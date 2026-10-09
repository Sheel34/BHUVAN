import test from 'node:test';
import assert from 'node:assert/strict';
import { pressWater, releaseWater, waterPressure, waterSettled, forgetWater } from '../src/engine/waterFeedback.js';
import { layoutTerrainMarkers } from '../src/engine/annotationLayout.js';

test('a rapid click stays visible, returns once and settles exactly', () => {
  const button = {};
  pressWater(button, 1000); releaseWater(button, 1010);
  assert.equal(waterPressure(button, 1000), 0);
  assert.equal(waterPressure(button, 1120), 1);
  assert.ok(waterPressure(button, 1250) < 1);
  assert.equal(waterPressure(button, 1430), 0);
  assert.equal(waterPressure(button, 9000), 0);
  assert.equal(waterSettled(button, 1430), true);
});

test('holding a button retains pressure until release and repeated release cannot extend it', () => {
  const button = {};
  pressWater(button, 0);
  assert.equal(waterPressure(button, 30000), 1);
  assert.equal(waterSettled(button, 30000), false);
  releaseWater(button, 30000); releaseWater(button, 30050);
  assert.equal(waterSettled(button, 30300), true);
  pressWater(button, 30400);
  assert.equal(waterPressure(button, 30400), 0);
  forgetWater(button); assert.equal(waterPressure(button, 30500), 0);
});

const bounds = { left: 284, top: 240, right: 946, bottom: 496 };
test('reduced motion keeps a quick press perceptible without bounce or ripple timing', () => {
  const button = {};
  pressWater(button, 0); releaseWater(button, 10);
  assert.equal(waterPressure(button, 0, true), 1);
  assert.equal(waterPressure(button, 120, true), 1);
  assert.equal(waterPressure(button, 131, true), 0);
  assert.equal(waterSettled(button, 131, true), true);
});
test('clustered points get compact non-overlapping markers with their original anchors retained', () => {
  const points = Array.from({ length: 5 }, (_, id) => ({ id, x: 680, y: 340, visible: true }));
  const original = JSON.stringify(points), cards = layoutTerrainMarkers(points, bounds);
  assert.equal(cards.length, 5);
  for (const card of cards) {
    assert.ok(card.x >= bounds.left && card.x + card.width <= bounds.right);
    assert.ok(card.y >= bounds.top && card.y + card.height <= bounds.bottom);
    assert.equal(card.anchorX, 680); assert.equal(card.anchorY, 340);
    assert.equal(card.width, 32); assert.equal(card.height, 32);
    assert.ok(Math.hypot(card.x + 16 - 680, card.y + 16 - 340) <= 108.001);
    for (const other of cards) if (other !== card) {
      assert.ok(card.x + card.width + 4 <= other.x || other.x + other.width + 4 <= card.x
        || card.y + card.height + 4 <= other.y || other.y + other.height + 4 <= card.y);
    }
  }
  assert.equal(JSON.stringify(points), original);
  assert.deepEqual(layoutTerrainMarkers(points, bounds), cards);
});

test('offscreen/occluded points stay out of the view and undersized viewports do not stack labels', () => {
  const points = [{ id: 1, x: 0, y: 0, visible: false }, { id: 2, x: 320, y: 360, visible: true }];
  assert.deepEqual(layoutTerrainMarkers(points, bounds).map(card => card.id), [2]);
  assert.deepEqual(layoutTerrainMarkers(points, { left: 0, top: 0, right: 20, bottom: 20 }), []);
  const mobile = Array.from({length: 5}, (_, id) => ({id, x: 200, y: 400, visible: true}));
  assert.equal(layoutTerrainMarkers(mobile, {left: 16, top: 264, right: 370, bottom: 662}, 44).length, 5);
});

test('separated markers stay exactly on their anchors and avoid controls when nudged', () => {
  const points = [{id: 1, x: 480, y: 300, visible: true}, {id: 2, x: 800, y: 400, visible: true}];
  const markers = layoutTerrainMarkers(points, bounds);
  assert.equal(markers[0].x + 16, 480); assert.equal(markers[0].y + 16, 300);
  assert.equal(markers[1].x + 16, 800); assert.equal(markers[1].y + 16, 400);
  const obstacle = {x: 450, y: 270, width: 60, height: 60};
  const shifted = layoutTerrainMarkers(points, bounds, 32, [obstacle]);
  assert.equal(shifted.length, 2);
  for (const marker of shifted) assert.ok(marker.x + 32 <= obstacle.x || marker.x >= obstacle.x + 60
    || marker.y + 32 <= obstacle.y || marker.y >= obstacle.y + 60);
});
