import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

export default function RoverRehearsal({route,alternatives,terrain,verticalExaggeration}) {
  const lines=useMemo(()=> {
    if(!route)return [];
    const routes=alternatives?.length?alternatives.filter(c=>c.route).map(c=>c.route):[route];
    return routes.map((candidate,i)=>({route:candidate,color:['#d9edf0','#b3b4a7','#a8b5ca'][i%3],
      geometry:new THREE.BufferGeometry().setFromPoints(candidate.path.map(p=>new THREE.Vector3(p[0],p[1]*verticalExaggeration+Math.max(.15,terrain.scale*.0001),p[2])))}));
  },[route,alternatives,terrain,verticalExaggeration]);
  useEffect(()=>()=>lines.forEach(line=>line.geometry.dispose()),[lines]);
  return <group name="Compared rover corridors">{lines.map((line,i)=><line key={i} geometry={line.geometry} name="Planned rover route" raycast={()=>null}>
    <lineBasicMaterial color={line.color} transparent opacity={line.route===route ? .85 : .3} depthWrite={false}/>
  </line>)}</group>;
}
