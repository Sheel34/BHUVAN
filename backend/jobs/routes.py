"""/api/v2/jobs — async job API over the same analysis pipeline as v1.

Contract:
    POST /api/v2/jobs                 {"sample": id}            -> 202 JobAccepted
    POST /api/v2/jobs/upload          multipart file            -> 202 JobAccepted
    GET  /api/v2/jobs/{job_id}                                  -> JobStatus
    GET  /artifacts/{job_id}/result.json                        -> AnalysisPayload

Job ids are content hashes (cache-aside): re-submitting the same sample or
identical upload bytes returns the finished job instantly.
"""

from __future__ import annotations

import hashlib
import json
import os
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

from .celery_app import EAGER, celery_app
from .tasks import analyze_job, job_dir, write_error

router = APIRouter(prefix="/api/v2", tags=["jobs"])

UPLOAD_LIMIT = 50 * 1024 * 1024
ALLOWED_UPLOAD_TYPES = {"image/png", "image/jpeg", "image/tiff", "image/x-tiff"}


class JobRequest(BaseModel):
    sample: str
    ai_enhance: bool = False


class JobAccepted(BaseModel):
    job_id: str
    state: str
    status_url: str
    cached: bool = False


class JobStatus(BaseModel):
    job_id: str
    state: Literal["PENDING", "STARTED", "PROGRESS", "SUCCESS", "FAILURE"]
    stage: Optional[str] = None
    pct: Optional[int] = None
    result_url: Optional[str] = None
    error: Optional[dict] = None


def _output_dir() -> str:
    import main as backend_main

    return backend_main.OUTPUT_DIR


def _result_path(job_id: str) -> str:
    return os.path.join(job_dir(_output_dir(), job_id), "result.json")


def _error_path(job_id: str) -> str:
    return os.path.join(job_dir(_output_dir(), job_id), "error.json")


def _terminal_status(job_id: str) -> JobStatus | None:
    """Disk is the source of truth for finished jobs (works without Redis)."""
    if os.path.exists(_result_path(job_id)):
        return JobStatus(
            job_id=job_id,
            state="SUCCESS",
            stage="Complete",
            pct=100,
            result_url=f"/artifacts/{job_id}/result.json",
        )
    if os.path.exists(_error_path(job_id)):
        with open(_error_path(job_id), encoding="utf-8") as fh:
            return JobStatus(job_id=job_id, state="FAILURE", error=json.load(fh))
    return None


def _submit(job_id: str, spec: dict) -> JobAccepted:
    status_url = f"/api/v2/jobs/{job_id}"
    if _terminal_status(job_id) is not None:
        return JobAccepted(job_id=job_id, state="SUCCESS", status_url=status_url, cached=True)

    if EAGER:
        try:
            analyze_job.apply(args=[spec], task_id=job_id)
        except Exception:  # noqa: BLE001 — error.json already written by the task
            if not os.path.exists(_error_path(job_id)):
                write_error(_output_dir(), job_id, "ANALYSIS_FAILED", "Job failed.")
            return JobAccepted(job_id=job_id, state="FAILURE", status_url=status_url)
        return JobAccepted(job_id=job_id, state="SUCCESS", status_url=status_url)

    analyze_job.apply_async(args=[spec], task_id=job_id)
    return JobAccepted(job_id=job_id, state="PENDING", status_url=status_url)


@router.post("/jobs", response_model=JobAccepted, status_code=202)
def create_job(request: JobRequest):
    import main as backend_main

    if request.sample not in backend_main.SAMPLE_REGISTRY:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "UNKNOWN_SAMPLE",
                "message": f"Sample '{request.sample}' not in registry.",
            },
        )
    job_id = hashlib.sha256(
        f"sample:{request.sample}:ai={int(request.ai_enhance)}".encode()
    ).hexdigest()[:32]
    return _submit(
        job_id,
        {"kind": "sample", "sample": request.sample, "ai_enhance": request.ai_enhance},
    )


@router.post("/jobs/upload", response_model=JobAccepted, status_code=202)
async def create_upload_job(file: Annotated[UploadFile, File(...)]):
    ct = (file.content_type or "").lower()
    if ct not in ALLOWED_UPLOAD_TYPES:
        raise HTTPException(
            status_code=415,
            detail={"code": "UNSUPPORTED_MEDIA_TYPE", "message": f"Received '{ct}'."},
        )
    content = await file.read()
    if len(content) < 64:
        raise HTTPException(
            status_code=400,
            detail={"code": "FILE_TOO_SMALL", "message": "File appears empty."},
        )
    if len(content) > UPLOAD_LIMIT:
        raise HTTPException(
            status_code=413,
            detail={"code": "FILE_TOO_LARGE", "message": "Maximum upload is 50 MB."},
        )

    job_id = hashlib.sha256(content).hexdigest()[:32]
    d = job_dir(_output_dir(), job_id)
    os.makedirs(d, exist_ok=True)
    input_path = os.path.join(d, "input.bin")
    with open(input_path, "wb") as fh:
        fh.write(content)

    return _submit(
        job_id,
        {
            "kind": "upload",
            "input_path": input_path,
            "content_type": ct,
            "filename": file.filename or "",
        },
    )


@router.get("/jobs/{job_id}", response_model=JobStatus)
def get_job_status(job_id: str):
    terminal = _terminal_status(job_id)
    if terminal is not None:
        return terminal

    if EAGER:
        # Eager jobs finish inline; nothing on disk means the id is unknown.
        raise HTTPException(
            status_code=404,
            detail={"code": "UNKNOWN_JOB", "message": f"No job '{job_id}'."},
        )

    try:
        async_result = celery_app.AsyncResult(job_id)
        state = async_result.state
        info = async_result.info if isinstance(async_result.info, dict) else {}
    except Exception:  # noqa: BLE001 — Redis unreachable
        raise HTTPException(
            status_code=503,
            detail={"code": "QUEUE_UNAVAILABLE", "message": "Job queue backend unreachable."},
        )

    if state == "FAILURE":
        return JobStatus(
            job_id=job_id,
            state="FAILURE",
            error={"code": "ANALYSIS_FAILED", "message": str(async_result.info)},
        )
    if state not in {"PENDING", "STARTED", "PROGRESS", "SUCCESS"}:
        state = "PENDING"
    return JobStatus(
        job_id=job_id,
        state=state,
        stage=info.get("stage"),
        pct=info.get("pct"),
    )
