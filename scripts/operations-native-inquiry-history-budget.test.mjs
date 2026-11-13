import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { listOpsPrincipalInquiries } from '../apps/operations/src/worker/operations-native-principal-inquiries.ts';

const PROOF_KEYS = ['targetId','targetRevision','clientAuthorityId','workspaceId','targetClientRecordId','recipientBindingId',
  'issuer','subject','baseOperationId','ownershipEpoch','grantRevision','capabilityOperationId','capabilityRevision',
  'publicationOperationId','publicationRevision','publicationSourceSequence','publicationSnapshotId','publicationSnapshotSha256','expiresAt'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const uuid = value => `00000000-0000-4000-8000-${String(value).padStart(12,'0')}`;

function proof(index = 1, overrides = {}) {
  return { targetId: uuid(index), targetRevision: 1, clientAuthorityId: uuid(100 + index), workspaceId: `workspace-${index}`,
    targetClientRecordId: `client-record-${index}`, recipientBindingId: uuid(200 + index), issuer: 'issuer.example', subject: 'subject-1',
    baseOperationId: uuid(300 + index), ownershipEpoch: 1, grantRevision: 1, capabilityOperationId: uuid(400 + index), capabilityRevision: 1,
    publicationOperationId: uuid(500 + index), publicationRevision: 1, publicationSourceSequence: 1,
    publicationSnapshotId: uuid(600 + index), publicationSnapshotSha256: 'a'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z', ...overrides };
}
function canonicalProofs(proofs) {
  return [...proofs].map(value => Object.fromEntries(PROOF_KEYS.map(key => [key, value[key]])))
    .sort((a, b) => a.targetId.localeCompare(b.targetId) || a.recipientBindingId.localeCompare(b.recipientBindingId));
}
function storedRow(index, proofs, overrides = {}) {
  const json = JSON.stringify(canonicalProofs(proofs));
  return { inquiry_id: uuid(800 + index), kind: 'website', title: `Request ${index}`, details: 'Please contact me.', location: null,
    status: 'received', created_at: '2026-11-12T12:00:00.000Z', authority_set_json: json, authority_set_sha256: sha256(json), ...overrides };
}
function harness({ rows = [], onCurrent, onList } = {}) {
  const queries = [];
  let currentReads = 0, listReads = 0;
  const database = {
    withSession(kind) { assert.equal(kind, 'first-primary'); return this; },
    prepare(sql) {
      queries.push(sql);
      return { bind(...values) { return {
        async first() { currentReads++; return onCurrent ? await onCurrent(currentReads, values) : 1; },
        async all() { listReads++; return { results: onList ? await onList(listReads, values) : rows }; },
      }; } };
    },
  };
  return { env: { OPS_DB: database, CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED: 'true' }, queries,
    get currentReads() { return currentReads; }, get listReads() { return listReads; } };
}
const request = proofs => JSON.stringify({ protocolVersion: 1, proofs });
const list = async (state, proofs) => JSON.parse(await listOpsPrincipalInquiries(state.env, request(proofs)));

test('lists 50 histories with 20 current proofs in 41 D1 reads', async () => {
  const proofs = Array.from({ length: 20 }, (_, i) => proof(i + 1));
  const rows = Array.from({ length: 50 }, (_, i) => storedRow(i + 1, [proofs[i % proofs.length]]));
  const state = harness({ rows });
  const result = await list(state, proofs);
  assert.equal(result.ok, true);
  assert.equal(result.inquiries.length, 50);
  assert.equal(state.currentReads, 40, 'the supplied 20-proof set is checked before and after listing');
  assert.equal(state.listReads, 1);
  assert.equal(state.queries.length, 41, 'no row triggers another SQL authority check');
});

test('preserves legitimate stored subsets and rejects same-key proof pin drift', async () => {
  const active = proof();
  const changes = [
    ['targetRevision', value => value + 1], ['clientAuthorityId', () => uuid(901)], ['workspaceId', () => 'workspace-replaced'],
    ['targetClientRecordId', () => 'client-record-replaced'], ['issuer', () => 'other-issuer'], ['subject', () => 'other-subject'],
    ['baseOperationId', () => uuid(902)], ['ownershipEpoch', value => value + 1], ['grantRevision', value => value + 1],
    ['capabilityOperationId', () => uuid(903)], ['capabilityRevision', value => value + 1],
    ['publicationOperationId', () => uuid(904)], ['publicationRevision', value => value + 1],
    ['publicationSourceSequence', value => value + 1], ['publicationSnapshotId', () => uuid(905)],
    ['publicationSnapshotSha256', () => 'b'.repeat(64)], ['expiresAt', () => '2098-01-01T00:00:00.000Z'],
  ];
  const rows = [storedRow(1, [active]), ...changes.map(([key, change], i) =>
    storedRow(i + 2, [{ ...active, [key]: change(active[key]) }]))];
  const state = harness({ rows });
  const result = await list(state, [active]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.inquiries.map(row => row.id), [uuid(801)], 'a row may be authorized by any exact subset of supplied proofs');
});

test('rejects bad hashes, noncanonical JSON, duplicates and invalid stored proofs', async () => {
  const active = proof();
  const wrongHash = storedRow(2, [active], { authority_set_sha256: '0'.repeat(64) });
  const reversed = Object.fromEntries(Object.entries(active).reverse());
  const noncanonicalJson = JSON.stringify([reversed]);
  const noncanonical = storedRow(3, [active], { authority_set_json: noncanonicalJson, authority_set_sha256: sha256(noncanonicalJson) });
  const duplicate = storedRow(4, [active, active]);
  const invalid = storedRow(5, [{ ...active, capabilityRevision: 2 }]);
  const state = harness({ rows: [wrongHash, noncanonical, duplicate, invalid] });
  const result = await list(state, [active]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.inquiries, []);
  assert.equal(state.queries.length, 3, 'invalid rows are filtered locally between the two bounded authority reads');
});

test('final current read fences revocation of a supplied proof absent from the stored subset', async () => {
  const supplied = [proof(1), proof(2)];
  const state = harness({ rows: [storedRow(1, [supplied[0]])], onCurrent: read => read < 4 ? 1 : 0 });
  const result = await list(state, supplied);
  assert.deepEqual(result, { ok: false, code: 'unavailable' });
  assert.equal(state.currentReads, 4, 'both supplied proofs are rechecked after reading, including the proof absent from the row');
  assert.equal(state.listReads, 1);
});

test('final current read fences expiry that occurs after history was read', async () => {
  const actualNow = Date.now;
  let now = Date.parse('2026-11-12T12:00:00.000Z');
  Date.now = () => now;
  try {
    const active = proof(1, { expiresAt: '2026-11-12T12:00:01.000Z' });
    const state = harness({ rows: [storedRow(1, [active])], onList: () => {
      now = Date.parse('2026-11-12T12:00:02.000Z'); return [storedRow(1, [active])];
    } });
    const result = await list(state, [active]);
    assert.deepEqual(result, { ok: false, code: 'unavailable' });
    assert.equal(state.currentReads, 1, 'expired proofs fail closed before a final SQL check');
    assert.equal(state.listReads, 1);
  } finally { Date.now = actualNow; }
});

test('separate requests re-read current authority and history without cross-request caching', async () => {
  const active = proof();
  let rows = [storedRow(1, [active])];
  const state = harness({ onList: () => rows });
  const first = await list(state, [active]);
  rows = [];
  const second = await list(state, [active]);
  assert.equal(first.inquiries.length, 1);
  assert.deepEqual(second.inquiries, []);
  assert.equal(state.listReads, 2);
  assert.equal(state.currentReads, 4);
  assert.equal(state.queries.length, 6);
});
