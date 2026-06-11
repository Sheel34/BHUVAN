import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';

// Offline fallback: synthesize equirectangular moon color + displacement
// textures on a canvas so the hero globe renders with zero network access.

function fbm(noise, x, y, octaves = 5) {
  let value = 0;
  let amp = 1;
  let freq = 1;
  let max = 0;
  for (let o = 0; o < octaves; o++) {
    value += noise(x * freq, y * freq) * amp;
    max += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return value / max;
}

export function createProceduralMoonTextures(width = 1024, height = 512) {
  const noise = createNoise2D(() => 0.42); // deterministic seed
  const color = document.createElement('canvas');
  const disp = document.createElement('canvas');
  color.width = disp.width = width;
  color.height = disp.height = height;
  const cctx = color.getContext('2d');
  const dctx = disp.getContext('2d');

  const cimg = cctx.createImageData(width, height);
  const dimg = dctx.createImageData(width, height);

  // Pre-scatter craters (lon/lat space, wrapped horizontally)
  const craters = [];
  for (let i = 0; i < 90; i++) {
    craters.push({
      x: ((noise(i * 12.9, 3.7) + 1) / 2) * width,
      y: ((noise(7.1, i * 9.3) + 1) / 2) * height,
      r: 4 + ((noise(i * 3.3, i * 5.1) + 1) / 2) * 26,
    });
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = x / width;
      const ny = y / height;
      // Base highlands/maria split
      let h = 0.55 + 0.25 * fbm(noise, nx * 4, ny * 4, 5);
      const maria = fbm(noise, nx * 2 + 9, ny * 2 + 9, 3);
      if (maria > 0.25) h -= 0.22 * (maria - 0.25);

      // Craters: bowl + rim, wrapped in x
      for (const c of craters) {
        let dx = Math.abs(x - c.x);
        if (dx > width / 2) dx = width - dx;
        const dy = y - c.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < c.r * 1.5) {
          const t = d / c.r;
          if (t < 1) h -= 0.18 * (1 - t * t);
          else h += 0.08 * Math.exp(-((t - 1.12) ** 2) / 0.012);
        }
      }

      h = Math.max(0, Math.min(1, h));
      const i4 = (y * width + x) * 4;

      // Color: neutral grey regolith, maria slightly darker + bluer
      const grey = 60 + h * 130;
      cimg.data[i4] = grey;
      cimg.data[i4 + 1] = grey;
      cimg.data[i4 + 2] = grey * 1.02;
      cimg.data[i4 + 3] = 255;

      const dh = h * 255;
      dimg.data[i4] = dh;
      dimg.data[i4 + 1] = dh;
      dimg.data[i4 + 2] = dh;
      dimg.data[i4 + 3] = 255;
    }
  }

  cctx.putImageData(cimg, 0, 0);
  dctx.putImageData(dimg, 0, 0);

  const colorTex = new THREE.CanvasTexture(color);
  colorTex.colorSpace = THREE.SRGBColorSpace;
  const dispTex = new THREE.CanvasTexture(disp);
  colorTex.anisotropy = 8;

  return { color: colorTex, displacement: dispTex, procedural: true };
}
