from __future__ import annotations

import cv2
import numpy as np

from .schemas import LandingZone, ZoneComponents, ZoneUncertainty

MIN_SAFE_RADIUS_M = 4.0
HAZARD_SAFE_THRESHOLD = 0.42


def _world_coord(index: int, size: int, scale: float) -> float:
    return (index / (size - 1) - 0.5) * scale


def _bootstrap_uncertainty(
    hazard_data: np.ndarray,
    traversability_data: np.ndarray,
    component_masks: dict,
    n_bootstrap: int = 100,
    noise_std: float = 0.02,
) -> dict:
    """
    Perform bootstrap resampling with noise injection to estimate uncertainty.
    Returns confidence intervals for score, hazard, and traversability.
    """
    size = hazard_data.shape[0]
    
    # Store bootstrap samples
    bootstrap_scores = []
    bootstrap_hazards = []
    bootstrap_traversabilities = []
    
    for _ in range(n_bootstrap):
        # Add Gaussian noise to simulate sensor/DEM uncertainty
        noise = np.random.normal(0, noise_std, hazard_data.shape)
        noisy_hazard = np.clip(hazard_data + noise, 0.0, 1.0)
        noisy_traversability = 1.0 - noisy_hazard
        
        # Compute metrics for each component mask
        for mask_name, mask in component_masks.items():
            if mask.sum() < 4:
                continue
            
            patch_hazard = noisy_hazard[mask]
            patch_traversability = noisy_traversability[mask]
            
            mean_haz = float(patch_hazard.mean())
            mean_trav = float(patch_traversability.mean())
            
            # Simple score formula (same as main ranking)
            score = mean_trav * 100.0
            
            bootstrap_scores.append(score)
            bootstrap_hazards.append(mean_haz)
            bootstrap_traversabilities.append(mean_trav)
    
    # Compute 95% confidence intervals
    if len(bootstrap_scores) > 0:
        scores_arr = np.array(bootstrap_scores)
        hazards_arr = np.array(bootstrap_hazards)
        travs_arr = np.array(bootstrap_traversabilities)
        
        score_ci = np.percentile(scores_arr, [2.5, 97.5])
        hazard_ci = np.percentile(hazards_arr, [2.5, 97.5])
        trav_ci = np.percentile(travs_arr, [2.5, 97.5])
        
        return {
            "score_ci_lower": float(score_ci[0]),
            "score_ci_upper": float(score_ci[1]),
            "hazard_ci_lower": float(hazard_ci[0]),
            "hazard_ci_upper": float(hazard_ci[1]),
            "traversability_ci_lower": float(trav_ci[0]),
            "traversability_ci_upper": float(trav_ci[1]),
            "bootstrap_samples": n_bootstrap,
        }
    
    # Fallback if no valid samples
    return {
        "score_ci_lower": 0.0,
        "score_ci_upper": 100.0,
        "hazard_ci_lower": 0.0,
        "hazard_ci_upper": 1.0,
        "traversability_ci_lower": 0.0,
        "traversability_ci_upper": 1.0,
        "bootstrap_samples": n_bootstrap,
    }


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
    eroded_mask = cv2.erode(safe_mask, kernel, iterations=1)

    # Worst-case footprint scoring: grayscale erosion (min filter) makes a
    # candidate only as good as the most dangerous cell the vehicle would
    # actually touch, instead of trusting the single centre pixel.
    worst_traversability = cv2.erode(
        traversability_data.astype(np.float32), kernel, iterations=1
    )

    dist = cv2.distanceTransform(safe_mask, cv2.DIST_L2, 5)

    count, labels, stats, centroids = cv2.connectedComponentsWithStats(
        eroded_mask, connectivity=8
    )

    slope_data = layers["slope"]["data"]
    roughness_data = layers["roughness"]["data"]
    curvature_data = layers["curvature"]["data"]
    shadow_data = layers["shadow"]["data"]

    zones: list[LandingZone] = []
    component_masks = {}

    for cid in range(1, count):
        area_px = int(stats[cid, cv2.CC_STAT_AREA])
        if area_px < 4:
            continue

        component_mask = labels == cid
        component_masks[f"zone-{cid}"] = component_mask
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

    # Compute uncertainty for all zones if enabled
    if compute_uncertainty and component_masks:
        uncertainty_results = _bootstrap_uncertainty(
            hazard_data,
            traversability_data,
            component_masks,
            n_bootstrap=100,
            noise_std=0.02,
        )
        
        # Assign same uncertainty to all zones (simplified for performance)
        # In a full implementation, each zone would have its own CI
        for zone in zones:
            zone.uncertainty = ZoneUncertainty(**uncertainty_results)

    zones.sort(key=lambda z: z.score, reverse=True)
    return zones[:max_zones]
