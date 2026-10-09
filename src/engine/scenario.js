import { triangleHeight } from './surfacePlacement.js';

// A controllable timebase and explicit editable state, NOT a physics solver.
export class SimulationClock {
  constructor() { this.reset(); }
  reset() { this.elapsed = 0; this.playing = false; this.timeScale = 1; }
  play() { this.playing = true; }
  pause() { this.playing = false; }
  setTimeScale(value) {
    if (!Number.isFinite(value) || value <= 0 || value > 100) throw new Error('Time scale must be > 0 and ≤ 100.');
    this.timeScale = value;
  }
  advance(seconds) {
    if (this.playing && Number.isFinite(seconds) && seconds > 0) this.elapsed += seconds * this.timeScale;
    return this.elapsed;
  }
  snapshot() { return { elapsed: this.elapsed, playing: this.playing, timeScale: this.timeScale }; }
}

export const SCENARIO_TYPES = Object.freeze(['VEHICLE', 'STATION', 'FACILITY', 'RELAY', 'SCIENCE SITE', 'HAZARD REGION', 'OBJECTIVE']);

export async function terrainAttachment(terrain, x, z, signal) {
  if (![x, z].every(Number.isFinite) || Math.max(Math.abs(x), Math.abs(z)) > terrain.scale / 2) throw new Error('Placement is outside the DEM.');
  let elevation;
  if (terrain.tileSource) {
    const index = value => (value / terrain.scale + .5) * (terrain.size - 1);
    const fi = index(x), fj = index(z), i = Math.min(terrain.size - 2, Math.floor(fi)), j = Math.min(terrain.size - 2, Math.floor(fj));
    const dx = fi - i, dz = fj - j;
    const points = await Promise.all([[i,j],[i+1,j],[i,j+1],[i+1,j+1]].map(([a,b]) => terrain.tileSource.inspect(a,b,{signal})));
    if (points.every(p => Number.isFinite(p?.elevation))) elevation = triangleHeight(points[0].elevation,points[1].elevation,points[2].elevation,points[3].elevation,dx,dz);
  } else {
    const fi=(x/terrain.scale+.5)*(terrain.size-1),fj=(z/terrain.scale+.5)*(terrain.size-1);
    const i=Math.min(terrain.size-2,Math.floor(fi)),j=Math.min(terrain.size-2,Math.floor(fj)),n=terrain.size;
    elevation = triangleHeight(terrain.data[i*n+j],terrain.data[(i+1)*n+j],terrain.data[i*n+j+1],terrain.data[(i+1)*n+j+1],fi-i,fj-j) + (terrain.elevationOrigin || 0);
  }
  if (!Number.isFinite(elevation)) throw new Error('Native terrain height is unavailable. Object was not placed.');
  return { x, z, elevation, localHeight: elevation - (terrain.elevationOrigin || 0),
    sampling: 'native DEM triangle interpolation; same diagonal as the terrain mesh' };
}

export function createScenarioObject(type, attachment, datasetId, timestamp, id) {
  if (!SCENARIO_TYPES.includes(type) || !datasetId || ![attachment.x, attachment.z, attachment.elevation].every(Number.isFinite)) throw new Error('Valid type, dataset and terrain attachment are required.');
  return { id, type, datasetId, attachment, position: [attachment.x, attachment.localHeight, attachment.z],
    velocity: [0, 0, 0], orientation: [0, 0, 0], angularVelocity: [0, 0, 0], mass: null,
    constraints: {}, timestamp, timeReference: 'scenario elapsed seconds; not a geospatial acquisition epoch',
    stateModel: 'user placement; no dynamics or physical validation' };
}
