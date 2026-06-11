"""Landing zone ranking tests against the current layer format.

`rank_landing_zones` consumes the dict-of-dicts produced by
`analyze_terrain`, where each layer holds a 2D float32 grid under "data".
"""

import numpy as np

from pipeline.landing_zones import HAZARD_SAFE_THRESHOLD, rank_landing_zones
from pipeline.terrain_analysis import analyze_terrain


def _flat_terrain_layers(size: int = 96) -> tuple[np.ndarray, dict]:
    """Mostly-flat terrain with one rough corner: guaranteed safe zones."""
    rng = np.random.default_rng(7)
    elevation = np.zeros((size, size), dtype=np.float32)
    elevation += 0.01 * rng.standard_normal((size, size)).astype(np.float32)
    elevation[: size // 4, : size // 4] += rng.uniform(
        0.0, 1.0, (size // 4, size // 4)
    ).astype(np.float32)
    layers = analyze_terrain(elevation, cell_size_m=1.25)
    return elevation * 30.0, layers


def test_rank_landing_zones_does_not_crash_on_current_layer_format():
    elevation_m, layers = _flat_terrain_layers()
    zones = rank_landing_zones(elevation_m, layers, scale_m=200.0)
    assert isinstance(zones, list)


def test_rank_landing_zones_returns_sorted_valid_zones():
    elevation_m, layers = _flat_terrain_layers()
    zones = rank_landing_zones(elevation_m, layers, scale_m=200.0)

    assert zones, "flat terrain should produce at least one landing zone"
    scores = [z.score for z in zones]
    assert scores == sorted(scores, reverse=True)

    for zone in zones:
        assert zone.classification in {"safe", "caution", "unsafe"}
        assert zone.mean_hazard_in_patch <= HAZARD_SAFE_THRESHOLD
        assert 0.0 <= zone.confidence <= 1.0
        assert -100.0 <= zone.x <= 100.0
        assert -100.0 <= zone.z <= 100.0
        assert zone.uncertainty is not None
        assert zone.uncertainty.bootstrap_samples == 100


def test_rank_landing_zones_handles_fully_hazardous_terrain():
    size = 64
    ones = np.ones((size, size), dtype=np.float32)
    layers = {
        "slope": {"data": ones, "min_val": 0.0, "max_val": 15.0},
        "roughness": {"data": ones, "min_val": 0.0, "max_val": 0.5},
        "curvature": {"data": ones, "min_val": 0.0, "max_val": 0.1},
        "shadow": {"data": ones, "min_val": 0.0, "max_val": 1.0},
        "hazard": {"data": ones, "min_val": 0.0, "max_val": 1.0},
        "traversability": {"data": np.zeros_like(ones), "min_val": 0.0, "max_val": 1.0},
    }
    zones = rank_landing_zones(ones * 30.0, layers, scale_m=200.0)
    assert zones == []
