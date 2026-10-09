import test from 'node:test';
import assert from 'node:assert/strict';
import {missionEvidence} from '../src/engine/missionEvidence.js';
import {vehicleWheels} from '../src/engine/vehicleProfiles.js';
import {roverGroundSupport} from '../src/engine/surfacePlacement.js';
import {waterShadow} from '../src/engine/waterFeedback.js';
test('a measured 2 m DEM does not clear half-metre obstacles; finer rendering cannot change that',()=>{
  const a={metadata:{provenance:{metric:true,analysis_gsd:2,source_gsd:2}}};
  const e=missionEvidence(a,{profileId:'curiosity',obstacleWidth:.5,maxSlope:25});
  assert.equal(e.decision,'SMALL HAZARDS UNRESOLVED');assert.equal(e.samplesAcrossObstacle,.25);assert.equal(e.requiredSpacingM,1/6);
  assert.equal(missionEvidence({...a,displayGsd:.001},{obstacleWidth:.5}).decision,e.decision);
});
test('an uncalibrated photo cannot pass a metric sampling check',()=>{
  assert.equal(missionEvidence({metadata:{provenance:{metric:false,analysis_gsd:.01}}},{obstacleWidth:1}).decision,'UNKNOWN SCALE');
});
test('a coarse overview preserves source spacing but uses working spacing for decisions',()=>{
  const e=missionEvidence({metadata:{provenance:{metric:true,source_gsd:2,analysis_gsd:30}}},{obstacleWidth:10});
  assert.equal(e.observedSourceSpacingM,2);assert.equal(e.analysisSpacingM,30);assert.match(e.decision,/UNRESOLVED/);
});

test('interpolated finer analysis cannot clear hazards absent from the source sampling',()=>{
  const e=missionEvidence({metadata:{provenance:{metric:true,source_gsd:30,analysis_gsd:1}}},{obstacleWidth:3});
  assert.equal(e.screeningSpacingM,30);assert.equal(e.samplesAcrossObstacle,.1);assert.match(e.decision,/UNRESOLVED/);
});

test('a capped slope cannot clear a grade limit at or above its saturation threshold',()=>{
  const a={metadata:{analysisModel:{slope:{max:30}},provenance:{metric:true,analysis_gsd:2}}};
  const point={metrics:{slope:1}};
  assert.equal(missionEvidence(a,{maxSlope:35,obstacleWidth:1},point).gradeExceeded,null);
  assert.equal(missionEvidence(a,{maxSlope:25,obstacleWidth:1},point).gradeExceeded,true);
});
test('vehicle footprint changes physical contact locations without changing plane heights',()=>{
  const generic=roverGroundSupport([0,0,0],0,(x,z)=>x*.1+z*.2,vehicleWheels('generic'));
  const curiosity=roverGroundSupport([0,0,0],0,(x,z)=>x*.1+z*.2,vehicleWheels('curiosity'));
  assert.notEqual(generic.contacts[0].worldX,curiosity.contacts[0].worldX);
  assert.ok(Math.abs(generic.roll-curiosity.roll)<1e-9);
});
test('pressing collapses the directional shadow into the contact footprint',()=>{
  let last=waterShadow(0);
  for(let i=1;i<=20;i++){const s=waterShadow(i/20);assert.ok(s.x<=last.x&&Math.abs(s.y)<=Math.abs(last.y)&&s.opacity<=last.opacity&&s.softness<=last.softness);last=s;}
  assert.equal(last.x,0);assert.ok(Math.abs(last.y)===0);assert.ok(last.opacity<.01);
});
