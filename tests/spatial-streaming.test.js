import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RemoteTileSource, decodeTerrainTile, MemoryTileSource, terrainTiles } from '../src/engine/tileSource.js';
import { precisionBenchmark, createRenderFrame, datasetCoordinateContext, lunarBodyFixed } from '../src/engine/coordinates.js';
import { buildTerrainTile, selectStreamedTiles, trimGeometryCache } from '../src/scene/terrainGeometry.js';

const descriptor={id:'fixture',size:32768,scale:32767,max_level:8,tile_url:'https://fixture/{level}/{x}/{y}',point_url:'https://fixture/point'};
function binary(level,x,y) {
  const metadata={dataset:{id:'fixture'},tile_id:`${level}/${x}/${y}`,level,rows:2,cols:2,
    row_indices:[y*128,y*128+1],column_indices:[x*128,x*128+1],fields:['height']};
  let json=new TextEncoder().encode(JSON.stringify(metadata));
  const padded=Math.ceil(json.length/4)*4,buffer=new ArrayBuffer(8+padded+16),bytes=new Uint8Array(buffer);
  bytes.set(new TextEncoder().encode('BHT1'));new DataView(buffer).setUint32(4,padded,true);
  bytes.fill(32,8,8+padded);bytes.set(json,8);new Float32Array(buffer,8+padded).set([1,2,3,4]);return buffer;
}
const response=(url)=> {const [l,x,y]=url.split('/').slice(-3).map(Number);return new Response(binary(l,x,y));};

test('numerical precision matrix labels float32 representation, not GPU jitter',()=> {
  const rows=precisionBenchmark();assert.equal(rows.length,32);
  for(const row of rows) {
    assert.equal(row.gpuJitterMeasured,false);
    assert.equal(row.kind,'numerical precision benchmark only');
    assert.equal(row.absoluteFloat32.absoluteError,Math.abs(row.globalSeparation-row.expectedSeparation));
    assert.equal(row.originFirstFloat32.relativeError,row.relativeError/row.expectedSeparation);
  }
  const moon=rows.find(r=>r.magnitude===1737400 && r.expectedSeparation===.01);
  assert.equal(moon.globalSeparation,0);assert.ok(moon.originFirstFloat32.absoluteError<1e-8);
});

test('render recentering leaves scientific coordinates and datum intact',()=> {
  const scientific=lunarBodyFixed(10,20,123),before=Array.from(scientific);
  const origin=[1000000,123,2000000],frame=createRenderFrame(origin);
  const local=[1000000.01,123.1,2000000.001];frame.toRender(local);frame.setOrigin(local);
  assert.deepEqual(Array.from(scientific),before);assert.deepEqual(origin,[1000000,123,2000000]);
  assert.deepEqual(Array.from(frame.toRender(local)),[0,0,0]);
  const context=datasetCoordinateContext({body:'moon',metric:true,analysis_gsd:5,vertical_reference:'LOLA sphere'}, {scale:2000,elevationOrigin:123});
  assert.equal(context.render.continuousFloatingOrigin,false);assert.equal(context.frameTransforms.inertialAvailable,false);
  assert.ok(context.curvatureApproximationM>.5 && context.curvatureApproximationM<.6);
  assert.equal(context.scientific.verticalReference,'LOLA sphere');
  const custom=datasetCoordinateContext({body:'moon',metric:true,reference_model:{a_m:1740000,b_m:1730000}}, {scale:2000,elevationOrigin:123});
  assert.equal(custom.curvatureApproximationM,null); // do not substitute a default sphere for a different source model
  const projected=datasetCoordinateContext({affine:[2,0,100000000,0,-2,200000000],horizontal_unit:'m'}, {scale:2000,elevationOrigin:123});
  assert.deepEqual(Array.from(projected.scientific.rasterToReference([0,0,123])),[100000001,199999999,123]);
  assert.deepEqual(Array.from(projected.render.frame.toRender([1,123.01,2])),[1,Math.fround(.01),2]);
  assert.throws(()=>lunarBodyFixed(95,20));
});

test('binary validation rejects truncated/malformed tiles',()=> {
  assert.equal(decodeTerrainTile(binary(0,0,0)).fields.height[3],4);
  assert.throws(()=>decodeTerrainTile(new ArrayBuffer(7)));
  assert.throws(()=>decodeTerrainTile(binary(0,0,0).slice(0,-4)));
});

test('fetch uses the browser/global receiver rather than the TileSource instance',async()=> {
  const source=new RemoteTileSource(descriptor,{fetchImpl:function(url) {assert.equal(this,globalThis);return Promise.resolve(response(url));}});
  await source.getTile(0,0,0);source.dispose();
});

test('remote requests deduplicate, cache stays bounded, and buffers are released',async()=> {
  let requests=0;
  const source=new RemoteTileSource(descriptor,{maxTiles:3,maxBytes:10000,fetchImpl:async url=>{requests++;await new Promise(r=>setTimeout(r,3));return response(url);}});
  const [a,b]=await Promise.all([source.getTile(0,0,0),source.getTile(0,0,0)]);
  assert.equal(a,b);assert.equal(requests,1);
  assert.equal(source.metrics.deduplicatedRequests,1);assert.equal(source.metrics.cacheHits,0);
  for(let x=1;x<15;x++)await source.getTile(0,x,0);
  assert.equal(source.cache.size,3);assert.equal(source.metrics.evicted,12);
  assert.ok(source.metrics.cacheBytes<=10000);assert.equal(source.inFlight.size,0);
  await source.getTile(0,14,0);assert.equal(source.metrics.cacheHits,1);
  source.dispose();assert.equal(source.metrics.cacheBytes,0);assert.equal(source.cache.size,0);
});

test('abort of one consumer preserves another, obsolete queued requests cancel',async()=> {
  let completed=0;
  const source=new RemoteTileSource(descriptor,{concurrency:1,fetchImpl:(url,{signal})=>new Promise((resolve,reject)=> {
    const timer=setTimeout(()=>{completed++;resolve(response(url));},20);
    signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});
  })});
  const abort=new AbortController(),a=source.getTile(0,0,0,{signal:abort.signal}),b=source.getTile(0,0,0);
  const settledA=assert.rejects(a);abort.abort();await settledA;await b;assert.equal(completed,1);
  const c=source.getTile(0,1,0),d=source.getTile(0,2,0),settled=Promise.allSettled([c,d]);
  source.cancelExcept(new Set());assert.ok((await settled).every(r=>r.status==='rejected'));
  assert.equal(source.inFlight.size,0);assert.ok(source.metrics.cancelled>=2);source.dispose();
});

test('retry policy is bounded and permanent HTTP errors do not loop',async()=> {
  let calls=0;
  const source=new RemoteTileSource(descriptor,{fetchImpl:async url=>++calls===1 ? new Response('',{status:503}) : response(url)});
  await source.getTile(0,0,0);assert.equal(calls,2);assert.equal(source.metrics.retries,1);source.dispose();
  const bad=new RemoteTileSource(descriptor,{fetchImpl:async()=>new Response('',{status:404})});
  await assert.rejects(bad.getTile(0,0,0));assert.equal(bad.metrics.retries,0);assert.equal(bad.errors.size,1);bad.dispose();
});

test('existing mixed interior LOD geometry retains identical native borders and normals',async()=> {
  const terrain={size:257,scale:256,minH:0,maxH:10,data:Float64Array.from({length:257**2},(_,k)=>Math.sin(Math.floor(k/257)*.04)+Math.cos(k%257*.02))};
  const source=new MemoryTileSource(terrain),all=terrainTiles(257);
  const left={...all[0],step:1},right={...all[1],step:8};
  const a=buildTerrainTile(terrain,left,await source.readTile(left)),b=buildTerrainTile(terrain,right,await source.readTile(right));
  function border(g) {
    const output=new Map(),samples=g.userData.samples;
    for(let k=0;k<samples.length/2;k++)if(samples[k*2+1]===128)output.set(samples[k*2],[g.attributes.position.getY(k),g.attributes.normal.getX(k),g.attributes.normal.getY(k),g.attributes.normal.getZ(k)]);
    return output;
  }
  const aa=border(a),bb=border(b);assert.equal(aa.size,129);assert.equal(bb.size,129);
  for(const [i,values] of aa)assert.deepEqual(bb.get(i),values);
  a.dispose();b.dispose();
});

test('32K visible selection is deterministic, bounded and uses a common LOD while panning',()=> {
  const terrain={size:32768,scale:32767,minH:-3,maxH:3,stream:{max_level:8}};
  const camera=new THREE.PerspectiveCamera(50,1.5,.1,300000),target=new THREE.Vector3();
  for(const [x,z,distance] of [[0,0,30000],[5000,5000,1500],[-5000,6000,200]]) {
    target.set(x,0,z);camera.position.set(x,distance,z+distance*.5);camera.lookAt(target);camera.updateMatrixWorld();
    const tiles=selectStreamedTiles(terrain,camera,900,target);
    assert.ok(tiles.length>0 && tiles.length<=32);assert.equal(new Set(tiles.map(t=>t.level)).size,1);
    assert.deepEqual(selectStreamedTiles(terrain,camera,900,target),tiles);
  }
});

test('geometry eviction retains pending as well as visible tiles, preventing disposed orphan uploads',()=> {
  const disposed=[],cache=new Map();
  for(let k=0;k<96;k++)cache.set(String(k),{geometry:{dispose:()=>disposed.push(k)}});
  const visible=Array.from({length:32},(_,k)=>String(k+32)),pending=Array.from({length:32},(_,k)=>String(k+64));
  trimGeometryCache(cache,new Set([...visible,...pending]));
  assert.equal(cache.size,64);assert.deepEqual(disposed,Array.from({length:32},(_,k)=>k));
  for(const key of [...visible,...pending])assert.ok(cache.has(key));
});
