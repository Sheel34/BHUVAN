import * as THREE from 'three';

// These are visual pose limits, not NASA actuator or collision limits.
export function createArmRig(model) {
  const nodes = new Map();
  model.traverse(node => nodes.set(node.name.replaceAll('.', ''), node));
  const joints = ['arm003','arm002','arm','arm004'].map(name => nodes.get(name));
  const tip = nodes.get('turret_obj');
  if (joints.some(node => !node) || !tip) return null;
  return { joints, tip, rest:joints.map(node => node.quaternion.clone()),
    position:new THREE.Vector3(), end:new THREE.Vector3(), a:new THREE.Vector3(), b:new THREE.Vector3(),
    world:new THREE.Quaternion(), parent:new THREE.Quaternion(), delta:new THREE.Quaternion(),
    desired:new THREE.Quaternion(), target:new THREE.Vector3(), filtered:new THREE.Vector3(), initialized:false };
}

export function updateArmRig(rig, target, dt) {
  if (!rig) return;
  const alpha = 1 - Math.exp(-Math.min(.1, Math.max(0, dt)) * 9);
  if (!target) {
    rig.joints.forEach((node,i) => node.quaternion.slerp(rig.rest[i],alpha));
    rig.initialized=false;
    return;
  }
  if (!rig.initialized) {rig.tip.getWorldPosition(rig.filtered);rig.initialized=true;}
  rig.filtered.lerp(target,alpha);
  for (let pass=0;pass<3;pass++) for (let i=rig.joints.length-1;i>=0;i--) {
    const node=rig.joints[i];
    node.updateWorldMatrix(true,true);
    node.getWorldPosition(rig.position);rig.tip.getWorldPosition(rig.end);
    rig.a.copy(rig.end).sub(rig.position);rig.b.copy(rig.filtered).sub(rig.position);
    if (rig.a.lengthSq()<1e-9 || rig.b.lengthSq()<1e-9) continue;
    rig.delta.setFromUnitVectors(rig.a.normalize(),rig.b.normalize());
    node.getWorldQuaternion(rig.world);node.parent.getWorldQuaternion(rig.parent);
    rig.desired.copy(rig.parent).invert().multiply(rig.delta).multiply(rig.world).normalize();
    const angle=rig.rest[i].angleTo(rig.desired),limit=.8;
    if(angle>limit)rig.desired.slerp(rig.rest[i],1-limit/angle);
    node.quaternion.slerp(rig.desired,.35);
  }
}

export function clampArmTarget(target, base, reach=2.2) {
  target.sub(base);if(target.length()>reach)target.setLength(reach);
  target.add(base);target.y=Math.max(base.y-.6,target.y);
  return target;
}
