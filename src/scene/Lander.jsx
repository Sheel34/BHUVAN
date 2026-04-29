import React, { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

/* ── Geometric Lander Model ── */
function LanderBody() {
  return (
    <group>
      {/* Main body - octagonal capsule */}
      <mesh castShadow position={[0, 0.8, 0]}>
        <cylinderGeometry args={[1.2, 1.5, 1.6, 8]} />
        <meshStandardMaterial color="#c0c0c0" metalness={0.7} roughness={0.3} />
      </mesh>

      {/* Top dome */}
      <mesh position={[0, 1.8, 0]}>
        <sphereGeometry args={[1.0, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color="#8899aa" metalness={0.8} roughness={0.2} />
      </mesh>

      {/* Engine bell */}
      <mesh position={[0, -0.2, 0]}>
        <coneGeometry args={[0.8, 1.0, 8, 1, true]} />
        <meshStandardMaterial color="#555555" metalness={0.9} roughness={0.4} side={THREE.DoubleSide} />
      </mesh>

      {/* Landing legs (4) */}
      {[0, 1, 2, 3].map((i) => {
        const angle = (i * Math.PI) / 2;
        const lx = Math.cos(angle) * 2.0;
        const lz = Math.sin(angle) * 2.0;
        return (
          <group key={i}>
            {/* Strut */}
            <mesh position={[lx * 0.55, -0.3, lz * 0.55]} rotation={[0, 0, Math.cos(angle) * 0.5]}>
              <boxGeometry args={[0.08, 2.0, 0.08]} />
              <meshStandardMaterial color="#aaaaaa" metalness={0.6} roughness={0.4} />
            </mesh>
            {/* Foot pad */}
            <mesh position={[lx, -1.3, lz]}>
              <cylinderGeometry args={[0.3, 0.35, 0.08, 8]} />
              <meshStandardMaterial color="#999999" metalness={0.5} roughness={0.5} />
            </mesh>
          </group>
        );
      })}

      {/* Antenna */}
      <mesh position={[0.5, 2.3, 0]}>
        <cylinderGeometry args={[0.02, 0.02, 1.0, 4]} />
        <meshStandardMaterial color="#cccccc" />
      </mesh>
      <mesh position={[0.5, 2.85, 0]}>
        <sphereGeometry args={[0.06, 8, 8]} />
        <meshStandardMaterial color="#ff3333" emissive="#ff0000" emissiveIntensity={0.5} />
      </mesh>
    </group>
  );
}

/* ── Thruster Flame ── */
function ThrusterFlame({ throttle }) {
  const flameRef = useRef();
  const lightRef = useRef();

  useFrame((_, dt) => {
    if (flameRef.current) {
      const scale = throttle * (0.8 + Math.random() * 0.4);
      flameRef.current.scale.set(scale, scale * 2, scale);
      flameRef.current.visible = throttle > 0.01;
    }
    if (lightRef.current) {
      lightRef.current.intensity = throttle * 8;
    }
  });

  return (
    <group position={[0, -0.8, 0]}>
      <mesh ref={flameRef}>
        <coneGeometry args={[0.5, 2.5, 8]} />
        <meshBasicMaterial color="#ff6600" transparent opacity={0.7} />
      </mesh>
      <pointLight ref={lightRef} color="#ff8833" intensity={0} distance={30} />
    </group>
  );
}

/* ── Exhaust Particles ── */
function ExhaustParticles({ throttle }) {
  const pointsRef = useRef();
  const particleCount = 80;

  const { positions, velocities, lifetimes } = useMemo(() => {
    const p = new Float32Array(particleCount * 3);
    const v = new Float32Array(particleCount * 3);
    const l = new Float32Array(particleCount);
    for (let i = 0; i < particleCount; i++) {
      l[i] = Math.random();
    }
    return { positions: p, velocities: v, lifetimes: l };
  }, []);

  useFrame((_, dt) => {
    if (!pointsRef.current || throttle < 0.01) {
      if (pointsRef.current) pointsRef.current.visible = false;
      return;
    }
    pointsRef.current.visible = true;

    for (let i = 0; i < particleCount; i++) {
      lifetimes[i] -= dt * 2;
      if (lifetimes[i] <= 0) {
        // Reset particle
        lifetimes[i] = 1.0;
        positions[i * 3] = (Math.random() - 0.5) * 0.5;
        positions[i * 3 + 1] = -0.8;
        positions[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
        velocities[i * 3] = (Math.random() - 0.5) * 3;
        velocities[i * 3 + 1] = -(Math.random() * 8 + 4) * throttle;
        velocities[i * 3 + 2] = (Math.random() - 0.5) * 3;
      }
      positions[i * 3] += velocities[i * 3] * dt;
      positions[i * 3 + 1] += velocities[i * 3 + 1] * dt;
      positions[i * 3 + 2] += velocities[i * 3 + 2] * dt;
    }
    pointsRef.current.geometry.attributes.position.needsUpdate = true;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={particleCount}
          array={positions}
          itemSize={3}
        />
      </bufferGeometry>
      <pointsMaterial
        size={0.3}
        color="#ff9944"
        transparent
        opacity={0.6}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

/* ── Complete Lander ── */
export default function Lander({ landerState }) {
  const groupRef = useRef();

  useFrame(() => {
    if (groupRef.current && landerState) {
      groupRef.current.position.set(landerState.x, landerState.y, landerState.z);
      groupRef.current.rotation.set(landerState.pitch, landerState.yaw, landerState.roll);
    }
  });

  const throttle = landerState?.throttle || 0;

  return (
    <group ref={groupRef}>
      <LanderBody />
      <ThrusterFlame throttle={throttle} />
      <ExhaustParticles throttle={throttle} />
    </group>
  );
}
