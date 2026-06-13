"""Lunar terrain downloader — globe textures and site DEMs from NASA open data.

Two asset classes:

1. Globe textures (NASA SVS "CGI Moon Kit", visualization id 4720):
   global LROC color mosaic + LOLA displacement map, made specifically
   for rendering the Moon as a textured sphere. Served to the frontend
   for the hero globe.

2. Site DEMs (LOLA / SLDEM2015 derived GeoTIFFs): regional elevation
   models for landing-site analysis, fed through the same pipeline as
   HiRISE DTMs.

Usage:
    python -m backend.data.lroc_downloader               # list catalog
    python -m backend.data.lroc_downloader --textures    # fetch globe textures
    python -m backend.data.lroc_downloader --download ID # fetch a site DEM

References:
    - CGI Moon Kit:  https://svs.gsfc.nasa.gov/4720/
    - LOLA PDS:      https://pds-geosciences.wustl.edu/missions/lro/lola.htm
    - LOLA 5m polar: https://pgda.gsfc.nasa.gov/products/78
    - SLDEM2015:     https://imbrium.mit.edu/DATA/SLDEM2015/
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SVS_MOON_KIT_BASE = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720"

DATA_CACHE_DIR = Path(os.environ.get(
    "ARES_MOON_CACHE",
    Path(__file__).resolve().parent.parent.parent / "data_cache" / "moon"
))

# Globe textures from the CGI Moon Kit. The color map is an LROC WAC
# mosaic with corrected poles; the displacement maps are LOLA-derived
# global elevation in simple cylindrical projection.
# Color mosaics are published as TIFF only; browsers cannot decode TIFF,
# so the downloader converts them to JPEG (filename) after fetch.
GLOBE_TEXTURES = {
    "color-2k": {
        "filename": "lroc_color_poles_2k.jpg",
        "url": f"{SVS_MOON_KIT_BASE}/lroc_color_poles_2k.tif",
        "kind": "color",
        "approx_size_mb": 3,
        "description": "LROC WAC global color mosaic, 2048x1024",
    },
    "color-4k": {
        "filename": "lroc_color_poles_4k.jpg",
        "url": f"{SVS_MOON_KIT_BASE}/lroc_color_poles_4k.tif",
        "kind": "color",
        "approx_size_mb": 12,
        "description": "LROC WAC global color mosaic, 4096x2048",
    },
    "displacement-2k": {
        "filename": "ldem_3_8bit.jpg",
        "url": f"{SVS_MOON_KIT_BASE}/ldem_3_8bit.jpg",
        "kind": "displacement",
        "approx_size_mb": 1,
        "description": "LOLA global elevation, 8-bit, 2880x1440 (fast load)",
    },
    "displacement-16bit": {
        "filename": "ldem_4_uint.tif",
        "url": f"{SVS_MOON_KIT_BASE}/ldem_4_uint.tif",
        "kind": "displacement",
        "approx_size_mb": 2,
        "description": "LOLA global elevation, 16-bit uint, 5760x2880 (analysis-grade)",
    },
}

# Default texture set fetched by the API on first request: smallest pair
# that still looks good with bump shading.
DEFAULT_TEXTURE_SET = ["color-4k", "displacement-2k"]

# Curated lunar site DEMs. The LOLA 5 m/px polar mosaics from NASA PGDA
# cover the south pole hero sites (Shackleton et al.).
CURATED_DEMS = [
    {
        "id": "lola-south-pole-87s",
        "name": "Lunar South Pole (LOLA 5m, 87°S–90°S)",
        "url": "https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/87S/ldem_87s_5mpp.tif",
        "description": "Shackleton crater and Artemis candidate sites — LOLA laser altimetry polar mosaic",
        "body": "moon",
        "lat": -89.0,
        "lon": 0.0,
        "resolution_m": 5.0,
        "approx_size_mb": 2000,
    },
    {
        "id": "lola-south-pole-85s",
        "name": "Lunar South Pole Wide (LOLA 10m, 85°S–90°S)",
        "url": "https://pgda.gsfc.nasa.gov/data/LOLA_10mpp/85S/ldem_85s_10mpp.tif",
        "description": "Wider south-pole context — Malapert, de Gerlache, Shackleton approaches",
        "body": "moon",
        "lat": -87.5,
        "lon": 0.0,
        "resolution_m": 10.0,
        "approx_size_mb": 1200,
    },
]


def get_texture_path(texture_id: str) -> Path:
    """Local cache path for a globe texture."""
    info = GLOBE_TEXTURES[texture_id]
    return DATA_CACHE_DIR / "textures" / info["filename"]


def get_dem_cache_path(dem_id: str) -> Path:
    """Local cache path for a site DEM."""
    return DATA_CACHE_DIR / f"{dem_id}.tif"


def get_dem_metadata_path(dem_id: str) -> Path:
    return DATA_CACHE_DIR / f"{dem_id}_meta.json"


def list_globe_textures() -> list[dict]:
    """Globe texture catalog with cache status."""
    catalog = []
    for tex_id, info in GLOBE_TEXTURES.items():
        path = get_texture_path(tex_id)
        catalog.append({
            "id": tex_id,
            "kind": info["kind"],
            "filename": info["filename"],
            "description": info["description"],
            "approx_size_mb": info["approx_size_mb"],
            "cached": path.exists(),
        })
    return catalog


def list_curated_dems() -> list[dict]:
    """Site DEM catalog with download status."""
    catalog = []
    for dem in CURATED_DEMS:
        entry = {**dem}
        cache_path = get_dem_cache_path(dem["id"])
        entry["cached"] = cache_path.exists()
        entry["cache_path"] = str(cache_path) if cache_path.exists() else None
        catalog.append(entry)
    return catalog


def _http_download(
    url: str,
    dest: Path,
    progress_callback: Optional[callable] = None,
) -> None:
    """Stream a URL to disk with optional progress reporting."""
    import urllib.request

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = dest.with_suffix(dest.suffix + ".part")

    request = urllib.request.Request(url, headers={"User-Agent": "ares-terrain-intel/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            total_bytes = int(response.headers.get("Content-Length", 0))
            downloaded = 0
            chunk_size = 1024 * 1024

            with open(tmp_path, "wb") as f:
                while True:
                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if progress_callback:
                        progress_callback(downloaded, total_bytes)
        tmp_path.replace(dest)
    except Exception:
        if tmp_path.exists():
            tmp_path.unlink()
        raise


def download_globe_texture(
    texture_id: str,
    force: bool = False,
    progress_callback: Optional[callable] = None,
) -> Path:
    """Download one CGI Moon Kit texture to the local cache.

    Raises:
        ValueError: If texture_id is not in the catalog.
        RuntimeError: If all candidate URLs fail.
    """
    if texture_id not in GLOBE_TEXTURES:
        raise ValueError(
            f"Unknown texture id '{texture_id}'. Valid: {list(GLOBE_TEXTURES.keys())}"
        )

    info = GLOBE_TEXTURES[texture_id]
    path = get_texture_path(texture_id)
    if path.exists() and not force:
        logger.info(f"Texture '{texture_id}' already cached at {path}")
        return path

    url = info["url"]
    source_suffix = Path(url).suffix.lower()
    target_suffix = path.suffix.lower()

    try:
        logger.info(f"Downloading moon texture '{texture_id}' from {url}")
        if source_suffix == target_suffix:
            _http_download(url, path, progress_callback)
        else:
            # Fetch the TIFF original, then convert to a browser-decodable JPEG.
            raw_path = path.with_suffix(source_suffix)
            _http_download(url, raw_path, progress_callback)
            from PIL import Image

            Image.MAX_IMAGE_PIXELS = None  # trusted NASA source, large mosaics
            with Image.open(raw_path) as img:
                img.convert("RGB").save(path, "JPEG", quality=92)
            raw_path.unlink()
    except Exception as exc:
        raise RuntimeError(
            f"Failed to download texture '{texture_id}': {exc}"
        ) from exc

    logger.info(f"Downloaded '{texture_id}': {path.stat().st_size / 1e6:.1f} MB")
    return path


def ensure_default_textures(
    progress_callback: Optional[callable] = None,
) -> dict[str, Path]:
    """Fetch the default globe texture set if missing. Returns id → path."""
    paths = {}
    for tex_id in DEFAULT_TEXTURE_SET:
        paths[tex_id] = download_globe_texture(tex_id, progress_callback=progress_callback)
    return paths


def download_dem(
    dem_id: str,
    force: bool = False,
    progress_callback: Optional[callable] = None,
) -> Path:
    """Download a curated lunar site DEM.

    Warning: polar LOLA mosaics are large (1–2 GB). Check
    `approx_size_mb` in the catalog before fetching.

    Raises:
        ValueError: If dem_id is not in the catalog.
        RuntimeError: If download fails.
    """
    dem_info = next((d for d in CURATED_DEMS if d["id"] == dem_id), None)
    if dem_info is None:
        valid_ids = [d["id"] for d in CURATED_DEMS]
        raise ValueError(f"Unknown DEM id '{dem_id}'. Valid: {valid_ids}")

    cache_path = get_dem_cache_path(dem_id)
    if cache_path.exists() and not force:
        logger.info(f"DEM '{dem_id}' already cached at {cache_path}")
        return cache_path

    try:
        logger.info(f"Downloading lunar DEM '{dem_id}' from {dem_info['url']}")
        _http_download(dem_info["url"], cache_path, progress_callback)
    except Exception as exc:
        raise RuntimeError(f"Failed to download DEM '{dem_id}': {exc}") from exc

    meta = {
        **dem_info,
        "cache_path": str(cache_path),
        "file_size_bytes": cache_path.stat().st_size,
        "checksum_md5": _md5(cache_path),
    }
    get_dem_metadata_path(dem_id).write_text(json.dumps(meta, indent=2))

    logger.info(f"Downloaded DEM '{dem_id}': {cache_path.stat().st_size / 1e6:.1f} MB")
    return cache_path


def load_dem_as_numpy(
    dem_id: str,
    target_size: int = 512,
) -> tuple[np.ndarray, dict]:
    """Load a cached lunar DEM, resampled to target grid size.

    Returns:
        (elevation_grid, metadata) — grid is [target_size x target_size]
        float32 normalized to [0, 1].

    Raises:
        FileNotFoundError: If DEM is not cached (download it first).
    """
    import rasterio
    from rasterio.enums import Resampling

    cache_path = get_dem_cache_path(dem_id)
    if not cache_path.exists():
        raise FileNotFoundError(
            f"DEM '{dem_id}' not cached. Call download_dem('{dem_id}') first."
        )

    with rasterio.open(str(cache_path)) as src:
        data = src.read(
            1,
            out_shape=(target_size, target_size),
            resampling=Resampling.bilinear,
        ).astype(np.float32)

        bounds = src.bounds
        crs = str(src.crs) if src.crs else "unknown"
        native_res = abs(src.transform.a)
        nodata = src.nodata
        src_width = src.width

    if nodata is not None:
        data = np.where(data == nodata, np.nan, data)

    nan_mask = np.isnan(data)
    if nan_mask.any():
        import cv2
        data_filled = np.where(nan_mask, 0.0, data).astype(np.float32)
        mask_uint8 = nan_mask.astype(np.uint8)
        data = cv2.inpaint(data_filled, mask_uint8, inpaintRadius=5, flags=cv2.INPAINT_TELEA)

    height_min = float(np.nanmin(data))
    height_max = float(np.nanmax(data))
    height_range = height_max - height_min

    dem_info = next((d for d in CURATED_DEMS if d["id"] == dem_id), {})

    metadata = {
        "terrain_name": dem_info.get("name", f"Lunar DEM {dem_id}"),
        "source": "lola-dem",
        "grid_size": target_size,
        "world_scale_m": native_res * target_size,
        "height_scale_m": height_range,
        "resolution_m_per_px": native_res * (src_width / target_size),
        "native_resolution_m_per_px": native_res,
        "crs": crs,
        "height_min_m": height_min,
        "height_max_m": height_max,
        "bounds_left": bounds.left,
        "bounds_right": bounds.right,
        "bounds_bottom": bounds.bottom,
        "bounds_top": bounds.top,
        "body": "moon",
        "lat": dem_info.get("lat"),
        "lon": dem_info.get("lon"),
        "description": dem_info.get("description", ""),
    }

    if height_range > 0.01:
        normalized = (data - height_min) / height_range
    else:
        normalized = np.zeros_like(data)

    return normalized.astype(np.float32), metadata


def _md5(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO)

    print(f"\n{'='*70}")
    print("ARES Terrain Intel -- Lunar Asset Catalog")
    print(f"{'='*70}\n")

    print("Globe textures (CGI Moon Kit):")
    for tex in list_globe_textures():
        status = "CACHED" if tex["cached"] else "NOT DOWNLOADED"
        print(f"  [{status:14s}]  {tex['id']:20s}  ~{tex['approx_size_mb']}MB  {tex['description']}")

    print("\nSite DEMs (LOLA):")
    for dem in list_curated_dems():
        status = "CACHED" if dem["cached"] else "NOT DOWNLOADED"
        print(f"  [{status:14s}]  {dem['id']:24s}  ~{dem['approx_size_mb']}MB")
        print(f"           {dem['description']}")

    def show_progress(downloaded, total):
        pct = (downloaded / total * 100) if total else 0
        print(f"\r  Progress: {downloaded / 1e6:.1f} MB ({pct:.0f}%)", end="", flush=True)

    if "--textures" in sys.argv:
        print("\nFetching default globe texture set...")
        for tex_id, path in ensure_default_textures(show_progress).items():
            print(f"\n  {tex_id}: {path}")

    if "--download" in sys.argv:
        idx = sys.argv.index("--download")
        dem_id = sys.argv[idx + 1] if len(sys.argv) > idx + 1 else CURATED_DEMS[0]["id"]
        print(f"\nDownloading '{dem_id}' (large file)...")
        path = download_dem(dem_id, progress_callback=show_progress)
        print(f"\n  Saved to: {path}")
