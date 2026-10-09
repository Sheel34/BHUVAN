import numpy as np
import pytest
from pipeline.ingest import ingest_geotiff
from pipeline.terrain_analysis import analyze_terrain, _roughness_std, _curvature_laplacian
from pipeline.landing_zones import _footprint_sensitivity
from main import build_payload


def test_absolute_offset_does_not_change_analysis():
    x=np.arange(32, dtype=np.float64)
    grid=np.tile(x*.01,(32,1))
    a=analyze_terrain(grid,cell_size_m=1)
    b=analyze_terrain(grid+1e6,cell_size_m=1)
    for key in a:
        assert np.allclose(a[key]['data'],b[key]['data'],atol=1e-5)


def test_five_point_laplacian_has_expected_physical_scale():
    x=np.arange(16,dtype=np.float32)
    grid=np.tile(x*x,(16,1))
    assert np.allclose(_curvature_laplacian(grid,1)[2:-2,2:-2],2)


def test_image_result_is_relative_and_has_no_metric_candidates():
    grid=np.tile(np.linspace(0,1,32),(32,1))
    result=build_payload(grid,{'source':'uploaded-image','terrain_name':'test','world_scale_m':2000,'height_scale_m':220})
    assert result.metadata.provenance['status']=='ESTIMATED'
    assert result.metadata.provenance['metric'] is False
    assert result.terrain.max_h==1
    assert result.landing_zones==[]


def test_measured_absolute_elevation_is_preserved():
    grid=np.zeros((32,32))
    result=build_payload(grid,{'source':'geotiff','terrain_name':'test','world_scale_m':31,'height_scale_m':0,'height_min_m':1234.5})
    assert result.terrain.min_h==1234.5
    assert result.intelligence.elevation.min_m==1234.5


def test_dem_derived_estimate_retains_known_metric_scale():
    grid=np.tile(np.linspace(0,1,32),(32,1))
    result=build_payload(grid,{'source':'geotiff+ai-enhanced','terrain_name':'test','world_scale_m':31,'height_scale_m':2,'height_min_m':1234})
    assert result.metadata.provenance['status']=='ESTIMATED'
    assert result.metadata.provenance['metric'] is True
    assert result.terrain.max_h==1236


def test_sensitivity_depends_on_each_footprint_not_pooled_regions():
    hazards=np.full((8,8),.1,dtype=np.float32);hazards[:,4:]=.3
    left=np.zeros((8,8),bool);left[:,:4]=True
    right=~left
    a=_footprint_sensitivity(hazards,1-hazards,{'a':left})
    b=_footprint_sensitivity(hazards,1-hazards,{'b':right})
    assert a['hazard_ci_upper']<b['hazard_ci_lower']
    assert a['score_ci_lower']>b['score_ci_upper']


def _write_dem(path,crs,transform):
    import rasterio
    grid=1000+np.arange(80*96,dtype=np.float32).reshape(80,96)*.01
    with rasterio.open(path,'w',driver='GTiff',height=80,width=96,count=1,dtype='float32',crs=crs,transform=transform) as dst:
        dst.write(grid,1)
    return grid


def test_geotiff_retains_native_samples_and_explicit_window(tmp_path):
    from rasterio.transform import from_origin
    path=tmp_path/'native.tif'; original=_write_dem(path,'EPSG:32643',from_origin(500000,4000000,2,2))
    grid,meta=ingest_geotiff(str(path),target_size=32)
    assert meta['native_resolution_m_per_px']==2
    assert meta['resolution_m_per_px']==2
    assert meta['window']==[32,24,32,32]
    recovered=grid*meta['height_scale_m']+meta['height_min_m']
    assert np.allclose(recovered,original[24:56,32:64])
    assert meta['resampled'] is False


def test_geographic_degrees_are_never_interpreted_as_metres(tmp_path):
    from rasterio.transform import from_origin
    path=tmp_path/'degrees.tif';_write_dem(path,'EPSG:4326',from_origin(70,30,.001,.001))
    with pytest.raises(ValueError,match='degrees are not metres'):
        ingest_geotiff(str(path))


def test_async_lola_uses_native_product_instead_of_procedural_fallback(monkeypatch, tmp_path):
    from jobs.tasks import _resolve_elevation
    import main
    import data.lroc_downloader as lunar
    path=tmp_path/'lola.tif'
    monkeypatch.setattr(lunar, 'get_dem_cache_path', lambda dataset: path)
    calls=[]
    monkeypatch.setattr(main, '_native_product', lambda *args: calls.append(args) or ('grid', {'body':'moon'}))
    grid,meta=_resolve_elevation({'kind':'sample','sample':'lola-south-pole-87s'})
    assert meta['body']=='moon'
    assert calls[0][0]==path
    assert calls[0][2]=='lola-dem'


def test_cached_failed_job_does_not_report_success(monkeypatch):
    from jobs import routes
    monkeypatch.setattr(routes, '_terminal_status', lambda job: routes.JobStatus(job_id=job,state='FAILURE',error={'code':'TEST'}))
    accepted=routes._submit('test',{})
    assert accepted.state=='FAILURE'
    assert accepted.cached is True
