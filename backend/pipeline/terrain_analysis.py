from __future__ import annotations

import cv2
import numpy as np


HAZARD_WEIGHTS = {
    "slope": 0.45,
    "roughness": 0.25,
    "curvature": 0.20,
    "shadow": 0.10,
}

SLOPE_SAFE_DEG = 5.0
SLOPE_DANGER_DEG = 15.0


def _normalize(grid: np.ndarray) -> np.ndarray:
    grid = grid.astype(np.float32)
    lo, hi = float(grid.min()), float(grid.max())
    if hi - lo < 1e-8:
        return np.zeros_like(grid)
    return (grid - lo) / (hi - lo)


def _slope_degrees(elevation_m: np.ndarray, cell_size_m: float) -> np.ndarray:
    grad_y, grad_x = np.gradient(elevation_m.astype(np.float32), cell_size_m)
    slope_rad = np.arctan(np.sqrt(grad_x**2 + grad_y**2))
    return np.degrees(slope_rad)


def _roughness_std(elevation_m: np.ndarray, kernel: int = 5) -> np.ndarray:
    mean = cv2.blur(elevation_m, (kernel, kernel))
    mean_sq = cv2.blur(elevation_m**2, (kernel, kernel))
    variance = np.maximum(mean_sq - mean**2, 0.0)
    return np.sqrt(variance)


def _curvature_laplacian(elevation_m: np.ndarray, cell_size_m: float) -> np.ndarray:
    lap = cv2.Laplacian(elevation_m.astype(np.float32), cv2.CV_32F, ksize=3)
    return np.abs(lap) / (cell_size_m**2)


def _shadow_proxy(elevation_m: np.ndarray, sun_azimuth_deg: float = 40.0) -> np.ndarray:
    grad_y, grad_x = np.gradient(elevation_m.astype(np.float32))
    sun_x = np.cos(np.deg2rad(sun_azimuth_deg))
    sun_y = np.sin(np.deg2rad(sun_azimuth_deg))
    illumination = grad_x * sun_x + grad_y * sun_y
    return np.where(illumination < 0, np.abs(illumination), 0.0)


def analyze_terrain(
    elevation: np.ndarray,
    cell_size_m: float = 1.25,
    sun_azimuth_deg: float = 40.0,
) -> dict:
    elevation_m = elevation.astype(np.float32)

    slope_deg = _slope_degrees(elevation_m, cell_size_m)
    roughness_m = _roughness_std(elevation_m)
    curvature_inv_m = _curvature_laplacian(elevation_m, cell_size_m)
    shadow_proxy = _shadow_proxy(elevation_m, sun_azimuth_deg)

    slope_n = _normalize(slope_deg)
    roughness_n = _normalize(roughness_m)
    curvature_n = _normalize(curvature_inv_m)
    shadow_n = _normalize(shadow_proxy)

    w = HAZARD_WEIGHTS
    hazard = np.clip(
        slope_n * w["slope"]
        + roughness_n * w["roughness"]
        + curvature_n * w["curvature"]
        + shadow_n * w["shadow"],
        0.0,
        1.0,
    ).astype(np.float32)
    traversability = 1.0 - hazard

    return {
        "slope": {"data": slope_n, "physical": slope_deg, "unit": "degrees"},
        "roughness": {"data": roughness_n, "physical": roughness_m, "unit": "metres"},
        "curvature": {"data": curvature_n, "physical": curvature_inv_m, "unit": "1/metres"},
        "shadow": {"data": shadow_n, "physical": shadow_proxy, "unit": "proxy_0_1"},
        "hazard": {"data": hazard, "physical": hazard, "unit": "composite_0_1"},
        "traversability": {
            "data": traversability,
            "physical": traversability,
            "unit": "composite_0_1",
        },
        "_meta": {
            "cell_size_m": cell_size_m,
            "sun_azimuth_deg": sun_azimuth_deg,
            "weights": w,
            "slope_safe_threshold_deg": SLOPE_SAFE_DEG,
            "shadow_note": "gradient-proxy, not ray-cast",
        },
    }
