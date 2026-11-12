import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildContract } from './staging-migration-contract.mjs';

const contract = buildContract();
const byRole = role => contract.workers.find(w => w.role === role);
test('packet is offline and cannot be treated as deployable configuration', () => {
  assert.equal(contract.deployable, false); assert.equal(contract.providerWrites, false);
  assert.equal(contract.schema, 'ledge-top.staging-migration-review.v1');
  assert.ok(contract.holds.includes('not-a-wrangler-config'));
});
test('every proposed worker stays private in the Staging account', () => {
  assert.equal(contract.workers.length, 6);
  for (const worker of contract.workers) {
    assert.equal(worker.accountId, 'df3f376bae6ee621f50cf972ebcc9484');
    assert.equal(worker.workersDev, false); assert.equal(worker.previewUrls, false);
    assert.deepEqual(worker.routes, []); assert.match(worker.name, /^ledge-top-.+-staging$/);
  }
});
test('graph is closed and retains reciprocal Ops/Portal and Sync ingress', () => {
  const names = new Set(contract.workers.map(w => w.name));
  assert.equal(names.size, 6);
  for (const worker of contract.workers) for (const edge of worker.services) assert.ok(names.has(edge.target));
  assert.ok(byRole('operations').services.some(e => e.target === byRole('client').name));
  assert.ok(byRole('client').services.some(e => e.binding === 'VIEWER_SESSION_ISSUER'));
  assert.equal(byRole('sync').services.length, 2);
  assert.equal(byRole('iosEdge').services[0].target, byRole('iosRead').name);
});
test('unallocated identities are conspicuous and no production resource ID is copied', () => {
  const raw = JSON.stringify(contract);
  for (const forbidden of ['846c924bf17bf4f3dd15c97a4c5d1d51', '6ebf7514-d306-4615-ae56-ad869c874dbd',
    '7f40a7b7-c3ec-470e-a626-e798867f71f8', '78b34173-b168-4e3d-9832-bb9d245cc6b8',
    '559cd7c0d2cc47f271aac422412fce677a51443ec365d9f2c585d9c0e377cc0b']) assert.ok(!raw.includes(forbidden));
  for (const worker of contract.workers) for (const db of worker.databases) assert.match(db.id, /^REQUIRES_ALLOCATION:/);
  assert.match(contract.access.iosAudience, /^REQUIRES_ALLOCATION:/);
});
test('iOS enablement mismatch and source-only origin pins remain explicit blockers', () => {
  assert.equal(contract.activation.iosManagedPilot, 'unresolved-live-source-delta');
  assert.ok(contract.holds.includes('ios-source-reviewed-origin-pins'));
  assert.ok(contract.holds.includes('ios-live-source-enable-delta'));
  assert.equal(contract.access.callback, 'com.ledgetoptechnologies.ops.pilot://auth/callback');
});
test('fresh graph requires retained UI service, source drift and no running jobs', () => {
  for (const role of ['operations', 'client']) assert.ok(byRole(role).services.some(e => e.binding === 'UI_RELEASE_ASSETS'));
  assert.equal(contract.activation.assetRetentionHours, 48);
  assert.equal(contract.activation.crons, false); assert.equal(contract.activation.queueConsumers, false);
  assert.equal(contract.unresolvedLiveBindings.length, 5);
  assert.equal(contract.unresolvedLiveWorkflows[0].className, 'ProjectAlphaCatalogPromotionWorkflow');
  assert.equal(contract.unresolvedLiveWorkflows[0].previouslyObservedLiveWorkflowCount, 5);
  assert.equal(contract.durableObjects[0].binding, 'THUMBNAIL_RENDERER');
});
test('checked-in packet matches the current source-derived contract', () => {
  const packet = JSON.parse(readFileSync(new URL('../docs/staging/account-migration/contract.json', import.meta.url)));
  assert.deepEqual(packet, contract);
});
test('migration source chains are pinned independently of line-ending checkout policy', () => {
  assert.equal(contract.migrationSources.length, 2);
  for (const chain of contract.migrationSources) {
    assert.ok(chain.fileCount > 0); assert.match(chain.chainSha256, /^[a-f0-9]{64}$/);
    assert.equal(chain.textNormalization, 'CRLF-to-LF');
    assert.equal(chain.ledgerRequirement, 'compare-every-applied-name-and-body-before-rehearsed-apply');
  }
});
