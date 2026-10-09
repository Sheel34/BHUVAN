import json
import struct

import numpy as np
import pytest
import rasterio
from fastapi.testclient import TestClient
from rasterio.transform import from_origin
from rasterio.windows import Window

from main import app, build_payload
from data import terrain_tiles as tiles


@pytest.fixture(autouse=True)
def separate_store(tmp_path, monkeypatch):
    monkeypatch.setattr(tiles,'_root',lambda:tmp_path)


def decode(binary):
    assert binary[:4]==b'BHT1'
    length=struct.unpack('<I',binary[4:8])[0]
    header=json.loads(binary[8:8+length])
    values=np.frombuffer(binary,dtype='<f4',offset=8+length).reshape(len(header['fields']),header['rows'],header['cols'])
    return header,dict(zip(header['fields'],values))


def test_coarse_planning_retains_a_hazard_between_samples_without_changing_canonical_values(tmp_path):
    folder=tmp_path/'pit';folder.mkdir()
    height=np.zeros((257,257),dtype=np.float32)
    hazard=np.zeros_like(height);hazard[127,128]=1
    np.save(folder/'height.npy',height);np.save(folder/'hazard.npy',hazard)
    d={'id':'pit','kind':'analysis-window','fields':['height','hazard']}
    axis=np.arange(0,257,2)
    fields=tiles.tile_fields(d,axis,axis)
    assert not fields['hazard'].any()  # pit lies between point samples
    assert fields['planning_hazard'][64,64]==1
    assert fields['planning_hazard'][10,10]==0
    native=tiles.tile_fields(d,np.arange(125,132),np.arange(125,132))
    assert native['hazard'][2,3]==1
    assert 'planning_hazard' not in native


def source(tmp_path, size=1033, sparse=False, missing=False):
    path=tmp_path/'source.tif';spacing=1.
    affine=from_origin(-.5,size-.5,spacing,spacing)
    with rasterio.open(path,'w',driver='GTiff',count=1,width=size,height=size,dtype='float32',
                       crs='+proj=eqc +R=1737400 +units=m',transform=affine,tiled=True,
                       blockxsize=128,blockysize=128,SPARSE_OK=True,nodata=-9999) as dst:
        if sparse:
            dst.write(np.full((256,256),1000,dtype=np.float32),1,window=Window(0,0,256,256))
        else:
            r,c=np.meshgrid(np.arange(size),np.arange(size),indexing='ij')
            values=(1000+r*.001+c*.002+np.sin(r*.009)).astype(np.float32)
            if missing:values[10,10]=-9999
            dst.write(values,1)
    metadata={'grid_size':size,'resolution_m_per_px':spacing,'native_resolution_m_per_px':spacing,
              'source':'controlled-raster-fixture','dataset_id':'fixture','body':'moon','crs':'+proj=eqc +R=1737400 +units=m',
              'vertical_reference':'test sphere height','affine':list(affine)[:6],
              'acquisition':{'products':[{'uri':str(path)}]}}
    return metadata,path


@pytest.mark.parametrize('level',[0,1,2])
def test_cog_neighbors_share_border_samples_and_bounded_warps(tmp_path,monkeypatch,level):
    meta,_=source(tmp_path);d=tiles.descriptor_for(tiles.register_cog(meta)['id'])
    from rasterio.vrt import WarpedVRT as actual
    dimensions=[]
    def spy(*args,**kwargs):
        dimensions.append((kwargs['width'],kwargs['height']))
        return actual(*args,**kwargs)
    monkeypatch.setattr('rasterio.vrt.WarpedVRT',spy)
    a,aa=decode(tiles.encode_tile(d,level,0,0));b,bb=decode(tiles.encode_tile(d,level,1,0))
    border=a['j1'];ia=a['column_indices'].index(border);ib=b['column_indices'].index(border)
    assert a['row_indices']==b['row_indices']
    assert np.allclose(aa['height'][:,ia],bb['height'][:,ib],atol=1e-5,rtol=0)
    assert all(w<=131 and h<=131 for w,h in dimensions)
    assert a['dataset']['body']=='moon' and 'WGS' not in a['dataset']['crs']


def test_terminal_lod_tile_retains_exact_last_sample_position(tmp_path):
    meta,_=source(tmp_path);d=tiles.descriptor_for(tiles.register_cog(meta)['id'])
    h,fields=decode(tiles.encode_tile(d,2,2,2))
    assert h['row_indices'][-1]==1032 and h['column_indices'][-1]==1032
    assert np.isfinite(fields['height']).all()


def test_sparse_32k_raster_streams_without_full_raster_allocation(tmp_path,monkeypatch):
    meta,path=source(tmp_path,size=32768,sparse=True)
    assert path.stat().st_size<2_000_000
    d=tiles.descriptor_for(tiles.register_cog(meta)['id'])
    from rasterio.vrt import WarpedVRT as actual
    shapes=[]
    def spy(*args,**kwargs):
        shapes.append([kwargs['height'],kwargs['width']]);return actual(*args,**kwargs)
    monkeypatch.setattr('rasterio.vrt.WarpedVRT',spy)
    h,fields=decode(tiles.encode_tile(d,0,0,0))
    assert d['size']==32768
    assert fields['height'].nbytes<=131**2*4
    assert max(max(shape) for shape in shapes)<=131
    assert h['analysis_gsd_m'] is None


def test_nodata_is_an_explicit_tile_error(tmp_path):
    meta,_=source(tmp_path,missing=True);d=tiles.register_cog(meta)
    response=TestClient(app).get(f"/api/v1/terrain/datasets/{d['id']}/tiles/0/0/0")
    assert response.status_code==422 and 'missing cells' in response.text


def test_nonmetric_vertical_band_is_not_silently_rendered_as_metres(tmp_path):
    meta,path=source(tmp_path)
    with rasterio.open(path,'r+') as raster:raster.set_band_unit(1,'ft')
    d=tiles.register_cog(meta)
    assert len(d['affine'])==6
    response=TestClient(app).get(f"/api/v1/terrain/datasets/{d['id']}/tiles/0/0/0")
    assert response.status_code==422 and 'metric conversion' in response.text


def test_analysis_resolution_and_point_values_are_independent_of_visual_lod(tmp_path):
    n=257;spacing=5.
    meta={'terrain_name':'validation','source':'geotiff','body':'moon','world_scale_m':(n-1)*spacing,
          'height_scale_m':2.,'height_min_m':1000000.,'resolution_m_per_px':spacing,
          'crs':'+proj=eqc +R=1737400 +units=m','affine':list(from_origin(-642.5,642.5,spacing,spacing))[:6]}
    payload=build_payload(np.tile(np.linspace(0,1,n),(n,1)),meta)
    d=tiles.register_analysis(payload,meta);client=TestClient(app)
    response=client.get(f"/api/v1/terrain/datasets/{d['id']}/tiles/1/0/0")
    assert response.status_code==200
    header,fields=decode(response.content)
    assert header['analysis_gsd_m']==5. and header['gsd_m']==10.
    point=client.get(f"/api/v1/terrain/datasets/{d['id']}/point?i=120&j=121").json()
    assert point['elevation']==pytest.approx(payload.terrain.data[120*n+121],abs=1e-6)
    assert point['slope']==pytest.approx(payload.layers.slope[120*n+121])
    assert fields['height'].max()<2.01  # offset removed BEFORE float32 storage
    assert d['analysis']['window']['shape']==[n,n]


def test_streaming_acquisition_keeps_reports_but_omits_frontend_full_raster(tmp_path,monkeypatch):
    from data import terrain_routes
    n=129
    metadata={'terrain_name':'validation','source':'geotiff','body':'moon','world_scale_m':1280,
              'height_scale_m':1.,'resolution_m_per_px':10.,'crs':'+proj=eqc +R=1737400 +units=m',
              'affine':list(from_origin(-645,645,10,10))[:6]}
    monkeypatch.setattr(terrain_routes,'acquire_dem',lambda *args:(np.zeros((n,n)),metadata))
    client=TestClient(app)
    response=client.post('/api/v1/terrain/acquire',json={'body':'moon','lat':0,'lon':0,'stream_tiles':True})
    events=[json.loads(line) for line in response.text.splitlines()]
    result=next(e['analysis'] for e in events if e['type']=='result')
    assert result['terrain']['data']==[] and all(not values for values in result['layers'].values())
    assert result['intelligence'] and result['landing_zones'] and result['job_id']
    assert result['terrain_stream']['analysis']['gsd_m']==10.
    url=result['terrain_stream']['tile_url'].format(level=0,x=0,y=0)
    assert client.get(url).status_code==200
    legacy=client.post('/api/v1/terrain/acquire',json={'body':'moon','lat':0,'lon':0})
    old=next(json.loads(line)['analysis'] for line in legacy.text.splitlines() if json.loads(line)['type']=='result')
    assert len(old['terrain']['data'])==n*n and 'terrain_stream' not in old


def test_dev_datasets_disabled_in_production_and_tile_addresses_checked(monkeypatch):
    monkeypatch.delenv('BHUVAN_DEV_BENCHMARKS',raising=False)
    client=TestClient(app)
    assert client.get('/api/v1/terrain/datasets/benchmark-32768').status_code==404
    monkeypatch.setenv('BHUVAN_DEV_BENCHMARKS','1')
    assert client.get('/api/v1/terrain/datasets/benchmark-32768/tiles/9/0/0').status_code==422
    assert client.get('/api/v1/terrain/datasets/benchmark-32768/tiles/0/999/0').status_code==404
    assert client.get('/api/v1/terrain/datasets/not-a-dataset').status_code==404


def test_tile_waits_for_native_slot_instead_of_exhausting_client_retries(monkeypatch):
    monkeypatch.setenv('BHUVAN_DEV_BENCHMARKS','1')
    class TemporarilyBusy:
        attempts=0
        released=False
        def acquire(self,blocking=False):
            self.attempts+=1
            return self.attempts>=3
        def release(self):self.released=True
    slots=TemporarilyBusy();monkeypatch.setattr(tiles,'_slots',slots)
    response=TestClient(app).get('/api/v1/terrain/datasets/benchmark-512/tiles/0/0/0')
    assert response.status_code==200 and slots.attempts==3 and slots.released
    assert response.headers['cache-control']=='no-store'


def test_obsolete_queued_request_never_starts_gdal(monkeypatch):
    import asyncio
    class Busy:
        def acquire(self,blocking=False):return False
    class Disconnected:
        async def is_disconnected(self):return True
    monkeypatch.setattr(tiles,'_slots',Busy())
    monkeypatch.setattr(tiles,'encode_tile',lambda *args:pytest.fail('Disconnected request started raster work'))
    response=asyncio.run(tiles.get_tile('unused',0,0,0,Disconnected()))
    assert response.status_code==499


@pytest.mark.parametrize('size',[512,1024,2048,4096,8192,16384,32768])
def test_dev_logical_sizes_have_fixed_tile_working_set(monkeypatch,size):
    monkeypatch.setenv('BHUVAN_DEV_BENCHMARKS','1')
    client=TestClient(app);binary=client.get(f'/api/v1/terrain/datasets/benchmark-{size}/tiles/0/1/1').content
    h,fields=decode(binary)
    assert fields['height'].shape==(131,131) and h['dataset']['status']=='SYNTHETIC'
    assert len(binary)<100000

def test_rgb_transport_matches_absolute_tile_heights_without_changing_analysis(tmp_path):
    from data.height_rgb import decode_height_rgb
    meta,_=source(tmp_path,size=257)
    d=tiles.register_cog(meta);identifier=d['id']
    client=TestClient(app)
    desc=client.get(f'/api/v1/terrain/datasets/{identifier}').json()
    assert desc['height_rgb']['quantization_m']==.1
    native=client.get(f'/api/v1/terrain/datasets/{identifier}/tiles/0/0/0')
    header,values=decode(native.content)
    rgb=client.get(f'/api/v1/terrain/datasets/{identifier}/elevation-rgb/0/0/0.png')
    assert rgb.status_code==200 and rgb.headers['content-type']=='image/png'
    decoded=decode_height_rgb(rgb.content)
    expected=values['height'].astype(np.float64)+d['elevation_origin']
    assert np.max(np.abs(decoded-expected))<=.05000001
    _,after=decode(client.get(f'/api/v1/terrain/datasets/{identifier}/tiles/0/0/0').content)
    assert np.array_equal(after['height'],values['height'])


@pytest.mark.parametrize('level',[0,1,2])
def test_acquired_overview_tiles_use_retained_analysis_even_if_remote_source_changes(tmp_path,monkeypatch,level):
    n=513;spacing=40.
    meta={'terrain_name':'overview','source':'geotiff','body':'moon','world_scale_m':(n-1)*spacing,
          'height_scale_m':100.,'height_min_m':-2000.,'resolution_m_per_px':spacing,
          'crs':'+proj=eqc +R=1737400 +units=m','affine':list(from_origin(-10260,10260,spacing,spacing))[:6],
          'acquisition':{'products':[{'uri':'https://example.test/no-longer-available.tif'}]}}
    r,c=np.meshgrid(np.arange(n),np.arange(n),indexing='ij')
    payload=build_payload(((np.sin(r*.13)*np.cos(c*.07)+1)/2).astype(np.float32),meta)
    d=tiles.descriptor_for(tiles.register_analysis(payload,meta)['id'])
    # Also cover descriptors registered before this fix, whose products were remote.
    d['products']=meta['acquisition']['products']
    monkeypatch.setattr(tiles,'_cog_samples',lambda *args:pytest.fail('Acquired terrain re-fetched the remote source'))
    header,fields=decode(tiles.encode_tile(d,level,0,0))
    analytical=np.asarray(payload.terrain.data).reshape(n,n)-d['elevation_origin']
    expected=analytical[np.ix_(header['row_indices'],header['column_indices'])].astype(np.float32)
    assert np.array_equal(fields['height'],expected)
    assert header['resampling']['height']=='point selection from retained analysis grid'
