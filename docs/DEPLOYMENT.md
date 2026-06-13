# BHUVAN — Deployment Guide & Checklist

Split deploy: **static frontend** (Vercel/Netlify) + **FastAPI backend**
(Render/Railway/Fly). SQLite workspace persists on the backend host disk.

---

## Chosen stack: Vercel (frontend) + Railway (backend + Redis)

Config files are in the repo: `vercel.json` (root), `backend/railway.json`,
`backend/Procfile`, `backend/.python-version`. Redis is OPTIONAL — the live
`/api/v1/analyze` path is synchronous; Redis only powers the async `/jobs`
queue, so the app boots and works without it.

### Railway — backend
1. New Project → Deploy from GitHub repo → pick `Sheel34/BHUVAN`.
2. Service → Settings → **Root Directory = `backend`** (so it finds
   `requirements.txt` + `railway.json` + `Procfile`).
3. (Optional) Add the **Redis** plugin to the project.
4. Service → Variables:
   - `BHUVAN_CORS_ORIGINS` = your Vercel URL (e.g. `https://bhuvan.vercel.app`)
   - `BHUVAN_WORKSPACE_DB` = `/data/workspace.db`  *(add a Volume mounted at `/data`)*
   - `BHUVAN_MOON_CACHE` = `/data/moon`
   - `BHUVAN_REDIS_URL` = `${{Redis.REDIS_URL}}`  *(only if Redis plugin added)*
5. Deploy → confirm `GET /health` → `{"status":"ok"}`.
6. Warm globe textures once: `POST /api/v1/moon/textures/download`.

### Vercel — frontend
1. New Project → import `Sheel34/BHUVAN` (root = repo root; `vercel.json`
   sets build = `npm run build`, output = `dist`, framework = vite).
2. Environment Variable: `VITE_API_BASE` = the Railway backend URL
   (must be set BEFORE the build — Vite inlines it). **No trailing slash**
   (e.g. `https://bhuvan-api-production-3c0b.up.railway.app`, not `...app/`).
3. Deploy. Custom `bhuvan` domain → add it under Vercel → Domains (needs
   DNS you control); otherwise you get `bhuvan-*.vercel.app`.

### CLI alternative (if you give tokens)
With `VERCEL_TOKEN` (+ `RAILWAY_TOKEN`) exported, these can run headless:
`npx vercel deploy --prod --token $VERCEL_TOKEN` and `railway up` from `backend/`.

---

## Architecture at deploy time

```
[ Browser ]  --HTTPS-->  [ Static frontend (Vercel) ]
     |
     |  fetch VITE_API_BASE
     v
[ FastAPI backend (Render) ]  --reads-->  workspace.db (disk)
                              --serves-->  /moon-assets, /artifacts (disk)
```

- **torch / CUDA is optional.** The API works without it (AI enhancement
  is gated behind `model_available()`). Cloud hosts rarely give a GPU —
  deploy CPU-only; keep GPU inference local.
- **NVML telemetry** (`/api/v1/system/stats`) returns CPU/RAM only on a
  GPU-less host; the SystemMonitor panel degrades gracefully.

---

## Environment configuration

### Frontend (`.env.production`)
```
VITE_API_BASE=https://bhuvan-api.onrender.com
```

### Backend (host env vars)
```
BHUVAN_CORS_ORIGINS=https://bhuvan.vercel.app   # comma-separated for multiple
BHUVAN_WORKSPACE_DB=/data/workspace.db            # persistent disk path
BHUVAN_MOON_CACHE=/data/moon                      # texture cache on persistent disk
```

---

## Backend deploy (Render example)

- **Build:** `pip install -r backend/requirements.txt`
- **Start:** `uvicorn main:app --host 0.0.0.0 --port $PORT` (working dir `backend/`)
- **Disk:** attach a persistent disk mounted at `/data` (workspace.db + moon cache survive restarts)
- **First-boot textures:** the globe calls `POST /api/v1/moon/textures/download`
  on demand (~14 MB from NASA SVS). To avoid first-visitor lag, hit that
  endpoint once after deploy, or bake the two JPEGs into the image.

CPU-only requirements install (no torch line needed — it's commented out).

---

## Frontend deploy (Vercel example)

- **Build:** `npm run build`  → outputs `dist/`
- **Output dir:** `dist`
- **Env:** set `VITE_API_BASE` to the backend URL (build-time, must be set before build)
- Verified: `npm run build` produces a working bundle (~310 KB gzipped).

---

## Deploy Checklist: BHUVAN v1

### Pre-Deploy
- [x] Backend tests passing (`pytest` — 31 passed)
- [x] Production frontend build succeeds (`npm run build`)
- [x] `scipy` added to requirements (intelligence module dependency)
- [x] CORS reads production origins from `BHUVAN_CORS_ORIGINS`
- [ ] `VITE_API_BASE` set in frontend host to the live backend URL
- [ ] `BHUVAN_CORS_ORIGINS` set in backend host to the live frontend URL
- [ ] Persistent disk attached; `BHUVAN_WORKSPACE_DB` / `BHUVAN_MOON_CACHE` point to it
- [ ] `output/`, `data_cache/`, `workspace.db`, venvs confirmed git-ignored
- [ ] Secrets: none required today (no auth/keys) — confirm before adding any

### Deploy
- [ ] Deploy backend; hit `GET /health` → `{"status":"ok"}`
- [ ] Warm textures: `POST /api/v1/moon/textures/download`
- [ ] Deploy frontend pointed at backend
- [ ] Smoke test: globe loads → select Shackleton → survey runs → report exports

### Post-Deploy
- [ ] Verify `GET /api/v1/system/stats` returns (GPU block null on cloud is fine)
- [ ] Confirm a report `.md` downloads and a print-to-PDF renders
- [ ] Tag release, update changelog

### Rollback Triggers
- `/health` non-200 after deploy
- Analyze endpoint 5xx on a known-good sample
- Globe renders but workspace analysis never returns (texture/DEM path issue)

---

## Known limits (be honest in demos)
- 512² analysis payload is ~33 MB JSON — fine on localhost/good network,
  heavy on mobile data. Artifact-texture path exists for optimization.
- Three.js bundle is ~1.1 MB (310 KB gzipped) in one chunk — code-split later.
- Real high-res DEMs (LOLA 5 m polar) are 1–2 GB and are NOT bundled; they
  download on demand and need disk + bandwidth headroom.
