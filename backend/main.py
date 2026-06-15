from __future__ import annotations

import logging
import os
import tempfile
import uuid
from typing import Annotated, Callable, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from pipeline.artifacts import write_analysis_artifacts
from pipeline.ingest import generate_sample, ingest_geotiff, ingest_image_bytes
from pipeline.intelligence import build_intelligence
from pipeline.landing_zones import rank_landing_zones
from pipeline.schemas import (
    AnalysisLayers,
    AnalysisPayload,
    LandingZone,
    TerrainGrid,
    TerrainMeta,
)
from pipeline.terrain_analysis import analyze_terrain

logger = logging.getLogger(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.environ.get("BHUVAN_OUTPUT_DIR", os.path.join(BASE_DIR, "outputs"))
os.makedirs(OUTPUT_DIR, exist_ok=True)

API_VERSION = "1.1"
SAMPLE_REGISTRY = {
    # Procedural analogues (always available, no download required)
    "mars-jezero": {"label": "Jezero Crater", "sublabel": "Mars · analogue", "source": "bundled-procedural", "body": "mars"},
    "moon-south-pole": {
        "label": "Lunar South Pole",
        "sublabel": "Moon · analogue",
        "source": "bundled-procedural",
        "body": "moon",
    },
    "mars-gale": {"label": "Gale Crater", "sublabel": "Mars · analogue", "source": "bundled-procedural", "body": "mars"},
    "moon-shackleton": {
        "label": "Shackleton Crater",
        "sublabel": "Moon · analogue",
        "source": "bundled-procedural",
        "body": "moon",
    },
    "moon-tycho": {
        "label": "Tycho Crater",
        "sublabel": "Moon · analogue",
        "source": "bundled-procedural",
        "body": "moon",
    },
    "moon-mare-tranquillitatis": {
        "label": "Mare Tranquillitatis",
        "sublabel": "Apollo 11 region · analogue",
        "source": "bundled-procedural",
        "body": "moon",
    },
    # Real lunar LOLA DEMs (require download first — large files)
    "lola-south-pole-87s": {
        "label": "Lunar South Pole",
        "sublabel": "LOLA 5 m · real elevation",
        "source": "lola-dem",
        "body": "moon",
        "lola_id": "lola-south-pole-87s",
    },
    # Real HiRISE DTMs (require download first)
    "hirise-jezero-delta": {
        "label": "Jezero Delta",
        "sublabel": "HiRISE · real elevation",
        "source": "hirise-dtm",
        "body": "mars",
        "hirise_id": "jezero-delta",
    },
    "hirise-gale-msl": {
        "label": "Gale Crater",
        "sublabel": "HiRISE · real elevation",
        "source": "hirise-dtm",
        "body": "mars",
        "hirise_id": "gale-msl-landing",
    },
    "hirise-nili-fossae": {
        "label": "Nili Fossae",
        "sublabel": "HiRISE · real elevation",
        "source": "hirise-dtm",
        "body": "mars",
        "hirise_id": "nili-fossae",
    },
}

class AnalyzeRequest(BaseModel):
    sample: str
    ai_enhance: bool = False  # Whether to apply AI DEM enhancement


class DemRequest(BaseModel):
    lat: float
    lon: float
    zoom: int = 12


class TercomRequest(BaseModel):
    lat: float
    lon: float
    zoom: int = 12
    launch: Optional[list[float]] = None   # [nx, nz] render fractions
    target: Optional[list[float]] = None
    params: Optional[dict] = None


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


def apply_ai_enhancement(elevation_grid, metadata: dict):
    """Run the Terrain GAN on the elevation grid, or fail loudly (501) when
    the model is unavailable — never silently return unenhanced data the
    caller believes is AI-processed."""
    from ai.runtime import enhance_elevation, model_available

    available, reason = model_available()
    if not available:
        raise HTTPException(
            status_code=501,
            detail=ErrorDetail(code="MODEL_UNAVAILABLE", message=reason).model_dump(),
        )

    enhanced = enhance_elevation(elevation_grid)
    metadata = {
        **metadata,
        "grid_size": int(enhanced.shape[0]),
        "source": f"{metadata['source']}+ai-enhanced",
        "disclaimer": (
            (metadata.get("disclaimer") or "")
            + " Elevation refined by Terrain GAN; treat as estimate, not survey data."
        ).strip(),
    }
    return enhanced, metadata


def build_payload(
    elevation_grid,
    metadata: dict,
    progress: Callable[[str, int], None] | None = None,
    job_id: str | None = None,
) -> AnalysisPayload:
    """Run full analysis. ``progress(stage, pct)`` is invoked at each stage
    boundary so async job runners can publish status (no-op for sync API).
    ``job_id`` keys the artifact directory; defaults to a fresh UUID."""
    notify = progress or (lambda stage, pct: None)
    world_scale_m = metadata.get("world_scale_m", 200.0)
    height_scale_m = metadata.get("height_scale_m", 30.0)
    size = int(elevation_grid.shape[0])
    cell_size_m = metadata.get("resolution_m_per_px", world_scale_m / (size - 1))

    elevation_m = elevation_grid * height_scale_m

    notify("Computing hazard layers", 30)
    # analyze_terrain expects metres — passing the normalised [0,1] grid
    # collapses every slope to ~0° and reports all terrain as safe.
    layers = analyze_terrain(elevation_m, cell_size_m=cell_size_m)

    notify("Ranking landing zones", 60)
    landing_zones: list[LandingZone] = rank_landing_zones(
        elevation_m, layers, scale_m=world_scale_m
    )

    notify("Deriving terrain intelligence", 75)
    intelligence = build_intelligence(elevation_m, layers, scale_m=world_scale_m)

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

    notify("Writing artifacts", 85)
    job_id = job_id or uuid.uuid4().hex
    try:
        artifacts = write_analysis_artifacts(job_id, elevation_m, layers, OUTPUT_DIR)
    except OSError as exc:
        # Texture artifacts are an optimisation; a full JSON payload still works.
        logger.warning("Artifact write failed for job %s: %s", job_id, exc)
        artifacts = None

    payload = AnalysisPayload(
        api_version=API_VERSION,
        job_id=job_id,
        metadata=terrain_meta,
        terrain=terrain_grid,
        layers=_layers_to_schema(layers),
        landing_zones=landing_zones,
        intelligence=intelligence,
        artifacts=artifacts,
    )

    try:
        from workspace.store import save_analysis

        save_analysis(payload)
    except Exception as exc:  # noqa: BLE001 — persistence must never break analysis
        logger.warning("Workspace save failed for job %s: %s", job_id, exc)

    return payload

app = FastAPI(
    title="BHUVAN Terrain Intelligence API",
    version=API_VERSION,
    description="Backend-first terrain risk assessment and landing decision support.",
)

app.mount("/artifacts", StaticFiles(directory=OUTPUT_DIR), name="artifacts")

# Moon globe textures (CGI Moon Kit cache) served as static assets.
from data.lroc_downloader import DATA_CACHE_DIR as MOON_CACHE_DIR  # noqa: E402

MOON_TEXTURE_DIR = MOON_CACHE_DIR / "textures"
MOON_TEXTURE_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/moon-assets", StaticFiles(directory=str(MOON_TEXTURE_DIR)), name="moon-assets")

from jobs.routes import router as jobs_router  # noqa: E402 — needs OUTPUT_DIR defined

app.include_router(jobs_router)

# Dev defaults plus any production origins supplied via env
# (BHUVAN_CORS_ORIGINS="https://app.example.com,https://www.example.com").
_DEFAULT_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]
_env_origins = [o.strip() for o in os.environ.get("BHUVAN_CORS_ORIGINS", "").split(",") if o.strip()]
# Any Vercel deployment of this project (bhuvanspace, bhuvan-terrain, preview
# URLs, …) is allowed without re-deploying the backend on every domain rename.
# Custom (non-vercel.app) domains must still be added via BHUVAN_CORS_ORIGINS.
_VERCEL_ORIGIN_REGEX = r"https://([a-z0-9-]+\.)*vercel\.app"
app.add_middleware(
    CORSMiddleware,
    allow_origins=_DEFAULT_ORIGINS + _env_origins,
    allow_origin_regex=_VERCEL_ORIGIN_REGEX,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@app.get("/api/v1/samples")
def get_samples():
    """List all available terrain samples (procedural + real HiRISE DTMs)."""
    samples = []
    for sid, info in SAMPLE_REGISTRY.items():
        entry = {
            "id": sid,
            "label": info["label"],
            "sublabel": info.get("sublabel", ""),
            "source": info["source"],
            "body": info.get("body", "mars"),
        }
        # Check if real-data samples are cached locally
        if info["source"] == "hirise-dtm":
            try:
                from data.hirise_downloader import get_cache_path
                entry["cached"] = get_cache_path(info["hirise_id"]).exists()
            except Exception:
                entry["cached"] = False
        elif info["source"] == "lola-dem":
            try:
                from data.lroc_downloader import get_dem_cache_path
                entry["cached"] = get_dem_cache_path(info["lola_id"]).exists()
            except Exception:
                entry["cached"] = False
        else:
            entry["cached"] = True  # Procedural samples are always available

        # Real-data samples need a multi-GB download; listing an uncached
        # one produces a button that 404s. Only surface usable samples.
        if entry["cached"]:
            samples.append(entry)

    return {
        "api_version": API_VERSION,
        "samples": samples,
    }


from workspace.store import init_db as _init_workspace_db  # noqa: E402

_init_workspace_db()


@app.get("/api/v1/workspace/analyses")
def workspace_analyses():
    """Persistent analysis history (newest first)."""
    from workspace.store import list_analyses

    return {"api_version": API_VERSION, "analyses": list_analyses()}


@app.post("/api/v1/workspace/reports/{job_id}/{kind}")
def workspace_generate_report(job_id: str, kind: str):
    """Render + persist a report for a stored analysis."""
    from workspace.reports import render_report
    from workspace.store import get_analysis, save_report

    record = get_analysis(job_id)
    if record is None:
        raise HTTPException(
            status_code=404,
            detail=ErrorDetail(
                code="ANALYSIS_NOT_FOUND",
                message=f"No stored analysis with job_id '{job_id}'.",
            ).model_dump(),
        )
    try:
        markdown = render_report(record, kind)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail=ErrorDetail(code="REPORT_FAILED", message=str(exc)).model_dump(),
        )
    report_id = save_report(job_id, kind, markdown)
    return {
        "api_version": API_VERSION,
        "report_id": report_id,
        "job_id": job_id,
        "kind": kind,
        "markdown": markdown,
    }


@app.get("/api/v1/workspace/reports/{job_id}")
def workspace_list_reports(job_id: str):
    from workspace.store import list_reports

    return {"api_version": API_VERSION, "reports": list_reports(job_id)}


@app.get("/api/v1/system/specs")
def get_system_specs():
    """Static machine description (CPU/RAM/GPU model)."""
    from system.telemetry import get_static_specs

    return {"api_version": API_VERSION, **get_static_specs()}


@app.get("/api/v1/system/stats")
def get_system_stats():
    """Live hardware load: CPU %, RAM, GPU util/VRAM/temp/power (NVML)."""
    from system.telemetry import get_live_stats

    return {"api_version": API_VERSION, **get_live_stats()}


@app.get("/api/v1/moon/textures")
def get_moon_textures():
    """Globe texture status. Frontend uses the returned URLs for the hero moon."""
    from data.lroc_downloader import (
        DEFAULT_TEXTURE_SET,
        GLOBE_TEXTURES,
        get_texture_path,
        list_globe_textures,
    )

    textures = list_globe_textures()
    ready = all(get_texture_path(t).exists() for t in DEFAULT_TEXTURE_SET)

    urls = {}
    for tex_id in DEFAULT_TEXTURE_SET:
        info = GLOBE_TEXTURES[tex_id]
        if get_texture_path(tex_id).exists():
            urls[info["kind"]] = f"/moon-assets/{info['filename']}"

    return {
        "api_version": API_VERSION,
        "ready": ready,
        "urls": urls,
        "catalog": textures,
    }


@app.post("/api/v1/moon/textures/download")
def download_moon_textures():
    """Fetch the default globe texture set (~14 MB total) from NASA SVS."""
    from data.lroc_downloader import ensure_default_textures

    try:
        paths = ensure_default_textures()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=502,
            detail=ErrorDetail(code="DOWNLOAD_FAILED", message=str(exc)).model_dump(),
        )
    return {
        "api_version": API_VERSION,
        "status": "downloaded",
        "textures": {k: str(v) for k, v in paths.items()},
    }


@app.get("/api/v1/lola-catalog")
def get_lola_catalog():
    """List curated lunar LOLA DEMs with download status."""
    from data.lroc_downloader import list_curated_dems

    return {
        "api_version": API_VERSION,
        "dems": list_curated_dems(),
    }


@app.post("/api/v1/lola-download/{dem_id}")
def download_lola_dem(dem_id: str):
    """Download a lunar LOLA DEM (warning: polar mosaics are 1-2 GB)."""
    from data.lroc_downloader import download_dem

    try:
        path = download_dem(dem_id)
        return {
            "api_version": API_VERSION,
            "status": "downloaded",
            "dem_id": dem_id,
            "path": str(path),
            "size_mb": round(path.stat().st_size / 1e6, 1),
        }
    except ValueError as exc:
        raise HTTPException(
            status_code=404,
            detail=ErrorDetail(code="UNKNOWN_DEM", message=str(exc)).model_dump(),
        )
    except RuntimeError as exc:
        raise HTTPException(
            status_code=502,
            detail=ErrorDetail(code="DOWNLOAD_FAILED", message=str(exc)).model_dump(),
        )


@app.get("/api/v1/hirise-catalog")
def get_hirise_catalog():
    """List available HiRISE DTMs with download status."""
    try:
        from data.hirise_downloader import list_curated_dtms
        return {
            "api_version": API_VERSION,
            "dtms": list_curated_dtms(),
        }
    except ImportError:
        raise HTTPException(
            status_code=501,
            detail=ErrorDetail(
                code="HIRISE_MODULE_MISSING",
                message="HiRISE downloader module not available.",
            ).model_dump(),
        )


@app.post("/api/v1/hirise-download/{dtm_id}")
def download_hirise_dtm(dtm_id: str):
    """Download a HiRISE DTM from AWS (can take several minutes)."""
    try:
        from data.hirise_downloader import download_dtm
        path = download_dtm(dtm_id)
        return {
            "api_version": API_VERSION,
            "status": "downloaded",
            "dtm_id": dtm_id,
            "path": str(path),
            "size_mb": round(path.stat().st_size / 1e6, 1),
        }
    except ValueError as exc:
        raise HTTPException(
            status_code=404,
            detail=ErrorDetail(code="UNKNOWN_DTM", message=str(exc)).model_dump(),
        )
    except RuntimeError as exc:
        raise HTTPException(
            status_code=502,
            detail=ErrorDetail(code="DOWNLOAD_FAILED", message=str(exc)).model_dump(),
        )


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

    sample_info = SAMPLE_REGISTRY[request.sample]

    # Route to appropriate data source
    if sample_info["source"] == "hirise-dtm":
        # Load real HiRISE DTM data
        try:
            from data.hirise_downloader import load_dtm_as_numpy
            hirise_id = sample_info["hirise_id"]
            elevation, metadata = load_dtm_as_numpy(hirise_id, target_size=512)
        except FileNotFoundError:
            raise HTTPException(
                status_code=404,
                detail=ErrorDetail(
                    code="DTM_NOT_CACHED",
                    message=(
                        f"HiRISE DTM '{sample_info['hirise_id']}' not downloaded. "
                        f"Call POST /api/v1/hirise-download/{sample_info['hirise_id']} first."
                    ),
                ).model_dump(),
            )
        except ImportError:
            raise HTTPException(
                status_code=501,
                detail=ErrorDetail(
                    code="HIRISE_MODULE_MISSING",
                    message="HiRISE downloader not available. Install rasterio.",
                ).model_dump(),
            )
    elif sample_info["source"] == "lola-dem":
        # Load real lunar LOLA DEM data
        try:
            from data.lroc_downloader import load_dem_as_numpy
            lola_id = sample_info["lola_id"]
            elevation, metadata = load_dem_as_numpy(lola_id, target_size=512)
        except FileNotFoundError:
            raise HTTPException(
                status_code=404,
                detail=ErrorDetail(
                    code="DEM_NOT_CACHED",
                    message=(
                        f"Lunar DEM '{sample_info['lola_id']}' not downloaded. "
                        f"Call POST /api/v1/lola-download/{sample_info['lola_id']} first."
                    ),
                ).model_dump(),
            )
        except ImportError:
            raise HTTPException(
                status_code=501,
                detail=ErrorDetail(
                    code="LOLA_MODULE_MISSING",
                    message="Lunar downloader not available. Install rasterio.",
                ).model_dump(),
            )
    else:
        # Original procedural generation
        elevation, metadata = generate_sample(request.sample)

    if request.ai_enhance:
        elevation, metadata = apply_ai_enhancement(elevation, metadata)

    return build_payload(elevation, metadata)


@app.post("/api/v1/dem/fetch", response_model=AnalysisPayload)
def dem_fetch(req: DemRequest):
    """Fetch a REAL DEM (AWS Terrain Tiles / SRTM+Copernicus) for a lat/lon and
    run it through the full analysis pipeline. The accurate-terrain path."""
    from data.dem_fetch import fetch_dem

    try:
        elevation, metadata = fetch_dem(req.lat, req.lon, req.zoom)
    except Exception as exc:  # noqa: BLE001 — surface any fetch/decoding failure
        raise HTTPException(
            status_code=502,
            detail=ErrorDetail(code="DEM_FETCH_FAILED", message=f"Could not fetch DEM: {exc}").model_dump(),
        ) from exc

    return build_payload(elevation, metadata)


@app.post("/api/v1/tercom/run")
def tercom_run(req: TercomRequest):
    """Run the TERCOM guidance simulation on a real DEM for this lat/lon.
    Returns trajectory + fix events + verdict (HIT/MISS/CFIT/LOST)."""
    from data.dem_fetch import fetch_dem
    from pipeline.tercom import simulate_tercom

    try:
        norm, meta = fetch_dem(req.lat, req.lon, req.zoom)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=502,
            detail=ErrorDetail(code="DEM_FETCH_FAILED", message=f"Could not fetch DEM: {exc}").model_dump(),
        ) from exc

    elev_m = norm * meta["height_scale_m"]
    size = int(elev_m.shape[0])
    cell_m = meta["resolution_m_per_px"]

    def to_grid(pt, default):
        nx, nz = pt if (pt and len(pt) == 2) else default
        return ((nz + 0.5) * (size - 1), (nx + 0.5) * (size - 1))  # (gx=col, gy=row)

    launch = to_grid(req.launch, [-0.46, -0.46])
    target = to_grid(req.target, [0.46, 0.46])

    result = simulate_tercom(elev_m, cell_m, launch, target, req.params or {})
    result["api_version"] = API_VERSION
    result["dem"] = {
        "lat": req.lat, "lon": req.lon, "zoom": req.zoom,
        "world_scale_m": meta["world_scale_m"], "height_scale_m": meta["height_scale_m"],
    }
    return result


@app.post("/api/v1/analyze-upload", response_model=AnalysisPayload)
async def analyze_upload(file: Annotated[UploadFile, File(...)]):
    content = await file.read()
    if len(content) < 64:
        raise HTTPException(
            status_code=400,
            detail=ErrorDetail(code="FILE_TOO_SMALL", message="File appears empty.").model_dump(),
        )
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(
            status_code=413,
            detail=ErrorDetail(code="FILE_TOO_LARGE", message="Maximum upload is 50 MB.").model_dump(),
        )

    ct = (file.content_type or "").lower()
    filename = (file.filename or "").lower()
    is_tiff = ct in {"image/tiff", "image/x-tiff"} or filename.endswith((".tif", ".tiff"))

    # ── GeoTIFF: the only path that can load a REAL area — it carries CRS +
    #    bounds, so the surface is georeferenced to true coordinates. ──
    if is_tiff:
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".tif") as tmp:
                tmp.write(content)
                tmp_path = tmp.name
            try:
                elevation, metadata = ingest_geotiff(tmp_path)
            finally:
                os.remove(tmp_path)
        except ValueError as exc:
            raise HTTPException(
                status_code=422,
                detail=ErrorDetail(code="INGEST_FAILED", message=str(exc)).model_dump(),
            ) from exc
        return build_payload(elevation, metadata)

    # ── Plain image: accept ANY decodable image (don't gate on content-type,
    #    which wrongly rejects valid terrain). Classify it; reject only clear
    #    non-terrain (selfies/logos), then treat as a heightmap. ──
    from pipeline.classify import classify_terrain_image

    try:
        verdict = classify_terrain_image(content)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail=ErrorDetail(code="INGEST_FAILED", message=str(exc)).model_dump(),
        ) from exc

    if not verdict["is_terrain"]:
        raise HTTPException(
            status_code=422,
            detail=ErrorDetail(
                code="NOT_TERRAIN",
                message=f"Not a terrain image ({verdict['reason']}). Upload surface/DEM imagery, or a georeferenced GeoTIFF for a real area.",
            ).model_dump(),
        )

    elevation, metadata = ingest_image_bytes(content)

    # Label + honest provenance by detected body.
    if verdict["is_moon"]:
        metadata["terrain_name"] = "Lunar Upload — surface image"
        metadata["source"] = "uploaded-image-moon"
        metadata["disclaimer"] = (
            "Lunar surface image detected and loaded as a heightmap. Exact "
            "selenographic location cannot be resolved from a photo — upload a "
            "georeferenced GeoTIFF for true coordinates."
        )
    elif verdict["body"] == "mars":
        metadata["terrain_name"] = "Mars Upload — surface image"
        metadata["source"] = "uploaded-image-mars"
    else:
        metadata["terrain_name"] = "Terrain Upload — image"

    return build_payload(elevation, metadata)


@app.get("/health")
def health():
    return {"status": "ok", "api_version": API_VERSION}
