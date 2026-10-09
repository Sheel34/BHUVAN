import test from 'node:test';
import assert from 'node:assert/strict';
import {applyImageScale,hasRehearsalScale,imageTerrainLayers,depthRehearsalAnalysis} from '../src/engine/imageRehearsal.js';
import {prepareRoverRoutes,prepareRoverRoute,roverPose,routeOverlap,DEFAULT_ROVER,traverseCSV} from '../src/engine/rover.js';
import {memoryTriangleHeight,roverGroundSupport} from '../src/engine/surfacePlacement.js';

function imageFixture(size=65) {
  const data=Float64Array.from({length:size**2},(_,k)=> {
    const x=Math.floor(k/size)-(size-1)/2,z=k%size-(size-1)/2;
    return .1+x*.001-.08*Math.exp(-(x*x+z*z)/12);
  });
  return {jobId:'photo',terrain:{size,scale:2,minH:0,maxH:1,data},metadata:{colorUrl:'/original-image.png',
    provenance:{status:'ESTIMATED',metric:false,source:'image',limitations:['Single view']}}};
}

test('assumed dimensions enable rehearsal without upgrading an image to measured evidence',async()=> {
  const source=imageFixture(),bytes=Float64Array.from(source.terrain.data);
  const scaled=applyImageScale(source,{width:320,relief:8,invert:false});
  assert.equal(scaled.terrain.scale,320);assert.equal(scaled.terrain.maxH,8);
  assert.equal(scaled.metadata.provenance.metric,false);assert.equal(scaled.metadata.provenance.status,'ESTIMATED');
  assert.equal(scaled.metadata.colorUrl,source.metadata.colorUrl);assert.equal(hasRehearsalScale(source),false);
  assert.equal(hasRehearsalScale(scaled),true);assert.deepEqual(source.terrain.data,bytes);
  const start={id:'r',position:[-100,0,60]},goal={id:'o',position:[100,0,60]};
  const route=await prepareRoverRoute(scaled,start,goal,DEFAULT_ROVER);
  assert.equal(route.metric,false);assert.match(route.fidelity,/ASSUMED SCALE/);
  assert.deepEqual(roverPose(route,1000).position,route.path.at(-1));
  assert.match(traverseCSV(route),/assumed_surface_height_m/);
  const resized=applyImageScale(scaled,{width:640,relief:8,invert:false});
  assert.deepEqual(resized.terrain.data,scaled.terrain.data);assert.equal(resized.metadata.provenance.analysis_gsd,10);
  assert.notEqual(resized.jobId,scaled.jobId);
  assert.throws(()=>applyImageScale({...source,metadata:{provenance:{metric:true}}}),/only to estimated/);
  assert.throws(()=>applyImageScale(source,{width:0,relief:8}),/20–30,000/);
});

test('a resolved depression is automatically excluded, while a smooth incline stays usable',async()=> {
  const size=65,data=new Float64Array(size**2);
  for(let i=0;i<size;i++)for(let j=0;j<size;j++)data[i*size+j]=i*.02;
  for(let i=30;i<=34;i++)for(let j=30;j<=34;j++)data[i*size+j]-=2;
  const layers=imageTerrainLayers(data,size,64);
  assert.equal(layers.hazard[32*size+32],1);assert.ok(layers.hazard[20*size+20]<.1);
  const input={terrain:{size,scale:64,minH:-2,maxH:2,data,metric:true},layers,
    metadata:{provenance:{metric:false,status:'ESTIMATED'},rehearsalScale:{kind:'assumed'}}};
  const options=await prepareRoverRoutes(input,{id:'r',position:[-20,0,0]},{id:'o',position:[20,0,0]},DEFAULT_ROVER);
  assert.equal(options.length,3);assert.ok(options.every(o=>o.route),options.map(o=>o.reason).join(';'));
  for(const {route} of options) {
    assert.ok(route.path.some(p=>Math.abs(p[2])>=4));
    assert.ok(route.maxHazard<=DEFAULT_ROVER.maxHazard);assert.ok(route.maxSlope<=DEFAULT_ROVER.maxSlope);
  }
  assert.ok(routeOverlap(options[0].route,options[1].route)<=.8);
  assert.ok(routeOverlap(options[1].route,options[2].route)<=.8);
});

test('route alternatives report a single constrained corridor instead of duplicate choices',async()=> {
  const size=33,hazard=new Float32Array(size**2).fill(1);
  for(let i=0;i<size;i++)for(let j=14;j<=18;j++)hazard[i*size+j]=0;
  const input={terrain:{size,scale:32,data:new Float64Array(size**2)},layers:{hazard},metadata:{provenance:{metric:true}}};
  const choices=await prepareRoverRoutes(input,{id:'r',position:[-10,0,0]},{id:'o',position:[10,0,0]},DEFAULT_ROVER);
  assert.ok(choices.find(c=>c.route));
  assert.equal(choices.filter(c=>c.route).length,1);
  for(const choice of choices)assert.ok(choice.route||choice.reason);
  const abort=new AbortController();abort.abort();
  await assert.rejects(()=>prepareRoverRoutes(input,{position:[-10,0,0]},{position:[10,0,0]},DEFAULT_ROVER,[],{},abort.signal),{name:'AbortError'});
});

test('local neural depth keeps original colours and handles a featureless image honestly',()=> {
  const depth={grid:Array.from({length:9},()=>new Array(9).fill(.5)),model:'depth-fixture'};
  const analysis=depthRehearsalAnalysis(depth,{name:'flat',colorUrl:'blob:fixture',jobId:'flat'});
  assert.equal(analysis.terrain.maxH,0);assert.equal(analysis.metadata.colorUrl,'blob:fixture');
  assert.equal(analysis.metadata.provenance.metric,false);
});

test('newly placed image rovers use native triangle support before planning',()=> {
  const terrain={size:9,scale:8,data:Float64Array.from({length:81},(_,k)=>Math.floor(k/9)*.1+k%9*.2)};
  const height=(x,z)=>memoryTriangleHeight(terrain,x,z);
  assert.ok(Math.abs(height(.3,.7)-(1.2+.3*.1+.7*.2))<1e-12);
  const support=roverGroundSupport([.3,height(.3,.7),.7],0,height);
  assert.ok(Math.abs(support.pitch-Math.atan(.2))<1e-12);
  assert.ok(Math.abs(support.roll-Math.atan(.1))<1e-12);
  assert.ok(support.unsupportedHeight<1e-12);assert.ok(Number.isNaN(height(5,0)));
});
