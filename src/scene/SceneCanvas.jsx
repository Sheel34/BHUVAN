import React, { useEffect, useMemo, useRef, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Stars, OrbitControls } from '@react-three/drei';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import TerrainChunked from './TerrainChunked';
import Lander from './Lander';
import PerfStats from './PerfStats';

const INSPECTION_PHASES = new Set(['analyze', 'inspect3d']);

/* ── Camera Controller (active only during scripted descent/report phases) ── */
function CameraRig({ phase, landerRef }) {
  const { camera } = useThree();
  const targetPos = useRef(new THREE.Vector3(0, 120, 30));
  const targetLook = useRef(new THREE.Vector3(0, 0, 0));

  useFrame((_, dt) => {
    if (phase !== 'descent' && phase !== 'report' && phase !== 'landed' && phase !== 'crashed') return;

    const lerpSpeed = Math.min(1, 2.5 * dt);
    const landerState = landerRef.current;

    if (phase === 'descent' && landerState) {
      const above = 6 + landerState.y * 0.08;
      targetPos.current.set(
        landerState.x - 4,
        landerState.y + above,
        landerState.z + 12
      );
      targetLook.current.set(landerState.x, landerState.y - 2, landerState.z);
    } else if ((phase === 'landed' || phase === 'crashed' || phase === 'report') && landerState) {
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

function TerrainInspectionControls({ enabled, target }) {
  const controlsRef = useRef();

  useEffect(() => {
    if (!controlsRef.current) return;
    controlsRef.current.target.set(target[0], target[1], target[2]);
    controlsRef.current.update();
  }, [target]);

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enabled={enabled}
      enableDamping
      dampingFactor={0.08}
      rotateSpeed={0.48}
      zoomSpeed={0.85}
      panSpeed={0.75}
      enablePan
      enableZoom
      enableRotate
      screenSpacePanning={false}
      mouseButtons={{
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN,
      }}
      touches={{
        ONE: THREE.TOUCH.ROTATE,
        TWO: THREE.TOUCH.DOLLY_PAN,
      }}
      maxPolarAngle={Math.PI / 1.8}
      minPolarAngle={0.05}
      minDistance={2}
      maxDistance={500}
    />
  );
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
        intensity={0.28}
        luminanceThreshold={0.7}
        luminanceSmoothing={0.3}
        mipmapBlur
      />
      <Vignette eskil={false} offset={0.15} darkness={0.8} />
    </EffectComposer>
  );
}

/* ── Main Scene Canvas ── */
export default function SceneCanvas({
  phase,
  analysis,
  landerRef,
  viewMode,
  landingTarget,
  landingTargetHazard,
  inspectedPoint,
  onInspectPoint,
  debugMode = false,
}) {
  const terrain = analysis?.terrain;
  const layers = analysis?.layers;
  const inspectionControlsEnabled = INSPECTION_PHASES.has(phase);
  const inspectionTarget = useMemo(() => {
    if (inspectedPoint) return [inspectedPoint.x, inspectedPoint.y, inspectedPoint.z];
    if (landingTarget) return [landingTarget[0], landingTarget[1], landingTarget[2]];
    return [0, 0, 0];
  }, [inspectedPoint, landingTarget]);

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
      shadows="soft"
      dpr={[1, 1.5]}
      camera={{ position: [0, 120, 30], fov: 55, near: 0.5, far: 500 }}
      gl={{
        antialias: false,
        powerPreference: 'high-performance',
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.2,
      }}
      onCreated={({ gl }) => {
        gl.shadowMap.type = THREE.PCFSoftShadowMap;
      }}
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
    >
      <Lighting />
      <Stars radius={200} depth={80} count={1400} factor={4} saturation={0.1} fade speed={0.25} />
      <GroundGrid />

      <group onClick={handleClick}>
        {terrain && <TerrainChunked terrain={terrain} layers={layers} viewMode={viewMode} />}
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
        <Lander landerRef={landerRef} />
      )}

      <CameraRig
        phase={phase}
        landerRef={landerRef}
      />

      <TerrainInspectionControls
        enabled={inspectionControlsEnabled}
        target={inspectionTarget}
      />

      <PerfStats enabled={debugMode} />
      <Effects />
    </Canvas>
  );
}
