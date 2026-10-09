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

export const networkMetrics = { decodedResponseBytes: 0, requests: 0, lastRequestMs: 0 };
class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.httpStatus = status;
  }
}

async function requestJson(url, options = {}) {
  const { timeoutMs = 15000, ...fetchOptions } = options;
  const started = performance.now();
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

  const body = await response.text();
  const decodedBytes = new TextEncoder().encode(body).byteLength;
  networkMetrics.requests++;
  networkMetrics.decodedResponseBytes += decodedBytes;
  networkMetrics.lastRequestMs = performance.now()-started;
  console.info('[data] Response', { url, decodedBytes, ms: networkMetrics.lastRequestMs });
  return JSON.parse(body);
}

function legacyProvenance(metadata) {
  const source = metadata.source || 'unknown';
  const estimated = /image|depth|ai-enhanced/.test(source);
  const synthetic = /procedural|fallback/.test(source);
  return { status: estimated ? 'ESTIMATED' : synthetic ? 'SYNTHETIC' : 'MEASURED',
    metric: !estimated && !synthetic, source, dataset_id: metadata.terrain_name,
    body: /lola|moon|lunar/.test(source + metadata.terrain_name) ? 'moon' : /hirise|mars/.test(source) ? 'mars' : /srtm|terrarium/.test(source) ? 'earth' : 'unknown',
    reference: metadata.crs || 'unspecified', analysis_gsd: estimated ? null : metadata.resolution_m_per_px,
    source_gsd: metadata.native_resolution_m_per_px ?? null, elevation_unit: estimated || synthetic ? 'relative units' : 'm',
    limitations: ['Legacy backend: source fidelity/reference/unit metadata are incomplete; verify before physical interpretation.', metadata.disclaimer].filter(Boolean) };
}

function adaptPayload(raw) {
  return {
    terrainStream: raw.terrain_stream ? {...raw.terrain_stream,
      tile_url: `${API_BASE}${raw.terrain_stream.tile_url}`,point_url:`${API_BASE}${raw.terrain_stream.point_url}`} : null,
    api_version: raw.api_version,
    jobId: raw.job_id || null,
    intelligence: raw.intelligence || null,
    metadata: {
      provenance: raw.metadata.provenance || legacyProvenance(raw.metadata),
      analysisModel: raw.metadata.analysis_model || null,
      terrainName: raw.metadata.terrain_name,
      source: raw.metadata.source,
      gridSize: raw.metadata.grid_size,
      worldScale: raw.metadata.world_scale_m,
      heightScale: raw.metadata.height_scale_m,
      resolutionMPerPx: raw.metadata.resolution_m_per_px,
      safeAreaPct: raw.metadata.safe_area_pct,
      crs: raw.metadata.crs,
      disclaimer: raw.metadata.disclaimer ?? null,
      colorUrl: raw.metadata.color_url ? `${API_BASE}${raw.metadata.color_url}` : null,
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
    if (err.code === 'NETWORK_ERROR' && /^(moon|mars)-/.test(sampleId)) {
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
      provenance: { status: 'SYNTHETIC', metric: false, source: 'procedural-fallback', dataset_id: id, body: id.startsWith('mars') ? 'mars' : 'moon', reference: 'local arbitrary test coordinates', analysis_gsd: null, source_gsd: null, elevation_unit: 'relative units', limitations: ['Offline procedural test; no observations of this site.', 'Heuristic indices with arbitrary display scale; no calibrated physical quantities.'] },
      gridSize: size,
      worldScale: scale,
      heightScale: heightScale,
      resolutionMPerPx: scale / (size - 1),
      safeAreaPct: 100 * layers.hazard.filter(v => v < .35).length / data.length,
      crs: 'local-demo',
      disclaimer: 'BACKEND OFFLINE: Using procedural demo data.',
    },
    terrain: { data, size, scale, heightScale, minH: 0, maxH: heightScale },
    layers,
    landingZones: [],

  };
}

export async function fetchMoonTextures() {
  try {
    let status = await requestJson(`${API_V1}/moon/textures`);

    if (!status.ready || !status.urls?.color || !status.urls?.displacement) return null;
    return {
      color: `${API_BASE}${status.urls.color}`,
      displacement: `${API_BASE}${status.urls.displacement}`,
    };
  } catch (err) {
    console.warn('Moon textures unavailable; bundled lunar imagery will be used.', err);
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

// NDJSON stages are emitted by acquisition/analysis work, never by a UI timer.
export async function acquireLocationTerrain(location, { signal, onStage } = {}) {
  const started = performance.now();
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
  let response;
  try {
    response = await fetch(`${API_V1}/terrain/acquire`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({...location,stream_tiles:true}), signal: requestSignal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError('NETWORK_ERROR', `Terrain provider could not be reached: ${error.message}`, 0);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new ApiError('ACQUISITION_FAILED', `Terrain request failed (${response.status}): ${text}`, response.status);
  }
  if (!response.body) throw new ApiError('STREAM_UNAVAILABLE', 'Acquisition progress stream is unavailable.', 0);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '', result = null, bytes = 0;
  const consume = line => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'error') throw new ApiError(event.code, event.message, 0);
    if (event.type === 'stage') onStage?.(event);
    if (event.type === 'result') result = event.analysis;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      pending += decoder.decode(value, { stream: true });
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        consume(pending.slice(0, end)); pending = pending.slice(end + 1);
      }
    }
    pending += decoder.decode(); consume(pending);
  } finally { await reader.cancel(); reader.releaseLock(); }
  networkMetrics.requests++;
  networkMetrics.decodedResponseBytes += bytes;
  networkMetrics.lastRequestMs = performance.now() - started;
  if (!result) throw new ApiError('INCOMPLETE_ACQUISITION', 'Terrain stream ended without an analysis result.', 0);
  return normalizeAnalysisPayload(adaptPayload(result));
}

export async function analyzeEdgeDepth(grid, meta = {}, imageFile = null) {
  if(imageFile) {
    const imageForm=new FormData();imageForm.append('file',imageFile);
    const image=await requestJson(`${API_V1}/surface-image`,{method:'POST',body:imageForm,timeoutMs:60000});
    meta={...meta,color_url:image.color_url};
  }
  const raw = await requestJson(`${API_V1}/analyze-edge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grid, ...meta }),
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

export async function analyzeUpload(file, orthophoto = null) {
  const formData = new FormData();
  formData.append(orthophoto?'dem':'file', file);
  if(orthophoto)formData.append('orthophoto',orthophoto);
  const raw = await requestJson(`${API_V1}/${orthophoto?'analyze-pair':'analyze-upload'}`, {
    method: 'POST',
    body: formData,
    timeoutMs: 300000,
  });
  return normalizeAnalysisPayload(adaptPayload(raw));
}

export { ApiError };

export async function developmentStreamingAnalysis(size) {
  if(!import.meta.env.DEV)throw new Error('Development-only dataset');
  const raw=await requestJson(`${API_V1}/terrain/datasets/benchmark-${size}`);
  const stream={...raw,tile_url:API_BASE+raw.tile_url,point_url:API_BASE+raw.point_url};
  return normalizeAnalysisPayload({terrainStream:stream,metadata:{terrainName:raw.dataset_id,source:raw.source,
    gridSize:raw.size,worldScale:raw.scale,resolutionMPerPx:1,
    provenance:{status:'SYNTHETIC',body:'unknown',metric:true,source:raw.source,dataset_id:raw.dataset_id,
      reference:raw.crs,source_gsd:1,analysis_gsd:null,elevation_unit:'m',limitations:[raw.limitation,'Visual test only; no hazard or candidate analysis.']}}});
}
