from __future__ import annotations

from io import BytesIO

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

# rasterio is imported lazily inside ingest_geotiff(): it links native
# GDAL/expat libs that may be absent on minimal cloud images. Keeping the
# import lazy lets the API boot and serve the procedural + image paths even
# where those system libs aren't installed.

# 512-cell grid over a 2 km patch (~3.9 m/cell) — large-terrain defaults
# sized for dedicated-GPU rendering via the chunked LOD pipeline.
DEFAULT_SIZE = 512
DEFAULT_WORLD_SCALE_M = 2000.0
DEFAULT_HEIGHT_SCALE_M = 220.0


def _normalize_grid(grid: np.ndarray) -> np.ndarray:
    grid = grid.astype(np.float32)
    min_val = float(grid.min())
    max_val = float(grid.max())
    if max_val - min_val < 1e-6:
        return np.zeros_like(grid, dtype=np.float32)
    return (grid - min_val) / (max_val - min_val)


def _make_metadata(
    terrain_name: str,
    source: str,
    size: int,
    world_scale_m: float = DEFAULT_WORLD_SCALE_M,
    height_scale_m: float = DEFAULT_HEIGHT_SCALE_M,
    **extra,
) -> dict:
    return {
        "terrain_name": terrain_name,
        "source": source,
        "grid_size": size,
        "world_scale_m": world_scale_m,
        "height_scale_m": height_scale_m,
        "resolution_m_per_px": world_scale_m / (size - 1),
        **extra,
    }


def generate_sample(
    sample: str,
    size: int = DEFAULT_SIZE,
) -> tuple[np.ndarray, dict]:
    xs = np.linspace(-1.0, 1.0, size, dtype=np.float32)
    zs = np.linspace(-1.0, 1.0, size, dtype=np.float32)
    xx, zz = np.meshgrid(xs, zs)

    if sample == "moon-south-pole":
        rim = np.exp(-((np.sqrt(xx**2 + zz**2) - 0.58) ** 2) / 0.018)
        bowl = -0.9 * np.exp(-(xx**2 + zz**2) / 0.22)
        ridges = 0.12 * np.sin(xx * 18.0) + 0.08 * np.cos(zz * 22.0)
        grid = rim + bowl + ridges
        name = "Lunar South Pole Analogue"
    elif sample == "moon-shackleton":
        # Steep-walled polar crater: sharp rim, deep shadowed bowl, rim terraces
        r = np.sqrt(xx**2 + zz**2)
        rim = 1.1 * np.exp(-((r - 0.5) ** 2) / 0.008)
        bowl = -1.3 * np.exp(-(r**2) / 0.14)
        terraces = 0.08 * np.sin(r * 40.0) * np.exp(-((r - 0.42) ** 2) / 0.02)
        rough = 0.05 * np.sin(xx * 31.0) * np.cos(zz * 27.0)
        grid = rim + bowl + terraces + rough
        name = "Shackleton Crater Rim Analogue"
    elif sample == "moon-tycho":
        # Young complex crater: central peak, hummocky floor, slumped walls
        r = np.sqrt(xx**2 + zz**2)
        peak = 0.85 * np.exp(-(r**2) / 0.015)
        floor = -0.55 * np.exp(-(r**2) / 0.30)
        wall = 0.7 * np.exp(-((r - 0.75) ** 2) / 0.012)
        hummocks = 0.10 * np.sin(xx * 23.0 + 1.7) * np.sin(zz * 19.0)
        grid = peak + floor + wall + hummocks
        name = "Tycho Crater Floor Analogue"
    elif sample == "moon-mare-tranquillitatis":
        # Flat basaltic mare: gentle wrinkle ridges, scattered small craters
        ridges = 0.18 * np.sin(xx * 6.0 + zz * 2.0) * np.exp(-(zz**2) / 0.5)
        plain = 0.05 * np.sin(xx * 3.0) * np.cos(zz * 4.0)
        craters = np.zeros_like(xx)
        for cx, cz, cr in ((0.3, -0.2, 0.05), (-0.45, 0.35, 0.03), (-0.1, -0.5, 0.04)):
            d2 = (xx - cx) ** 2 + (zz - cz) ** 2
            craters += -0.3 * np.exp(-d2 / cr) + 0.12 * np.exp(-((np.sqrt(d2) - np.sqrt(cr) * 1.4) ** 2) / 0.004)
        grid = ridges + plain + craters
        name = "Mare Tranquillitatis Analogue"
    elif sample == "mars-gale":
        mound = 0.9 * np.exp(-((xx * 0.7) ** 2 + (zz * 0.7) ** 2) / 0.18)
        channel = -0.25 * np.exp(-((xx + 0.25) ** 2) / 0.04)
        dunes = 0.15 * np.sin(zz * 25.0 + xx * 6.0)
        grid = mound + channel + dunes
        name = "Mars Gale Crater Analogue"
    else:
        ridge = 0.4 * np.sin(xx * 12.0) * np.cos(zz * 9.0)
        crater = -0.75 * np.exp(-((xx - 0.18) ** 2 + (zz + 0.15) ** 2) / 0.06)
        ejecta = 0.2 * np.exp(-((np.sqrt((xx - 0.18) ** 2 + (zz + 0.15) ** 2) - 0.32) ** 2) / 0.01)
        delta = 0.25 * np.exp(-((zz - 0.35) ** 2) / 0.05)
        grid = ridge + crater + ejecta + delta
        name = "Mars Jezero Analogue"

    normalised = _normalize_grid(grid)
    return normalised, _make_metadata(name, "bundled-procedural", size)


def ingest_image_bytes(
    content: bytes,
    size: int = DEFAULT_SIZE,
    world_scale_m: float = DEFAULT_WORLD_SCALE_M,
    height_scale_m: float = DEFAULT_HEIGHT_SCALE_M,
) -> tuple[np.ndarray, dict]:
    try:
        image = ImageOps.exif_transpose(Image.open(BytesIO(content)))
    except UnidentifiedImageError as exc:
        raise ValueError(f"Cannot decode image: {exc}") from exc

    orig_w, orig_h = image.size
    grey = np.asarray(image.convert("L"), dtype=np.float32)
    resized = cv2.resize(grey, (size, size), interpolation=cv2.INTER_AREA)
    normalised = _normalize_grid(resized)

    return normalised, _make_metadata(
        terrain_name="User Upload",
        source="uploaded-image",
        size=size,
        world_scale_m=world_scale_m,
        height_scale_m=height_scale_m,
        original_width=orig_w,
        original_height=orig_h,
        disclaimer=(
            "Image treated as grayscale heightmap. "
            "No geospatial projection or real-world scale applied. "
            "Values are pixel-intensity proxies only."
        ),
    )


def ingest_geotiff(path: str, target_size: int = 512) -> tuple[np.ndarray, dict]:
    """Read a bounded native-resolution window, never stretch or resample a DEM.

    Geographic/rotated/anisotropic rasters need a body-aware transform that this
    square-patch client does not implement. Reject them rather than fake metres.
    """
    import rasterio
    from rasterio.windows import Window
    from rasterio.errors import RasterioIOError

    try:
        with rasterio.open(path) as src:
            if src.crs is None or not src.crs.is_projected:
                raise ValueError("Metric analysis requires a projected body-appropriate CRS. Geographic degrees are not metres; automatic reprojection is not implemented.")
            t = src.transform
            factor = src.crs.linear_units_factor[1]
            cell = abs(t.a) * factor
            if t.b != 0 or t.d != 0 or not np.isclose(abs(t.a), abs(t.e)) or not np.isfinite(cell) or cell <= 0:
                raise ValueError("Rotated or unequal-spacing grids require explicit reprojection before square-patch analysis.")
            n = min(target_size, src.width, src.height)
            if n < 2:
                raise ValueError("DEM window must contain at least 2 x 2 samples.")
            window = Window((src.width-n)//2, (src.height-n)//2, n, n)
            band = src.read(1, window=window, masked=True)
            if np.ma.getmaskarray(band).any() or not np.isfinite(band).all():
                raise ValueError("Selected DEM window contains missing elevations. No-data interpolation is not performed silently; supply a valid window.")
            declared_unit = src.units[0]
            unit = (declared_unit or "m").lower()
            if unit not in ("m", "metre", "meter", "metres", "meters"):
                raise ValueError(f"Elevation unit {unit!r} requires explicit conversion to metres.")
            grid = np.asarray(band, dtype=np.float64) * src.scales[0] + src.offsets[0]
            transform = src.window_transform(window)
            lo, hi = float(grid.min()), float(grid.max())
            crs = str(src.crs)
            wkt = src.crs.to_wkt().lower()
            body = "moon" if "moon" in wkt or "lunar" in wkt else "mars" if "mars" in wkt else "earth" if "wgs" in wkt or "nad" in wkt else "unknown"
            reference_params=src.crs.to_dict()
            radius=reference_params.get('R')
            if radius is not None and abs(float(radius)-1737400)<1:
                body='moon'
            reference_model={"body":body,"kind":"source CRS reference model","crs_wkt":src.crs.to_wkt()}
            if radius is not None:
                reference_model.update(radius_m=float(radius),kind="source reference sphere")
            elif 'a' in reference_params:
                reference_model.update(a_m=float(reference_params['a']),b_m=float(reference_params.get('b',reference_params['a'])))
            metadata = _make_metadata(
                "GeoTIFF DEM", "geotiff", n, world_scale_m=cell*(n-1),
                height_scale_m=hi-lo, crs=crs, native_resolution_m_per_px=cell,
                original_width=src.width, original_height=src.height,
                height_min_m=lo, height_max_m=hi, body=body,
                dataset_id="uploaded-geotiff",
                window=[int(window.col_off), int(window.row_off), n, n],
                bounds=list(src.window_bounds(window)), affine=list(transform)[:6],
                vertical_reference="source CRS/band; datum unspecified; " + ("band unit " + unit if declared_unit else "band unit unspecified, metres assumed; verify source"),
                resampled=False,
                reference_model=reference_model,
                horizontal_unit=src.crs.linear_units,
                disclaimer="Native-resolution central square window; exterior samples remain in the source file. Body/reference inferred only from CRS; verify before use.",
            )
    except RasterioIOError as exc:
        raise ValueError(f"Failed to read GeoTIFF: {exc}") from exc
    # Use float64 so large absolute offsets do not contaminate local relief.
    relative = (grid-lo)/(hi-lo) if hi > lo else np.zeros_like(grid)
    return relative, metadata
