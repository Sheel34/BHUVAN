import test from 'node:test';
import assert from 'node:assert/strict';
import { planGridRoute,prepareRoverRoute,roverPose,relayVisibility,DEFAULT_ROVER,findRehearsalPlacement } from '../src/engine/rover.js';
import { lunarOrbitPosition,LUNAR_ORBIT } from '../src/engine/orbit.js';
import { parseEnvironmentFeatures,attachEnvironmentFeatures } from '../src/engine/environment.js';

const terrain={size:33,scale:32,minH:0,maxH:0,body:'earth',elevationOrigin:100,data:new Float64Array(33**2)};
const analysis={terrain,layers:{hazard:new Float32Array(33**2)},metadata:{provenance:{metric:true,status:'MEASURED'}}};
const vehicle={id:'rover',type:'VEHICLE',position:[-10,0,0]},objective={id:'goal',type:'OBJECTIVE',position:[10,0,0]};

test('rehearsal placement uses the current limits and refuses a wholly excluded patch',async()=> {
  const large={...terrain,scale:200,size:201,data:new Float64Array(201**2)};
  const fixture={...analysis,terrain:large,layers:{hazard:new Float32Array(201**2)}};
  const pair=await findRehearsalPlacement(fixture,DEFAULT_ROVER);
  assert.ok(pair.checkedDistance>=20);
  const route=await prepareRoverRoute(fixture,{...vehicle,position:pair.start},{...objective,position:pair.goal},DEFAULT_ROVER);
  assert.ok(route.maxSlope<=DEFAULT_ROVER.maxSlope&&route.maxHazard<=DEFAULT_ROVER.maxHazard);
  await assert.rejects(()=>findRehearsalPlacement({...fixture,layers:{hazard:new Float32Array(201**2).fill(1)}},DEFAULT_ROVER),/No short rover/);
});

test('planned route traverses native elevations and reaches the exact objective at a fixed speed',async()=> {
  const route=await prepareRoverRoute(analysis,vehicle,objective,DEFAULT_ROVER);
  assert.equal(route.distance,20);assert.equal(route.fidelity,'MEASURED');assert.equal(route.sourceGsd,1);
  const halfway=roverPose(route,10);assert.deepEqual(halfway.position,[0,0,0]);assert.equal(halfway.progress,.5);
  assert.deepEqual(roverPose(route,100).position,objective.position);assert.equal(roverPose(route,100).complete,true);
  assert.deepEqual(roverPose(route,-1).position,vehicle.position);
});

test('uncalibrated image depth cannot drive a metre-sized rover',async()=> {
  await assert.rejects(()=>prepareRoverRoute({...analysis,metadata:{provenance:{metric:false,status:'ESTIMATED'}}},vehicle,objective,DEFAULT_ROVER),/metric DEM/);
});

test('A* detours around explicit hazard areas without diagonal corner cutting',()=> {
  const route=planGridRoute(terrain,analysis.layers,vehicle.position,objective.position,DEFAULT_ROVER,[{position:[0,0,0],constraints:{radius:4}}]);
  assert.ok(route.path.every(p=>Math.hypot(p[0],p[2])>=4));
  assert.ok(route.path.some(p=>Math.abs(p[2])>=4));
});

test('a DEM hazard between planning nodes causes an automatic detour with only a rover and objective',async()=> {
  const size=257,heights=new Float64Array(size**2),hazard=new Float32Array(size**2);
  for(let i=127;i<=129;i++)for(let j=127;j<=129;j++) {heights[i*size+j]=-1;hazard[i*size+j]=1;}
  const fixture={...analysis,terrain:{...terrain,size,scale:256,minH:-1,data:heights},layers:{hazard}};
  const start={...vehicle,position:[-20,0,0]},goal={...objective,position:[20,0,0]};
  const route=await prepareRoverRoute(fixture,start,goal,DEFAULT_ROVER,[start,goal]);
  assert.ok(route.path.some(p=>Math.abs(p[2])>=4));
  assert.ok(route.maxHazard<=DEFAULT_ROVER.maxHazard);
  assert.deepEqual(roverPose(route,1000).position,goal.position);
});

test('impossible slope and submerged regions fail explicitly instead of playing an unsafe route',async()=> {
  const cliff={...terrain,maxH:100,data:Float64Array.from({length:33**2},(_,k)=>Math.floor(k/33)>=16?100:0)};
  assert.throws(()=>planGridRoute(cliff,analysis.layers,[-10,0,0],[10,100,0],DEFAULT_ROVER),/No route/);
  await assert.rejects(prepareRoverRoute(analysis,vehicle,objective,DEFAULT_ROVER,[],{water:true,waterLevel:101}),/excluded/);
  assert.throws(()=>planGridRoute(terrain,analysis.layers,[30,0,0],objective.position),/inside/);
});

test('native corridor validation catches a sharp ridge missed by a decimated planning grid',async()=> {
  const large={...terrain,size:257,scale:256,maxH:20,data:Float64Array.from({length:257**2},(_,k)=>Math.floor(k/257)===127?20:0)};
  const input={...analysis,terrain:large,layers:{hazard:new Float32Array(257**2)}};
  await assert.rejects(prepareRoverRoute(input,{...vehicle,position:[-10,0,0]},objective,DEFAULT_ROVER),/Native route check failed/);
});

test('relay reports local DEM obstruction and range rather than claiming radio performance',()=> {
  assert.equal(relayVisibility(terrain,vehicle.position,[]),'No relay');
  const relay={type:'RELAY',position:[0,0,0],constraints:{range:100}};
  assert.equal(relayVisibility(terrain,vehicle.position,[relay]),'DEM line of sight');
  assert.equal(relayVisibility(terrain,vehicle.position,[{...relay,constraints:{range:1}}]),'Terrain blocked / out of range');
});

test('feature import requires matching dataset, local coordinate reference and bounded source features',()=> {
  const doc={source:'Survey fixture',coordinateSpace:'dataset-local',datasetId:'d1',features:[{kind:'rocks',x:1,z:2,size:.5}]};
  assert.equal(parseEnvironmentFeatures(doc,terrain,'d1')[0].source,'Survey fixture');
  assert.throws(()=>parseEnvironmentFeatures(doc,terrain,'d2'));
  assert.throws(()=>parseEnvironmentFeatures({...doc,features:[{kind:'rocks',x:100,z:0,size:1}]},terrain,'d1'));
});

test('supplied environmental features attach to native elevations instead of the display fallback',async()=> {
  const native={...terrain,tileSource:{inspect:async(i,j)=>({elevation:100+i*2+j}) ,sample:()=>9999}};
  const [rock]=await attachEnvironmentFeatures([{kind:'rocks',x:0,z:0,size:1}],native);
  assert.equal(rock.groundHeight,48);
  assert.equal(relayVisibility({...native,stream:{}},vehicle.position,[{type:'RELAY',position:[0,0,0]}]),'Terrain blocked / out of range');
  assert.equal(relayVisibility({...native,tileSource:{sample:()=>undefined}},vehicle.position,[{type:'RELAY',position:[0,0,0]}]),'Terrain data unavailable');
});

test('route cannot use malformed speed or hazard limits',async()=> {
  await assert.rejects(prepareRoverRoute(analysis,vehicle,objective,{...DEFAULT_ROVER,speed:NaN}),/finite/);
  await assert.rejects(prepareRoverRoute(analysis,vehicle,objective,{...DEFAULT_ROVER,maxHazard:2}),/finite/);
  await assert.rejects(prepareRoverRoute({...analysis,layers:{}},vehicle,objective,DEFAULT_ROVER),/excluded/);
});

test('Kepler ellipse has its focus at Earth and advances faster near perigee',()=> {
  const a=LUNAR_ORBIT.displaySemiMajor,e=LUNAR_ORBIT.eccentricity;
  assert.ok(Math.abs(Math.hypot(...lunarOrbitPosition(0))-a*(1-e))<1e-10);
  assert.ok(Math.abs(Math.hypot(...lunarOrbitPosition(Math.PI))-a*(1+e))<1e-10);
  const distance=(p,q)=>Math.hypot(...p.map((v,i)=>v-q[i]));
  assert.ok(distance(lunarOrbitPosition(0),lunarOrbitPosition(.01))>distance(lunarOrbitPosition(Math.PI),lunarOrbitPosition(Math.PI+.01)));
  assert.deepEqual(lunarOrbitPosition(0),lunarOrbitPosition(Math.PI*2));
});
