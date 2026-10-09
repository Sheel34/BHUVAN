# BHUVAN

Earth/Moon terrain inspection and rover rehearsal using React, Three.js and FastAPI.

## Run locally

Use Node.js and Python 3.12. Run the backend and frontend in separate terminals.

```powershell
cd E:\storm\BHUVAN\backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
$env:BHUVAN_EAGER = '1'
.\.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000
```

```powershell
cd E:\storm\BHUVAN
npm ci
npm run dev
```

The frontend runs at http://127.0.0.1:5173/. Set `VITE_API_BASE` to use a different API origin. Deployment also requires the backend's `BHUVAN_CORS_ORIGINS` to allow the frontend origin.

For the Windows desktop launcher, install its separate runtime with `npm ci --prefix desktop`, then run `Launch BHUVAN.cmd`. It requests and verifies NVIDIA rendering; ordinary web clients use their own browser/OS graphics settings.

## Checks

```powershell
npm test
npm run build
cd backend
.\.venv\Scripts\python.exe -m pytest tests -q
```

Measured terrain requires a DEM with known scale and coverage. Image depth is estimated; offline test ranges are synthetic. Rover routes and hazard layers are research approximations, not validated vehicle safety predictions.

Asset credits: [public/textures/ATTRIBUTION.md](public/textures/ATTRIBUTION.md). Terrain results retain source and spacing metadata.
