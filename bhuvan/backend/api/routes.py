"""FastAPI routes for BHUVAN.

Three endpoints, matching the frontend flow exactly:

    POST /analyze          → validate request, queue Celery job, 202 + job_id
    GET  /status/{job_id}  → Celery state mapped to UI stage + progress;
                             carries the full AnalysisResult once complete
    GET  /presets          → the four preloaded mission terrains

Note: Celery reports unknown job ids as PENDING, so /status returns
"Queued" for ids it has never seen — the frontend treats a job that
stays Queued past its timeout as lost.
"""

from __future__ import annotations

from celery.result import AsyncResult
from fastapi import APIRouter, HTTPException

from backend.data.presets import get_preset, list_presets
from backend.schemas.terrain import (
    AnalysisRequest,
    AnalysisResult,
    AnalyzeResponse,
    JobStage,
    JobStatusResponse,
    PresetInfo,
)
from backend.tasks.celery_worker import analyze_terrain, celery_app

router = APIRouter(tags=["terrain"])


@router.get("/presets", response_model=list[PresetInfo])
def get_presets() -> list[PresetInfo]:
    """List the preloaded mission terrains."""
    return [PresetInfo(**p) for p in list_presets()]


@router.post("/analyze", response_model=AnalyzeResponse, status_code=202)
def start_analysis(request: AnalysisRequest) -> AnalyzeResponse:
    """Validate the request and queue an analysis job."""
    if request.preset_id is not None:
        try:
            get_preset(request.preset_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
    task = analyze_terrain.delay(request.model_dump(mode="json"))
    return AnalyzeResponse(job_id=task.id, status_url=f"/status/{task.id}")


@router.get("/status/{job_id}", response_model=JobStatusResponse)
def get_status(job_id: str) -> JobStatusResponse:
    """Report job progress; attach the result when the job is complete."""
    res = AsyncResult(job_id, app=celery_app)
    state = res.state

    if state == "SUCCESS":
        return JobStatusResponse(
            job_id=job_id,
            state=state,
            stage=JobStage.COMPLETE,
            progress=1.0,
            result=AnalysisResult.model_validate(res.result),
        )
    if state == "FAILURE":
        return JobStatusResponse(
            job_id=job_id,
            state=state,
            stage=JobStage.FAILED,
            progress=1.0,
            error=str(res.result),
        )
    if state == "PROGRESS":
        meta = res.info if isinstance(res.info, dict) else {}
        return JobStatusResponse(
            job_id=job_id,
            state=state,
            stage=JobStage(meta.get("stage", JobStage.FETCHING_DEM.value)),
            progress=float(meta.get("progress", 0.0)),
        )
    if state == "STARTED":
        return JobStatusResponse(
            job_id=job_id, state=state, stage=JobStage.FETCHING_DEM, progress=0.05
        )
    # PENDING / RETRY / unknown ids
    return JobStatusResponse(
        job_id=job_id, state=state, stage=JobStage.QUEUED, progress=0.0
    )


if __name__ == "__main__":
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    # In-process Celery: eager execution, in-memory result backend.
    celery_app.conf.task_always_eager = True
    celery_app.conf.task_store_eager_result = True
    celery_app.conf.result_backend = "cache+memory://"
    celery_app.conf.broker_url = "memory://"

    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)

    # Presets endpoint serves all four mission terrains.
    r = client.get("/presets")
    assert r.status_code == 200
    presets = r.json()
    assert {p["id"] for p in presets} == {
        "jezero_crater",
        "vikram_site",
        "shackleton_crater",
        "deccan_plateau",
    }

    # Full preset flow: 202 → status SUCCESS with 5-zone result.
    r = client.post("/analyze", json={"preset_id": "vikram_site", "rover_radius_m": 3})
    assert r.status_code == 202, r.text
    job_id = r.json()["job_id"]
    assert r.json()["status_url"] == f"/status/{job_id}"

    r = client.get(f"/status/{job_id}")
    assert r.status_code == 200
    status = r.json()
    assert status["state"] == "SUCCESS" and status["stage"] == "Complete"
    assert status["progress"] == 1.0
    result = status["result"]
    assert result["preset_id"] == "vikram_site"
    assert len(result["landing_zones"]) >= 1
    assert set(result["layers"]) == {"slope_deg", "roughness", "curvature", "hazard"}

    # Free-bbox flow.
    r = client.post(
        "/analyze",
        json={
            "bbox": {"min_lat": 17.0, "min_lon": 74.8, "max_lat": 17.4, "max_lon": 75.2},
            "body": "earth",
            "grid_size": 100,
        },
    )
    assert r.status_code == 202, r.text
    r = client.get(f"/status/{r.json()['job_id']}")
    assert r.json()["result"]["grid_shape"] == [100, 100]

    # Unknown preset → 404; malformed bbox → 422; unknown job → Queued.
    assert client.post("/analyze", json={"preset_id": "atlantis"}).status_code == 404
    assert (
        client.post(
            "/analyze",
            json={"bbox": {"min_lat": 99, "min_lon": 0, "max_lat": 100, "max_lon": 1}},
        ).status_code
        == 422
    )
    assert (
        client.post("/analyze", json={"rover_radius_m": 2}).status_code == 422
    )  # neither bbox nor preset
    r = client.get("/status/nonexistent-job-id")
    assert r.status_code == 200 and r.json()["stage"] == "Queued"

    print("api/routes.py: all tests passed")
