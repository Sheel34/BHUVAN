import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

export default function RoverRehearsal({route,runtime,clock,terrain,objects,verticalExaggeration}) {
  const geometry=useMemo(()=> {
    if(!route)return null;
    return new THREE.BufferGeometry().setFromPoints(route.path.map(p=>new THREE.Vector3(p[0],p[1]*verticalExaggeration+Math.max(.15,terrain.scale*.0001),p[2])));
  },[route,terrain,verticalExaggeration]);
  useEffect(()=>()=>geometry?.dispose(),[geometry]);
  return geometry ? <line geometry={geometry} name="Planned rover route" raycast={()=>null}>
    <lineBasicMaterial color="#9de9ed" transparent opacity={.9} />
  </line> : null;
}
