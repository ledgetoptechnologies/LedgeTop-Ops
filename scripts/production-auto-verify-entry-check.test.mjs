import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { verifierEntryFindings } from './production-auto-verify-entry-check.mjs';

const union = JSON.parse(fs.readFileSync(new URL('./data/production-auto-asset-bootstrap/client-packet-manifest.json', import.meta.url), 'utf8')).union.files
  .map(row => ({ path: row.path, size: row.size, sha256: row.sha256, contentType: row.mime ?? row.contentType }));

test('the reviewed Client packet union passes every verifier rule and the real source builder', () => {
  const result = verifierEntryFindings(union, { workerName: 'ledgetop-clients', versionId: '7ebfd9ba-e293-482d-84f9-08d1c6901b88' });
  assert.deepEqual(result.rules, []);
  assert.equal(result.realCreateAssetVerifierSource, 'accepted');
});

test('each verifier rule is named by a fixed label, and the real builder agrees it refuses', () => {
  const ok = union[0];
  for (const [label, bad] of [
    ['pathRefused', { ...ok, path: '/images/photo.jpg' }],
    ['mimeRefused', { ...ok, contentType: 'text/javascript; charset=utf-8' }],
    ['sizeRefused', { ...ok, size: 17 * 1024 * 1024 }],
    ['archiveIndexRefused', { ...ok, path: `/_ui/client/${'b'.repeat(40)}/index.html`, contentType: 'text/html' }],
    ['releaseProofRefused', { ...ok, path: `/_ui/client/${'c'.repeat(40)}/release.json`, contentType: 'text/plain' }],
  ]) {
    const result = verifierEntryFindings([...union.slice(1), bad], { workerName: 'ledgetop-clients' });
    assert.ok(result.rules.includes(label), `${label}: ${result.rules}`);
    assert.equal(result.realCreateAssetVerifierSource, 'refused', label);
    assert.ok(!JSON.stringify(result).includes(bad.path), 'no path is echoed');
  }
  const many = Array.from({ length: 1025 }, (_, i) => ({ ...ok, path: `/assets/f${i}.js` }));
  assert.ok(verifierEntryFindings(many, { workerName: 'ledgetop-clients' }).rules.includes('file_count_over_limit'));
});
