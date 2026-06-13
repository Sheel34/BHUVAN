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
