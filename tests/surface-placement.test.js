import test from 'node:test';
import assert from 'node:assert/strict';
import { triangleHeight,roverGroundSupport } from '../src/engine/surfacePlacement.js';
import { terrainAttachment } from '../src/engine/scenario.js';
import { buildTerrainTile } from '../src/scene/terrainGeometry.js';
import { advanceOrbitDays,orbitPose,DEFAULT_ORBIT_MOTION } from '../src/engine/orbitMotion.js';
import { LUNAR_ORBIT } from '../src/engine/orbit.js';
import * as THREE from 'three';

test('placement matches the rendered non-planar cell, including both triangles and diagonal',async()=> {
  const terrain={size:2,scale:10,elevationOrigin:100,data:Float64Array.from([0,0,0,20])};
  const tile=buildTerrainTile(terrain,{i0:0,i1:1,j0:0,j1:1,step:1});
  const mesh=new THREE.Mesh(tile,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));mesh.updateMatrixWorld();
  for(const [x,z] of [[.2,.3],[.8,.7],[.25,.75]]) {
    const px=(x-.5)*10,pz=(z-.5)*10;
    const hit=new THREE.Raycaster(new THREE.Vector3(px,100,pz),new THREE.Vector3(0,-1,0)).intersectObject(mesh)[0];
    const attached=await terrainAttachment(terrain,px,pz);
    assert.ok(Math.abs(attached.localHeight-hit.point.y)<1e-6);
    assert.ok(Math.abs(attached.localHeight-triangleHeight(0,0,0,20,x,z))<1e-10);
  }
  assert.equal(triangleHeight(0,0,0,20,.2,.3),0); // bilinear would invent 1.2 units above the mesh
  tile.dispose();mesh.material.dispose();
});

test('six wheel supports recover an inclined plane for different rover headings',()=> {
  const height=(x,z)=>12+.2*x-.3*z;
  for(const heading of [0,.8,Math.PI/2]) {
    const support=roverGroundSupport([4,0,-3],heading,height);
    assert.ok(Math.abs(support.centerHeight-height(4,-3))<1e-10);
    assert.ok(support.unsupportedHeight<1e-10);
    assert.equal(support.contacts.length,6);
    assert.ok(Math.abs(Math.tan(support.roll)-(.2*Math.cos(heading)+.3*Math.sin(heading)))<1e-10);
    assert.ok(Math.abs(Math.tan(support.pitch)-(.2*Math.sin(heading)-.3*Math.cos(heading)))<1e-10);
  }
});

test('wheel geometry exposes unsupported gaps and refuses unknown terrain',()=> {
  const support=roverGroundSupport([0,0,0],0,(x,z)=>x>0&&z>.5?2:0);
  assert.ok(support.unsupportedHeight>0);
  for(const p of support.contacts) assert.ok(support.centerHeight+Math.tan(support.roll)*p.x+Math.tan(support.pitch)*p.z>=p.height-1e-9);
  assert.throws(()=>roverGroundSupport([0,0,0],0,()=>NaN),/unavailable/);
});

test('model clock advances and lunar spin completes once per orbit; pause and acquisition lock hold it',()=> {
  const days=advanceOrbitDays(0,.05,DEFAULT_ORBIT_MOTION);
  assert.ok(Math.abs(days-.01)<1e-15);
  assert.equal(advanceOrbitDays(days,.05,{...DEFAULT_ORBIT_MOTION,playing:false}),days);
  assert.equal(advanceOrbitDays(days,.05,DEFAULT_ORBIT_MOTION,true),days);
  const start=orbitPose(0),end=orbitPose(LUNAR_ORBIT.periodDays);
  assert.ok(Math.abs(end.moonRotation-start.moonRotation+2*Math.PI)<1e-10);
  end.moonPosition.forEach((v,k)=>assert.ok(Math.abs(v-start.moonPosition[k])<1e-10));
  assert.notDeepEqual(orbitPose(3).moonPosition,start.moonPosition);
});
