'use strict';
// Test-only oracle: this does not authenticate evidence or enable a pipeline.
const test = require('node:test');
const assert = require('node:assert/strict');
const vectors = require('./fixtures/treedar-project-provenance-vectors.json');

function syntheticAdmission({ capability, request, resolver }) {
  const id = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(value);
  return capability.advertised === true && capability.current === true &&
    request.treedar === true && request.gaussianSplat === false &&
    ['projectId', 'assetId', 'receiptId'].every(key => id(request[key]) && request[key] === resolver[key]) &&
    /^[a-f0-9]{64}$/.test(request.sha256) && request.sha256 === resolver.sha256 &&
    resolver.authenticated === true && resolver.immutable === true &&
    resolver.genuineSensorLidar === true && resolver.photogrammetryDerived === false;
}

test('synthetic TreeDar provenance policy vectors', async t => {
  assert.equal(vectors.version, 1);
  for (const vector of vectors.vectors) {
    await t.test(vector.name, () => {
      const value = structuredClone(vectors.base);
      for (const [key, patch] of Object.entries(vector.patch)) Object.assign(value[key], patch);
      assert.equal(syntheticAdmission(value), vector.accept);
    });
  }
});
