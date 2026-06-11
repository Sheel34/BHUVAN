import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';

/* ── Render performance sampler ──
 * Lives inside the R3F Canvas; writes throttled stats straight into the
 * #perf-stats DOM node so 60 fps sampling never triggers React re-renders.
 */

const UPDATE_INTERVAL_MS = 500;

export default function PerfStats({ enabled }) {
  const { gl } = useThree();
  const acc = useRef({ frames: 0, time: 0, last: 0 });

  useEffect(() => {
    const el = document.getElementById('perf-stats');
    if (el) el.style.display = enabled ? 'block' : 'none';
  }, [enabled]);

  useFrame((_, dt) => {
    if (!enabled) return;
    const a = acc.current;
    a.frames += 1;
    a.time += dt;

    const now = performance.now();
    if (now - a.last < UPDATE_INTERVAL_MS) return;
    a.last = now;

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
