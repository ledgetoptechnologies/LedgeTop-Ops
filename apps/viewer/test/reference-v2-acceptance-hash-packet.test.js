'use strict';
// Review of exact public fixture bytes only: no authority, receiver or live route.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const protocol = require('../server/referenceProtocol');
const base = process.env.PROCESSING_V2_VECTOR_DIR;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const pins = {
  'contract.schema.json': '850b38441911a518fd6b3add9b74b4f7e2e6d8607cca50372c38f785a01c6412',
  'hash-domains.json': '0ae9dda18cf7f2d77eb359e5a373221562f95397e82de0dbd1167799af67bc85',
  'canonical-vectors.json': '19a1b673bd9f1b88aea74a2c324936d9fdecb639ec579ca9286b406904d14e9a',
  'inventory.json': '3b9ea5f93a3d0dab57b67682d2210d48e18fe1c560facc607dffb6d1df3e7326',
};
test('pinned acceptance digest vectors match Viewer canonical bytes', {skip: !base}, () => {
  const files = {};
  for (const [name, expected] of Object.entries(pins)) {
    const raw = fs.readFileSync(path.join(base, name));
    assert.ok(raw.length < 1024 * 1024);
    assert.equal(sha(raw), expected, name);
    files[name] = JSON.parse(raw);
  }
  assert.equal(files['inventory.json'].inventoryDigest, 'b53e11dbb3a97fc1bfb064d231144e6353c98e82e68bddc9302d792f18b1fb77');
  const vector = files['canonical-vectors.json'].domainSeparatedRecords.find(item => item.type === 'AcceptedCopyAck.acceptanceSha256');
  assert.ok(vector);
  assert.equal(vector.prefixAscii, 'LTDS-PARTIAL-ACCEPTANCE-V2');
  assert.equal(vector.prefixTerminatorHex, '00');
  const original = protocol.canonicalBytes(vector.value);
  assert.equal(original.toString('base64'), vector.canonicalUtf8Base64);
  const hashAcceptance = value => sha(Buffer.concat([Buffer.from(vector.prefixAscii, 'ascii'), Buffer.from([0]), protocol.canonicalBytes(value)]));
  assert.equal(hashAcceptance(vector.value), vector.sha256);
  assert.equal(hashAcceptance(vector.changedValue), vector.changedSha256);
  assert.notEqual(vector.sha256, vector.changedSha256);
});
