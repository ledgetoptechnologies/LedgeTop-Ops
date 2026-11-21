'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { publishedAssetIntegrityAllows } = require('../server/assets');

test('published asset range verification uses registered chunks and rejects tampered full responses', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-asset-range-'));
  const file = path.join(directory, 'fixture.tif');
  const body = Buffer.from('abcdefgh');
  fs.writeFileSync(file, body);
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(directory); });
  const hash = data => crypto.createHash('sha256').update(data).digest('hex');
  const chunks = [0, 4].map(byteOffset => ({ byteOffset, byteSize: 4,
    sha256: hash(body.subarray(byteOffset, byteOffset + 4)) }));
  const asset = { id: 'ortho', kind: 'ortho', relativePath: 'fixture.tif', byteSize: 8, sha256: hash(body) };
  const repository = { getModelAssetChunks(id, relativePath) {
    assert.equal(id, 'ortho'); assert.equal(relativePath, ''); return chunks;
  } };
  const verify = range => publishedAssetIntegrityAllows(repository, { provider: 'ltds-processing' },
    asset, 'fixture.tif', file, range);
  assert.equal(await verify('bytes=0-1'), true);
  assert.equal(await verify(null), true);
  fs.writeFileSync(file, 'abcdefgX');
  assert.equal(await verify('bytes=0-1'), true, 'unrequested chunks are not read');
  assert.equal(await verify('bytes=6-7'), false);
  assert.equal(await verify(null), false);
});
