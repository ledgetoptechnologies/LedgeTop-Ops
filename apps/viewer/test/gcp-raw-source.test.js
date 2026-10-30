'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { decodeRawGcpSource, parseRawGcpSource } = require('../server/gcpRawSource');
const { MAX_SOURCE_BYTES } = require('../server/gcpImport');

test('raw GCP source preserves BOM, line endings and multibyte bytes', () => {
  const original = Buffer.from('\ufeffName,Description\r\nGCP1,caf\u00e9\r\n', 'utf8');
  const result = decodeRawGcpSource(original.toString('base64'));
  assert.deepEqual(result.bytes, original);
  assert.equal(result.byteSize, original.length);
  assert.equal(result.sha256, crypto.createHash('sha256').update(original).digest('hex'));
  assert.equal(Buffer.from(result.content, 'utf8').compare(original), 0);
});

test('raw GCP source rejects malformed, noncanonical and non-UTF8 input', () => {
  for (const invalid of ['', 'YQ', 'YQ===', 'YQ==\n', 'YR==', '////', 1, null]) {
    assert.throws(() => decodeRawGcpSource(invalid), { code: 'invalid_gcp_input' });
  }
});

test('raw GCP source enforces byte limit before accepting content', () => {
  const maximum = Buffer.alloc(MAX_SOURCE_BYTES, 0x61);
  assert.equal(decodeRawGcpSource(maximum.toString('base64')).byteSize, MAX_SOURCE_BYTES);
  assert.throws(() => decodeRawGcpSource(Buffer.alloc(MAX_SOURCE_BYTES + 1, 0x61).toString('base64')), { code: 'invalid_gcp_input' });
});

test('preview binds confirmation to exact raw bytes, including a BOM', () => {
  const plain = Buffer.from('point_id,label,latitude,longitude,elevation_m\r\nA,A,44.5,-88.1,250\r\n');
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), plain]);
  const first = parseRawGcpSource({ encoded: plain.toString('base64'), format: 'generic-csv-v1' });
  const second = parseRawGcpSource({ encoded: withBom.toString('base64'), format: 'generic-csv-v1' });
  assert.equal(first.parsed.points.length, 1);
  assert.equal(second.parsed.points.length, 1);
  assert.notEqual(first.sha256, second.sha256);
  assert.notEqual(first.confirmationToken, second.confirmationToken);
});
