import { roverPose, relayVisibility } from './rover.js';
// Rehearsal telemetry comes from the supplied map, never from an invented sensor.
export const boundedRoverSpeed = value => Math.max(.001, Math.min(20, Number(value) || .001));

export function advanceTravel(state, elapsed, speed, length) {
  if (!Number.isFinite(elapsed)) return state;
  const reset = elapsed < state.elapsed;
  return { elapsed, distance: Math.min(length, Math.max(0, reset ? elapsed * boundedRoverSpeed(speed)
    : state.distance + Math.max(0, elapsed - state.elapsed) * boundedRoverSpeed(speed))) };
}

export function scenarioLabel(objects, object) {
  const peers = objects.filter(o => o.type === object.type);
  return `${object.type} ${peers.findIndex(o => o.id === object.id) + 1}`;
}

// Keep generated infrastructure clear of the route's coarse planning cells.
export function rehearsalObjectPositions(terrain, placement) {
  const [x,,z]=placement.start,[gx,,gz]=placement.goal;
  const length=Math.hypot(gx-x,gz-z),nx=-(gz-z)/length,nz=(gx-x)/length;
  const cell=terrain.scale/(Math.min(129,terrain.size)-1);
  const half=terrain.scale/2-8,clamp=value=>Math.max(-half,Math.min(half,value));
  const offset=Math.max(40,cell*2+8);
  const candidates=[1,-1].map(side=>[clamp(x+nx*offset*side),clamp(z+nz*offset*side),side]);
  const clearance=([px,pz])=>Math.min(Math.hypot(px-x,pz-z),Math.hypot(px-gx,pz-gz));
  candidates.sort((a,b)=>clearance(b)-clearance(a));
  const [fx,fz,side]=candidates[0];
  return [['VEHICLE',x,z],['OBJECTIVE',gx,gz],['FACILITY',fx,fz],
    ['RELAY',clamp(x-nx*20*side),clamp(z-nz*20*side)]];
}

export const SCENARIO_ROLES = Object.freeze({
  VEHICLE: 'Route start. Follows DEM height and six wheel supports.',
  OBJECTIVE: 'Destination coordinate; not a solid object.',
  'SCIENCE SITE': 'Observation destination. Stops the route when reached.',
  FACILITY: 'Surface infrastructure. Its exclusion radius blocks rover routes. The displayed habitat is a concept model.',
  STATION: 'Mission hub with a blocked footprint. Power transfer is not simulated.',
  RELAY: 'Map line of sight within the set range. Radio propagation is not simulated.',
  'HAZARD REGION': 'User-declared no-go area. Replan after changing its radius.',
});

export function observationsCSV(observations) {
  return ['scenario_s,distance_m,local_x_m,local_z_m,dem_elevation_m,pitch_deg,roll_deg,contact_gap_m,relay_status',
    ...observations.map(o => [o.elapsed,o.distance,o.x,o.z,o.elevation,o.pitch,o.roll,o.gap].map(v => Number(v).toFixed(6)).join(',') + `,"${String(o.relay).replaceAll('"','""')}"`)].join('\n');
}

export function updateRehearsal(route, runtime, travel, elapsed, speed, terrain, objects) {
  const reset = elapsed < travel.elapsed;
  const next = advanceTravel(travel, elapsed, speed, route.distance);
  Object.assign(travel, next);
  Object.assign(runtime, roverPose(route, next.distance / route.speed), {
    speed: boundedRoverSpeed(speed), remaining:(route.distance-next.distance)/boundedRoverSpeed(speed),
  });
  if (reset || !runtime.observations) runtime.observations = [];
  const records = runtime.observations, last = records.at(-1);
  const spacing = Math.max(1, terrain.scale / (terrain.size - 1));
  if (!last || next.distance - last.distance >= spacing || (runtime.complete && last.distance !== next.distance)) {
    runtime.relay = relayVisibility(terrain, runtime.position, objects);
    records.push({elapsed, distance:next.distance,x:runtime.position[0],z:runtime.position[2],
      elevation:runtime.position[1]+(terrain.elevationOrigin||0),pitch:runtime.pitch*180/Math.PI,
      roll:runtime.roll*180/Math.PI,gap:runtime.support?.unsupportedHeight||0,relay:runtime.relay});
    if (records.length > 2000) records.shift();
  }
  return runtime;
}

// The local AEQD raster uses X = south (row), Z = east (column).
// Inverse spherical azimuthal equidistant, consistent with the lunar CRS.
export function localToLunarLocation(location, position, radius = 1737400) {
  if (!location || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) return null;
  const east = position[2], north = -position[0], rho = Math.hypot(east, north);
  if (!rho) return {lat:location.latitude,lon:location.longitude};
  const phi = location.latitude * Math.PI / 180, lambda = location.longitude * Math.PI / 180, c = rho / radius;
  const lat = Math.asin(Math.cos(c)*Math.sin(phi) + north*Math.sin(c)*Math.cos(phi)/rho);
  const lon = lambda + Math.atan2(east*Math.sin(c),rho*Math.cos(phi)*Math.cos(c) - north*Math.sin(phi)*Math.sin(c));
  return {lat:lat*180/Math.PI,lon:((lon*180/Math.PI+540)%360)-180};
}

export function lunarMissionOrigin(analysis) {
  const p=analysis?.metadata?.provenance;
  if (!p?.metric || p.body !== 'moon' || !/Azimuthal_Equidistant/i.test(p.reference||'')) return null;
  const parameter=name => Number((p.reference.match(new RegExp(`PARAMETER\\["${name}",([-+0-9.eE]+)`, 'i'))||[])[1]);
  const latitude=p.acquisition?.selected_lat??parameter('latitude_of_center'),longitude=p.acquisition?.selected_lon??parameter('longitude_of_center');
  return Number.isFinite(latitude)&&Number.isFinite(longitude)?{latitude,longitude}:null;
}
