# AGENTS.md — BHUVAN codebase map

## What BHUVAN does

BHUVAN is a terrain intelligence platform that analyzes elevation data to find safe landing zones for autonomous rovers and spacecraft, inspired by the Chandrayaan-2 Vikram lander crash. A user selects a region on a 3D globe (Earth, Moon, or Mars) or picks a preset mission terrain; the backend fetches/builds a DEM and computes slope, roughness, curvature, a composite hazard score, and the top 5 ranked landing zones. Results render in the frontend as a 3D terrain mesh with toggleable hazard layers and an exportable mission report.

## Folder structure

```
bhuvan/
├── backend/
│   ├── main.py                    # FastAPI app entry: CORS, /health, mounts routes
│   ├── api/
│   │   └── routes.py              # POST /analyze, GET /status/{job_id}, GET /presets
│   ├── analysis/
│   │   ├── hazard.py              # curvature (laplace), normalization, weighted hazard combine, full pipeline
│   │   ├── slope.py               # slope angle via numpy.gradient: arctan(sqrt(gx²+gy²))
│   │   ├── roughness.py           # 3x3 elevation std dev via scipy generic_filter
│   │   └── landing_zones.py       # safety inversion, grey_erosion w/ rover footprint, top-5 ranking
│   ├── tasks/
│   │   └── celery_worker.py       # Celery app + analyze_terrain task with staged progress
│   ├── schemas/
│   │   └── terrain.py             # all Pydantic models: requests, status, results, presets
│   ├── data/
│   │   └── presets.py             # 4 preset mission terrains, deterministic DEM generators
│   ├── requirements.txt           # pinned Python deps
│   └── Dockerfile                 # shared image for api + worker services
├── frontend/                      # Phase 2 — React + Three.js + deck.gl + Tailwind
│   └── src/
│       ├── App.jsx                # app shell, view state, polling loop
│       └── components/
│           ├── Globe.jsx          # deck.gl globe, lat/lon bbox picking
│           ├── TerrainViewer.jsx  # Three.js DEM mesh + hazard overlay
│           ├── AnalysisPanel.jsx  # layer toggle switches, progress stages
│           └── ReportExport.jsx   # mission report PDF export
├── AGENTS.md                      # this file
├── README.md                      # human-facing overview + quickstart
└── docker-compose.yml             # redis + api + worker
```

## How to run locally

From the `bhuvan/` repo root.

**Option A — Docker (recommended):**
```bash
docker compose up --build      # redis :6379, API :8000, worker
```

**Option B — manual (three terminals):**
```bash
pip install -r backend/requirements.txt

# 1. Redis
docker run -p 6379:6379 redis:7-alpine

# 2. Celery worker (add --pool=solo on Windows)
celery -A backend.tasks.celery_worker.celery_app worker --loglevel=info

# 3. API
uvicorn backend.main:app --reload --port 8000
```

**Frontend (Phase 2):** `cd frontend && npm install && npm run dev` (Vite, :5173).

**Self-tests** (each module ships one under `if __name__ == "__main__"`, no Redis needed — Celery runs eager with an in-memory backend):
```bash
python -m backend.schemas.terrain
python -m backend.analysis.slope
python -m backend.analysis.roughness
python -m backend.analysis.hazard
python -m backend.analysis.landing_zones
python -m backend.data.presets
python -m backend.tasks.celery_worker
python -m backend.api.routes
python -m backend.main
```

**Smoke the API:**
```bash
curl -s -X POST localhost:8000/analyze -H 'content-type: application/json' \
  -d '{"preset_id": "jezero_crater"}'
curl -s localhost:8000/status/<job_id>
```

## Analysis pipeline flow (in order)

1. `api/routes.py:start_analysis` — Pydantic validates `AnalysisRequest`, queues Celery task, returns `job_id` (202).
2. `tasks/celery_worker.py:_resolve_dem` — loads preset DEM (`data/presets.py:load_preset_dem`) or synthesizes terrain for a free bbox (`synthesize_dem`; Phase 2 swaps this single call site for the NASA Earthdata + rasterio client). Stage: "Fetching elevation data...".
3. `analysis/slope.py:compute_slope` — `arctan(sqrt((dz/dx)² + (dz/dy)²))` via `numpy.gradient`, degrees.
4. `analysis/roughness.py:compute_roughness` — std dev of elevation in a 3x3 window (`scipy.ndimage.generic_filter` + `np.std`).
5. `analysis/hazard.py:compute_curvature` — Laplacian via `scipy.ndimage.laplace`.
6. `analysis/hazard.py:combine_hazard` — `0.5*norm_slope + 0.3*norm_roughness + 0.2*abs(sym_norm_curvature)`, clipped to [0,1].
7. `analysis/landing_zones.py:rank_landing_zones` — safety = 1 − hazard, `grey_erosion` with circular rover footprint, greedy top-5 centroid selection with separation suppression, pixel → lat/lon mapping.
8. Worker assembles `AnalysisResult` (layers + stats + zones), stores it in Redis; each stage above was published via Celery `PROGRESS` state with the exact UI strings.
9. `api/routes.py:get_status` — maps Celery state → `JobStatusResponse`; attaches the full result on `SUCCESS`.

## Which files to touch for…

**Adding a new analysis type (e.g., shadow/illumination):**
1. `backend/analysis/<new>.py` — new module, same shape contract (2D in → 2D float64 out), self-test at bottom.
2. `backend/analysis/hazard.py` — add a weight constant, wire into `combine_hazard` and `compute_hazard_layers` (weights must sum to 1).
3. `backend/tasks/celery_worker.py` — call it in `analyze_terrain`, add a `JobStage` publish, add the layer to `layers` dict.
4. `backend/schemas/terrain.py` — add the stage string to `JobStage`; layer dicts are open-keyed, no other change.
5. Frontend Phase 2: add a toggle in `AnalysisPanel.jsx` and a colormap in `TerrainViewer.jsx`.

**Adding a new preset terrain:**
1. `backend/data/presets.py` — add an entry to `PRESETS` (id, name, body, bbox, cell_size_m, dataset, description, terrain type, seed, params). If the morphology is new, add a generator and register it in `_GENERATORS`.
2. Nothing else — `/presets`, validation, and the worker pick it up from the registry.

**Changing a frontend layer (Phase 2):**
1. `frontend/src/components/AnalysisPanel.jsx` — toggle state and switch UI.
2. `frontend/src/components/TerrainViewer.jsx` — layer mesh/texture and colormap.
3. Layer data arrives keyed by name in `result.layers` from `/status/{job_id}` — backend changes only needed for brand-new layers (see above).

## Contracts agents must not break

- `JobStage` strings are displayed verbatim in the UI — changing them is a frontend-visible change.
- Hazard weights 0.5/0.3/0.2 and the formulas above are the spec.
- `layers` grids are row-major `list[list[float]]`, row 0 = northern edge; `pixel_to_latlon` in `landing_zones.py` is the single source of truth for geo mapping.
- All API I/O goes through `schemas/terrain.py` — never return raw dicts from routes.
- DEM acquisition has exactly one entry point: `_resolve_dem` in `celery_worker.py`.
