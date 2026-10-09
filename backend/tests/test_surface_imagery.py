from io import BytesIO
import numpy as np
import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import from_origin
from PIL import Image
from fastapi.testclient import TestClient
from main import app,OUTPUT_DIR
from pathlib import Path

client=TestClient(app)

def raster_bytes(data,transform=None):
    array=np.asarray(data)
    if array.ndim==2: array=array[None,:,:]
    with MemoryFile() as file:
        with file.open(driver='GTiff',width=array.shape[2],height=array.shape[1],count=array.shape[0],dtype=array.dtype,crs='EPSG:32643',transform=transform or from_origin(500000,3400000,2,2)) as raster:
            raster.write(array)
        return file.read()

def fixtures():
    row,col=np.indices((33,33))
    dem=(100+row*3+col*2).astype('float32')
    rgb=np.stack([col*7,row*6,np.full((33,33),30)]).astype('uint8')
    return dem,rgb

def test_paired_orthophoto_preserves_measured_elevations_and_registers_pixel_colours():
    dem,rgb=fixtures()
    plain=client.post('/api/v1/analyze-upload',files={'file':('dem.tif',raster_bytes(dem),'image/tiff')})
    pair=client.post('/api/v1/analyze-pair',files={'dem':('dem.tif',raster_bytes(dem),'image/tiff'),'orthophoto':('photo.tif',raster_bytes(rgb),'image/tiff')})
    assert plain.status_code==pair.status_code==200,pair.text
    payload=pair.json()
    assert payload['terrain']==plain.json()['terrain']
    assert payload['metadata']['provenance']['status']=='MEASURED'
    assert payload['metadata']['provenance']['surface_imagery']['coverage']=='complete'
    with Image.open(Path(OUTPUT_DIR)/'imagery'/Path(payload['metadata']['color_url']).name) as image:
        np.testing.assert_array_equal(np.asarray(image),np.moveaxis(rgb,0,2))

def test_pair_rejects_non_overlapping_image_and_float_elevation_as_colour():
    dem,rgb=fixtures()
    for bad_image in [raster_bytes(rgb,from_origin(600000,3500000,2,2)),raster_bytes(dem)]:
        response=client.post('/api/v1/analyze-pair',files={'dem':('dem.tif',raster_bytes(dem),'image/tiff'),'orthophoto':('bad.tif',bad_image,'image/tiff')})
        assert response.status_code==422

def test_original_photo_colour_survives_edge_depth_and_height_stays_estimated():
    _,rgb=fixtures();buffer=BytesIO();Image.fromarray(np.moveaxis(rgb,0,2)).save(buffer,format='PNG')
    image=client.post('/api/v1/surface-image',files={'file':('colours.png',buffer.getvalue(),'image/png')})
    assert image.status_code==200
    url=image.json()['color_url']
    row,col=np.indices((16,16))
    result=client.post('/api/v1/analyze-edge',json={'grid':((row+col)/30).tolist(),'color_url':url})
    assert result.status_code==200,result.text
    assert result.json()['metadata']['color_url']==url
    assert result.json()['metadata']['provenance']['status']=='ESTIMATED'
    assert not result.json()['metadata']['provenance']['metric']
    with Image.open(Path(OUTPUT_DIR)/'imagery'/Path(url).name) as output:
        np.testing.assert_array_equal(np.asarray(output),np.moveaxis(rgb,0,2))

def test_curated_lroc_catalogue_has_five_measured_source_pairs_and_normalized_locations():
    from data.lroc_catalogue import catalogue,selected_product
    entries=catalogue();assert len(entries)==5
    for entry in entries:
        assert -180<=entry['lon']<=180 and -90<=entry['lat']<=90
        selected,provider=selected_product(entry['id'])
        assert provider.products[0].body=='moon'
        assert provider.products[0].source=='lroc-nac-dtm'
        assert entry['dtm']!=entry['ortho']
