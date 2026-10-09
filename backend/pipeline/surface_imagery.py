"""Colour is a display layer; it never changes DEM elevations."""
from io import BytesIO
from pathlib import Path
import hashlib
import numpy as np
from PIL import Image, ImageOps


def save_rgb_image(content, output_dir):
    with Image.open(BytesIO(content)) as source:
        image=ImageOps.exif_transpose(source).convert('RGB')
        image.thumbnail((2048,2048),Image.Resampling.LANCZOS)
        key=hashlib.sha256(content).hexdigest()[:24]
        directory=Path(output_dir)/'imagery';directory.mkdir(parents=True,exist_ok=True)
        image.save(directory/f'{key}.png')
    return f'/artifacts/imagery/{key}.png'


def align_raster_image(uri, metadata, output_dir, region=None):
    """Read a bounded orthophoto window and register it to the DEM pixel centres.

    Alignment requires a real CRS; a photograph without one cannot use this path.
    Native elevation is untouched. Imagery is a resampled display product.
    """
    import rasterio
    from affine import Affine
    from rasterio.warp import transform, reproject, Resampling
    from rasterio.windows import Window, from_bounds
    n=metadata['grid_size'];dst_transform=Affine(*metadata['affine'])
    dst_crs=rasterio.crs.CRS.from_string(metadata['crs'])
    corners=[dst_transform*(x,y) for x,y in ((0,0),(n,0),(n,n),(0,n))]
    # Sample every edge to cover non-linear transformations.
    outline=[(a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t) for a,b in zip(corners,corners[1:]+corners[:1]) for t in np.linspace(0,1,21)]
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR',GDAL_HTTP_TIMEOUT='20',GDAL_HTTP_MAX_RETRY='1',VSI_CACHE=False):
        with rasterio.open(uri) as source:
            if not source.crs or source.count not in (1,3,4):
                raise ValueError('Orthophoto requires a CRS and one grayscale or three RGB bands (optional alpha).')
            if source.transform.b or source.transform.d:
                raise ValueError('Rotated image grids need explicit preprocessing.')
            xs,ys=transform(dst_crs,source.crs,[p[0] for p in outline],[p[1] for p in outline])
            rx,ry=map(abs,source.res)
            raw=from_bounds(min(xs)-rx,min(ys)-ry,max(xs)+rx,max(ys)+ry,source.transform)
            c=max(0,int(np.floor(raw.col_off)));r=max(0,int(np.floor(raw.row_off)))
            e=min(source.width,int(np.ceil(raw.col_off+raw.width)));b=min(source.height,int(np.ceil(raw.row_off+raw.height)))
            if e<=c or b<=r: raise ValueError('Orthophoto does not overlap the selected DEM.')
            window=Window(c,r,e-c,b-r)
            if window.width*window.height>4_000_000:
                raise ValueError('Image window exceeds 4 million native pixels. Use the orthophoto at DTM resolution or a smaller patch.')
            indexes=[1] if source.count==1 else [1,2,3]
            values=source.read(indexes,window=window,masked=True)
            if values.dtype not in (np.dtype('uint8'),np.dtype('uint16')):
                raise ValueError('Display orthophoto must contain 8-bit or 16-bit image bands; a floating-point DEM is not a colour image.')
            src_transform=source.window_transform(window)
            coverage=np.zeros((n,n),dtype=np.uint8)
            valid=~np.ma.getmaskarray(values).any(axis=0)
            reproject(valid.astype('uint8'),coverage,src_transform=src_transform,src_crs=source.crs,dst_transform=dst_transform,dst_crs=dst_crs,resampling=Resampling.nearest)
            if not coverage.all(): raise ValueError('Orthophoto has gaps in the selected DEM patch. Supply a fully overlapping image or select a covered region.')
            rgb=np.zeros((len(indexes),n,n),dtype=np.float32)
            for i in range(len(indexes)):
                reproject(values[i].filled(0).astype(np.float32),rgb[i],src_transform=src_transform,src_crs=source.crs,dst_transform=dst_transform,dst_crs=dst_crs,resampling=Resampling.bilinear)
            if values.dtype==np.uint16: rgb/=257
            rgb=np.clip(np.rint(rgb),0,255).astype('uint8')
            if len(indexes)==1: rgb=np.repeat(rgb,3,axis=0)
            key=hashlib.sha256((str(uri)+str(metadata['affine'])+metadata['crs']+str(n)).encode()).hexdigest()[:24]
            directory=Path(output_dir)/'imagery';directory.mkdir(parents=True,exist_ok=True)
            Image.fromarray(np.moveaxis(rgb,0,2)).save(directory/f'{key}.png')
            info={'dataset_id':Path(str(uri)).name,'source':'supplied georeferenced orthophoto','resampling':'bilinear colour only; DEM unchanged','source_crs':source.crs.to_wkt(),'native_window':[c,r,e-c,b-r],'display_shape':[n,n],'coverage':'complete'}
    return f'/artifacts/imagery/{key}.png',info
