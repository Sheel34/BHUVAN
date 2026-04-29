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
    data: list[float]


class AnalysisLayers(BaseModel):
    slope: list[float]
    roughness: list[float]
    curvature: list[float]
    shadow: list[float]
    hazard: list[float]
    traversability: list[float]


class ZoneComponents(BaseModel):
    slope_pct: float
    roughness_pct: float
    curvature_pct: float
    shadow_pct: float


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


class AnalysisPayload(BaseModel):
    api_version: str = "1.0"
    metadata: TerrainMeta
    terrain: TerrainGrid
    layers: AnalysisLayers
    landing_zones: list[LandingZone]
