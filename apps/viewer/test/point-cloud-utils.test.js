'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const modulePromise = import(pathToFileURL(path.join(__dirname, '..', 'point-cloud-utils.mjs')).href);

test('absolute UTM point positions are rebased before Float32 conversion', async () => {
  const { localizePointPositions } = await modulePromise;
  const source = new Float64Array([
    367257.0125, 4759982.025, 202.125,
    367258.0375, 4759983.05, 203.25,
  ]);

  const result = localizePointPositions(source, { e: 367257, n: 4759982, z: 200 });

  assert.equal(result.rebasedFromUtm, true);
  assert.ok(result.positions instanceof Float32Array);
  assert.ok(Math.abs(result.positions[0] - 0.0125) < 1e-6);
  assert.ok(Math.abs(result.positions[1] - 0.025) < 1e-6);
  assert.ok(Math.abs(result.positions[2] - 2.125) < 1e-6);
  assert.ok(Math.abs(result.positions[3] - 1.0375) < 1e-6);
});

test('already-local point positions are not shifted by the RTC origin', async () => {
  const { localizePointPositions } = await modulePromise;
  const source = new Float32Array([-12, -30, 2, 15, 22, 8]);

  const result = localizePointPositions(source, { e: 367257, n: 4759982, z: 200 });

  assert.equal(result.rebasedFromUtm, false);
  assert.deepEqual(Array.from(result.positions), Array.from(source));
});

test('malformed XYZ buffers fail closed', async () => {
  const { localizePointPositions } = await modulePromise;
  assert.throws(() => localizePointPositions(new Float32Array([1, 2])), /XYZ triples/);
});

test('point-cloud-only projects do not initialize a nonexistent mesh', async () => {
  const { hasMeshSource } = await modulePromise;
  assert.equal(hasMeshSource('none'), false);
  assert.equal(hasMeshSource(null), false);
  assert.equal(hasMeshSource('tiles'), true);
  assert.equal(hasMeshSource('glb'), true);
  assert.equal(hasMeshSource('obj'), true);
});

test('localized geometry replaces the stale UTM bounding sphere used for frustum culling', async () => {
  const THREE = await import('three');
  const { localizePointPositions, refreshPointGeometryBounds } = await modulePromise;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    367257, 4759982, 200,
    367267, 4759992, 205,
  ]), 3));
  geometry.computeBoundingSphere();
  assert.ok(geometry.boundingSphere.center.y > 4_000_000);

  const localized = localizePointPositions(
    geometry.getAttribute('position').array,
    { e: 367257, n: 4759982, z: 200 },
  );
  geometry.setAttribute('position', new THREE.BufferAttribute(localized.positions, 3));
  refreshPointGeometryBounds(geometry);

  assert.deepEqual(geometry.boundingSphere.center.toArray(), [5, 5, 2.5]);
  assert.deepEqual(geometry.boundingBox.min.toArray(), [0, 0, 0]);
  assert.deepEqual(geometry.boundingBox.max.toArray(), [10, 10, 5]);
});
