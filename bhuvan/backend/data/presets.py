"""Preset mission terrains for BHUVAN.

Four preloaded regions the user can pick without selecting coordinates:
Jezero Crater (Mars), the Chandrayaan-2 Vikram landing zone (Moon),
Shackleton Crater (Moon), and the Deccan Plateau (Earth).

Phase 1 ships deterministic synthetic DEMs that reproduce each site's
characteristic morphology (crater bowl + rim, cratered highland, polar
crater, basalt plateau) from a fixed per-preset seed, so the entire
pipeline, API, and frontend run end-to-end today. Phase 2 swaps the
generators for real rasters (HiRISE ESP_046060_1985, Chandrayaan-2 TMC,
LOLA, NASA Earthdata DEM) behind the same two functions:
`load_preset_dem` and `synthesize_dem`.
"""

from __future__ import annotations

import hashlib

import numpy as np
from scipy.ndimage import gaussian_filter

DEFAULT_SHAPE: tuple[int, int] = (200, 200)

PRESETS: dict[str, dict] = {
    "jezero_crater": {
        "id": "jezero_crater",
        "name": "Jezero Crater",
        "body": "mars",
        "bbox": {"min_lat": 18.2, "min_lon": 77.3, "max_lat": 18.7, "max_lon": 77.8},
        "cell_size_m": 50.0,
        "dataset": "HiRISE ESP_046060_1985",
        "description": "Perseverance landing site: ancient lake delta inside a 45 km impact crater.",
        "terrain": "crater",
        "seed": 4601,
        "params": {"depth": 480.0, "rim_height": 160.0, "noise_amp": 35.0},
    },
    "vikram_site": {
        "id": "vikram_site",
        "name": "Vikram Landing Zone",
        "body": "moon",
        "bbox": {"min_lat": -71.0, "min_lon": 22.6, "max_lat": -70.6, "max_lon": 23.1},
        "cell_size_m": 30.0,
        "dataset": "Chandrayaan-2 TMC",
        "description": "Chandrayaan-2 target between Manzinus C and Simpelius N, southern lunar highlands.",
        "terrain": "highland",
        "seed": 2019,
        "params": {"noise_amp": 220.0, "crater_count": 5},
    },
    "shackleton_crater": {
        "id": "shackleton_crater",
        "name": "Shackleton Crater",
        "body": "moon",
        "bbox": {"min_lat": -89.95, "min_lon": -2.5, "max_lat": -89.55, "max_lon": 2.5},
        "cell_size_m": 60.0,
        "dataset": "LRO LOLA polar DEM",
        "description": "Artemis-program target at the lunar south pole; 4.2 km deep permanently shadowed crater.",
        "terrain": "crater",
        "seed": 1972,
        "params": {"depth": 4200.0, "rim_height": 600.0, "noise_amp": 120.0},
    },
    "deccan_plateau": {
        "id": "deccan_plateau",
        "name": "Deccan Plateau",
        "body": "earth",
        "bbox": {"min_lat": 17.0, "min_lon": 74.8, "max_lat": 17.4, "max_lon": 75.2},
        "cell_size_m": 30.0,
        "dataset": "NASA Earthdata SRTM (drone validation set)",
        "description": "Basalt plateau in western India used for terrestrial drone validation runs.",
        "terrain": "plateau",
        "seed": 1991,
        "params": {"mesa_height": 90.0, "noise_amp": 12.0},
    },
}


def _fractal_noise(
    shape: tuple[int, int], rng: np.random.Generator, octaves: int = 4
) -> np.ndarray:
    """Generate zero-centered fractal noise in [-0.5, 0.5] via stacked
    gaussian-smoothed white noise octaves."""
    base_sigma = max(shape) / 8.0
    out = np.zeros(shape, dtype=np.float64)
    for i in range(octaves):
        layer = gaussian_filter(rng.standard_normal(shape), sigma=base_sigma / (2**i))
        out += layer * (0.5**i)
    lo, hi = out.min(), out.max()
    if hi - lo == 0.0:
        return np.zeros(shape)
    return (out - lo) / (hi - lo) - 0.5


def _radial_distance(shape: tuple[int, int], center: tuple[float, float]) -> np.ndarray:
    """Per-cell Euclidean distance in pixels from a center point."""
    yy, xx = np.meshgrid(
        np.arange(shape[0], dtype=np.float64),
        np.arange(shape[1], dtype=np.float64),
        indexing="ij",
    )
    return np.hypot(yy - center[0], xx - center[1])


def _crater_profile(
    shape: tuple[int, int],
    center: tuple[float, float],
    radius_px: float,
    depth: float,
    rim_height: float,
) -> np.ndarray:
    """Elevation contribution of one impact crater: parabolic bowl inside
    the radius, a gaussian rim at the radius, flat outside."""
    r = _radial_distance(shape, center)
    bowl = np.where(r < radius_px, depth * ((r / radius_px) ** 2 - 1.0), 0.0)
    rim = rim_height * np.exp(-(((r - radius_px) / (0.12 * radius_px)) ** 2))
    return bowl + rim


def _crater_dem(shape: tuple[int, int], seed: int, params: dict) -> np.ndarray:
    """Single dominant crater with fractal noise floor (Jezero, Shackleton)."""
    rng = np.random.default_rng(seed)
    center = (shape[0] / 2.0, shape[1] / 2.0)
    radius_px = 0.32 * min(shape)
    dem = _crater_profile(shape, center, radius_px, params["depth"], params["rim_height"])
    dem += _fractal_noise(shape, rng) * params["noise_amp"] * 2.0
    dem += rng.normal(0.0, params["noise_amp"] * 0.05, size=shape)
    return dem


def _highland_dem(shape: tuple[int, int], seed: int, params: dict) -> np.ndarray:
    """Rolling cratered highland (Vikram landing zone)."""
    rng = np.random.default_rng(seed)
    dem = _fractal_noise(shape, rng) * params["noise_amp"] * 2.0
    for _ in range(params["crater_count"]):
        center = (rng.uniform(0.15, 0.85) * shape[0], rng.uniform(0.15, 0.85) * shape[1])
        radius_px = rng.uniform(0.04, 0.10) * min(shape)
        depth = rng.uniform(0.2, 0.5) * params["noise_amp"]
        dem += _crater_profile(shape, center, radius_px, depth, 0.35 * depth)
    dem += rng.normal(0.0, params["noise_amp"] * 0.03, size=shape)
    return dem


def _plateau_dem(shape: tuple[int, int], seed: int, params: dict) -> np.ndarray:
    """Stepped basalt mesas with gentle tops (Deccan Plateau)."""
    rng = np.random.default_rng(seed)
    base = _fractal_noise(shape, rng)
    mesa = np.where(base > 0.0, params["mesa_height"], 0.0)
    mesa = gaussian_filter(mesa, sigma=2.5)  # soften the scarp edges
    mesa += _fractal_noise(shape, rng) * params["noise_amp"] * 2.0
    mesa += rng.normal(0.0, params["noise_amp"] * 0.05, size=shape)
    return mesa


_GENERATORS = {
    "crater": _crater_dem,
    "highland": _highland_dem,
    "plateau": _plateau_dem,
}


def list_presets() -> list[dict]:
    """Return public metadata for every preset (shape of PresetInfo)."""
    keys = ("id", "name", "body", "bbox", "cell_size_m", "dataset", "description")
    return [{k: p[k] for k in keys} for p in PRESETS.values()]


def get_preset(preset_id: str) -> dict:
    """Fetch one preset's full definition.

    Raises:
        ValueError: If the preset id is unknown.
    """
    try:
        return PRESETS[preset_id]
    except KeyError:
        known = ", ".join(sorted(PRESETS))
        raise ValueError(f"unknown preset '{preset_id}' (known: {known})") from None


def load_preset_dem(
    preset_id: str, shape: tuple[int, int] = DEFAULT_SHAPE
) -> np.ndarray:
    """Build the deterministic DEM for a preset mission terrain.

    Args:
        preset_id: One of the keys in PRESETS.
        shape: Output grid shape (rows, cols).

    Returns:
        2D float64 elevation array in meters.
    """
    preset = get_preset(preset_id)
    generator = _GENERATORS[preset["terrain"]]
    return generator(shape, preset["seed"], preset["params"])


def synthesize_dem(
    bbox: tuple[float, float, float, float],
    body: str = "earth",
    shape: tuple[int, int] = DEFAULT_SHAPE,
) -> np.ndarray:
    """Deterministic DEM for an arbitrary bounding box (Phase 1 stand-in
    for the NASA Earthdata fetch; Phase 2 replaces this body with a real
    Earthdata + rasterio client behind the same signature).

    The seed derives from the rounded bbox and body, so repeated queries
    for the same region return identical terrain — which also makes the
    cache-aside layer trivially correct.

    Args:
        bbox: (min_lat, min_lon, max_lat, max_lon) in decimal degrees.
        body: 'earth', 'moon', or 'mars' — sets the relief amplitude.
        shape: Output grid shape (rows, cols).

    Returns:
        2D float64 elevation array in meters.
    """
    amplitude = {"earth": 150.0, "mars": 300.0, "moon": 450.0}.get(body, 150.0)
    key = f"{body}:{bbox[0]:.4f}:{bbox[1]:.4f}:{bbox[2]:.4f}:{bbox[3]:.4f}"
    seed = int(hashlib.sha256(key.encode()).hexdigest()[:8], 16)
    rng = np.random.default_rng(seed)
    dem = _fractal_noise(shape, rng) * amplitude * 2.0
    dem += rng.normal(0.0, amplitude * 0.02, size=shape)
    return dem


if __name__ == "__main__":
    # Every preset loads, is finite, and has real relief.
    for pid in PRESETS:
        dem = load_preset_dem(pid, shape=(100, 100))
        assert dem.shape == (100, 100)
        assert np.isfinite(dem).all()
        assert dem.std() > 1.0, pid

    # Determinism: same preset, same DEM.
    a = load_preset_dem("jezero_crater", shape=(100, 100))
    b = load_preset_dem("jezero_crater", shape=(100, 100))
    assert np.array_equal(a, b)

    # Crater morphology: the bowl center sits well below the outer floor.
    jezero = load_preset_dem("jezero_crater", shape=(100, 100))
    center_mean = jezero[45:55, 45:55].mean()
    border_mean = np.concatenate([jezero[:5].ravel(), jezero[-5:].ravel()]).mean()
    assert center_mean < border_mean - 100.0, (center_mean, border_mean)

    # Shackleton is far deeper than Jezero, as configured.
    shack = load_preset_dem("shackleton_crater", shape=(100, 100))
    assert shack.min() < jezero.min() - 1000.0

    # Arbitrary-bbox synthesis is deterministic and body-scaled.
    bbox = (17.0, 74.8, 17.4, 75.2)
    d1 = synthesize_dem(bbox, "earth", shape=(100, 100))
    d2 = synthesize_dem(bbox, "earth", shape=(100, 100))
    assert np.array_equal(d1, d2)
    d_moon = synthesize_dem(bbox, "moon", shape=(100, 100))
    assert d_moon.std() > d1.std()

    # Public listing carries exactly the PresetInfo fields.
    listing = list_presets()
    assert len(listing) == 4
    assert all(set(p) == {"id", "name", "body", "bbox", "cell_size_m", "dataset", "description"} for p in listing)

    # Unknown preset raises.
    try:
        get_preset("olympus_mons")
        raise AssertionError("expected ValueError for unknown preset")
    except ValueError:
        pass

    print("data/presets.py: all tests passed")
