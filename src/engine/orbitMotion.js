import { LUNAR_ORBIT, lunarOrbitPosition } from './orbit.js';

export const DEFAULT_ORBIT_MOTION = Object.freeze({ playing: true, daysPerSecond: .2 });

// Shared model time: the Moon spins once per sidereal orbit, rather than
// independently spinning rapidly while showing the same side to Earth.
export function orbitPose(days) {
  const meanAnomaly = days * Math.PI * 2 / LUNAR_ORBIT.periodDays;
  return { days, meanAnomaly, moonPosition: lunarOrbitPosition(meanAnomaly),
    moonRotation: -Math.PI / 2 - meanAnomaly,
    earthRotation: days * Math.PI * 2 / .99726968 };
}

export function advanceOrbitDays(days, seconds, motion, locked = false) {
  if (!motion.playing || locked || !Number.isFinite(seconds) || seconds <= 0) return days;
  return days + Math.min(seconds, .1) * motion.daysPerSecond;
}
