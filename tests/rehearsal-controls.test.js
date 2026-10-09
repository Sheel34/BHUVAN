import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { advanceTravel, scenarioLabel, localToLunarLocation, lunarMissionOrigin, updateRehearsal, observationsCSV } from '../src/engine/rehearsal.js';
import { WHEEL_RIGS, partitionWheelGeometry } from '../src/engine/wheelGeometry.js';
import { embedCaptureMetadata, crc32 } from '../src/engine/captureMetadata.js';

test('capture retains PNG pixels and embeds valid UTF-8 metadata with a CRC',()=> {
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1cAAAAASUVORK5CYII=','base64');
  const metadata={dataset:'LROC',caption:'Lunar view · 28° N'},result=Buffer.from(embedCaptureMetadata(png,metadata));
  const at=png.length-12,n=result.readUInt32BE(at);
  assert.deepEqual(result.subarray(0,at),png.subarray(0,at));assert.equal(result.toString('ascii',at+4,at+8),'iTXt');
  assert.equal(result.readUInt32BE(at+8+n),crc32(result.subarray(at+4,at+8+n)));
  const body=result.subarray(at+8,at+8+n),start=body.indexOf(0)+5;
  assert.deepEqual(JSON.parse(body.subarray(start).toString('utf8')),metadata);
  assert.deepEqual(result.subarray(-12),png.subarray(-12));
  assert.throws(()=>embedCaptureMetadata(new Uint8Array(30),{}),/valid PNG/);
});

test('speed changes preserve distance; pause and rewind do not teleport',()=> {
  let state=advanceTravel({elapsed:0,distance:0},10,1,100);
  assert.equal(state.distance,10);
  state=advanceTravel(state,10,5,100);assert.equal(state.distance,10);
  state=advanceTravel(state,12,5,100);assert.equal(state.distance,20);
  state=advanceTravel(state,0,5,100);assert.equal(state.distance,0);
  assert.equal(advanceTravel(state,100,5,100).distance,100);
});

test('object numbering is independent of interleaved facilities and vehicles',()=> {
  const objects=[{id:'a',type:'OBJECTIVE'},{id:'b',type:'FACILITY'},{id:'c',type:'OBJECTIVE'}];
  assert.equal(scenarioLabel(objects,objects[2]),'OBJECTIVE 2');
});

test('lunar registration requires a metric AEQD frame and respects south/east raster axes',()=> {
  const fixture={metadata:{provenance:{metric:true,body:'moon',reference:'PROJECTION["Azimuthal_Equidistant"],PARAMETER["latitude_of_center",0],PARAMETER["longitude_of_center",0]'}}};
  const origin=lunarMissionOrigin(fixture);assert.deepEqual(origin,{latitude:0,longitude:0});
  assert.equal(lunarMissionOrigin({metadata:{provenance:{...fixture.metadata.provenance,reference:'unregistered photograph'}}}),null);
  assert.ok(localToLunarLocation(origin,[1000,0,0]).lat<0);
  assert.ok(localToLunarLocation(origin,[0,0,1000]).lon>0);
  assert.deepEqual(localToLunarLocation(origin,[0,0,0]),{lat:0,lon:0});
  const polar=localToLunarLocation({latitude:-89.7,longitude:170},[1000,0,1000]);
  assert.ok(Number.isFinite(polar.lat)&&Number.isFinite(polar.lon));
});

test('map observations accumulate only with travel and clear on reset',()=> {
  const terrain={size:11,scale:10,data:new Float64Array(121),elevationOrigin:100};
  const route={distance:10,path:[[0,0,0],[0,0,10]],cumulative:[0,10],speed:1};
  const runtime={},travel={elapsed:0,distance:0};
  updateRehearsal(route,runtime,travel,0,1,terrain,[]);
  updateRehearsal(route,runtime,travel,2,1,terrain,[]);
  updateRehearsal(route,runtime,travel,2,5,terrain,[]);
  assert.equal(runtime.observations.length,2);assert.equal(runtime.observations[1].elevation,100);assert.equal(runtime.distance,2);
  assert.match(observationsCSV(runtime.observations),/2.000000,2.000000/);
  updateRehearsal(route,runtime,travel,0,5,terrain,[]);assert.equal(runtime.observations.length,1);assert.equal(runtime.distance,0);
});

function glbGeometry(name,primitive) {
  const data=readFileSync(new URL(`../public/models/${name}.glb`,import.meta.url));
  const jsonLength=data.readUInt32LE(12),doc=JSON.parse(data.subarray(20,20+jsonLength).toString());
  const binary=data.subarray(28+jsonLength);
  const mesh=doc.meshes[name==='curiosity'?0:8],p=mesh.primitives[primitive];
  const read=index=> {
    const a=doc.accessors[index],v=doc.bufferViews[a.bufferView],dims={SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a.type];
    const types={5126:Float32Array,5125:Uint32Array,5123:Uint16Array,5121:Uint8Array},Type=types[a.componentType];
    const byteOffset=(v.byteOffset||0)+(a.byteOffset||0),stride=v.byteStride||dims*Type.BYTES_PER_ELEMENT,values=new Type(a.count*dims);
    for(let i=0;i<a.count;i++)for(let j=0;j<dims;j++) {
      const at=byteOffset+i*stride+j*Type.BYTES_PER_ELEMENT;
      values[i*dims+j]=a.componentType===5126?binary.readFloatLE(at):a.componentType===5125?binary.readUInt32LE(at):a.componentType===5123?binary.readUInt16LE(at):binary.readUInt8(at);
    }
    return new THREE.BufferAttribute(values,dims,a.normalized);
  };
  const g=new THREE.BufferGeometry();g.setAttribute('position',read(p.attributes.POSITION));
  g.setAttribute('normal',read(p.attributes.NORMAL));g.setAttribute('uv',read(p.attributes.TEXCOORD_0));
  if(p.indices!==undefined)g.setIndex(read(p.indices));return g;
}

test('supplied wheel primitives split into six complete wheels without cutting faces or losing UVs',()=> {
  for(const name of ['curiosity','perseverance'])for(let primitive=0;primitive<(name==='curiosity'?1:3);primitive++) {
    const original=glbGeometry(name,primitive),parts=partitionWheelGeometry(original,WHEEL_RIGS[name]);
    assert.equal(parts.length,6);
    assert.equal(parts.reduce((n,p)=>n+p.index.count,0),original.index?.count||original.attributes.position.count);
    for(const p of parts){assert.equal(p.attributes.uv.count,p.attributes.position.count);assert.ok(p.boundingBox.max.z-p.boundingBox.min.z<.6);p.dispose();}
    original.dispose();
  }
});
