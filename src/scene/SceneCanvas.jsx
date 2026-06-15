import React, { useEffect, useMemo, useRef, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Stars, OrbitControls, Html } from '@react-three/drei';
import { EffectComposer, Bloom, Vignette, N8AO } from '@react-three/postprocessing';
import * as THREE from 'three';
import TerrainChunked from './TerrainChunked';
import PerfStats from './PerfStats';
import Rover from './Rover';
import Ingress from './Ingress';
import { getRegolithMaps } from './lunarSurface';
import { lunarSample, worldHeight } from '../engine/world';

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
      maxPolarAngle={Math.PI / 2.02}
      minPolarAngle={0.05}
      minDistance={2}
      maxDistance={worldScale * 5}
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
/* ── The lunar world: one finite surface around the analyzed patch — maria,
   highlands and impact craters from the shared lunarSample() field, so it is
   continuous with the patch (no floating tile) and reads as real Moon, not
   random dunes. Vertex-coloured (dark mare / bright highland). Sized to fade
   into the fogged horizon before the far plane — no square, no hard cut. ── */
const GROUND_SEG = 384;

function LunarWorld({ terrain }) {
  const worldScale = terrain.scale;
  const maps = getRegolithMaps();
  const { normalMap, roughnessMap } = useMemo(() => {
    const n = maps.normal.clone(); n.needsUpdate = true; n.wrapS = n.wrapT = THREE.RepeatWrapping;
    const r = maps.roughness.clone(); r.needsUpdate = true; r.wrapS = r.wrapT = THREE.RepeatWrapping;
    return { normalMap: n, roughnessMap: r };
  }, [maps]);

  const geometry = useMemo(() => {
    const size = worldScale * 24;
    const curveR = worldScale * 45; // gentle curvature — horizon drop, not a ball
    const g = new THREE.PlaneGeometry(size, size, GROUND_SEG, GROUND_SEG);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    const colors = new Float32Array(pos.count * 3);
    const relief = Math.max(40, terrain.maxH - terrain.minH);
    const detail = 60; // regolith repeats every 60 m
    for (let k = 0; k < pos.count; k++) {
      const x = pos.getX(k);
      const z = pos.getZ(k);
      const { h, mare, cr } = lunarSample(terrain, x, z);
      // Planet curvature: far terrain bends down so it drops below a round
      // horizon (airless — no fog needed to hide the edge).
      const drop = (x * x + z * z) / (2 * curveR);
      pos.setY(k, h - drop);
      uv.setXY(k, x / detail, z / detail);
      const e = Math.max(0, Math.min(1, (h - terrain.minH) / (relief * 1.6)));
      const crN = Math.max(-1, Math.min(1, cr / relief));
      // Sharper albedo: strong mare/highland split, fresh-crater rims bright,
      // bowls dark.
      let base = 0.60 - mare * 0.42 + e * 0.10 + crN * 0.16;
      base = Math.max(0.10, Math.min(0.96, base));
      colors[k * 3] = base;
      colors[k * 3 + 1] = base * 0.985;
      colors[k * 3 + 2] = base * 0.95;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    return g;
  }, [worldScale, terrain.minH, terrain.maxH]);

  return (
    <mesh geometry={geometry} receiveShadow>
      <meshStandardMaterial
        vertexColors
        roughness={1}
        metalness={0}
        normalMap={normalMap}
        normalScale={new THREE.Vector2(0.5, 0.5)}
        roughnessMap={roughnessMap}
      />
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
      <sphereGeometry args={[worldScale * 30, 48, 48]} />
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
    const ground = worldHeight(terrain, camera.position.x, camera.position.z);
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
      <ambientLight intensity={0.16} color="#aab4cc" />
      <directionalLight
        position={[s * 0.6, s * 0.17, s * 0.32]}
        intensity={2.4}
        color="#fff3da"
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
      {/* No fog — the Moon is airless. Distance is read crisply; the far
          terrain instead curves below a round horizon (see LunarWorld). */}
    </>
  );
}

function Effects({ worldScale }) {
  // Ambient occlusion = the big realism unlock — contact shadows in craters,
  // depth in the regolith. Then bloom + a filmic vignette.
  return (
    <EffectComposer multisampling={4}>
      <N8AO halfRes aoRadius={worldScale * 0.06} distanceFalloff={0.6} intensity={2.6} color="#05060a" />
      <Bloom
        intensity={0.32}
        luminanceThreshold={0.72}
        luminanceSmoothing={0.3}
        mipmapBlur
      />
      <Vignette eskil={false} offset={0.18} darkness={0.92} />
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
  onGlReady,
  ingressPlaying = false,
  onIngressDone,
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
        position: [-worldScale * 0.34, worldScale * 0.14, worldScale * 0.42],
        fov: 55,
        near: 0.5,
        far: worldScale * 40,
      }}
      gl={{
        antialias: true,
        powerPreference: 'high-performance',
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.2,
      }}
      onCreated={({ gl }) => {
        gl.shadowMap.type = THREE.PCFSoftShadowMap;
        if (onGlReady) onGlReady(gl);
      }}
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
    >
      <color attach="background" args={['#0b0c10']} />
      <Lighting worldScale={worldScale} />
      <SpaceDome worldScale={worldScale} />
      <Stars
        radius={worldScale * 22}
        depth={worldScale * 5}
        count={4500}
        factor={worldScale / 30}
        saturation={0}
        fade
        speed={0.2}
      />

      {terrain && <LunarWorld terrain={terrain} />}
      {terrain && <CameraFloor terrain={terrain} />}

      <group onClick={handleClick} onPointerMove={handlePointerMove}>
        {terrain && <TerrainChunked terrain={terrain} layers={layers} viewMode={viewMode} />}
      </group>

      {/* Parked digital-twin rover — scale + telemetry. */}
      {terrain && <Rover terrain={terrain} />}

      {/* Nap-of-the-earth ingress: radar-masked route + cinematic fly-through. */}
      {terrain && <Ingress terrain={terrain} playing={ingressPlaying} onDone={onIngressDone} />}

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
      <Effects worldScale={worldScale} />
    </Canvas>
  );
}
