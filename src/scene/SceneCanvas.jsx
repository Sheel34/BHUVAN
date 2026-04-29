import React, { useRef, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Stars, OrbitControls } from '@react-three/drei';
import { EffectComposer, Bloom, Vignette, ChromaticAberration } from '@react-three/postprocessing';
import { BlendFunction } from 'postprocessing';
import * as THREE from 'three';
import Terrain from './Terrain';
import Lander from './Lander';

/* ── Camera Controller (ONLY active during descent/landed — NOT orbital) ── */
function CameraRig({ phase, landerState }) {
  const { camera } = useThree();
  const targetPos = useRef(new THREE.Vector3(0, 120, 30));
  const targetLook = useRef(new THREE.Vector3(0, 0, 0));

  useFrame((_, dt) => {
    // During orbital phase, OrbitControls handles the camera — we do nothing.
    if (phase === 'orbital') return;

    const lerpSpeed = Math.min(1, 2.5 * dt);

    if (phase === 'descent' && landerState) {
      const above = 6 + landerState.y * 0.08;
      targetPos.current.set(
        landerState.x - 4,
        landerState.y + above,
        landerState.z + 12
      );
      targetLook.current.set(landerState.x, landerState.y - 2, landerState.z);
    } else if ((phase === 'landed' || phase === 'crashed') && landerState) {
      const t = Date.now() * 0.0003;
      targetPos.current.set(
        landerState.x + Math.cos(t) * 20,
        landerState.y + 10,
        landerState.z + Math.sin(t) * 20
      );
      targetLook.current.set(landerState.x, landerState.y, landerState.z);
    }

    camera.position.lerp(targetPos.current, lerpSpeed);
    camera.lookAt(targetLook.current);
  });

  return null;
}

/* ── Landing Zone Marker ── */
function LandingMarker({ position, hazardLevel, radius = 3.5 }) {
  const ringRef = useRef();
  const colors = ['#00ff66', '#ffaa00', '#ff3333'];

  useFrame((state) => {
    if (ringRef.current) {
      ringRef.current.rotation.z = state.clock.elapsedTime * 0.5;
      ringRef.current.scale.setScalar(1 + Math.sin(state.clock.elapsedTime * 2) * 0.1);
    }
  });

  return (
    <group position={[position[0], position[1] + 0.5, position[2]]}>
      <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[Math.max(1.5, radius - 0.8), radius, 32]} />
        <meshBasicMaterial
          color={colors[hazardLevel] || '#00ff66'}
          transparent
          opacity={0.7}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Crosshair lines */}
      {[0, Math.PI / 2].map((rot, i) => (
        <mesh key={i} rotation={[-Math.PI / 2, 0, rot]} position={[0, 0.1, 0]}>
          <planeGeometry args={[0.15, radius * 2 + 1]} />
          <meshBasicMaterial color={colors[hazardLevel] || '#00ff66'} transparent opacity={0.4} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}

function InspectionMarker({ point }) {
  return (
    <group position={[point.x, point.y + 0.75, point.z]}>
      <mesh>
        <sphereGeometry args={[0.8, 20, 20]} />
        <meshBasicMaterial color="#44aaff" />
      </mesh>
      <mesh position={[0, 1.2, 0]}>
        <cylinderGeometry args={[0.05, 0.05, 2.4, 8]} />
        <meshBasicMaterial color="#44aaff" />
      </mesh>
    </group>
  );
}

/* ── Ground grid for spatial awareness ── */
function GroundGrid() {
  return (
    <gridHelper
      args={[200, 40, '#442200', '#331800']}
      position={[0, -12, 0]}
    />
  );
}

/* ── Scene Lighting ── */
function Lighting() {
  return (
    <>
      <ambientLight intensity={0.25} color="#ffeedd" />
      <directionalLight
        position={[60, 80, 30]}
        intensity={1.8}
        color="#fff5e0"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-far={250}
        shadow-camera-left={-100}
        shadow-camera-right={100}
        shadow-camera-top={100}
        shadow-camera-bottom={-100}
      />
      <directionalLight position={[-40, 20, -30]} intensity={0.3} color="#aabbff" />
      <fog attach="fog" args={['#1a0a00', 80, 300]} />
    </>
  );
}

/* ── Post Processing ── */
function Effects() {
  return (
    <EffectComposer>
      <Bloom
        intensity={0.6}
        luminanceThreshold={0.7}
        luminanceSmoothing={0.3}
        mipmapBlur
      />
      <Vignette eskil={false} offset={0.15} darkness={0.8} />
      <ChromaticAberration
        blendFunction={BlendFunction.NORMAL}
        offset={new THREE.Vector2(0.0008, 0.0008)}
      />
    </EffectComposer>
  );
}

/* ── Main Scene Canvas ── */
export default function SceneCanvas({
  phase,
  analysis,
  landerState,
  viewMode,
  landingTarget,
  landingTargetHazard,
  inspectedPoint,
  onInspectPoint,
}) {
  const controlsRef = useRef();
  const terrain = analysis?.terrain;
  const layers = analysis?.layers;

  // Only fire on click — no onPointerMove (that was causing lag/re-renders)
  const handleClick = useCallback(
    (e) => {
      if ((phase === 'analyze' || phase === 'inspect3d' || phase === 'report') && e.point && onInspectPoint) {
        e.stopPropagation();
        onInspectPoint(e.point.x, e.point.z);
      }
    },
    [phase, onInspectPoint]
  );

  return (
    <Canvas
      shadows
      camera={{ position: [0, 120, 30], fov: 55, near: 0.5, far: 500 }}
      gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.2 }}
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
    >
      <Lighting />
      <Stars radius={200} depth={80} count={3000} factor={4} saturation={0.1} fade speed={0.5} />
      <GroundGrid />

      <group onClick={handleClick}>
        {terrain && <Terrain terrain={terrain} layers={layers} viewMode={viewMode} />}
      </group>

      {landingTarget && (
        <LandingMarker
          position={landingTarget}
          hazardLevel={landingTargetHazard}
          radius={landingTarget[3] || 4}
        />
      )}

      {inspectedPoint && <InspectionMarker point={inspectedPoint} />}

      {(phase === 'descent' || phase === 'report') && (
        <Lander landerState={landerState} />
      )}

      <CameraRig
        phase={phase}
        landerState={landerState}
      />

      {phase === 'orbital' && (
        <OrbitControls
          ref={controlsRef}
          makeDefault
          enableDamping
          dampingFactor={0.08}
          rotateSpeed={0.4}
          zoomSpeed={0.6}
          panSpeed={0.4}
          enablePan={true}
          enableZoom={true}
          enableRotate={true}
          maxPolarAngle={Math.PI / 2.2}
          minPolarAngle={0.2}
          minDistance={30}
          maxDistance={200}
          target={[0, 0, 0]}
        />
      )}

      <Effects />
    </Canvas>
  );
}
