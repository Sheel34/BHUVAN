import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
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
 * BHUVAN-1 — the surface asset (digital twin), parked on the analyzed site
 * for scale and live telemetry. Sits on the terrain, leaned to the local
 * slope; status light driven by the mission telemetry bus. Not a game piece —
 * a fixed reference on the surface under survey.
 */
export default function Rover({ terrain }) {
  const navRef = useRef();
  const lightRef = useRef();
  const telem = useRef(null);

  const worldScale = terrain?.scale || 200;
  const S = worldScale * 0.011; // a few metres across

  // Parked pose: a spot on the patch, sitting on the surface, leaned to slope.
  const { position, quaternion } = useMemo(() => {
    const px = worldScale * 0.06;
    const pz = -worldScale * 0.04;
    const gy = worldHeight(terrain, px, pz);
    const e = worldScale * 0.008;
    const hx = (worldHeight(terrain, px + e, pz) - worldHeight(terrain, px - e, pz)) / (2 * e);
    const hz = (worldHeight(terrain, px, pz + e) - worldHeight(terrain, px, pz - e)) / (2 * e);
    const normal = new THREE.Vector3(-hx, 1, -hz).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(UP, normal);
    return { position: [px, gy + S * 0.35, pz], quaternion: q };
  }, [terrain, worldScale, S]);

  useEffect(() => {
    missionControl.start();
    const off = missionControl.subscribe((p) => { telem.current = p; });
    return () => { off(); missionControl.stop(); };
  }, []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const p = telem.current;
    const sev = worstAlarm(p?.params);
    const col = ALARM_COLOR[sev];
    const blink = 0.5 + 0.5 * Math.sin(t * (sev === 'CRITICAL' ? 9 : sev === 'WARN' ? 5 : 2.2));
    if (navRef.current) { navRef.current.material.color.set(col); navRef.current.material.opacity = 0.4 + blink * 0.6; }
    if (lightRef.current) { lightRef.current.color.set(col); lightRef.current.intensity = (0.4 + blink) * S * 5; }
  });

  const body = '#d8d6cf';
  const dark = '#34343a';
  const wheelPos = [-1, 0, 1].flatMap((rowi) => [-1, 1].map((side) => [side * S * 1.15, S * 0.42, rowi * S * 1.15]));

  return (
    <group position={position} quaternion={quaternion}>
      {/* chassis */}
      <mesh position={[0, S * 1.0, 0]} castShadow>
        <boxGeometry args={[S * 1.7, S * 0.6, S * 2.6]} />
        <meshStandardMaterial color={body} metalness={0.3} roughness={0.55} />
      </mesh>
      <mesh position={[0, S * 1.2, -S * 1.55]} castShadow>
        <boxGeometry args={[S * 0.8, S * 0.5, S * 0.6]} />
        <meshStandardMaterial color={dark} metalness={0.5} roughness={0.5} />
      </mesh>

      {/* six wheels + struts */}
      {wheelPos.map((wp, i) => (
        <group key={i}>
          <mesh position={wp} rotation={[0, 0, Math.PI / 2]} castShadow>
            <cylinderGeometry args={[S * 0.42, S * 0.42, S * 0.34, 16]} />
            <meshStandardMaterial color="#26262b" metalness={0.2} roughness={0.85} />
          </mesh>
          <mesh position={[wp[0], wp[1], wp[2]]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[S * 0.16, S * 0.16, S * 0.36, 8]} />
            <meshStandardMaterial color="#8a8a90" metalness={0.6} roughness={0.4} />
          </mesh>
          <mesh position={[wp[0] * 0.7, S * 0.72, wp[2]]} rotation={[0, 0, wp[0] > 0 ? -0.5 : 0.5]}>
            <cylinderGeometry args={[S * 0.06, S * 0.06, S * 0.8, 6]} />
            <meshStandardMaterial color="#6a6a72" metalness={0.6} roughness={0.45} />
          </mesh>
        </group>
      ))}

      {/* camera mast + head */}
      <mesh position={[0, S * 1.9, S * 0.9]} castShadow>
        <cylinderGeometry args={[S * 0.07, S * 0.08, S * 1.4, 8]} />
        <meshStandardMaterial color="#9a9aa2" metalness={0.6} roughness={0.4} />
      </mesh>
      <mesh position={[0, S * 2.65, S * 0.9]} castShadow>
        <boxGeometry args={[S * 0.7, S * 0.32, S * 0.3]} />
        <meshStandardMaterial color={dark} metalness={0.5} roughness={0.5} />
      </mesh>
      {[-1, 1].map((sx) => (
        <mesh key={sx} position={[sx * S * 0.2, S * 2.65, S * 1.06]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[S * 0.07, S * 0.07, S * 0.06, 12]} />
          <meshStandardMaterial color="#10131a" metalness={0.2} roughness={0.2} emissive="#0a1a2a" />
        </mesh>
      ))}

      {/* high-gain antenna */}
      <mesh position={[-S * 0.5, S * 1.7, -S * 0.9]} rotation={[0, 0, -0.4]} castShadow>
        <coneGeometry args={[S * 0.34, S * 0.16, 16, 1, true]} />
        <meshStandardMaterial color="#d8d8de" metalness={0.4} roughness={0.5} side={THREE.DoubleSide} />
      </mesh>

      {/* status light */}
      <mesh ref={navRef} position={[0, S * 1.5, 0]}>
        <sphereGeometry args={[S * 0.12, 12, 12]} />
        <meshBasicMaterial color="#34d399" transparent toneMapped={false} />
      </mesh>
      <pointLight ref={lightRef} position={[0, S * 1.7, 0]} distance={S * 12} color="#34d399" intensity={S * 3} />

      <Html distanceFactor={worldScale * 0.5} position={[0, S * 3.4, 0]} style={{ pointerEvents: 'none' }} center>
        <div className="twin-tag">BHUVAN-1 ROVER</div>
      </Html>
    </group>
  );
}
