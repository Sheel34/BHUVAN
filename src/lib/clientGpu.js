/**
 * Read the GPU driving WebGL in this browser tab (the user's machine).
 * NVML is server-only; this is how we surface laptop GPU info on Vercel.
 */
export function readWebGLGpu(gl) {
  if (!gl) return null;

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
