import { createNoise2D } from 'simplex-noise';
import { normalizeAnalysisPayload } from '../engine/terrain';

const _noise2D = createNoise2D();

function _fbmNoise(nx, ny, octaves = 5) {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let maxVal = 0;
  for (let o = 0; o < octaves; o++) {
    value += _noise2D(nx * frequency, ny * frequency) * amplitude;
    maxVal += amplitude;
    amplitude *= 0.5;
    frequency *= 2.0;
  }
  return value / maxVal;
}

export const API_BASE = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000').replace(/\/+$/, '');

/** True when the API runs on this machine (NVML can read the local NVIDIA GPU). */
export function isLocalBackend() {
  try {
    const { hostname } = new URL(API_BASE);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

const API_V1 = `${API_BASE}/api/v1`;



class ApiError extends Error {

  constructor(code, message, status) {

    super(message);

    this.code = code;

    this.httpStatus = status;

  }

}



async function requestJson(url, options = {}) {

  const { timeoutMs = 15000, ...fetchOptions } = options;

  let response;

  try {

    response = await fetch(url, { ...fetchOptions, signal: AbortSignal.timeout(timeoutMs) });

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

    jobId: raw.job_id || null,

    intelligence: raw.intelligence || null,

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

      uncertainty: z.uncertainty ? {

        scoreCiLower: z.uncertainty.score_ci_lower,

        scoreCiUpper: z.uncertainty.score_ci_upper,

        hazardCiLower: z.uncertainty.hazard_ci_lower,

        hazardCiUpper: z.uncertainty.hazard_ci_upper,

        traversabilityCiLower: z.uncertainty.traversability_ci_lower,

        traversabilityCiUpper: z.uncertainty.traversability_ci_upper,

        bootstrapSamples: z.uncertainty.bootstrap_samples,

      } : null,

    })),

  };

}



export async function fetchSampleCatalog() {

  try {

    const payload = await requestJson(`${API_V1}/samples`);

    return { samples: payload.samples || [], backendMode: 'online' };

  } catch (err) {

    console.warn('Backend samples fetch failed, using local demo samples.');

    return {

      samples: [

        { id: 'mars-jezero', label: 'Mars Jezero (Local Demo)', source: 'frontend-fallback' },

        { id: 'moon-south-pole', label: 'Lunar South Pole (Local Demo)', source: 'frontend-fallback' },

      ],

      backendMode: 'error',

    };

  }

}



export async function analyzeSample(sampleId) {

  try {

    const raw = await requestJson(`${API_V1}/analyze`, {

      method: 'POST',

      headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify({ sample: sampleId }),

    });

    return normalizeAnalysisPayload(adaptPayload(raw));

  } catch (err) {

    // Offline / unreachable backend → never dead-end the user. Synthesize a
    // representative demo surface so ANY clicked site stays explorable.

    if (err.code === 'NETWORK_ERROR' || sampleId.startsWith('moon') || sampleId.startsWith('mars')) {

      return generateMockAnalysis(sampleId);

    }

    throw err;

  }

}



function generateMockAnalysis(id) {

  // Larger grid + wider world scale → a big, detailed surface to roam,
  // not a tiny patch. Chunked LOD keeps it cheap to render.
  const size = 192;

  const scale = 400;

  const heightScale = 72;

  const data = new Float32Array(size * size);

  for (let i = 0; i < size; i++) {

    for (let j = 0; j < size; j++) {

      const nx = i / size;

      const ny = j / size;

      const base = _fbmNoise(nx * 2.5, ny * 2.5, 5);

      let h = base;

      if (id.startsWith('moon')) {

        const crater = -0.6 * Math.exp(-((nx - 0.5) ** 2 + (ny - 0.5) ** 2) / 0.03);

        h = base * 0.5 + crater;

      } else {

        const crater = -0.5 * Math.exp(-((nx - 0.35) ** 2 + (ny - 0.55) ** 2) / 0.025);

        const ridge = 0.3 * Math.max(0, Math.sin(nx * 12) * 0.5 + 0.5);

        h = base * 0.6 + crater + ridge * 0.3;

      }

      data[i * size + j] = Math.max(-1, Math.min(1, h));

    }
  }

  const minH = Math.min(...data);
  const maxH = Math.max(...data);
  const range = maxH - minH || 1;
  for (let i = 0; i < data.length; i++) {
    data[i] = ((data[i] - minH) / range) * heightScale;
  }

  const slope = new Float32Array(size * size);
  for (let i = 1; i < size - 1; i++) {
    for (let j = 1; j < size - 1; j++) {
      const dx = (data[(i + 1) * size + j] - data[(i - 1) * size + j]) / 2;
      const dz = (data[i * size + j + 1] - data[i * size + j - 1]) / 2;
      slope[i * size + j] = Math.min(1, Math.sqrt(dx * dx + dz * dz) * 0.03);
    }
  }

  const roughness = new Float32Array(size * size);
  for (let i = 2; i < size - 2; i++) {
    for (let j = 2; j < size - 2; j++) {
      let sum = 0, count = 0;
      for (let di = -2; di <= 2; di++) {
        for (let dj = -2; dj <= 2; dj++) {
          sum += data[(i + di) * size + (j + dj)];
          count++;
        }
      }
      const mean = sum / count;
      let variance = 0;
      for (let di = -2; di <= 2; di++) {
        for (let dj = -2; dj <= 2; dj++) {
          const diff = data[(i + di) * size + (j + dj)] - mean;
          variance += diff * diff;
        }
      }
      roughness[i * size + j] = Math.min(1, Math.sqrt(variance / count) * 0.05);
    }
  }

  const hazard = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    hazard[i] = Math.min(1, slope[i] * 0.45 + roughness[i] * 0.25);
  }
  const traversability = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    traversability[i] = 1 - hazard[i];
  }

  const layers = {
    slope, roughness,
    curvature: new Float32Array(size * size),
    shadow: new Float32Array(size * size),
    hazard, traversability,
  };

  return {

    metadata: {

      terrainName: id.startsWith('mars') ? 'Mars Surface (DEMO)' : 'Lunar Surface (DEMO)',

      source: 'procedural-fallback',

      gridSize: size,

      worldScale: scale,

      heightScale: heightScale,

      resolutionMPerPx: scale / (size - 1),

      safeAreaPct: 82.4,

      crs: 'local-demo',

      disclaimer: 'BACKEND OFFLINE: Using procedural demo data.',

    },

    terrain: { data, size, scale, heightScale, minH: 0, maxH: heightScale },

    layers,

    landingZones: [

      {

        id: 'lz-1', x: 20, z: -15, y: 12, radius: 4, score: 92, classification: 'safe',

        patchAreaPx: 64, minHazard: 0.12, meanHazard: 0.19, confidence: 0.92,

        components: { slope: 5, roughness: 12, curvature: 2, shadow: 0 }

      },

      {

        id: 'lz-2', x: -30, z: 40, y: 15, radius: 4, score: 78, classification: 'caution',

        patchAreaPx: 42, minHazard: 0.28, meanHazard: 0.34, confidence: 0.78,

        components: { slope: 18, roughness: 25, curvature: 10, shadow: 5 }

      }

    ],

  };

}



export async function fetchMoonTextures() {

  try {

    let status = await requestJson(`${API_V1}/moon/textures`);

    if (!status.ready) {

      await requestJson(`${API_V1}/moon/textures/download`, { method: 'POST', timeoutMs: 120000 });

      status = await requestJson(`${API_V1}/moon/textures`);

    }

    if (!status.ready || !status.urls?.color || !status.urls?.displacement) return null;

    return {

      color: `${API_BASE}${status.urls.color}`,

      displacement: `${API_BASE}${status.urls.displacement}`,

    };

  } catch (err) {

    console.warn('Moon textures unavailable, globe will use procedural fallback.', err);

    return null;

  }

}



export async function generateReport(jobId, kind) {

  return requestJson(`${API_V1}/workspace/reports/${jobId}/${kind}`, {

    method: 'POST',

    timeoutMs: 30000,

  });

}



export async function fetchAnalysisHistory() {

  const payload = await requestJson(`${API_V1}/workspace/analyses`);

  return payload.analyses || [];

}



export async function fetchDemRegion(lat, lon, zoom = 12) {

  const raw = await requestJson(`${API_V1}/dem/fetch`, {

    method: 'POST',

    headers: { 'Content-Type': 'application/json' },

    body: JSON.stringify({ lat, lon, zoom }),

    timeoutMs: 60000,

  });

  return normalizeAnalysisPayload(adaptPayload(raw));

}



export async function runTercom(lat, lon, zoom = 12, launch = null, target = null, params = null) {

  return requestJson(`${API_V1}/tercom/run`, {

    method: 'POST',

    headers: { 'Content-Type': 'application/json' },

    body: JSON.stringify({ lat, lon, zoom, launch, target, params }),

    timeoutMs: 90000,

  });

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