import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
// The liquid compositor applies final tone mapping and display conversion.
export const surfaceOutputs = new WeakMap();

// The installed postprocessing/N8AO wrapper produced a depth-texture feedback
// error with this Three version. Use Three's matching built-in passes, with
// owned render targets, for the optional surface-only Ultra effect.
export default function SurfaceEffects({ terrain }) {
  const { gl, scene, camera, size, viewport } = useThree();
  const effects = useMemo(() => {
    const composer = new EffectComposer(gl);
    composer.addPass(new RenderPass(scene, camera));
    const ao = new SSAOPass(scene, camera, size.width, size.height);
    ao.kernelRadius = terrain.scale * .0008;
    ao.minDistance = .001; ao.maxDistance = .05;
    composer.addPass(ao); composer.renderToScreen = false;
    return { composer, ao };
  }, [gl, scene, camera, terrain]);
  useEffect(() => {
    effects.composer.setPixelRatio(viewport.dpr); effects.composer.setSize(size.width, size.height);
  }, [effects, size.width, size.height, viewport.dpr]);
  useEffect(() => () => { surfaceOutputs.delete(gl); effects.ao.dispose(); effects.composer.dispose(); }, [effects, gl]);
  useFrame((_, dt) => {
    const autoReset = gl.info.autoReset;
    gl.info.reset(); gl.info.autoReset = false;
    try { effects.composer.render(dt); surfaceOutputs.set(gl, effects.composer.readBuffer.texture); }
    finally { gl.info.autoReset = autoReset; }
  }, 1);
  return null;
}
