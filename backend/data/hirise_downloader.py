"""HiRISE DTM downloader — fetch real Mars terrain from NASA/USGS open data on AWS.

Downloads Cloud-Optimized GeoTIFFs (COGs) of Mars Digital Terrain Models
from the public AWS registry: s3://nasa-usgs-mars-hirise-dtms/

Usage:
    python -m backend.data.hirise_downloader            # list available DTMs
    python -m backend.data.hirise_downloader --download  # fetch first 3 DTMs

References:
    - Registry: https://registry.opendata.aws/nasa-usgs-mars-hirise-dtms/
    - HiRISE:   https://www.uahirise.org/dtm/
    - PDS ODE:  https://ode.rsl.wustl.edu/mars/
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

HIRISE_S3_BUCKET = "nasa-usgs-mars-hirise-dtms"
HIRISE_S3_REGION = "us-west-2"

# Local cache directory for downloaded DTMs
DATA_CACHE_DIR = Path(os.environ.get(
    "ARES_DATA_CACHE",
    Path(__file__).resolve().parent.parent.parent / "data_cache" / "hirise"
))

# Pre-curated catalog of interesting HiRISE DTMs with metadata.
# These cover scientifically significant Mars landing/exploration sites.
CURATED_DTMS = [
    {
        "id": "jezero-delta",
        "name": "Jezero Crater Delta Front",
        "s3_key": "DTEED_037197_1985_036907_1985_U01/DTEED_037197_1985_036907_1985_U01_DEM.tif",
        "description": "Perseverance rover landing site — ancient river delta in Jezero Crater",
        "body": "mars",
        "lat": 18.4446,
        "lon": 77.4508,
        "resolution_m": 1.0,
        "approx_size_mb": 250,
    },
    {
        "id": "gale-msl-landing",
        "name": "Gale Crater / MSL Landing Ellipse",
        "s3_key": "DTEEC_009149_1750_009294_1750_U01/DTEEC_009149_1750_009294_1750_U01_DEM.tif",
        "description": "Curiosity rover landing site inside Gale Crater",
        "body": "mars",
        "lat": -4.5895,
        "lon": 137.4417,
        "resolution_m": 1.0,
        "approx_size_mb": 180,
    },
    {
        "id": "nili-fossae",
        "name": "Nili Fossae Carbonate Outcrop",
        "s3_key": "DTEEC_002176_2025_003231_2025_U01/DTEEC_002176_2025_003231_2025_U01_DEM.tif",
        "description": "Clay-bearing region — candidate ancient habitable environment",
        "body": "mars",
        "lat": 22.3,
        "lon": 77.0,
        "resolution_m": 1.0,
        "approx_size_mb": 200,
    },
    {
        "id": "columbia-hills",
        "name": "Columbia Hills / Spirit Landing",
        "s3_key": "DTEEC_014084_1655_013517_1655_U01/DTEEC_014084_1655_013517_1655_U01_DEM.tif",
        "description": "Spirit rover exploration area in Gusev Crater",
        "body": "mars",
        "lat": -14.5718,
        "lon": 175.4785,
        "resolution_m": 1.0,
        "approx_size_mb": 160,
    },
    {
        "id": "hellas-planitia-wall",
        "name": "Hellas Planitia Basin Wall",
        "s3_key": "DTEEC_001397_1415_002175_1415_U01/DTEEC_001397_1415_002175_1415_U01_DEM.tif",
        "description": "Deepest impact basin on Mars — extreme elevation gradient",
        "body": "mars",
        "lat": -38.3,
        "lon": 60.4,
        "resolution_m": 1.0,
        "approx_size_mb": 190,
    },
]


def get_cache_path(dtm_id: str) -> Path:
    """Get the local file path for a cached DTM."""
    return DATA_CACHE_DIR / f"{dtm_id}.tif"


def get_metadata_path(dtm_id: str) -> Path:
    """Get the local metadata JSON path."""
    return DATA_CACHE_DIR / f"{dtm_id}_meta.json"


def list_curated_dtms() -> list[dict]:
    """Return the curated DTM catalog with download status."""
    catalog = []
    for dtm in CURATED_DTMS:
        entry = {**dtm}
        cache_path = get_cache_path(dtm["id"])
        entry["cached"] = cache_path.exists()
        entry["cache_path"] = str(cache_path) if cache_path.exists() else None
        catalog.append(entry)
    return catalog


def download_dtm(
    dtm_id: str,
    force: bool = False,
    progress_callback: Optional[callable] = None,
) -> Path:
    """Download a curated HiRISE DTM from AWS S3.

    Uses boto3 with no-sign-request (public bucket). Falls back to
    urllib if boto3 is not installed.

    Args:
        dtm_id: ID from CURATED_DTMS catalog.
        force: Re-download even if cached.
        progress_callback: Optional fn(bytes_downloaded, total_bytes).

    Returns:
        Path to the local GeoTIFF file.

    Raises:
        ValueError: If dtm_id is not in the catalog.
        RuntimeError: If download fails.
    """
    # Find DTM in catalog
    dtm_info = None
    for dtm in CURATED_DTMS:
        if dtm["id"] == dtm_id:
            dtm_info = dtm
            break
    if dtm_info is None:
        valid_ids = [d["id"] for d in CURATED_DTMS]
        raise ValueError(f"Unknown DTM id '{dtm_id}'. Valid: {valid_ids}")

    cache_path = get_cache_path(dtm_id)
    meta_path = get_metadata_path(dtm_id)

    if cache_path.exists() and not force:
        logger.info(f"DTM '{dtm_id}' already cached at {cache_path}")
        return cache_path

    # Ensure cache directory exists
    DATA_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    s3_key = dtm_info["s3_key"]
    s3_url = f"https://{HIRISE_S3_BUCKET}.s3.{HIRISE_S3_REGION}.amazonaws.com/{s3_key}"

    logger.info(f"Downloading HiRISE DTM '{dtm_id}' from {s3_url}")

    try:
        import boto3
        from botocore import UNSIGNED
        from botocore.config import Config

        s3_client = boto3.client(
            "s3",
            region_name=HIRISE_S3_REGION,
            config=Config(signature_version=UNSIGNED),
        )

        # Get file size for progress
        head = s3_client.head_object(Bucket=HIRISE_S3_BUCKET, Key=s3_key)
        total_bytes = head["ContentLength"]

        # Download with progress callback
        downloaded = [0]

        def _progress(chunk_bytes):
            downloaded[0] += chunk_bytes
            if progress_callback:
                progress_callback(downloaded[0], total_bytes)

        s3_client.download_file(
            HIRISE_S3_BUCKET,
            s3_key,
            str(cache_path),
            Callback=_progress,
        )

    except ImportError:
        # Fallback: use urllib for no-dependency download
        logger.info("boto3 not available, falling back to urllib")
        import urllib.request

        with urllib.request.urlopen(s3_url) as response:
            total_bytes = int(response.headers.get("Content-Length", 0))
            downloaded = 0
            chunk_size = 1024 * 1024  # 1 MB chunks

            with open(cache_path, "wb") as f:
                while True:
                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if progress_callback:
                        progress_callback(downloaded, total_bytes)

    except Exception as exc:
        # Clean up partial download
        if cache_path.exists():
            cache_path.unlink()
        raise RuntimeError(f"Failed to download DTM '{dtm_id}': {exc}") from exc

    # Save metadata alongside the DTM
    meta = {
        **dtm_info,
        "cache_path": str(cache_path),
        "file_size_bytes": cache_path.stat().st_size,
        "checksum_md5": _md5(cache_path),
    }
    meta_path.write_text(json.dumps(meta, indent=2))

    logger.info(
        f"Downloaded DTM '{dtm_id}': {cache_path.stat().st_size / 1e6:.1f} MB"
    )
    return cache_path


def load_dtm_as_numpy(
    dtm_id: str,
    target_size: int = 512,
) -> tuple[np.ndarray, dict]:
    """Load a cached HiRISE DTM and resample to target grid size.

    Returns:
        (elevation_grid, metadata_dict) where elevation_grid is [target_size x target_size]
        normalized float32, and metadata contains geo info.

    Raises:
        FileNotFoundError: If DTM is not cached (download it first).
    """
    import rasterio
    from rasterio.enums import Resampling

    cache_path = get_cache_path(dtm_id)
    if not cache_path.exists():
        raise FileNotFoundError(
            f"DTM '{dtm_id}' not cached. Call download_dtm('{dtm_id}') first."
        )

    with rasterio.open(str(cache_path)) as src:
        # Read with resampling to target size
        data = src.read(
            1,
            out_shape=(target_size, target_size),
            resampling=Resampling.bilinear,
        ).astype(np.float32)

        bounds = src.bounds
        crs = str(src.crs) if src.crs else "unknown"
        native_res = abs(src.transform.a)
        nodata = src.nodata

    # Handle nodata
    if nodata is not None:
        data = np.where(data == nodata, np.nan, data)

    # Inpaint NaN regions
    nan_mask = np.isnan(data)
    if nan_mask.any():
        import cv2
        data_filled = np.where(nan_mask, 0.0, data).astype(np.float32)
        mask_uint8 = nan_mask.astype(np.uint8)
        data = cv2.inpaint(data_filled, mask_uint8, inpaintRadius=5, flags=cv2.INPAINT_TELEA)

    height_min = float(np.nanmin(data))
    height_max = float(np.nanmax(data))
    height_range = height_max - height_min

    # Find the catalog entry for metadata
    dtm_info = next((d for d in CURATED_DTMS if d["id"] == dtm_id), {})

    metadata = {
        "terrain_name": dtm_info.get("name", f"HiRISE DTM {dtm_id}"),
        "source": "hirise-dtm",
        "grid_size": target_size,
        "world_scale_m": native_res * target_size,
        "height_scale_m": height_range,
        "resolution_m_per_px": native_res * (src.width / target_size) if 'src' in dir() else native_res,
        "native_resolution_m_per_px": native_res,
        "crs": crs,
        "height_min_m": height_min,
        "height_max_m": height_max,
        "bounds_left": bounds.left,
        "bounds_right": bounds.right,
        "bounds_bottom": bounds.bottom,
        "bounds_top": bounds.top,
        "body": dtm_info.get("body", "mars"),
        "lat": dtm_info.get("lat"),
        "lon": dtm_info.get("lon"),
        "description": dtm_info.get("description", ""),
    }

    # Normalize to [0, 1]
    if height_range > 0.01:
        normalized = (data - height_min) / height_range
    else:
        normalized = np.zeros_like(data)

    return normalized.astype(np.float32), metadata


def _md5(path: Path) -> str:
    """Compute MD5 checksum of a file."""
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

    catalog = list_curated_dtms()
    print(f"\n{'='*70}")
    print(f"ARES Terrain Intel -- HiRISE DTM Catalog ({len(catalog)} entries)")
    print(f"{'='*70}")
    for dtm in catalog:
        status = "CACHED" if dtm["cached"] else "NOT DOWNLOADED"
        print(f"  [{status:14s}]  {dtm['id']:20s}  {dtm['name']}")
        print(f"           lat={dtm['lat']}, lon={dtm['lon']}, ~{dtm['approx_size_mb']}MB")
        print(f"           {dtm['description']}")
        print()

    if "--download" in sys.argv:
        dtm_id = sys.argv[sys.argv.index("--download") + 1] if len(sys.argv) > sys.argv.index("--download") + 1 else catalog[0]["id"]
        print(f"\nDownloading '{dtm_id}'...")

        def show_progress(downloaded, total):
            pct = (downloaded / total * 100) if total else 0
            mb = downloaded / 1e6
            print(f"\r  Progress: {mb:.1f} MB ({pct:.0f}%)", end="", flush=True)

        path = download_dtm(dtm_id, progress_callback=show_progress)
        print(f"\n  Saved to: {path}")
        print(f"  Size: {path.stat().st_size / 1e6:.1f} MB")
