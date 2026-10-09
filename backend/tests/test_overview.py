import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin
from data.terrain_providers import Region,Product,acquire_dem,DataUnavailable

class Provider:
    def __init__(self,p): self.p=p
    def locate(self,_): return [[self.p]]

def source(tmp_path,region,nodata=False):
    path=tmp_path/'wide.tif';n=3201
    with rasterio.open(path,'w',driver='GTiff',count=1,width=n,height=n,dtype='float32',
            crs=region.crs,transform=from_origin(-16005,16005,10,10),nodata=-9999,tiled=True) as ds:
        values=np.full((n,n),1234.5,dtype=np.float32)
        if nodata:values[1600,1600]=-9999
        ds.write(values,1)
    return Product('survey',str(path),'lola-dem' if region.body=='moon' else 'copernicus-glo-30',region.body,10,'test datum','test fixture')

@pytest.mark.parametrize('body,width',[('earth',30000),('moon',9000)])
def test_overview_keeps_extent_and_absolute_height_with_bounded_working_grid(tmp_path,body,width):
    region=Region(body,10,20,width);p=source(tmp_path,region)
    grid,m=acquire_dem(region,lambda *args:None,Provider(p),overview=True)
    assert max(grid.shape)<=1025
    assert width<=m['world_scale_m']<=width+m['resolution_m_per_px']
    assert m['native_resolution_m_per_px']==pytest.approx(10,rel=1e-5)
    assert m['height_min_m']==pytest.approx(1234.5)
    assert m['acquisition']['sampling_mode']=='overview'
    if width==30000:assert m['resolution_m_per_px']>10

def test_overview_conservatively_retains_a_single_missing_native_sample(tmp_path):
    region=Region('earth',10,20,30000);p=source(tmp_path,region,True)
    with pytest.raises(DataUnavailable,match='missing cells'):
        acquire_dem(region,lambda *args:None,Provider(p),overview=True)
