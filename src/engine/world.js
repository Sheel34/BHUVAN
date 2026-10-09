import { sampleHeight } from './terrain.js';

// The finite DEM is the only ground model. Clamping outside its domain is a
// boundary constraint, not an assertion that exterior elevations are known.
export function worldHeight(terrain, x, z) {
  return terrain ? sampleHeight(terrain, x, z) : 0;
}

export function constrainTerrainCamera(camera, controls, terrain, { verticalExaggeration = 1, targetHeight } = {}) {
  if (!terrain || !controls) return;
  const half = terrain.scale / 2;
  const target = controls.target;
  const x = Math.max(-half, Math.min(half, target.x));
  const z = Math.max(-half, Math.min(half, target.z));
  const y = Number.isFinite(targetHeight) && x === target.x && z === target.z
    ? targetHeight : worldHeight(terrain, x, z) * verticalExaggeration;
  camera.position.x += x - target.x;
  camera.position.y += y - target.y;
  camera.position.z += z - target.z;
  target.set(x, y, z);
  // Clearance belongs at the camera, not every point on the viewing ray.
  // A ridge close to the pivot must be allowed to occlude it. Dividing its
  // height by a tiny ray fraction previously launched the camera into space.
  const cell = terrain.scale / (terrain.size - 1);
  const clearance = Math.max(camera.near * 4, cell * .25);
  if (Math.abs(camera.position.x) <= half && Math.abs(camera.position.z) <= half) {
    const i = (camera.position.x / terrain.scale + .5) * (terrain.size - 1);
    const j = (camera.position.z / terrain.scale + .5) * (terrain.size - 1);
    const height = terrain.tileSource ? terrain.tileSource.sample('height', i, j) : worldHeight(terrain, camera.position.x, camera.position.z);
    // Unknown streaming ground cannot justify a jump to the global peak.
    if (Number.isFinite(height)) camera.position.y = Math.max(camera.position.y, height * verticalExaggeration + clearance);
  }
  camera.lookAt(target);
  camera.updateMatrixWorld();
}
