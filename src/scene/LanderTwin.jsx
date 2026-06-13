import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { sampleHeight } from '../engine/terrain';
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
 * BHUVAN-1 digital twin: a lander rendered to true scale on the surface and
 * driven LIVE by the telemetry bus — same source the ops console reads. It is
 * deliberately tiny against the terrain: that contrast is the point.
 */
export default function LanderTwin({ terrain }) {
  const group = useRef();
  const lightRef = useRef();
  const navRef = useRef();
  const beamRef = useRef();
  const telem = useRef(null);
  const pos = useRef(new THREE.Vector3(0, 0, 0));
  const tmpQuat = useMemo(() => new THREE.Quaternion(), []);
  const tmpNormal = useMemo(() => new THREE.Vector3(), []);
  const yawQuat = useMemo(() => new THREE.Quaternion(), []);

  const worldScale = terrain?.scale || 200;
  // True-scale lander: a few metres on a hundreds-of-metres world.
  const S = worldScale * 0.012;

  // Subscribe to the live bus (also keeps it running while in the workspace).
  useEffect(() => {
    missionControl.start();
    const off = missionControl.subscribe((p) => { telem.current = p; });
    return () => { off(); missionControl.stop(); };
  }, []);

  useFrame((state, dt) => {
    if (!group.current || !terrain) return;
    const p = telem.current;
    const t = state.clock.elapsedTime;

    // Drive across the patch along the commanded heading when in DRIVING mode.
    const driving = p?.mode === 'DRIVING';
    const speed = driving ? worldScale * 0.03 : 0;
    const hdg = ((p?.pos?.heading || 0) * Math.PI) / 180;
    pos.current.x += Math.sin(hdg) * speed * dt;
    pos.current.z += Math.cos(hdg) * speed * dt;
    const lim = worldScale * 0.42;
    pos.current.x = Math.max(-lim, Math.min(lim, pos.current.x));
    pos.current.z = Math.max(-lim, Math.min(lim, pos.current.z));

    // Sit on the surface, leaning to the local slope.
    const x = pos.current.x;
    const z = pos.current.z;
    const gy = sampleHeight(terrain, x, z);
    const e = worldScale * 0.01;
    const hx = (sampleHeight(terrain, x + e, z) - sampleHeight(terrain, x - e, z)) / (2 * e);
    const hz = (sampleHeight(terrain, x, z + e) - sampleHeight(terrain, x, z - e)) / (2 * e);
    tmpNormal.set(-hx, 1, -hz).normalize();

    group.current.position.set(x, gy + S * 0.05, z);
    tmpQuat.setFromUnitVectors(UP, tmpNormal);
    yawQuat.setFromAxisAngle(UP, -hdg);
    group.current.quaternion.copy(tmpQuat).multiply(yawQuat);

    // Status light: colour by worst alarm, blink faster under fault.
    const sev = worstAlarm(p?.params);
    const col = ALARM_COLOR[sev];
    const blink = 0.5 + 0.5 * Math.sin(t * (sev === 'CRITICAL' ? 9 : sev === 'WARN' ? 5 : 2.2));
    if (navRef.current) {
      navRef.current.material.color.set(col);
      navRef.current.material.opacity = 0.4 + blink * 0.6;
    }
    if (lightRef.current) {
      lightRef.current.color.set(col);
      lightRef.current.intensity = (0.4 + blink) * S * 6;
    }
    // Comms beam visible only when the link is up.
    if (beamRef.current) {
      const up = p?.comms;
      beamRef.current.visible = !!up;
      if (up) beamRef.current.material.opacity = 0.12 + 0.12 * Math.sin(t * 3);
    }
  });

  const gold = '#caa64e';

  return (
    <group ref={group}>
      {/* descent stage — octagonal foil-wrapped body */}
      <mesh position={[0, S * 0.55, 0]} castShadow>
        <cylinderGeometry args={[S * 0.9, S * 1.05, S * 0.7, 8]} />
        <meshStandardMaterial color={gold} metalness={0.85} roughness={0.35} />
      </mesh>
      {/* top deck */}
      <mesh position={[0, S * 0.95, 0]} castShadow>
        <cylinderGeometry args={[S * 0.7, S * 0.85, S * 0.25, 8]} />
        <meshStandardMaterial color="#9a9aa2" metalness={0.6} roughness={0.5} />
      </mesh>
      {/* four landing legs + foot pads */}
      {[0, 1, 2, 3].map((i) => {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const lx = Math.cos(a) * S * 1.5;
        const lz = Math.sin(a) * S * 1.5;
        return (
          <group key={i}>
            <mesh position={[lx * 0.5, S * 0.35, lz * 0.5]} rotation={[0, -a, Math.PI / 5]} castShadow>
              <cylinderGeometry args={[S * 0.06, S * 0.06, S * 1.6, 6]} />
              <meshStandardMaterial color="#7d7d84" metalness={0.7} roughness={0.4} />
            </mesh>
            <mesh position={[lx, S * 0.02, lz]} castShadow>
              <cylinderGeometry args={[S * 0.28, S * 0.28, S * 0.08, 12]} />
              <meshStandardMaterial color="#5e5e64" metalness={0.5} roughness={0.6} />
            </mesh>
          </group>
        );
      })}
      {/* central mast + instrument head */}
      <mesh position={[0, S * 1.55, 0]} castShadow>
        <cylinderGeometry args={[S * 0.05, S * 0.05, S * 1.0, 6]} />
        <meshStandardMaterial color="#8a8a92" metalness={0.7} roughness={0.4} />
      </mesh>
      <mesh position={[0, S * 2.1, 0]} castShadow>
        <boxGeometry args={[S * 0.45, S * 0.3, S * 0.45]} />
        <meshStandardMaterial color="#3a3a42" metalness={0.5} roughness={0.5} />
      </mesh>
      {/* high-gain dish */}
      <mesh position={[S * 0.55, S * 1.7, 0]} rotation={[0, 0, -Math.PI / 4]} castShadow>
        <coneGeometry args={[S * 0.4, S * 0.18, 16, 1, true]} />
        <meshStandardMaterial color="#d8d8de" metalness={0.4} roughness={0.5} side={THREE.DoubleSide} />
      </mesh>

      {/* status nav light */}
      <mesh ref={navRef} position={[0, S * 2.35, 0]}>
        <sphereGeometry args={[S * 0.12, 12, 12]} />
        <meshBasicMaterial color="#34d399" transparent toneMapped={false} />
      </mesh>
      <pointLight ref={lightRef} position={[0, S * 2.4, 0]} distance={S * 14} color="#34d399" intensity={S * 3} />

      {/* comms beam to orbit */}
      <mesh ref={beamRef} position={[0, S * 18, 0]}>
        <cylinderGeometry args={[S * 0.03, S * 0.3, S * 32, 8, 1, true]} />
        <meshBasicMaterial color="#7fd8ff" transparent opacity={0.14} side={THREE.DoubleSide} depthWrite={false} toneMapped={false} />
      </mesh>

      {/* floating ID tag */}
      <Html distanceFactor={worldScale * 0.5} position={[0, S * 3.0, 0]} style={{ pointerEvents: 'none' }} center>
        <div className="twin-tag">BHUVAN-1</div>
      </Html>
    </group>
  );
}
