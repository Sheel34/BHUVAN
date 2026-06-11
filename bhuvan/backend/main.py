"""BHUVAN FastAPI application entry point.

Single API gateway in front of the Celery/Redis analysis pipeline.
Run (from the bhuvan/ repo root, with Redis and a worker running):

    uvicorn backend.main:app --reload --port 8000

CORS is open to the local React dev servers (Vite 5173, CRA 3000).
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routes import router

ALLOWED_ORIGINS: list[str] = [
    "http://localhost:3000",
    "http://localhost:5173",
]


def create_app() -> FastAPI:
    """Build the FastAPI app with CORS and all terrain routes."""
    app = FastAPI(
        title="BHUVAN",
        version="0.1.0",
        description="Terrain hazard analysis for autonomous rover and "
        "spacecraft landing zone selection.",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router)

    @app.get("/health", tags=["meta"])
    def health() -> dict[str, str]:
        return {"status": "ok", "service": "bhuvan", "version": "0.1.0"}

    return app


app = create_app()


if __name__ == "__main__":
    from fastapi.testclient import TestClient

    client = TestClient(app)

    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["service"] == "bhuvan"

    r = client.get("/presets")
    assert r.status_code == 200 and len(r.json()) == 4

    # All three terrain routes are registered on the gateway.
    paths = {route.path for route in app.routes}
    assert {"/analyze", "/status/{job_id}", "/presets", "/health"} <= paths

    # OpenAPI schema is generated and exposes the analyze contract.
    schema = client.get("/openapi.json").json()
    assert "AnalysisRequest" in schema["components"]["schemas"]

    print("main.py: all tests passed")
