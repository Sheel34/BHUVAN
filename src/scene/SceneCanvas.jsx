import React, { useEffect, useMemo, useRef, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Stars, OrbitControls, Html } from '@react-three/drei';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import TerrainChunked from './TerrainChunked';
import PerfStats from './PerfStats';
import { sampleHeight } from '../engine/terrain';

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
      maxPolarAngle={Math.PI / 2.08}
      minPolarAngle={0.05}
      minDistance={2}
      maxDistance={worldScale * 1.6}
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
  // Flat survey reticle hugging the surface — an instrument cursor,
  // not a landing pin.
  const s = Math.max(1.2, worldScale / 160);
  return (
    <group position={[point.x, point.y + s * 0.08, point.z]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[s * 0.8, s, 48]} />
        <meshBasicMaterial color="#93a4c4" transparent opacity={0.85} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[s * 0.06, s * 0.14, 24]} />
        <meshBasicMaterial color="#93a4c4" transparent opacity={0.9} side={THREE.DoubleSide} depthWrite={false} />
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
        <meshBasicMaterial color="#93a4c4" transparent opacity={0.4} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <Html distanceFactor={terrain ? terrain.scale * 0.18 : 40} position={[0, beamH * 1.08, 0]} style={{ pointerEvents: 'none' }}>
        <div className="poi-label">{poi.kind}</div>
      </Html>
    </group>
  );
}

/* ── Surrounding lunar plain: the analyzed patch sits inside a much
   larger ground disc so its edges read as "more moon", not a cliff into
   space. Fog swallows the far rim. ── */
function EdgeApron({ worldScale, minH }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, minH - worldScale * 0.01, 0]} receiveShadow>
      <circleGeometry args={[worldScale * 14, 96]} />
      <meshStandardMaterial color="#5a5a5e" roughness={1} metalness={0} />
    </mesh>
  );
}

/* ── Space dome: a vast inward-facing shell so zooming out always shows
   a star-flecked sky, never an empty black void. ── */
function SpaceDome({ worldScale }) {
  const tex = useMemo(() => {
    const size = 1024;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    // Deep-space vertical gradient
    const g = ctx.createLinearGradient(0, 0, 0, size);
    g.addColorStop(0, '#06070b');
    g.addColorStop(0.5, '#0a0c12');
    g.addColorStop(1, '#070809');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    // Scattered stars
    for (let i = 0; i < 1400; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = Math.random() * 1.3;
      const a = 0.3 + Math.random() * 0.7;
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.mapping = THREE.EquirectangularReflectionMapping;
    return t;
  }, []);

  return (
    <mesh scale={[-1, 1, 1]}>
      <sphereGeometry args={[worldScale * 6, 32, 32]} />
      <meshBasicMaterial map={tex} side={THREE.BackSide} fog={false} depthWrite={false} />
    </mesh>
  );
}

/* ── Camera floor: hard guarantee the camera never dips below the
   surface, whatever the orbit/pan/zoom math does. ── */
function CameraFloor({ terrain }) {
  const { camera, controls } = useThree();
  useFrame(() => {
    if (!terrain) return;
    const ground = sampleHeight(terrain, camera.position.x, camera.position.z);
    const clearance = terrain.scale * 0.015 + 2;
    const minY = ground + clearance;
    if (camera.position.y < minY) {
      camera.position.y = minY;
      if (controls?.update) controls.update();
    }
  });
  return null;
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
      {/* Fog color MUST match the scene background — any mismatch reads as
          holes in the terrain at grazing camera angles. */}
      <fog attach="fog" args={['#0b0c10', s * 0.45, s * 1.8]} />
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
  focusPoint,
  interestRegions = [],
  onInspectPoint,
  debugMode = false,
}) {
  const terrain = analysis?.terrain;
  const layers = analysis?.layers;
  const inspectionTarget = useMemo(() => {
    if (focusPoint) return [focusPoint.x, focusPoint.y, focusPoint.z];
    if (landingTarget) return [landingTarget[0], landingTarget[1], landingTarget[2]];
    return [0, 0, 0];
  }, [focusPoint, landingTarget]);

  const handleClick = useCallback(
    (e) => {
      if (e.point && onInspectPoint) {
        e.stopPropagation();
        onInspectPoint(e.point.x, e.point.z);
      }
    },
    [onInspectPoint]
  );

  // Live hover probe — the surface reticle and readout follow the cursor
  // without clicking. Throttled so React state updates stay cheap.
  const lastProbeRef = useRef(0);
  const handlePointerMove = useCallback(
    (e) => {
      if (!e.point || !onInspectPoint) return;
      const now = performance.now();
      if (now - lastProbeRef.current < 90) return;
      lastProbeRef.current = now;
      onInspectPoint(e.point.x, e.point.z);
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
      <color attach="background" args={['#0b0c10']} />
      <Lighting worldScale={worldScale} />
      <SpaceDome worldScale={worldScale} />
      <Stars
        radius={worldScale * 3.2}
        depth={worldScale * 0.6}
        count={3200}
        factor={worldScale / 70}
        saturation={0}
        fade
        speed={0.2}
      />

      {terrain && <EdgeApron worldScale={worldScale} minH={terrain.minH} />}
      {terrain && <CameraFloor terrain={terrain} />}

      <group onClick={handleClick} onPointerMove={handlePointerMove}>
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
