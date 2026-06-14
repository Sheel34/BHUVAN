import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { planIngress } from '../engine/ingress';

const EXPOSED = new THREE.Color('#ff5b5b');
const MASKED = new THREE.Color('#5fd0ff');
const FLIGHT_SECONDS = 14;

/* Enemy radar coverage — translucent dome + bright ground ring. */
function ThreatDome({ threat }) {
  return (
    <group position={[threat.x, 0, threat.z]}>
      <mesh position={[0, threat.y * 0.0, 0]}>
        <sphereGeometry args={[threat.radius, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshBasicMaterial color="#ff4d4d" transparent opacity={0.035} side={THREE.DoubleSide} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, threat.y - threat.radius + 2, 0]}>
        <ringGeometry args={[threat.radius * 0.97, threat.radius, 64]} />
        <meshBasicMaterial color="#ff6a6a" transparent opacity={0.5} side={THREE.DoubleSide} depthWrite={false} toneMapped={false} />
      </mesh>
      {/* radar mast */}
      <mesh position={[0, threat.y * 0.5, 0]}>
        <cylinderGeometry args={[threat.radius * 0.006, threat.radius * 0.006, threat.y, 6]} />
        <meshBasicMaterial color="#ff6a6a" toneMapped={false} />
      </mesh>
    </group>
  );
}

export default function Ingress({ terrain, playing, onDone }) {
  const { camera, controls } = useThree();
  const plan = useMemo(() => planIngress(terrain), [terrain]);
  const curve = useMemo(
    () => new THREE.CatmullRomCurve3(plan.routePoints.map((p) => new THREE.Vector3(p.x, p.y, p.z))),
    [plan],
  );

  // Route tube, vertex-coloured by radar exposure (red exposed / cyan masked).
  const tubeGeo = useMemo(() => {
    const TS = 260;
    const tubeR = terrain.scale * 0.004;
    const g = new THREE.TubeGeometry(curve, TS, tubeR, 8, false);
    const M = plan.routePoints.length;
    const radial = 8 + 1;
    const colors = new Float32Array(g.attributes.position.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i <= TS; i++) {
      const u = i / TS;
      const ri = Math.min(M - 1, Math.round(u * (M - 1)));
      c.copy(plan.routePoints[ri].exposed ? EXPOSED : MASKED);
      for (let j = 0; j < radial; j++) {
        const v = (i * radial + j) * 3;
        colors[v] = c.r; colors[v + 1] = c.g; colors[v + 2] = c.b;
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  }, [curve, plan, terrain.scale]);

  const dartRef = useRef();
  const flightT = useRef(0);
  const flying = useRef(false);
  const idleT = useRef(0);

  useEffect(() => {
    if (playing) { flightT.current = 0; flying.current = true; if (controls) controls.enabled = false; }
  }, [playing, controls]);

  const tmpAhead = useMemo(() => new THREE.Vector3(), []);
  const tmpPos = useMemo(() => new THREE.Vector3(), []);
  const tmpCam = useMemo(() => new THREE.Vector3(), []);

  useFrame((_, dt) => {
    const d = Math.min(dt, 0.05); // clamp — a backgrounded tab spikes dt
    let t;
    if (flying.current) {
      flightT.current = Math.min(1, flightT.current + d / FLIGHT_SECONDS);
      t = flightT.current;
    } else {
      idleT.current = (idleT.current + d * 0.04) % 1; // gentle idle preview
      t = idleT.current;
    }

    curve.getPointAt(t, tmpPos);
    curve.getPointAt(Math.min(1, t + 0.01), tmpAhead);
    if (dartRef.current) {
      dartRef.current.position.copy(tmpPos);
      dartRef.current.lookAt(tmpAhead);
    }

    if (flying.current) {
      // chase camera — behind + above the dart, looking ahead. Top Gun shot.
      const back = tmpPos.clone().sub(tmpAhead).normalize().multiplyScalar(terrain.scale * 0.05);
      tmpCam.copy(tmpPos).add(back); tmpCam.y += terrain.scale * 0.03;
      camera.position.lerp(tmpCam, Math.min(1, dt * 3));
      camera.lookAt(tmpAhead.x, tmpAhead.y, tmpAhead.z);
      if (flightT.current >= 1) {
        flying.current = false;
        if (controls) {
          controls.enabled = true;
          controls.target.set(plan.target.x, plan.target.y, plan.target.z);
          controls.update();
        }
        if (onDone) onDone();
      }
    }
  });

  const dartLen = terrain.scale * 0.018;

  return (
    <group>
      {plan.threats.map((th, i) => <ThreatDome key={i} threat={th} />)}

      {/* route */}
      <mesh geometry={tubeGeo}>
        <meshBasicMaterial vertexColors transparent opacity={0.92} toneMapped={false} />
      </mesh>

      {/* start pad */}
      <mesh position={[plan.start.x, plan.start.y, plan.start.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[dartLen * 0.6, dartLen, 32]} />
        <meshBasicMaterial color="#34d399" transparent opacity={0.8} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>

      {/* target + CEP */}
      <group position={[plan.target.x, plan.target.y + 1, plan.target.z]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[plan.cep * 0.96, plan.cep, 48]} />
          <meshBasicMaterial color="#ffce4d" transparent opacity={0.85} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[plan.cep * 0.45, plan.cep * 0.5, 32]} />
          <meshBasicMaterial color="#ffce4d" transparent opacity={0.6} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
        <Html distanceFactor={terrain.scale * 0.5} position={[0, dartLen * 2, 0]} style={{ pointerEvents: 'none' }} center>
          <div className="ingress-tag target">TARGET · CEP</div>
        </Html>
      </group>

      {/* the strike vehicle */}
      <group ref={dartRef}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <coneGeometry args={[dartLen * 0.35, dartLen, 12]} />
          <meshBasicMaterial color="#eaf2ff" toneMapped={false} />
        </mesh>
        <pointLight distance={terrain.scale * 0.12} intensity={terrain.scale * 0.04} color="#bcd8ff" />
      </group>

      <Html
        position={[plan.start.x, plan.start.y + dartLen * 3, plan.start.z]}
        distanceFactor={terrain.scale * 0.6}
        style={{ pointerEvents: 'none' }}
        center
      >
        <div className="ingress-tag">RADAR EXPOSURE {Math.round(plan.exposedFraction * 100)}%</div>
      </Html>
    </group>
  );
}
