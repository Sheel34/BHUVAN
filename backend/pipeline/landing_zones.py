from __future__ import annotations

import cv2
import numpy as np

from .schemas import LandingZone, ZoneComponents, ZoneUncertainty

MIN_SAFE_RADIUS_M = 4.0
HAZARD_SAFE_THRESHOLD = 0.42


def _world_coord(index: int, size: int, scale: float) -> float:
    return (index / (size - 1) - 0.5) * scale


def _footprint_sensitivity(hazard_data, traversability_data, component_masks,
                           n_bootstrap=100, noise_std=0.02, confidence=1.0):
    """Per-footprint perturbation sensitivity, not sensor uncertainty.

    No resampling is claimed: assumed independent Gaussian index noise is
    applied to the same footprint and the actual worst-cell score formula.
    """
    rng = np.random.default_rng(0)
    values = hazard_data[next(iter(component_masks.values()))]
    hazards, traversabilities, scores = [], [], []
    for _ in range(n_bootstrap):
        noisy = np.clip(values + rng.normal(0, noise_std, values.shape), 0, 1)
        hazards.append(float(noisy.mean()))
        traversabilities.append(float((1-noisy).mean()))
        scores.append(float((1-noisy.max())*100*confidence))
    result = {"bootstrap_samples": n_bootstrap}
    for name, samples in (("score", scores), ("hazard", hazards), ("traversability", traversabilities)):
        lower, upper = np.percentile(samples, [2.5, 97.5])
        result[name+"_ci_lower"], result[name+"_ci_upper"] = float(lower), float(upper)
    return result


def rank_landing_zones(
    elevation: np.ndarray,
    layers: dict,
    scale_m: float = 200.0,
    min_radius_m: float = MIN_SAFE_RADIUS_M,
    max_zones: int = 8,
    compute_uncertainty: bool = True,
) -> list[LandingZone]:
    size = elevation.shape[0]
    cell_m = scale_m / (size - 1)
    min_radius_px = min_radius_m / cell_m

    hazard_data = layers["hazard"]["data"]
    traversability_data = layers["traversability"]["data"]
    safe_mask = (hazard_data < HAZARD_SAFE_THRESHOLD).astype(np.uint8)

    kernel_px = max(1, int(np.ceil(min_radius_px)))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_px * 2 + 1,) * 2)
    eroded_mask = cv2.erode(safe_mask, kernel, iterations=1, borderType=cv2.BORDER_CONSTANT, borderValue=0)

    # Worst-case footprint scoring: grayscale erosion (min filter) makes a
    # candidate only as good as the most dangerous cell the vehicle would
    # actually touch, instead of trusting the single centre pixel.
    worst_traversability = cv2.erode(
        traversability_data.astype(np.float32), kernel, iterations=1
    )

    dist = cv2.distanceTransform(np.pad(safe_mask, 1), cv2.DIST_L2, 5)[1:-1, 1:-1]

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

        traversability = float(worst_traversability[ix, iz])
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
                uncertainty=None,
            )
        )

    if compute_uncertainty:
        for zone in zones:
            ix = round((zone.x / scale_m + .5) * (size-1))
            iz = round((zone.z / scale_m + .5) * (size-1))
            # Exactly the footprint used by the ranking erosion, including
            # clipped boundary support. Regions are not pooled together.
            footprint = np.zeros_like(hazard_data, dtype=bool)
            for ki, kj in np.argwhere(kernel):
                ri, cj = ix+ki-kernel_px, iz+kj-kernel_px
                if 0 <= ri < size and 0 <= cj < size:
                    footprint[ri, cj] = True
            sensitivity = _footprint_sensitivity(hazard_data, traversability_data,
                {zone.id: footprint}, confidence=zone.confidence)
            zone.uncertainty = ZoneUncertainty(**sensitivity)

    zones.sort(key=lambda z: z.score, reverse=True)
    return zones[:max_zones]
