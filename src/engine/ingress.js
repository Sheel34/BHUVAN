// ── Nap-of-the-Earth ingress planner ─────────────────────────────────
//
// The algorithm (the thing actually built): given terrain + enemy radar
// sites, find the lowest, most radar-masked route from start to target.
//   1. radar exposure — a grid cell is "seen" if a threat has line-of-sight
//      to it over the terrain, within range.
//   2. A* route — minimise exposure + altitude (hug valleys) to the target.
// Output drives the cinematic terrain-following fly-through.

import { sampleHeight } from './terrain';

const ROUTE_G = 60;           // routing grid resolution
const EXPOSURE_W = 14;        // cost of flying exposed to radar
const ALT_W = 3.5;            // cost of flying high (prefer valleys)
const SQRT2 = Math.SQRT2;

function gridToWorld(terrain, gi, gj) {
  const s = terrain.scale;
  return [(gi / (ROUTE_G - 1) - 0.5) * s, (gj / (ROUTE_G - 1) - 0.5) * s];
}

// Is B hidden from A by terrain? March the sight line; blocked if ground pokes
// above it anywhere between.
function losBlocked(terrain, ax, ay, az, bx, by, bz, steps = 22) {
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    const sight = ay + (by - ay) * t;
    if (sampleHeight(terrain, x, z) > sight + 0.5) return true;
  }
  return false;
}

export function planIngress(terrain, opts = {}) {
  const s = terrain.scale;
  const relief = Math.max(20, terrain.maxH - terrain.minH);
  const clearance = relief * 0.06 + s * 0.006; // nap-of-the-earth altitude

  const start = opts.start || { x: -s * 0.42, z: -s * 0.40 };
  const target = opts.target || { x: s * 0.36, z: s * 0.34 };
  const threats = opts.threats || [
    { x: -s * 0.02, z: s * 0.02, radius: s * 0.30 },
    { x: s * 0.16, z: -s * 0.20, radius: s * 0.24 },
  ];
  // radar mast height above local ground
  threats.forEach((t) => { t.y = sampleHeight(terrain, t.x, t.z) + relief * 0.10 + 8; });

  // ── exposure grid ──
  const exposure = new Float32Array(ROUTE_G * ROUTE_G);
  for (let gi = 0; gi < ROUTE_G; gi++) {
    for (let gj = 0; gj < ROUTE_G; gj++) {
      const [wx, wz] = gridToWorld(terrain, gi, gj);
      const fy = sampleHeight(terrain, wx, wz) + clearance;
      let seen = 0;
      for (const th of threats) {
        const d = Math.hypot(wx - th.x, wz - th.z);
        if (d > th.radius) continue;
        if (!losBlocked(terrain, th.x, th.y, th.z, wx, fy, wz)) { seen = 1; break; }
      }
      exposure[gi * ROUTE_G + gj] = seen;
    }
  }

  // ── A* over the grid ──
  const idx = (i, j) => i * ROUTE_G + j;
  const cellCost = (i, j) => {
    const [wx, wz] = gridToWorld(terrain, i, j);
    const h = (sampleHeight(terrain, wx, wz) - terrain.minH) / relief;
    return 1 + exposure[idx(i, j)] * EXPOSURE_W + Math.max(0, h) * ALT_W;
  };
  const toCell = (p) => [
    Math.round((p.x / s + 0.5) * (ROUTE_G - 1)),
    Math.round((p.z / s + 0.5) * (ROUTE_G - 1)),
  ];
  const [si, sj] = toCell(start);
  const [ti, tj] = toCell(target);

  const N = ROUTE_G * ROUTE_G;
  const g = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const open = [idx(si, sj)];
  g[idx(si, sj)] = 0;
  const h = (i, j) => Math.hypot(i - ti, j - tj);

  while (open.length) {
    // pop lowest f (linear scan — grid is small)
    let bi = 0, bf = Infinity;
    for (let k = 0; k < open.length; k++) {
      const c = open[k]; const ci = (c / ROUTE_G) | 0; const cj = c % ROUTE_G;
      const f = g[c] + h(ci, cj) * 1.2;
      if (f < bf) { bf = f; bi = k; }
    }
    const cur = open.splice(bi, 1)[0];
    const ci = (cur / ROUTE_G) | 0; const cj = cur % ROUTE_G;
    if (ci === ti && cj === tj) break;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        if (!di && !dj) continue;
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= ROUTE_G || nj >= ROUTE_G) continue;
        const step = (di && dj) ? SQRT2 : 1;
        const tentative = g[cur] + cellCost(ni, nj) * step;
        if (tentative < g[idx(ni, nj)]) {
          g[idx(ni, nj)] = tentative;
          came[idx(ni, nj)] = cur;
          if (!open.includes(idx(ni, nj))) open.push(idx(ni, nj));
        }
      }
    }
  }

  // ── reconstruct + drape ──
  const cells = [];
  let cur = idx(ti, tj);
  if (came[cur] === -1 && cur !== idx(si, sj)) {
    // no path found — fall back to straight line
    cells.push([si, sj], [ti, tj]);
  } else {
    while (cur !== -1) { cells.push([(cur / ROUTE_G) | 0, cur % ROUTE_G]); cur = came[cur]; }
    cells.reverse();
  }

  const routePoints = cells.map(([i, j]) => {
    const [wx, wz] = gridToWorld(terrain, i, j);
    return {
      x: wx,
      z: wz,
      y: sampleHeight(terrain, wx, wz) + clearance,
      exposed: exposure[idx(i, j)] > 0.5,
    };
  });

  return {
    routePoints,
    threats,
    start: { x: start.x, z: start.z, y: sampleHeight(terrain, start.x, start.z) + clearance },
    target: { x: target.x, z: target.z, y: sampleHeight(terrain, target.x, target.z) },
    cep: s * 0.03,
    clearance,
    exposedFraction: routePoints.length
      ? routePoints.filter((p) => p.exposed).length / routePoints.length
      : 0,
  };
}
