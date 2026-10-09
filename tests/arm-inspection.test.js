import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {readFileSync} from 'node:fs';
import {createArmRig,updateArmRig,clampArmTarget} from '../src/engine/armRig.js';
import {engineeringRange} from '../src/engine/engineeringRange.js';
import {planGridRoute,DEFAULT_ROVER,findRehearsalPlacement,prepareRoverRoute} from '../src/engine/rover.js';
import {terrainAttachment,createScenarioObject} from '../src/engine/scenario.js';
import {rehearsalObjectPositions} from '../src/engine/rehearsal.js';

test('cursor arm remains bounded and returns to its unchanged rest pose',()=>{
  const root=new THREE.Group();let parent=root;
  for(const name of ['arm003','arm002','arm','arm004','turret_obj']){const node=new THREE.Group();node.name=name;node.position.y=.4;parent.add(node);parent=node;}
  const rig=createArmRig(root);assert.ok(rig);root.updateMatrixWorld(true);
  const target=new THREE.Vector3(.7,1.3,.4);
  const before=rig.tip.getWorldPosition(new THREE.Vector3()).distanceTo(target);
  for(let i=0;i<60;i++)updateArmRig(rig,target,1/30);
  assert.ok(rig.tip.getWorldPosition(new THREE.Vector3()).distanceTo(target)<before);
  rig.joints.forEach((node,i)=>assert.ok(node.quaternion.angleTo(rig.rest[i])<=.8+1e-6));
  for(let i=0;i<90;i++)updateArmRig(rig,null,1/30);
  rig.joints.forEach((node,i)=>assert.ok(node.quaternion.angleTo(rig.rest[i])<1e-5));
  // A target beyond the pose limit must clamp towards it, not erase its rotation.
  for(let i=0;i<90;i++)updateArmRig(rig,new THREE.Vector3(100,-100,100),1/30);
  assert.ok(rig.joints.some((node,i)=>node.quaternion.angleTo(rig.rest[i])>.1));
  rig.joints.forEach((node,i)=>assert.ok(node.quaternion.angleTo(rig.rest[i])<=.8+1e-6));
  assert.ok(clampArmTarget(new THREE.Vector3(100,0,0),new THREE.Vector3()).length()<=2.2+1e-9);
  assert.equal(createArmRig(new THREE.Group()),null);
});
test('large offline demo retains physical extent and synthetic provenance with usable route layers',()=>{
  const analysis=engineeringRange(10000,129);
  assert.equal(analysis.terrain.scale,10000);assert.equal(analysis.metadata.provenance.status,'SYNTHETIC');
  assert.equal(analysis.metadata.provenance.metric,true);
  for(const layer of Object.values(analysis.layers))assert.equal(layer.length,129**2);
  const route=planGridRoute(analysis.terrain,analysis.layers,[-1500,0,-1500],[-1000,0,-1500],DEFAULT_ROVER);
  assert.ok(route.path.length>1);assert.throws(()=>engineeringRange(100000));
});
test('the supplied Perseverance hierarchy has connected movable joints and finite bounded poses',()=>{
  const bytes=readFileSync(new URL('../public/models/perseverance.glb',import.meta.url));
  const doc=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
  const nodes=doc.nodes.map(data=>{const node=new THREE.Group();node.name=data.name;
    if(data.translation)node.position.fromArray(data.translation);if(data.rotation)node.quaternion.fromArray(data.rotation);if(data.scale)node.scale.fromArray(data.scale);return node;});
  doc.nodes.forEach((data,i)=>data.children?.forEach(child=>nodes[i].add(nodes[child])));
  const root=new THREE.Group();doc.scenes[doc.scene||0].nodes.forEach(i=>root.add(nodes[i]));root.updateMatrixWorld(true);
  const rig=createArmRig(root);assert.ok(rig);
  const before=rig.tip.getWorldPosition(new THREE.Vector3()),base=rig.joints[0].getWorldPosition(new THREE.Vector3());
  const target=clampArmTarget(before.clone().add(new THREE.Vector3(.3,.1,.2)),base);
  const links=rig.joints.slice(1).map((node,i)=>node.getWorldPosition(new THREE.Vector3()).distanceTo(rig.joints[i].getWorldPosition(new THREE.Vector3())));
  for(let n=0;n<90;n++)updateArmRig(rig,target,1/30);
  assert.ok(rig.tip.getWorldPosition(new THREE.Vector3()).distanceTo(before)>.01);
  rig.joints.forEach((node,i)=>{assert.ok(node.quaternion.toArray().every(Number.isFinite));assert.ok(node.quaternion.angleTo(rig.rest[i])<=.8+1e-6);});
  rig.joints.slice(1).forEach((node,i)=>assert.ok(Math.abs(node.getWorldPosition(new THREE.Vector3()).distanceTo(rig.joints[i].getWorldPosition(new THREE.Vector3()))-links[i])<1e-5));
});
test('both offline ranges prepare a complete rover rehearsal using the actual planning pipeline',async()=>{
  for(const width of [1000,10000]) {
    const analysis=engineeringRange(width),settings={...DEFAULT_ROVER,profileId:'perseverance',speed:.02};
    const placement=await findRehearsalPlacement(analysis,settings,[],{});
    const specs=rehearsalObjectPositions(analysis.terrain,placement);
    const objects=await Promise.all(specs.map(async([type,x,z],i)=>createScenarioObject(type,await terrainAttachment(analysis.terrain,x,z),analysis.jobId,0,String(i))));
    assert.deepEqual(objects.map(o=>o.type),['VEHICLE','OBJECTIVE','FACILITY','RELAY']);
    const route=await prepareRoverRoute(analysis,objects[0],objects[1],settings,objects,{});
    assert.ok(route.distance>0);assert.ok(route.maxSlope<=settings.maxSlope);assert.equal(route.fidelity,'SYNTHETIC');
  }
});
