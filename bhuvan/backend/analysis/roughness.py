"""Surface roughness computation for the BHUVAN terrain pipeline.

Roughness is defined as the standard deviation of elevation inside a
sliding 3x3 window, computed with scipy.ndimage.generic_filter and
np.std. High values indicate boulder fields, crater rims, and broken
terrain that are unsafe for landing regardless of mean slope.
"""

from __future__ import annotations

import numpy as np
from scipy.ndimage import generic_filter


def compute_roughness(elevation: np.ndarray, window: int = 3) -> np.ndarray:
    """Compute local elevation standard deviation over a sliding window.

    Args:
        elevation: 2D array of elevation values in meters.
        window: Odd window edge length in cells (default 3 → 3x3 window).

    Returns:
        2D float64 array of local elevation std deviation in meters,
        same shape as the input. Edges use nearest-neighbor padding.

    Raises:
        ValueError: If the input is not 2D or the window is invalid.
    """
    if elevation.ndim != 2:
        raise ValueError(f"elevation must be a 2D array, got shape {elevation.shape}")
    if window < 3 or window % 2 == 0:
        raise ValueError(f"window must be odd and >= 3, got {window}")

    dem = elevation.astype(np.float64, copy=False)
    return generic_filter(dem, np.std, size=window, mode="nearest")


if __name__ == "__main__":
    rng = np.random.default_rng(7)

    # Flat terrain has zero roughness.
    flat = np.full((100, 100), 1500.0)
    assert np.allclose(compute_roughness(flat), 0.0)

    # A uniform ramp has a known analytic roughness: the 3x3 window holds
    # three copies each of {c-1, c, c+1} * m, so std = m * sqrt(2/3).
    m = 4.0
    ramp = np.tile(np.arange(100, dtype=np.float64) * m, (100, 1))
    rough = compute_roughness(ramp)
    expected = m * np.sqrt(2.0 / 3.0)
    assert np.allclose(rough[1:-1, 1:-1], expected, atol=1e-9), rough[1:-1, 1:-1]

    # A noisy patch is measurably rougher than the smooth surroundings.
    terrain = np.zeros((100, 100))
    terrain[40:60, 40:60] = rng.normal(0.0, 10.0, size=(20, 20))
    rough = compute_roughness(terrain)
    assert rough[45:55, 45:55].mean() > 10.0 * rough[0:10, 0:10].mean() + 1.0

    # Invalid window sizes are rejected.
    try:
        compute_roughness(flat, window=4)
        raise AssertionError("expected ValueError for even window")
    except ValueError:
        pass
    try:
        compute_roughness(flat, window=1)
        raise AssertionError("expected ValueError for window < 3")
    except ValueError:
        pass

    print("analysis/roughness.py: all tests passed")
