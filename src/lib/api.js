import { normalizeAnalysisPayload } from '../engine/terrain';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000';
const API_V1 = `${API_BASE}/api/v1`;

class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.httpStatus = status;
  }
}

async function requestJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  } catch (err) {
    throw new ApiError('NETWORK_ERROR', `Cannot reach backend: ${err.message}`, 0);
  }

  if (!response.ok) {
    let detail = { code: 'HTTP_ERROR', message: `HTTP ${response.status}` };
    try {
      const body = await response.json();
      if (body?.detail?.code) detail = body.detail;
      else if (typeof body?.detail === 'string') detail.message = body.detail;
    } catch {
      // ignore non-json payloads
    }
    throw new ApiError(detail.code, detail.message, response.status);
  }

  return response.json();
}

function adaptPayload(raw) {
  return {
    api_version: raw.api_version,
    metadata: {
      terrainName: raw.metadata.terrain_name,
      source: raw.metadata.source,
      gridSize: raw.metadata.grid_size,
      worldScale: raw.metadata.world_scale_m,
      heightScale: raw.metadata.height_scale_m,
      resolutionMPerPx: raw.metadata.resolution_m_per_px,
      safeAreaPct: raw.metadata.safe_area_pct,
      crs: raw.metadata.crs,
      disclaimer: raw.metadata.disclaimer ?? null,
    },
    terrain: {
      size: raw.terrain.size,
      scale: raw.terrain.scale,
      heightScale: raw.terrain.height_scale,
      minH: raw.terrain.min_h,
      maxH: raw.terrain.max_h,
      data: raw.terrain.data,
    },
    layers: raw.layers,
    landingZones: (raw.landing_zones || []).map((z) => ({
      id: z.id,
      x: z.x,
      z: z.z,
      y: z.y,
      radius: z.radius_m,
      score: z.score,
      classification: z.classification,
      patchAreaPx: z.patch_area_px,
      minHazard: z.min_hazard_in_patch,
      meanHazard: z.mean_hazard_in_patch,
      confidence: z.confidence,
      components: {
        slope: z.components.slope_pct,
        roughness: z.components.roughness_pct,
        curvature: z.components.curvature_pct,
        shadow: z.components.shadow_pct,
      },
    })),
  };
}

export async function fetchSampleCatalog() {
  const payload = await requestJson(`${API_V1}/samples`);
  return payload.samples || [];
}

export async function analyzeSample(sampleId) {
  const raw = await requestJson(`${API_V1}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sample: sampleId }),
  });
  return normalizeAnalysisPayload(adaptPayload(raw));
}

export async function analyzeUpload(file) {
  const formData = new FormData();
  formData.append('file', file);
  const raw = await requestJson(`${API_V1}/analyze-upload`, {
    method: 'POST',
    body: formData,
  });
  return normalizeAnalysisPayload(adaptPayload(raw));
}

export { ApiError };
