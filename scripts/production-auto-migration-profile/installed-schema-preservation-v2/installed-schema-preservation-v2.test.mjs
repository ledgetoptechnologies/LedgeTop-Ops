import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BASE, BASE_SHA256, INSTALLED_SCHEMA_PRESERVATION_V2_BASE_PINS as PINS, readSourceMigrationNames,
  validateInstalledSchemaPreservationV2, createInstalledSchemaPreservationV2Session, createInstalledSchemaPreservationV2TestSession,
  isProductionInstalledSchemaPreservationV2Admission } from './installed-schema-preservation-v2.mjs';
import { PRODUCTION_DATABASES } from '../installed-schema-preservation-v1/installed-schema-preservation.mjs';
import { PROFILE as V4_PROFILE, readCanonicalInstalledProfileV5 } from '../../production-deploy.mjs';
import { createProductionAutoCloudflarePacer } from '../../production-auto-cloudflare-pacer.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const SOURCE_COMMIT = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('../../../', import.meta.url)),
  encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 1024 }).trim();
const NOW = Date.parse('2026-11-27T21:00:00.000Z');
function evidence() {
  return { schemaVersion: 1, purpose: 'installed-schema-preservation-metadata-evidence', accountId: BASE.accountId,
    observedAt: new Date(NOW - 1_000).toISOString(), readOnly: true, executesDdl: false,
    databases: Object.fromEntries(['operations', 'client'].map(app => [app, { databaseId: PRODUCTION_DATABASES[app],
      ledger: clone(BASE.databases[app].orderedLedger), schema: { ...clone(BASE.databases[app].schema), cloudflareInternalRows: 1 } }])) };
}
const installedNames = app => BASE.databases[app].orderedLedger.map(row => row.name).sort();
const names = (changes = {}) => ({ operations: installedNames('operations'), client: installedNames('client'), ...changes });
const check = (input = {}) => validateInstalledSchemaPreservationV2({ evidence: evidence(), sourceCommit: SOURCE_COMMIT,
  sourceNames: names(), now: NOW, ...input });

test('the v2 base pins the ordered ledgers and schema digests of the 2026-11-27 read', () => {
  assert.equal(BASE_SHA256, hash(Buffer.from(fs.readFileSync(new URL('./base.json', import.meta.url), 'utf8').replace(/\r\n/gu, '\n'))));
  assert.equal(BASE.observedAt, '2026-11-27T20:09:53.090Z');
  assert.deepEqual({ ...PINS.operations }, { databaseId: '6ebf7514-d306-4615-ae56-ad869c874dbd', ledgerCount: 238,
    highestInstalledName: '0248_client_onboarding_invite_mail_outbox.sql',
    orderedLedgerSha256: 'bddff2b1eb5ad46da2ae449e4b07ce899e1082668a5e78a5716112d5f5489b91',
    objectCount: 2616, objectsSha256: '701c5294031095d53daf0a90608a46ee82eeb25877c729b6c564906ef6ccf56f' });
  assert.deepEqual({ ...PINS.client }, { databaseId: '7f40a7b7-c3ec-470e-a626-e798867f71f8', ledgerCount: 164,
    highestInstalledName: '0243_viewer_direct_grant_model_report.sql',
    orderedLedgerSha256: '5dbcf86ded8599cfb6e5199b8673c42e21dd84681a1464fceed0518f63f68d7e',
    objectCount: 1210, objectsSha256: 'ebfa0d346537eb9452410ea0f02a3e4bb61a1dbcf3ac02cd5448ea0a933895ce' });
  for (const app of ['operations', 'client']) {
    const db = BASE.databases[app];
    assert.equal(hash(Buffer.from(JSON.stringify(db.orderedLedger))), PINS[app].orderedLedgerSha256);
    assert.deepEqual(db.orderedLedger.map(row => row.id), db.orderedLedger.map((_, index) => index + 1));
    assert.ok(db.orderedLedger.every(row => Object.keys(row).join() === 'name,id' && row.name.endsWith('.sql')));
  }
  // Client keeps its historical and out-of-order installed rows exactly.
  const client = BASE.databases.client.orderedLedger;
  assert.deepEqual(client.filter((row, i) => i > 0 && row.name < client[i - 1].name).map(row => `${row.id}:${row.name}`), [
    '33:0112_public_share_location_privacy.sql', '120:0199_incoming_upload_pickup_lifecycle.sql',
    '160:0235_windows_portal_successor_candidates.sql']);
  assert.ok(Object.isFrozen(BASE.databases.client.orderedLedger[0]));
});

test('v2 admits the exact base with no pending source migration', () => {
  const result = check();
  assert.equal(result.status, 'installed-schema-preserved-v2');
  assert.equal(result.baseSha256, BASE_SHA256);
  assert.deepEqual(result.databases.operations.pendingSourceNames, []);
  assert.equal(result.applicationSchemaReady, false); assert.equal(result.authorizesMigration, false);
  // Source names that are a subset of the installed ledger (historical rows absent from source) are fine.
  assert.equal(check({ sourceNames: names({ client: installedNames('client').filter(name => !name.startsWith('0113_')) }) }).status,
    'installed-schema-preserved-v2');
});

test('v2 holds every pending source migration and names an out-of-order one separately', () => {
  assert.throws(() => check({ sourceNames: names({ operations: [...installedNames('operations'), '0249_next.sql'] }) }),
    { code: 'migration_required_pending' });
  assert.throws(() => check({ sourceNames: names({ client: [...installedNames('client'), '0244_next.sql'] }) }),
    { code: 'migration_required_pending' });
  for (const sourceNames of [names({ operations: [...installedNames('operations'), '0247_late.sql'] }),
    names({ client: [...installedNames('client'), '0243_a_late.sql'] }),
    names({ operations: [...installedNames('operations'), '0249_next.sql', '0001_early.sql'] })])
    assert.throws(() => check({ sourceNames }), { code: 'migration_out_of_order_pending' });
});

test('v2 refuses ledger, schema, identity or freshness drift', () => {
  const variants = [
    [e => { e.databases.operations.ledger.pop(); }, 'preservation_v2_ledger_drift'],
    [e => { e.databases.client.ledger[32].id = 999; }, 'preservation_v2_ledger_drift'],
    [e => { e.databases.client.ledger.reverse(); }, 'preservation_v2_ledger_drift'],
    [e => { e.databases.operations.ledger.push({ name: '0249_next.sql', id: 239 }); }, 'preservation_v2_ledger_drift'],
    [e => { e.databases.operations.schema.objectCount++; }, 'preservation_v2_schema_drift'],
    [e => { e.databases.client.schema.objectsSha256 = 'f'.repeat(64); }, 'preservation_v2_schema_drift'],
    [e => { e.databases.client.databaseId = PRODUCTION_DATABASES.operations; }, 'preservation_evidence_invalid'],
    [e => { e.readOnly = false; }, 'preservation_evidence_invalid'],
    [e => { e.observedAt = new Date(NOW - 60_001).toISOString(); }, 'preservation_evidence_invalid'],
    [e => { e.observedAt = new Date(NOW + 1).toISOString(); }, 'preservation_evidence_invalid'],
    [e => { e.databases.operations.ledger[0].extra = true; }, 'preservation_ledger_row_invalid'],
  ];
  for (const [mutate, code] of variants) {
    const e = evidence(); mutate(e);
    assert.throws(() => validateInstalledSchemaPreservationV2({ evidence: e, sourceCommit: SOURCE_COMMIT, sourceNames: names(), now: NOW }),
      { code }, code);
  }
  assert.throws(() => check({ sourceNames: { operations: installedNames('operations') } }), { code: 'preservation_evidence_invalid' });
  assert.throws(() => check({ sourceNames: names({ client: ['0001_x.txt'] }) }), { code: 'preservation_evidence_invalid' });
  assert.throws(() => check({ sourceCommit: 'nope' }), { code: 'preservation_evidence_invalid' });
});

test('source migration names come from the exact commit tree, sorted and .sql only', () => {
  const current = readSourceMigrationNames(SOURCE_COMMIT);
  for (const app of ['operations', 'client']) {
    assert.ok(current[app].length > 100 && current[app].every(name => /^[0-9]{4}_[a-z0-9_]+\.sql$/u.test(name)));
    assert.deepEqual([...current[app]].sort(), current[app]);
  }
  assert.throws(() => readSourceMigrationNames('HEAD'), { code: 'preservation_source_commit_invalid' });
});

test('v2 sessions refuse an untrusted transport, a non-v5 profile and Sync asset rotation before any I/O', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('native-transport-test-stop'); });
  const v5 = readCanonicalInstalledProfileV5();
  const options = { sourceCommit: SOURCE_COMMIT, canonicalV5Profile: v5, selectedApp: 'client', token: 'x'.repeat(32) };
  const native = createProductionAutoCloudflarePacer({ accountId: BASE.accountId });
  await assert.rejects(createInstalledSchemaPreservationV2Session({ ...options, fetchImpl: native.fetchImpl }), /native-transport-test-stop/u);
  assert.equal(requests, 1, 'the production constructor reached its own paced transport');
  const fake = createProductionAutoCloudflarePacer({ accountId: BASE.accountId, fetchImpl: async () => { requests++; throw Error('fake'); } });
  await assert.rejects(createInstalledSchemaPreservationV2Session({ ...options, fetchImpl: fake.fetchImpl }),
    { code: 'preservation_production_transport_untrusted' });
  await assert.rejects(createInstalledSchemaPreservationV2Session({ ...options, canonicalV5Profile: V4_PROFILE }),
    { code: 'preservation_v5_profile_unpinned' });
  await assert.rejects(createInstalledSchemaPreservationV2Session({ ...options, canonicalV4Profile: V4_PROFILE }),
    { code: 'preservation_session_options_invalid' });
  await assert.rejects(createInstalledSchemaPreservationV2Session({ ...options, selectedApp: 'ops-sync', allowAssetAssociationRotation: true }),
    { code: 'preservation_session_target_invalid' });
  await assert.rejects(createInstalledSchemaPreservationV2Session({ ...options, sourceNamesReader: () => names() }),
    { code: 'preservation_session_options_invalid' }, 'only test sessions may inject source names');
  assert.equal(requests, 1);
});

test('a v2 test session refuses a moving deployment head before any D1 query and never brands production admission', async () => {
  const v5 = readCanonicalInstalledProfileV5();
  let heads = 0, queries = 0;
  const id = '11111111-1111-4111-8111-111111111111';
  const fetchImpl = async input => {
    const url = new URL(input);
    if (url.pathname.includes('/d1/')) { queries++; throw Error('must not query'); }
    let result;
    if (url.pathname.endsWith('/deployments')) result = { deployments: [{ id: ++heads === 2 ? '22222222-2222-4222-8222-222222222222' : id,
      versions: [{ version_id: id, percentage: 100 }] }] };
    else if (url.pathname.endsWith('/versions')) result = { items: [{ id }] };
    else if (url.pathname.endsWith('/settings')) result = {};
    else if (url.pathname.endsWith('/schedules')) result = { schedules: [] };
    else result = { id };
    return Response.json({ success: true, errors: [], result });
  };
  await assert.rejects(createInstalledSchemaPreservationV2TestSession({ sourceCommit: SOURCE_COMMIT, canonicalV5Profile: v5,
    selectedApp: 'client', token: 'x'.repeat(32), allowUnselectedRecapture: false, fetchImpl, sourceNamesReader: () => names(),
    clock: { wallNow: () => Date.now(), monotonicNow: () => performance.now() } }), /changed during metadata capture/u);
  assert.equal(heads, 2); assert.equal(queries, 0);
  assert.equal(isProductionInstalledSchemaPreservationV2Admission({ status: 'preserved-installed-schema-v2', baseSha256: BASE_SHA256 }), false);
});
