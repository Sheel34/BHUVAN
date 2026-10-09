import { MOON_REFERENCE } from './coordinates.js';

// This is a compact visual arrangement, NOT an ephemeris or a distance model.
// Earth/Moon radius ratio is approximate; render units are not scientific metres.
export const ORBIT_BODIES = Object.freeze({
  earth: Object.freeze({ id: 'earth', radius: 2.6, center: [-2.5, .5, 0],
    reference: Object.freeze({ body: 'earth', model: 'WGS84 geographic',
      aM: 6378137, inverseFlattening: 298.257223563, longitude: 'east-positive',
      frame: 'Earth-fixed geographic; no inertial transform', verticalDatum: 'not selected' }) }),
  moon: Object.freeze({ id: 'moon', radius: .708, center: [3.4, -.5, .4], reference: MOON_REFERENCE }),
});

export function selectedLocation(body, latitude, longitude, timestamp = new Date().toISOString()) {
  const definition = ORBIT_BODIES[body];
  if (!definition || ![latitude, longitude].every(Number.isFinite) || Math.abs(latitude) > 90) {
    throw new Error('A supported body and valid surface coordinate are required.');
  }
  const lon = ((longitude + 180) % 360 + 360) % 360 - 180;
  return { body, latitude, longitude: lon, referenceModel: { ...definition.reference },
    selectionTimestamp: timestamp, terrainDataStatus: 'not-loaded', dataset: null };
}

export function previousOrbitLevel(level) {
  return level === 'region' ? 'body' : 'space';
}

// Optional layers require sourced content. An empty list creates no geography.
export const EARTH_LAYER_KINDS = Object.freeze(['water', 'rivers', 'roads', 'buildings',
  'land-cover', 'vegetation', 'clouds']);
export function sourcedEarthLayer({ kind, source, datasetId, reference, content, acquiredAt }) {
  if (!EARTH_LAYER_KINDS.includes(kind) || !source || !datasetId || !reference || !content) {
    throw new Error('An Earth layer requires kind, source, dataset identity, reference and content.');
  }
  return { body: 'earth', kind, source, datasetId, reference, content, acquiredAt: acquiredAt || null };
}

// Inject providers later; null means unavailable, not a fabricated physical state.
// State providers must return their epoch, frame and source. A future SPICE
// adapter belongs here, independently of Three.js and the visual layout above.
export function createEnvironmentProviders(providers = {}) {
  return Object.fromEntries(['clock', 'sun', 'ephemerides', 'trajectories', 'lineOfSight', 'illumination']
    .map(key => [key, typeof providers[key] === 'function' ? providers[key] : null]));
}

export const VISUAL_SUN = Object.freeze({ direction: [5, 2, 5],
  status: 'presentation lighting; fixed direction, no ephemeris' });

// NASA mean lunar elements. This is an accelerated two-body display orbit,
// with compressed distance; it is not an epoch-specific SPICE ephemeris.
export const LUNAR_ORBIT = Object.freeze({eccentricity:.0549,inclinationDegrees:5.145,periodDays:27.32166,displaySemiMajor:6.2});
export function lunarOrbitPosition(meanAnomaly,semiMajor=LUNAR_ORBIT.displaySemiMajor) {
  const e=LUNAR_ORBIT.eccentricity,M=((meanAnomaly%(Math.PI*2))+Math.PI*2)%(Math.PI*2);
  let E=M;for(let k=0;k<8;k++)E-=(E-e*Math.sin(E)-M)/(1-e*Math.cos(E));
  const x=semiMajor*(Math.cos(E)-e),z=semiMajor*Math.sqrt(1-e*e)*Math.sin(E),i=LUNAR_ORBIT.inclinationDegrees*Math.PI/180;
  return [x,Math.sin(i)*z,Math.cos(i)*z];
}
