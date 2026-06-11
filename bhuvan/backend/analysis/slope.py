"""Slope computation for the BHUVAN terrain pipeline.

Computes the per-cell slope angle of a digital elevation model (DEM):

    slope = arctan(sqrt((dz/dx)^2 + (dz/dy)^2))

Partial derivatives are obtained with numpy.gradient (central differences
in the interior, one-sided at the edges), scaled by the ground cell size
so the result is physically correct in degrees.
"""

from __future__ import annotations

import numpy as np


def compute_slope(elevation: np.ndarray, cell_size: float = 1.0) -> np.ndarray:
    """Compute the slope angle in degrees for every cell of a DEM.

    Args:
        elevation: 2D array of elevation values in meters.
        cell_size: Ground distance between adjacent cells in meters.

    Returns:
        2D float64 array of slope angles in degrees [0, 90), same shape
        as the input.

    Raises:
        ValueError: If the input is not 2D or cell_size is not positive.
    """
    if elevation.ndim != 2:
        raise ValueError(f"elevation must be a 2D array, got shape {elevation.shape}")
    if cell_size <= 0:
        raise ValueError(f"cell_size must be positive, got {cell_size}")

    dem = elevation.astype(np.float64, copy=False)
    dz_dy, dz_dx = np.gradient(dem, cell_size)
    gradient_magnitude = np.hypot(dz_dx, dz_dy)
    return np.degrees(np.arctan(gradient_magnitude))


if __name__ == "__main__":
    rng = np.random.default_rng(42)

    # Flat terrain has zero slope everywhere.
    flat = np.zeros((100, 100), dtype=np.float64)
    assert np.allclose(compute_slope(flat, cell_size=1.0), 0.0)

    # A plane tilted by exactly 10 degrees along x recovers 10 degrees.
    angle_deg = 10.0
    x = np.arange(100, dtype=np.float64)
    plane = np.tile(x * np.tan(np.radians(angle_deg)), (100, 1))
    slope = compute_slope(plane, cell_size=1.0)
    assert np.allclose(slope, angle_deg, atol=1e-9), slope

    # Cell size matters: same plane sampled at 2 m cells halves the gradient.
    slope_coarse = compute_slope(plane, cell_size=2.0)
    expected = np.degrees(np.arctan(np.tan(np.radians(angle_deg)) / 2.0))
    assert np.allclose(slope_coarse, expected, atol=1e-9)

    # Random terrain: slopes are finite, non-negative, below 90 degrees.
    noisy = rng.normal(0.0, 5.0, size=(100, 100))
    s = compute_slope(noisy, cell_size=30.0)
    assert s.shape == (100, 100)
    assert np.isfinite(s).all() and (s >= 0.0).all() and (s < 90.0).all()

    # Invalid inputs are rejected.
    try:
        compute_slope(np.zeros(10), cell_size=1.0)
        raise AssertionError("expected ValueError for 1D input")
    except ValueError:
        pass
    try:
        compute_slope(flat, cell_size=0.0)
        raise AssertionError("expected ValueError for zero cell_size")
    except ValueError:
        pass

    print("analysis/slope.py: all tests passed")
