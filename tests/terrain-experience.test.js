import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { constrainTerrainCamera } from '../src/engine/world.js';
import { terrainFrameDistance, terrainCameraLimits, terrainDisplayMetadata, terrainRenderBounds } from '../src/engine/terrainNavigation.js';
import { selectStreamedTiles } from '../src/scene/terrainGeometry.js';
import { SimulationClock, terrainAttachment, createScenarioObject } from '../src/engine/scenario.js';
import { environmentLayers, ENVIRONMENT_PROFILES } from '../src/engine/environment.js';

const flat = { size: 9, scale: 80, minH: 0, maxH: 0, elevationOrigin: 1000, data: new Float64Array(81) };

test('visibility follows visual exaggeration without modifying the scientific bounds', () => {
  const terrain = { size:1025, scale:1024, minH:1200, maxH:1250, stream:{max_level:3} };
  const camera = new THREE.PerspectiveCamera(50,1.6,.1,300);
  camera.position.set(100,5100,100);camera.lookAt(100,5000,0);camera.updateMatrixWorld();
  const target = new THREE.Vector3(100,5000,0);
  assert.equal(selectStreamedTiles(terrain,camera,900,target).length,0);
  assert.ok(selectStreamedTiles(terrainRenderBounds(terrain,4),camera,900,target).length>0);
  assert.equal(terrain.maxH,1250);
});

test('bounded pan moves camera and pivot coherently without imposing the global peak floor', () => {
  const camera = new THREE.PerspectiveCamera(50, 1.6, .1, 1000); camera.position.set(90, 12, 10);
  const controls = { target: new THREE.Vector3(60, 0, 0) };
  constrainTerrainCamera(camera, controls, flat);
  assert.equal(controls.target.x, 40); assert.equal(camera.position.x, 70);
  assert.equal(camera.position.x - controls.target.x, 30);
  assert.equal(camera.position.y, 12);
});

test('a ridge may occlude the pivot without launching the camera away from the terrain', () => {
  const terrain = { ...flat, maxH: 25, data: Float64Array.from({length:81}, (_,k) => Math.floor(k/9) === 6 ? 25 : 0) };
  const camera = new THREE.PerspectiveCamera(50, 1.6, .1, 1000); camera.position.set(35, 5, 0);
  const controls = { target: new THREE.Vector3(-20, 0, 0) };
  constrainTerrainCamera(camera, controls, terrain);
  assert.equal(camera.position.y, 5);
  assert.equal(controls.target.x, -20);
});

test('camera only clears local ground and repeated constraints do not amplify distance', () => {
  const terrain = { ...flat, maxH: 25, data: Float64Array.from({length:81}, (_,k) => Math.floor(k/9) === 6 ? 25 : 0) };
  const camera = new THREE.PerspectiveCamera(50, 1.6, .1, 1000); camera.position.set(20, 5, 0);
  const controls = { target: new THREE.Vector3(-20, 0, 0) };
  constrainTerrainCamera(camera, controls, terrain);
  assert.equal(camera.position.y, 27.5);
  const distance = camera.position.distanceTo(controls.target);
  for (let k=0;k<100;k++) constrainTerrainCamera(camera, controls, terrain);
  assert.equal(camera.position.distanceTo(controls.target),distance);
});

test('7 km physical extent stays independent of tessellation and visual exaggeration', () => {
  const terrain = { ...flat, size: 241, scale: 7015.263424367565, maxH: 142 };
  const analysis = { terrain, metadata: { provenance: { metric:true, source_shape:[3600,3600], source_gsd:30.748, analysis_gsd:29.230264268198187 } } };
  const before = JSON.stringify(analysis), displayed = terrainDisplayMetadata(analysis, 2);
  assert.equal(displayed.physicalExtent[0], 7015.263424367565); assert.equal(displayed.analysisGrid[0], 241);
  assert.equal(JSON.stringify(analysis), before);
  assert.ok(terrainCameraLimits(terrain).minDistance < 100);
  assert.ok(terrainFrameDistance(terrain,50,1.6)>terrain.scale);
});

test('clock is controllable; advancing it does not invent object dynamics', () => {
  const clock = new SimulationClock(); clock.advance(10); assert.equal(clock.elapsed,0);
  clock.play();clock.setTimeScale(2);clock.advance(.5); assert.equal(clock.elapsed,1);
  clock.pause();clock.advance(3);assert.equal(clock.elapsed,1);
  const object = createScenarioObject('VEHICLE',{x:2,z:3,elevation:1000,localHeight:0},'example',clock.elapsed,'id');
  const before = JSON.stringify(object); clock.play();clock.advance(10);assert.equal(JSON.stringify(object),before);
  assert.equal(object.mass,null);clock.reset();assert.deepEqual(clock.snapshot(),{elapsed:0,playing:false,timeScale:1});
  assert.throws(()=>clock.setTimeScale(0));
});

test('native bilinear object attachment is independent of streamed display LOD', async () => {
  const terrain = {...flat, tileSource: { inspect:async(i,j)=>({elevation:1000+i*10+j*5}) }};
  const attachment = await terrainAttachment(terrain,-17,-13);
  assert.ok(Math.abs(attachment.elevation-1036.5)<1e-10);
  terrain.tileSource.sample=()=>99999;
  assert.deepEqual(await terrainAttachment(terrain,-17,-13),attachment);
  await assert.rejects(terrainAttachment(terrain,50,0));
});

test('body profiles and environmental registry do not fabricate geography or lunar life', () => {
  assert.equal(ENVIRONMENT_PROFILES.moon.birds,false); assert.equal(ENVIRONMENT_PROFILES.mars.birds,false);
  assert.equal(ENVIRONMENT_PROFILES.moon.sky,'space');assert.notEqual(ENVIRONMENT_PROFILES.earth.sky,'space');
  assert.ok(environmentLayers().every(layer=>!layer.available));
  assert.ok(environmentLayers({colorUrl:'/uploaded-photo.png',provenance:{source:'image upload'}}).every(layer=>!layer.available));
  const layers = environmentLayers({colorUrl:'/actual.png',provenance:{source:'source',reference:'local CRS',acquisition:{imagery:{dataset_id:'Sentinel example',source:'Sentinel-2 L2A RGB'}}}});
  assert.deepEqual(layers.filter(l=>l.available).map(l=>l.kind),['satellite imagery']);
});
