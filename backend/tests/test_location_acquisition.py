import json
import math
import numpy as np
import pytest
import rasterio
from fastapi.testclient import TestClient
from rasterio.transform import from_origin

from data.terrain_providers import (Region, Product, CopernicusTerrainProvider,
    ConfiguredLunarTerrainProvider, acquire_dem, DataUnavailable)
from main import app, build_payload


class Provider:
    def __init__(self, groups): self.groups=groups
    def locate(self, region): return self.groups


def raster(tmp_path,region,spacing=10,offset=1234,nodata=False,crs=None):
    path=tmp_path/f'{region.body}-{spacing}-{offset}.tif'
    values=offset+np.tile(np.arange(201,dtype=np.float32)*.02,(201,1))
    if nodata: values[80:120,80:120]=-9999
    with rasterio.open(path,'w',driver='GTiff',width=201,height=201,count=1,dtype='float32',
            transform=from_origin(-100.5*spacing,100.5*spacing,spacing,spacing),crs=crs or region.crs,nodata=-9999) as dst:
        dst.write(values,1)
    return Product(path.stem,str(path),'lola-dem' if region.body=='moon' else 'copernicus-glo-30',region.body,spacing,'reference height','test fixture')


@pytest.mark.parametrize('body',['earth','moon'])
def test_bounded_native_window_and_absolute_elevations(tmp_path,body):
    region=Region(body,10,20,500);product=raster(tmp_path,region);events=[]
    grid,metadata=acquire_dem(region,lambda *args:events.append(args),Provider([[product]]))
    native=metadata['acquisition']['products'][0]
    assert native['window'][2]<native['shape'][1]
    assert native['window'][3]<native['shape'][0]
    assert metadata['resolution_m_per_px']==pytest.approx(10,rel=1e-5)
    assert metadata['lat']==10 and metadata['lon']==20
    assert np.isfinite(grid).all()
    result=build_payload(grid,metadata)
    assert result.metadata.provenance['status']=='MEASURED'
    assert result.metadata.provenance['body']==body
    assert result.metadata.provenance['acquisition']['selected_lat']==10
    assert result.terrain.min_h>1234
    assert [stage for stage,status,_ in events if status=='completed']==['LOCATING DATA','READING DEM','REPROJECTING/RESAMPLING']


def test_lunar_source_rejects_earth_crs(tmp_path):
    region=Region('moon',10,20,500);product=raster(tmp_path,region,crs='EPSG:3857')
    with pytest.raises(DataUnavailable,match='Earth CRS is invalid'):
        acquire_dem(region,lambda *args:None,Provider([[product]]))


def test_anisotropic_native_spacing_is_retained_without_coarsening_finer_axis(tmp_path):
    region=Region('earth',10,20,500);product=raster(tmp_path,region)
    with rasterio.open(product.uri,'r+') as source:
        source.transform=from_origin(-1005,2010,10,20)
    grid,metadata=acquire_dem(region,lambda *args:None,Provider([[product]]))
    assert metadata['resolution_m_per_px']==pytest.approx(10,rel=1e-5)
    assert metadata['acquisition']['products'][0]['gsd']==[10,20]
    assert metadata['acquisition']['products'][0]['local_gsd_m']==pytest.approx([10,20],rel=1e-5)
    assert grid.shape==(51,51)
    assert metadata['resampled'] is True


def test_missing_dem_cells_are_never_synthetic_or_interpolated_over_holes(tmp_path):
    region=Region('earth',10,20,500);product=raster(tmp_path,region,nodata=True)
    with pytest.raises(DataUnavailable,match='missing cells'):
        acquire_dem(region,lambda *args:None,Provider([[product]]))


def test_single_missing_source_sample_is_not_bridged_by_bilinear_sampling(tmp_path):
    region=Region('earth',10,20,500);product=raster(tmp_path,region)
    with rasterio.open(product.uri,'r+') as source:
        values=source.read(1);values[100,100]=-9999;source.write(values,1)
    with pytest.raises(DataUnavailable,match='missing cells'):
        acquire_dem(region,lambda *args:None,Provider([[product]]))


def test_native_resolution_is_not_reduced_to_fit_large_region(tmp_path):
    region=Region('earth',10,20,20000);product=raster(tmp_path,region,spacing=5)
    with pytest.raises(DataUnavailable) as exc:
        acquire_dem(region,lambda *args:None,Provider([[product]]))
    assert exc.value.code=='REGION_TOO_LARGE'


def test_finer_unavailable_source_falls_back_to_available_measured_source(tmp_path):
    region=Region('earth',10,20,500)
    missing=Product('glo30','missing.tif','copernicus-glo-30','earth',30,'EGM2008','test')
    coarse=raster(tmp_path,region,spacing=90)
    grid,metadata=acquire_dem(region,lambda *args:None,Provider([[missing],[coarse]]))
    assert metadata['dataset_id']==coarse.id
    assert metadata['acquisition']['selection_failures'][0]['datasets']==['glo30']
    assert metadata['resolution_m_per_px']==pytest.approx(90,rel=1e-5)


def test_geographic_tile_boundaries_are_mosaicked_without_degrees_as_metres(tmp_path):
    region=Region('earth',0,0,500);products=[]
    for index,left in enumerate([-.01,0]):
        path=tmp_path/f'tile-{index}.tif'
        with rasterio.open(path,'w',driver='GTiff',height=72,width=36,count=1,dtype='float32',
                crs='EPSG:4326',transform=from_origin(left,.01,1/3600,1/3600)) as dst:
            dst.write(np.full((72,36),1200,dtype=np.float32),1)
        products.append(Product(str(index),str(path),'copernicus-glo-30','earth',30,'EGM2008','test'))
    grid,metadata=acquire_dem(region,lambda *args:None,Provider([products]))
    assert 30<metadata['resolution_m_per_px']<32
    assert np.isfinite(grid).all() and metadata['height_min_m']==pytest.approx(1200)
    assert len(metadata['acquisition']['products'])==2
    assert all(p['gsd_unit']=='degrees' for p in metadata['acquisition']['products'])
    assert region.crs.to_dict()['proj']=='aeqd'


def test_tile_ids_use_sw_corner_and_official_arc_second_codes():
    provider=CopernicusTerrainProvider()
    assert 'COG_10_S01_00_W002_00' in provider.tile_uri(-1,-2,30)
    assert 'COG_30_N19_00_E073_00' in provider.tile_uri(19,73,90)
    groups=provider.locate(Region('earth',0,0,500))
    assert len(groups[0])==4
    assert all(product.body=='earth' for product in groups[0])


def test_nonintersecting_catalogue_strip_does_not_abort_a_complementary_mosaic(tmp_path):
    region=Region('moon',10,20,500)
    outside=raster(tmp_path,region,spacing=10,offset=500)
    with rasterio.open(outside.uri,'r+') as source:
        source.transform=from_origin(5000,6000,10,10)
    covering=raster(tmp_path,region,spacing=10,offset=1200)
    grid,metadata=acquire_dem(region,lambda *args:None,Provider([[outside,covering]]))
    assert np.isfinite(grid).all()
    assert metadata['dataset_id']==covering.id
    assert metadata['acquisition']['selection_failures'][0]['datasets']==[outside.id]
    with pytest.raises(DataUnavailable,match='does not intersect'):
        acquire_dem(region,lambda *args:None,Provider([[outside]]))


def test_antimeridian_request_only_intersects_adjacent_degree_tiles():
    boxes=Region('earth',0,179.999,500).geographic_boxes()
    assert len(boxes)==2
    groups=CopernicusTerrainProvider().locate(Region('earth',0,179.999,500))
    assert {int(p.bounds[0]) for p in groups[0]}=={179,-180}


def test_antimeridian_native_windows_form_a_complete_local_mosaic(tmp_path):
    region=Region('earth',0,179.999,500);products=[]
    for index,left in enumerate([179.99,-180]):
        path=tmp_path/f'antimeridian-{index}.tif'
        with rasterio.open(path,'w',driver='GTiff',height=72,width=36,count=1,dtype='float32',
                crs=region.geographic_crs,transform=from_origin(left,.01,1/3600,1/3600)) as dst:
            dst.write(np.full((72,36),500,dtype=np.float32),1)
        products.append(Product(str(index),str(path),'copernicus-glo-30','earth',30,'EGM2008','test'))
    grid,metadata=acquire_dem(region,lambda *args:None,Provider([products]))
    assert np.isfinite(grid).all() and metadata['height_min_m']==pytest.approx(500)


def test_lunar_360_degree_longitudes_preserve_location_and_native_window(tmp_path):
    region=Region('moon',10,-20,500);path=tmp_path/'sldem-longitudes.tif'
    with rasterio.open(path,'w',driver='GTiff',height=216,width=216,count=1,dtype='float32',
            crs=region.geographic_crs,transform=from_origin(339.97,10.03,1/3600,1/3600)) as dst:
        dst.write(np.full((216,216),-1250,dtype=np.float32),1)
    product=Product('sldem',str(path),'sldem2015','moon',8.4,'lunar sphere','test',(339.97,9.97,340.03,10.03))
    provider=ConfiguredLunarTerrainProvider([product],use_usgs=False)
    grid,metadata=acquire_dem(region,lambda *args:None,provider)
    assert np.isfinite(grid).all() and metadata['height_min_m']==pytest.approx(-1250)
    assert metadata['lon']==-20 and metadata['acquisition']['products'][0]['window'][2]<216
    assert metadata['acquisition']['products'][0]['gsd_unit']=='degrees'


def test_unconfigured_lunar_location_has_explicit_unavailable_state():
    provider=ConfiguredLunarTerrainProvider([],use_usgs=False)
    with pytest.raises(DataUnavailable,match='No configured authoritative'):
        provider.locate(Region('moon',40,70,500))


def test_lunar_candidate_order_preserves_best_available_gsd(tmp_path):
    region=Region('moon',0,23,500)
    fine=raster(tmp_path,region,10);coarse=raster(tmp_path,region,50)
    groups=ConfiguredLunarTerrainProvider([coarse,fine],use_usgs=False).locate(region)
    assert groups[0][0]==fine


@pytest.mark.parametrize('body,lat,lon,size',[('mars',0,0,500),('moon',math.nan,0,500),('earth',91,0,500),('moon',0,181,500),('earth',0,0,30001)])
def test_request_validation(body,lat,lon,size):
    with pytest.raises(ValueError):Region(body,lat,lon,size)


def test_stream_reports_failure_without_fake_completed_stages(monkeypatch):
    import data.terrain_routes as routes
    def unavailable(region,progress):
        progress('LOCATING DATA','started','query')
        raise DataUnavailable('No authoritative data at the selected coordinate.')
    monkeypatch.setattr(routes,'acquire_dem',unavailable)
    response=TestClient(app).post('/api/v1/terrain/acquire',json={'body':'moon','lat':40,'lon':70})
    events=[json.loads(line) for line in response.text.splitlines()]
    assert events[-1]['code']=='DATA_UNAVAILABLE'
    assert not any(event.get('status')=='completed' for event in events)
    assert not any(event.get('type')=='result' for event in events)


def test_stream_analysis_and_optional_imagery_failure_are_independent(monkeypatch,tmp_path):
    import data.terrain_routes as routes
    region=Region('earth',10,20,500);product=raster(tmp_path,region)
    monkeypatch.setattr(routes,'acquire_dem',lambda request,progress:acquire_dem(request,progress,Provider([[product]])))
    monkeypatch.setattr(routes.SentinelImageryProvider,'acquire',lambda *args:(_ for _ in ()).throw(DataUnavailable('No cloud-free RGB')))
    response=TestClient(app).post('/api/v1/terrain/acquire',json={'body':'earth','lat':10,'lon':20,'region_size_m':500,'sentinel_imagery':True})
    events=[json.loads(line) for line in response.text.splitlines()]
    assert events[-1]['type']=='result'
    result=events[-1]['analysis']
    assert result['metadata']['provenance']['status']=='MEASURED'
    assert result['metadata']['provenance']['acquisition']['imagery']['status']=='unavailable'
    assert any(e.get('stage')=='ANALYSING' and e.get('status')=='completed' for e in events)
    assert not any(e.get('stage')=='BUILDING TERRAIN' for e in events)  # actual GPU draw belongs to the client


def test_sentinel_rgb_uses_catalogue_sort_contract_and_never_changes_dem(monkeypatch,tmp_path):
    import data.terrain_routes as routes
    import data.terrain_providers as providers
    region=Region('earth',10,20,500);product=raster(tmp_path,region)
    image=tmp_path/'sentinel-rgb.tif'
    with rasterio.open(image,'w',driver='GTiff',height=201,width=201,count=3,dtype='uint8',
            crs=region.crs,transform=from_origin(-1005,1005,10,10)) as dst:
        dst.write(np.full((3,201,201),128,dtype=np.uint8))
    def catalogue(url,params):
        assert url==providers.SENTINEL_STAC and params['sortby']=='-properties.datetime'
        return {'features':[{'id':'recent-rgb','assets':{'visual':{'href':str(image)}},
            'properties':{'datetime':'2026-01-01T00:00:00Z','eo:cloud_cover':5}}]}
    monkeypatch.setattr(providers,'_json_get',catalogue)
    monkeypatch.setattr(routes,'acquire_dem',lambda request,progress:acquire_dem(request,progress,Provider([[product]])))
    def request(imagery):
        response=TestClient(app).post('/api/v1/terrain/acquire',json={'body':'earth','lat':10,'lon':20,'region_size_m':500,'sentinel_imagery':imagery})
        return json.loads(response.text.splitlines()[-1])['analysis']
    dem_only=request(False);with_rgb=request(True)
    assert with_rgb['terrain']==dem_only['terrain']
    imagery=with_rgb['metadata']['provenance']['acquisition']['imagery']
    assert imagery['dataset_id']=='recent-rgb' and imagery['cloud_cover_pct']==5
    assert with_rgb['metadata']['color_url'].startswith('/artifacts/imagery/')


def test_bounded_lunar_catalogue_does_not_discard_available_configured_dem(monkeypatch,tmp_path):
    from data import terrain_providers as providers
    region=Region('moon',10,20,30000);p=raster(tmp_path,region,spacing=200)
    calls=[]
    def catalogue(url,params):
        calls.append(url)
        return {'features':[{'id':'no-dtm','properties':{},'assets':{}}],'links':[{'rel':'next','href':'https://example.test/next'}]}
    monkeypatch.setattr(providers,'_json_get',catalogue)
    provider=ConfiguredLunarTerrainProvider(products=[p])
    groups=provider.locate(region)
    assert provider.catalogue_limited
    assert len(calls)<=5*len(region.geographic_boxes())
    assert groups[0][0].id==p.id


def test_regional_polar_cog_avoids_unbounded_partial_strip_search(monkeypatch):
    from data import terrain_providers as providers
    def unexpected(*args):
        raise AssertionError('Regional polar coverage must not enumerate STAC strips')
    monkeypatch.setattr(providers,'_json_get',unexpected)
    provider=ConfiguredLunarTerrainProvider()
    groups=provider.locate(Region('moon',-89.76,-171.8,30000))
    assert any(p.id=='NASA-PGDA-80S-40m' for group in groups for p in group)
    assert len(groups)<=providers.MAX_SOURCE_GROUPS


def test_acquisition_rejects_a_mosaic_over_input_budget(monkeypatch,tmp_path):
    from data import terrain_providers as providers
    region=Region('earth',10,20,500);p=raster(tmp_path,region)
    monkeypatch.setattr(providers,'MAX_INPUT_BYTES',100)
    with pytest.raises(DataUnavailable,match='input memory budget'):
        acquire_dem(region,lambda *args:None,Provider([[p]]))
