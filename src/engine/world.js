// ── Lunar world height field ─────────────────────────────────────────
//
// Real-Moon procedural surface around the analyzed DEM patch: maria (dark,
// flat, low basins), highlands (bright, rough, elevated), and scattered
// impact craters (bowl + raised rim) at several scales. No water, no snow —
// regolith only. The ground mesh AND the rover sample the same field so the
// surface is one continuous world, not a tile floating over a plane.

import { createNoise2D } from 'simplex-noise';
import { sampleHeight } from './terrain';

const n2 = createNoise2D(() => 0.731); // fixed seed → stable world

function fbm(x, y, oct = 5) {
  let v = 0, a = 0.5, f = 1, m = 0;
  for (let i = 0; i < oct; i++) { v += n2(x * f, y * f) * a; m += a; a *= 0.5; f *= 2; }
  return v / m;
}

// Ridged multifractal → sharp highland ridges, not soft dunes.
function ridged(x, y, oct = 4) {
  let v = 0, a = 0.5, f = 1, m = 0;
  for (let i = 0; i < oct; i++) { const s = 1 - Math.abs(n2(x * f, y * f)); v += s * s * a; m += a; a *= 0.5; f *= 2; }
  return v / m;
}

function hash(i, j) {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// One layer of impact craters on a grid of `cell`-sized buckets. Deterministic
// (hash-placed) so it is stable and seamless across chunks.
function craterLayer(x, z, cell) {
  let h = 0;
  const ci = Math.floor(x / cell);
  const cj = Math.floor(z / cell);
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const gi = ci + di, gj = cj + dj;
      if (hash(gi * 1.7, gj * 2.3) < 0.4) continue; // denser crater field
      const cx = (gi + hash(gi + 3.1, gj + 7.7)) * cell;
      const cz = (gj + hash(gi + 5.5, gj + 2.2)) * cell;
      const rad = cell * (0.10 + 0.30 * hash(gi + 9.1, gj + 4.7));
      const d = Math.hypot(x - cx, z - cz) / rad;
      if (d < 1.5) {
        if (d < 0.85) {
          const u = d / 0.85;
          h += -rad * 0.55 * (1 - u * u);            // bowl
        } else {
          const rt = (d - 0.85) / 0.65;
          h += rad * 0.30 * Math.exp(-((rt - 0.12) ** 2) / 0.05); // raised rim
        }
      }
    }
  }
  return h;
}

// Returns { h, mare } — height and a 0..1 mare-ness for colouring.
export function lunarSample(terrain, x, z) {
  const wavelength = terrain.scale;
  const relief = Math.max(40, terrain.maxH - terrain.minH);
  const baseline = terrain.minH + (terrain.maxH - terrain.minH) * 0.45;
  const f = 1 / (wavelength * 1.6);

  // Mare basins (large, smooth, low) vs highlands (rough, high).
  const mRaw = fbm(x * f * 0.55 + 30, z * f * 0.55 + 12, 3); // ~ -0.6..0.6
  const mare = Math.min(1, Math.max(0, (mRaw - 0.05) / 0.35)); // 0 highland → 1 mare

  const highland = relief * (0.30 + ridged(x * f * 1.1, z * f * 1.1, 4) * 0.85);
  const basin = -relief * 0.45 + fbm(x * f * 1.3, z * f * 1.3, 3) * relief * 0.06;
  let h = highland * (1 - mare) + basin * mare;

  // Craters at four scales (denser; mare floors get fewer/smaller).
  const cr = craterLayer(x, z, wavelength * 0.9)
    + craterLayer(x, z, wavelength * 0.34)
    + craterLayer(x, z, wavelength * 0.13) * (0.4 + 0.6 * (1 - mare))
    + craterLayer(x, z, wavelength * 0.055) * (0.3 + 0.7 * (1 - mare));
  h += cr * 0.9;

  // Sinuous rilles — meandering collapsed lava channels, mostly in mare.
  const w = fbm(x * f * 0.9 + 70, z * f * 0.9 + 40, 2);
  const rille = Math.exp(-(w * w) / 0.0009);
  h -= relief * 0.14 * rille * (0.35 + 0.65 * mare);

  // fine regolith
  h += fbm(x * f * 7, z * f * 7, 4) * relief * 0.03;

  return { h: baseline + h, mare, cr, relief };
}

export function groundHeight(terrain, x, z) {
  return lunarSample(terrain, x, z).h;
}

// Unified height the rover/camera stand on: real DEM inside the patch, lunar
// procedural outside, blended across the rim so there is no wall/seam and the
// patch is part of one continuous surface (no floating tile).
export function worldHeight(terrain, x, z) {
  if (!terrain) return 0;
  const half = terrain.scale * 0.5;
  const ax = Math.abs(x), az = Math.abs(z);
  if (ax <= half && az <= half) {
    const patchH = sampleHeight(terrain, x, z);
    const edge = Math.max(ax, az) / half;
    if (edge > 0.78) {
      const t = (edge - 0.78) / 0.22;
      return patchH * (1 - t) + groundHeight(terrain, x, z) * t;
    }
    return patchH;
  }
  return groundHeight(terrain, x, z);
}
