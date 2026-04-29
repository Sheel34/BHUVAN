from __future__ import annotations

import cv2
import numpy as np

from .schemas import LandingZone, ZoneComponents

MIN_SAFE_RADIUS_M = 4.0
HAZARD_SAFE_THRESHOLD = 0.42


def _world_coord(index: int, size: int, scale: float) -> float:
    return (index / (size - 1) - 0.5) * scale


def rank_landing_zones(
    elevation: np.ndarray,
    layers: dict,
    scale_m: float = 200.0,
    min_radius_m: float = MIN_SAFE_RADIUS_M,
    max_zones: int = 8,
) -> list[LandingZone]:
    size = elevation.shape[0]
    cell_m = scale_m / (size - 1)
    min_radius_px = min_radius_m / cell_m

    hazard_data = layers["hazard"]["data"]
    safe_mask = (hazard_data < HAZARD_SAFE_THRESHOLD).astype(np.uint8)

    kernel_px = max(1, int(np.ceil(min_radius_px)))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_px * 2 + 1,) * 2)
    eroded_mask = cv2.erode(safe_mask, kernel, iterations=1)

    dist = cv2.distanceTransform(safe_mask, cv2.DIST_L2, 5)

    count, labels, stats, centroids = cv2.connectedComponentsWithStats(
        eroded_mask, connectivity=8
    )

    slope_data = layers["slope"]["data"]
    roughness_data = layers["roughness"]["data"]
    curvature_data = layers["curvature"]["data"]
    shadow_data = layers["shadow"]["data"]

    zones: list[LandingZone] = []

    for cid in range(1, count):
        area_px = int(stats[cid, cv2.CC_STAT_AREA])
        if area_px < 4:
            continue

        component_mask = labels == cid
        dist_in_patch = dist * component_mask.astype(float)
        best_px = np.unravel_index(np.argmax(dist_in_patch), dist_in_patch.shape)
        ix, iz = int(best_px[0]), int(best_px[1])

        radius_px = float(dist[ix, iz])
        radius_m = radius_px * cell_m
        if radius_m < min_radius_m:
            continue

        patch_hazard = hazard_data[component_mask]
        mean_haz = float(patch_hazard.mean())
        min_haz = float(patch_hazard.min())

        eroded_area = int((eroded_mask * component_mask).sum())
        confidence = float(np.clip(eroded_area / max(area_px, 1), 0.0, 1.0))

        traversability = float(layers["traversability"]["data"][ix, iz])
        hazard_at_centre = float(hazard_data[ix, iz])

        wx = _world_coord(ix, size, scale_m)
        wz = _world_coord(iz, size, scale_m)
        wy = float(elevation[ix, iz])

        score = round(traversability * 100.0 * confidence, 1)
        if hazard_at_centre < 0.25:
            classification = "safe"
        elif hazard_at_centre < HAZARD_SAFE_THRESHOLD:
            classification = "caution"
        else:
            classification = "unsafe"

        zones.append(
            LandingZone(
                id=f"zone-{cid}",
                x=wx,
                z=wz,
                y=wy,
                radius_m=round(radius_m, 2),
                score=score,
                classification=classification,
                patch_area_px=area_px,
                min_hazard_in_patch=round(min_haz, 4),
                mean_hazard_in_patch=round(mean_haz, 4),
                confidence=round(confidence, 3),
                components=ZoneComponents(
                    slope_pct=round(float(slope_data[ix, iz]) * 100.0, 1),
                    roughness_pct=round(float(roughness_data[ix, iz]) * 100.0, 1),
                    curvature_pct=round(float(curvature_data[ix, iz]) * 100.0, 1),
                    shadow_pct=round(float(shadow_data[ix, iz]) * 100.0, 1),
                ),
            )
        )

    zones.sort(key=lambda z: z.score, reverse=True)
    return zones[:max_zones]
