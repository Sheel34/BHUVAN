"""AI-enhancement integration: graceful degradation without torch/checkpoint,
plus unit tests for the pure-numpy evaluation metrics."""

import numpy as np
import pytest
from fastapi.testclient import TestClient

from ai.evaluate import evaluate_pair, high_freq_ratio, rmse, slope_mae_deg
from ai.runtime import model_available
from main import app

client = TestClient(app)

MODEL_PRESENT = model_available()[0]


@pytest.mark.skipif(MODEL_PRESENT, reason="model installed; degradation path n/a")
def test_v1_ai_enhance_unavailable_returns_501():
    response = client.post(
        "/api/v1/analyze", json={"sample": "mars-jezero", "ai_enhance": True}
    )
    assert response.status_code == 501
    assert response.json()["detail"]["code"] == "MODEL_UNAVAILABLE"


@pytest.mark.skipif(MODEL_PRESENT, reason="model installed; degradation path n/a")
def test_v2_ai_enhance_unavailable_fails_job():
    response = client.post(
        "/api/v2/jobs", json={"sample": "mars-jezero", "ai_enhance": True}
    )
    assert response.status_code == 202
    job_id = response.json()["job_id"]

    status = client.get(f"/api/v2/jobs/{job_id}").json()
    assert status["state"] == "FAILURE"
    assert status["error"]["code"] == "MODEL_UNAVAILABLE"

    # The AI job id must differ from the plain job for the same sample.
    plain = client.post("/api/v2/jobs", json={"sample": "mars-jezero"}).json()
    assert plain["job_id"] != job_id


def test_metrics_identical_dems_are_perfect():
    rng = np.random.default_rng(3)
    dem = rng.uniform(0, 30, (64, 64)).astype(np.float32)
    m = evaluate_pair(dem, dem)
    assert m["rmse"] == 0.0
    assert m["slope_mae_deg"] == 0.0
    assert m["hf_ratio"] == pytest.approx(1.0)


def test_metrics_detect_smoothing():
    """A blurred prediction must score worse on slope + lose HF energy."""
    import cv2

    rng = np.random.default_rng(9)
    target = rng.uniform(0, 30, (64, 64)).astype(np.float32)
    smoothed = cv2.GaussianBlur(target, (9, 9), 3.0)

    assert rmse(smoothed, target) > 0.0
    assert slope_mae_deg(smoothed, target) > 1.0
    assert high_freq_ratio(smoothed, target) < 0.5


def test_metrics_offset_only_hits_rmse_not_slope():
    rng = np.random.default_rng(4)
    target = rng.uniform(0, 30, (64, 64)).astype(np.float32)
    offset = target + 5.0
    assert rmse(offset, target) == pytest.approx(5.0)
    # float32 addition introduces sub-millidegree gradient noise; that's fine.
    assert slope_mae_deg(offset, target) < 1e-3
