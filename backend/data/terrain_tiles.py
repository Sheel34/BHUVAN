"""Bounded binary terrain windows, separate from scientific analysis resolution.

No caller-controlled raster URLs. Registration retains source/reference metadata.
Analysis products are disk-backed; COG products use a bounded virtual warp.
The synthetic development source evaluates only requested samples, never N*N.
"""
from __future__ import annotations

import json
import asyncio
import math
import os
import re
import struct
import threading
import time
import uuid
from pathlib import Path
from typing import Literal

import numpy as np
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, FiniteFloat

TILE_CELLS = 128
FIELDS = ['height', 'slope', 'roughness', 'curvature', 'shadow', 'hazard', 'traversability']
router = APIRouter(prefix='/api/v1/terrain', tags=['Terrain tiles'])
_slots = threading.BoundedSemaphore(4)


def _root():
    from main import OUTPUT_DIR
    # Separate from the legacy artifact writer's job-folder eviction.
    root = Path(OUTPUT_DIR).parent / (Path(OUTPUT_DIR).name + '-terrain-tiles')
    root.mkdir(parents=True, exist_ok=True)
    return root


def _rss():
    try:
        import psutil
        return psutil.Process().memory_info().rss
    except ImportError:
        pass
    # Standard-library fallback; do not add a monitoring dependency merely to
    # measure resident memory on the development host.
    if os.name=='nt':
        import ctypes
        from ctypes import wintypes
        class Counters(ctypes.Structure):
            _fields_=[('cb',wintypes.DWORD),('faults',wintypes.DWORD)]+[(name,ctypes.c_size_t) for name in
                ('peak_working_set','working_set','peak_paged','paged','peak_nonpaged','nonpaged','pagefile','peak_pagefile')]
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.GetCurrentProcess.restype=wintypes.HANDLE
        api=ctypes.WinDLL('psapi',use_last_error=True).GetProcessMemoryInfo
        api.argtypes=[wintypes.HANDLE,ctypes.POINTER(Counters),wintypes.DWORD]
        data=Counters();data.cb=ctypes.sizeof(data)
        return int(data.working_set) if api(kernel.GetCurrentProcess(),ctypes.byref(data),data.cb) else None
    try:
        with open('/proc/self/statm',encoding='ascii') as handle:
            return int(handle.read().split()[1])*os.sysconf('SC_PAGE_SIZE')
    except (OSError,AttributeError,ValueError):
        return None


def save_descriptor(descriptor):
    identifier = descriptor['id']
    folder = _root() / identifier
    folder.mkdir(exist_ok=True)
    (folder / 'descriptor.json').write_text(json.dumps(descriptor, allow_nan=False), encoding='utf-8')
    return public_descriptor(descriptor)


def descriptor_for(identifier):
    if not re.fullmatch(r'[a-f0-9]{32}|benchmark-(512|1024|2048|4096|8192|16384|32768)', identifier):
        raise HTTPException(404, 'Unknown terrain dataset')
    if identifier.startswith('benchmark-'):
        if os.environ.get('BHUVAN_DEV_BENCHMARKS') != '1':
            raise HTTPException(404, 'Development datasets are disabled')
        size = int(identifier.split('-')[1])
        return {'id':identifier, 'kind':'synthetic-window', 'size':size, 'scale':float(size-1),
                'cell_size_m':1., 'min_h':-3., 'max_h':3., 'elevation_origin':0.,
                'source':'DEV analytical sinusoid', 'dataset_id':identifier, 'body':'unknown',
                'crs':'local metric test coordinates', 'reference_model':None, 'vertical_reference':'synthetic origin',
                'native_gsd_m':1., 'nodata':None, 'fields':['height'], 'analysis':None,
                'status':'SYNTHETIC', 'limitation':'Generated on demand; not a measured 32K DEM.'}
    path = _root() / identifier / 'descriptor.json'
    if not path.is_file():
        raise HTTPException(404, 'Terrain dataset is no longer available; reacquire it')
    return json.loads(path.read_text(encoding='utf-8'))


def public_descriptor(d):
    # Source URIs and file paths stay on the server; acquisition provenance is
    # separately retained in the scientific report.
    public = {k:v for k,v in d.items() if k != 'products'}
    public.update(tile_cells=TILE_CELLS, max_level=max(0, math.ceil(math.log2(max(1,(d['size']-1)/TILE_CELLS)))),
                  encoding='BHT1 little-endian float32 + UTF-8 JSON header',
                  height_rgb={'url':f"/api/v1/terrain/datasets/{d['id']}/elevation-rgb/{{level}}/{{x}}/{{y}}.png",'formula':'height_m = -10000 + (R*65536 + G*256 + B)*0.1','quantization_m':0.1,'maximum_rounding_error_m':0.05,'accuracy':'Source accuracy unchanged; RGB transport quantization only','addressing':'BHUVAN local grid with border halo, NOT Web Mercator XYZ; use BHT1 header for row/column coordinates','color_handling':'Decode raw RGB bytes without sRGB conversion or lossy compression'},
                  tile_url=f"/api/v1/terrain/datasets/{d['id']}/tiles/{{level}}/{{x}}/{{y}}",
                  point_url=f"/api/v1/terrain/datasets/{d['id']}/point",
                  addressing='x=column, y=row; level 0 is native analytical grid; step=2**level',
                  bounds=[-d['scale']/2,-d['scale']/2,d['scale']/2,d['scale']/2],
                  axes='render x=row/south, z=column/east, y=height minus elevation_origin',
                  visual_resampling='point selection from retained analysis grid; common visible LOD' if d['kind']=='analysis-window'
                    else 'height: bilinear warp at an endpoint-anchored LOD lattice; common visible LOD')
    return public


def register_analysis(payload, metadata):
    """Preserve exact analysis values on disk; do not analyse display LOD tiles."""
    from rasterio import open as raster_open
    from rasterio.transform import Affine
    identifier = uuid.uuid4().hex
    folder = _root() / identifier
    folder.mkdir()
    n = payload.terrain.size
    provenance = payload.metadata.provenance
    origin = payload.terrain.min_h
    # Analytical arrays are bounded by acquisition's 1025-side limit. This
    # materialization is explicitly not an out-of-core analysis algorithm.
    height = np.asarray(payload.terrain.data, dtype=np.float64).reshape(n,n)
    np.save(folder/'height.npy', (height-origin).astype(np.float32))
    for field in FIELDS[1:]:
        np.save(folder/f'{field}.npy', np.asarray(getattr(payload.layers,field),dtype=np.float32).reshape(n,n))
    # A tiled metric raster is also retained for independently bounded GDAL
    # window reads and interoperability; no giant JSON elevation response.
    with raster_open(folder/'elevation.tif','w',driver='GTiff',count=1,width=n,height=n,
                     dtype='float64',crs=metadata['crs'],transform=Affine(*metadata['affine']),
                     tiled=True,blockxsize=128,blockysize=128,compress='deflate') as dst:
        dst.write(height,1)
    d = {'id':identifier,'kind':'analysis-window','size':n,'scale':payload.terrain.scale,
         'cell_size_m':payload.metadata.resolution_m_per_px,'min_h':0.,
         'max_h':payload.terrain.max_h-origin,'elevation_origin':origin,
         'source':provenance['source'],'dataset_id':provenance['dataset_id'],'body':provenance['body'],
         'crs':provenance['reference'],'reference_model':provenance.get('reference_model'),
         'vertical_reference':provenance['vertical_reference'],'native_gsd_m':provenance['source_gsd'],
         'status':provenance['status'],'nodata':None,'fields':FIELDS,
         'source_references':[{k:p.get(k) for k in ('dataset_id','crs','shape','gsd','gsd_unit','local_gsd_m','nodata','scale','offset','elevation_unit','elevation_unit_basis')} for p in metadata.get('acquisition',{}).get('products',[])],
         'products':[{'uri':str(folder/'elevation.tif')}], 'affine':metadata['affine'],
         'analysis':{'gsd_m':provenance['analysis_gsd'],'window':provenance.get('analysis_window'),
                     'shape':[n,n],'resampling':metadata.get('acquisition',{}).get('reprojection'),
                     'provenance':provenance,'job_id':payload.job_id},
         'limitation':'Renderer streams disk-backed analysis windows; analysis remains a bounded in-memory operation.'}
    return save_descriptor(d)


def register_cog(metadata, *, size=None):
    """A virtual local lattice over configured source COGs, without a full raster.

    Reuses the provider's body-aware metric affine and native source metadata.
    No automatic analysis of this logical raster is implied. A separately
    registered analysis product may be rendered through register_analysis.
    """
    n = size or metadata['grid_size']
    spacing = metadata['resolution_m_per_px']
    d = {'id':uuid.uuid4().hex,'kind':'cog-window','size':n,'scale':(n-1)*spacing,
         'cell_size_m':spacing,'min_h':metadata.get('height_min_m',-12000.),
         'max_h':metadata.get('height_max_m',12000.),'elevation_origin':0.,
         'source':metadata['source'],'dataset_id':metadata['dataset_id'],'body':metadata['body'],
         'crs':metadata['crs'],'reference_model':metadata.get('reference_model'),
         'vertical_reference':metadata['vertical_reference'],'native_gsd_m':metadata.get('native_resolution_m_per_px'),
         'status':'MEASURED','nodata':'missing elevations cause a tile error','fields':['height'],
         'source_references':[{k:p.get(k) for k in ('dataset_id','crs','shape','native_gsd','gsd_unit','vertical_reference','nodata','scale','offset','elevation_unit','elevation_unit_basis')} for p in metadata['acquisition']['products']],
         'affine':metadata['affine'],'products':metadata['acquisition']['products'],'analysis':None,
         'limitation':'Visual-only virtual COG grid; no scientific analysis is inferred from display LOD.'}
    return save_descriptor(d)


class DatasetLocationRequest(BaseModel):
    body: Literal['earth','moon']
    lat: FiniteFloat=Field(ge=-90,le=90)
    lon: FiniteFloat=Field(ge=-180,le=180)
    region_size_m: FiniteFloat=Field(default=2000,ge=500,le=20000)


@router.post('/datasets/location')
def locate_streaming_dataset(request: DatasetLocationRequest):
    """Register a virtual raster using source headers, without acquiring N*N.

    This low-level endpoint does not manufacture reports/candidates. Production
    acquisition retains a separately bounded scientific analysis. Tile errors
    expose incomplete coverage rather than substituting another location.
    """
    import rasterio
    from rasterio.transform import from_origin
    from .terrain_providers import (Region,CopernicusTerrainProvider,ConfiguredLunarTerrainProvider,
                                   _spacing,require_range_access,MOON_RADIUS_M,metric_elevation_unit)
    region=Region(request.body,request.lat,request.lon,request.region_size_m)
    provider=CopernicusTerrainProvider() if request.body=='earth' else ConfiguredLunarTerrainProvider()
    failures=[]
    for products in provider.locate(region):
        try:
            sources=[];spacings=[]
            with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR',GDAL_HTTP_TIMEOUT='20',GDAL_HTTP_MAX_RETRY='1'):
                for product in products:
                    require_range_access(product.uri)
                    with rasterio.open(product.uri) as src:
                        if not src.crs or src.count!=1:
                            raise ValueError('Scalar elevation source with a CRS is required')
                        if request.body=='moon':
                            p=src.crs.to_dict();radius=float(p.get('R',p.get('a',0)))
                            if abs(radius-MOON_RADIUS_M)>1:
                                raise ValueError('Source lunar reference model must agree with the configured local Moon sphere; Earth CRS is invalid')
                        spacings.extend(_spacing(src,region))
                        elevation_unit=metric_elevation_unit(src)
                        sources.append({'uri':product.uri,'dataset_id':product.id,'crs':src.crs.to_wkt(),
                                        'shape':[src.height,src.width],'native_gsd':list(src.res),
                                        'gsd_unit':'degrees' if src.crs.is_geographic else src.crs.linear_units,
                                        'vertical_reference':product.vertical_reference,'nodata':src.nodata,
                                        'scale':src.scales[0],'offset':src.offsets[0],**elevation_unit})
            spacing=min(spacings);size=math.ceil(request.region_size_m/spacing)+1
            if size>32768:
                raise HTTPException(422,'Virtual dataset exceeds the tested logical dimension limit; select a smaller region')
            extent=(size-1)*spacing
            metadata={'grid_size':size,'resolution_m_per_px':spacing,'native_resolution_m_per_px':spacings,
                      'source':products[0].source,'dataset_id':' + '.join(p.id for p in products),'body':request.body,
                      'crs':region.crs.to_wkt(),'vertical_reference':products[0].vertical_reference,
                      'reference_model':{'body':'moon','radius_m':MOON_RADIUS_M} if request.body=='moon' else {'body':'earth','kind':'WGS84 horizontal; product vertical datum retained'},
                      'affine':list(from_origin(-(extent+spacing)/2,(extent+spacing)/2,spacing,spacing))[:6],
                      'acquisition':{'products':sources}}
            return register_cog(metadata)
        except (OSError,ValueError,rasterio.errors.RasterioError) as exc:
            failures.append(str(exc))
    raise HTTPException(422,{'code':'DATA_UNAVAILABLE','message':failures[-1] if failures else 'No available DEM'})


def _axes(d, level, x, y):
    if level < 0 or level > public_descriptor(d)['max_level'] or min(x,y)<0:
        raise HTTPException(422, 'Invalid terrain tile level/address')
    step = 2**level
    count = math.ceil((d['size']-1)/(TILE_CELLS*step))
    if x>=count or y>=count:
        raise HTTPException(404, 'Tile lies outside dataset')
    def axis(address):
        start = address*TILE_CELLS*step
        end = min((address+1)*TILE_CELLS*step,d['size']-1)
        values = np.arange(start,end,step,dtype=np.int64).tolist()+[end]
        if start>0: values.insert(0,max(0,start-step))
        if end<d['size']-1: values.append(min(d['size']-1,end+step))
        return np.asarray(values),start,end
    rows,i0,i1 = axis(y); cols,j0,j1 = axis(x)
    return rows,cols,{'i0':i0,'i1':i1,'j0':j0,'j1':j1,'step':step}


def _cog_samples(d, rows, cols):
    import rasterio
    from rasterio.transform import Affine
    from rasterio.vrt import WarpedVRT
    from rasterio.enums import Resampling
    from .terrain_providers import metric_elevation_unit
    # Every tile is warped onto the SAME global sample lattice. Exact warp
    # transforms and shared halo indices avoid independent tile origins.
    step = int(rows[1]-rows[0]) if len(rows)>1 else 1
    cstep = int(cols[1]-cols[0]) if len(cols)>1 else step
    base = Affine(*d['affine'])
    def read(row_axis,col_axis,dy,dx):
        affine = base*Affine.translation(float(col_axis[0])-(dx-1)/2,float(row_axis[0])-(dy-1)/2)*Affine.scale(dx,dy)
        output = np.full((len(row_axis),len(col_axis)),np.nan,dtype=np.float64)
        with rasterio.Env(GDAL_CACHEMAX=32*1024*1024,GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR',
                          GDAL_HTTP_TIMEOUT='20',GDAL_HTTP_MAX_RETRY='1',VSI_CACHE=False):
            for product in d['products']:
                with rasterio.open(product['uri']) as source:
                    try:metric_elevation_unit(source)
                    except ValueError as exc:raise HTTPException(422,str(exc)) from exc
                    with WarpedVRT(source,crs=d['crs'],transform=affine,width=len(col_axis),height=len(row_axis),
                                   resampling=Resampling.bilinear,tolerance=1e-9,warp_mem_limit=32,nodata=np.nan,dtype='float64') as vrt:
                        values = vrt.read(1,masked=True).filled(np.nan)*source.scales[0]+source.offsets[0]
                    # Preserve source nodata coverage independently: interpolation
                    # must not silently bridge missing elevation cells.
                    with WarpedVRT(source,crs=d['crs'],transform=affine,width=len(col_axis),height=len(row_axis),
                                   resampling=Resampling.nearest,tolerance=1e-9,warp_mem_limit=32,nodata=np.nan,dtype='float64') as valid_vrt:
                        valid = np.isfinite(valid_vrt.read(1,masked=True).filled(np.nan))
                    valid &= np.isfinite(values)&~np.isfinite(output)
                    output[valid] = values[valid]
        return output
    output = read(rows,cols,step,cstep)
    # The last native sample is an explicit endpoint, not a shifted coarse
    # pixel centre. Read irregular terminal strips at their exact coordinates.
    if len(rows)>1 and rows[-1]-rows[-2]!=step:
        output[-1:] = read(rows[-1:],cols,1,cstep)
    if len(cols)>1 and cols[-1]-cols[-2]!=cstep:
        output[:,-1:] = read(rows,cols[-1:],step,1)
    if len(rows)>1 and len(cols)>1 and (rows[-1]-rows[-2]!=step or cols[-1]-cols[-2]!=cstep):
        output[-1,-1] = read(rows[-1:],cols[-1:],1,1)[0,0]
    if not np.isfinite(output).all():
        raise HTTPException(422, 'Source DEM has missing cells in this tile; no synthetic substitution')
    return (output-d['elevation_origin']).astype(np.float32)


def tile_fields(d, rows, cols):
    if d['kind']=='synthetic-window':
        r,c=np.meshgrid(rows,cols,indexing='ij')
        return {'height':(2*np.sin(r*.013)*np.cos(c*.009)+np.sin(c*.031)).astype(np.float32)}
    if d['kind']=='cog-window':
        return {'height':_cog_samples(d,rows,cols)}
    folder=_root()/d['id']
    # np.load(... mmap_mode='r') maps the file, then copies only indexed tile
    # samples. No N*N array is allocated or retained in the server tile cache.
    # All fields, including geometry, use the SAME retained analysis samples.
    # Re-reading remote source products here is both expensive and wrong after
    # overview aggregation/reprojection: it can disagree with rover contacts.
    fields = {field:np.asarray(np.load(folder/f'{field}.npy',mmap_mode='r')[np.ix_(rows,cols)],dtype=np.float32)
              for field in d['fields']}
    step = max(int(np.diff(rows).max()) if len(rows)>1 else 1, int(np.diff(cols).max()) if len(cols)>1 else 1)
    if 'hazard' in fields and step>1:
        # Keep canonical point samples for inspection/rendering, and transmit
        # an explicitly separate conservative field for coarse route planning.
        hazard = np.load(folder/'hazard.npy', mmap_mode='r')
        radius = int(np.ceil(step/2))
        pooled = np.empty((len(rows),len(cols)),dtype=np.float32)
        for i,row in enumerate(rows):
            for j,col in enumerate(cols):
                window = hazard[max(0,row-radius):row+radius+1,max(0,col-radius):col+radius+1]
                pooled[i,j] = float(window.max()) if np.isfinite(window).all() else 1
        fields['planning_hazard'] = pooled
    return fields


def encode_tile(d, level, x, y):
    start=time.perf_counter()
    rows,cols,address=_axes(d,level,x,y)
    fields=tile_fields(d,rows,cols)
    height=fields['height']
    reference={k:d[k] for k in ('id','source','dataset_id','body','crs','reference_model','vertical_reference','native_gsd_m','elevation_origin','status')}
    reference['source_references']=d.get('source_references',[])
    reference['local_affine']=d.get('affine')
    header={**address,'dataset':reference,'tile_id':f'{level}/{x}/{y}','level':level,
            'bounds_native_indices':[address['j0'],address['i0'],address['j1'],address['i1']],
            'rows':len(rows),'cols':len(cols),'row_indices':rows.tolist(),'column_indices':cols.tolist(),
            'fields':list(fields),'encoding':'float32-le','min_h':float(height.min()),'max_h':float(height.max()),
            'gsd_m':d['cell_size_m']*2**level,'analysis_gsd_m':d['analysis']['gsd_m'] if d['analysis'] else None,
            'resampling':{'height':'point selection from retained analysis grid' if d['kind']=='analysis-window' else 'bilinear COG warp at display GSD; sample coordinates retain endpoints' if d['kind']=='cog-window' else 'evaluated test function',
                          'quantitative_layers':'point selection from original analytical grid' if d['analysis'] else 'unavailable; no analysis inferred',
                          'planning_hazard':'maximum within half an LOD step of each sample; unknowns excluded' if 'planning_hazard' in fields else 'native hazard samples'},
            'warp_tolerance_pixels':1e-9 if d['kind']=='cog-window' else None,
            'nodata':d['nodata'],'server_rss_bytes':_rss(),'read_ms':(time.perf_counter()-start)*1000}
    encoded=json.dumps(header,separators=(',',':'),allow_nan=False).encode()
    encoded+=b' '*(-len(encoded)%4)
    return b'BHT1'+struct.pack('<I',len(encoded))+encoded+b''.join(np.asarray(value,dtype='<f4').tobytes() for value in fields.values())


@router.get('/datasets/{identifier}')
def get_descriptor(identifier: str):
    return public_descriptor(descriptor_for(identifier))


@router.get('/datasets/{identifier}/tiles/{level}/{x}/{y}')
async def get_tile(identifier: str, level: int, x: int, y: int, request: Request):
    # Browser cancellation cannot interrupt a GDAL read already in progress.
    # Keep replacements queued without starting obsolete disconnected reads,
    # rather than exhausting short retries against occupied native workers.
    deadline=time.monotonic()+25
    while not _slots.acquire(blocking=False):
        if await request.is_disconnected():
            return Response(status_code=499)
        if time.monotonic()>deadline:
            raise HTTPException(503,'Terrain tile working-set slots busy; retry',headers={'Retry-After':'1'})
        await asyncio.sleep(.05)
    try:
        if await request.is_disconnected():
            return Response(status_code=499)
        binary=await run_in_threadpool(encode_tile,descriptor_for(identifier),level,x,y)
        return Response(binary,media_type='application/vnd.bhuvan.terrain-tile',headers={'Cache-Control':'no-store'})
    finally:
        _slots.release()


@router.get('/datasets/{identifier}/point')
def get_point(identifier: str, i: int=Query(ge=0), j: int=Query(ge=0)):
    d=descriptor_for(identifier)
    if i>=d['size'] or j>=d['size']:
        raise HTTPException(422,'Point outside terrain dataset')
    if d['kind']=='analysis-window':
        fields={field:np.array([[np.load(_root()/d['id']/f'{field}.npy',mmap_mode='r')[i,j]]]) for field in d['fields']}
    else:
        fields=tile_fields(d,np.array([i]),np.array([j]))
    return {'i':i,'j':j,'elevation':float(fields['height'][0,0])+d['elevation_origin'],
            **{k:float(v[0,0]) for k,v in fields.items() if k!='height'},
            'analysis_gsd_m':d['analysis']['gsd_m'] if d['analysis'] else None,
            'status':d['status']}


@router.get('/datasets/{identifier}/elevation-rgb/{level}/{x}/{y}.png')
async def get_height_rgb(identifier: str, level: int, x: int, y: int):
    from .height_rgb import encode_height_rgb
    if not _slots.acquire(blocking=False):
        raise HTTPException(503,'Terrain tile workers busy; retry',headers={'Retry-After':'1'})
    def encode():
        d=descriptor_for(identifier)
        binary=encode_tile(d,level,x,y)
        header_size=struct.unpack('<I',binary[4:8])[0]
        header=json.loads(binary[8:8+header_size])
        height=np.frombuffer(binary,dtype='<f4',offset=8+header_size,count=header['rows']*header['cols']).reshape(header['rows'],header['cols']).astype(np.float64)+d['elevation_origin']
        return encode_height_rgb(height)
    try:
        content=await run_in_threadpool(encode)
        return Response(content,media_type='image/png',headers={'Cache-Control':'no-store','X-Height-Quantization-M':'0.1'})
    except ValueError as exc:
        raise HTTPException(422,str(exc)) from exc
    finally:
        _slots.release()
