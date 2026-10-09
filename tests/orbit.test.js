import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedLocation, previousOrbitLevel, sourcedEarthLayer, createEnvironmentProviders } from '../src/engine/orbit.js';
import { latLonToVec3, vec3ToLatLon } from '../src/lib/moonSites.js';

test('surface coordinates round-trip independently of visual body placement', () => {
  for (const [lat, lon] of [[19.1,73.1],[-89.66,129.2],[10.504743,89.88404],[0,-179.999]]) {
    const point=latLonToVec3(lat,lon,2), actual=vec3ToLatLon(...point);
    assert.ok(Math.abs(actual.lat-lat)<1e-10);assert.ok(Math.abs(actual.lon-lon)<1e-10);
  }
});

test('persistent location records retain a body-specific reference and do not claim loaded data', () => {
  const moon=selectedLocation('moon',10,190,'2026-10-01T00:00:00Z');
  assert.equal(moon.longitude,-170);assert.equal(moon.referenceModel.radiusM,1737400);
  assert.ok(!JSON.stringify(moon.referenceModel).includes('WGS84'));
  assert.equal(moon.terrainDataStatus,'not-loaded');assert.equal(moon.dataset,null);
  const earth=selectedLocation('earth',19.1,73.1);
  assert.equal(earth.referenceModel.model,'WGS84 geographic');
  assert.throws(()=>selectedLocation('earth',91,0));assert.throws(()=>selectedLocation('mars',0,0));
  moon.referenceModel.radiusM=1;
  assert.equal(selectedLocation('moon',0,0).referenceModel.radiusM,1737400);
  assert.equal(previousOrbitLevel('region'),'body');assert.equal(previousOrbitLevel('body'),'space');
});

test('future environment and Earth layers stay unavailable without sourced inputs', () => {
  assert.ok(Object.values(createEnvironmentProviders()).every(provider=>provider===null));
  assert.throws(()=>sourcedEarthLayer({kind:'roads',content:{url:'/fake'}}));
  const layer=sourcedEarthLayer({kind:'clouds',source:'fixture',datasetId:'static-clouds',reference:'geographic',content:{url:'/clouds'}});
  assert.equal(layer.source,'fixture');assert.equal(layer.body,'earth');
});
