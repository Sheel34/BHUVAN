"""Landing zone ranking for the BHUVAN terrain pipeline.

The hazard map is inverted into a safety map (safety = 1 - hazard), then
eroded with scipy.ndimage.grey_erosion using a circular footprint sized
to the rover/lander radius in pixels. Erosion replaces each cell with the
*worst* safety value inside the footprint, so a candidate zone is only as
good as the most dangerous cell the vehicle would actually touch.

The top N zones are selected greedily: take the global maximum of the
eroded safety map, record its centroid, suppress a separation disk around
it, and repeat. Pixel centroids are mapped back to lat/lon through the
request bounding box (row 0 = northern edge).
"""

from __future__ import annotations

from typing import Optional

import numpy as np
from scipy.ndimage import grey_erosion


def disk_footprint(radius_px: int) -> np.ndarray:
    """Build a boolean circular footprint of the given pixel radius.

    Args:
        radius_px: Footprint radius in pixels (>= 1).

    Returns:
        Boolean array of shape (2r+1, 2r+1), True inside the disk.

    Raises:
        ValueError: If radius_px < 1.
    """
    if radius_px < 1:
        raise ValueError(f"radius_px must be >= 1, got {radius_px}")
    span = np.arange(-radius_px, radius_px + 1)
    yy, xx = np.meshgrid(span, span, indexing="ij")
    return (yy**2 + xx**2) <= radius_px**2


def pixel_to_latlon(
    row: int, col: int, grid_shape: tuple[int, int], bbox: tuple[float, float, float, float]
) -> tuple[float, float]:
    """Map a pixel centroid to (lat, lon) inside the bounding box.

    Args:
        row: Pixel row (0 = northern edge of the bbox).
        col: Pixel column (0 = western edge of the bbox).
        grid_shape: (rows, cols) of the analysis grid.
        bbox: (min_lat, min_lon, max_lat, max_lon) in decimal degrees.

    Returns:
        (lat, lon) of the pixel center in decimal degrees.
    """
    rows, cols = grid_shape
    min_lat, min_lon, max_lat, max_lon = bbox
    lat = max_lat - (row + 0.5) / rows * (max_lat - min_lat)
    lon = min_lon + (col + 0.5) / cols * (max_lon - min_lon)
    return lat, lon


def rank_landing_zones(
    hazard: np.ndarray,
    bbox: tuple[float, float, float, float],
    rover_radius_px: int = 3,
    top_n: int = 5,
    min_separation_px: Optional[int] = None,
) -> list[dict]:
    """Rank the safest landing zones on a hazard map.

    Args:
        hazard: 2D hazard array in [0, 1].
        bbox: (min_lat, min_lon, max_lat, max_lon) of the analyzed region.
        rover_radius_px: Vehicle footprint radius in pixels.
        top_n: Maximum number of zones to return.
        min_separation_px: Minimum pixel distance between zone centroids.
            Defaults to 2 * rover_radius_px + 1 (footprints cannot overlap).

    Returns:
        Up to top_n dicts sorted by descending safety, each with keys:
        rank, row, col, lat, lon, safety_score.

    Raises:
        ValueError: If the hazard map is not 2D or smaller than the footprint.
    """
    if hazard.ndim != 2:
        raise ValueError(f"hazard must be a 2D array, got shape {hazard.shape}")
    footprint = disk_footprint(rover_radius_px)
    if hazard.shape[0] <= footprint.shape[0] or hazard.shape[1] <= footprint.shape[1]:
        raise ValueError(
            f"hazard map {hazard.shape} too small for footprint {footprint.shape}"
        )
    if min_separation_px is None:
        min_separation_px = 2 * rover_radius_px + 1

    safety = 1.0 - np.clip(hazard.astype(np.float64, copy=False), 0.0, 1.0)
    eroded = grey_erosion(safety, footprint=footprint, mode="nearest")

    # Exclude cells whose footprint would extend past the analyzed region.
    work = eroded.copy()
    r = rover_radius_px
    work[:r, :] = -np.inf
    work[-r:, :] = -np.inf
    work[:, :r] = -np.inf
    work[:, -r:] = -np.inf

    rows_idx = np.arange(work.shape[0])[:, None]
    cols_idx = np.arange(work.shape[1])[None, :]

    zones: list[dict] = []
    for rank in range(1, top_n + 1):
        flat_idx = int(np.argmax(work))
        row, col = np.unravel_index(flat_idx, work.shape)
        score = work[row, col]
        if not np.isfinite(score):
            break  # everything reachable has been suppressed
        lat, lon = pixel_to_latlon(int(row), int(col), work.shape, bbox)
        zones.append(
            {
                "rank": rank,
                "row": int(row),
                "col": int(col),
                "lat": round(float(lat), 5),
                "lon": round(float(lon), 5),
                "safety_score": round(float(score), 4),
            }
        )
        suppress = (rows_idx - row) ** 2 + (cols_idx - col) ** 2 <= min_separation_px**2
        work[suppress] = -np.inf
    return zones


if __name__ == "__main__":
    # 100x100 hazard map: dangerous everywhere except two safe basins.
    hazard = np.full((100, 100), 0.9)
    yy, xx = np.meshgrid(np.arange(100), np.arange(100), indexing="ij")
    basin_a = (25, 25)
    basin_b = (70, 70)
    hazard[(yy - basin_a[0]) ** 2 + (xx - basin_a[1]) ** 2 <= 10**2] = 0.05
    hazard[(yy - basin_b[0]) ** 2 + (xx - basin_b[1]) ** 2 <= 10**2] = 0.05

    bbox = (10.0, 70.0, 11.0, 71.0)  # (min_lat, min_lon, max_lat, max_lon)
    zones = rank_landing_zones(
        hazard, bbox, rover_radius_px=3, top_n=5, min_separation_px=25
    )

    assert len(zones) == 5
    assert [z["rank"] for z in zones] == [1, 2, 3, 4, 5]
    scores = [z["safety_score"] for z in zones]
    assert scores == sorted(scores, reverse=True), scores
    assert all(0.0 <= s <= 1.0 for s in scores)

    # The two best zones land inside the two distinct basins.
    def dist(z: dict, center: tuple[int, int]) -> float:
        return float(np.hypot(z["row"] - center[0], z["col"] - center[1]))

    top_two_centers = sorted(
        (min(dist(z, basin_a), dist(z, basin_b)) for z in zones[:2])
    )
    assert all(d <= 8.0 for d in top_two_centers), zones[:2]
    hit_a = any(dist(z, basin_a) <= 8.0 for z in zones[:2])
    hit_b = any(dist(z, basin_b) <= 8.0 for z in zones[:2])
    assert hit_a and hit_b, zones[:2]
    assert zones[0]["safety_score"] >= 0.94  # 1 - 0.05 minus rounding

    # Geographic mapping: the more-northern basin (smaller row) has higher lat.
    za = next(z for z in zones[:2] if dist(z, basin_a) <= 8.0)
    zb = next(z for z in zones[:2] if dist(z, basin_b) <= 8.0)
    assert za["lat"] > zb["lat"]
    assert 10.0 <= za["lat"] <= 11.0 and 70.0 <= za["lon"] <= 71.0

    # Footprint construction sanity.
    fp = disk_footprint(3)
    assert fp.shape == (7, 7) and fp[3, 3] and not fp[0, 0]

    # Degenerate input is rejected.
    try:
        rank_landing_zones(np.zeros((5, 5)), bbox, rover_radius_px=3)
        raise AssertionError("expected ValueError for tiny map")
    except ValueError:
        pass

    print("analysis/landing_zones.py: all tests passed")
