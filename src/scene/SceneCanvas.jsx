import React, { useEffect, useMemo, useRef, useCallback } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Stars, OrbitControls, Html } from '@react-three/drei';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import TerrainChunked from './TerrainChunked';
import PerfStats from './PerfStats';

function TerrainInspectionControls({ target, worldScale = 200 }) {
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
      maxDistance={worldScale * 2.5}
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
      {[0, Math.PI / 2].map((rot, i) => (
        <mesh key={i} rotation={[-Math.PI / 2, 0, rot]} position={[0, 0.1, 0]}>
          <planeGeometry args={[0.15, radius * 2 + 1]} />
          <meshBasicMaterial color={colors[hazardLevel] || '#00ff66'} transparent opacity={0.4} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}

function InspectionMarker({ point, worldScale }) {
  const s = Math.max(0.8, worldScale / 250);
  return (
    <group position={[point.x, point.y + s, point.z]}>
      <mesh>
        <sphereGeometry args={[s, 20, 20]} />
        <meshBasicMaterial color="#44aaff" />
      </mesh>
      <mesh position={[0, s * 1.5, 0]}>
        <cylinderGeometry args={[s * 0.06, s * 0.06, s * 3, 8]} />
        <meshBasicMaterial color="#44aaff" />
      </mesh>
    </group>
  );
}

/* ── Scientific-interest beacon ── */
function InterestBeacon({ poi, terrain }) {
  const ref = useRef();
  const y = useMemo(() => {
    if (!terrain) return 0;
    // Sample terrain height at the POI grid position
    const { data, size, scale } = terrain;
    const fi = (poi.z / scale + 0.5) * (size - 1);
    const fj = (poi.x / scale + 0.5) * (size - 1);
    const i = Math.max(0, Math.min(size - 1, Math.round(fi)));
    const j = Math.max(0, Math.min(size - 1, Math.round(fj)));
    return data[i * size + j];
  }, [poi, terrain]);

  const beamH = terrain ? terrain.scale * 0.05 : 12;

  useFrame((state) => {
    if (ref.current) {
      ref.current.material.opacity = 0.35 + Math.sin(state.clock.elapsedTime * 2 + poi.x) * 0.15;
    }
  });

  return (
    <group position={[poi.x, y, poi.z]}>
      <mesh ref={ref} position={[0, beamH / 2, 0]}>
        <cylinderGeometry args={[beamH * 0.012, beamH * 0.03, beamH, 8, 1, true]} />
        <meshBasicMaterial color="#00ddcc" transparent opacity={0.4} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <Html distanceFactor={terrain ? terrain.scale * 0.18 : 40} position={[0, beamH * 1.08, 0]} style={{ pointerEvents: 'none' }}>
        <div className="poi-label">{poi.kind}</div>
      </Html>
    </group>
  );
}

/* ── Surrounding apron: hides the terrain edge in fog ── */
function EdgeApron({ worldScale, minH }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, minH - worldScale * 0.002, 0]}>
      <circleGeometry args={[worldScale * 4, 64]} />
      <meshStandardMaterial color="#241307" roughness={1} metalness={0} />
    </mesh>
  );
}

/* ── Scene Lighting — shadow frustum sized to the terrain ── */
function Lighting({ worldScale }) {
  const s = worldScale;
  return (
    <>
      <ambientLight intensity={0.25} color="#ffeedd" />
      <directionalLight
        position={[s * 0.3, s * 0.4, s * 0.15]}
        intensity={1.8}
        color="#fff5e0"
        castShadow
        shadow-mapSize-width={4096}
        shadow-mapSize-height={4096}
        shadow-camera-far={s * 1.25}
        shadow-camera-left={-s * 0.6}
        shadow-camera-right={s * 0.6}
        shadow-camera-top={s * 0.6}
        shadow-camera-bottom={-s * 0.6}
        shadow-bias={-0.0002}
      />
      <directionalLight position={[-s * 0.2, s * 0.1, -s * 0.15]} intensity={0.3} color="#aabbff" />
      <fog attach="fog" args={['#170b03', s * 0.35, s * 1.35]} />
    </>
  );
}

function Effects() {
  return (
    <EffectComposer multisampling={4}>
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

/* ── Main Scene Canvas — terrain is the hero ── */
export default function SceneCanvas({
  analysis,
  viewMode,
  landingTarget,
  landingTargetHazard,
  inspectedPoint,
  interestRegions = [],
  onInspectPoint,
  debugMode = false,
}) {
  const terrain = analysis?.terrain;
  const layers = analysis?.layers;
  const inspectionTarget = useMemo(() => {
    if (inspectedPoint) return [inspectedPoint.x, inspectedPoint.y, inspectedPoint.z];
    if (landingTarget) return [landingTarget[0], landingTarget[1], landingTarget[2]];
    return [0, 0, 0];
  }, [inspectedPoint, landingTarget]);

  const handleClick = useCallback(
    (e) => {
      if (e.point && onInspectPoint) {
        e.stopPropagation();
        onInspectPoint(e.point.x, e.point.z);
      }
    },
    [onInspectPoint]
  );

  const worldScale = terrain?.scale || 200;

  return (
    <Canvas
      shadows="soft"
      dpr={[1, 2]}
      camera={{
        position: [-worldScale * 0.32, worldScale * 0.22, worldScale * 0.38],
        fov: 50,
        near: 0.5,
        far: worldScale * 8,
      }}
      gl={{
        antialias: true,
        powerPreference: 'high-performance',
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.2,
      }}
      onCreated={({ gl }) => {
        gl.shadowMap.type = THREE.PCFSoftShadowMap;
      }}
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
    >
      <color attach="background" args={['#0a0502']} />
      <Lighting worldScale={worldScale} />
      <Stars
        radius={worldScale * 2.6}
        depth={worldScale * 0.5}
        count={2400}
        factor={worldScale / 60}
        saturation={0.1}
        fade
        speed={0.25}
      />

      {terrain && <EdgeApron worldScale={worldScale} minH={terrain.minH} />}

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

      {inspectedPoint && <InspectionMarker point={inspectedPoint} worldScale={worldScale} />}

      {interestRegions.map((poi) => (
        <InterestBeacon key={poi.id} poi={poi} terrain={terrain} />
      ))}

      <TerrainInspectionControls target={inspectionTarget} worldScale={worldScale} />

      <PerfStats enabled={debugMode} />
      <Effects />
    </Canvas>
  );
}
