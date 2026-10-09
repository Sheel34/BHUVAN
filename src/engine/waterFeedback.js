// Shared timing keeps the DOM label and its Three.js lens in the same place.
export const PRESS_IN_MS = 80;
export const MIN_PRESS_MS = 130;
export const RELEASE_MS = 300;
const feedback = new WeakMap();
const smooth = t => t * t * (3 - 2 * t);

export function pressWater(element, now) {
  const state = { downAt: now, upAt: Infinity };
  feedback.set(element, state);
  return state;
}

export function releaseWater(element, now) {
  const state = feedback.get(element);
  if (state && !Number.isFinite(state.upAt)) state.upAt = Math.max(now, state.downAt + MIN_PRESS_MS);
}

export function waterPressure(element, now, reducedMotion = false) {
  const state = feedback.get(element);
  if (!state) return 0;
  if (reducedMotion) return now < state.upAt ? 1 : 0;
  if (now <= state.upAt) return smooth(Math.min(1, Math.max(0, (now - state.downAt) / PRESS_IN_MS)));
  const t = (now - state.upAt) / RELEASE_MS;
  if (t >= 1) return 0;
  // One small return overshoot, then an exact rest; no ongoing oscillation.
  return (1 - t) ** 3 * Math.cos(t * Math.PI * 1.8);
}

export function waterSettled(element, now, reducedMotion = false) {
  const state = feedback.get(element);
  return !state || now >= state.upAt + (reducedMotion ? 0 : RELEASE_MS);
}

export function forgetWater(element) { feedback.delete(element); }

// Projection from a fixed upper-left key light onto the panel surface.
// As the lens descends its shadow contracts, sharpens and retreats underneath it.
export function waterShadow(pressure) {
  const height=1-Math.max(0,Math.min(1,pressure));
  return {x:6*height,y:-8*height,softness:.55+2.65*height,opacity:.22*(.04+.96*height),scale:.975+.025*height};
}
