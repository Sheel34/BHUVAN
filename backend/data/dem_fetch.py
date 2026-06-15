from __future__ import annotations

"""Real-world DEM fetch — genuine accurate elevation, no API key.

Source: AWS Terrain Tiles (s3://elevation-tiles-prod), the public
SRTM + Copernicus + others mosaic in Mapzen "terrarium" PNG encoding:
    height_m = R*256 + G + B/256 - 32768

Fetches a span×span block of 256px tiles around a lat/lon, decodes to a real
metre grid, normalises for the analysis pipeline (which expects [0,1] +
height_scale_m). This is the accurate path for TERCOM — real terrain contours,
real coordinates."""

import io
import math
import urllib.request

import numpy as np
from PIL import Image

TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
# ESRI World Imagery — public basemap, no key. Tile order is z/row/col (y/x).
IMAGERY_URL = "https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
TILE_PX = 256


def _lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    lat_r = math.radians(lat)
    y = int((1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n)
    return x, y


def _meters_per_px(lat, z):
    return 156543.03392 * math.cos(math.radians(lat)) / (2 ** z)


def _get_tile(z, x, y):
    url = TILE_URL.format(z=z, x=x, y=y)
    req = urllib.request.Request(url, headers={"User-Agent": "BHUVAN-DEM/1.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = resp.read()
    img = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"), dtype=np.float64)
    return img[..., 0] * 256.0 + img[..., 1] + img[..., 2] / 256.0 - 32768.0


def fetch_imagery(lat: float, lon: float, zoom: int = 12, span: int = 2):
    """Stitched real satellite imagery (ESRI World Imagery) for the SAME tiles
    as fetch_dem, so the photo aligns with the elevation. Returns a PIL Image."""
    zoom = max(6, min(14, int(zoom)))
    span = max(1, min(3, int(span)))
    cx, cy = _lonlat_to_tile(lon, lat, zoom)
    half = span // 2
    n = 2 ** zoom
    tiles = []
    for ty in range(cy - half, cy - half + span):
        row = []
        for tx in range(cx - half, cx - half + span):
            url = IMAGERY_URL.format(z=zoom, y=max(0, min(n - 1, ty)), x=tx % n)
            req = urllib.request.Request(url, headers={"User-Agent": "BHUVAN-DEM/1.0"})
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = resp.read()
            row.append(Image.open(io.BytesIO(data)).convert("RGB"))
        tiles.append(row)
    w = sum(im.width for im in tiles[0])
    h = sum(r[0].height for r in tiles)
    canvas = Image.new("RGB", (w, h))
    y = 0
    for r in tiles:
        x = 0
        for im in r:
            canvas.paste(im, (x, y))
            x += im.width
        y += r[0].height
    return canvas


def fetch_dem(lat: float, lon: float, zoom: int = 12, span: int = 2):
    """Return (normalised_grid[0,1], metadata) for a real area around lat/lon."""
    zoom = max(6, min(14, int(zoom)))
    span = max(1, min(3, int(span)))
    cx, cy = _lonlat_to_tile(lon, lat, zoom)
    half = span // 2

    rows = []
    n = 2 ** zoom
    for ty in range(cy - half, cy - half + span):
        cols = []
        for tx in range(cx - half, cx - half + span):
            cols.append(_get_tile(zoom, tx % n, max(0, min(n - 1, ty))))
        rows.append(np.hstack(cols))
    grid = np.vstack(rows).astype(np.float32)

    mpp = _meters_per_px(lat, zoom)
    world_scale_m = mpp * grid.shape[0]
    h_min = float(grid.min())
    h_max = float(grid.max())
    h_range = max(1.0, h_max - h_min)

    norm = (grid - h_min) / h_range  # → [0,1]; pipeline scales by height_scale_m

    metadata = {
        "terrain_name": f"Real DEM {lat:.3f}, {lon:.3f}",
        "source": "srtm-terrarium",
        "grid_size": int(norm.shape[0]),
        "world_scale_m": float(world_scale_m),
        "height_scale_m": float(h_range),
        "resolution_m_per_px": float(mpp),
        "crs": "EPSG:3857 (web-mercator) · terrarium",
        "lat": float(lat),
        "lon": float(lon),
        "zoom": zoom,
        "height_min_m": h_min,
        "height_max_m": h_max,
        "disclaimer": (
            "Real elevation from AWS Terrain Tiles (SRTM/Copernicus, terrarium-encoded). "
            "Accurate contours and coordinates."
        ),
    }
    return norm, metadata
