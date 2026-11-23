import { canonical, hash } from './production-deploy.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';

const CONTRACT = 'team-663-held-ops-sync-companion-v1';
const TEAM_SOURCE = '52d5a57d74814c821d8de39854b6a2a86b25ecab';
const OPS_BASELINE = '844a999f-eb29-4a67-9166-5b272893c8a5';
const OPS_DEPLOYMENT = 'c85dd11b-429e-4237-863e-ac1e06bb53e0';
const SYNC_DEPLOYMENT = 'd16949c4-d637-4b9b-8f6d-e21cc303e795';
const SYNC_ACTIVE = '6f8e224c-4202-4904-9de5-b78886b52e74';
const SYNC_LATEST = 'bc65f489-e8dd-4ef8-8411-abca3b3ef464';
const HELD_JOURNAL = '908d9c4d500f4754eb2879deb3669cc48a8d0eaf4a35d39eb4e9d38edd999b1c';
const IMMUTABLE_MAP_EVIDENCE = 'd08b93d2ef15f830dd07dec15055e153ff636f9a51235d785ae7144f6b2d916c';
const IMMUTABLE_MAP_PROJECTION = '813f84d704b3a6fbc7f2cf5db7142326959780089951f807b302407f7bf1903b';
const COMPANION = Object.freeze({
  deployment:'e3321a449696ea892042e87370dd8022e4449195f0ef4ff3e594a49e90a26ff3',
  settings:'0eb83ed621f7b2db8efc1b978e3da439eced9db888c2f3b3ae0f0fe6365beb65',
  schedules:'6649d9ca192b1e8e0f994860d0ff48375b84bcbc954511f8d3fe82a9f94b80d8',
  version:'acfe3a82434228074a49fe0c5dc37338b526bdfe5069b8855d43db65799086f0',
  modern:'a2203112a5c39e7ca47569fbd375a74ac8286966f218e29bd7d73578806a1970',
  latestVersion:'0f44b987e51fd532f50f61438a5e1dd265dcbc4c1b29429418b3993569871309',
  latestModern:'0992bc30b931bad81642c0b24584c5dcb269880e8254c19fae16acb1d12b6a7e',
});
const issued = new WeakMap();
const refuse = () => { throw Error('Exact held Ops Sync companion evidence refused'); };
const MAX_EVIDENCE = 32 * 1024 * 1024;

function exactEvidence(bytes, pin) {
  if (typeof pin !== 'string' || !Buffer.isBuffer(bytes) || bytes.length === 0
    || bytes.length > MAX_EVIDENCE || hash(bytes) !== pin) refuse();
}

function assertCompanion(snapshot) {
  const state = snapshot?.['ops-sync'];
  if (!state || Object.keys(state).length !== Object.keys(COMPANION).length + 1
    || state.deployment?.id !== SYNC_DEPLOYMENT || state.deployment.versions?.length !== 1
    || state.deployment.versions[0]?.version_id !== SYNC_ACTIVE || state.deployment.versions[0]?.percentage !== 100
    || state.version?.id !== SYNC_ACTIVE || state.modern?.id !== SYNC_ACTIVE || state.latest !== SYNC_LATEST
    || state.latestVersion?.id !== SYNC_LATEST || state.latestModern?.id !== SYNC_LATEST
    || state.version.resources?.script?.last_deployed_from !== 'wrangler'
    || state.latestVersion.resources?.script?.last_deployed_from !== 'api'
    || Object.entries(COMPANION).some(([key, digest]) => !Object.hasOwn(state,key)
      || hash(canonical(state[key])) !== digest)) refuse();
}

export function createHeldOpsSyncCompanionWitness({ accountId, sourceCommit, snapshot, heldJournalBytes,
  immutableMapEvidenceBytes } = {}) {
  // These are independently reviewed exact evidence bytes, never a generic
  // acknowledgment supplied by a caller or a way to rewrite metadata.
  exactEvidence(heldJournalBytes, HELD_JOURNAL);
  exactEvidence(immutableMapEvidenceBytes, IMMUTABLE_MAP_EVIDENCE);
  if (accountId !== NATIVE_STAFF_PRODUCTION_TARGET.accountId || sourceCommit !== TEAM_SOURCE) refuse();
  const ops = snapshot?.operations;
  if (ops?.version?.id !== OPS_BASELINE || ops.modern?.id !== OPS_BASELINE
    || ops.deployment?.id !== OPS_DEPLOYMENT) refuse();
  assertCompanion(snapshot);
  const receipt = Object.freeze({ contract:CONTRACT, sourceCommit, accountId, opsBaselineVersionId:OPS_BASELINE,
    opsDeploymentId:OPS_DEPLOYMENT,
    syncDeploymentId:SYNC_DEPLOYMENT, syncActiveVersionId:SYNC_ACTIVE, syncHeldVersionId:SYNC_LATEST,
    evidenceSHA256:hash(canonical({COMPANION,HELD_JOURNAL,IMMUTABLE_MAP_EVIDENCE,IMMUTABLE_MAP_PROJECTION})) });
  const witness = Object.freeze({});
  issued.set(witness, {receipt, expiresAt:Date.now() + 15 * 60_000});
  return witness;
}

export function heldOpsSyncCompanionReceipt(witness, sourceCommit) {
  const proof = issued.get(witness);
  if (!proof || proof.receipt.sourceCommit !== sourceCommit || Date.now() >= proof.expiresAt) refuse();
  return proof.receipt;
}

export function assertHeldOpsSyncCompanion(witness, snapshot) {
  heldOpsSyncCompanionReceipt(witness, TEAM_SOURCE);
  assertCompanion(snapshot);
}

export function assertHeldOpsSyncCompanionMap(witness, projection) {
  heldOpsSyncCompanionReceipt(witness, TEAM_SOURCE);
  if (projection?.id !== SYNC_LATEST || hash(canonical(projection)) !== IMMUTABLE_MAP_PROJECTION) refuse();
}
