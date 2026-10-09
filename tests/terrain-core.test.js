import test from 'node:test';
import assert from 'node:assert/strict';
import { precisionBenchmark, lunarLocalFrame, lunarBodyFixed, cameraRelative } from '../src/engine/coordinates.js';
import { MemoryTileSource, terrainTiles, windowValue } from '../src/engine/tileSource.js';
import { normalizeAnalysisPayload, inspectTerrainPoint } from '../src/engine/terrain.js';
import { planTerrainRoute } from '../src/engine/ingress.js';

test('lunar frame is reversible; rebasing never changes scientific positions', () => {
  const origin=lunarBodyFixed(-89,45), before=Array.from(origin);
  const frame=lunarLocalFrame(-89,45), local=[2,.01,5];
  const global=frame.toScientific(local), roundtrip=frame.toLocal(global);
  local.forEach((value,i)=>assert.ok(Math.abs(roundtrip[i]-value)<1e-8));
  cameraRelative(global,origin);
  assert.deepEqual(Array.from(origin),before);
  const moon=precisionBenchmark().find(row=>row.magnitude===1737400 && row.expectedSeparation===.01);
  assert.equal(moon.globalSeparation,0);
  assert.ok(moon.relativeError<1e-8);
});

test('scientific elevation offset is retained while rendering remains local', () => {
  const result=normalizeAnalysisPayload({ terrain:{size:2,scale:2,minH:1000000,maxH:1000000.01,data:[1000000,1000000.01,1000000,1000000.01]} });
  assert.ok(result.terrain.data[1]<.011);
  assert.equal(result.terrain.scientificData[1],1000000.01);
  assert.equal(inspectTerrainPoint(result,-1,1).elevation,1000000.01);
});

test('independent bounded tile reads share exact halo and edge values', async () => {
  const size=513, data=Float64Array.from({length:size*size},(_,k)=>k*.001);
  const source=new MemoryTileSource({ size,data,scale:512 });
  const tiles=terrainTiles(size), a=await source.readTile(tiles[0]), b=await source.readTile(tiles[1]);
  assert.ok(a.fields.height.length<=131**2);
  for(let i=0;i<=128;i++)assert.equal(windowValue(a,'height',i,128),windowValue(b,'height',i,128));
  const controller=new AbortController();controller.abort();
  await assert.rejects(source.readTile(tiles[0],{signal:controller.signal}));
});

test('route requires explicit scenario and reports blocked route without fabricating a straight line', () => {
  const terrain={size:8,scale:7,data:new Float64Array(64)};
  assert.throws(()=>planTerrainRoute(terrain));
  assert.throws(()=>planTerrainRoute(terrain,{start:{x:9,z:0},target:{x:0,z:0}}));
  const hazard=new Float32Array(64);for(let i=0;i<8;i++)hazard[i*8+4]=1;
  const result=planTerrainRoute(terrain,{start:{x:-3,z:-3},target:{x:3,z:3},hazard,maxHazard:.5});
  assert.equal(result.feasible,false);assert.deepEqual(result.routePoints,[]);
  assert.ok(planTerrainRoute(terrain,{start:{x:0,z:0},target:{x:1,z:1}}).feasible);
});
