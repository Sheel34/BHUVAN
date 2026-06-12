import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Stars, Html } from '@react-three/drei';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import { MOON_SITES, latLonToVec3 } from '../lib/moonSites';
import { createProceduralMoonTextures } from './proceduralMoon';

const MOON_RADIUS = 2;
// Real lunar relief is ~19.8 km on a 1737 km radius (~1.1%); exaggerate
// ~2.5x so craters read at globe scale without looking cartoonish.
const DISPLACEMENT_SCALE = MOON_RADIUS * 0.028;
const IDLE_SPIN_SPEED = 0.018;
const CAMERA_HOME = new THREE.Vector3(0, 0.9, 5.4);
const FLY_DURATION = 2.4;

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/* ── Texture loading: backend LROC/LOLA maps, procedural fallback ── */
function useMoonTextures(textureUrls) {
  const [textures, setTextures] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');

    const fallback = () => {
      if (!cancelled) setTextures(createProceduralMoonTextures());
    };

    if (!textureUrls?.color || !textureUrls?.displacement) {
      fallback();
      return () => { cancelled = true; };
    }

    Promise.all([
      loader.loadAsync(textureUrls.color),
      loader.loadAsync(textureUrls.displacement),
    ])
      .then(([color, displacement]) => {
        if (cancelled) return;
        color.colorSpace = THREE.SRGBColorSpace;
        color.anisotropy = 8;
        setTextures({ color, displacement, procedural: false });
      })
      .catch((err) => {
        console.warn('Moon texture load failed, using procedural fallback.', err);
        fallback();
      });

    return () => { cancelled = true; };
  }, [textureUrls]);

  return textures;
}

/* ── The Moon itself: displaced, bump-lit sphere ── */
function Moon({ textures, groupRef, spinning }) {
  const spinPaused = useRef(false);

  useFrame((_, dt) => {
    if (!groupRef.current) return;
    if (spinning && !spinPaused.current) {
      groupRef.current.rotation.y += dt * IDLE_SPIN_SPEED;
    }
  });

  return (
    <group ref={groupRef}>
      <mesh
        onPointerDown={() => { spinPaused.current = true; }}
        onPointerUp={() => { spinPaused.current = false; }}
      >
        <sphereGeometry args={[MOON_RADIUS, 384, 192]} />
        <meshStandardMaterial
          map={textures.color}
          displacementMap={textures.displacement}
          displacementScale={DISPLACEMENT_SCALE}
          displacementBias={-DISPLACEMENT_SCALE / 2}
          bumpMap={textures.displacement}
          bumpScale={1.4}
          roughness={0.96}
          metalness={0.0}
        />
      </mesh>
      {/* Faint cool rim light — cinematic depth cue, kept subtle (no atmosphere) */}
      <mesh scale={1.014}>
        <sphereGeometry args={[MOON_RADIUS, 64, 32]} />
        <shaderMaterial
          transparent
          depthWrite={false}
          side={THREE.BackSide}
          blending={THREE.AdditiveBlending}
          uniforms={{ uColor: { value: new THREE.Color('#7fb8ff') } }}
          vertexShader={`
            varying vec3 vNormal;
            void main() {
              vNormal = normalize(normalMatrix * normal);
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `}
          fragmentShader={`
            uniform vec3 uColor;
            varying vec3 vNormal;
            void main() {
              float rim = pow(1.0 - abs(dot(vNormal, vec3(0.0, 0.0, 1.0))), 4.0);
              gl_FragColor = vec4(uColor, rim * 0.16);
            }
          `}
        />
      </mesh>
    </group>
  );
}

/* ── Site marker: pulsing ring + hover card ── */
function SiteMarker({ site, moonGroupRef, hovered, onHover, onSelect, flying }) {
  const markerRef = useRef();
  const ringRef = useRef();
  const basePos = useMemo(
    () => latLonToVec3(site.lat, site.lon, MOON_RADIUS * 1.015),
    [site]
  );

  useFrame(({ camera, clock }) => {
    if (!markerRef.current || !moonGroupRef.current) return;
    // Fade markers on the far side of the globe
    const worldPos = markerRef.current.getWorldPosition(new THREE.Vector3());
    const toCamera = camera.position.clone().sub(worldPos).normalize();
    const outward = worldPos.clone().normalize();
    const facing = outward.dot(toCamera);
    const visible = facing > 0.12;
    markerRef.current.visible = visible;

    if (ringRef.current) {
      const pulse = 1 + Math.sin(clock.elapsedTime * 2.4) * 0.12;
      ringRef.current.scale.setScalar(hovered ? 1.5 : pulse);
    }
  });

  return (
    <group ref={markerRef} position={basePos}>
      <mesh
        ref={ringRef}
        onPointerOver={(e) => { e.stopPropagation(); if (!flying) onHover(site.id); }}
        onPointerOut={(e) => { e.stopPropagation(); onHover(null); }}
        onClick={(e) => { e.stopPropagation(); if (!flying) onSelect(site); }}
      >
        <sphereGeometry args={[0.035, 16, 16]} />
        <meshBasicMaterial
          color={hovered ? '#ffffff' : '#93a4c4'}
          toneMapped={false}
        />
      </mesh>
      {hovered && !flying && (
        <Html distanceFactor={5} position={[0.08, 0.1, 0]} style={{ pointerEvents: 'none' }}>
          <div className="globe-site-card">
            <div className="globe-site-card-title">{site.name}</div>
            <div className="globe-site-card-row">{site.blurb}</div>
            <div className="globe-site-card-meta">
              <span>ELEV {site.elevation}</span>
              <span>RISK {site.risk}</span>
            </div>
            <div className="globe-site-card-cta">
              RUN TERRAIN SURVEY {site.real ? '· REAL DEM AVAILABLE' : '· ANALOGUE TERRAIN'}
            </div>
          </div>
        </Html>
      )}
    </group>
  );
}

/* ── Camera: cursor drift at rest, eased fly-to on site select ── */
function GlobeCameraRig({ flight, onFlightDone }) {
  const { camera, pointer } = useThree();
  const flightState = useRef(null);

  useEffect(() => {
    if (!flight) {
      flightState.current = null;
      return;
    }
    flightState.current = {
      from: camera.position.clone(),
      to: flight.cameraTarget.clone(),
      t: 0,
    };
  }, [flight, camera]);

  useFrame((_, dt) => {
    const fs = flightState.current;
    if (fs) {
      fs.t = Math.min(1, fs.t + dt / FLY_DURATION);
      const k = easeInOutCubic(fs.t);
      // Arc the path outward slightly so the camera sweeps, not tunnels
      const mid = fs.from.clone().lerp(fs.to, 0.5).normalize()
        .multiplyScalar(Math.max(fs.from.length(), fs.to.length()) * 1.12);
      const a = fs.from.clone().lerp(mid, k);
      const b = mid.clone().lerp(fs.to, k);
      camera.position.copy(a.lerp(b, k));
      camera.lookAt(0, 0, 0);
      if (fs.t >= 1) {
        flightState.current = null;
        onFlightDone();
      }
      return;
    }

    // Idle: Apple-subtle cursor drift around the home position
    const driftX = pointer.x * 0.35;
    const driftY = pointer.y * 0.22;
    const target = new THREE.Vector3(
      CAMERA_HOME.x + driftX,
      CAMERA_HOME.y + driftY,
      CAMERA_HOME.z
    );
    camera.position.lerp(target, Math.min(1, 1.8 * dt));
    camera.lookAt(0, 0, 0);
  });

  return null;
}

/* ── Sun: slow orbit, nudged by cursor for living shadows ── */
function Sun() {
  const lightRef = useRef();
  const { pointer } = useThree();

  useFrame(({ clock }) => {
    if (!lightRef.current) return;
    const t = clock.elapsedTime * 0.02;
    const azimuth = t + pointer.x * 0.25;
    lightRef.current.position.set(
      Math.cos(azimuth) * 10,
      2.5 + pointer.y * 1.5,
      Math.sin(azimuth) * 10
    );
  });

  return (
    <>
      <directionalLight ref={lightRef} intensity={2.6} color="#fff4e6" />
      <ambientLight intensity={0.06} color="#334466" />
    </>
  );
}

function GlobeScene({ textureUrls, flight, onFlightDone, onSelectSite, flying }) {
  const moonGroupRef = useRef();
  const [hoveredSite, setHoveredSite] = useState(null);
  const textures = useMoonTextures(textureUrls);

  if (!textures) return null;

  return (
    <>
      <Sun />
      <Stars radius={70} depth={40} count={6000} factor={3.2} saturation={0} fade speed={0.4} />
      <Moon textures={textures} groupRef={moonGroupRef} spinning={!flying && !hoveredSite} />
      <group>
        {MOON_SITES.map((site) => (
          <SiteMarker
            key={site.id}
            site={site}
            moonGroupRef={moonGroupRef}
            hovered={hoveredSite === site.id}
            onHover={setHoveredSite}
            onSelect={onSelectSite}
            flying={flying}
          />
        ))}
      </group>
      <GlobeCameraRig flight={flight} onFlightDone={onFlightDone} />
      <EffectComposer multisampling={4}>
        <Bloom intensity={0.32} luminanceThreshold={0.28} luminanceSmoothing={0.7} mipmapBlur />
        <Vignette eskil={false} offset={0.18} darkness={0.78} />
      </EffectComposer>
    </>
  );
}

/**
 * Full-screen hero Moon globe. Renders instantly (procedural fallback),
 * upgrades to real LROC/LOLA textures when the backend serves them.
 * Clicking a site flies the camera in, then calls onSiteSelected(site).
 */
export default function MoonGlobe({ textureUrls, onSiteSelected }) {
  const [flight, setFlight] = useState(null);
  const pendingSite = useRef(null);

  const handleSelectSite = useCallback((site) => {
    const pos = latLonToVec3(site.lat, site.lon, MOON_RADIUS);
    const dir = new THREE.Vector3(...pos).normalize();
    pendingSite.current = site;
    setFlight({ cameraTarget: dir.multiplyScalar(MOON_RADIUS * 1.55) });
  }, []);

  const handleFlightDone = useCallback(() => {
    setFlight(null);
    const site = pendingSite.current;
    pendingSite.current = null;
    if (site && onSiteSelected) onSiteSelected(site);
  }, [onSiteSelected]);

  return (
    <div className="globe-root">
      <Canvas
        camera={{ position: CAMERA_HOME.toArray(), fov: 42, near: 0.1, far: 200 }}
        gl={{
          antialias: true,
          powerPreference: 'high-performance',
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.05,
        }}
        dpr={[1, 2]}
      >
        <color attach="background" args={['#040408']} />
        <GlobeScene
          textureUrls={textureUrls}
          flight={flight}
          onFlightDone={handleFlightDone}
          onSelectSite={handleSelectSite}
          flying={Boolean(flight)}
        />
      </Canvas>
    </div>
  );
}
