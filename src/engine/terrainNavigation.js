// All distances are dataset-local units. This module does not change DEM samples.
export function terrainRenderBounds(terrain, verticalExaggeration = 1) {
  return { size:terrain.size, scale:terrain.scale, stream:terrain.stream,
    minH:terrain.minH * verticalExaggeration, maxH:terrain.maxH * verticalExaggeration };
}

export function terrainCameraLimits(terrain, verticalExaggeration = 1) {
  const cell = terrain.scale / (terrain.size - 1);
  const relief = (terrain.maxH - terrain.minH) * verticalExaggeration;
  return { near: Math.max(.01, Math.min(cell / 20, terrain.scale / 10000)),
    minDistance: Math.max(cell * 3, terrain.scale * .0002),
    maxDistance: terrain.scale * 8 + relief * 4 };
}

export function terrainFrameDistance(terrain, fovDegrees, aspect, verticalExaggeration = 1) {
  return Math.max(terrain.scale * .7, (terrain.maxH - terrain.minH) * verticalExaggeration)
    / (Math.tan(fovDegrees * Math.PI / 360) * Math.min(aspect, 1));
}

export function terrainDisplayMetadata(analysis, verticalExaggeration = 1) {
  const t = analysis?.terrain, p = analysis?.metadata?.provenance;
  if (!t) return null;
  return { physicalExtent: [t.scale, t.scale], metric: p?.metric === true || analysis.metadata?.rehearsalScale?.kind==='assumed',
    sourceShape: p?.source_shape || null, sourceGsd: p?.source_gsd ?? null,
    analysisGrid: [t.size, t.size], analysisGsd: p?.analysis_gsd ?? null,
    verticalExaggeration, elevationOrigin: t.elevationOrigin || 0,
    bounds: [-t.scale / 2, -t.scale / 2, t.scale / 2, t.scale / 2] };
}
