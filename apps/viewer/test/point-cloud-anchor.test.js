'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  POINT_PICK_WINDOW,
  NAVIGATION_POLICY,
  orbitRadiansForPixels,
  wheelZoomScale,
  worldUnitsPerPixel,
  maxPanStep,
  clampZoomDistance,
  isPlausibleAnchorDistance,
  canUseOverviewAnchor,
} = require('../public/pointcloud-navigation.js');

test('point-cloud picking uses a narrow odd window instead of Potree default 65 pixels', () => {
  assert.equal(POINT_PICK_WINDOW, 11);
  assert.equal(POINT_PICK_WINDOW % 2, 1);
  assert.ok(POINT_PICK_WINDOW < 20);
});

test('point-cloud anchor depth rejects distant background hits but keeps nearby surface variation', () => {
  assert.equal(isPlausibleAnchorDistance(104, 100), true);
  assert.equal(isPlausibleAnchorDistance(135, 100), true);
  assert.equal(isPlausibleAnchorDistance(136, 100), false);
  assert.equal(isPlausibleAnchorDistance(8, 10), true, 'foreground points remain valid');
  assert.equal(isPlausibleAnchorDistance(15, 10), true, 'close views retain a five-metre minimum allowance');
  assert.equal(isPlausibleAnchorDistance(15.01, 10), false);
  assert.equal(isPlausibleAnchorDistance(Number.NaN, 10), false);
  assert.equal(isPlausibleAnchorDistance(10, 0), false);
});

test('point-cloud motion policy matches model gains and scales translation with view distance', () => {
  assert.equal(NAVIGATION_POLICY.orbitTurnsPerViewport, 0.55);
  assert.equal(NAVIGATION_POLICY.wheelBase, 0.9);
  assert.ok(Math.abs(orbitRadiansForPixels(100, 1000) + Math.PI * 2 * 0.055) < 1e-12);
  assert.equal(orbitRadiansForPixels(-100, 1000), -orbitRadiansForPixels(100, 1000));
  assert.ok(Math.abs(wheelZoomScale(-100) - 0.9) < 1e-12);
  assert.ok(Math.abs(wheelZoomScale(100) - (1 / 0.9)) < 1e-12);

  const nearUnits = worldUnitsPerPixel(100, 60, 1000);
  const farUnits = worldUnitsPerPixel(1000, 60, 1000);
  assert.ok(nearUnits > 0);
  assert.ok(Math.abs(farUnits / nearUnits - 10) < 1e-12, 'screen pan must preserve visual speed as distance changes');
  assert.equal(maxPanStep(1), 50);
  assert.equal(maxPanStep(1000), 2000, 'overview pan must not retain the old fixed 1000 metre rejection');
  assert.equal(clampZoomDistance(0), NAVIGATION_POLICY.minZoomDistance);
  assert.equal(clampZoomDistance(Infinity), NAVIGATION_POLICY.minZoomDistance);
  assert.equal(clampZoomDistance(1e9), NAVIGATION_POLICY.maxZoomDistance);
});

test('overview orbit fallback is limited to the visible cloud bounds and overview distances', () => {
  const bounds = { min: { x: 100, y: 200, z: 10 }, max: { x: 200, y: 300, z: 60 } };
  const cloudDiameter = 150;
  assert.equal(canUseOverviewAnchor({
    point: { x: 150, y: 250, z: 35 }, bounds, referenceDistance: 200, cloudDiameter,
  }), true);
  assert.equal(canUseOverviewAnchor({
    point: { x: 150, y: 250, z: 35 }, bounds, referenceDistance: 50, cloudDiameter,
  }), false, 'close views still require a real point hit');
  assert.equal(canUseOverviewAnchor({
    point: { x: 250, y: 250, z: 35 }, bounds, referenceDistance: 200, cloudDiameter,
  }), false, 'empty background outside the projected cloud footprint cannot start orbit');
  assert.equal(canUseOverviewAnchor({
    point: { x: 202, y: 250, z: 35 }, bounds, referenceDistance: 200, cloudDiameter,
  }), true, 'small edge tolerance avoids losing orbit to numerical bounds noise');
});
