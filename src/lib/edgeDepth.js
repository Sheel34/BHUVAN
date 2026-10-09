// On-device monocular depth estimation — the genuine "Edge AI" stage.
//
// A real neural network (Depth-Anything V2, a ViT-based transformer) runs
// inference IN THE BROWSER on the local GPU via WebGPU (WASM fallback). No
// server round-trip for inference: the model weights are fetched once from the
// Hugging Face CDN and cached, then every prediction is computed on-device —
// the textbook definition of edge AI (inference next to where data is captured).
//
// Output: a normalised [0,1] elevation grid that feeds straight into BHUVAN's
// existing terrain-mechanics pipeline (slope / roughness / curvature / hazard).

import { pipeline, env } from '@huggingface/transformers';

// Pull weights from the HF CDN (no bundled model); cache in the browser.
env.allowLocalModels = false;

const MODEL_ID = 'onnx-community/depth-anything-v2-small';

let _depther = null;
let _loading = null;
let _device = null;

export function depthDevice() {
  return _device;
}

/** Lazily construct the depth-estimation pipeline on the best local backend. */
export async function getDepther(onProgress) {
  if (_depther) return _depther;
  if (!_loading) {
    _device = typeof navigator !== 'undefined' && navigator.gpu ? 'webgpu' : 'wasm';
    _loading = pipeline('depth-estimation', MODEL_ID, {
      device: _device,
      dtype: _device === 'webgpu' ? 'fp16' : 'q8',
      progress_callback: onProgress,
    }).then((p) => {
      _depther = p;
      return p;
    }).catch(error => {
      _loading = null;
      throw error;
    });
  }
  return _loading;
}

/**
 * Run depth estimation on an image (URL string, Blob/File, or HTMLImageElement).
 * Returns the on-device depth field plus provenance for the "edge proof" UI.
 */
export async function estimateDepth(imageSource, { onProgress, gridSize = 192 } = {}) {
  const depther = await getDepther(onProgress);

  let src = imageSource;
  if (typeof File !== 'undefined' && imageSource instanceof File) {
    src = URL.createObjectURL(imageSource);
  }

  const t0 = performance.now();
  let out;
  try { out = await depther(src); }
  finally { if (src !== imageSource && typeof src === 'string' && src.startsWith('blob:')) URL.revokeObjectURL(src); }
  const ms = Math.round(performance.now() - t0);


  const tensor = out.predicted_depth;
  const dims = tensor.dims;
  const h = dims[dims.length - 2];
  const w = dims[dims.length - 1];
  const data = tensor.data; // Float32Array of raw (relative) depth

  // Relative camera depth is mapped to display relief, not registered ground
  // elevation. A single view supplies no metric scale or terrain orientation.
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) throw new Error('Depth model returned a non-finite sample.');
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const range = Math.max(1e-6, mx - mn);

  // Resample to a square grid the terrain pipeline expects.
  const grid = resampleToGrid(data, w, h, gridSize, mn, range);

  return {
    grid, // number[gridSize][gridSize] in [0,1]
    gridSize,
    sourceWidth: w,
    sourceHeight: h,
    ms,
    device: _device,
    model: MODEL_ID,
  };
}

function resampleToGrid(data, w, h, n, mn, range) {
  const out = [];
  for (let gy = 0; gy < n; gy++) {
    const row = [];
    const sy = Math.min(h - 1, Math.floor((gy / n) * h));
    for (let gx = 0; gx < n; gx++) {
      const sx = Math.min(w - 1, Math.floor((gx / n) * w));
      const v = data[sy * w + sx];
      // invert (near→low): higher terrain = farther-from-camera not assumed;
      // keep raw normalised value, the pipeline only needs relative relief.
      row.push((v - mn) / range);
    }
    out.push(row);
  }
  return out;
}
