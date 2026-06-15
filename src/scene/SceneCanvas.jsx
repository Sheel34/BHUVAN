import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Stars, OrbitControls, Html } from '@react-three/drei';
import { EffectComposer, Bloom, Vignette, N8AO } from '@react-three/postprocessing';
import * as THREE from 'three';
import TerrainChunked from './TerrainChunked';
import PerfStats from './PerfStats';
import Rover from './Rover';
import Ingress from './Ingress';
import TercomReplay from './TercomReplay';
import { getRegolithMaps } from './lunarSurface';
import { worldHeight } from '../engine/world';
import { deriveBody, sampleHeight } from '../engine/terrain';

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

/* ── Surrounding ground: a QUIET body-coloured plain the analyzed patch sits
   in — NOT a second detailed terrain. Solid colour (Moon grey / Mars rust /
   Earth green), faint regolith texture, gently curved to a round horizon. The
   sharp analyzed patch is the only hero; this is just the floor around it. ── */
const SURFACE_COLORS = { moon: '#6d6d73', mars: '#9c5a3a', earth: '#5f6b58' };
const GROUND_SEG = 160;

function Surround({ terrain, body }) {
  const worldScale = terrain.scale;
  const maps = getRegolithMaps();
  const normalMap = useMemo(() => {
    const n = maps.normal.clone();
    n.needsUpdate = true; n.wrapS = n.wrapT = THREE.RepeatWrapping;
    return n;
  }, [maps]);

  const geometry = useMemo(() => {
    const size = worldScale * 22;
    const curveR = worldScale * 50; // gentle horizon drop
    const baseline = terrain.minH - worldScale * 0.004;
    const g = new THREE.PlaneGeometry(size, size, GROUND_SEG, GROUND_SEG);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    const detail = 80;
    for (let k = 0; k < pos.count; k++) {
      const x = pos.getX(k);
      const z = pos.getZ(k);
      pos.setY(k, baseline - (x * x + z * z) / (2 * curveR));
      uv.setXY(k, x / detail, z / detail);
    }
    g.computeVertexNormals();
    return g;
  }, [worldScale, terrain.minH]);

  return (
    <mesh geometry={geometry} receiveShadow>
      <meshStandardMaterial
        color={SURFACE_COLORS[body] || SURFACE_COLORS.earth}
        roughness={1}
        metalness={0}
        normalMap={normalMap}
        normalScale={new THREE.Vector2(0.22, 0.22)}
      />
    </mesh>
  );
}

/* ── Photoreal draped terrain: real satellite imagery (ESRI World Imagery)
   mapped onto the real DEM. Single high-res displaced plane, photo as albedo
   → Google-Earth look, not procedural shapes. Used for the surface view when
   imagery is available; data layers still use the chunked analysis mesh. ── */
function DrapedTerrain({ terrain, map }) {
  const geometry = useMemo(() => {
    const seg = 384;
    const g = new THREE.PlaneGeometry(terrain.scale, terrain.scale, seg, seg);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    for (let k = 0; k < pos.count; k++) {
      const x = pos.getX(k);
      const z = pos.getZ(k);
      pos.setY(k, sampleHeight(terrain, x, z));
      // Patch-normalised UV aligned to the DEM grid (X←row, Z←col).
      uv.setXY(k, z / terrain.scale + 0.5, 1 - (x / terrain.scale + 0.5));
    }
    g.computeVertexNormals();
    return g;
  }, [terrain]);

  return (
    <mesh geometry={geometry} receiveShadow>
      <meshStandardMaterial map={map} roughness={0.95} metalness={0} />
    </mesh>
  );
}

/* ── Real Milky Way panorama as the scene BACKGROUND (equirectangular, drawn
   at infinity). No giant geometry — so it works at any world scale, including
   the huge real-DEM scales where a scaled sky sphere broke the render. ── */
function SkyBackground() {
  const { scene } = useThree();
  const tex = useMemo(() => {
    const t = new THREE.TextureLoader().load('/textures/2k_stars_milky_way.jpg');
    t.colorSpace = THREE.SRGBColorSpace;
    t.mapping = THREE.EquirectangularReflectionMapping;
    return t;
  }, []);
  useEffect(() => {
    const prev = scene.background;
    scene.background = tex;
    return () => { scene.background = prev; };
  }, [scene, tex]);
  return null;
}

/* ── A real planet hanging in the sky (prebuilt texture), lit by the sun →
   a phase/crescent like the reference shots. On Earth show the Moon; on the
   Moon/Mars show Earth. ── */
const PLANET_TEX = { earth: '/textures/2k_earth_daymap.jpg', moon: '/textures/2k_moon.jpg', mars: '/textures/2k_mars.jpg' };
function SkyBody({ body, worldScale }) {
  const which = body === 'earth' ? 'moon' : 'earth';
  const tex = useMemo(() => {
    const t = new THREE.TextureLoader().load(PLANET_TEX[which]);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [which]);
  const ref = useRef();
  useFrame((_, dt) => { if (ref.current) ref.current.rotation.y += dt * 0.01; });
  return (
    <mesh ref={ref} position={[worldScale * 8, worldScale * 6.5, -worldScale * 12]}>
      <sphereGeometry args={[worldScale * 1.6, 48, 48]} />
      <meshStandardMaterial map={tex} roughness={1} metalness={0} />
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
  tercomResult = null,
}) {
  const terrain = analysis?.terrain;
  const body = terrain?.body || deriveBody(analysis?.metadata);

  // Real satellite imagery (when present) → photoreal draped surface.
  const colorUrl = analysis?.metadata?.colorUrl || null;
  const [colorMap, setColorMap] = useState(null);
  useEffect(() => {
    if (!colorUrl) { setColorMap(null); return undefined; }
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    let tex;
    loader.load(
      colorUrl,
      (t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; tex = t; setColorMap(t); },
      undefined,
      () => setColorMap(null),
    );
    return () => { if (tex) tex.dispose(); };
  }, [colorUrl]);
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
      <Lighting worldScale={worldScale} />
      <SkyBackground />
      {worldScale < 5000 && <SkyBody body={body} worldScale={worldScale} />}
      <Stars
        radius={worldScale * 22}
        depth={worldScale * 5}
        count={4500}
        factor={worldScale / 30}
        saturation={0}
        fade
        speed={0.2}
      />

      {terrain && <Surround terrain={terrain} body={body} />}
      {terrain && <CameraFloor terrain={terrain} />}

      <group onClick={handleClick} onPointerMove={handlePointerMove}>
        {terrain && (colorMap && (viewMode === 'surface' || viewMode === 'elevation')
          ? <DrapedTerrain terrain={terrain} map={colorMap} />
          : <TerrainChunked terrain={terrain} layers={layers} viewMode={viewMode} />)}
      </group>

      {/* Parked digital-twin rover — scale + telemetry. */}
      {terrain && <Rover terrain={terrain} />}

      {/* Nap-of-the-earth ingress: radar-masked route + cinematic fly-through. */}
      {terrain && !tercomResult && <Ingress terrain={terrain} playing={ingressPlaying} onDone={onIngressDone} />}

      {/* TERCOM mission replay — real backend trajectory + verdict. */}
      {terrain && tercomResult && <TercomReplay terrain={terrain} result={tercomResult} />}

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
