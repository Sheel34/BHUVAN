/**
 * Read the GPU driving WebGL in this browser tab (the user's machine).
 * NVML is server-only; this is how we surface laptop GPU info on Vercel.
 */
export function readWebGLGpu(rendererOrGl) {
  if (!rendererOrGl) return null;

  // R3F hands us a THREE.WebGLRenderer, not the raw WebGL context. Accept
  // either: a renderer exposes .getContext(); a raw context has .getExtension.
  // (Calling getExtension on the renderer throws and crashes the canvas.)
  const gl = typeof rendererOrGl.getExtension === 'function'
    ? rendererOrGl
    : (typeof rendererOrGl.getContext === 'function' ? rendererOrGl.getContext() : null);
  if (!gl || typeof gl.getExtension !== 'function') return null;

  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = debugInfo
    ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);
  const vendor = debugInfo
    ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
    : gl.getParameter(gl.VENDOR);

  const rendererText = String(renderer || 'Unknown GPU');
  const software = /swiftshader|llvmpipe|software rasterizer|microsoft basic render/i.test(rendererText);

  return {
    renderer: rendererText,
    vendor: vendor ? String(vendor) : null,
    software,
    webgl2: gl instanceof WebGL2RenderingContext,
  };
}
