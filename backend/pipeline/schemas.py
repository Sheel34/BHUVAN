# backend/pipeline/schemas.py
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

class TerrainMeta(BaseModel):
    terrain_name: str
    source: str
    grid_size: int
    world_scale_m: float = Field(description="Side length of terrain square in metres")
    height_scale_m: float = Field(description="Vertical scale factor in metres")
    resolution_m_per_px: float = Field(description="Ground sampling distance in metres/pixel")
    safe_area_pct: float
    crs: str = "local-normalised"
    disclaimer: str | None = None

class TerrainGrid(BaseModel):
    size: int
    scale: float
    height_scale: float
    min_h: float
    max_h: float
    data: list[float] = Field(description="Row-major flattened elevation grid in metres")

class AnalysisLayers(BaseModel):
    slope: list[float]
    roughness: list[float]
    curvature: list[float]
    shadow: list[float]
    hazard: list[float]
    traversability: list[float]

class LayerArtifact(BaseModel):
    """GPU-ready texture artifact. Pixel 0 maps to min_val, max pixel to max_val."""
    url: str = Field(description="Relative URL under the /artifacts static mount")
    min_val: float
    max_val: float

class ArtifactBundle(BaseModel):
    """Additive texture representation of the analysis (16-bit heightmap + 8-bit layers)."""
    heightmap: LayerArtifact
    layers: dict[str, LayerArtifact]

class ZoneComponents(BaseModel):
    slope_pct: float
    roughness_pct: float
    curvature_pct: float
    shadow_pct: float

class ZoneUncertainty(BaseModel):
    score_ci_lower: float = Field(description="Lower 95% confidence bound for score")
    score_ci_upper: float = Field(description="Upper 95% confidence bound for score")
    hazard_ci_lower: float = Field(description="Lower 95% confidence bound for hazard")
    hazard_ci_upper: float = Field(description="Upper 95% confidence bound for hazard")
    traversability_ci_lower: float = Field(description="Lower 95% confidence bound for traversability")
    traversability_ci_upper: float = Field(description="Upper 95% confidence bound for traversability")
    bootstrap_samples: int = Field(description="Number of bootstrap samples used")

class LandingZone(BaseModel):
    id: str
    x: float
    z: float
    y: float
    radius_m: float
    score: float
    classification: Literal["safe", "caution", "unsafe"]
    patch_area_px: int
    min_hazard_in_patch: float
    mean_hazard_in_patch: float
    confidence: float
    components: ZoneComponents
    uncertainty: ZoneUncertainty | None = None

class AnalysisPayload(BaseModel):
    api_version: str = "1.0"
    job_id: str | None = None
    metadata: TerrainMeta
    terrain: TerrainGrid
    layers: AnalysisLayers
    landing_zones: list[LandingZone]
    artifacts: ArtifactBundle | None = None