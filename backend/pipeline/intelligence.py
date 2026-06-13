"""Terrain intelligence layer — turns raw analysis rasters into findings.

Produces the post-generation insight the workspace shows alongside the
3D terrain: elevation statistics, surface classification, contiguous
region segmentation, and ranked scientific-interest regions. Heuristic
by design — the goal is interactive exploration, not survey-grade
science (each output carries enough provenance to say how it was
derived).
"""

from __future__ import annotations

import numpy as np
from scipy import ndimage

# Surface classes by slope/curvature/roughness heuristics
CLASS_DEFS = [
    ("plains", "Smooth plains", "Low slope, low roughness — prime traverse corridors"),
    ("slopes", "Moderate slopes", "Walkable gradients; watch local hazards"),
    ("steep", "Steep terrain", "Slopes beyond safe traverse limits"),
    ("ridges", "Ridges and rims", "Convex crests — high visibility, exposed"),
    ("depressions", "Craters and basins", "Concave floors — potential science targets, comms shadow"),
    ("rough", "Broken ground", "High roughness — boulder fields, ejecta"),
]


def _classify_cells(layers: dict) -> np.ndarray:
    """Per-cell class index into CLASS_DEFS."""
    slope = layers["slope"]["data"]
    rough = layers["roughness"]["data"]
    curv = layers["curvature"]["data"]

    classes = np.zeros(slope.shape, dtype=np.int8)  # default: plains
    classes[slope > 0.25] = 1                        # slopes
    classes[slope > 0.55] = 2                        # steep
    classes[(curv > 0.6) & (slope > 0.15)] = 3       # ridges
    classes[(curv < 0.4) & (slope > 0.15) & (classes != 2)] = 4  # depressions
    classes[rough > 0.55] = 5                        # rough overrides
    return classes


def elevation_statistics(elevation_m: np.ndarray, bins: int = 32) -> dict:
    """Distribution summary + histogram for the elevation grid."""
    flat = elevation_m.reshape(-1)
    hist, edges = np.histogram(flat, bins=bins)
    p = np.percentile(flat, [5, 25, 50, 75, 95])
    return {
        "min_m": float(flat.min()),
        "max_m": float(flat.max()),
        "mean_m": float(flat.mean()),
        "std_m": float(flat.std()),
        "p5_m": float(p[0]),
        "p25_m": float(p[1]),
        "median_m": float(p[2]),
        "p75_m": float(p[3]),
        "p95_m": float(p[4]),
        "relief_m": float(flat.max() - flat.min()),
        "histogram": hist.astype(int).tolist(),
        "histogram_edges_m": [float(e) for e in edges],
    }


def classify_surface(layers: dict) -> dict:
    """Coverage share per surface class."""
    classes = _classify_cells(layers)
    total = classes.size
    coverage = []
    for idx, (key, label, description) in enumerate(CLASS_DEFS):
        count = int((classes == idx).sum())
        coverage.append({
            "key": key,
            "label": label,
            "description": description,
            "coverage_pct": round(count / total * 100.0, 1),
        })
    dominant = max(coverage, key=lambda c: c["coverage_pct"])
    return {"classes": coverage, "dominant": dominant["key"]}


def segment_regions(
    layers: dict,
    scale_m: float,
    min_region_pct: float = 0.5,
    max_regions: int = 12,
) -> list[dict]:
    """Contiguous same-class regions (connected-component labeling)."""
    classes = _classify_cells(layers)
    size = classes.shape[0]
    cell_area_m2 = (scale_m / (size - 1)) ** 2
    regions = []

    for idx, (key, label, _desc) in enumerate(CLASS_DEFS):
        mask = classes == idx
        if not mask.any():
            continue
        labeled, count = ndimage.label(mask)
        if count == 0:
            continue
        sizes = ndimage.sum_labels(mask, labeled, index=range(1, count + 1))
        for region_id in np.argsort(sizes)[::-1][:4]:
            region_cells = float(sizes[region_id])
            pct = region_cells / classes.size * 100.0
            if pct < min_region_pct:
                break
            cy, cx = ndimage.center_of_mass(labeled == region_id + 1)
            regions.append({
                "class_key": key,
                "class_label": label,
                "coverage_pct": round(pct, 1),
                "area_km2": round(region_cells * cell_area_m2 / 1e6, 3),
                # Centroid in world coordinates (terrain centered at origin)
                "x": round((cx / (size - 1) - 0.5) * scale_m, 1),
                "z": round((cy / (size - 1) - 0.5) * scale_m, 1),
            })

    regions.sort(key=lambda r: r["coverage_pct"], reverse=True)
    return regions[:max_regions]


def find_interest_regions(
    elevation_m: np.ndarray,
    layers: dict,
    scale_m: float,
    top_n: int = 5,
) -> list[dict]:
    """Ranked scientific-interest candidates.

    Interest score favours geological variety: strong curvature
    (rims/floors), elevation extremes, and texture transitions —
    smoothed so single noisy cells don't win.
    """
    size = elevation_m.shape[0]
    curv = layers["curvature"]["data"]
    rough = layers["roughness"]["data"]
    slope = layers["slope"]["data"]

    elev_norm = (elevation_m - elevation_m.min()) / max(float(np.ptp(elevation_m)), 1e-6)
    extremity = np.abs(elev_norm - 0.5) * 2.0
    curv_interest = np.abs(curv - 0.5) * 2.0
    texture_edge = np.abs(ndimage.gaussian_gradient_magnitude(rough, sigma=3))
    texture_edge = texture_edge / max(texture_edge.max(), 1e-6)

    score = 0.45 * curv_interest + 0.3 * extremity + 0.25 * texture_edge
    score = ndimage.gaussian_filter(score, sigma=size / 64)

    # Greedy non-overlapping peak picking
    picked = []
    working = score.copy()
    exclusion = max(8, size // 12)
    for _ in range(top_n):
        flat_idx = int(np.argmax(working))
        i, j = divmod(flat_idx, size)
        peak = float(working[i, j])
        if peak <= 0:
            break

        local_curv = float(curv[i, j])
        local_slope = float(slope[i, j])
        local_elev = float(elevation_m[i, j])
        if local_curv > 0.62:
            kind = "ridge crest / crater rim"
        elif local_curv < 0.38:
            kind = "crater floor / basin"
        elif local_slope > 0.4:
            kind = "scarp face"
        else:
            kind = "texture transition zone"

        picked.append({
            "id": f"poi-{len(picked) + 1}",
            "kind": kind,
            "score": round(peak, 3),
            "x": round((j / (size - 1) - 0.5) * scale_m, 1),
            "z": round((i / (size - 1) - 0.5) * scale_m, 1),
            "elevation_m": round(local_elev, 1),
            "evidence": {
                "curvature": round(local_curv, 2),
                "slope": round(local_slope, 2),
                "roughness": round(float(rough[i, j]), 2),
            },
        })

        i0, i1 = max(0, i - exclusion), min(size, i + exclusion)
        j0, j1 = max(0, j - exclusion), min(size, j + exclusion)
        working[i0:i1, j0:j1] = 0.0

    return picked


def build_intelligence(
    elevation_m: np.ndarray,
    layers: dict,
    scale_m: float,
) -> dict:
    """Full intelligence bundle for the analysis payload."""
    return {
        "elevation": elevation_statistics(elevation_m),
        "classification": classify_surface(layers),
        "regions": segment_regions(layers, scale_m),
        "interest_regions": find_interest_regions(elevation_m, layers, scale_m),
    }
