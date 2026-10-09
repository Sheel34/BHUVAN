"""Terrain-RGB transport quantization. It does not improve DEM accuracy."""
import io
import numpy as np
from PIL import Image

def encode_height_rgb(height):
    values=np.asarray(height,dtype=np.float64)
    if values.ndim!=2 or not np.isfinite(values).all():
        raise ValueError('Height RGB requires a finite two-dimensional metric raster; NoData needs an explicit mask.')
    if values.min() < -10000 or values.max() > 1667721.5:
        raise ValueError('Elevation outside the Terrain-RGB representable range.')
    packed=np.rint((values+10000)*10).astype(np.uint32)
    rgb=np.stack([(packed>>16)&255,(packed>>8)&255,packed&255],axis=-1).astype(np.uint8)
    stream=io.BytesIO();Image.fromarray(rgb).save(stream,format='PNG')
    return stream.getvalue()

def decode_height_rgb(content):
    rgb=np.asarray(Image.open(io.BytesIO(content)).convert('RGB'),dtype=np.uint32)
    return -10000+(rgb[...,0]*65536+rgb[...,1]*256+rgb[...,2])*.1
