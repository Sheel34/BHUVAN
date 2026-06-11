from __future__ import annotations

from io import BytesIO

import cv2
import numpy as np
from PIL import Image, UnidentifiedImageError

import rasterio  # type: ignore
from rasterio.enums import Resampling  # type: ignore
from rasterio.errors import RasterioIOError

DEFAULT_SIZE = 160
DEFAULT_WORLD_SCALE_M = 200.0
DEFAULT_HEIGHT_SCALE_M = 30.0


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
        image = Image.open(BytesIO(content))
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


def ingest_geotiff(
    path: str,
    target_size: int = 512,
) -> tuple[np.ndarray, dict]:
    try:
        with rasterio.open(path) as src:
            # Validate CRS
            if src.crs is None:
                raise ValueError("GeoTIFF has no CRS defined. Please provide a georeferenced DEM.")
            
            crs_str = str(src.crs)
            is_projected = src.crs.is_projected
            
            # Extract bounds and transform
            bounds = src.bounds
            native_res_m = abs(src.transform.a)
            orig_width = src.width
            orig_height = src.height
            
            # Validate resolution is reasonable
            if native_res_m <= 0 or native_res_m > 1000:
                raise ValueError(f"Invalid resolution: {native_res_m} m/pixel. Expected 0-1000 m/pixel.")
            
            # Calculate resampled resolution
            resampled_res_m = native_res_m * (orig_width / target_size)
            world_scale_m = resampled_res_m * target_size
            
            # Read and resample data
            data = src.read(
                1,
                out_shape=(target_size, target_size),
                resampling=Resampling.bilinear,
            ).astype(np.float32)
            
            nodata = src.nodata
            
            # Extract additional metadata
            metadata_extra = {
                "original_width": orig_width,
                "original_height": orig_height,
                "bounds_left": bounds.left,
                "bounds_right": bounds.right,
                "bounds_bottom": bounds.bottom,
                "bounds_top": bounds.top,
                "is_projected_crs": is_projected,
            }
            
    except RasterioIOError as e:
        raise ValueError(f"Failed to read GeoTIFF: {e}") from e

    grid = data
    
    # Handle nodata values
    if nodata is not None:
        grid = np.where(grid == nodata, np.nan, grid)
    
    # Validate data range
    valid_pixels = ~np.isnan(grid)
    if valid_pixels.sum() < 0.1 * grid.size:
        raise ValueError("GeoTIFF has insufficient valid data (<10% of pixels).")
    
    # Inpaint missing data
    nan_mask = np.isnan(grid).astype(np.uint8)
    if nan_mask.any():
        grid_filled = np.where(np.isnan(grid), 0.0, grid)
        grid = cv2.inpaint(grid_filled, nan_mask, inpaintRadius=3, flags=cv2.INPAINT_TELEA)
    
    # Calculate height statistics
    height_min_m = float(np.nanmin(grid))
    height_max_m = float(np.nanmax(grid))
    height_range_m = height_max_m - height_min_m
    
    if height_range_m < 0.1:
        raise ValueError(f"Terrain has insufficient height variation: {height_range_m:.2f}m")
    
    normalised = _normalize_grid(grid)
    
    return normalised, _make_metadata(
        "GeoTIFF DEM",
        "geotiff",
        target_size,
        world_scale_m=world_scale_m,
        height_scale_m=height_range_m,
        crs=crs_str,
        native_resolution_m_per_px=native_res_m,
        height_min_m=height_min_m,
        height_max_m=height_max_m,
        **metadata_extra,
    )
