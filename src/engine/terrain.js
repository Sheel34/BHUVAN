export function sampleHeight(terrain, wx, wz) {

  const { data, size, scale } = terrain;

  const fi = ((wx / scale + 0.5) * (size - 1));

  const fj = ((wz / scale + 0.5) * (size - 1));

  const i0 = Math.max(0, Math.min(size - 2, Math.floor(fi)));

  const j0 = Math.max(0, Math.min(size - 2, Math.floor(fj)));

  const fx = fi - i0, fz = fj - j0;



  const h00 = data[i0 * size + j0];

  const h10 = data[(i0 + 1) * size + j0];

  const h01 = data[i0 * size + j0 + 1];

  const h11 = data[(i0 + 1) * size + j0 + 1];



  return h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz;

}



export function sampleSlope(slopes, terrain, wx, wz) {

  const { size, scale } = terrain;

  const i = Math.round((wx / scale + 0.5) * (size - 1));

  const j = Math.round((wz / scale + 0.5) * (size - 1));

  const ci = Math.max(0, Math.min(size - 1, i));

  const cj = Math.max(0, Math.min(size - 1, j));

  return slopes[ci * size + cj];

}



export function sampleRaster(raster, terrain, wx, wz) {

  const { data, size, scale } = terrain;

  const source = raster?.data || raster;

  if (!source || source.length !== size * size) return 0;

  const fi = (wx / scale + 0.5) * (size - 1);

  const fj = (wz / scale + 0.5) * (size - 1);

  const i = Math.max(0, Math.min(size - 1, Math.round(fi)));

  const j = Math.max(0, Math.min(size - 1, Math.round(fj)));

  return source[i * size + j];

}



export function inspectTerrainPoint(analysis, wx, wz) {

  if (!analysis?.terrain || !analysis?.layers) return null;

  const { terrain, layers } = analysis;

  return {

    x: wx,

    z: wz,

    elevation: sampleHeight(terrain, wx, wz),

    slope: sampleRaster(layers.slope, terrain, wx, wz),

    roughness: sampleRaster(layers.roughness, terrain, wx, wz),

    shadow: sampleRaster(layers.shadow, terrain, wx, wz),

    hazard: sampleRaster(layers.hazard, terrain, wx, wz),

    traversability: sampleRaster(layers.traversability, terrain, wx, wz),

  };

}



export function terrainFromPayload(payload) {

  const terrain = payload.terrain || {};

  const size = terrain.size || 0;

  return {

    data: Float32Array.from(terrain.data || []),

    size,

    scale: terrain.scale || 200,

    heightScale: terrain.heightScale || 30,

    minH: terrain.minH ?? 0,

    maxH: terrain.maxH ?? 1,

  };

}



export function layersFromPayload(payload, terrain) {

  const size = terrain.size * terrain.size;

  const layers = payload.layers || {};

  return {

    slope: Float32Array.from(layers.slope || new Array(size).fill(0)),

    roughness: Float32Array.from(layers.roughness || new Array(size).fill(0)),

    curvature: Float32Array.from(layers.curvature || new Array(size).fill(0)),

    shadow: Float32Array.from(layers.shadow || new Array(size).fill(0)),

    hazard: Float32Array.from(layers.hazard || new Array(size).fill(0)),

    traversability: Float32Array.from(layers.traversability || new Array(size).fill(0)),

  };

}



export function normalizeAnalysisPayload(payload) {

  const terrain = terrainFromPayload(payload);

  return {

    metadata: payload.metadata || {},

    jobId: payload.jobId || null,

    intelligence: payload.intelligence || null,

    terrain,

    layers: layersFromPayload(payload, terrain),

    landingZones: (payload.landingZones || []).map((z) => ({

      ...z,

      confidence: z.confidence ?? 1.0,

      patchAreaPx: z.patchAreaPx ?? 0,

      minHazard: z.minHazard ?? null,

      meanHazard: z.meanHazard ?? null,

    })),

    report: payload.report || null,

  };

}



/* ── Hazard level (0=safe, 1=caution, 2=danger) ── */

export function hazardLevel(slopeVal) {

  if (slopeVal < 0.35) return 0;

  if (slopeVal < 0.6) return 1;

  return 2;

}



/* ── Color for hazard visualization ── */

export function hazardColor(slopeVal) {

  if (slopeVal < 0.2) return [0.1, 0.82, 0.32];

  if (slopeVal < 0.35) return [0.36, 0.88, 0.2];

  if (slopeVal < 0.55) return [0.92, 0.78, 0.14];

  if (slopeVal < 0.7) return [0.95, 0.45, 0.12];

  return [0.9, 0.1, 0.1];

}



/* ── Mars surface color based on elevation ── */

export function marsColor(h, minH, maxH) {

  const t = (h - minH) / (maxH - minH + 0.001);

  const r = 0.55 + t * 0.35;

  const g = 0.25 + t * 0.18;

  const b = 0.12 + t * 0.08;

  return [r, g, b];

}



/* ── Realistic lunar regolith albedo (neutral grey, subtle elevation tint).

   Kept mid-bright so the normal-mapped detail and directional sun do the

   shading work — flat dark grey reads as plastic, this reads as rock. */

export function lunarColor(h, minH, maxH) {

  const t = (h - minH) / (maxH - minH + 0.001);

  // Highlands brighten with elevation, mare floors stay darker.

  const base = 0.42 + t * 0.30;

  return [base, base * 0.99, base * 0.96];

}



/* ── Earth surface: green lowlands → grey-brown highlands ── */

export function earthColor(h, minH, maxH) {

  const t = (h - minH) / (maxH - minH + 0.001);

  return [0.28 + t * 0.34, 0.36 + t * 0.16, 0.24 + t * 0.22];

}



/* ── Which body the analyzed terrain belongs to (drives surface colour). ── */

export function deriveBody(metadata) {

  const src = (metadata?.source || '').toLowerCase();

  const name = `${metadata?.source || ''} ${metadata?.terrainName || ''}`.toLowerCase();

  if (/srtm|terrarium|geotiff/.test(src)) return 'earth';

  if (/mars|jezero|gale|nili/.test(name)) return 'mars';

  if (/moon|lunar|tycho|shackleton|tranquil|mare|pole/.test(name)) return 'moon';

  return 'earth';

}



export function analysisColor(viewMode, value, terrain, height) {

  if (viewMode === 'hazard') return hazardColor(value);

  if (viewMode === 'slope') return [0.18 + value * 0.82, 0.25 + value * 0.3, 0.95 - value * 0.55];

  if (viewMode === 'roughness') return [0.15 + value * 0.8, 0.18 + value * 0.55, 0.2 + value * 0.18];

  if (viewMode === 'shadow') return [0.1, 0.18 + value * 0.32, 0.3 + value * 0.55];

  if (viewMode === 'traversability') return [0.18 + value * 0.18, 0.25 + value * 0.7, 0.25 + value * 0.2];

  // 'elevation' / 'surface' / default → photoreal surface, coloured by body

  const body = terrain.body || 'moon';

  if (body === 'mars') return marsColor(height, terrain.minH, terrain.maxH);

  if (body === 'earth') return earthColor(height, terrain.minH, terrain.maxH);

  return lunarColor(height, terrain.minH, terrain.maxH);

}