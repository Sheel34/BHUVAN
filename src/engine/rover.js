import { vehicleWheels } from './vehicleProfiles.js';
import { sampleHeight, sampleRaster } from './terrain.js';
import { RemoteTileSource, windowValue } from './tileSource.js';
import { triangleHeight, roverGroundSupport } from './surfacePlacement.js';
import { hasRehearsalScale, terrainWindowExtrema } from './imageRehearsal.js';

export const DEFAULT_ROVER = Object.freeze({ profileId: 'generic', obstacleWidth: .5, speed: 1, maxSlope: 25, maxHazard: .8 });

function queue() {
  const heap=[];
  return {
    push(node) { heap.push(node); let i=heap.length-1; while(i) { const p=(i-1)>>1; if(heap[p].cost<=node.cost)break; heap[i]=heap[p]; i=p; } heap[i]=node; },
    pop() { const top=heap[0],last=heap.pop(); if(heap.length) { let i=0; while(i*2+1<heap.length) { let j=i*2+1;if(j+1<heap.length && heap[j+1].cost<heap[j].cost)j++;if(heap[j].cost>=last.cost)break;heap[i]=heap[j];i=j; } heap[i]=last; } return top; },
    get length() { return heap.length; },
  };
}

export function planGridRoute(terrain, layers, start, goal, settings=DEFAULT_ROVER, obstacles=[], environment={}) {
  const count=Math.min(settings.planningCount||129,terrain.size), cell=terrain.scale/(count-1), half=terrain.scale/2;
  const index=(x,z)=>Math.round((x+half)/cell)*count+Math.round((z+half)/cell);
  for(const point of [start,goal]) if(![point[0],point[2]].every(Number.isFinite) || Math.max(Math.abs(point[0]),Math.abs(point[2]))>half) throw new Error('Rover and objective must lie inside this dataset.');
  const total=count*count, heights=new Float64Array(total), hazards=new Float32Array(total), blocked=new Uint8Array(total);
  const stride=(terrain.size-1)/(count-1),nativeCell=terrain.scale/(terrain.size-1);
  const wheelRadius=Math.max(...vehicleWheels(settings.profileId).map(([x,z])=>Math.hypot(x,z)));
  const pooled=layers?.hazard?.length===terrain.size**2?
    terrainWindowExtrema(Float32Array.from(layers.hazard,v=>Number.isFinite(v)?v:1),terrain.size,
      Math.min(terrain.size-1,Math.ceil(stride/2+wheelRadius/nativeCell)),true):null;
  for(let i=0;i<count;i++) for(let j=0;j<count;j++) {
    const k=i*count+j,x=i*cell-half,z=j*cell-half;
    heights[k]=sampleHeight(terrain,x,z);let hazard=sampleRaster(layers?.hazard,terrain,x,z);
    // Preserve resolved hazards between the coarser planning nodes. Averaging
    // or point sampling can erase a small pit before A* ever sees it.
    if(pooled)hazard=pooled[Math.round(i*stride)*terrain.size+Math.round(j*stride)];
    hazards[k]=Number.isFinite(hazard)?hazard:1;
    blocked[k]=!Number.isFinite(heights[k]) || !Number.isFinite(hazard) || hazards[k]>(settings.maxHazard ?? .8)
      || (environment.water && terrain.body==='earth' && heights[k]+(terrain.elevationOrigin||0)<environment.waterLevel)
      || obstacles.some(o=>Math.hypot(x-o.position[0],z-o.position[2])<(o.constraints?.radius ?? (o.type==='HAZARD REGION'?cell*1.5:6))+cell*.5);
  }
  const source=index(start[0],start[2]),destination=index(goal[0],goal[2]);
  const separation=new Float32Array(total);
  // Encourage genuinely separate corridors without changing exclusion limits.
  // Leave the common start/end approaches free of this preference penalty.
  for(const path of settings.avoidPaths||[])for(const p of path) {
    const i=Math.round((p[0]+half)/cell),j=Math.round((p[2]+half)/cell);
    for(let a=Math.max(0,i-3);a<=Math.min(count-1,i+3);a++)for(let b=Math.max(0,j-3);b<=Math.min(count-1,j+3);b++) {
      const x=a*cell-half,z=b*cell-half;
      if(Math.min(Math.hypot(x-start[0],z-start[2]),Math.hypot(x-goal[0],z-goal[2]))<cell*4)continue;
      separation[a*count+b]=Math.max(separation[a*count+b],Math.max(0,1-Math.hypot(a-i,b-j)/3)*8);
    }
  }
  if(blocked[source]||blocked[destination]) {
    const k=blocked[source]?source:destination,name=blocked[source]?'Rover start':'Destination';
    if(!Number.isFinite(heights[k])||!Number.isFinite(sampleRaster(layers?.hazard,terrain,Math.floor(k/count)*cell-half,k%count*cell-half)))
      throw new Error(`${name} excluded: elevation or hazard data is missing. Choose a point with measured coverage.`);
    if(hazards[k]>(settings.maxHazard??.8))throw new Error(`${name} excluded: mapped hazard ${hazards[k].toFixed(2)} exceeds your ${(settings.maxHazard??.8).toFixed(2)} limit. Inspect the Hazard layer, move the point, or revise the experimental limit.`);
    if(environment.water&&terrain.body==='earth'&&heights[k]+(terrain.elevationOrigin||0)<environment.waterLevel)
      throw new Error(`${name} excluded: DEM elevation ${(heights[k]+(terrain.elevationOrigin||0)).toFixed(2)} m is below the scenario water level ${environment.waterLevel} m.`);
    throw new Error(`${name} excluded by a facility or declared hazard footprint. Move the point or change that object's exclusion radius.`);
  }
  const cost=new Float64Array(total).fill(Infinity),previous=new Int32Array(total).fill(-1),closed=new Uint8Array(total),open=queue();
  const heuristic=k=>Math.hypot(Math.floor(k/count)-Math.floor(destination/count),k%count-destination%count)*cell;
  cost[source]=0;open.push({id:source,cost:heuristic(source)});
  const slopeLimit=settings.maxSlope ?? 25;
  while(open.length) {
    const current=open.pop().id;if(closed[current])continue;closed[current]=1;if(current===destination)break;
    const i=Math.floor(current/count),j=current%count;
    for(const [di,dj] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
      const ni=i+di,nj=j+dj;if(ni<0||nj<0||ni>=count||nj>=count)continue;
      const next=ni*count+nj;if(blocked[next]||closed[next])continue;
      if(di && dj && (blocked[(i+di)*count+j] || blocked[i*count+j+dj]))continue;
      const horizontal=cell*Math.hypot(di,dj),rise=heights[next]-heights[current];
      const slope=Math.atan2(Math.abs(rise),horizontal)*180/Math.PI;
      if(slope>slopeLimit)continue;
      const candidate=cost[current]+Math.hypot(horizontal,rise)*(1+hazards[next]*(settings.hazardWeight??4)
        +(slope/Math.max(1,slopeLimit))**2*(settings.gradeWeight??1)+separation[next]);
      if(candidate>=cost[next])continue;cost[next]=candidate;previous[next]=current;open.push({id:next,cost:candidate+heuristic(next)});
    }
  }
  if(!closed[destination])throw new Error('No route meets the slope, hazard and exclusion limits on the planning grid.');
  const path=[];for(let k=destination;k!==-1;k=previous[k])path.push([Math.floor(k/count)*cell-half,heights[k],k%count*cell-half]);path.reverse();
  if(path.length===1)path.push([...path[0]]);
  path[0]=[start[0],sampleHeight(terrain,start[0],start[2]),start[2]];
  path[path.length-1]=[goal[0],sampleHeight(terrain,goal[0],goal[2]),goal[2]];
  return {path,planningGsd:cell};
}

// Own tile consumer prevents the renderer's camera-dependent cancellation from
// cancelling route preparation. An overview proposes a route; native windows
// then attach and check it, without inventing detail between source samples.
export async function prepareRoverRoute(analysis, vehicle, objective, settings, objects=[], environment={}, signal) {
  if(!hasRehearsalScale(analysis))throw new Error('Choose a metric DEM or assign an assumed image rehearsal scale.');
  if(!Number.isFinite(settings.speed)||settings.speed<=0||!Number.isFinite(settings.maxSlope)||settings.maxSlope<=0||!Number.isFinite(settings.maxHazard)||settings.maxHazard<0||settings.maxHazard>1)throw new Error('Rover speed, grade and hazard limits must be finite and valid.');
  const terrain=analysis.terrain;
  const source=terrain.stream ? new RemoteTileSource(terrain.stream,{maxTiles:96,maxBytes:64*1024*1024}) : null;
  try {
    let planning=terrain,layers=analysis.layers;
    if(source) {
      const level=terrain.stream.max_level,overview=await source.getTile(level,0,0,{signal});
      const n=overview.rows;
      const values=Float64Array.from({length:n*n},(_,k)=>windowValue(overview,'height',overview.rowIndices[Math.floor(k/n)],overview.columnIndices[k%n]));
      planning={...terrain,tileSource:null,size:n,data:values};
      const hazardField=overview.fields.planning_hazard?'planning_hazard':'hazard';
      layers={hazard:Float32Array.from({length:n*n},(_,k)=>windowValue(overview,hazardField,overview.rowIndices[Math.floor(k/n)],overview.columnIndices[k%n])??NaN)};
    }
    signal?.throwIfAborted();
    const obstacles=[...objects.filter(o=>o.type==='HAZARD REGION'||o.type==='FACILITY'||o.type==='STATION'),
      ...(environment.features||[]).filter(f=>['rocks','buildings'].includes(f.kind)).map(f=>({position:[f.x,0,f.z],constraints:{radius:f.size*.71+1.3}}))];
    const planningSettings={...settings,planningCount:analysis.metadata?.rehearsalScale?257:settings.planningCount};
    const proposed=planGridRoute(planning,layers,vehicle.position,objective.position,planningSettings,obstacles,environment);
    const step=terrain.scale/(terrain.size-1)/2,coordinates=[];
    for(let k=1;k<proposed.path.length;k++) {
      const a=proposed.path[k-1],b=proposed.path[k],n=Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[2]-a[2])/step));
      for(let j=0;j<n;j++)coordinates.push([a[0]+(b[0]-a[0])*j/n,a[2]+(b[2]-a[2])*j/n]);
    }
    coordinates.push([objective.position[0],objective.position[2]]);
    if(coordinates.length>20000)throw new Error('Route exceeds the bounded rehearsal working set. Use a closer objective.');
    if(source) {
      const keys=new Map();
      const footprint=coordinates.flatMap(([x,z])=>[[x,z],[x-1.5,z-1.5],[x+1.5,z+1.5],[x-1.5,z+1.5],[x+1.5,z-1.5]]);
      for(const [x,z] of footprint) {
        const i=Math.min(terrain.size-2,Math.max(0,Math.floor((x/terrain.scale+.5)*(terrain.size-1))));
        const j=Math.min(terrain.size-2,Math.max(0,Math.floor((z/terrain.scale+.5)*(terrain.size-1))));
        const y=Math.floor(i/128),tx=Math.floor(j/128);keys.set(`${tx}:${y}`,[tx,y]);
      }
      if(keys.size>64)throw new Error('Native route corridor is too large. Use a closer objective.');
      await Promise.all([...keys.values()].map(([x,y])=>source.getTile(0,x,y,{signal})));
    }
    let retainedHeightTiles=null;
    const nativeHeight=(x,z)=> {
      if(Math.max(Math.abs(x),Math.abs(z))>terrain.scale/2)return NaN;
      const fi=(x/terrain.scale+.5)*(terrain.size-1),fj=(z/terrain.scale+.5)*(terrain.size-1);
      const i=Math.min(terrain.size-2,Math.max(0,Math.floor(fi))),j=Math.min(terrain.size-2,Math.max(0,Math.floor(fj))),a=fi-i,b=fj-j;
      const window=source ? (retainedHeightTiles||source.cache).get(`0/${Math.floor(j/128)}/${Math.floor(i/128)}`) : null;
      const get=(di,dj)=>source ? windowValue(window,'height',i+di,j+dj) : terrain.data[(i+di)*terrain.size+j+dj];
      return triangleHeight(get(0,0),get(1,0),get(0,1),get(1,1),a,b);
    };
    const path=coordinates.map(([x,z])=>[x,nativeHeight(x,z),z]);
    let distance=0,maxSlope=0,maxHazard=0,maxRoll=0,maxUnsupportedHeight=0,hazardSum=0;const cumulative=[0],supports=[];
    for(let k=0;k<path.length;k++) {
      const p=path[k];if(!Number.isFinite(p[1]))throw new Error('Native elevation is missing along the route.');
      const next=path[Math.min(k+1,path.length-1)],previous=path[Math.max(k-1,0)];
      const heading=Math.atan2(next[0]-previous[0],next[2]-previous[2]);
      const support=roverGroundSupport(p,heading,nativeHeight,vehicleWheels(settings.profileId));supports.push(support);
      maxRoll=Math.max(maxRoll,Math.abs(support.roll)*180/Math.PI);maxUnsupportedHeight=Math.max(maxUnsupportedHeight,support.unsupportedHeight);
      if(obstacles.some(o=>Math.hypot(p[0]-o.position[0],p[2]-o.position[2])<(o.constraints?.radius ?? (o.type==='HAZARD REGION'?proposed.planningGsd*1.5:6))))throw new Error('Native corridor crosses a facility or hazard exclusion. Move the objective or enlarge the exclusion.');
      const i=Math.round((p[0]/terrain.scale+.5)*(terrain.size-1)),j=Math.round((p[2]/terrain.scale+.5)*(terrain.size-1));
      const contactHazards=support.contacts.map(contact=> {
        const row=Math.round((contact.worldX/terrain.scale+.5)*(terrain.size-1));
        const column=Math.round((contact.worldZ/terrain.scale+.5)*(terrain.size-1));
        return source?source.sample('hazard',row,column):sampleRaster(analysis.layers?.hazard,terrain,contact.worldX,contact.worldZ);
      });
      const hazard=Math.max(source ? source.sample('hazard',i,j) : sampleRaster(analysis.layers?.hazard,terrain,p[0],p[2]),...contactHazards);
      if(!Number.isFinite(hazard))throw new Error('Native hazard raster is missing along the route.');
      maxHazard=Math.max(maxHazard,hazard);
      hazardSum+=hazard;
      if(environment.water && terrain.body==='earth' && p[1]+(terrain.elevationOrigin||0)<environment.waterLevel)throw new Error('Native route crosses the scenario water level.');
      if(k) { const a=path[k-1],h=Math.hypot(p[0]-a[0],p[2]-a[2]);distance+=Math.hypot(h,p[1]-a[1]);cumulative.push(distance);maxSlope=Math.max(maxSlope,Math.atan2(Math.abs(p[1]-a[1]),h)*180/Math.PI); }
    }
    if(maxSlope>settings.maxSlope+.01 || maxHazard>settings.maxHazard+.001)throw new Error(`Native route check failed: ${maxSlope.toFixed(1)}° maximum grade, ${maxHazard.toFixed(2)} hazard. Move the objective or change the limits.`);
    if(source)retainedHeightTiles=new Map([...source.cache].filter(([key])=>key.startsWith('0/')).map(([key,window])=>[key,{...window,fields:{height:Float32Array.from(window.fields.height)}}]));
    return { ...proposed,path,supports,cumulative,distance,maxSlope,maxHazard,meanHazard:hazardSum/path.length,maxRoll,maxUnsupportedHeight,groundHeight:nativeHeight,vehicleId:vehicle.id,objectiveId:objective.id,
      profileId:settings.profileId,wheels:vehicleWheels(settings.profileId),speed:settings.speed,sourceGsd:terrain.scale/(terrain.size-1),metric:analysis.metadata?.provenance?.metric===true,
      fidelity:analysis.metadata?.rehearsalScale?'ESTIMATED · ASSUMED SCALE':analysis.metadata?.provenance?.status||'UNKNOWN',
      assumedScale:analysis.metadata?.rehearsalScale||null,model:'kinematic route rehearsal; source triangles and six-point ground support; no wheel/soil dynamics' };
  } finally {source?.dispose();}
}

export function routeOverlap(a,b) {
  const cell=Math.max(a.planningGsd,b.planningGsd),keys=new Set();
  for(const p of a.path)keys.add(`${Math.round(p[0]/cell)}:${Math.round(p[2]/cell)}`);
  const other=new Set(b.path.map(p=>`${Math.round(p[0]/cell)}:${Math.round(p[2]/cell)}`));
  let common=0;for(const key of other)if(keys.has(key))common++;
  return common/Math.max(1,Math.min(keys.size,other.size));
}

export async function prepareRoverRoutes(analysis,vehicle,objective,settings,objects=[],environment={},signal) {
  const choices=[],accepted=[];
  for(const preference of [
    {id:'direct',label:'Direct',hazardWeight:1,gradeWeight:.25},
    {id:'hazard',label:'Hazard priority',hazardWeight:16,gradeWeight:1},
    {id:'grade',label:'Grade priority',hazardWeight:4,gradeWeight:8},
  ]) {
    signal?.throwIfAborted();
    // Yield between searches so cancellation and the busy state can paint.
    await new Promise(resolve=>setTimeout(resolve,0));
    try {
      const route=await prepareRoverRoute(analysis,vehicle,objective,{...settings,...preference,
        avoidPaths:accepted.map(r=>r.path)},objects,environment,signal);
      if(accepted.some(r=>routeOverlap(r,route)>.8))choices.push({...preference,reason:'No separate corridor under these limits.'});
      else {accepted.push(route);choices.push({...preference,route});}
    } catch(error) {
      if(signal?.aborted||error.name==='AbortError')throw error;
      choices.push({...preference,reason:error.message});
    }
  }
  if(!accepted.length)throw new Error(choices[0].reason);
  return choices;
}

export function roverPose(route,elapsed) {
  const distance=Math.min(route.distance,Math.max(0,elapsed)*route.speed);
  let lo=0,hi=route.cumulative.length-1;
  while(lo<hi) {const mid=(lo+hi)>>1;if(route.cumulative[mid]<distance)lo=mid+1;else hi=mid;}
  const k=Math.max(1,lo),a=route.path[k-1],b=route.path[k],span=route.cumulative[k]-route.cumulative[k-1];
  const t=span ? (distance-route.cumulative[k-1])/span : 1;
  const supportA=route.supports?.[k-1],supportB=route.supports?.[k];
  const position=a.map((v,i)=>v+(b[i]-v)*t),heading=Math.atan2(b[0]-a[0],b[2]-a[2]);
  if(route.groundHeight)position[1]=route.groundHeight(position[0],position[2]);
  const support=route.groundHeight ? roverGroundSupport(position,heading,route.groundHeight,route.wheels) : supportA&&supportB ? {centerHeight:supportA.centerHeight+(supportB.centerHeight-supportA.centerHeight)*t,
    pitch:supportA.pitch+(supportB.pitch-supportA.pitch)*t,roll:supportA.roll+(supportB.roll-supportA.roll)*t,
    unsupportedHeight:supportA.unsupportedHeight+(supportB.unsupportedHeight-supportA.unsupportedHeight)*t} : null;
  return {position,heading,
    pitch:support?.pitch ?? Math.atan2(b[1]-a[1],Math.hypot(b[0]-a[0],b[2]-a[2])),roll:support?.roll||0,support,distance,
    progress:route.distance ? distance/route.distance : 1,complete:distance>=route.distance,
    remaining:Math.max(0,route.distance-distance)/route.speed};
}

export function traverseCSV(route,elevationOrigin=0) {
  return [`elapsed_s,distance_m,local_x_m,local_z_m,${route.assumedScale?'assumed_surface_height_m':'dem_elevation_m'},chassis_support_elevation_m,pitch_deg,roll_deg,unsupported_wheel_height_m`,
    ...route.path.map((p,k)=>[route.cumulative[k]/route.speed,route.cumulative[k],p[0],p[2],p[1]+elevationOrigin,
      (route.supports?.[k]?.centerHeight??p[1])+elevationOrigin,(route.supports?.[k]?.pitch||0)*180/Math.PI,
      (route.supports?.[k]?.roll||0)*180/Math.PI,route.supports?.[k]?.unsupportedHeight||0].map(v=>v.toFixed(6)).join(','))].join('\n');
}

export function relayVisibility(terrain,position,objects,mast=2) {
  const relays=objects.filter(o=>['RELAY','STATION','FACILITY'].includes(o.type));
  if(!relays.length)return 'No relay';
  let unknown=false;
  const visible=relays.some(o=> {
    if(Math.hypot(position[0]-o.position[0],position[2]-o.position[2])>(o.constraints?.range??terrain.scale*.5))return false;
    for(let k=1;k<48;k++) {const t=k/48,x=position[0]+(o.position[0]-position[0])*t,z=position[2]+(o.position[2]-position[2])*t;
      const height=terrain.tileSource ? terrain.tileSource.sample('height',(x/terrain.scale+.5)*(terrain.size-1),(z/terrain.scale+.5)*(terrain.size-1)) : sampleHeight(terrain,x,z);
      if(!Number.isFinite(height)){unknown=true;return false;}
      if(height>position[1]+(o.position[1]-position[1])*t+mast)return false;}
    return true;
  });
  return visible ? (terrain.stream?'Display DEM line of sight':'DEM line of sight') : unknown?'Terrain data unavailable':'Terrain blocked / out of range';
}

// Choose a usable example under the user's current limits. It remains a
// rehearsal: no limit is relaxed and native validation can reject every pair.
export async function findRehearsalPlacement(analysis,settings,objects=[],environment={},signal) {
  const terrain=analysis.terrain;
  let grid=terrain,layers=analysis.layers;
  const source=terrain.stream ? new RemoteTileSource(terrain.stream,{maxTiles:2,maxBytes:8*1024*1024}) : null;
  try {
    if(source) {
      const tile=await source.getTile(terrain.stream.max_level,0,0,{signal}),n=tile.rows;
      const sample=field=>Float64Array.from({length:n*n},(_,k)=>windowValue(tile,field,tile.rowIndices[Math.floor(k/n)],tile.columnIndices[k%n]));
      grid={...terrain,tileSource:null,size:n,data:sample('height')};layers={hazard:sample('hazard')};
    }
    const count=Math.min(129,grid.size),half=terrain.scale/2,step=terrain.scale/(count-1),distance=Math.max(20,Math.min(100,terrain.scale*.07));
    const candidates=[];
    for(let i=1;i<count-1;i++)for(let j=1;j<count-1;j++) {
      const x=i*step-half,z=j*step-half;
      if(Math.max(Math.abs(x),Math.abs(z))>half-distance-4)continue;
      const hazard=sampleRaster(layers?.hazard,grid,x,z);
      if(!Number.isFinite(hazard)||hazard>settings.maxHazard)continue;
      candidates.push({x,z,score:hazard+Math.hypot(x,z)/terrain.scale*.03});
    }
    candidates.sort((a,b)=>a.score-b.score);
    const centers=[];
    for(const candidate of candidates) {
      if(centers.every(p=>Math.hypot(p.x-candidate.x,p.z-candidate.z)>distance*.6))centers.push(candidate);
      if(centers.length===8)break;
    }
    for(const p of centers)for(const [dx,dz] of [[distance,0],[0,distance],[-distance,0],[0,-distance]]) {
      signal?.throwIfAborted();
      const vehicle={id:'example-rover',type:'VEHICLE',position:[p.x,0,p.z]},objective={id:'example-objective',type:'OBJECTIVE',position:[p.x+dx,0,p.z+dz]};
      try {
        const route=await prepareRoverRoute(analysis,vehicle,objective,settings,objects,environment,signal);
        return {start:route.path[0],goal:route.path.at(-1),checkedDistance:route.distance};
      } catch(error) {if(signal?.aborted||error.name==='AbortError')throw error;}
    }
    throw new Error('No short rover rehearsal meets the current native DEM, grade, hazard and exclusion limits. Place points manually or revise the scenario assumptions.');
  } finally {source?.dispose();}
}
