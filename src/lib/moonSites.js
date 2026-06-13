// Hero landing sites shown on the Moon globe. Each maps to a backend
// analysis sample; `real` flags sites with a real-DEM upgrade path.
export const MOON_SITES = [
  {
    id: 'shackleton',
    name: 'Shackleton Crater',
    lat: -89.66,
    lon: 129.2,
    sampleId: 'moon-shackleton',
    blurb: 'Permanently shadowed polar crater — Artemis III candidate region.',
    elevation: '−1.3 km to +1.1 km rim relief',
    risk: 'Extreme rim slopes, cryogenic shadows',
    real: true,
  },
  {
    id: 'tycho',
    name: 'Tycho Crater',
    lat: -43.31,
    lon: -11.36,
    sampleId: 'moon-tycho',
    blurb: 'Youngest large lunar crater (~108 My) with a 2 km central peak.',
    elevation: '4.8 km floor-to-rim depth',
    risk: 'Hummocky impact-melt floor, boulder fields',
    real: false,
  },
  {
    id: 'tranquillitatis',
    name: 'Mare Tranquillitatis',
    lat: 0.674,
    lon: 23.473,
    sampleId: 'moon-mare-tranquillitatis',
    blurb: 'Apollo 11 landing region — basaltic mare plain.',
    elevation: '< 300 m local relief',
    risk: 'Low — wrinkle ridges and scattered fresh craters',
    real: false,
  },
];

// Convert selenographic lat/lon (degrees) to a position on a sphere of
// radius r, matching three.js equirectangular sphere UV orientation.
export function latLonToVec3(lat, lon, r) {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  return [
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  ];
}

// Inverse of latLonToVec3 — turn a hit point on the globe back into
// selenographic lat/lon so the user can click ANY spot, not just a marker.
export function vec3ToLatLon(x, y, z) {
  const r = Math.sqrt(x * x + y * y + z * z) || 1;
  const lat = 90 - (Math.acos(Math.max(-1, Math.min(1, y / r))) * 180) / Math.PI;
  let lon = (Math.atan2(z, -x) * 180) / Math.PI - 180;
  while (lon < -180) lon += 360;
  while (lon > 180) lon += -360;
  return { lat, lon };
}

// Pick the closest analyzable analogue for an arbitrary latitude so any
// clicked point lands on a representative surface in the workspace.
export function sampleIdForLat(lat) {
  const a = Math.abs(lat);
  if (a > 55) return 'moon-shackleton';        // polar
  if (a > 22) return 'moon-tycho';             // cratered highlands
  return 'moon-mare-tranquillitatis';          // equatorial mare
}

// Evenly scatter N explorable site nodes over the whole sphere
// (Fibonacci lattice) so the globe shows many clickable marks.
export function generateExplorationGrid(count = 60) {
  const sites = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const yy = 1 - (i / (count - 1)) * 2; // +1 → −1
    const radius = Math.sqrt(Math.max(0, 1 - yy * yy));
    const theta = golden * i;
    const x = Math.cos(theta) * radius;
    const z = Math.sin(theta) * radius;
    const { lat, lon } = vec3ToLatLon(x, yy, z);
    sites.push({ id: `grid-${i}`, name: 'Survey site', lat, lon, sampleId: sampleIdForLat(lat) });
  }
  return sites;
}
