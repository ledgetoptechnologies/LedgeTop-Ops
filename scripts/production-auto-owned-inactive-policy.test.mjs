import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  OWNED_INACTIVE_CLIENT_POLICY, ownedInactivePolicySHA256,
  verifyPinnedOwnedInactiveCustody, isVerifiedPinnedOwnedInactiveCustody,
} from './production-auto-owned-inactive-policy.mjs';
import { canonical } from './production-deploy.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-fixtures/owned-inactive-client-held-20261112.json'), 'utf8'));
const REFUSAL = { message: 'owned_inactive_custody_refused' };

function input() {
  const journalBytes = Buffer.from(canonical(fixture) + '\n', 'utf8');
  return {
    journalHead: OWNED_INACTIVE_CLIENT_POLICY.journalHead,
    journalBytes,
    artifact: {
      id: OWNED_INACTIVE_CLIENT_POLICY.artifactId,
      name: OWNED_INACTIVE_CLIENT_POLICY.artifactName,
      expired: false,
      digest: `sha256:${OWNED_INACTIVE_CLIENT_POLICY.artifactSha256}`,
      size_in_bytes: OWNED_INACTIVE_CLIENT_POLICY.artifactSize,
      workflow_run: { id: OWNED_INACTIVE_CLIENT_POLICY.oldReleaseRunId, head_branch: 'main' },
    },
    run: {
      id: OWNED_INACTIVE_CLIENT_POLICY.oldReleaseRunId,
      path: OWNED_INACTIVE_CLIENT_POLICY.workflowPath,
      run_attempt: 1,
      event: 'workflow_run',
      head_branch: 'main',
      head_sha: OWNED_INACTIVE_CLIENT_POLICY.oldSourceCommit,
      status: 'completed',
      conclusion: 'failure',
    },
    jobs: {
      total_count: 3,
      jobs: [
        { name: 'release-client', conclusion: 'failure', steps: [
          { name: OWNED_INACTIVE_CLIENT_POLICY.clientReleaseStep, conclusion: 'failure' },
          { name: OWNED_INACTIVE_CLIENT_POLICY.artifactUploadStep, conclusion: 'success' },
          { name: OWNED_INACTIVE_CLIENT_POLICY.artifactBindStep, conclusion: 'success' },
        ] },
        { name: 'release-operations', conclusion: 'skipped', steps: [] },
        { name: 'release-sync', conclusion: 'skipped', steps: [] },
      ],
    },
  };
}

function reserializeJournal(value) {
  return Buffer.from(canonical(value) + '\n', 'utf8');
}

test('policy is deeply frozen and hashes deterministically', () => {
  assert.equal(Object.isFrozen(OWNED_INACTIVE_CLIENT_POLICY), true);
  assert.equal(Object.isFrozen(OWNED_INACTIVE_CLIENT_POLICY.intentPhases), true);
  assert.equal(Object.isFrozen(OWNED_INACTIVE_CLIENT_POLICY.intentMethods), true);
  assert.equal(ownedInactivePolicySHA256(), ownedInactivePolicySHA256());
  assert.throws(() => { OWNED_INACTIVE_CLIENT_POLICY.unknown = true; }, TypeError);
  assert.throws(() => { OWNED_INACTIVE_CLIENT_POLICY.intentPhases.push('activate-candidate'); }, TypeError);
});

test('pinned journal, ACKs, artifact and failed main-run job yield a branded custody-only receipt', () => {
  const value = input();
  const receipt = verifyPinnedOwnedInactiveCustody(value);
  assert.deepEqual(Object.keys(receipt).sort(), [
    'artifactDigestSha256', 'journalDocumentSHA256', 'journalHead', 'operationSHA256', 'parentVersionId',
    'policySHA256', 'priorCandidateVersionId', 'schemaVersion',
  ].sort());
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.policySHA256, ownedInactivePolicySHA256());
  assert.equal(receipt.journalHead, OWNED_INACTIVE_CLIENT_POLICY.journalHead);
  assert.equal(receipt.journalDocumentSHA256, OWNED_INACTIVE_CLIENT_POLICY.journalDocumentSha256);
  assert.equal(receipt.operationSHA256, OWNED_INACTIVE_CLIENT_POLICY.oldOperationSha256);
  assert.equal(receipt.artifactDigestSha256, OWNED_INACTIVE_CLIENT_POLICY.artifactSha256);
  assert.equal(receipt.priorCandidateVersionId, OWNED_INACTIVE_CLIENT_POLICY.priorInactiveCandidateVersionId);
  assert.equal(receipt.parentVersionId, OWNED_INACTIVE_CLIENT_POLICY.parentVersionId);
  assert.equal(isVerifiedPinnedOwnedInactiveCustody(receipt), true);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(isVerifiedPinnedOwnedInactiveCustody({ ...receipt }), false);
  assert.equal(isVerifiedPinnedOwnedInactiveCustody(JSON.parse(JSON.stringify(receipt))), false);
});

test('arguments, journal head, canonical bytes, and byte bounds fail closed', () => {
  const unknown = input(); unknown.unknownPolicyKey = true;
  assert.throws(() => verifyPinnedOwnedInactiveCustody(unknown), REFUSAL);
  for (const change of [
    value => { value.journalHead = 'a'.repeat(40); },
    value => { value.journalBytes = Buffer.from('{}\n'); },
    value => { value.journalBytes = Buffer.concat([value.journalBytes, Buffer.from(' ') ]); },
    value => { value.journalBytes = Buffer.alloc(OWNED_INACTIVE_CLIENT_POLICY.maxJournalBytes + 1); },
    value => { value.journalBytes = new Uint8Array(value.journalBytes); },
  ]) {
    const value = input(); change(value);
    assert.throws(() => verifyPinnedOwnedInactiveCustody(value), REFUSAL);
  }
});

test('whole-document and selected-operation pins reject altered or unknown journal fields', () => {
  for (const mutate of [
    doc => { doc.operations.find(row => row.releaseId === OWNED_INACTIVE_CLIENT_POLICY.oldReleaseId).sourceCommit = 'b'.repeat(40); },
    doc => { doc.operations.find(row => row.releaseId === OWNED_INACTIVE_CLIENT_POLICY.oldReleaseId).unknownPolicyKey = true; },
    doc => { doc.operations.find(row => row.releaseId === OWNED_INACTIVE_CLIENT_POLICY.oldReleaseId).intents[0].phase = 'activate-candidate'; },
    doc => { doc.operations.find(row => row.releaseId === OWNED_INACTIVE_CLIENT_POLICY.oldReleaseId).responses[0].providerAcknowledged = false; },
    doc => { doc.operations.find(row => row.releaseId === OWNED_INACTIVE_CLIENT_POLICY.oldReleaseId).responses[0].errorCodes.push('unexpected'); },
    doc => { doc.sequence++; },
    doc => { doc.operations.push(structuredClone(doc.operations[0])); },
  ]) {
    const value = input(), document = JSON.parse(value.journalBytes.toString('utf8'));
    mutate(document); value.journalBytes = reserializeJournal(document);
    assert.throws(() => verifyPinnedOwnedInactiveCustody(value), REFUSAL);
  }
});

test('artifact metadata and run identity are all pinned independently', () => {
  const artifactFields = [
    ['id', 13994393519], ['name', 'production-auto-other'], ['expired', true],
    ['digest', `sha256:${'0'.repeat(64)}`], ['size_in_bytes', 47974],
  ];
  for (const [key, replacement] of artifactFields) {
    const value = input(); value.artifact[key] = replacement;
    assert.throws(() => verifyPinnedOwnedInactiveCustody(value), REFUSAL);
  }
  {
    const value = input();
    delete value.artifact.size_in_bytes;
    value.artifact.size = OWNED_INACTIVE_CLIENT_POLICY.artifactSize;
    assert.throws(() => verifyPinnedOwnedInactiveCustody(value), REFUSAL,
      'the noncanonical size field must not substitute for size_in_bytes');
  }
  for (const mutate of [
    value => { value.artifact.workflow_run.id++; },
    value => { value.artifact.workflow_run.head_branch = 'feature'; },
    value => { value.run.id++; },
    value => { value.run.path = '.github/workflows/other.yml'; },
    value => { value.run.run_attempt++; },
    value => { value.run.event = 'push'; },
    value => { value.run.head_branch = 'feature'; },
    value => { value.run.head_sha = 'b'.repeat(40); },
    value => { value.run.status = 'in_progress'; },
    value => { value.run.conclusion = 'success'; },
  ]) {
    const value = input(); mutate(value);
    assert.throws(() => verifyPinnedOwnedInactiveCustody(value), REFUSAL);
  }
});

test('job roster, exact Client steps, and skipped non-Client jobs are pinned', () => {
  for (const mutate of [
    value => { value.jobs.jobs[0].name = 'release-ops-sync'; },
    value => { value.jobs.jobs.push(structuredClone(value.jobs.jobs[0])); },
    value => { value.jobs.total_count = 4; },
    value => { value.jobs.jobs[0].steps[0].conclusion = 'success'; },
    value => { value.jobs.jobs[0].steps[1].conclusion = 'failure'; },
    value => { value.jobs.jobs[0].steps[2].name = 'different bind step'; },
    value => { value.jobs.jobs[0].steps.push(structuredClone(value.jobs.jobs[0].steps[0])); },
    value => { value.jobs.jobs[1].conclusion = 'success'; },
    value => { value.jobs.jobs[2].conclusion = 'failure'; },
    value => { value.jobs.jobs[0].steps = Array.from({ length: 129 }, (_, i) => ({ name: `step-${i}`, conclusion: 'success' })); },
  ]) {
    const value = input(); mutate(value);
    assert.throws(() => verifyPinnedOwnedInactiveCustody(value), REFUSAL);
  }
});
