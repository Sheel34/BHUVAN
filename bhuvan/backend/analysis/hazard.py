"""Composite hazard scoring for the BHUVAN terrain pipeline.

Combines three terrain derivatives into a single hazard score per cell:

    hazard = 0.5 * normalized_slope
           + 0.3 * normalized_roughness
           + 0.2 * abs(normalized_curvature)

Curvature is the Laplacian (second derivative) of the elevation surface.
Slope and roughness are min-max normalized to [0, 1]. Curvature is
normalized symmetrically to [-1, 1] (divided by its max absolute value)
before taking abs(), so that both pits (positive Laplacian) and peaks
(negative Laplacian) contribute equally as hazards. The result is
clipped to [0, 1].
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.ndimage import laplace

from backend.analysis.roughness import compute_roughness
from backend.analysis.slope import compute_slope

W_SLOPE: float = 0.5
W_ROUGHNESS: float = 0.3
W_CURVATURE: float = 0.2


@dataclass(frozen=True)
class HazardLayers:
    """All per-cell layers produced by one pipeline run."""

    slope_deg: np.ndarray
    roughness: np.ndarray
    curvature: np.ndarray
    hazard: np.ndarray


def compute_curvature(elevation: np.ndarray, cell_size: float = 1.0) -> np.ndarray:
    """Compute surface curvature as the Laplacian of the DEM.

    Args:
        elevation: 2D array of elevation values in meters.
        cell_size: Ground distance between adjacent cells in meters.

    Returns:
        2D float64 array of curvature (1/m). Positive values are local
        depressions, negative values are local peaks/ridges.

    Raises:
        ValueError: If the input is not 2D or cell_size is not positive.
    """
    if elevation.ndim != 2:
        raise ValueError(f"elevation must be a 2D array, got shape {elevation.shape}")
    if cell_size <= 0:
        raise ValueError(f"cell_size must be positive, got {cell_size}")
    dem = elevation.astype(np.float64, copy=False)
    return laplace(dem, mode="nearest") / (cell_size**2)


def normalize_minmax(layer: np.ndarray) -> np.ndarray:
    """Min-max normalize a layer to [0, 1]. A constant layer maps to zeros."""
    layer = layer.astype(np.float64, copy=False)
    lo, hi = float(layer.min()), float(layer.max())
    if hi - lo == 0.0:
        return np.zeros_like(layer)
    return (layer - lo) / (hi - lo)


def normalize_symmetric(layer: np.ndarray) -> np.ndarray:
    """Normalize a signed layer to [-1, 1] by its max absolute value."""
    layer = layer.astype(np.float64, copy=False)
    peak = float(np.abs(layer).max())
    if peak == 0.0:
        return np.zeros_like(layer)
    return layer / peak


def combine_hazard(
    slope_deg: np.ndarray, roughness: np.ndarray, curvature: np.ndarray
) -> np.ndarray:
    """Combine normalized layers into the composite hazard score.

    Args:
        slope_deg: Slope angle layer (degrees).
        roughness: Local elevation std deviation layer (meters).
        curvature: Laplacian curvature layer (1/m).

    Returns:
        2D float64 hazard array in [0, 1], same shape as the inputs.

    Raises:
        ValueError: If layer shapes differ.
    """
    if not (slope_deg.shape == roughness.shape == curvature.shape):
        raise ValueError(
            "layer shapes differ: "
            f"{slope_deg.shape}, {roughness.shape}, {curvature.shape}"
        )
    hazard = (
        W_SLOPE * normalize_minmax(slope_deg)
        + W_ROUGHNESS * normalize_minmax(roughness)
        + W_CURVATURE * np.abs(normalize_symmetric(curvature))
    )
    return np.clip(hazard, 0.0, 1.0)


def compute_hazard_layers(
    elevation: np.ndarray, cell_size: float = 1.0
) -> HazardLayers:
    """Run the full per-cell pipeline: slope → roughness → curvature → hazard.

    Args:
        elevation: 2D DEM array in meters.
        cell_size: Ground distance per cell in meters.

    Returns:
        HazardLayers with all four layers, each the shape of the input.
    """
    slope_deg = compute_slope(elevation, cell_size)
    roughness = compute_roughness(elevation)
    curvature = compute_curvature(elevation, cell_size)
    hazard = combine_hazard(slope_deg, roughness, curvature)
    return HazardLayers(
        slope_deg=slope_deg, roughness=roughness, curvature=curvature, hazard=hazard
    )


if __name__ == "__main__":
    rng = np.random.default_rng(11)

    # Synthetic 100x100 DEM: calm western half, steep + rugged eastern half.
    dem = np.zeros((100, 100), dtype=np.float64)
    cols = np.arange(50, dtype=np.float64)
    dem[:, 50:] = cols * 8.0  # steep ramp
    dem[:, 50:] += rng.normal(0.0, 6.0, size=(100, 50))  # broken surface

    layers = compute_hazard_layers(dem, cell_size=10.0)

    # Shapes and bounds.
    for arr in (layers.slope_deg, layers.roughness, layers.curvature, layers.hazard):
        assert arr.shape == (100, 100)
        assert np.isfinite(arr).all()
    assert (layers.hazard >= 0.0).all() and (layers.hazard <= 1.0).all()

    # The rugged half must score clearly more hazardous than the calm half.
    calm = layers.hazard[:, :45].mean()
    rugged = layers.hazard[:, 55:].mean()
    assert rugged > calm + 0.2, (calm, rugged)

    # Constant terrain produces an all-zero hazard map.
    assert np.allclose(compute_hazard_layers(np.full((100, 100), 42.0)).hazard, 0.0)

    # Both a pit and a peak register curvature hazard (abs of symmetric norm).
    bowl = np.zeros((100, 100))
    bowl[50, 50] = -25.0  # pit
    bowl[20, 20] = 25.0  # spike
    curv = compute_curvature(bowl, cell_size=1.0)
    contribution = np.abs(normalize_symmetric(curv))
    assert contribution[50, 50] > 0.9 and contribution[20, 20] > 0.9

    # Weights are the spec'd contract.
    assert (W_SLOPE, W_ROUGHNESS, W_CURVATURE) == (0.5, 0.3, 0.2)

    print("analysis/hazard.py: all tests passed")
