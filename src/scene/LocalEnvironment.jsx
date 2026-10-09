import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import SpaceEnvironment from './SpaceEnvironment';
import { ENVIRONMENT_PROFILES } from '../engine/environment';

function LocalSky({ profile }) {
  const { scene } = useThree();
  const texture = useMemo(() => {
    const pixels = new Uint8Array(4 * 256);
    const upper = new THREE.Color(profile.upper), horizon = new THREE.Color(profile.horizon), lower = new THREE.Color(profile.lower), c = new THREE.Color();
    for (let y = 0; y < 256; y++) {
      const latitude = (y / 255 - .5) * Math.PI;
      c.copy(horizon).lerp(latitude > 0 ? upper : lower, Math.min(1, Math.abs(latitude) * 1.4));
      pixels.set([c.r * 255, c.g * 255, c.b * 255, 255], y * 4);
    }
    const t = new THREE.DataTexture(pixels, 1, 256, THREE.RGBAFormat);
    t.mapping = THREE.EquirectangularReflectionMapping; t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
    return t;
  }, [profile]);
  useEffect(() => {
    const previous = scene.background, intensity = scene.backgroundIntensity;
    scene.background = texture; scene.backgroundIntensity = 1;
    return () => { scene.background = previous; scene.backgroundIntensity = intensity; };
  }, [scene, texture]);
  useEffect(() => () => texture.dispose(), [texture]);
  return null;
}

// Decorative flock: no observed location, biological model or physics claim.
function AmbientBirds({ terrain, clock, verticalExaggeration }) {
  const flock = useRef();
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, .2, 0, .1, 0, -.1, 0, -.5, 0, .1, 0, 1, 0, .2, .1, 0, -.5], 3));
    g.computeVertexNormals(); return g;
  }, []);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useFrame(({clock:visualClock}) => {
    const t = visualClock.elapsedTime, s = terrain.scale;
    for (let i = 0; i < 9; i++) {
      const angle = t * .035 + i * .025;
      dummy.position.set(Math.sin(angle) * s * .32 + (i % 3) * s * .005,
        terrain.maxH * verticalExaggeration + s * (.12 + i * .002), Math.cos(angle) * s * .25 + Math.floor(i / 3) * s * .005);
      dummy.rotation.set(0, angle + Math.PI / 2, Math.sin(t * 2.5 + i) * .08);
      dummy.scale.setScalar(s * .00065); dummy.updateMatrix(); flock.current.setMatrixAt(i, dummy.matrix);
    }
    flock.current.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={flock} args={[geometry, undefined, 9]} frustumCulled={false} name="VISUAL ONLY decorative birds">
    <meshBasicMaterial color="#142331" side={THREE.DoubleSide} />
  </instancedMesh>;
}

export default function LocalEnvironment({ terrain, quality, ambience, clock, verticalExaggeration }) {
  const profile = ENVIRONMENT_PROFILES[terrain.body] || ENVIRONMENT_PROFILES.moon;
  return <>
    {profile.sky === 'space' ? <SpaceEnvironment mobile={quality.stars <= 100} starCount={quality.stars} decorativeStars /> : <LocalSky profile={profile} />}
    {ambience && profile.birds && <AmbientBirds terrain={terrain} clock={clock} verticalExaggeration={verticalExaggeration} />}
  </>;
}
