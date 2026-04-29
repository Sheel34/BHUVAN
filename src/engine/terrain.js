import { createNoise2D } from 'simplex-noise';

/* ── Seeded PRNG (Mulberry32) ── */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── Fractal Brownian Motion ── */
function fbm(noise, x, z, octaves = 6, lac = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, val = 0, max = 0;
  for (let i = 0; i < octaves; i++) {
    val += amp * noise(x * freq, z * freq);
    max += amp;
    amp *= gain;
    freq *= lac;
  }
  return val / max;
}

/* ── Crater profile ── */
function craterProfile(dist, radius, depth) {
  const t = dist / radius;
  if (t > 2.0) return 0;
  if (t < 0.8) return -depth * (1.0 - (t / 0.8) ** 2 * 0.3);
  if (t < 1.0) {
    const s = (t - 0.8) / 0.2;
    return -depth * (1.0 - s) * 0.7 + depth * 0.4 * s;
  }
  if (t < 1.3) {
    const s = (t - 1.0) / 0.3;
    return depth * 0.4 * (1.0 - s * s);
  }
  const s = (t - 1.3) / 0.7;
  return depth * 0.05 * Math.exp(-s * s * 3);
}

/* ── Main heightmap generator ── */
export function generateTerrain(size = 256, scale = 200, heightScale = 30, seed = 42) {
  const rng = mulberry32(seed);
  const noise = createNoise2D(rng);
  const data = new Float32Array(size * size);

  // Random craters
  const craters = [];
  for (let i = 0; i < 12; i++) {
    craters.push({
      x: (rng() - 0.5) * scale * 0.9,
      z: (rng() - 0.5) * scale * 0.9,
      r: rng() * scale * 0.12 + scale * 0.03,
      d: rng() * heightScale * 0.4 + heightScale * 0.05,
    });
  }

  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const wx = (i / (size - 1) - 0.5) * scale;
      const wz = (j / (size - 1) - 0.5) * scale;

      let h = fbm(noise, wx * 0.012, wz * 0.012, 6) * heightScale;
      h += fbm(noise, wx * 0.05 + 100, wz * 0.05 + 100, 4) * heightScale * 0.15;

      for (const c of craters) {
        const dist = Math.sqrt((wx - c.x) ** 2 + (wz - c.z) ** 2);
        h += craterProfile(dist, c.r, c.d);
      }

      data[i * size + j] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }

  return { data, size, scale, heightScale, minH, maxH, craters };
}

function createGrid(size, fill = 0) {
  const data = new Float32Array(size * size);
  if (fill !== 0) data.fill(fill);
  return data;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function normalizeGrid(grid) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < grid.length; i++) {
    const value = grid[i];
    if (value < min) min = value;
    if (value > max) max = value;
  }

  const range = max - min || 1;
  const normalized = new Float32Array(grid.length);
  for (let i = 0; i < grid.length; i++) {
    normalized[i] = (grid[i] - min) / range;
  }
  return normalized;
}

/* ── Terrain gradients ── */
export function computeSlopeMap(terrain) {
  const { data, size, scale } = terrain;
  const slopes = new Float32Array(size * size);
  const cell = scale / (size - 1);

  for (let i = 1; i < size - 1; i++) {
    for (let j = 1; j < size - 1; j++) {
      const idx = i * size + j;
      const dhdx = (data[idx + 1] - data[idx - 1]) / (2 * cell);
      const dhdz = (data[(i + 1) * size + j] - data[(i - 1) * size + j]) / (2 * cell);
      slopes[idx] = Math.sqrt(dhdx * dhdx + dhdz * dhdz);
    }
  }

  // Copy edges
  for (let i = 0; i < size; i++) {
    slopes[i] = slopes[size + i];
    slopes[(size - 1) * size + i] = slopes[(size - 2) * size + i];
    slopes[i * size] = slopes[i * size + 1];
    slopes[i * size + size - 1] = slopes[i * size + size - 2];
  }

  return normalizeGrid(slopes);
}

export function computeRoughnessMap(terrain) {
  const { data, size } = terrain;
  const roughness = createGrid(size);

  for (let i = 1; i < size - 1; i++) {
    for (let j = 1; j < size - 1; j++) {
      const idx = i * size + j;
      let sum = 0;
      let sumSq = 0;
      let count = 0;

      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const value = data[(i + di) * size + (j + dj)];
          sum += value;
          sumSq += value * value;
          count++;
        }
      }

      const mean = sum / count;
      const variance = Math.max(0, sumSq / count - mean * mean);
      roughness[idx] = Math.sqrt(variance);
    }
  }

  return normalizeGrid(roughness);
}

export function computeCurvatureMap(terrain) {
  const { data, size } = terrain;
  const curvature = createGrid(size);

  for (let i = 1; i < size - 1; i++) {
    for (let j = 1; j < size - 1; j++) {
      const idx = i * size + j;
      const center = data[idx];
      const laplacian =
        data[idx - 1] +
        data[idx + 1] +
        data[idx - size] +
        data[idx + size] -
        4 * center;
      curvature[idx] = Math.abs(laplacian);
    }
  }

  return normalizeGrid(curvature);
}

export function computeShadowMap(terrain, azimuthDeg = 35) {
  const { data, size, scale } = terrain;
  const shadow = createGrid(size);
  const cell = scale / (size - 1);
  const sunX = Math.cos((azimuthDeg * Math.PI) / 180);
  const sunZ = Math.sin((azimuthDeg * Math.PI) / 180);

  for (let i = 1; i < size - 1; i++) {
    for (let j = 1; j < size - 1; j++) {
      const idx = i * size + j;
      const dhdx = (data[idx + 1] - data[idx - 1]) / (2 * cell);
      const dhdz = (data[(i + 1) * size + j] - data[(i - 1) * size + j]) / (2 * cell);
      const illumination = dhdx * sunX + dhdz * sunZ;
      shadow[idx] = illumination < 0 ? Math.abs(illumination) : 0;
    }
  }

  return normalizeGrid(shadow);
}

/* ── Hazard analysis (multi-factor) ── */
export function computeHazards(terrain) {
  const slope = computeSlopeMap(terrain);
  const roughness = computeRoughnessMap(terrain);
  const curvature = computeCurvatureMap(terrain);
  const shadow = computeShadowMap(terrain);

  const hazard = new Float32Array(slope.length);
  const traversability = new Float32Array(slope.length);

  for (let i = 0; i < hazard.length; i++) {
    const score =
      slope[i] * 0.45 +
      roughness[i] * 0.25 +
      curvature[i] * 0.2 +
      shadow[i] * 0.1;
    hazard[i] = clamp01(score);
    traversability[i] = 1 - hazard[i];
  }

  return {
    slope,
    roughness,
    curvature,
    shadow,
    hazard,
    traversability,
  };
}

/* ── Get height at world position (bilinear interpolation) ── */
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

/* ── Get slope at world position ── */
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

export function createAnalysisFromTerrain(terrain, terrainName = 'Fallback Terrain') {
  const layers = computeHazards(terrain);
  const landingZones = [];
  const step = Math.max(8, Math.floor(terrain.size / 18));

  for (let i = step; i < terrain.size - step; i += step) {
    for (let j = step; j < terrain.size - step; j += step) {
      const idx = i * terrain.size + j;
      const hazardScore = layers.hazard[idx];
      const traversability = layers.traversability[idx];
      if (hazardScore > 0.45) continue;

      const x = (i / (terrain.size - 1) - 0.5) * terrain.scale;
      const z = (j / (terrain.size - 1) - 0.5) * terrain.scale;
      landingZones.push({
        id: `zone-${i}-${j}`,
        x,
        z,
        y: terrain.data[idx],
        radius: terrain.scale / terrain.size * 8,
        score: Number((traversability * 100).toFixed(1)),
        classification: hazardScore < 0.25 ? 'safe' : 'caution',
        components: {
          slope: Number((layers.slope[idx] * 100).toFixed(1)),
          roughness: Number((layers.roughness[idx] * 100).toFixed(1)),
          curvature: Number((layers.curvature[idx] * 100).toFixed(1)),
          shadow: Number((layers.shadow[idx] * 100).toFixed(1)),
        },
      });
    }
  }

  landingZones.sort((a, b) => b.score - a.score);

  let safeCells = 0;
  for (let i = 0; i < layers.hazard.length; i++) {
    if (layers.hazard[i] < 0.35) safeCells++;
  }

  return {
    metadata: {
      terrainName,
      source: 'frontend-fallback',
      gridSize: terrain.size,
      worldScale: terrain.scale,
      safeAreaPct: Number(((safeCells / layers.hazard.length) * 100).toFixed(1)),
    },
    terrain,
    layers,
    landingZones: landingZones.slice(0, 6),
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

export function analysisColor(viewMode, value, terrain, height) {
  if (viewMode === 'hazard') return hazardColor(value);
  if (viewMode === 'slope') return [0.18 + value * 0.82, 0.25 + value * 0.3, 0.95 - value * 0.55];
  if (viewMode === 'roughness') return [0.15 + value * 0.8, 0.18 + value * 0.55, 0.2 + value * 0.18];
  if (viewMode === 'shadow') return [0.1, 0.18 + value * 0.32, 0.3 + value * 0.55];
  if (viewMode === 'traversability') return [0.18 + value * 0.18, 0.25 + value * 0.7, 0.25 + value * 0.2];
  return marsColor(height, terrain.minH, terrain.maxH);
}
