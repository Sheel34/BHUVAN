# BHUVAN

Real-time terrain hazard analysis for planetary and terrestrial autonomous landing systems. Select a region on a 3D globe (Earth / Moon / Mars) or a preset mission terrain; BHUVAN computes slope, surface roughness, curvature, a composite hazard score, and ranks the five safest landing zones — rendered as a 3D mesh with toggleable hazard overlays and an exportable mission report.

Born from the Chandrayaan-2 Vikram lander crash: terrain killed the mission, and terrain is analyzable.

## Architecture

```
React + deck.gl globe ──POST /analyze──▶ FastAPI gateway ──▶ Redis ◀── Celery worker
        ▲                                     │                            │
        └────────── poll /status/{job_id} ◀───┘          NumPy/SciPy pipeline
                                                 slope → roughness → curvature
Three.js mesh + hazard overlay ◀── result ──     → hazard score → top-5 zones
```

Patterns: message queue (Celery + Redis), API gateway (FastAPI single entry), cache-aside (deterministic DEM resolution makes repeat queries cacheable).

## Quickstart

```bash
docker compose up --build
# API on :8000 — interactive docs at http://localhost:8000/docs
```

Or manually (from repo root): install `backend/requirements.txt`, start Redis, then
`celery -A backend.tasks.celery_worker.celery_app worker --loglevel=info` (Windows: add `--pool=solo`)
and `uvicorn backend.main:app --reload`.

## API

```bash
# Preset mission terrain
curl -s -X POST localhost:8000/analyze -H 'content-type: application/json' \
  -d '{"preset_id": "jezero_crater", "rover_radius_m": 2.5}'
# → {"job_id": "...", "status_url": "/status/..."}

# Free coordinate selection
curl -s -X POST localhost:8000/analyze -H 'content-type: application/json' \
  -d '{"bbox": {"min_lat": 17.0, "min_lon": 74.8, "max_lat": 17.4, "max_lon": 75.2}, "body": "earth"}'

curl -s localhost:8000/status/<job_id>   # stage strings + progress; full result on completion
curl -s localhost:8000/presets           # jezero_crater, vikram_site, shackleton_crater, deccan_plateau
```

## Analysis math

| Layer | Method |
|---|---|
| Slope | `arctan(sqrt((dz/dx)² + (dz/dy)²))`, gradients via `numpy.gradient` scaled by cell size |
| Roughness | Std dev of elevation in a 3×3 window (`scipy.ndimage.generic_filter` + `np.std`) |
| Curvature | Laplacian of the surface (`scipy.ndimage.laplace`) |
| Hazard | `0.5·slopê + 0.3·roughnesŝ + 0.2·|curvaturê|`, each layer normalized, clipped to [0,1] |
| Landing zones | safety = 1 − hazard, `grey_erosion` with circular rover footprint (worst cell under the vehicle governs), greedy top-5 with separation suppression |

## Tests

Every module carries a self-test (synthetic 100×100 DEMs, no Redis required):

```bash
for m in backend.schemas.terrain backend.analysis.slope backend.analysis.roughness \
         backend.analysis.hazard backend.analysis.landing_zones backend.data.presets \
         backend.tasks.celery_worker backend.api.routes backend.main; do
  python -m $m || break
done
```

## Status

- **Phase 1 (this repo): backend complete.** Full pipeline, Celery/Redis queue, REST API, four preset terrains with deterministic synthetic DEMs, self-tests.
- **Phase 2:** NASA Earthdata + rasterio DEM client (single swap point: `_resolve_dem` in `backend/tasks/celery_worker.py`), React/deck.gl globe, Three.js terrain viewer, PDF mission report.

See `AGENTS.md` for the full codebase map and modification recipes.
