/* ── 6DOF Mars Lander Physics Engine ── */

const MARS_GRAVITY = 3.72;       // m/s²
const MAX_THRUST_ACCEL = 15.0;   // m/s² acceleration at full throttle
const FUEL_BURN_RATE = 1.2;      // kg/s at full throttle
const INITIAL_FUEL = 120;        // kg
const SAFE_LANDING_SPEED = 3.5;  // m/s
const DRY_MASS = 450;            // kg (lander without fuel)
const RCS_THRUST_ACCEL = 4.5;    // m/s² per RCS thruster pair
const RCS_FUEL_RATE = 0.08;      // kg/s per active RCS pair

// Moment of inertia for a cylinder-like lander (kg·m²)
const IXX = 80;
const IYY = 60;
const IZZ = 80;

// Attitude control gains (PID)
const ATTITUDE_KP = 12.0;
const ATTITUDE_KD = 6.0;
const MAX_ANGULAR_RATE = 1.2;    // rad/s

/* ── Quaternion utilities ── */
function quatMultiply(q1, q2) {
  return [
    q1[0] * q2[0] - q1[1] * q2[1] - q1[2] * q2[2] - q1[3] * q2[3],
    q1[0] * q2[1] + q1[1] * q2[0] + q1[2] * q2[3] - q1[3] * q2[2],
    q1[0] * q2[2] - q1[1] * q2[3] + q1[2] * q2[0] + q1[3] * q2[1],
    q1[0] * q2[3] + q1[1] * q2[2] - q1[2] * q2[1] + q1[3] * q2[0],
  ];
}

function quatNormalize(q) {
  const len = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  if (len < 1e-8) return [1, 0, 0, 0];
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

function quatFromAxisAngle(axis, angle) {
  const halfAngle = angle * 0.5;
  const s = Math.sin(halfAngle);
  return [Math.cos(halfAngle), axis[0] * s, axis[1] * s, axis[2] * s];
}

function quatToEuler(q) {
  // Returns [pitch, yaw, roll] in radians (YXZ convention)
  const sinp = 2 * (q[0] * q[2] - q[3] * q[1]);
  const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(sinp);
  const yaw = Math.atan2(2 * (q[0] * q[3] + q[1] * q[2]), 1 - 2 * (q[2] * q[2] + q[3] * q[3]));
  const roll = Math.atan2(2 * (q[0] * q[1] + q[2] * q[3]), 1 - 2 * (q[1] * q[1] + q[2] * q[2]));
  return [pitch, yaw, roll];
}

function quatRotateVector(q, v) {
  const qv = [0, v[0], v[1], v[2]];
  const qConj = [q[0], -q[1], -q[2], -q[3]];
  const result = quatMultiply(quatMultiply(q, qv), qConj);
  return [result[1], result[2], result[3]];
}

/* ── 6DOF Lander State ── */
export function createLanderState(startX = 0, startZ = 0, altitude = 120) {
  return {
    // Position (world frame, metres)
    x: startX,
    y: altitude,
    z: startZ,
    // Velocity (world frame, m/s)
    vx: 0,
    vy: 0,
    vz: 0,
    // Attitude quaternion [w, x, y, z] (body → world)
    quat: [1, 0, 0, 0],
    // Angular velocity (body frame, rad/s)
    wx: 0,
    wy: 0,
    wz: 0,
    // Derived Euler angles (for rendering / HUD)
    pitch: 0,
    yaw: 0,
    roll: 0,
    // Resources
    fuel: INITIAL_FUEL,
    throttle: 0,
    // RCS input commands (-1..1 each axis)
    rcsX: 0,
    rcsZ: 0,
    rcsYaw: 0,
    // Attitude commands from guidance (-1..1)
    pitchCmd: 0,
    rollCmd: 0,
    // Legacy lateral inputs (mapped to RCS)
    lateralX: 0,
    lateralZ: 0,
    // Status
    landed: false,
    crashed: false,
    missionTime: 0,
    maxDescentRate: 0,
    impactSpeed: 0,
    touchdownRisk: 0,
    touchdownTraversability: 0,
    touchdownAssessment: 'pending',
    // Guidance telemetry
    guidanceMode: 'none',
    targetX: startX,
    targetZ: startZ,
  };
}

/* ── 6DOF Rigid Body Update ── */
export function updateLander(state, dt, groundHeight, surfaceAssessment = {}) {
  if (state.landed || state.crashed) return state;

  const s = { ...state, quat: [...state.quat] };
  s.missionTime += dt;

  const totalMass = DRY_MASS + s.fuel;

  // ── Gravity (world frame) ──
  s.vy -= MARS_GRAVITY * dt;

  // ── Main engine thrust ──
  // Thrust vector is along body -Y axis (downward in body frame)
  // Rotated to world frame by attitude quaternion
  if (s.fuel > 0 && s.throttle > 0) {
    const thrustAccel = s.throttle * MAX_THRUST_ACCEL;
    // Thrust direction in body frame: [0, 1, 0] (upward in body)
    const thrustWorld = quatRotateVector(s.quat, [0, thrustAccel, 0]);
    s.vx += thrustWorld[0] * dt;
    s.vy += thrustWorld[1] * dt;
    s.vz += thrustWorld[2] * dt;
    s.fuel = Math.max(0, s.fuel - s.throttle * FUEL_BURN_RATE * dt);
  }

  // ── RCS thrusters (attitude + lateral translation) ──
  if (s.fuel > 0) {
    // Map legacy lateral inputs to RCS
    const rcsX = s.rcsX || s.lateralX || 0;
    const rcsZ = s.rcsZ || s.lateralZ || 0;
    const rcsYaw = s.rcsYaw || 0;

    // Translational RCS (lateral acceleration in body frame, rotated to world)
    if (rcsX !== 0 || rcsZ !== 0) {
      const rcsAccelBody = [rcsX * RCS_THRUST_ACCEL, 0, rcsZ * RCS_THRUST_ACCEL];
      const rcsAccelWorld = quatRotateVector(s.quat, rcsAccelBody);
      s.vx += rcsAccelWorld[0] * dt;
      s.vy += rcsAccelWorld[1] * dt;
      s.vz += rcsAccelWorld[2] * dt;
      s.fuel = Math.max(0, s.fuel - (Math.abs(rcsX) + Math.abs(rcsZ)) * RCS_FUEL_RATE * dt);
    }

    // Yaw RCS (torque about body Y axis)
    if (rcsYaw !== 0) {
      s.wy += rcsYaw * RCS_THRUST_ACCEL * 2.0 * dt / IYY;
      s.fuel = Math.max(0, s.fuel - Math.abs(rcsYaw) * RCS_FUEL_RATE * dt);
    }
  }

  // ── Attitude dynamics (Euler's rotation equations) ──
  // Apply PID attitude control torques from guidance commands
  if (s.fuel > 0) {
    const pitchTorque = (s.pitchCmd || 0) * RCS_THRUST_ACCEL * 15.0;
    const rollTorque = (s.rollCmd || 0) * RCS_THRUST_ACCEL * 15.0;
    s.wx += pitchTorque * dt / IXX;
    s.wz += rollTorque * dt / IZZ;
    s.fuel = Math.max(0, s.fuel - (Math.abs(s.pitchCmd || 0) + Math.abs(s.rollCmd || 0)) * RCS_FUEL_RATE * dt);
  }

  // Torque-free precession + damping
  const angDamping = 0.8;
  s.wx -= (angDamping * s.wx + (IZZ - IYY) * s.wy * s.wz / IXX) * dt;
  s.wz -= (angDamping * s.wz + (IXX - IYY) * s.wx * s.wy / IZZ) * dt;
  s.wy -= (angDamping * s.wy + (IXX - IZZ) * s.wx * s.wz / IYY) * dt;

  // Clamp angular rates
  s.wx = Math.max(-MAX_ANGULAR_RATE, Math.min(MAX_ANGULAR_RATE, s.wx));
  s.wy = Math.max(-MAX_ANGULAR_RATE, Math.min(MAX_ANGULAR_RATE, s.wy));
  s.wz = Math.max(-MAX_ANGULAR_RATE, Math.min(MAX_ANGULAR_RATE, s.wz));

  // ── Update quaternion from angular velocity ──
  const angSpeed = Math.sqrt(s.wx * s.wx + s.wy * s.wy + s.wz * s.wz);
  if (angSpeed > 1e-8) {
    const axis = [s.wx / angSpeed, s.wy / angSpeed, s.wz / angSpeed];
    const dq = quatFromAxisAngle(axis, angSpeed * dt);
    s.quat = quatNormalize(quatMultiply(dq, s.quat));
  }

  // ── Thin atmospheric drag ──
  const drag = 0.002;
  s.vx *= (1 - drag);
  s.vz *= (1 - drag);

  // ── Update position ──
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  s.z += s.vz * dt;

  // ── Derive Euler angles for rendering ──
  const euler = quatToEuler(s.quat);
  s.pitch = euler[0];
  s.yaw = euler[1];
  s.roll = euler[2];

  // ── Track max descent rate ──
  if (-s.vy > s.maxDescentRate) s.maxDescentRate = -s.vy;

  // ── Ground collision ──
  if (s.y <= groundHeight + 1.5) {
    s.y = groundHeight + 1.5;
    s.impactSpeed = Math.sqrt(s.vx ** 2 + s.vy ** 2 + s.vz ** 2);
    s.touchdownRisk = surfaceAssessment.hazard ?? 0;
    s.touchdownTraversability = surfaceAssessment.traversability ?? 1;

    const terrainUnsafe = s.touchdownRisk > 0.62 || s.touchdownTraversability < 0.35;
    const hardTouchdown = Math.abs(s.vy) >= SAFE_LANDING_SPEED || s.impactSpeed >= SAFE_LANDING_SPEED * 2;

    // Also check attitude at touchdown (tilted landings are dangerous)
    const tiltAngle = Math.acos(Math.min(1, Math.abs(s.quat[0]))) * 2;
    const attitudeUnsafe = tiltAngle > 0.35; // ~20 degrees

    if (!terrainUnsafe && !hardTouchdown && !attitudeUnsafe) {
      s.landed = true;
      s.touchdownAssessment = 'safe';
    } else if (!terrainUnsafe && s.impactSpeed < SAFE_LANDING_SPEED * 2.5 && !attitudeUnsafe) {
      s.landed = true;
      s.touchdownAssessment = 'marginal';
    } else {
      s.crashed = true;
      s.touchdownAssessment = terrainUnsafe ? 'hazardous' : attitudeUnsafe ? 'tilt-impact' : 'hard-impact';
    }
    s.vx = 0;
    s.vy = 0;
    s.vz = 0;
    s.wx = 0;
    s.wy = 0;
    s.wz = 0;
  }

  return s;
}

/* ── Hazard-Aware MPC Guidance ── */
export function computeAutopilot(state, groundHeight, hazardField = null, terrain = null) {
  const altitude = state.y - groundHeight;
  const descentRate = -state.vy;

  // Required deceleration for suicide burn
  const reqDecel = (descentRate * descentRate) / (2 * Math.max(altitude, 1)) + MARS_GRAVITY;
  const reqThrottle = reqDecel / MAX_THRUST_ACCEL;

  let throttle = 0;
  let rcsX = 0;
  let rcsZ = 0;
  let rcsYaw = 0;
  let guidanceMode = 'suicide-burn';

  // ── Hazard-aware lateral correction ──
  // If hazard field is available, steer away from high-hazard areas
  let hazardAvoidX = 0;
  let hazardAvoidZ = 0;
  if (hazardField && terrain) {
    const lookAheadTime = 1.5; // seconds
    const sampleDist = Math.max(8, Math.sqrt(state.vx**2 + state.vz**2) * lookAheadTime);
    const numSamples = 12;
    
    // Sample a ring around the projected position
    const projX = state.x + state.vx * lookAheadTime;
    const projZ = state.z + state.vz * lookAheadTime;
    
    for (let i = 0; i < numSamples; i++) {
      const angle = (i / numSamples) * Math.PI * 2;
      const sx = projX + Math.cos(angle) * 4;
      const sz = projZ + Math.sin(angle) * 4;
      const h = sampleRasterValue(hazardField, terrain, sx, sz);
      // Repulsion: push away from high hazard
      hazardAvoidX -= Math.cos(angle) * h * 3.5;
      hazardAvoidZ -= Math.sin(angle) * h * 3.5;
    }
    
    // Also repel from current projected position if it's hazardous
    const centerH = sampleRasterValue(hazardField, terrain, projX, projZ);
    if (centerH > 0.4) {
        // Gradient descent step (simplified: sample 4 nearby points)
        const d = 2.0;
        const hN = sampleRasterValue(hazardField, terrain, projX, projZ - d);
        const hS = sampleRasterValue(hazardField, terrain, projX, projZ + d);
        const hE = sampleRasterValue(hazardField, terrain, projX + d, projZ);
        const hW = sampleRasterValue(hazardField, terrain, projX - d, projZ);
        hazardAvoidX += (hW - hE) * 5.0;
        hazardAvoidZ += (hN - hS) * 5.0;
    }
  }

  // ── Target-seeking lateral correction ──
  const dx = state.targetX - state.x;
  const dz = state.targetZ - state.z;
  const distToTarget = Math.sqrt(dx * dx + dz * dz);
  // Target seeking becomes less important if we are high and focusing on hazard avoidance
  // But becomes critical as we get low for a precision landing.
  const targetGain = altitude < 20 ? 1.5 : (altitude < 50 ? 0.8 : 0.4);

  // ── Altitude-based throttle logic ──
  if (altitude > 80) {
    // High altitude: begin early braking if falling fast
    throttle = descentRate > 10 ? 0.5 : descentRate > 5 ? 0.2 : 0;
    guidanceMode = 'high-alt-braking';
  } else if (altitude > 30) {
    // Mid altitude: active braking + hazard avoidance
    throttle = Math.min(1, reqThrottle * 1.05);
    guidanceMode = 'active-braking';
  } else if (altitude > 8) {
    // Low altitude: precision deceleration
    throttle = Math.min(1, reqThrottle * 1.12);
    if (descentRate < 2.0) {
      throttle = MARS_GRAVITY / MAX_THRUST_ACCEL + 0.02;
      if (descentRate < 1.0) throttle = MARS_GRAVITY / MAX_THRUST_ACCEL - 0.04;
    }
    guidanceMode = 'precision-approach';
  } else {
    // Final approach: gentle touchdown
    if (descentRate > 1.5) {
      throttle = Math.min(1, reqThrottle * 1.15);
    } else if (descentRate > 0.6) {
      throttle = MARS_GRAVITY / MAX_THRUST_ACCEL;
    } else {
      throttle = Math.max(0.1, MARS_GRAVITY / MAX_THRUST_ACCEL - 0.08);
    }
    guidanceMode = 'final-approach';
  }

  // ── Combine lateral corrections ──
  // Target-seeking + hazard avoidance + velocity damping
  // Damping is crucial to prevent oscillations
  const damping = altitude < 20 ? 1.2 : 0.8;
  rcsX = (dx / Math.max(distToTarget, 1)) * targetGain + hazardAvoidX - state.vx * damping;
  rcsZ = (dz / Math.max(distToTarget, 1)) * targetGain + hazardAvoidZ - state.vz * damping;
  
  // Limit lateral thrust
  const maxLateral = 1.5;
  const lateralMag = Math.sqrt(rcsX**2 + rcsZ**2);
  if (lateralMag > maxLateral) {
      rcsX = (rcsX / lateralMag) * maxLateral;
      rcsZ = (rcsZ / lateralMag) * maxLateral;
  }

  // ── Attitude control (PID) ──
  // Target attitude: upright (zero pitch/roll), yaw toward target
  const targetYaw = Math.atan2(dx, dz);
  const yawError = targetYaw - state.yaw;
  // Normalize yaw error to [-PI, PI]
  const normalizedYawError = Math.atan2(Math.sin(yawError), Math.cos(yawError));
  rcsYaw = (ATTITUDE_KP * 1.5) * normalizedYawError - (ATTITUDE_KD * 0.8) * state.wy;
  rcsYaw = Math.max(-1, Math.min(1, rcsYaw));

  // Pitch/roll attitude commands (normalized -1..1) — applied in updateLander
  const pitchCmd = Math.max(-1, Math.min(1, -ATTITUDE_KP * 1.2 * state.pitch - ATTITUDE_KD * 0.8 * state.wx));
  const rollCmd = Math.max(-1, Math.min(1, -ATTITUDE_KP * 1.2 * state.roll - ATTITUDE_KD * 0.8 * state.wz));

  return { throttle, lateralX: rcsX, lateralZ: rcsZ, rcsYaw, pitchCmd, rollCmd, guidanceMode };
}

/* ── Helper: sample hazard raster at world position ── */
function sampleRasterValue(raster, terrain, wx, wz) {
  const source = raster?.data || raster;
  if (!source) return 0;
  const { size, scale } = terrain;
  if (source.length !== size * size) return 0;
  const fi = (wx / scale + 0.5) * (size - 1);
  const fj = (wz / scale + 0.5) * (size - 1);
  const i = Math.max(0, Math.min(size - 1, Math.round(fi)));
  const j = Math.max(0, Math.min(size - 1, Math.round(fj)));
  return source[i * size + j];
}

export const CONSTANTS = {
  MARS_GRAVITY,
  MAX_THRUST: MAX_THRUST_ACCEL,
  FUEL_BURN_RATE,
  INITIAL_FUEL,
  SAFE_LANDING_SPEED,
  DRY_MASS,
  IXX,
  IYY,
  IZZ,
  RCS_THRUST_ACCEL,
};
