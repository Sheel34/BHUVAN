/* ── Mars Lander Physics Engine ── */

const MARS_GRAVITY = 3.72; // m/s²
const MAX_THRUST = 12.0;   // m/s² acceleration at full throttle
const FUEL_BURN_RATE = 0.8; // kg/s at full throttle
const INITIAL_FUEL = 100;   // kg
const SAFE_LANDING_SPEED = 3.0; // m/s
const MAX_TILT = 0.3;       // radians

export function createLanderState(startX = 0, startZ = 0, altitude = 120) {
  return {
    // Position (world units)
    x: startX,
    y: altitude,
    z: startZ,
    // Velocity
    vx: 0,
    vy: 0,
    vz: 0,
    // Rotation (euler)
    pitch: 0,
    yaw: 0,
    roll: 0,
    // Resources
    fuel: INITIAL_FUEL,
    throttle: 0,          // 0..1
    // Lateral thrust input
    lateralX: 0,          // -1..1
    lateralZ: 0,          // -1..1
    // Status
    landed: false,
    crashed: false,
    missionTime: 0,
    maxDescentRate: 0,
    impactSpeed: 0,
    touchdownRisk: 0,
    touchdownTraversability: 0,
    touchdownAssessment: 'pending',
  };
}

export function updateLander(state, dt, groundHeight, surfaceAssessment = {}) {
  if (state.landed || state.crashed) return state;

  const s = { ...state };
  s.missionTime += dt;

  // Gravity
  s.vy -= MARS_GRAVITY * dt;

  // Main engine thrust (upward)
  if (s.fuel > 0 && s.throttle > 0) {
    const thrustAccel = s.throttle * MAX_THRUST;
    s.vy += thrustAccel * dt;
    s.fuel = Math.max(0, s.fuel - s.throttle * FUEL_BURN_RATE * dt);
  }

  // Lateral thrust (RCS)
  if (s.fuel > 0) {
    const lateralForce = 4.0;
    if (s.lateralX !== 0) {
      s.vx += s.lateralX * lateralForce * dt;
      s.fuel = Math.max(0, s.fuel - Math.abs(s.lateralX) * 0.1 * dt);
    }
    if (s.lateralZ !== 0) {
      s.vz += s.lateralZ * lateralForce * dt;
      s.fuel = Math.max(0, s.fuel - Math.abs(s.lateralZ) * 0.1 * dt);
    }
  }

  // Air resistance (thin atmosphere)
  const drag = 0.002;
  s.vx *= (1 - drag);
  s.vz *= (1 - drag);

  // Update position
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  s.z += s.vz * dt;

  // Tilt based on lateral velocity
  s.pitch = Math.max(-MAX_TILT, Math.min(MAX_TILT, -s.vz * 0.04));
  s.roll = Math.max(-MAX_TILT, Math.min(MAX_TILT, s.vx * 0.04));

  // Track max descent rate
  if (-s.vy > s.maxDescentRate) s.maxDescentRate = -s.vy;

  // Ground collision
  if (s.y <= groundHeight + 1.5) {
    s.y = groundHeight + 1.5;
    s.impactSpeed = Math.sqrt(s.vx ** 2 + s.vy ** 2 + s.vz ** 2);
    s.touchdownRisk = surfaceAssessment.hazard ?? 0;
    s.touchdownTraversability = surfaceAssessment.traversability ?? 1;

    const terrainUnsafe = s.touchdownRisk > 0.62 || s.touchdownTraversability < 0.35;
    const hardTouchdown = Math.abs(s.vy) >= SAFE_LANDING_SPEED || s.impactSpeed >= SAFE_LANDING_SPEED * 2;

    if (!terrainUnsafe && !hardTouchdown) {
      s.landed = true;
      s.touchdownAssessment = 'safe';
    } else if (!terrainUnsafe && s.impactSpeed < SAFE_LANDING_SPEED * 2.5) {
      s.landed = true;
      s.touchdownAssessment = 'marginal';
    } else {
      s.crashed = true;
      s.touchdownAssessment = terrainUnsafe ? 'hazardous' : 'hard-impact';
    }
    s.vx = 0;
    s.vy = 0;
    s.vz = 0;
  }

  return s;
}

/* ── Simple autopilot (gravity turn / suicide burn) ── */
export function computeAutopilot(state, groundHeight) {
  const altitude = state.y - groundHeight;
  const descentRate = -state.vy;

  // Compute ideal throttle
  // Time to ground at current descent rate
  const ttg = altitude / Math.max(descentRate, 0.1);
  // Required deceleration to stop at ground level
  const reqDecel = (descentRate * descentRate) / (2 * Math.max(altitude, 1)) + MARS_GRAVITY;
  const reqThrottle = reqDecel / MAX_THRUST;

  let throttle = 0;

  if (altitude > 80) {
    // High altitude: begin early braking if falling fast
    throttle = descentRate > 10 ? 0.5 : descentRate > 5 ? 0.2 : 0;
  } else if (altitude > 30) {
    // Mid altitude: active braking
    throttle = Math.min(1, reqThrottle * 1.1);
  } else if (altitude > 8) {
    // Low altitude: precision deceleration
    throttle = Math.min(1, reqThrottle * 1.15);
    if (descentRate < 2.0) {
      // Hover descent
      throttle = MARS_GRAVITY / MAX_THRUST + 0.01;
      if (descentRate < 1.0) throttle = MARS_GRAVITY / MAX_THRUST - 0.03;
    }
  } else {
    // Final approach: gentle touchdown
    if (descentRate > 2.0) {
      throttle = Math.min(1, reqThrottle * 1.2);
    } else if (descentRate > 0.8) {
      throttle = MARS_GRAVITY / MAX_THRUST;
    } else {
      throttle = Math.max(0.15, MARS_GRAVITY / MAX_THRUST - 0.05);
    }
  }

  // Lateral correction: try to zero out lateral velocity
  let lateralX = -state.vx * 0.5;
  let lateralZ = -state.vz * 0.5;
  lateralX = Math.max(-1, Math.min(1, lateralX));
  lateralZ = Math.max(-1, Math.min(1, lateralZ));

  return { throttle, lateralX, lateralZ };
}

export const CONSTANTS = {
  MARS_GRAVITY,
  MAX_THRUST,
  FUEL_BURN_RATE,
  INITIAL_FUEL,
  SAFE_LANDING_SPEED,
};
