"""Pydantic schemas for the BHUVAN terrain analysis API.

Defines the strict request/response contracts used by every endpoint:
analysis requests (bounding box or preset mission terrain), job status
polling payloads with human-readable pipeline stages, and the full
analysis result (layer grids, per-layer statistics, ranked landing zones).

All numeric bounds are validated here so nothing malformed ever reaches
the Celery worker or the NumPy pipeline.
"""

from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, model_validator

MAX_LAT_SPAN_DEG: float = 5.0
MAX_LON_SPAN_DEG: float = 5.0


class Body(str, Enum):
    """Celestial body whose terrain is being analyzed."""

    EARTH = "earth"
    MOON = "moon"
    MARS = "mars"


class JobStage(str, Enum):
    """Human-readable pipeline stages, surfaced verbatim in the UI."""

    QUEUED = "Queued"
    FETCHING_DEM = "Fetching elevation data..."
    COMPUTING_SLOPE = "Computing slope..."
    COMPUTING_ROUGHNESS = "Computing roughness..."
    COMPUTING_CURVATURE = "Computing curvature..."
    SCORING_HAZARD = "Scoring hazards..."
    RANKING_ZONES = "Ranking landing zones..."
    COMPLETE = "Complete"
    FAILED = "Failed"


class BoundingBox(BaseModel):
    """Geographic bounding box in decimal degrees (WGS84 / body-fixed)."""

    min_lat: float = Field(..., ge=-90.0, le=90.0)
    min_lon: float = Field(..., ge=-180.0, le=180.0)
    max_lat: float = Field(..., ge=-90.0, le=90.0)
    max_lon: float = Field(..., ge=-180.0, le=180.0)

    @model_validator(mode="after")
    def _check_ordering(self) -> "BoundingBox":
        if self.min_lat >= self.max_lat:
            raise ValueError("min_lat must be strictly less than max_lat")
        if self.min_lon >= self.max_lon:
            raise ValueError("min_lon must be strictly less than max_lon")
        return self

    def as_tuple(self) -> tuple[float, float, float, float]:
        """Return (min_lat, min_lon, max_lat, max_lon) for the analysis layer."""
        return (self.min_lat, self.min_lon, self.max_lat, self.max_lon)


class AnalysisRequest(BaseModel):
    """Input to POST /analyze.

    Exactly one of `bbox` (free coordinate selection on the globe) or
    `preset_id` (preloaded mission terrain) must be provided.
    """

    body: Body = Body.EARTH
    bbox: Optional[BoundingBox] = None
    preset_id: Optional[str] = None
    rover_radius_m: float = Field(
        2.5, gt=0.0, le=50.0, description="Lander/rover footprint radius in meters"
    )
    grid_resolution_m: float = Field(
        30.0, gt=0.0, le=500.0, description="Ground distance per DEM cell in meters"
    )
    grid_size: int = Field(
        200, ge=32, le=512, description="DEM grid dimension for bbox requests (NxN)"
    )

    @model_validator(mode="after")
    def _check_target(self) -> "AnalysisRequest":
        if (self.bbox is None) == (self.preset_id is None):
            raise ValueError("provide exactly one of 'bbox' or 'preset_id'")
        if self.bbox is not None:
            if self.bbox.max_lat - self.bbox.min_lat > MAX_LAT_SPAN_DEG:
                raise ValueError(f"bbox latitude span exceeds {MAX_LAT_SPAN_DEG} deg")
            if self.bbox.max_lon - self.bbox.min_lon > MAX_LON_SPAN_DEG:
                raise ValueError(f"bbox longitude span exceeds {MAX_LON_SPAN_DEG} deg")
        return self


class LandingZone(BaseModel):
    """One ranked candidate landing zone."""

    rank: int = Field(..., ge=1)
    row: int = Field(..., ge=0, description="Pixel row in the analysis grid")
    col: int = Field(..., ge=0, description="Pixel column in the analysis grid")
    lat: float = Field(..., ge=-90.0, le=90.0)
    lon: float = Field(..., ge=-180.0, le=180.0)
    safety_score: float = Field(
        ..., ge=0.0, le=1.0, description="Worst-case safety inside the rover footprint"
    )


class LayerStats(BaseModel):
    """Summary statistics for one analysis layer."""

    min: float
    max: float
    mean: float


class AnalysisResult(BaseModel):
    """Full output of one analysis job, rendered by the frontend."""

    job_id: str
    body: Body
    preset_id: Optional[str] = None
    bbox: BoundingBox
    grid_shape: tuple[int, int] = Field(..., description="(rows, cols)")
    cell_size_m: float = Field(..., gt=0.0)
    layers: dict[str, list[list[float]]] = Field(
        ..., description="slope_deg, roughness, curvature, hazard — row-major grids"
    )
    stats: dict[str, LayerStats]
    landing_zones: list[LandingZone] = Field(..., max_length=5)


class AnalyzeResponse(BaseModel):
    """Returned immediately by POST /analyze (202 Accepted)."""

    job_id: str
    status_url: str


class JobStatusResponse(BaseModel):
    """Returned by GET /status/{job_id} while the frontend polls."""

    job_id: str
    state: str = Field(..., description="Celery state: PENDING/PROGRESS/SUCCESS/FAILURE")
    stage: JobStage
    progress: float = Field(..., ge=0.0, le=1.0)
    result: Optional[AnalysisResult] = None
    error: Optional[str] = None


class PresetInfo(BaseModel):
    """One preloaded mission terrain, listed by GET /presets."""

    id: str
    name: str
    body: Body
    bbox: BoundingBox
    cell_size_m: float
    dataset: str
    description: str


if __name__ == "__main__":
    from pydantic import ValidationError

    # Valid preset request round-trips through JSON.
    req = AnalysisRequest(preset_id="jezero_crater", body=Body.MARS, rover_radius_m=2.5)
    restored = AnalysisRequest.model_validate(req.model_dump(mode="json"))
    assert restored.preset_id == "jezero_crater"
    assert restored.bbox is None

    # Valid bbox request.
    bbox_req = AnalysisRequest(
        bbox=BoundingBox(min_lat=17.0, min_lon=74.8, max_lat=17.4, max_lon=75.2)
    )
    assert bbox_req.preset_id is None

    # Rejected: both targets supplied.
    try:
        AnalysisRequest(preset_id="x", bbox=bbox_req.bbox)
        raise AssertionError("expected ValidationError for bbox+preset")
    except ValidationError:
        pass

    # Rejected: neither target supplied.
    try:
        AnalysisRequest()
        raise AssertionError("expected ValidationError for empty target")
    except ValidationError:
        pass

    # Rejected: inverted bbox.
    try:
        BoundingBox(min_lat=20.0, min_lon=10.0, max_lat=10.0, max_lon=20.0)
        raise AssertionError("expected ValidationError for inverted bbox")
    except ValidationError:
        pass

    # Rejected: bbox span too large.
    try:
        AnalysisRequest(
            bbox=BoundingBox(min_lat=0.0, min_lon=0.0, max_lat=20.0, max_lon=1.0)
        )
        raise AssertionError("expected ValidationError for oversized span")
    except ValidationError:
        pass

    # Landing zone bounds enforced.
    try:
        LandingZone(rank=1, row=0, col=0, lat=0.0, lon=0.0, safety_score=1.5)
        raise AssertionError("expected ValidationError for safety_score > 1")
    except ValidationError:
        pass

    print("schemas/terrain.py: all tests passed")
