// Generic approximate terrain route evaluation. No default scenario and no
// weapon/radar model. Dormant unless an explicit caller supplies start/goal.
import { sampleHeight, sampleRaster } from './terrain.js';
const ROUTE_G = 60;
const SQRT2 = Math.SQRT2;
function gridToWorld(terrain, i, j) {
  return [(i/(ROUTE_G-1)-.5)*terrain.scale,(j/(ROUTE_G-1)-.5)*terrain.scale];
}
export function planTerrainRoute(terrain, opts = {}) {
  const { start, target, hazard, maxHazard = 1 } = opts;
  const valid = p => p && Number.isFinite(p.x) && Number.isFinite(p.z) && Math.abs(p.x)<=terrain.scale/2 && Math.abs(p.z)<=terrain.scale/2;
  if(!valid(start) || !valid(target)) throw new Error('Explicit start and goal must lie within the terrain patch.');
  if(hazard && hazard.length!==terrain.size**2) throw new Error('Hazard raster does not match terrain.');
  const idx=(i,j)=>i*ROUTE_G+j;
  const cellCost=(i,j)=> {
    const [x,z]=gridToWorld(terrain,i,j);
    const value=hazard ? sampleRaster(hazard,terrain,x,z) : 0;
    return !Number.isFinite(value) || value>maxHazard ? Infinity : 1+4*value;
  };
  const toCell=p=>[Math.round((p.x/terrain.scale+.5)*(ROUTE_G-1)),Math.round((p.z/terrain.scale+.5)*(ROUTE_G-1))];
  const [si,sj]=toCell(start), [ti,tj]=toCell(target);
  const failure={ feasible:false,routePoints:[],limitations:['Coarse 60 × 60 raster routing; sub-cell obstacles and vehicle geometry are not evaluated.'] };
  if(!Number.isFinite(cellCost(si,sj)) || !Number.isFinite(cellCost(ti,tj))) return failure;
  const N=ROUTE_G*ROUTE_G, g=new Float64Array(N).fill(Infinity), came=new Int32Array(N).fill(-1);
  const open=[idx(si,sj)];g[idx(si,sj)]=0;
  const h = (i, j) => Math.hypot(i - ti, j - tj);

  while (open.length) {
    // pop lowest f (linear scan — grid is small)
    let bi = 0, bf = Infinity;
    for (let k = 0; k < open.length; k++) {
      const c = open[k]; const ci = (c / ROUTE_G) | 0; const cj = c % ROUTE_G;
      const f = g[c] + h(ci, cj);
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
        if (!Number.isFinite(cellCost(ni,nj))) continue;
        if(di && dj && (!Number.isFinite(cellCost(ci+di,cj)) || !Number.isFinite(cellCost(ci,cj+dj)))) continue;
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

  let cur=idx(ti,tj);
  if(came[cur]===-1 && cur!==idx(si,sj))return failure;
  const cells=[];
  while(cur!==-1) { cells.push([Math.floor(cur/ROUTE_G),cur%ROUTE_G]);cur=came[cur]; }
  cells.reverse();
  const routePoints=cells.map(([i,j])=> { const [x,z]=gridToWorld(terrain,i,j);return {x,z,y:sampleHeight(terrain,x,z)}; });
  return { feasible:true,routePoints,cost:g[idx(ti,tj)],limitations:failure.limitations };
}
