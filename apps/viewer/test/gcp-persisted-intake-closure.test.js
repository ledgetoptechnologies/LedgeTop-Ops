'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { persistedSourceIntakeContext } = require('../server/processingWorker');

test('resumed source intake requires the exact retained GCP object', () => {
  const bytes = Buffer.from('control points');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const snapshot = { contentBytes: bytes, sha256 };
  const object = { id: 'gcp_attempt', byteSize: bytes.length, sha256 };
  const request = objects => ({ manifest: {}, sourceManifest: {}, derivedManifest: { objects } });
  assert.equal(persistedSourceIntakeContext(request([object]), 'attempt', snapshot).derivedBytes.get(object.id), bytes);
  assert.equal(persistedSourceIntakeContext(request([]), 'attempt', null).derivedBytes.size, 0);
  for (const [objects, current] of [[[], snapshot], [[object], null], [[object, object], snapshot], [[{...object, sha256: '0'.repeat(64)}], snapshot]]) {
    assert.throws(() => persistedSourceIntakeContext(request(objects), 'attempt', current), { code: 'gcp_snapshot_changed' });
  }
});
