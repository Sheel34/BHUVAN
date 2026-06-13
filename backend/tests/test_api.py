"""API contract tests for the BHUVAN terrain backend.

Covers the four frontend-facing endpoints and guards the raw-array layer
contract (terrain.data + six flat float layers) that src/lib/api.js and
src/engine/terrain.js depend on.
"""

from io import BytesIO

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from main import SAMPLE_REGISTRY, app

LAYER_KEYS = ("slope", "roughness", "curvature", "shadow", "hazard", "traversability")

PROCEDURAL_SAMPLES = sorted(
    sid for sid, info in SAMPLE_REGISTRY.items() if info["source"] == "bundled-procedural"
)
HIRISE_SAMPLES = sorted(
    sid for sid, info in SAMPLE_REGISTRY.items() if info["source"] == "hirise-dtm"
)

client = TestClient(app)


def _make_png_bytes(size: int = 96) -> bytes:
    """Grayscale gradient + bumps so the heightmap has real variation."""
    xs = np.linspace(0, 255, size, dtype=np.float32)
    grid = np.tile(xs, (size, 1))
    grid += 40.0 * np.sin(np.linspace(0, 12, size))[:, None]
    img = Image.fromarray(np.clip(grid, 0, 255).astype(np.uint8), mode="L")
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _assert_analysis_payload(payload: dict) -> None:
    size = payload["terrain"]["size"]
    n_cells = size * size

    assert payload["terrain"]["data"], "terrain.data must be a non-empty flat array"
    assert len(payload["terrain"]["data"]) == n_cells

    for key in LAYER_KEYS:
        layer = payload["layers"][key]
        assert len(layer) == n_cells, f"layer '{key}' wrong length"

    hazard = np.asarray(payload["layers"]["hazard"])
    assert hazard.min() >= 0.0 and hazard.max() <= 1.0

    assert isinstance(payload["landing_zones"], list)
    for zone in payload["landing_zones"]:
        assert zone["classification"] in {"safe", "caution", "unsafe"}
        assert zone["radius_m"] > 0
        assert {"slope_pct", "roughness_pct", "curvature_pct", "shadow_pct"} <= set(
            zone["components"]
        )


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert "api_version" in body


def test_samples_catalog():
    response = client.get("/api/v1/samples")
    assert response.status_code == 200
    samples = response.json()["samples"]
    listed = {s["id"] for s in samples}
    # Catalog lists only usable samples (procedural always; real DEMs only
    # when downloaded) so the UI never shows a button that 404s.
    assert listed.issubset(set(SAMPLE_REGISTRY))
    assert set(PROCEDURAL_SAMPLES).issubset(listed)
    for sample in samples:
        assert sample["label"] and sample["source"]
        assert sample["cached"] is True


@pytest.mark.parametrize("sample_id", PROCEDURAL_SAMPLES)
def test_analyze_sample(sample_id):
    response = client.post("/api/v1/analyze", json={"sample": sample_id})
    assert response.status_code == 200
    _assert_analysis_payload(response.json())


@pytest.mark.parametrize("sample_id", HIRISE_SAMPLES)
def test_analyze_hirise_uncached_returns_404(sample_id):
    """Real-DTM samples require an explicit download first; without the cache
    the API must fail loudly with DTM_NOT_CACHED, not 500."""
    from data.hirise_downloader import get_cache_path

    hirise_id = SAMPLE_REGISTRY[sample_id]["hirise_id"]
    if get_cache_path(hirise_id).exists():
        pytest.skip("DTM cached locally; covered by the 200 path")
    response = client.post("/api/v1/analyze", json={"sample": sample_id})
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "DTM_NOT_CACHED"


def test_analyze_returns_artifact_bundle():
    response = client.post("/api/v1/analyze", json={"sample": "mars-jezero"})
    assert response.status_code == 200
    payload = response.json()

    assert payload["job_id"]
    artifacts = payload["artifacts"]
    assert artifacts is not None

    hm = artifacts["heightmap"]
    assert hm["url"].startswith("/artifacts/")
    assert hm["max_val"] > hm["min_val"]
    assert set(artifacts["layers"]) == set(LAYER_KEYS)

    # Heightmap must be fetchable and decode as 16-bit PNG of grid size.
    img_resp = client.get(hm["url"])
    assert img_resp.status_code == 200
    img = Image.open(BytesIO(img_resp.content))
    assert img.size == (payload["terrain"]["size"],) * 2
    assert img.mode in ("I", "I;16")

    # One 8-bit overlay roundtrip: pixel values track the JSON hazard array.
    hz_resp = client.get(artifacts["layers"]["hazard"]["url"])
    assert hz_resp.status_code == 200
    hz_img = np.asarray(Image.open(BytesIO(hz_resp.content)), dtype=np.float32) / 255.0
    hz_json = np.asarray(payload["layers"]["hazard"], dtype=np.float32).reshape(hz_img.shape)
    assert np.abs(hz_img - hz_json).max() < (1.0 / 255.0) + 1e-6


def test_analyze_unknown_sample():
    response = client.post("/api/v1/analyze", json={"sample": "venus-nope"})
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "UNKNOWN_SAMPLE"


def test_analyze_upload_png():
    png = _make_png_bytes()
    response = client.post(
        "/api/v1/analyze-upload",
        files={"file": ("dem.png", png, "image/png")},
    )
    assert response.status_code == 200
    payload = response.json()
    _assert_analysis_payload(payload)
    assert payload["metadata"]["source"] == "uploaded-image"


def test_analyze_upload_rejects_bad_content_type():
    response = client.post(
        "/api/v1/analyze-upload",
        files={"file": ("notes.txt", b"not an image at all, just text bytes....", "text/plain")},
    )
    assert response.status_code == 415
    assert response.json()["detail"]["code"] == "UNSUPPORTED_MEDIA_TYPE"


def test_analyze_upload_rejects_tiny_file():
    response = client.post(
        "/api/v1/analyze-upload",
        files={"file": ("dem.png", b"tiny", "image/png")},
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "FILE_TOO_SMALL"
