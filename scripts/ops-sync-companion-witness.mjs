import { canonical, hash } from './production-deploy.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';

/** Sole-active Operations release witness.
 *
 * #663 (executor 802f74e4) released Operations from a sole 100% version while
 * Ops Sync held an inactive API-uploaded version. That witness hard-coded the
 * #663 versions. This revision takes the same facts as explicit inputs instead:
 *
 * 1. A read-only capture at release time is turned into a reviewed inputs file
 *    (`describeOpsSoleActiveReleaseInputs`).
 * 2. An independent reviewer checks that file against the capture and the
 *    release packet, then approves its exact SHA-256.
 * 3. `createOpsSoleActiveReleaseWitness` accepts only those exact bytes and only
 *    while the supplied live capture still matches them. The executor repeats
 *    the Sync check at every fence and refuses on any difference.
 *
 * The module never relaxes a check by itself: without a witness every caller
 * keeps main's original 0/100 and sole-active rules. The exported names keep the
 * #663 spelling so this revision diffs cleanly against 802f74e4. */

export const OPS_SOLE_ACTIVE_RELEASE_INPUTS_CONTRACT = 'ops-sole-active-release-inputs-v1';
const RECEIPT_CONTRACT = 'ops-sole-active-release-witness-v1';
const WITNESS_TTL_MS = 15 * 60_000;
const MAX_EVIDENCE = 32 * 1024 * 1024;
const MAX_INPUTS = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HEX40 = /^[a-f0-9]{40}$/u;
const HEX64 = /^[a-f0-9]{64}$/u;
const DEPLOYED_FROM = /^[a-z][a-z0-9_-]{0,31}$/u;
const ACTIVE_STATE_KEYS = Object.freeze(['deployment', 'modern', 'schedules', 'settings', 'version']);
const HELD_STATE_KEYS = Object.freeze([...ACTIVE_STATE_KEYS, 'latestModern', 'latestVersion'].sort());
const issued = new WeakMap();

const refuse = reason => { throw Error(`Exact held Ops Sync companion evidence refused: ${reason}`); };
const sha = value => hash(canonical(value));
const sorted = value => [...value].sort();
const sameKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
  && canonical(sorted(Object.keys(value))) === canonical(sorted(keys))
  && Object.keys(value).every(key => Object.getOwnPropertyDescriptor(value, key)?.get === undefined);
const isUuid = value => typeof value === 'string' && UUID.test(value);
const isHex64 = value => typeof value === 'string' && HEX64.test(value);

function exactEvidence(bytes, pin, name) {
  if (!isHex64(pin) || !Buffer.isBuffer(bytes) || bytes.length === 0
    || bytes.length > MAX_EVIDENCE || hash(bytes) !== pin) refuse(`${name} bytes differ from the reviewed inputs`);
}

/** Strictly parse and shape-check reviewed inputs. Returns a frozen copy. */
export function parseOpsSoleActiveReleaseInputs(inputsBytes, reviewedInputsSHA256) {
  if (!Buffer.isBuffer(inputsBytes) || inputsBytes.length === 0 || inputsBytes.length > MAX_INPUTS)
    refuse('inputs must be the reviewed file bytes');
  if (!isHex64(reviewedInputsSHA256) || hash(inputsBytes) !== reviewedInputsSHA256)
    refuse('inputs bytes differ from the independently reviewed SHA-256');
  let inputs;
  try { inputs = JSON.parse(inputsBytes.toString('utf8')); } catch { refuse('inputs are not JSON'); }
  if (!sameKeys(inputs, ['contract', 'accountId', 'sourceCommit', 'operations', 'opsSync'])
    || inputs.contract !== OPS_SOLE_ACTIVE_RELEASE_INPUTS_CONTRACT) refuse('unknown inputs contract or fields');
  if (inputs.accountId !== NATIVE_STAFF_PRODUCTION_TARGET.accountId) refuse('inputs name another account');
  if (typeof inputs.sourceCommit !== 'string' || !HEX40.test(inputs.sourceCommit)) refuse('inputs source commit malformed');
  const ops = inputs.operations;
  if (!sameKeys(ops, ['deploymentId', 'versionId']) || !isUuid(ops.deploymentId) || !isUuid(ops.versionId))
    refuse('Operations inputs malformed');
  const sync = inputs.opsSync;
  if (!sameKeys(sync, ['deploymentId', 'activeVersionId', 'latestVersionId', 'activeLastDeployedFrom',
    'latestLastDeployedFrom', 'stateSHA256', 'held'])
    || !isUuid(sync.deploymentId) || !isUuid(sync.activeVersionId) || !isUuid(sync.latestVersionId)
    || typeof sync.activeLastDeployedFrom !== 'string' || !DEPLOYED_FROM.test(sync.activeLastDeployedFrom))
    refuse('Ops Sync inputs malformed');
  const held = sync.latestVersionId !== sync.activeVersionId;
  if (!sameKeys(sync.stateSHA256, held ? HELD_STATE_KEYS : ACTIVE_STATE_KEYS)
    || !Object.values(sync.stateSHA256).every(isHex64)) refuse('Ops Sync state digests malformed');
  if (held) {
    if (typeof sync.latestLastDeployedFrom !== 'string' || !DEPLOYED_FROM.test(sync.latestLastDeployedFrom)
      || !sameKeys(sync.held, ['journalSHA256', 'immutableMapEvidenceSHA256', 'immutableMapProjectionSHA256'])
      || !Object.values(sync.held).every(isHex64)) refuse('held Ops Sync version needs its reviewed evidence digests');
  } else if (sync.latestLastDeployedFrom !== null || sync.held !== null) {
    refuse('Ops Sync without an inactive latest version must not name held evidence');
  }
  return Object.freeze(structuredClone(inputs));
}

function assertOperations(snapshot, inputs) {
  const ops = snapshot?.operations, id = inputs.operations.versionId;
  const rows = ops?.deployment?.versions;
  if (!Array.isArray(rows) || rows.length !== 1) refuse('live Operations is not a single active version');
  if (rows[0]?.version_id !== id || rows[0]?.percentage !== 100) refuse('live Operations active version differs from inputs');
  if (ops.deployment.id !== inputs.operations.deploymentId) refuse('live Operations deployment differs from inputs');
  if (ops.version?.id !== id || ops.modern?.id !== id || ops.latest !== id)
    refuse('live Operations version, runtime or latest differs from inputs');
}

function assertSync(snapshot, inputs) {
  const state = snapshot?.['ops-sync'], sync = inputs.opsSync;
  const held = sync.latestVersionId !== sync.activeVersionId;
  const expectedKeys = ['latest', ...Object.keys(sync.stateSHA256)];
  if (!state || !sameKeys(state, expectedKeys)) refuse('live Ops Sync capture shape differs from inputs');
  const rows = state.deployment?.versions;
  if (state.deployment?.id !== sync.deploymentId) refuse('live Ops Sync deployment differs from inputs');
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.version_id !== sync.activeVersionId
    || rows[0]?.percentage !== 100) refuse('live Ops Sync active version differs from inputs');
  if (state.version?.id !== sync.activeVersionId || state.modern?.id !== sync.activeVersionId
    || state.latest !== sync.latestVersionId) refuse('live Ops Sync version or latest differs from inputs');
  if (state.version.resources?.script?.last_deployed_from !== sync.activeLastDeployedFrom)
    refuse('live Ops Sync active upload source differs from inputs');
  if (held && (state.latestVersion?.id !== sync.latestVersionId || state.latestModern?.id !== sync.latestVersionId
    || state.latestVersion.resources?.script?.last_deployed_from !== sync.latestLastDeployedFrom))
    refuse('live held Ops Sync version differs from inputs');
  for (const [key, digest] of Object.entries(sync.stateSHA256))
    if (sha(state[key]) !== digest) refuse(`live Ops Sync ${key} differs from inputs`);
}

/** Offline helper: describe a fresh read-only capture as an inputs object for
 * independent review. It authorizes nothing; the reviewer must still compare it
 * with the release packet (for example the expected Operations version). */
export function describeOpsSoleActiveReleaseInputs(snapshot, { sourceCommit, heldJournalBytes,
  immutableMapEvidenceBytes } = {}) {
  const ops = snapshot?.operations, state = snapshot?.['ops-sync'];
  const id = ops?.deployment?.versions?.length === 1 ? ops.deployment.versions[0].version_id : undefined;
  if (!isUuid(id) || ops.deployment.versions[0].percentage !== 100) refuse('capture is not a single active Operations version');
  const syncRows = state?.deployment?.versions;
  if (!Array.isArray(syncRows) || syncRows.length !== 1 || syncRows[0]?.percentage !== 100)
    refuse('capture is not a single active Ops Sync version');
  const held = state.latest !== state.version?.id;
  const keys = held ? HELD_STATE_KEYS : ACTIVE_STATE_KEYS;
  let heldEvidence = null;
  if (held) {
    if (!Buffer.isBuffer(heldJournalBytes) || !Buffer.isBuffer(immutableMapEvidenceBytes))
      refuse('held Ops Sync version needs its journal and immutable map evidence bytes');
    let projection;
    try { projection = JSON.parse(immutableMapEvidenceBytes.toString('utf8')); } catch { refuse('immutable map evidence is not JSON'); }
    heldEvidence = { journalSHA256: hash(heldJournalBytes), immutableMapEvidenceSHA256: hash(immutableMapEvidenceBytes),
      immutableMapProjectionSHA256: sha(projection) };
  }
  return {
    contract: OPS_SOLE_ACTIVE_RELEASE_INPUTS_CONTRACT,
    accountId: NATIVE_STAFF_PRODUCTION_TARGET.accountId,
    sourceCommit,
    operations: { deploymentId: ops.deployment.id, versionId: id },
    opsSync: {
      deploymentId: state.deployment.id,
      activeVersionId: state.version.id,
      latestVersionId: state.latest,
      activeLastDeployedFrom: state.version.resources?.script?.last_deployed_from,
      latestLastDeployedFrom: held ? state.latestVersion?.resources?.script?.last_deployed_from ?? null : null,
      stateSHA256: Object.fromEntries(keys.map(key => [key, sha(state[key])])),
      held: heldEvidence,
    },
  };
}

/** Bytes to write for review: canonical JSON plus a trailing newline. */
export function opsSoleActiveReleaseInputsBytes(inputs) {
  return Buffer.from(`${canonical(inputs)}\n`, 'utf8');
}

export function createOpsSoleActiveReleaseWitness({ accountId, sourceCommit, snapshot, inputsBytes, reviewedInputsSHA256,
  heldJournalBytes, immutableMapEvidenceBytes } = {}) {
  const inputs = parseOpsSoleActiveReleaseInputs(inputsBytes, reviewedInputsSHA256);
  if (accountId !== inputs.accountId || sourceCommit !== inputs.sourceCommit)
    refuse('account or release source differs from inputs');
  const held = inputs.opsSync.held;
  if (held) {
    // Independently reviewed evidence bytes, never a caller acknowledgment.
    exactEvidence(heldJournalBytes, held.journalSHA256, 'held Sync journal');
    exactEvidence(immutableMapEvidenceBytes, held.immutableMapEvidenceSHA256, 'immutable Sync map evidence');
    let projection;
    try { projection = JSON.parse(immutableMapEvidenceBytes.toString('utf8')); } catch { refuse('immutable map evidence is not JSON'); }
    if (projection?.id !== inputs.opsSync.latestVersionId || sha(projection) !== held.immutableMapProjectionSHA256)
      refuse('immutable map evidence does not project to the reviewed held Sync version');
  } else if (heldJournalBytes !== undefined || immutableMapEvidenceBytes !== undefined) {
    refuse('held evidence was supplied for an Ops Sync without a held version');
  }
  assertOperations(snapshot, inputs);
  assertSync(snapshot, inputs);
  const receipt = Object.freeze({ contract: RECEIPT_CONTRACT, sourceCommit, accountId,
    inputsSHA256: reviewedInputsSHA256,
    opsBaselineVersionId: inputs.operations.versionId, opsDeploymentId: inputs.operations.deploymentId,
    syncDeploymentId: inputs.opsSync.deploymentId, syncActiveVersionId: inputs.opsSync.activeVersionId,
    syncHeldVersionId: held ? inputs.opsSync.latestVersionId : null,
    evidenceSHA256: sha({ stateSHA256: inputs.opsSync.stateSHA256, held }) });
  const issuedAt = Date.now();
  if (!Number.isFinite(issuedAt)) refuse('clock unavailable');
  const witness = Object.freeze({});
  issued.set(witness, { receipt, inputs, expiresAt: issuedAt + WITNESS_TTL_MS });
  return witness;
}

function proofOf(witness) {
  const proof = issued.get(witness);
  if (!proof) refuse('witness was not issued from reviewed inputs');
  if (!(Date.now() < proof.expiresAt)) refuse('witness expired; capture and review again');
  return proof;
}

export function heldOpsSyncCompanionReceipt(witness, sourceCommit) {
  const proof = proofOf(witness);
  if (proof.receipt.sourceCommit !== sourceCommit) refuse('witness belongs to another release source');
  return proof.receipt;
}

/** Re-check a fresh capture against the reviewed Sync inputs (every fence). */
export function assertHeldOpsSyncCompanion(witness, snapshot) {
  assertSync(snapshot, proofOf(witness).inputs);
}

/** Re-check the held Sync version's modules and source maps, when there is one. */
export function assertHeldOpsSyncCompanionMap(witness, projection) {
  const { inputs } = proofOf(witness), held = inputs.opsSync.held;
  if (!held) refuse('no held Ops Sync version to compare');
  if (projection?.id !== inputs.opsSync.latestVersionId || sha(projection) !== held.immutableMapProjectionSHA256)
    refuse('live held Ops Sync modules or source maps differ from inputs');
}
