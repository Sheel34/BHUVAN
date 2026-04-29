from __future__ import annotations

from typing import Annotated

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .pipeline.ingest import generate_sample, ingest_image_bytes
from .pipeline.landing_zones import rank_landing_zones
from .pipeline.schemas import (
    AnalysisLayers,
    AnalysisPayload,
    LandingZone,
    TerrainGrid,
    TerrainMeta,
)
from .pipeline.terrain_analysis import analyze_terrain

API_VERSION = "1.0"
SAMPLE_REGISTRY = {
    "mars-jezero": {"label": "Mars Jezero Analogue", "source": "bundled-procedural"},
    "moon-south-pole": {
        "label": "Lunar South Pole Analogue",
        "source": "bundled-procedural",
    },
    "mars-gale": {"label": "Mars Gale Crater Analogue", "source": "bundled-procedural"},
}


class AnalyzeRequest(BaseModel):
    sample: str


class ErrorDetail(BaseModel):
    code: str
    message: str
    api_version: str = API_VERSION


def _layers_to_schema(layers: dict) -> AnalysisLayers:
    def flat(key: str) -> list[float]:
        return layers[key]["data"].reshape(-1).astype(float).tolist()

    return AnalysisLayers(
        slope=flat("slope"),
        roughness=flat("roughness"),
        curvature=flat("curvature"),
        shadow=flat("shadow"),
        hazard=flat("hazard"),
        traversability=flat("traversability"),
    )


def build_payload(elevation_grid, metadata: dict) -> AnalysisPayload:
    world_scale_m = metadata.get("world_scale_m", 200.0)
    height_scale_m = metadata.get("height_scale_m", 30.0)
    size = int(elevation_grid.shape[0])
    cell_size_m = metadata.get("resolution_m_per_px", world_scale_m / (size - 1))

    elevation_m = elevation_grid * height_scale_m
    layers = analyze_terrain(elevation_grid, cell_size_m=cell_size_m)
    landing_zones: list[LandingZone] = rank_landing_zones(
        elevation_m, layers, scale_m=world_scale_m
    )

    safe_cells = float((layers["hazard"]["data"] < 0.35).sum())
    total_cells = float(layers["hazard"]["data"].size)

    terrain_meta = TerrainMeta(
        terrain_name=metadata["terrain_name"],
        source=metadata["source"],
        grid_size=size,
        world_scale_m=world_scale_m,
        height_scale_m=height_scale_m,
        resolution_m_per_px=cell_size_m,
        safe_area_pct=round((safe_cells / total_cells) * 100.0, 1),
        crs=metadata.get("crs", "local-normalised"),
        disclaimer=metadata.get("disclaimer"),
    )

    terrain_grid = TerrainGrid(
        size=size,
        scale=world_scale_m,
        height_scale=height_scale_m,
        min_h=float(elevation_m.min()),
        max_h=float(elevation_m.max()),
        data=elevation_m.reshape(-1).astype(float).tolist(),
    )

    return AnalysisPayload(
        api_version=API_VERSION,
        metadata=terrain_meta,
        terrain=terrain_grid,
        layers=_layers_to_schema(layers),
        landing_zones=landing_zones,
    )


app = FastAPI(
    title="ARES Terrain Intelligence API",
    version=API_VERSION,
    description="Backend-first terrain risk assessment and landing decision support.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@app.get("/api/v1/samples")
def get_samples():
    return {
        "api_version": API_VERSION,
        "samples": [
            {"id": sid, "label": info["label"], "source": info["source"]}
            for sid, info in SAMPLE_REGISTRY.items()
        ],
    }


@app.post("/api/v1/analyze", response_model=AnalysisPayload)
def analyze_sample(request: AnalyzeRequest):
    if request.sample not in SAMPLE_REGISTRY:
        raise HTTPException(
            status_code=404,
            detail=ErrorDetail(
                code="UNKNOWN_SAMPLE",
                message=(
                    f"Sample '{request.sample}' not in registry. Valid options: "
                    f"{list(SAMPLE_REGISTRY.keys())}"
                ),
            ).model_dump(),
        )

    elevation, metadata = generate_sample(request.sample)
    return build_payload(elevation, metadata)


@app.post("/api/v1/analyze-upload", response_model=AnalysisPayload)
async def analyze_upload(file: Annotated[UploadFile, File(...)]):
    allowed = {"image/png", "image/jpeg", "image/tiff", "image/x-tiff"}
    ct = (file.content_type or "").lower()
    if ct not in allowed:
        raise HTTPException(
            status_code=415,
            detail=ErrorDetail(
                code="UNSUPPORTED_MEDIA_TYPE",
                message=f"Received '{ct}'. Accepted: {sorted(allowed)}",
            ).model_dump(),
        )

    content = await file.read()
    if len(content) < 64:
        raise HTTPException(
            status_code=400,
            detail=ErrorDetail(
                code="FILE_TOO_SMALL",
                message="File appears empty.",
            ).model_dump(),
        )
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(
            status_code=413,
            detail=ErrorDetail(
                code="FILE_TOO_LARGE",
                message="Maximum upload is 50 MB.",
            ).model_dump(),
        )

    try:
        elevation, metadata = ingest_image_bytes(content)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail=ErrorDetail(
                code="INGEST_FAILED",
                message=str(exc),
            ).model_dump(),
        ) from exc

    return build_payload(elevation, metadata)


@app.get("/health")
def health():
    return {"status": "ok", "api_version": API_VERSION}
