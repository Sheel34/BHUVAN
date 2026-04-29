from __future__ import annotations

from io import BytesIO

import cv2
import numpy as np
from PIL import Image, UnidentifiedImageError

try:
    import rasterio  # type: ignore
    from rasterio.enums import Resampling  # type: ignore

    HAS_RASTERIO = True
except ImportError:
    HAS_RASTERIO = False

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
    if not HAS_RASTERIO:
        raise RuntimeError("rasterio is not installed. Run: pip install rasterio")

    with rasterio.open(path) as src:
        data = src.read(
            1,
            out_shape=(1, target_size, target_size),
            resampling=Resampling.bilinear,
        ).astype(np.float32)

        nodata = src.nodata
        crs_str = str(src.crs) if src.crs else "unknown"
        native_res_m = abs(src.transform.a)
        orig_size = src.width
        resampled_res_m = native_res_m * (orig_size / target_size)
        world_scale_m = resampled_res_m * target_size

    grid = data[0]
    if nodata is not None:
        grid = np.where(grid == nodata, np.nan, grid)

    nan_mask = np.isnan(grid).astype(np.uint8)
    if nan_mask.any():
        grid_filled = np.where(np.isnan(grid), 0.0, grid)
        grid = cv2.inpaint(grid_filled, nan_mask, inpaintRadius=3, flags=cv2.INPAINT_TELEA)

    height_range_m = float(np.nanmax(grid) - np.nanmin(grid))
    normalised = _normalize_grid(grid)

    return normalised, _make_metadata(
        "GeoTIFF DEM",
        "geotiff",
        target_size,
        world_scale_m=world_scale_m,
        height_scale_m=height_range_m,
        crs=crs_str,
        native_resolution_m_per_px=native_res_m,
    )
