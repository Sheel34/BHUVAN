import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import AssetModel from './AssetModel';

// Inspection composition, deliberately separate from the dynamical orbit.
// A realistically scaled Gateway is subpixel at this globe's distance.
export default function GatewayView({moonRef,controlsRef}) {
  const group=useRef(),previous=useRef(null),{camera}=useThree();
  const offset=useMemo(()=>new THREE.Vector3(.42,.05,1.1),[]);
  const delta=useMemo(()=>new THREE.Vector3(),[]);
  useEffect(()=>{camera.clearViewOffset();return()=>{};},[camera]);
  useFrame(()=> {
    if(!group.current||!moonRef.current||!controlsRef.current)return;
    group.current.position.copy(moonRef.current.position).add(offset);
    const controls=controlsRef.current;
    if(!previous.current){
      camera.position.copy(moonRef.current.position).add(new THREE.Vector3(1.05,.4,2.1));
      controls.target.copy(group.current.position);controls.minDistance=.45;controls.maxDistance=5;
      previous.current=group.current.position.clone();
    }else{
      delta.copy(group.current.position).sub(previous.current);
      camera.position.add(delta);controls.target.add(delta);previous.current.copy(group.current.position);
    }
    controls.update();
  });
  return <group ref={group} rotation={[.2,-.4,-.4]} name="Gateway — expanded-scale model inspection">
    <AssetModel url="/models/gateway.glb" width={.58} center/>
  </group>;
}
