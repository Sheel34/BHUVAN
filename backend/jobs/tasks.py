"""Celery tasks for terrain analysis.

A job spec is a small dict:
    {"kind": "sample", "sample": "<registry id>"}
    {"kind": "upload", "input_path": "<abs path>", "content_type": "...", "filename": "..."}

Terminal state is persisted to disk under ``outputs/<job_id>/``:
    result.json  — full AnalysisPayload on success
    error.json   — {"code", "message"} on failure

Disk is the source of truth for finished jobs; Redis carries live progress.
"""

from __future__ import annotations

import json
import os

from .celery_app import celery_app

STAGE_FETCH = "Fetching terrain data"
STAGE_DONE = "Complete"


def job_dir(output_dir: str, job_id: str) -> str:
    return os.path.join(output_dir, job_id)


def write_error(output_dir: str, job_id: str, code: str, message: str) -> None:
    d = job_dir(output_dir, job_id)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "error.json"), "w", encoding="utf-8") as fh:
        json.dump({"code": code, "message": message}, fh)


class ModelUnavailableError(RuntimeError):
    pass


def _resolve_elevation(spec: dict):
    """Resolve a job spec to (elevation_grid, metadata). Raises ValueError on bad input."""
    # Imported lazily: main imports jobs.routes at startup; tasks resolve main at runtime.
    import main as backend_main

    if spec["kind"] == "sample":
        sample_id = spec["sample"]
        info = backend_main.SAMPLE_REGISTRY[sample_id]
        if info["source"] == "hirise-dtm":
            from data.hirise_downloader import get_cache_path
            return backend_main._native_product(get_cache_path(info["hirise_id"]), info["hirise_id"], "hirise-dtm", "mars", info["label"])
        if info["source"] == "lola-dem":
            from data.lroc_downloader import get_dem_cache_path
            return backend_main._native_product(get_dem_cache_path(info["lola_id"]), info["lola_id"], "lola-dem", "moon", info["label"])
        from pipeline.ingest import generate_sample

        return generate_sample(sample_id)

    if spec["kind"] == "upload":
        from pipeline.ingest import ingest_geotiff, ingest_image_bytes

        path = spec["input_path"]
        ct = (spec.get("content_type") or "").lower()
        name = (spec.get("filename") or "").lower()
        if ct in {"image/tiff", "image/x-tiff"} or name.endswith((".tif", ".tiff")):
            grid, metadata = ingest_geotiff(path)
            metadata["dataset_id"] = spec.get("filename", "uploaded-geotiff")
            return grid, metadata
        with open(path, "rb") as fh:
            grid, metadata = ingest_image_bytes(fh.read())
        metadata["dataset_id"] = spec.get("filename", "uploaded-image")
        return grid, metadata

    raise ValueError(f"Unknown job kind: {spec.get('kind')!r}")


@celery_app.task(bind=True, name="bhuvan.analyze")
def analyze_job(self, spec: dict) -> dict:
    import main as backend_main

    job_id = self.request.id
    output_dir = backend_main.OUTPUT_DIR

    def publish(stage: str, pct: int) -> None:
        if not celery_app.conf.task_always_eager:
            self.update_state(state="PROGRESS", meta={"stage": stage, "pct": pct})

    try:
        publish(STAGE_FETCH, 10)
        elevation, metadata = _resolve_elevation(spec)

        if spec.get("ai_enhance"):
            from ai.runtime import enhance_elevation, model_available

            available, reason = model_available()
            if not available:
                raise ModelUnavailableError(reason)
            publish("AI elevation enhancement", 20)
            elevation = enhance_elevation(elevation)
            metadata = {
                **metadata,
                "grid_size": int(elevation.shape[0]),
                "source": f"{metadata['source']}+ai-enhanced",
            }

        payload = backend_main.build_payload(
            elevation, metadata, progress=publish, job_id=job_id
        )
    except ModelUnavailableError as exc:
        write_error(output_dir, job_id, "MODEL_UNAVAILABLE", str(exc))
        raise
    except ValueError as exc:
        write_error(output_dir, job_id, "INGEST_FAILED", str(exc))
        raise
    except FileNotFoundError as exc:
        write_error(output_dir, job_id, "DTM_NOT_CACHED", str(exc))
        raise
    except Exception as exc:  # noqa: BLE001 — persist any worker crash for the API
        write_error(output_dir, job_id, "ANALYSIS_FAILED", str(exc))
        raise

    d = job_dir(output_dir, job_id)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "result.json"), "w", encoding="utf-8") as fh:
        fh.write(payload.model_dump_json())

    publish(STAGE_DONE, 100)
    return {"job_id": job_id, "result_url": f"/artifacts/{job_id}/result.json"}
