import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { sampleHeight } from '../engine/terrain';

function Water({terrain,level}) {
  const material=useMemo(()=> {
    const m=new THREE.MeshPhysicalMaterial({color:'#356b83',roughness:.18,metalness:.15,transparent:true,opacity:.67,clearcoat:1,side:THREE.DoubleSide});
    const time={value:0};m.userData.time=time;
    m.onBeforeCompile=shader=> {
      shader.uniforms.waterTime=time;
      shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 waterPosition;')
        .replace('#include <worldpos_vertex>','#include <worldpos_vertex>\nwaterPosition=(modelMatrix*vec4(transformed,1.0)).xyz;');
      shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec3 waterPosition;uniform float waterTime;')
        .replace('#include <normal_fragment_maps>','#include <normal_fragment_maps>\nfloat waterPhaseX=waterPosition.x*.08+waterTime*.6;float waterPhaseZ=waterPosition.z*.07+waterTime*.45;float waterWaveX=1.-smoothstep(.05,.3,fwidth(waterPhaseX));float waterWaveZ=1.-smoothstep(.05,.3,fwidth(waterPhaseZ));normal=normalize(normal+vec3(sin(waterPhaseX)*.08*waterWaveX,0.,cos(waterPhaseZ)*.07*waterWaveZ));');
    };return m;
  },[]);
  useEffect(()=>()=>material.dispose(),[material]);
  useFrame(({clock})=> {material.userData.time.value=clock.elapsedTime;});
  return <mesh name="Scenario water level" position={[0,level-(terrain.elevationOrigin||0),0]} rotation={[-Math.PI/2,0,0]} material={material} raycast={()=>null}>
    <planeGeometry args={[terrain.scale,terrain.scale]}/>
  </mesh>;
}

function TestRocks({terrain,density}) {
  const instances=useMemo(()=> {
    const geometry=new THREE.DodecahedronGeometry(1,0),material=new THREE.MeshStandardMaterial({color:terrain.body==='mars'?'#7c5c49':'#777a7d',roughness:.97});
    const mesh=new THREE.InstancedMesh(geometry,material,density),dummy=new THREE.Object3D();
    let seed=1247;const random=()=> {seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    for(let k=0;k<density;k++) {const x=(random()-.5)*terrain.scale,z=(random()-.5)*terrain.scale,r=.2+random()*.65;
      dummy.position.set(x,sampleHeight(terrain,x,z)+r*.3,z);dummy.rotation.set(random(),random()*6,random());dummy.scale.set(r,r*.7,r*1.2);dummy.updateMatrix();mesh.setMatrixAt(k,dummy.matrix);}
    mesh.castShadow=true;mesh.receiveShadow=true;mesh.name='Procedural visual stress-test rocks';return mesh;
  },[terrain,density]);
  useEffect(()=>()=> {instances.geometry.dispose();instances.material.dispose();},[instances]);
  return <primitive object={instances} dispose={null}/>;
}

function Feature({feature,terrain}) {
  const h=feature.groundHeight,size=feature.size||2;
  if(!Number.isFinite(h))return null;
  const color=feature.color||({'buildings':'#bbc4c8','vegetation':'#556c4a','snow/ice':'#dceaf1','rocks':'#7c7771','land-cover':'#65855d','water':'#31586e'}[feature.kind]||'#bccbd2');
  return <mesh position={[feature.x,h+(feature.kind==='buildings'?(feature.height||size)/2:['vegetation','rocks'].includes(feature.kind)?size/2:.1),feature.z]} castShadow receiveShadow name={`${feature.kind} · supplied feature`}>
    {feature.kind==='buildings' ? <boxGeometry args={[size,feature.height||size,size]}/> : feature.kind==='vegetation' ? <coneGeometry args={[size*.4,size,8]}/> : feature.kind==='rocks' ? <dodecahedronGeometry args={[size/2,0]}/> : <boxGeometry args={[size,.15,size]}/>}
    <meshStandardMaterial color={color} roughness={feature.kind==='water'?.2:.9}/>
  </mesh>;
}

export default function EnvironmentalFeatures({terrain,environment}) {
  return <group name="Scenario environment">
    {environment.water && terrain.body==='earth' && <Water terrain={terrain} level={environment.waterLevel}/>}
    {environment.rocks && !terrain.stream && <TestRocks terrain={terrain} density={environment.rockDensity}/>}
    {(environment.features||[]).map((feature,i)=><Feature key={i} terrain={terrain} feature={feature}/>)}
  </group>;
}
