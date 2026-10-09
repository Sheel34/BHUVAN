import { useEffect, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { Stars } from '@react-three/drei';
import * as THREE from 'three';

export default function SpaceEnvironment({ mobile, decorativeStars = false, starCount }) {
  const { scene } = useThree();
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true, owned;
    const previous = scene.background;
    new THREE.TextureLoader().load('/textures/2k_stars_milky_way.jpg', texture => {
      owned = texture;
      if (!active) { texture.dispose(); return; }
      texture.mapping = THREE.EquirectangularReflectionMapping;
      texture.colorSpace = THREE.SRGBColorSpace;
      scene.background = texture;
      scene.backgroundIntensity = .38;
    }, undefined, error => {
      console.error('[space] Milky Way texture failed', error);
      if (active) setError(true);
    });
    return () => { active = false; scene.background = previous; owned?.dispose(); };
  }, [scene]);
  return <>
    {decorativeStars && <Stars radius={70} depth={40} count={starCount ?? (mobile ? 100 : 1000)} factor={mobile ? .7 : 1} saturation={0} />}
    {error && null}
  </>;
}
