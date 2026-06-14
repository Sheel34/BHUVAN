import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { worldHeight } from '../engine/world';
import { missionControl, evalAlarm } from '../engine/telemetry';

const UP = new THREE.Vector3(0, 1, 0);
const ALARM_COLOR = { NOMINAL: '#34d399', WARN: '#f59e0b', CRITICAL: '#ef4444' };

function worstAlarm(params) {
  if (!params) return 'NOMINAL';
  let worst = 'NOMINAL';
  for (const [k, v] of Object.entries(params)) {
    const a = evalAlarm(k, v);
    if (a === 'CRITICAL') return 'CRITICAL';
    if (a === 'WARN') worst = 'WARN';
  }
  return worst;
}

/**
 * BHUVAN-1 — a drivable six-wheel rover. WASD / arrows drive it across the
 * whole world (DEM patch + procedural surround); it sits on the terrain,
 * leans to the slope, wheels spin with speed. Pose/telemetry feeds the same
 * mission bus the ops console reads. The camera follows while driving.
 */
export default function Rover({ terrain }) {
  const group = useRef();
  const wheels = useRef([]);
  const navRef = useRef();
  const lightRef = useRef();
  const telem = useRef(null);
  const keys = useRef({});
  const heading = useRef(2.0);
  const speed = useRef(0);
  const pos = useRef(new THREE.Vector3(0, 0, 0));
  const { controls } = useThree();

  const tmpN = useMemo(() => new THREE.Vector3(), []);
  const qSlope = useMemo(() => new THREE.Quaternion(), []);
  const qYaw = useMemo(() => new THREE.Quaternion(), []);
  const followTarget = useMemo(() => new THREE.Vector3(), []);

  const worldScale = terrain?.scale || 200;
  const S = worldScale * 0.011; // rover ~ a few metres across

  useEffect(() => {
    missionControl.start();
    const off = missionControl.subscribe((p) => { telem.current = p; });
    const dn = (e) => { keys.current[e.key.toLowerCase()] = true; };
    const up = (e) => { keys.current[e.key.toLowerCase()] = false; };
    window.addEventListener('keydown', dn);
    window.addEventListener('keyup', up);
    return () => {
      off(); missionControl.stop();
      window.removeEventListener('keydown', dn);
      window.removeEventListener('keyup', up);
    };
  }, []);

  useFrame((state, dt) => {
    if (!group.current || !terrain) return;
    const k = keys.current;
    const t = state.clock.elapsedTime;
    const fwd = (k['w'] || k['arrowup'] ? 1 : 0) - (k['s'] || k['arrowdown'] ? 1 : 0);
    const turn = (k['a'] || k['arrowleft'] ? 1 : 0) - (k['d'] || k['arrowright'] ? 1 : 0);

    const maxSpeed = worldScale * 0.16;
    speed.current += (fwd * maxSpeed - speed.current) * Math.min(1, dt * 2.5);
    if (Math.abs(speed.current) > 0.01) heading.current += turn * dt * 0.9 * Math.sign(speed.current || 1);
    else heading.current += turn * dt * 0.6;

    pos.current.x += Math.sin(heading.current) * speed.current * dt;
    pos.current.z += Math.cos(heading.current) * speed.current * dt;
    const lim = worldScale * 5.5; // roam far past the patch, into the world
    pos.current.x = Math.max(-lim, Math.min(lim, pos.current.x));
    pos.current.z = Math.max(-lim, Math.min(lim, pos.current.z));

    const x = pos.current.x, z = pos.current.z;
    const gy = worldHeight(terrain, x, z);
    const e = worldScale * 0.008;
    const hx = (worldHeight(terrain, x + e, z) - worldHeight(terrain, x - e, z)) / (2 * e);
    const hz = (worldHeight(terrain, x, z + e) - worldHeight(terrain, x, z - e)) / (2 * e);
    tmpN.set(-hx, 1, -hz).normalize();

    group.current.position.set(x, gy + S * 0.35, z);
    qSlope.setFromUnitVectors(UP, tmpN);
    qYaw.setFromAxisAngle(UP, -heading.current);
    group.current.quaternion.copy(qSlope).multiply(qYaw);

    // wheels spin with travel
    const spin = (speed.current * dt) / (S * 0.32);
    wheels.current.forEach((w) => { if (w) w.rotation.x += spin; });

    // camera follows while driving
    if (controls && (fwd !== 0 || turn !== 0)) {
      followTarget.set(x, gy, z);
      controls.target.lerp(followTarget, Math.min(1, dt * 2));
      controls.update();
    }

    // status light by worst alarm
    const sev = worstAlarm(telem.current?.params);
    const col = ALARM_COLOR[sev];
    const blink = 0.5 + 0.5 * Math.sin(t * (sev === 'CRITICAL' ? 9 : sev === 'WARN' ? 5 : 2.2));
    if (navRef.current) { navRef.current.material.color.set(col); navRef.current.material.opacity = 0.4 + blink * 0.6; }
    if (lightRef.current) { lightRef.current.color.set(col); lightRef.current.intensity = (0.4 + blink) * S * 5; }
  });

  const body = '#d8d6cf';
  const dark = '#34343a';
  // wheel local positions: 3 per side
  const wheelPos = [-1, 0, 1].flatMap((rowi) => [-1, 1].map((side) => [side * S * 1.15, S * 0.42, rowi * S * 1.15]));
  let wIdx = 0;

  return (
    <group ref={group}>
      {/* chassis */}
      <mesh position={[0, S * 1.0, 0]} castShadow>
        <boxGeometry args={[S * 1.7, S * 0.6, S * 2.6]} />
        <meshStandardMaterial color={body} metalness={0.3} roughness={0.55} />
      </mesh>
      {/* warm-electronics box / RTG at rear */}
      <mesh position={[0, S * 1.2, -S * 1.55]} castShadow>
        <boxGeometry args={[S * 0.8, S * 0.5, S * 0.6]} />
        <meshStandardMaterial color={dark} metalness={0.5} roughness={0.5} />
      </mesh>

      {/* six wheels + rocker bars */}
      {wheelPos.map((p, i) => {
        const idx = wIdx++;
        return (
          <group key={i}>
            <mesh
              ref={(el) => { wheels.current[idx] = el; }}
              position={p}
              rotation={[0, 0, Math.PI / 2]}
              castShadow
            >
              <cylinderGeometry args={[S * 0.42, S * 0.42, S * 0.34, 16]} />
              <meshStandardMaterial color="#26262b" metalness={0.2} roughness={0.85} />
            </mesh>
            {/* hub */}
            <mesh position={[p[0], p[1], p[2]]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[S * 0.16, S * 0.16, S * 0.36, 8]} />
              <meshStandardMaterial color="#8a8a90" metalness={0.6} roughness={0.4} />
            </mesh>
            {/* strut to chassis */}
            <mesh position={[p[0] * 0.7, S * 0.72, p[2]]} rotation={[0, 0, p[0] > 0 ? -0.5 : 0.5]}>
              <cylinderGeometry args={[S * 0.06, S * 0.06, S * 0.8, 6]} />
              <meshStandardMaterial color="#6a6a72" metalness={0.6} roughness={0.45} />
            </mesh>
          </group>
        );
      })}

      {/* camera mast + head (the "face") */}
      <mesh position={[0, S * 1.9, S * 0.9]} castShadow>
        <cylinderGeometry args={[S * 0.07, S * 0.08, S * 1.4, 8]} />
        <meshStandardMaterial color="#9a9aa2" metalness={0.6} roughness={0.4} />
      </mesh>
      <mesh position={[0, S * 2.65, S * 0.9]} castShadow>
        <boxGeometry args={[S * 0.7, S * 0.32, S * 0.3]} />
        <meshStandardMaterial color={dark} metalness={0.5} roughness={0.5} />
      </mesh>
      {/* two camera eyes */}
      {[-1, 1].map((sx) => (
        <mesh key={sx} position={[sx * S * 0.2, S * 2.65, S * 1.06]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[S * 0.07, S * 0.07, S * 0.06, 12]} />
          <meshStandardMaterial color="#10131a" metalness={0.2} roughness={0.2} emissive="#0a1a2a" />
        </mesh>
      ))}

      {/* folded robotic arm at front */}
      <mesh position={[S * 0.3, S * 0.85, S * 1.5]} rotation={[Math.PI / 3, 0, 0]} castShadow>
        <cylinderGeometry args={[S * 0.07, S * 0.07, S * 1.2, 8]} />
        <meshStandardMaterial color="#b8b6af" metalness={0.4} roughness={0.5} />
      </mesh>
      <mesh position={[S * 0.3, S * 0.35, S * 2.05]} castShadow>
        <boxGeometry args={[S * 0.28, S * 0.28, S * 0.28]} />
        <meshStandardMaterial color={dark} metalness={0.5} roughness={0.5} />
      </mesh>

      {/* high-gain antenna */}
      <mesh position={[-S * 0.5, S * 1.7, -S * 0.9]} rotation={[0, 0, -0.4]} castShadow>
        <coneGeometry args={[S * 0.34, S * 0.16, 16, 1, true]} />
        <meshStandardMaterial color="#d8d8de" metalness={0.4} roughness={0.5} side={THREE.DoubleSide} />
      </mesh>

      {/* status nav light + local glow */}
      <mesh ref={navRef} position={[0, S * 1.5, 0]}>
        <sphereGeometry args={[S * 0.12, 12, 12]} />
        <meshBasicMaterial color="#34d399" transparent toneMapped={false} />
      </mesh>
      <pointLight ref={lightRef} position={[0, S * 1.7, 0]} distance={S * 12} color="#34d399" intensity={S * 3} />

      {/* ID tag */}
      <Html distanceFactor={worldScale * 0.5} position={[0, S * 3.4, 0]} style={{ pointerEvents: 'none' }} center>
        <div className="twin-tag">BHUVAN-1 ROVER</div>
      </Html>
    </group>
  );
}
