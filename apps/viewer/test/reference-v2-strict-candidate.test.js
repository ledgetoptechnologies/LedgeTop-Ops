'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { decodeV2Metadata: decode, requireSpoolV2Profile: profile, LIMITS } = require('../server/referenceV2StrictCandidate');
const root = path.join(__dirname, 'fixtures/reference-v2-lexical');
const cases = require('./fixtures/reference-v2-lexical/index.json');

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
