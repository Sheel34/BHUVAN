# backend/pipeline/terrain_analysis.py
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
ROUGHNESS_DANGER_M = 0.5
CURVATURE_DANGER_INV_M = 0.1
DEPRESSION_DANGER_M = 0.5
ANALYSIS_REVISION = 'resolved-depressions-2'


def _depression_depth(elevation_m: np.ndarray, cell_size_m: float) -> np.ndarray:
    # Closing fills local lows without interpreting a constant grade as a pit.
    # The window is bounded; this is a screening heuristic, not rock detection.
    radius = min(max(1, int(np.ceil(3.0 / cell_size_m))), 31, (min(elevation_m.shape) - 1) // 4)
    if radius < 1:
        return np.zeros_like(elevation_m, dtype=np.float32)
    kernel = np.ones((2 * radius + 1, 2 * radius + 1), dtype=np.uint8)
    closed = cv2.morphologyEx(elevation_m.astype(np.float32), cv2.MORPH_CLOSE, kernel)
    depth = np.maximum(closed - elevation_m, 0).astype(np.float32)
    # Both morphology passes need neighbours. Do not create pits at patch edges.
    margin = 2 * radius
    depth[:margin, :] = depth[-margin:, :] = 0
    depth[:, :margin] = depth[:, -margin:] = 0
    return depth

def _slope_degrees(elevation_m: np.ndarray, cell_size_m: float) -> np.ndarray:
    grad_y, grad_x = np.gradient(elevation_m.astype(np.float32), cell_size_m)
    slope_rad = np.arctan(np.sqrt(grad_x**2 + grad_y**2))
    return np.degrees(slope_rad)

def _roughness_std(elevation_m: np.ndarray, cell_size_m: float, physical_kernel_m: float = 6.0) -> np.ndarray:
    # Subtract an offset before squaring: large absolute elevations otherwise
    # cause catastrophic cancellation in float32 local variance.
    elevation_m = elevation_m.astype(np.float64) - float(elevation_m.min())
    kernel = min(max(3, int(physical_kernel_m / cell_size_m)), min(elevation_m.shape))
    if kernel % 2 == 0:
        kernel += 1
    mean = cv2.blur(elevation_m, (kernel, kernel))
    mean_sq = cv2.blur(elevation_m**2, (kernel, kernel))
    variance = np.maximum(mean_sq - mean**2, 0.0)
    return np.sqrt(variance)

def _curvature_laplacian(elevation_m: np.ndarray, cell_size_m: float) -> np.ndarray:
    # The ksize=3 OpenCV kernel has a different scale. Use the standard
    # five-point Laplacian; this is absolute bending, not signed curvature.
    lap = cv2.Laplacian(elevation_m.astype(np.float32), cv2.CV_32F, ksize=1)
    return np.abs(lap) / (cell_size_m**2)

def _shadow_proxy(
    elevation_m: np.ndarray,
    sun_azimuth_deg: float = 40.0,
    sun_elevation_deg: float = 45.0,
    cell_size_m: float = 1.25,
) -> np.ndarray:
    sun_az_rad = np.deg2rad(sun_azimuth_deg)
    sun_el_rad = np.deg2rad(sun_elevation_deg)
    sun_dx = np.cos(sun_el_rad) * np.cos(sun_az_rad)
    sun_dz = np.cos(sun_el_rad) * np.sin(sun_az_rad)
    sun_dy = np.sin(sun_el_rad)
    sun_vec = np.array([sun_dx, sun_dy, sun_dz], dtype=np.float32)
    
    grad_y, grad_x = np.gradient(elevation_m.astype(np.float32), cell_size_m)
    nx = -grad_x
    nz = -grad_y
    ny = np.ones_like(nx)
    
    norm = np.sqrt(nx**2 + ny**2 + nz**2)
    nx /= norm
    ny /= norm
    nz /= norm
    
    dot_prod = nx * sun_vec[0] + ny * sun_vec[1] + nz * sun_vec[2]
    shadow_map = (dot_prod < 0).astype(np.float32)
    return shadow_map

def analyze_terrain(
    elevation: np.ndarray,
    cell_size_m: float = 1.25,
    sun_azimuth_deg: float = 40.0,
    sun_elevation_deg: float = 45.0,
) -> dict:
    """
    Computes heuristic layers from elevations and spacing in matching units.

    Returns a dict keyed by layer name. Each value holds the normalised
    0-1 float32 grid under "data", plus the physical range it maps to.
    """
    if elevation.ndim != 2 or min(elevation.shape) < 2 or not np.isfinite(elevation).all():
        raise ValueError("Elevation grid must be finite and at least 2 x 2.")
    if not np.isfinite(cell_size_m) or cell_size_m <= 0:
        raise ValueError("Cell spacing must be positive and finite.")
    elevation_m = (elevation.astype(np.float64) - float(elevation.min())).astype(np.float32)

    # 1. Mathematical Analysis
    slope_deg = _slope_degrees(elevation_m, cell_size_m)
    roughness_m = _roughness_std(elevation_m, cell_size_m)
    curvature_inv_m = _curvature_laplacian(elevation_m, cell_size_m)
    shadow_map = _shadow_proxy(elevation_m, sun_azimuth_deg, sun_elevation_deg, cell_size_m)

    # 2. Normalization (0.0 to 1.0)
    slope_n = np.clip(slope_deg / SLOPE_DANGER_DEG, 0.0, 1.0).astype(np.float32)
    roughness_n = np.clip(roughness_m / ROUGHNESS_DANGER_M, 0.0, 1.0).astype(np.float32)
    curvature_n = np.clip(curvature_inv_m / CURVATURE_DANGER_INV_M, 0.0, 1.0).astype(np.float32)
    shadow_n = shadow_map.astype(np.float32)

    # 3. Composite Scoring
    w = HAZARD_WEIGHTS
    hazard = np.clip(
        slope_n * w["slope"]
        + roughness_n * w["roughness"]
        + curvature_n * w["curvature"]
        + shadow_n * w["shadow"],
        0.0,
        1.0,
    ).astype(np.float32)
    depression_risk = np.clip(_depression_depth(elevation_m, cell_size_m) / DEPRESSION_DANGER_M, 0, 1)
    hazard = np.maximum(hazard, depression_risk).astype(np.float32)
    traversability = (1.0 - hazard).astype(np.float32)

    return {
        "slope": {"data": slope_n, "min_val": 0.0, "max_val": SLOPE_DANGER_DEG},
        "roughness": {"data": roughness_n, "min_val": 0.0, "max_val": ROUGHNESS_DANGER_M},
        "curvature": {"data": curvature_n, "min_val": 0.0, "max_val": CURVATURE_DANGER_INV_M},
        "shadow": {"data": shadow_n, "min_val": 0.0, "max_val": 1.0},
        "hazard": {"data": hazard, "min_val": 0.0, "max_val": 1.0},
        "traversability": {"data": traversability, "min_val": 0.0, "max_val": 1.0},
    }
