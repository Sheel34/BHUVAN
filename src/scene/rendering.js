import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';

export const QUALITY_PROFILES = Object.freeze({
  ULTRA: { dpr: 2, shadowMap: 4096, antialias: true, anisotropy: 16, ao: true, stars: 1600 },
  HIGH: { dpr: 2, shadowMap: 2048, antialias: true, anisotropy: 8, ao: false, stars: 800 },
  BALANCED: { dpr: 1, shadowMap: 1024, antialias: true, anisotropy: 4, ao: false, stars: 300 },
  MOBILE: { dpr: 1, shadowMap: 512, antialias: false, anisotropy: 2, ao: false, stars: 100 },
});

export function FrameBudget({active=true,fps=30}) {
  const {advance,setFrameloop,clock}=useThree();
  useEffect(()=> {
    // OrbitControls emits changes while a moving target is followed. In demand
    // mode those invalidations defeat an interval-based frame budget.
    setFrameloop('never');
    if(!active)return;
    let last=performance.now(),elapsed=clock.elapsedTime;
    const tick=()=> {
      const now=performance.now(),dt=Math.min(.1,(now-last)/1000);last=now;
      if(document.visibilityState!=='visible')return;
      elapsed+=dt;advance(elapsed,false);
    };
    const timer=setInterval(tick,1000/fps);
    return()=>clearInterval(timer);
  },[active,fps,advance,setFrameloop,clock]);
  return null;
}

export function resolveQuality(requested, mobile) {
  return requested && QUALITY_PROFILES[requested] ? requested : mobile ? 'MOBILE' : 'HIGH';
}

export function useMobileQuality() {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 820px), (pointer: coarse)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 820px), (pointer: coarse)');
    const update = () => setMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return mobile;
}

export function WebGLContextStatus({ onStatus, label }) {
  const { gl, invalidate } = useThree();
  const restoring = useRef(false);
  useEffect(() => {
    const canvas = gl.domElement;
    const lost = event => {
      event.preventDefault();
      console.error(`[${label}] WebGL context lost`);
      onStatus('Graphics context lost. Waiting for restoration…');
    };
    const restored = () => {
      console.info(`[${label}] WebGL context restored`);
      restoring.current = true;
      onStatus('Restoring graphics…');
      invalidate();
    };
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
    return () => {
      canvas.removeEventListener('webglcontextlost', lost);
      canvas.removeEventListener('webglcontextrestored', restored);
    };
  }, [gl, invalidate, onStatus, label]);
  useFrame(() => {
    if (restoring.current && !gl.getContext().isContextLost()) {
      restoring.current = false;
      onStatus('');
    }
  });
  return null;
}
