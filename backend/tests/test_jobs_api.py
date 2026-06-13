"""Tests for the async job API (/api/v2/jobs) in eager mode.

Eager mode (BHUVAN_EAGER=1, set in conftest) runs Celery tasks inline; terminal
job state lives on disk, exactly as it does when a real worker writes it.
"""

import shutil
from io import BytesIO

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

import main as backend_main
from main import app

client = TestClient(app)


def _make_png_bytes(seed: int, size: int = 96) -> bytes:
    rng = np.random.default_rng(seed)
    xs = np.linspace(0, 255, size, dtype=np.float32)
    grid = np.tile(xs, (size, 1)) + 30.0 * rng.standard_normal((size, size))
    img = Image.fromarray(np.clip(grid, 0, 255).astype(np.uint8), mode="L").convert("RGB")
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _purge_job(job_id: str) -> None:
    shutil.rmtree(f"{backend_main.OUTPUT_DIR}/{job_id}", ignore_errors=True)


def test_sample_job_lifecycle():
    response = client.post("/api/v2/jobs", json={"sample": "mars-jezero"})
    assert response.status_code == 202
    accepted = response.json()
    job_id = accepted["job_id"]
    assert accepted["state"] == "SUCCESS"

    status = client.get(accepted["status_url"]).json()
    assert status["state"] == "SUCCESS"
    assert status["pct"] == 100
    assert status["result_url"] == f"/artifacts/{job_id}/result.json"

    result = client.get(status["result_url"])
    assert result.status_code == 200
    payload = result.json()
    assert payload["job_id"] == job_id
    assert len(payload["terrain"]["data"]) == payload["terrain"]["size"] ** 2
    assert payload["artifacts"]["heightmap"]["url"] == f"/artifacts/{job_id}/heightmap.png"


def test_sample_job_is_cached_on_resubmit():
    first = client.post("/api/v2/jobs", json={"sample": "mars-gale"}).json()
    second = client.post("/api/v2/jobs", json={"sample": "mars-gale"}).json()
    assert second["job_id"] == first["job_id"]
    assert second["cached"] is True


def test_unknown_sample_job_rejected_upfront():
    response = client.post("/api/v2/jobs", json={"sample": "venus-nope"})
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "UNKNOWN_SAMPLE"


def test_upload_job_lifecycle_and_dedupe():
    png = _make_png_bytes(seed=42)
    response = client.post(
        "/api/v2/jobs/upload", files={"file": ("region.png", png, "image/png")}
    )
    assert response.status_code == 202
    job_id = response.json()["job_id"]

    status = client.get(f"/api/v2/jobs/{job_id}").json()
    assert status["state"] == "SUCCESS"
    payload = client.get(status["result_url"]).json()
    assert payload["metadata"]["source"] == "uploaded-image"

    # Identical bytes -> same job, served from cache.
    again = client.post(
        "/api/v2/jobs/upload", files={"file": ("renamed.png", png, "image/png")}
    ).json()
    assert again["job_id"] == job_id
    assert again["cached"] is True
    _purge_job(job_id)


def test_upload_job_validation():
    bad_ct = client.post(
        "/api/v2/jobs/upload",
        files={"file": ("notes.txt", b"plain text, definitely not an image....", "text/plain")},
    )
    assert bad_ct.status_code == 415

    tiny = client.post(
        "/api/v2/jobs/upload", files={"file": ("t.png", b"tiny", "image/png")}
    )
    assert tiny.status_code == 400


def test_failed_job_reports_failure_state():
    # Valid PNG header size but undecodable content -> ingest fails inside the task.
    junk = b"\x89PNG\r\n\x1a\n" + bytes(range(256))
    response = client.post(
        "/api/v2/jobs/upload", files={"file": ("broken.png", junk, "image/png")}
    )
    assert response.status_code == 202
    job_id = response.json()["job_id"]
    assert response.json()["state"] == "FAILURE"

    status = client.get(f"/api/v2/jobs/{job_id}").json()
    assert status["state"] == "FAILURE"
    assert status["error"]["code"] == "INGEST_FAILED"
    _purge_job(job_id)


def test_unknown_job_id_404():
    response = client.get("/api/v2/jobs/deadbeefdeadbeefdeadbeefdeadbeef")
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "UNKNOWN_JOB"
