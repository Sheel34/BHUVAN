"""Location acquisition using bounded native raster windows, independent of Three.js.

Copernicus GLO-30/GLO-90: https://registry.opendata.aws/copernicus-dem/
USGS LOLA-aligned lunar DTMs: https://stac.astrogeology.usgs.gov/docs/data/moon/kaguyatc_dtms/
Server-side LOLA/SLDEM COGs can be configured with BHUVAN_LUNAR_DEM_MANIFEST.
No user-supplied URL, whole-product download, imagery-derived height or synthetic fallback.
"""
from __future__ import annotations

import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol

import numpy as np

MOON_RADIUS_M = 1737400.0
MAX_SAMPLES = max(129, min(1025, int(os.environ.get("BHUVAN_MAX_SAMPLES", "1025"))))
MAX_WINDOW_PIXELS = 4_000_000
MAX_INPUT_BYTES = max(16, min(256, int(os.environ.get("BHUVAN_MAX_INPUT_MIB", "64")))) * 1024 * 1024
MAX_SOURCE_GROUPS = 16
USGS_STAC = "https://stac.astrogeology.usgs.gov/api/search"
USGS_COLLECTION = "kaguya_terrain_camera_usgs_dtms_v2"
SENTINEL_STAC = "https://earth-search.aws.element84.com/v1/search"
Progress = Callable[[str, str, str], None]


class DataUnavailable(ValueError):
    def __init__(self, message, code="DATA_UNAVAILABLE"):
        super().__init__(message)
        self.code = code


def metric_elevation_unit(dataset):
    declared=dataset.units[0]
    if declared and declared.strip().lower() not in ('m','metre','meter','metres','meters'):
        raise DataUnavailable(f'Elevation band unit {declared!r} requires explicit metric conversion.')
    return {'elevation_unit':'m','elevation_unit_basis':'band metadata' if declared else 'configured product assumes metres; band unit unspecified'}


@dataclass(frozen=True)
class Region:
    body: str
    lat: float
    lon: float
    size_m: float = 2000

    def __post_init__(self):
        if self.body not in ("earth", "moon") or not all(math.isfinite(v) for v in (self.lat, self.lon, self.size_m)):
            raise ValueError("A supported body and finite coordinates/size are required.")
        if not -90 <= self.lat <= 90 or not -180 <= self.lon <= 180 or not 500 <= self.size_m <= 30000:
            raise ValueError("Latitude/longitude out of range or region outside 500–30000 m.")

    @property
    def crs(self):
        from rasterio.crs import CRS
        model = "+datum=WGS84" if self.body == "earth" else f"+R={MOON_RADIUS_M}"
        return CRS.from_string(f"+proj=aeqd +lat_0={self.lat} +lon_0={self.lon} {model} +units=m +no_defs")

    @property
    def geographic_crs(self):
        from rasterio.crs import CRS
        return CRS.from_epsg(4326) if self.body == "earth" else CRS.from_string(f"+proj=longlat +R={MOON_RADIUS_M} +no_defs")

    def outline(self):
        half = self.size_m / 2
        t = np.linspace(-half, half, 21).tolist()
        return t + [half]*21 + t[::-1] + [-half]*21, [-half]*21 + t + [half]*21 + t[::-1]

    def geographic_boxes(self):
        from rasterio.warp import transform
        xs, ys = self.outline()
        lon, lat = transform(self.crs, self.geographic_crs, xs, ys)
        lon = [self.lon + ((x - self.lon + 180) % 360) - 180 for x in lon]
        west, east, south, north = min(lon), max(lon), min(lat), max(lat)
        # A pole-containing region spans all longitudes; a tiny geographic box is invalid there.
        radius = 6371000 if self.body == "earth" else MOON_RADIUS_M
        if math.radians(90-abs(self.lat))*radius <= self.size_m / math.sqrt(2):
            return [[-180, min(south, -90 if self.lat<0 else south), 180, max(north, 90 if self.lat>0 else north)]]
        if west < -180:
            return [[west+360,south,180,north],[-180,south,east,north]]
        if east > 180:
            return [[west,south,180,north],[-180,south,east-360,north]]
        return [[west,south,east,north]]


@dataclass(frozen=True)
class Product:
    id: str
    uri: str
    source: str
    body: str
    gsd_m: float
    vertical_reference: str
    attribution: str
    bounds: tuple | None = None
    catalogue_metadata: dict | None = None


class TerrainProvider(Protocol):
    def locate(self, region: Region) -> list[list[Product]]: ...


class LunarTerrainProvider(TerrainProvider, Protocol):
    """A ranked set of lunar source mosaics. Scientific lunar CRS is required."""


def _json_get(url, params):
    query = urllib.parse.urlencode(params)
    request = urllib.request.Request(f"{url}{'?' + query if query else ''}", headers={"User-Agent":"BHUVAN-Terrain/1.0"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def require_range_access(uri):
    """Refuse remote products that would force a complete raster download."""
    if not uri.startswith("https://"):
        if uri.startswith("http://") or not Path(uri).is_file():
            raise DataUnavailable("Configured raster is missing or does not use HTTPS.")
        return
    request = urllib.request.Request(uri, headers={"Range":"bytes=0-0", "User-Agent":"BHUVAN-Terrain/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            if response.status != 206 or not response.headers.get("Content-Range"):
                raise DataUnavailable("Raster host does not support bounded HTTP Range reads.")
            response.read(1)
    except urllib.error.HTTPError as exc:
        raise DataUnavailable(f"Raster unavailable (HTTP {exc.code}).") from exc


class CopernicusTerrainProvider:
    @staticmethod
    def tile_uri(lat, lon, resolution):
        arc = 10 if resolution == 30 else 30
        name = f"Copernicus_DSM_COG_{arc}_{'N' if lat>=0 else 'S'}{abs(lat):02d}_00_{'E' if lon>=0 else 'W'}{abs(lon):03d}_00_DEM"
        return f"https://copernicus-dem-{resolution}m.s3.amazonaws.com/{name}/{name}.tif"

    def locate(self, region):
        if region.body != "earth":
            raise ValueError("Copernicus uses an Earth reference system.")
        tiles=set()
        for west,south,east,north in region.geographic_boxes():
            for lat in range(max(-90,math.floor(south-.001)), min(90,math.ceil(north+.001))):
                for lon in range(math.floor(west-.001), math.ceil(east+.001)):
                    tiles.add((lat,(lon+180)%360-180))
        if len(tiles)>64:
            raise DataUnavailable("Region intersects too many source tiles. Choose a smaller region.","REGION_TOO_LARGE")
        groups=[]
        for resolution in (30,90):
            groups.append([Product(f"COP-DEM_GLO-{resolution}_{lat}_{lon}",self.tile_uri(lat,lon,resolution),
                f"copernicus-glo-{resolution}","earth",resolution,"EGM2008 orthometric height",
                "Copernicus DEM 2021 / European Union, ESA, Airbus; AWS public COG",(lon,lat,lon+1,lat+1)) for lat,lon in sorted(tiles)])
        return groups


class ConfiguredLunarTerrainProvider:
    def __init__(self, products=None, use_usgs=True):
        self.products = products
        self.use_usgs = use_usgs
        self.catalogue_limited = False

    def _configured(self):
        if self.products is not None:
            return self.products
        products=[]
        manifest=os.environ.get("BHUVAN_LUNAR_DEM_MANIFEST")
        if manifest:
            with open(manifest,encoding="utf-8") as source:
                for entry in json.load(source):
                    if entry.get("body") != "moon" or entry.get("source") not in ("lola-dem","sldem2015","usgs-lunar-dem"):
                        raise ValueError("Lunar manifest requires body=moon and a LOLA/SLDEM/USGS source.")
                    products.append(Product(**entry))
        # Existing downloaded products remain usable; never invoke the downloader.
        from .lroc_downloader import CURATED_DEMS, get_dem_cache_path
        site04=get_dem_cache_path('nasa-pgda-site04-5m')
        if site04.is_file():
            products.append(Product('NASA-PGDA-Site04-5m',str(site04),'lola-dem','moon',5,
                'Height Z in metres; 1737400 m lunar sphere; MOON_ME / DE421 source frame',
                'NASA GSFC PGDA / Barker et al. 2021',(-180,-90,180,-89),
                {'reference':'https://pgda.gsfc.nasa.gov/products/78','readme':'https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/README',
                 'surface_model':'LOLA surface-interpolated DEM; 5 m pixel spacing does not imply 5 m effective resolution or rock detection'}))
        for entry in CURATED_DEMS:
            path=get_dem_cache_path(entry["id"])
            if path.is_file():
                products.append(Product(entry["id"],str(path),"lola-dem","moon",entry["resolution_m"],
                    "LOLA lunar reference sphere; verify product label", "NASA GSFC LOLA",(-180,-90,180,-87 if '87s' in entry['id'] else -85)))
        # NASA publishes these regional products as range-readable COGs. They cover
        # the whole south pole, unlike individual 5 m landing-site patches.
        for spacing in (40, 80):
            products.append(Product(f'NASA-PGDA-80S-{spacing}m',
                f'https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_{spacing}MPP_ADJ.TIF',
                'lola-dem','moon',spacing,
                'Height Z in metres; 1737400 m lunar sphere; MOON_ME / DE421 source frame',
                'NASA GSFC PGDA / Barker et al. 2023',(-180,-90,180,-80),
                {'reference':'https://pgda.gsfc.nasa.gov/products/90',
                 'regional_coverage':True,
                 'surface_model':'LOLA interpolated topography; pixel spacing is not effective resolution',
                 'quality_maps':{
                     'effective_resolution':'https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_20MPP_ADJ_EFFRES.TIF',
                     'height_error':'https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_20MPP_ADJ_ERR.TIF'},
                 'quality_maps_status':'Published companion products; not sampled in this acquisition'}))
        return products

    def locate(self, region):
        if region.body != "moon":
            raise ValueError("Lunar provider requires lunar coordinates.")
        candidates=[]
        for product in self._configured():
            if product.body != "moon":
                raise ValueError("Lunar product body mismatch.")
            if product.bounds is None or any(_boxes_intersect(box,product.bounds) for box in region.geographic_boxes()):
                candidates.append(product)
        boxes=region.geographic_boxes()
        regional_coverage=any((p.catalogue_metadata or {}).get('regional_coverage')
            and p.bounds and all(box[1]>=p.bounds[1] and box[3]<=p.bounds[3] for box in boxes)
            for p in candidates)
        # Avoid enumerating hundreds of overlapping Kaguya strips when the
        # complete polar COG already covers the requested region.
        if self.use_usgs and not regional_coverage:
            try:
                for box in region.geographic_boxes():
                    url=USGS_STAC;params={"collections":USGS_COLLECTION,"bbox":','.join(map(str,box)),"limit":100}
                    features=[]
                    for page in range(5):
                        result=_json_get(url,params);batch=result.get('features',[]);features.extend(batch)
                        next_link=next((link for link in result.get('links',[]) if link.get('rel')=='next'),None)
                        if not batch or not next_link:
                            break
                        if page==4:
                            self.catalogue_limited = True
                            break
                        url=next_link['href'];params={}
                    for feature in features:
                        props=feature.get("properties",{}); asset=feature.get("assets",{}).get("dtm")
                        if not asset or 'moon' not in [v.lower() for v in props.get('ssys:targets',[])]:
                            continue
                        candidates.append(Product(feature["id"],asset["href"],"usgs-lunar-dem","moon",float(props['gsd']),
                            "Height above IAU Moon 2015 sphere (1737400 m); LOLA-aligned, not geoid adjusted",
                            "USGS Kaguya TC DTM v2 / JAXA / NASA LOLA; CC0",tuple(feature['bbox']),
                            {"collection":USGS_COLLECTION,"properties":props,"raster_bands":asset.get('raster:bands')}))
            except (OSError, urllib.error.URLError) as exc:
                if not candidates:
                    raise DataUnavailable(f"Lunar catalogue could not be reached: {exc}") from exc
        unique={product.id:product for product in candidates}
        if not unique:
            raise DataUnavailable("No configured authoritative lunar DEM intersects this location.")
        # Complementary strips at one resolution can jointly cover a selected region.
        # Prefer finer products; retain coarser groups for an explicitly recorded fallback.
        ordered=sorted(unique.values(),key=lambda p:(p.gsd_m,p.id))
        compatible={}
        for product in ordered:
            compatible.setdefault((product.source,product.vertical_reference),[]).append(product)
        mosaics=[group for group in compatible.values() if 1<len(group)<=64]
        groups=sorted([[p] for p in ordered],key=lambda group:group[0].gsd_m)
        # Reserve attempts for complementary strips instead of spending every
        # slot on individual partial-coverage products.
        if len(groups)+len(mosaics)>MAX_SOURCE_GROUPS:
            self.catalogue_limited=True
            groups=groups[:MAX_SOURCE_GROUPS-min(len(mosaics),4)]
            mosaics=mosaics[:4]
        return groups+mosaics


def _boxes_intersect(a,b):
    if a[1]>b[3] or a[3]<b[1]:
        return False
    west,east=b[0],b[2]
    if east<west:
        east+=360
    # Lunar products may publish east-positive longitudes in 0–360.
    return any(a[0]<=east+shift and a[2]>=west+shift for shift in (-360,0,360))


def _native_window(dataset, region, indexes=1, overview=False):
    from rasterio.warp import transform
    from rasterio.windows import Window, from_bounds
    xs,ys=region.outline()
    x,y=transform(region.crs,dataset.crs,xs,ys)
    if dataset.crs.is_geographic:
        center=(dataset.bounds.left+dataset.bounds.right)/2
        x=[center+((v-center+180)%360)-180 for v in x]
    if dataset.transform.b or dataset.transform.d:
        raise DataUnavailable("Rotated source rasters are not supported by this window reader.")
    # Halo is read at native resolution for bilinear interpolation across tile edges.
    rx,ry=map(abs,dataset.res)
    raw=from_bounds(min(x)-(32 if overview else 2)*rx,min(y)-(32 if overview else 2)*ry,max(x)+(32 if overview else 2)*rx,max(y)+(32 if overview else 2)*ry,dataset.transform)
    col=max(0,math.floor(raw.col_off)); row=max(0,math.floor(raw.row_off))
    end_col=min(dataset.width,math.ceil(raw.col_off+raw.width)); end_row=min(dataset.height,math.ceil(raw.row_off+raw.height))
    if end_col<=col or end_row<=row:
        raise DataUnavailable("Source raster does not intersect this region.","SOURCE_NOT_INTERSECTING")
    window=Window(col,row,end_col-col,end_row-row)
    pixels=window.width*window.height
    if pixels>MAX_WINDOW_PIXELS and not overview:
        raise DataUnavailable("Native source window exceeds the working-set limit. Enable wide-area overview or choose a smaller region.","REGION_TOO_LARGE")
    if pixels>64_000_000:
        raise DataUnavailable("This fine product needs more than 64 million source samples. Select a coarser regional DEM or inspect a smaller patch.","REGION_TOO_LARGE")
    factor=max(1,math.ceil(max(window.width,window.height)/MAX_SAMPLES)) if overview else 1
    affine=dataset.window_transform(window)
    if factor==1:
        return dataset.read(indexes,window=window,masked=True),window,affine
    if indexes!=1:
        raise DataUnavailable("Overview aggregation currently supports scalar elevation only.")
    # Explicit box averaging in bounded stripes, with conservative NoData:
    # any missing source cell marks the corresponding overview cell missing.
    # NoData is not bridged by GDAL's usual valid-sample averaging.
    from affine import Affine
    h=math.ceil(window.height/factor); w=math.ceil(window.width/factor)
    result=np.ma.masked_all((h,w),dtype=np.float32)
    rows_per=max(1,min(64,MAX_WINDOW_PIXELS//(factor*int(window.width))))
    for out_row in range(0,h,rows_per):
        rows=min(rows_per,h-out_row); native_rows=min(rows*factor,int(window.height)-out_row*factor)
        stripe=dataset.read(1,window=Window(window.col_off,window.row_off+out_row*factor,window.width,native_rows),masked=True)
        padded=np.ma.masked_all((rows*factor,w*factor),dtype=np.float32)
        padded[:native_rows,:int(window.width)]=stripe
        blocks=padded.reshape(rows,factor,w,factor)
        means=blocks.mean(axis=(1,3))
        means.mask=np.ma.getmaskarray(blocks).any(axis=(1,3))
        result[out_row:out_row+rows]=means
    return result,window,affine*Affine.scale(factor)


def _spacing(dataset, region):
    from rasterio.warp import transform
    cx,cy=transform(region.geographic_crs,dataset.crs,[region.lon],[region.lat])
    x,y=transform(dataset.crs,region.crs,[cx[0],cx[0]+dataset.res[0],cx[0]],
        [cy[0],cy[0],cy[0]+dataset.res[1]])
    spacing=[math.hypot(x[1]-x[0],y[1]-y[0]),math.hypot(x[2]-x[0],y[2]-y[0])]
    if not all(math.isfinite(v) and v>0 for v in spacing):
        raise DataUnavailable("Source sample spacing cannot be represented at this location.")
    return spacing


def acquire_dem(region, progress: Progress, provider=None, overview=False):
    """Return normalized local metric grid plus complete native-source provenance."""
    import rasterio
    from rasterio.transform import from_origin
    from rasterio.warp import reproject, Resampling
    progress("LOCATING DATA","started",f"{region.body} {region.lat:.5f}, {region.lon:.5f}")
    provider=provider or (CopernicusTerrainProvider() if region.body=="earth" else ConfiguredLunarTerrainProvider())
    groups=provider.locate(region)
    progress("LOCATING DATA","completed",f"{len(groups)} candidate source set(s)" + ("; catalogue search capped, candidates still checked for full coverage" if getattr(provider,"catalogue_limited",False) else ""))
    failures=[]
    for products in groups:
        parts=[]; spacings=[]; source_meta=[]; decoded_bytes=0
        try:
            progress("READING DEM","started",', '.join(dict.fromkeys(p.source for p in products)))
            with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif,.tiff,.TIF",
                    GDAL_HTTP_TIMEOUT="20", GDAL_HTTP_MAX_RETRY="1", VSI_CACHE=False):
                for product in products:
                    progress("READING DEM","working",f"Reading native window: {product.id}")
                    require_range_access(product.uri)
                    started=time.perf_counter()
                    with rasterio.open(product.uri) as dataset:
                        if not dataset.crs:
                            raise DataUnavailable("Source is missing a coordinate reference system.")
                        if region.body=="moon":
                            params=dataset.crs.to_dict()
                            radius=params.get('R',params.get('a',0))
                            if abs(float(radius)-MOON_RADIUS_M)>1:
                                raise DataUnavailable("Lunar source CRS must use the 1737400 m Moon sphere; Earth CRS is invalid.")
                        if dataset.count!=1:
                            raise DataUnavailable("Elevation product must have one scalar band.")
                        elevation_unit=metric_elevation_unit(dataset)
                        spacing=_spacing(dataset,region)
                        try:
                            values,window,affine=_native_window(dataset,region,overview=overview)
                        except DataUnavailable as exc:
                            if exc.code=="SOURCE_NOT_INTERSECTING" and len(products)>1:
                                failures.append({"datasets":[product.id],"reason":str(exc)})
                                continue
                            raise
                        spacings.append(spacing)
                        if not overview and math.ceil(region.size_m/min(spacing))+1>MAX_SAMPLES:
                            raise DataUnavailable("Region exceeds the native analysis limit. Enable wide-area overview or reduce the patch width.","REGION_TOO_LARGE")
                        decoded_bytes+=values.size*8
                        if decoded_bytes>MAX_INPUT_BYTES:
                            raise DataUnavailable("Source mosaic exceeds the bounded input memory budget. Use a coarser product or smaller region.","REGION_TOO_LARGE")
                        values=values.astype(np.float64).filled(np.nan)*dataset.scales[0]+dataset.offsets[0]
                        parts.append((values,affine,dataset.crs))
                        source_meta.append({"dataset_id":product.id,"uri":product.uri,"source":product.source,
                            "crs":dataset.crs.to_wkt(),"shape":[dataset.height,dataset.width],"gsd":[abs(v) for v in dataset.res],
                            "gsd_unit":"degrees" if dataset.crs.is_geographic else dataset.crs.linear_units,
                            "local_gsd_m":spacing,"window":[int(window.col_off),int(window.row_off),int(window.width),int(window.height)],
                            "read_spacing_m":[spacing[0]*abs(affine.a/dataset.transform.a),spacing[1]*abs(affine.e/dataset.transform.e)],"affine":list(affine)[:6],"scale":dataset.scales[0],"offset":dataset.offsets[0],
                            **elevation_unit,"nodata":dataset.nodata if dataset.nodata is not None and math.isfinite(dataset.nodata) else None,
                            "tags":dataset.tags(),"block_shapes":dataset.block_shapes,"read_ms":(time.perf_counter()-started)*1000,
                            "decoded_window_bytes":values.nbytes,"attribution":product.attribution,"catalogue":product.catalogue_metadata})
            if not parts:
                raise DataUnavailable("Candidate rasters do not intersect this region.")
            progress("READING DEM","completed",f"{len(parts)} native raster window(s)")
            progress("REPROJECTING/RESAMPLING","started","Bounded overview grid; effective spacing reported separately" if overview else "Local metric grid; preserving the finest native-axis spacing")
            spacing=min(min(pair) for pair in spacings)
            if overview:
                spacing=max(spacing,region.size_m/(MAX_SAMPLES-1),min(min(p["read_spacing_m"]) for p in source_meta))
            cells=math.ceil(region.size_m/spacing)+1
            if cells>MAX_SAMPLES:
                raise DataUnavailable("Region exceeds the native-resolution working set.","REGION_TOO_LARGE")
            extent=(cells-1)*spacing
            # Pixel centres span ±extent/2. Renderer and metric analysis use those centres.
            affine=from_origin(-(extent+spacing)/2,(extent+spacing)/2,spacing,spacing)
            mosaic=np.full((cells,cells),np.nan,dtype=np.float64)
            for values,source_affine,source_crs in parts:
                destination=np.full_like(mosaic,np.nan)
                reproject(values,destination,src_transform=source_affine,src_crs=source_crs,src_nodata=np.nan,
                    dst_transform=affine,dst_crs=region.crs,dst_nodata=np.nan,resampling=Resampling.bilinear)
                # Bilinear interpolation can bridge small nodata holes. Preserve
                # the native coverage mask independently of height interpolation.
                coverage=np.zeros(mosaic.shape,dtype=np.uint8)
                reproject(np.isfinite(values).astype(np.uint8),coverage,
                    src_transform=source_affine,src_crs=source_crs,
                    dst_transform=affine,dst_crs=region.crs,dst_nodata=0,resampling=Resampling.nearest)
                valid=(coverage==1)&np.isfinite(destination)&~np.isfinite(mosaic)
                mosaic[valid]=destination[valid]
            if not np.isfinite(mosaic).all():
                raise DataUnavailable("DEM has missing cells in the requested region; gaps were not filled or replaced.")
            progress("REPROJECTING/RESAMPLING","completed",f"{cells} × {cells} samples · {spacing:.3f} m/sample")
            low=float(mosaic.min()); relief=float(mosaic.max()-low)
            grid=(mosaic-low)/relief if relief>0 else np.zeros_like(mosaic)
            metadata={"terrain_name":f"{region.body.title()} terrain · {region.lat:.4f}, {region.lon:.4f}",
                "source":source_meta[0]['source'],"body":region.body,"dataset_id":' + '.join(p['dataset_id'] for p in source_meta),
                "grid_size":cells,"world_scale_m":extent,"height_scale_m":relief,"height_min_m":low,
                "resolution_m_per_px":spacing,"native_resolution_m_per_px":max(max(pair) for pair in spacings),"lat":region.lat,"lon":region.lon,
                "crs":region.crs.to_wkt(),"earth_crs":region.body=="earth","vertical_reference":products[0].vertical_reference,
                "reference_model":{"body":"moon","kind":"configured lunar reference sphere","radius_m":MOON_RADIUS_M} if region.body=='moon' else {"body":"earth","kind":"WGS84 horizontal; source vertical datum retained"},
                "affine":list(affine)[:6],"bounds":[-extent/2,-extent/2,extent/2,extent/2],"resampled":True,
                "original_height":source_meta[0]['shape'][0],"original_width":source_meta[0]['shape'][1],"window":source_meta[0]['window'],
                "acquisition":{"selected_lat":region.lat,"selected_lon":region.lon,"requested_size_m":region.size_m,
                    "actual_sample_extent_m":extent,"products":source_meta,"reprojection":"bilinear to local azimuthal equidistant",
                    "selection_failures":failures,"catalogue_search_limited":getattr(provider,"catalogue_limited",False),"imagery":None,"sampling_mode":"overview" if overview else "native","analysis_spacing_m":spacing},
                "disclaimer": "Bounded native DEM windows reprojected to a local metric grid; original CRS, sample spacing and source windows are retained. "
                    + ("Copernicus is a surface model including vegetation/buildings, not a bare-earth DTM. " if region.body=='earth' else "Lunar registration follows product metadata; no SPICE epoch/ME-to-PA transform is applied. ")
                    + ("Wide-area overview: bounded block means and local reprojection; small obstacles can disappear. " if overview else "The square analysis grid retains the finer native-axis spacing; the coarser axis is interpolated. ") + "Bilinear interpolation changes samples; resolution does not imply positional accuracy."}
            return grid.astype(np.float32),metadata
        except (DataUnavailable, rasterio.errors.RasterioError, OSError, ValueError) as exc:
            if isinstance(exc,DataUnavailable) and exc.code=="REGION_TOO_LARGE" and (not overview or len(groups)==1):
                raise
            failures.append({"datasets":[p.id for p in products],"reason":str(exc)})
            progress("READING DEM","retry",str(exc))
    raise DataUnavailable("No available authoritative DEM completely covers the requested region. " + (failures[-1]['reason'] if failures else 'No candidates.'))


class SentinelImageryProvider:
    """Optional RGB acquisition. Never writes elevation or changes DEM analysis spacing."""
    def acquire(self, region, metadata, output_dir):
        import rasterio
        from rasterio.transform import Affine
        from rasterio.warp import reproject, Resampling
        from PIL import Image
        import uuid
        if region.body!='earth':
            raise DataUnavailable("Sentinel imagery is Earth-only.")
        candidates=[]
        for box in region.geographic_boxes():
            result=_json_get(SENTINEL_STAC,{"collections":"sentinel-2-l2a","bbox":','.join(map(str,box)),"limit":20,"sortby":"-properties.datetime"})
            candidates.extend(result.get('features',[]))
        candidates.sort(key=lambda f:(f.get('properties',{}).get('eo:cloud_cover',100),f['id']))
        for item in candidates:
            asset=item.get('assets',{}).get('visual')
            if not asset:
                continue
            try:
                require_range_access(asset['href'])
                with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR',GDAL_HTTP_TIMEOUT='20',GDAL_HTTP_MAX_RETRY='1'):
                    with rasterio.open(asset['href']) as source:
                        values,_,affine=_native_window(source,region,[1,2,3])
                        size=metadata['grid_size']; rgb=np.zeros((3,size,size),dtype=np.uint8)
                        coverage=np.zeros((size,size),dtype=np.uint8)
                        reproject((~np.ma.getmaskarray(values).any(axis=0)).astype(np.uint8),coverage,
                            src_transform=affine,src_crs=source.crs,dst_transform=Affine(*metadata['affine']),dst_crs=region.crs,resampling=Resampling.nearest)
                        if not coverage.all():
                            continue
                        reproject(values.filled(0),rgb,src_transform=affine,src_crs=source.crs,
                            dst_transform=Affine(*metadata['affine']),dst_crs=region.crs,resampling=Resampling.bilinear)
                folder=Path(output_dir)/'imagery';folder.mkdir(exist_ok=True)
                name=f"sentinel-{uuid.uuid4().hex}.png";Image.fromarray(rgb.transpose(1,2,0)).save(folder/name)
                return f"/artifacts/imagery/{name}",{"dataset_id":item['id'],"source":"Sentinel-2 L2A RGB", "uri":asset['href'],
                    "datetime":item.get('properties',{}).get('datetime'),"cloud_cover_pct":item.get('properties',{}).get('eo:cloud_cover'),
                    "role":"surface color only; DEM geometry unchanged","selection":"lowest reported cloud cover among up to 20 recent catalogue results"}
            except (ValueError,OSError,rasterio.errors.RasterioError):
                continue
        raise DataUnavailable("No accessible Sentinel RGB product fully covers the DEM region.")
