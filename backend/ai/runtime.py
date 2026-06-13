"""Runtime gateway between the API/worker and the Terrain GAN.

The web backend must work on machines without PyTorch or a trained
checkpoint, so everything torch-related is imported lazily and the API
asks ``model_available()`` before promising AI enhancement.

Checkpoint path: ``ARES_GAN_CHECKPOINT`` env var, default
``backend/checkpoints/terrain_gan_final.pt`` (produced by ai.train).
"""

from __future__ import annotations

import importlib.util
import logging
import os

import numpy as np

logger = logging.getLogger(__name__)

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHECKPOINT_PATH = os.environ.get(
    "ARES_GAN_CHECKPOINT",
    os.path.join(_BACKEND_DIR, "checkpoints", "terrain_gan_final.pt"),
)


def torch_available() -> bool:
    return importlib.util.find_spec("torch") is not None


def model_available() -> tuple[bool, str]:
    """Returns (available, reason-if-not)."""
    if not torch_available():
        return False, "PyTorch is not installed in this environment."
    if not os.path.exists(CHECKPOINT_PATH):
        return False, f"No trained checkpoint at {CHECKPOINT_PATH}."
    return True, ""


def enhance_elevation(elevation: np.ndarray) -> np.ndarray:
    """Run GAN enhancement on a normalised [0,1] elevation grid.

    Output is a 256x256 normalised grid (the model's native resolution).
    Caller is responsible for having checked ``model_available()``.
    """
    from .inference import enhance_dem_with_ai  # lazy: pulls in torch

    enhanced = enhance_dem_with_ai(elevation, CHECKPOINT_PATH)
    return enhanced.astype(np.float32)
