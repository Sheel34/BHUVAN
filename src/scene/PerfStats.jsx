import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';

/* ── Render performance sampler ──
 * Lives inside the R3F Canvas; writes throttled stats straight into the
 * #perf-stats DOM node so 60 fps sampling never triggers React re-renders.
 */

const UPDATE_INTERVAL_MS = 500;

export default function PerfStats({ enabled, onStats }) {
  const { gl } = useThree();
  const acc = useRef({ frames: 0, time: 0, last: 0, lastFrame: 0 });

  useEffect(() => {
    const el = document.getElementById('perf-stats');
    if (el) el.style.display = enabled ? 'block' : 'none';
  }, [enabled]);

  useEffect(()=>{const now=performance.now();acc.current={frames:0,time:0,last:now,lastFrame:now};},[enabled]);
  useFrame((_, dt) => {
    const a=acc.current,now=performance.now();
    // Report wall-clock frame intervals, not the simulation's clamped delta.
    const frameSeconds=a.lastFrame>0?(now-a.lastFrame)/1000:dt;
    a.lastFrame=now;
    if(import.meta.env.DEV) {
      const stats=globalThis.__BHUVAN_STREAMING_STATS__;
      if(stats) {
        stats.measuredFrames=(stats.measuredFrames||0)+1;stats.measuredTimeMs=(stats.measuredTimeMs||0)+frameSeconds*1000;
        stats.averageFrameMs=stats.measuredTimeMs/stats.measuredFrames;
        stats.averageFps=1000/stats.averageFrameMs;
        stats.browserHeapBytes=performance.memory?.usedJSHeapSize ?? null;
        stats.geometryCount=gl.info.memory.geometries;stats.renderedTriangles=gl.info.render.triangles;
      }
    }
    if (!enabled) return;
    a.frames += 1;
    a.time += frameSeconds;

    if (now - a.last < UPDATE_INTERVAL_MS) return;
    a.last = now;
    onStats?.({ fps: a.frames / a.time, frameMs: a.time / a.frames * 1000,
      drawCalls: gl.info.render.calls, renderedTriangles: gl.info.render.triangles,
      geometryCount: gl.info.memory.geometries,
      browserHeapBytes: performance.memory?.usedJSHeapSize ?? null });

    const el = document.getElementById('perf-stats');
    if (el) {
      const fps = a.frames / a.time;
      const frameMs = (a.time / a.frames) * 1000;
      const info = gl.info.render;
      el.textContent =
        `${fps.toFixed(0)} FPS  ${frameMs.toFixed(1)} ms\n` +
        `draw calls ${info.calls}\n` +
        `tris ${(info.triangles / 1000).toFixed(1)}k\n` +
        `geom ${gl.info.memory.geometries}  tex ${gl.info.memory.textures}`;
    }
    a.frames = 0;
    a.time = 0;
  });

  return null;
}
