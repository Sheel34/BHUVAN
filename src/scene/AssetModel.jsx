import React, { Suspense, useMemo, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { createArmRig, updateArmRig, clampArmTarget } from '../engine/armRig';
import { useGLTF, Html } from '@react-three/drei';
import * as THREE from 'three';
import { WHEEL_RIGS, partitionWheelGeometry } from '../engine/wheelGeometry';

class AssetBoundary extends React.Component {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed ? <Html center><span className="asset-status" role="alert">Model unavailable. Reload to retry.</span></Html> : this.props.children;}
}
function LoadedModel({url,width,center=false,wheelRig,travelRuntime,armMode=false}) {
  const {camera,pointer}=useThree();
  const cursor=useMemo(()=>({ray:new THREE.Raycaster(),plane:new THREE.Plane(),normal:new THREE.Vector3(),base:new THREE.Vector3(),target:new THREE.Vector3()}),[]);
  const {scene}=useGLTF(url);
  const model=useMemo(()=> {
    // Clone transforms only: geometries/materials stay owned by useGLTF's cache.
    const clone=scene.clone(true),box=new THREE.Box3().setFromObject(clone),size=box.getSize(new THREE.Vector3()),mid=box.getCenter(new THREE.Vector3());
    const scale=width/(center?Math.max(size.x,size.y,size.z):size.x);
    clone.position.sub(new THREE.Vector3(mid.x,center?mid.y:box.min.y,mid.z));
    clone.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});
    const rig=WHEEL_RIGS[wheelRig],wheels=[],owned=[];
    if(rig) {
      const candidates=[];
      clone.traverse(o=> {
        if(!o.isMesh)return;
        if(wheelRig==='curiosity'&&o.geometry.attributes.position.count===rig.vertexCount)candidates.push(o);
        if(wheelRig==='perseverance') {let a=o;while(a){if(a.name==='Wheels_objs'){candidates.push(o);break;}a=a.parent;}}
      });
      try {
        const partitions=candidates.map(mesh=>({mesh,parts:partitionWheelGeometry(mesh.geometry,rig)}));
        for(const {mesh,parts} of partitions) {
          mesh.visible=false;
          parts.forEach((geometry,k)=> {
            const pivot=new THREE.Group();pivot.position.fromArray(rig.centers[k]);
            const part=new THREE.Mesh(geometry,mesh.material);part.castShadow=true;part.receiveShadow=true;pivot.add(part);mesh.parent.add(pivot);
            wheels.push({pivot,radius:Math.max(.1,rig.radius*scale)});owned.push(geometry);
          });
        }
      } catch(error) {console.warn('[rover] Keeping intact wheel geometry:',error.message);}
    }
    return {clone,scale,wheels,owned,arm:wheelRig==='perseverance'?createArmRig(clone):null};
  },[scene,width,center,wheelRig]);
  useEffect(()=>()=>model.owned.forEach(g=>g.dispose()),[model]);
  useFrame((state,dt)=> {
    if(travelRuntime)for(const wheel of model.wheels)wheel.pivot.rotation.x=(travelRuntime.current.distance||0)/wheel.radius;
    if(!model.arm)return;
    let target=null;
    if(armMode) {
      model.arm.joints[0].getWorldPosition(cursor.base);camera.getWorldDirection(cursor.normal);
      cursor.plane.setFromNormalAndCoplanarPoint(cursor.normal,cursor.base);
      cursor.ray.setFromCamera(pointer,camera);
      if(cursor.ray.ray.intersectPlane(cursor.plane,cursor.target))target=clampArmTarget(cursor.target,cursor.base);
    }
    updateArmRig(model.arm,target,dt);
  });
  return <group scale={model.scale} dispose={null}><primitive object={model.clone}/></group>;
}
export default function AssetModel(props) {
  return <AssetBoundary key={props.url}><Suspense fallback={<Html center><span className="asset-status" role="status">Loading supplied model…</span></Html>}><LoadedModel {...props}/></Suspense></AssetBoundary>;
}
