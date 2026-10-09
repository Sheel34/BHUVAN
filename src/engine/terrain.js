import { RemoteTileSource } from './tileSource.js';

export function sampleHeight(terrain, wx, wz) {
  const { data, size, scale } = terrain;
  if(terrain.tileSource) {
    const i=(wx/scale+.5)*(size-1),j=(wz/scale+.5)*(size-1);
    return terrain.tileSource.sample('height',i,j) ?? terrain.maxH;
  }
  const fi = Math.max(0, Math.min(size - 1, (wx / scale + 0.5) * (size - 1)));
  const fj = Math.max(0, Math.min(size - 1, (wz / scale + 0.5) * (size - 1)));
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
  if (!source || source.length !== size * size) return null;
  const fi = (wx / scale + 0.5) * (size - 1);
  const fj = (wz / scale + 0.5) * (size - 1);
  const i = Math.max(0, Math.min(size - 1, Math.round(fi)));
  const j = Math.max(0, Math.min(size - 1, Math.round(fj)));
  return source[i * size + j];
}

export function inspectTerrainPoint(analysis, wx, wz) {
  if (!analysis?.terrain || !analysis?.layers) return null;
  const { terrain, layers } = analysis;
  if(terrain.tileSource) return null; // Native analysis point is fetched separately; never silently use display LOD.
  return {
    x: wx,
    z: wz,
    elevation: sampleHeight(terrain, wx, wz) + (terrain.elevationOrigin || 0),
    slope: sampleRaster(layers.slope, terrain, wx, wz),
    roughness: sampleRaster(layers.roughness, terrain, wx, wz),
    shadow: sampleRaster(layers.shadow, terrain, wx, wz),
    hazard: sampleRaster(layers.hazard, terrain, wx, wz),
    traversability: sampleRaster(layers.traversability, terrain, wx, wz),
  };
}

export function terrainFromPayload(payload) {
  const terrain = payload.terrain || {};
  if(payload.terrainStream) {
    const stream=payload.terrainStream;
    return { size:stream.size,scale:stream.scale,minH:stream.min_h,maxH:stream.max_h,
      elevationOrigin:stream.elevation_origin,heightScale:stream.max_h-stream.min_h,
      stream,tileSource:new RemoteTileSource(stream) };
  }
  const size = terrain.size || 0;
  const scientificData = Float64Array.from(terrain.data || []);
  const elevationOrigin = terrain.minH ?? 0;
  return {
    scientificData, elevationOrigin,
    data: Float64Array.from(scientificData, h => h - elevationOrigin),
    size,
    scale: terrain.scale || 200,
    heightScale: terrain.heightScale || 30,
    minH: (terrain.minH ?? 0) - elevationOrigin,
    maxH: (terrain.maxH ?? 1) - elevationOrigin,
  };
}

export function layersFromPayload(payload, terrain) {
  if(terrain.stream) return Object.fromEntries(terrain.stream.fields.filter(name=>name!=='height').map(name=>[name,{remote:true,analysisGsd:terrain.stream.analysis?.gsd_m}]));
  const size = terrain.size * terrain.size;
  const layers = payload.layers || {};
  return Object.fromEntries(['slope','roughness','curvature','shadow','hazard','traversability'].map(name => {
    const values=layers[name];
    if (!values || values.length !== size || !values.every(Number.isFinite)) {
      console.error('[analysis] Layer unavailable or invalid', { name, expected: size, received: values?.length });
      return [name, null];
    }
    return [name, Float32Array.from(values)];
  }));
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
  return paletteColor('hazard', slopeVal);
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
  if (metadata?.provenance?.body) return metadata.provenance.body;
  const src = (metadata?.source || '').toLowerCase();
  const name = `${metadata?.source || ''} ${metadata?.terrainName || ''}`.toLowerCase();
  if (/srtm|terrarium/.test(src)) return 'earth';
  if (/mars|jezero|gale|nili/.test(name)) return 'mars';
  if (/moon|lunar|tycho|shackleton|tranquil|mare|pole/.test(name)) return 'moon';
  return 'unknown';
}

// Shared with the HUD. These fields are normalized indices in the current
// frontend contract; do not label slope as degrees or roughness as metres.
export const LAYER_PALETTES = {
  elevation: { label: 'Elevation', colors: ['#55585c', '#c7c9cc'] },
  slope: { label: 'Slope', colors: ['#354f6b', '#8699a3', '#d2bf82'], lo: '0 flat', hi: '1 steep' },
  roughness: { label: 'Roughness', colors: ['#343f49', '#b8b1a1'], lo: '0 smooth', hi: '1 rough' },
  hazard: { label: 'Hazard', colors: ['#5d8e7f', '#c9b16d', '#a5433d'], lo: '0 low', hi: '1 high' },
  traversability: { label: 'Traversability', colors: ['#a5433d', '#c9b16d', '#5d8e7f'], lo: '0 poor', hi: '1 good' },
  shadow: { label: 'Shadow', colors: ['#273443', '#95b1c9'], lo: '0', hi: '1' },
};
const toLinear = c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
const toSrgb = c => c <= .0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - .055;
const PALETTE_LINEAR = Object.fromEntries(Object.entries(LAYER_PALETTES).map(([key, palette]) => [
  key, palette.colors.map(hex => [1, 3, 5].map(start => toLinear(parseInt(hex.slice(start, start + 2), 16) / 255))),
]));
function paletteColor(mode, value) {
  const stops = PALETTE_LINEAR[mode];
  const t = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(t));
  // Linear-light interpolation matches the CSS legend and GPU interpolation.
  return stops[index].map((c, channel) => toSrgb(c + (stops[index + 1][channel] - c) * (t - index)));
}
export function analysisColor(viewMode, value, terrain, height) {
  if (viewMode === 'hazard') return hazardColor(value);
  if (viewMode === 'elevation') return paletteColor('elevation', (height - terrain.minH) / (terrain.maxH - terrain.minH || 1));
  if (LAYER_PALETTES[viewMode]) return paletteColor(viewMode, value);
  // Surface view is physically lit and coloured by body.
  const body = terrain.body || 'moon';
  if (body === 'mars') return marsColor(height, terrain.minH, terrain.maxH);
  if (body === 'earth') return earthColor(height, terrain.minH, terrain.maxH);
  return lunarColor(height, terrain.minH, terrain.maxH);
}
