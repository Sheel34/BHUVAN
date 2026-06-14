// ── Endless world height field ───────────────────────────────────────
//
// The analyzed DEM is a finite patch. Around it we synthesize rolling
// procedural terrain so the surface reads as a whole world the rover can
// roam, not a square tile. The ground mesh AND the rover both sample
// worldHeight() so the rover always sits on whatever it drives over.

import { createNoise2D } from 'simplex-noise';
import { sampleHeight } from './terrain';

const n2 = createNoise2D(() => 0.731); // fixed seed → stable world

function fbm(x, y, oct = 5) {
  let v = 0, a = 0.5, f = 1, m = 0;
  for (let i = 0; i < oct; i++) { v += n2(x * f, y * f) * a; m += a; a *= 0.5; f *= 2; }
  return v / m;
}

// Rolling hills + broad basins, wavelength keyed to the patch size.
export function proceduralHeight(x, z, wavelength, amp) {
  const f = 1 / (wavelength * 1.3);
  let h = fbm(x * f, z * f, 5) * amp;
  h += fbm(x * f * 3.1 + 11, z * f * 3.1 + 7, 3) * amp * 0.28;
  return h;
}

// Unified height: real DEM inside the patch, procedural outside, blended
// across the patch rim so there is no wall/seam.
export function worldHeight(terrain, x, z) {
  if (!terrain) return 0;
  const half = terrain.scale * 0.5;
  const amp = Math.max(8, (terrain.maxH - terrain.minH) * 0.55);
  const proc = terrain.minH + proceduralHeight(x, z, terrain.scale, amp);
  const ax = Math.abs(x), az = Math.abs(z);
  if (ax <= half && az <= half) {
    const patchH = sampleHeight(terrain, x, z);
    const edge = Math.max(ax, az) / half; // 0 centre → 1 rim
    if (edge > 0.82) {
      const t = (edge - 0.82) / 0.18;
      return patchH * (1 - t) + proc * t;
    }
    return patchH;
  }
  return proc;
}
