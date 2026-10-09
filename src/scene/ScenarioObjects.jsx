import AssetModel from './AssetModel';
import { vehicleProfile } from '../engine/vehicleProfiles';
import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { sampleHeight } from '../engine/terrain';
import { useMemo, useEffect } from 'react';
import * as THREE from 'three';
import { scenarioLabel } from '../engine/rehearsal';
import { useThree } from '@react-three/fiber';

function RoverModel({runtime}) {
  const wheels=useRef([]);
  useFrame(()=> {if(runtime)for(const wheel of wheels.current)if(wheel)wheel.rotation.x=(runtime.current.distance||0)/.34;});
  return <group>
    <mesh position={[0,.7,0]} castShadow><boxGeometry args={[1.7,.55,2.3]} /><meshStandardMaterial color="#d6d5ce" metalness={.5} roughness={.38}/></mesh>
    <mesh position={[0,1.45,.5]} castShadow><cylinderGeometry args={[.045,.045,1.2,8]}/><meshStandardMaterial color="#e9ecec"/></mesh>
    <mesh position={[0,2.1,.5]}><boxGeometry args={[.45,.2,.2]}/><meshStandardMaterial color="#192936" metalness={.7}/></mesh>
    {[-1,1].flatMap(side=>[-.85,0,.85].map((z,k)=><group ref={g=>{wheels.current[(side===-1?0:3)+k]=g;}} key={`${side}:${z}`} position={[side,.35,z]}><mesh rotation={[0,0,Math.PI/2]} castShadow>
      <cylinderGeometry args={[.34,.34,.23,16]}/><meshStandardMaterial color="#282e35" roughness={.9}/></mesh><mesh position={[.13,0,0]}><boxGeometry args={[.035,.045,.6]}/><meshStandardMaterial color="#748291"/></mesh></group>))}
    <mesh position={[0,1.02,-.2]} rotation={[-Math.PI/2,0,0]}><planeGeometry args={[1.65,1.8]}/><meshStandardMaterial color="#233b59" metalness={.65} roughness={.22}/></mesh>
  </group>;
}

function Waypoint({object,route,runtime,verticalExaggeration}) {
  const marker=useRef();
  useFrame(()=> {if(marker.current)marker.current.visible=!(route?.objectiveId===object.id&&Math.hypot(runtime.current.position[0]-object.position[0],runtime.current.position[2]-object.position[2])<2);});
  return <mesh ref={marker} position={[0,.08,0]} rotation={[-Math.PI/2,0,0]}><ringGeometry args={[.13,.17,4]}/><meshBasicMaterial color="#bae6e5" side={THREE.DoubleSide} transparent opacity={.7} depthWrite={false}/></mesh>;
}
function FacilityModel() {
  return <group name="Concept surface habitat">
    <mesh position={[0,1.6,0]} rotation={[0,0,Math.PI/2]} castShadow receiveShadow><cylinderGeometry args={[1.25,1.25,6,20]}/><meshStandardMaterial color="#c9c8bc" roughness={.7} metalness={.2}/></mesh>
    {[-2,2].flatMap(x=>[-.85,.85].map(z=><mesh key={`${x}:${z}`} position={[x,.55,z]} castShadow><boxGeometry args={[.22,1.1,.22]}/><meshStandardMaterial color="#626d76" metalness={.5} roughness={.6}/></mesh>))}
    <mesh position={[0,2.9,0]} castShadow><boxGeometry args={[4,.06,1.8]}/><meshStandardMaterial color="#1e3249" roughness={.35} metalness={.5}/></mesh>
    <mesh position={[3.03,1.5,0]} rotation={[0,Math.PI/2,0]}><circleGeometry args={[.55,20]}/><meshStandardMaterial color="#394854" roughness={.4}/></mesh>
  </group>;
}
function ExclusionBoundary({terrain,object,route,verticalExaggeration}) {
  const geometry=useMemo(()=> {
    const radius=object.constraints?.radius??(object.type==='HAZARD REGION'?Math.max(terrain.scale/(Math.min(129,terrain.size)-1)*1.5,route?.planningGsd*1.5||0):6);
    const points=Array.from({length:49},(_,k)=> {
      const x=Math.sin(k/48*Math.PI*2)*radius,z=Math.cos(k/48*Math.PI*2)*radius;
      const h=object.orientation[1],gx=x*Math.cos(h)+z*Math.sin(h),gz=z*Math.cos(h)-x*Math.sin(h);
      const height=sampleHeight(terrain,object.position[0]+gx,object.position[2]+gz);
      return new THREE.Vector3(x,(Number.isFinite(height)?height-object.position[1]:0)*verticalExaggeration+.12,z);
    });return new THREE.BufferGeometry().setFromPoints(points);
  },[terrain,object,route,verticalExaggeration]);
  useEffect(()=>()=>geometry.dispose(),[geometry]);
  return <line geometry={geometry} raycast={()=>null}><lineBasicMaterial color="#e9bb7c" transparent opacity={.8}/></line>;
}

export default function ScenarioObjects({ terrain, objects, selectedId, verticalExaggeration, onSelect, onMove, onDragging, roverRoute, roverRuntime, roverView, roverProfileId,armMode=false }) {
  const { scene, raycaster, controls } = useThree();
  const drag = useRef(null);
  const rover=useRef(null);
  useFrame(()=> {
    if(!rover.current || !roverRoute)return;
    const p=roverRuntime.current;
    rover.current.position.set(p.position[0],(p.support?.centerHeight??p.position[1])*verticalExaggeration,p.position[2]);
    rover.current.rotation.set(-Math.atan(Math.tan(p.pitch)*verticalExaggeration),p.heading,Math.atan(Math.tan(p.roll||0)*verticalExaggeration),'YXZ');
  });
  const surfaces = () => {
    const list = [];
    scene.getObjectByName('DEM')?.traverse(o => {
      if (!o.geometry?.userData.tileId) return;
      let parent = o; while (parent) { if (!parent.visible) return; parent = parent.parent; }
      list.push(o);
    });
    return list;
  };
  const finish = (e, cancelled = false) => {
    e.stopPropagation();
    const current = drag.current; drag.current = null;
    e.target.releasePointerCapture?.(e.pointerId); onDragging(false);
    // Drag feedback is a transient display preview; the committed state below
    // is always reattached to native analysis heights, never this display LOD.
    if (current?.group) current.group.position.copy(current.original);
    if (!cancelled && current?.hit && current.moved) onMove(current.id, current.hit.x, current.hit.z);
  };
  const size = 1;
  const profile=vehicleProfile(roverProfileId);
  if(terrain.metric===false)return null;
  return <group name="User-created scenario objects">
    {objects.map(object => <group key={object.id} visible={!(roverView==='rover'&&object.id===roverRoute?.vehicleId)} ref={object.id===roverRoute?.vehicleId ? rover : undefined} position={[object.position[0], object.position[1] * verticalExaggeration, object.position[2]]}
      rotation={[0, object.orientation[1], 0]} scale={size}
      onPointerDown={e => {
        if (e.nativeEvent.button !== 0 || object.id===roverRoute?.vehicleId) return;
        e.stopPropagation(); onSelect(object.id); onDragging(true);
        if (controls) controls.enabled = false;
        drag.current = { id: object.id, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY,
          group: e.eventObject, original: e.eventObject.position.clone() };
        e.target.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={e => {
        if (!drag.current) return; e.stopPropagation();
        const d = drag.current;
        d.moved = Math.hypot(e.nativeEvent.clientX - d.x, e.nativeEvent.clientY - d.y) > 7;
        const hit = raycaster.intersectObjects(surfaces(), false)[0];
        if (hit) { d.hit = hit.point.clone(); if (d.moved) d.group.position.copy(hit.point); }
      }}
      onPointerUp={finish} onPointerCancel={e => finish(e, true)}>
      {object.type==='VEHICLE' ? (profile.asset ? <AssetModel url={profile.asset} width={profile.width} wheelRig={profile.id} armMode={armMode&&object.id===roverRoute?.vehicleId} travelRuntime={object.id===roverRoute?.vehicleId?roverRuntime:null}/> : <RoverModel runtime={object.id===roverRoute?.vehicleId?roverRuntime:null}/>) : ['OBJECTIVE','SCIENCE SITE'].includes(object.type)?<Waypoint object={object} route={roverRoute} runtime={roverRuntime} verticalExaggeration={verticalExaggeration}/> : ['FACILITY','STATION'].includes(object.type)?<FacilityModel/> : <mesh position={[0, object.type==='RELAY'?3:1, 0]} castShadow>
        {object.type === 'FACILITY' || object.type==='STATION' ? <boxGeometry args={[8, 2, 5]} /> : object.type==='RELAY' ? <cylinderGeometry args={[.1,.2,6,8]}/> : <cylinderGeometry args={[.3,.4,2,12]} />}
        <meshStandardMaterial color={selectedId === object.id ? '#c9f8ff' : '#79b3cf'} metalness={.35} roughness={.3} />
      </mesh>}
      {['FACILITY','STATION','HAZARD REGION'].includes(object.type)&&<ExclusionBoundary terrain={terrain} object={object} route={roverRoute} verticalExaggeration={verticalExaggeration}/>}
      <Html position={['OBJECTIVE','SCIENCE SITE'].includes(object.type)?[2.8,1.2,0]:[0,3.2,0]} center style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }} zIndexRange={[8, 0]}>
        <span className="scenario-label">{object.type==='VEHICLE'?profile.name:scenarioLabel(objects,object)}</span>
      </Html>
    </group>)}
  </group>;
}
