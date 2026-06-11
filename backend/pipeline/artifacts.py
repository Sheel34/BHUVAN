"""Artifact writer — serializes analysis results as GPU-ready textures.

Per analysis job, writes into ``outputs/<job_id>/``:
  - ``heightmap.png``   16-bit grayscale elevation (0..65535 maps min_h..max_h)
  - ``<layer>.png``     8-bit grayscale per analysis layer (0..255 maps 0..1)

URLs are served by the FastAPI app via a StaticFiles mount at ``/artifacts``.
JSON arrays in the payload stay authoritative for the v1 contract; artifacts
are an additive, bandwidth-efficient representation for GPU sampling.
"""

from __future__ import annotations

import os
import shutil

import cv2
import numpy as np

ARTIFACT_ROUTE = "/artifacts"
LAYER_KEYS = ("slope", "roughness", "curvature", "shadow", "hazard", "traversability")

# Bound disk usage: keep the newest N job directories.
KEEP_JOB_DIRS = int(os.environ.get("ARES_ARTIFACT_KEEP", "32"))


def _evict_old_jobs(output_dir: str) -> None:
    try:
        job_dirs = [
            os.path.join(output_dir, d)
            for d in os.listdir(output_dir)
            if os.path.isdir(os.path.join(output_dir, d))
        ]
    except FileNotFoundError:
        return
    if len(job_dirs) <= KEEP_JOB_DIRS:
        return
    job_dirs.sort(key=os.path.getmtime, reverse=True)
    for stale in job_dirs[KEEP_JOB_DIRS:]:
        shutil.rmtree(stale, ignore_errors=True)


def write_analysis_artifacts(
    job_id: str,
    elevation_m: np.ndarray,
    layers: dict,
    output_dir: str,
) -> dict:
    """Write heightmap + layer textures for one job. Returns artifact metadata.

    Returned dict matches the ``ArtifactBundle`` schema:
    ``{"heightmap": {url, min_val, max_val}, "layers": {name: {url, min_val, max_val}}}``
    """
    job_dir = os.path.join(output_dir, job_id)
    os.makedirs(job_dir, exist_ok=True)

    min_h = float(elevation_m.min())
    max_h = float(elevation_m.max())
    h_range = max(max_h - min_h, 1e-9)
    height_norm = (elevation_m.astype(np.float64) - min_h) / h_range
    height_u16 = np.round(height_norm * 65535.0).astype(np.uint16)
    cv2.imwrite(os.path.join(job_dir, "heightmap.png"), height_u16)

    bundle = {
        "heightmap": {
            "url": f"{ARTIFACT_ROUTE}/{job_id}/heightmap.png",
            "min_val": min_h,
            "max_val": max_h,
        },
        "layers": {},
    }

    for key in LAYER_KEYS:
        layer = layers[key]
        norm = np.clip(layer["data"].astype(np.float32), 0.0, 1.0)
        img_u8 = np.round(norm * 255.0).astype(np.uint8)
        cv2.imwrite(os.path.join(job_dir, f"{key}.png"), img_u8)
        bundle["layers"][key] = {
            "url": f"{ARTIFACT_ROUTE}/{job_id}/{key}.png",
            "min_val": float(layer["min_val"]),
            "max_val": float(layer["max_val"]),
        }

    _evict_old_jobs(output_dir)
    return bundle
