'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const valid = Object.freeze({
  revision: 'a'.repeat(40),
  schema: '19',
  cache: 'no-store',
});
const headers = ({ revision = valid.revision, schema = valid.schema, cache = valid.cache } = {}) => new Headers({
  'X-LTDS-Viewer-Revision': revision,
  'X-LTDS-Viewer-Schema-Version': schema,
  'Cache-Control': cache,
});

test('accepts matching no-store probes at the exact source-derived schema', async () => {
  const { validateRuntimeProbeHeaders } = await import('../scripts/runtime-probe-identity.mjs');
  assert.equal(validateRuntimeProbeHeaders({ healthHeaders: headers(), readyHeaders: headers(), expectedSchemaVersion: 19, bakedRevision: valid.revision }), null);
});

for (const [name, mutate, expected] of [
  ['health cache policy', () => ({ healthHeaders: headers({ cache: 'public, max-age=60' }), readyHeaders: headers() }), /Cache-Control: no-store/],
  ['readiness cache policy', () => ({ healthHeaders: headers(), readyHeaders: headers({ cache: 'private, no-store' }) }), /Cache-Control: no-store/],
  ['older schema', () => ({ healthHeaders: headers({ schema: '18' }), readyHeaders: headers({ schema: '18' }) }), /does not match expected schema version 19/],
  ['newer schema', () => ({ healthHeaders: headers({ schema: '20' }), readyHeaders: headers({ schema: '20' }) }), /does not match expected schema version 19/],
  ['probe disagreement', () => ({ healthHeaders: headers(), readyHeaders: headers({ revision: 'b'.repeat(40) }) }), /do not agree on a valid Viewer revision/],
  ['baked revision mismatch', () => ({ healthHeaders: headers(), readyHeaders: headers(), bakedRevision: 'b'.repeat(40) }), /immutable runtime source identity/],
]) test(`rejects ${name}`, async () => {
  const { validateRuntimeProbeHeaders } = await import('../scripts/runtime-probe-identity.mjs');
  const input = mutate();
  assert.match(validateRuntimeProbeHeaders({ ...input, expectedSchemaVersion: 19, bakedRevision: input.bakedRevision ?? valid.revision }), expected);
});
