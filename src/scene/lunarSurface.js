import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';

// Procedural regolith detail maps. The chunked terrain mesh only carries
// macro relief (one vertex every few metres); these tiling maps add the
// fine, lit micro-texture — grit, micro-craters, slope shading — that
// reads as a real surface instead of a smooth shell.

let _cache = null;

function fbm(noise, x, y, octaves) {
  let v = 0;
  let amp = 0.5;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    v += noise(x * freq, y * freq) * amp;
    amp *= 0.5;
    freq *= 2;
  }
  return v;
}

/**
 * Returns { normal, roughness } tiling CanvasTextures for the regolith.
 * Generated once, seeded, cached for the session.
 */
export function getRegolithMaps(size = 512) {
  if (_cache) return _cache;

  const noise = createNoise2D(() => 0.137);
  const height = new Float32Array(size * size);

  // Height field: layered grit + scattered micro-craters (rim + bowl).
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = x / size;
      const ny = y / size;
      height[y * size + x] = fbm(noise, nx * 18, ny * 18, 5) * 0.5;
    }
  }
  const craters = 70;
  for (let c = 0; c < craters; c++) {
    const cx = ((noise(c * 9.1, 2.3) + 1) / 2) * size;
    const cy = ((noise(3.7, c * 6.5) + 1) / 2) * size;
    const r = 3 + ((noise(c * 1.7, c * 4.2) + 1) / 2) * 14;
    for (let y = Math.max(0, cy - r * 2); y < Math.min(size, cy + r * 2); y++) {
      for (let x = Math.max(0, cx - r * 2); x < Math.min(size, cx + r * 2); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d < r * 1.6) {
          const t = d / r;
          let h = 0;
          if (t < 1) h = -0.5 * (1 - t * t);
          else h = 0.35 * Math.exp(-((t - 1.15) ** 2) / 0.05);
          height[y * size + x] += h;
        }
      }
    }
  }

  // Normal map from height gradient (tangent-space, +Z up).
  const normalCanvas = document.createElement('canvas');
  normalCanvas.width = normalCanvas.height = size;
  const nctx = normalCanvas.getContext('2d');
  const nimg = nctx.createImageData(size, size);

  const roughCanvas = document.createElement('canvas');
  roughCanvas.width = roughCanvas.height = size;
  const rctx = roughCanvas.getContext('2d');
  const rimg = rctx.createImageData(size, size);

  const strength = 2.4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xl = height[y * size + ((x - 1 + size) % size)];
      const xr = height[y * size + ((x + 1) % size)];
      const yu = height[((y - 1 + size) % size) * size + x];
      const yd = height[((y + 1) % size) * size + x];
      const dx = (xl - xr) * strength;
      const dy = (yu - yd) * strength;
      const len = Math.sqrt(dx * dx + dy * dy + 1);
      const i4 = (y * size + x) * 4;
      nimg.data[i4] = ((dx / len) * 0.5 + 0.5) * 255;
      nimg.data[i4 + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      nimg.data[i4 + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      nimg.data[i4 + 3] = 255;

      // Rougher in pits, slightly smoother on raised grit
      const rough = 230 + height[y * size + x] * 40;
      const rv = Math.max(180, Math.min(255, rough));
      rimg.data[i4] = rimg.data[i4 + 1] = rimg.data[i4 + 2] = rv;
      rimg.data[i4 + 3] = 255;
    }
  }
  nctx.putImageData(nimg, 0, 0);
  rctx.putImageData(rimg, 0, 0);

  const normal = new THREE.CanvasTexture(normalCanvas);
  normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
  normal.anisotropy = 8;
  const roughness = new THREE.CanvasTexture(roughCanvas);
  roughness.wrapS = roughness.wrapT = THREE.RepeatWrapping;

  _cache = { normal, roughness };
  return _cache;
}
