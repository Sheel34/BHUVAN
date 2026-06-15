import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const DURATION = 12;
const VERDICT_COLOR = { HIT: '#34d399', MISS: '#f59e0b', CFIT: '#ef4444', LOST: '#9aa3b4' };

/**
 * Cinematic replay of a backend TERCOM run: the weapon flies the computed
 * trajectory (chase cam), TERCOM fix strips light up, and it ends at the
 * outcome — HIT / MISS / CFIT / LOST. Trajectory is real backend output.
 */
export default function TercomReplay({ terrain, result }) {
  const { camera, controls } = useThree();
  const scale = terrain.scale;
  const vcol = VERDICT_COLOR[result.verdict] || '#ffffff';

  const traj = result.trajectory || [];
  const pts = useMemo(
    () => traj.map((p) => new THREE.Vector3(p.nx * scale, p.alt_m, p.nz * scale)),
    [traj, scale],
  );
  const curve = useMemo(() => (pts.length > 1 ? new THREE.CatmullRomCurve3(pts) : null), [pts]);

  // Path tube coloured by nav error (cyan accurate → red drifted).
  const tubeGeo = useMemo(() => {
    if (!curve) return null;
    const TS = Math.min(320, pts.length * 4);
    const g = new THREE.TubeGeometry(curve, TS, scale * 0.0025, 6, false);
    const radial = 7;
    const M = traj.length;
    const colors = new Float32Array(g.attributes.position.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i <= TS; i++) {
      const u = i / TS;
      const ri = Math.min(M - 1, Math.round(u * (M - 1)));
      const e = Math.min(1, (traj[ri].err_m || 0) / (result.cep_m * 2 + 1));
      c.setRGB(0.35 + e * 0.6, 0.82 - e * 0.55, 0.95 - e * 0.7);
      for (let j = 0; j < radial; j++) {
        const v = (i * radial + j) * 3;
        colors[v] = c.r; colors[v + 1] = c.g; colors[v + 2] = c.b;
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  }, [curve, traj, result.cep_m, scale, pts.length]);

  const fixMarks = useMemo(() => (result.fixes || []).map((f) => {
    const tp = traj.reduce((a, b) => (Math.abs(b.t - f.t) < Math.abs(a.t - f.t) ? b : a), traj[0]);
    return { x: tp.nx * scale, y: tp.gnd_m, z: tp.nz * scale, residual: f.residual_m };
  }), [result.fixes, traj, scale]);

  const dartRef = useRef();
  const t = useRef(0);
  const done = useRef(false);
  const tmpAhead = useMemo(() => new THREE.Vector3(), []);
  const tmpCam = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => { t.current = 0; done.current = false; if (controls) controls.enabled = false; }, [result, controls]);

  useFrame((_, dt) => {
    if (!curve) return;
    const d = Math.min(dt, 0.05);
    if (!done.current) t.current = Math.min(1, t.current + d / DURATION);
    const tt = t.current;
    const pos = curve.getPointAt(tt);
    curve.getPointAt(Math.min(1, tt + 0.01), tmpAhead);
    if (dartRef.current) { dartRef.current.position.copy(pos); dartRef.current.lookAt(tmpAhead); }

    const dir = tmpAhead.clone().sub(pos).normalize();
    const side = dir.clone().cross(UP).normalize();
    tmpCam.copy(pos).addScaledVector(dir, -scale * 0.03).addScaledVector(side, Math.sin(tt * 8) * scale * 0.01);
    tmpCam.y += scale * 0.012;
    camera.position.lerp(tmpCam, Math.min(1, d * 4));
    camera.lookAt(pos.x, pos.y, pos.z);

    if (tt >= 1 && !done.current) {
      done.current = true;
      if (controls) { controls.enabled = true; controls.target.copy(pos); controls.update(); }
    }
  });

  const dartLen = scale * 0.016;
  const L = result.launch;
  const T = result.target;
  const launchY = traj[0]?.gnd_m ?? 0;
  const targetY = traj[traj.length - 1]?.gnd_m ?? 0;
  const impact = traj[traj.length - 1];

  return (
    <group>
      {tubeGeo && (
        <mesh geometry={tubeGeo}><meshBasicMaterial vertexColors toneMapped={false} /></mesh>
      )}

      {/* launch pad */}
      <mesh position={[L.nx * scale, launchY + 1, L.nz * scale]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[dartLen * 0.6, dartLen, 24]} />
        <meshBasicMaterial color="#34d399" transparent opacity={0.85} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>

      {/* target + CEP ring (radius = cep_m world metres) */}
      <group position={[T.nx * scale, targetY + 1, T.nz * scale]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[result.cep_m * 0.97, result.cep_m, 56]} />
          <meshBasicMaterial color="#ffce4d" transparent opacity={0.8} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
        <Html center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
          <div className="ingress-tag target">TARGET · CEP {Math.round(result.cep_m)} m</div>
        </Html>
      </group>

      {/* TERCOM fix strips */}
      {fixMarks.map((m, i) => (
        <mesh key={i} position={[m.x, m.y + 1, m.z]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[dartLen * 1.1, dartLen * 1.45, 20]} />
          <meshBasicMaterial color="#5fd0ff" transparent opacity={0.85} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
      ))}

      {/* outcome marker at the end of flight */}
      {impact && (
        <group position={[impact.nx * scale, impact.gnd_m + 2, impact.nz * scale]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[dartLen * 1.6, dartLen * 2.4, 32]} />
            <meshBasicMaterial color={vcol} transparent opacity={0.9} side={THREE.DoubleSide} toneMapped={false} />
          </mesh>
          <Html center zIndexRange={[30, 0]} style={{ pointerEvents: 'none' }}>
            <div className="verdict-tag" style={{ color: vcol, borderColor: vcol }}>{result.verdict}</div>
          </Html>
        </group>
      )}

      {/* the weapon */}
      <group ref={dartRef}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <coneGeometry args={[dartLen * 0.3, dartLen, 12]} />
          <meshBasicMaterial color="#eaf2ff" toneMapped={false} />
        </mesh>
        <pointLight distance={scale * 0.1} intensity={scale * 0.03} color="#bcd8ff" />
      </group>
    </group>
  );
}
