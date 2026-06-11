"""Celery worker for BHUVAN terrain analysis jobs.

Wraps the full analysis pipeline in one async task. The task reports
each pipeline stage through Celery's PROGRESS state with the exact
human-readable strings the frontend displays ("Fetching elevation
data...", "Computing slope...", ...).

Run a worker (from the bhuvan/ repo root):

    celery -A backend.tasks.celery_worker.celery_app worker --loglevel=info

On Windows add `--pool=solo`. The broker/backend default to a local
Redis and can be overridden with the BHUVAN_REDIS_URL env var.
"""

from __future__ import annotations

import os

import numpy as np
from celery import Celery, Task

from backend.analysis.hazard import combine_hazard, compute_curvature
from backend.analysis.landing_zones import rank_landing_zones
from backend.analysis.roughness import compute_roughness
from backend.analysis.slope import compute_slope
from backend.data.presets import get_preset, load_preset_dem, synthesize_dem
from backend.schemas.terrain import (
    AnalysisRequest,
    AnalysisResult,
    BoundingBox,
    JobStage,
    LandingZone,
    LayerStats,
)

REDIS_URL: str = os.environ.get("BHUVAN_REDIS_URL", "redis://localhost:6379/0")

celery_app = Celery("bhuvan", broker=REDIS_URL, backend=REDIS_URL)
celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    task_track_started=True,
    result_expires=3600,
)


def _set_stage(task: Task, stage: JobStage, progress: float) -> None:
    """Publish a pipeline stage to the result backend for /status polling."""
    task.update_state(
        state="PROGRESS", meta={"stage": stage.value, "progress": progress}
    )


def _resolve_dem(
    req: AnalysisRequest,
) -> tuple[np.ndarray, tuple[float, float, float, float], float]:
    """Load the elevation grid for a request.

    Presets use their stored deterministic terrain; free bbox selections
    use the seeded synthesizer (Phase 2: NASA Earthdata + rasterio client
    replaces `synthesize_dem` here — this is the only call site).

    Returns:
        (elevation, bbox_tuple, cell_size_m)
    """
    if req.preset_id is not None:
        preset = get_preset(req.preset_id)
        bb = preset["bbox"]
        bbox = (bb["min_lat"], bb["min_lon"], bb["max_lat"], bb["max_lon"])
        return load_preset_dem(req.preset_id), bbox, float(preset["cell_size_m"])
    assert req.bbox is not None  # guaranteed by schema validation
    bbox = req.bbox.as_tuple()
    dem = synthesize_dem(bbox, req.body.value, shape=(req.grid_size, req.grid_size))
    return dem, bbox, req.grid_resolution_m


def _layer_to_list(arr: np.ndarray) -> list[list[float]]:
    """Round and convert a layer to a JSON-serializable nested list."""
    return np.round(arr.astype(np.float64), 4).tolist()


def _layer_stats(arr: np.ndarray) -> LayerStats:
    """Min/max/mean summary for one layer."""
    return LayerStats(
        min=float(arr.min()), max=float(arr.max()), mean=float(arr.mean())
    )


@celery_app.task(bind=True, name="bhuvan.analyze_terrain")
def analyze_terrain(self: Task, request: dict) -> dict:
    """Run the full BHUVAN pipeline for one /analyze request.

    Args:
        request: JSON dict matching AnalysisRequest.

    Returns:
        JSON dict matching AnalysisResult.
    """
    req = AnalysisRequest.model_validate(request)

    _set_stage(self, JobStage.FETCHING_DEM, 0.05)
    elevation, bbox, cell_size = _resolve_dem(req)

    _set_stage(self, JobStage.COMPUTING_SLOPE, 0.25)
    slope_deg = compute_slope(elevation, cell_size)

    _set_stage(self, JobStage.COMPUTING_ROUGHNESS, 0.45)
    roughness = compute_roughness(elevation)

    _set_stage(self, JobStage.COMPUTING_CURVATURE, 0.60)
    curvature = compute_curvature(elevation, cell_size)

    _set_stage(self, JobStage.SCORING_HAZARD, 0.75)
    hazard = combine_hazard(slope_deg, roughness, curvature)

    _set_stage(self, JobStage.RANKING_ZONES, 0.90)
    rover_radius_px = max(1, round(req.rover_radius_m / cell_size))
    zones = rank_landing_zones(hazard, bbox, rover_radius_px=rover_radius_px)

    layers = {
        "slope_deg": slope_deg,
        "roughness": roughness,
        "curvature": curvature,
        "hazard": hazard,
    }
    result = AnalysisResult(
        job_id=str(self.request.id or ""),
        body=req.body if req.preset_id is None else get_preset(req.preset_id)["body"],
        preset_id=req.preset_id,
        bbox=BoundingBox(
            min_lat=bbox[0], min_lon=bbox[1], max_lat=bbox[2], max_lon=bbox[3]
        ),
        grid_shape=(int(elevation.shape[0]), int(elevation.shape[1])),
        cell_size_m=float(cell_size),
        layers={name: _layer_to_list(arr) for name, arr in layers.items()},
        stats={name: _layer_stats(arr) for name, arr in layers.items()},
        landing_zones=[LandingZone(**z) for z in zones],
    )
    return result.model_dump(mode="json")


if __name__ == "__main__":
    # Run the task synchronously in-process: no Redis required.
    celery_app.conf.task_always_eager = True
    celery_app.conf.task_store_eager_result = True
    celery_app.conf.result_backend = "cache+memory://"
    celery_app.conf.broker_url = "memory://"

    # Preset path: Jezero Crater end to end.
    req = AnalysisRequest(preset_id="jezero_crater", rover_radius_m=2.5)
    out = analyze_terrain.apply(args=[req.model_dump(mode="json")]).get()
    result = AnalysisResult.model_validate(out)
    assert result.preset_id == "jezero_crater"
    assert result.body.value == "mars"
    assert result.grid_shape == (200, 200)
    assert set(result.layers) == {"slope_deg", "roughness", "curvature", "hazard"}
    assert len(result.layers["hazard"]) == 200 and len(result.layers["hazard"][0]) == 200
    assert 1 <= len(result.landing_zones) <= 5
    assert result.landing_zones[0].safety_score >= result.landing_zones[-1].safety_score
    flat_hazard = [v for row in result.layers["hazard"] for v in row]
    assert 0.0 <= min(flat_hazard) and max(flat_hazard) <= 1.0
    bb = result.bbox
    for z in result.landing_zones:
        assert bb.min_lat <= z.lat <= bb.max_lat and bb.min_lon <= z.lon <= bb.max_lon

    # Free-bbox path on a synthetic 100x100 grid.
    req2 = AnalysisRequest(
        bbox=BoundingBox(min_lat=17.0, min_lon=74.8, max_lat=17.4, max_lon=75.2),
        body="earth",
        grid_size=100,
        grid_resolution_m=30.0,
    )
    out2 = analyze_terrain.apply(args=[req2.model_dump(mode="json")]).get()
    result2 = AnalysisResult.model_validate(out2)
    assert result2.grid_shape == (100, 100)
    assert result2.preset_id is None
    assert len(result2.landing_zones) >= 1

    # Determinism across runs (cache-aside friendly).
    out3 = analyze_terrain.apply(args=[req2.model_dump(mode="json")]).get()
    assert out3["stats"] == out2["stats"]

    print("tasks/celery_worker.py: all tests passed")
