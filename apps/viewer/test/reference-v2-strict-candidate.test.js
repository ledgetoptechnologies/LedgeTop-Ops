'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { decodeV2Metadata: decode, requireSpoolV2Profile: profile, LIMITS } = require('../server/referenceV2StrictCandidate');
const root = path.join(__dirname, 'fixtures/reference-v2-lexical');
const cases = require('./fixtures/reference-v2-lexical/index.json');
const { canonicalBytes } = require('./helpers/reference-v2-canonical-snapshot.cjs');

test('rejects exact Processing lexical invalid fixtures with verified bytes', () => {
  for (const item of cases) {
    const bytes = fs.readFileSync(path.join(root, path.basename(item.inputFile)));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), item.inputSha256, item.id);
    assert.throws(() => decode(bytes), undefined, item.id);
  }
});
test('accepts scalar Unicode and bounded canonical integer data', () => {
  assert.deepEqual(decode(Buffer.from('{"a":[0,9007199254740991,true,null,"😀","\\ud83d\\ude00"]}')), {a:[0,9007199254740991,true,null,'😀','😀']});
  assert.equal(decode(Buffer.from('['.repeat(32) + '0' + ']'.repeat(32))).length, 1);
  assert.equal(decode(Buffer.from('[' + '0,'.repeat(9999) + '0]')).length, LIMITS.array);
  assert.equal(Object.keys(decode(Buffer.from('{' + Array.from({length:256}, (_, i) => '"k' + i + '":0').join(',') + '}'))).length, LIMITS.object);
});
test('rejects limits, unsafe JSON numbers, alias keys and malformed content', () => {
  const bad = ['['.repeat(33)+'0'+']'.repeat(33), '['+'0,'.repeat(10000)+'0]', '{'+Array.from({length:257},(_,i)=>'"k'+i+'":0').join(',')+'}', '{"a":1,"\\u0061":2}', '{"constructor":1}', '-0', '-1', '1.0', '1e0', '9007199254740992', 'true false', '[1,]', '{"a":1,}', '"\\ud800"'];
  for (const input of bad) assert.throws(() => decode(Buffer.from(input)), undefined, input.slice(0,80));
  assert.throws(() => decode(Buffer.alloc(LIMITS.bytes+1, 0x20)));
  assert.throws(() => decode(Buffer.from([0x22, 0xff, 0x22])));
});
test('requires distinct spool v2 marker and exact expected record type', () => {
  const v2 = {protocol:'ltds-processing-spool-v2',schemaVersion:2,receiptType:'source_release_ack_v2'};
  assert.equal(profile(v2, 'source_release_ack_v2'), v2);
  for (const bad of [{schemaVersion:1,receiptType:'source_release_ack'}, {...v2, protocol:undefined}, {...v2, schemaVersion:1}, {...v2, receiptType:'source_release_ack'}, {...v2,receiptType:'accepted_copy_ack'}]) assert.throws(() => profile(bad,'source_release_ack_v2'));
  assert.throws(() => profile(v2, 'accepted_copy_ack'));
});
test('roundtrips the pinned Processing canonical and acceptance vectors', () => {
  const raw = fs.readFileSync(path.join(root, 'canonical-vectors.json'));
  const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha(raw), '19a1b673bd9f1b88aea74a2c324936d9fdecb639ec579ca9286b406904d14e9a');
  const packet = JSON.parse(raw);
  assert.equal(packet.vectors.length, 3);
  assert.equal(packet.domainSeparatedRecords.length, 1);
  for (const vector of [...packet.vectors, ...packet.domainSeparatedRecords]) {
    const canonical = Buffer.from(vector.canonicalUtf8Base64, 'base64');
    assert.deepEqual(canonicalBytes(decode(canonical)), canonical);
    assert.deepEqual(canonicalBytes(decode(Buffer.from(JSON.stringify(vector.value)))), canonical);
    if (vector.prefixAscii) {
      assert.equal(vector.prefixTerminatorHex, '00');
      const digest = value => sha(Buffer.concat([Buffer.from(vector.prefixAscii, 'ascii'), Buffer.from([0]), canonicalBytes(value)]));
      assert.equal(digest(decode(canonical)), vector.sha256);
      assert.equal(digest(decode(Buffer.from(JSON.stringify(vector.changedValue)))), vector.changedSha256);
    } else assert.equal(sha(canonical), vector.sha256);
  }
});
