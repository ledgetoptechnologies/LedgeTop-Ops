import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { collectProductionMigrationEvidence, PRODUCTION_MIGRATION_TARGET,
  readProductionMigrationReadiness as readStrictProductionMigrationReadiness,
  validateProductionMigrationReadiness } from './production-auto-migration-readiness.mjs';
import { evaluateApprovedAppendOnlyLedger, expectedApprovedAppendOnlyClassification,
  RECONCILIATION_MANIFEST_SHA256, APPEND_PLAN_SHA256 } from './production-auto-migration-profile/append-only-inventory-gate.mjs';

export { PRODUCTION_MIGRATION_TARGET, validateProductionMigrationReadiness };

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keysExact(value, names) {
  return isRecord(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
}
function safeDate(value) {
  const time = Date.parse(value);
  if (typeof value !== 'string' || !Number.isFinite(time) || new Date(time).toISOString() !== value) fail('readiness_timestamp_invalid');
  return time;
}

export function loadPinnedAppendOnlyMigrationProfile() {
  const canonicalReviewedBytes = (file) => restoreReviewedAppendOnlyProfileBytes(readFileSync(file));
  return Object.freeze({
    reconciliationManifestBytes: canonicalReviewedBytes(new URL('./production-auto-migration-profile/reconciliation-manifest.json', import.meta.url)),
    appendPlanBytes: canonicalReviewedBytes(new URL('./production-auto-migration-profile/append-plan.json', import.meta.url)),
  });
}

export function restoreReviewedAppendOnlyProfileBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > 512 * 1024) fail('append_profile_unapproved');
  return Buffer.from(bytes.toString('utf8').replace(/\r?\n/g, '\r\n'), 'utf8');
}

function validateAppendOnlyProfile(profile, sourceCommit) {
  if (!keysExact(profile, ['reconciliationManifestBytes', 'appendPlanBytes']) ||
      !Buffer.isBuffer(profile.reconciliationManifestBytes) || !Buffer.isBuffer(profile.appendPlanBytes) ||
      !COMMIT.test(sourceCommit ?? '') ||
      hash(profile.reconciliationManifestBytes) !== RECONCILIATION_MANIFEST_SHA256 ||
      hash(profile.appendPlanBytes) !== APPEND_PLAN_SHA256) fail('append_profile_unapproved');
  return Object.freeze({
    reconciliationManifestBytes: Buffer.from(profile.reconciliationManifestBytes),
    appendPlanBytes: Buffer.from(profile.appendPlanBytes),
  });
}

export function validateAppendOnlyMigrationReadiness(value, { sourceCommit, now = Date.now(), appendOnlyProfile } = {}) {
  const checkedProfile = validateAppendOnlyProfile(appendOnlyProfile, sourceCommit);
  const keys = ['schemaVersion', 'purpose', 'sourceCommit', 'accountId', 'observedAt', 'status',
    'migrationRequired', 'databases', 'applicationSchemaReady', 'executesDdl', 'authorizesFeatureActivation'];
  if (!keysExact(value, keys) || value.schemaVersion !== 2 ||
      value.purpose !== 'append-only-migration-inventory-classification' || value.sourceCommit !== sourceCommit ||
      !COMMIT.test(sourceCommit ?? '') || value.accountId !== PRODUCTION_MIGRATION_TARGET.accountId ||
      !['migration-required', 'inventory-current-schema-check-required'].includes(value.status) ||
      typeof value.migrationRequired !== 'boolean' || !Array.isArray(value.databases) || value.databases.length !== 2 ||
      value.applicationSchemaReady !== false || value.executesDdl !== false || value.authorizesFeatureActivation !== false ||
      !Number.isFinite(now)) fail('append_readiness_invalid');
  const observed = safeDate(value.observedAt);
  if (observed > now || now - observed > 60_000) fail('append_readiness_stale');
  let needsMigration = false;
  for (let i = 0; i < 2; i++) {
    const db = PRODUCTION_MIGRATION_TARGET.databases[i], row = value.databases[i];
    if (!keysExact(row, ['schemaVersion', 'purpose', 'sourceCommit', 'app', 'databaseId', 'status',
      'sourceMigrationCount', 'sourceInventorySha256', 'installedRowCount', 'installedRowsSha256',
      'historicalRowsPreserved', 'appendEnvelope', 'applicationSchemaReady', 'executesDdl', 'authorizesFeatureActivation']) ||
      row.schemaVersion !== 1 || row.purpose !== 'append-only-migration-inventory-gate-candidate' ||
      row.sourceCommit !== sourceCommit || row.app !== db.name || row.databaseId !== db.databaseId ||
      !['preserved-base-awaiting-entire-approved-append', 'fully-appended-source-inventory'].includes(row.status) ||
      !Number.isSafeInteger(row.sourceMigrationCount) || !Number.isSafeInteger(row.installedRowCount) ||
      !SHA256.test(row.sourceInventorySha256 ?? '') || !SHA256.test(row.installedRowsSha256 ?? '') ||
      !Array.isArray(row.historicalRowsPreserved) || !Array.isArray(row.appendEnvelope) ||
      row.applicationSchemaReady !== false || row.executesDdl !== false || row.authorizesFeatureActivation !== false) {
      fail('append_readiness_database_invalid');
    }
    const expected = expectedApprovedAppendOnlyClassification({
      ...checkedProfile, sourceCommit, app: db.name, status: row.status,
    });
    if (JSON.stringify(row) !== JSON.stringify(expected)) fail('append_readiness_database_profile_mismatch');
    needsMigration ||= row.status === 'preserved-base-awaiting-entire-approved-append';
  }
  if (value.migrationRequired !== needsMigration || value.status !== (needsMigration
    ? 'migration-required' : 'inventory-current-schema-check-required')) fail('append_readiness_state_mismatch');
  return structuredClone(value);
}

export async function readProductionMigrationReadiness({
  sourceCommit, root, token, env = process.env, fetchImpl = globalThis.fetch,
  now = () => new Date(), monotonicNow = () => performance.now(), appendOnlyProfile,
} = {}) {
  if (appendOnlyProfile === undefined) {
    return readStrictProductionMigrationReadiness({ sourceCommit, root, token, env, fetchImpl, now, monotonicNow });
  }
  const checkedProfile = validateAppendOnlyProfile(appendOnlyProfile, sourceCommit);
  const evidence = await collectProductionMigrationEvidence({ sourceCommit, root, token, env, fetchImpl, now, monotonicNow }, {
    processLedgerEvidence: ({ databaseId, inventory, ledgerRows, statementMeta }, index) => evaluateApprovedAppendOnlyLedger({
      ...checkedProfile,
      sourceCommit,
      app: PRODUCTION_MIGRATION_TARGET.databases[index].name,
      databaseId,
      sourceRows: inventory.sourceRows,
      sourceFiles: inventory.sourceFiles,
      localMigrationNames: inventory.names,
      ledgerRows,
      statementMeta,
    }),
  });
  const databases = evidence.databases.map(({ classification }) => classification);
  const migrationRequired = databases.some((row) => row.status === 'preserved-base-awaiting-entire-approved-append');
  const endWall = Date.parse(evidence.observedAt);
  return validateAppendOnlyMigrationReadiness({
    schemaVersion: 2,
    purpose: 'append-only-migration-inventory-classification',
    sourceCommit,
    accountId: evidence.accountId,
    observedAt: evidence.observedAt,
    status: migrationRequired ? 'migration-required' : 'inventory-current-schema-check-required',
    migrationRequired,
    databases,
    applicationSchemaReady: false,
    executesDdl: false,
    authorizesFeatureActivation: false,
  }, { sourceCommit, now: endWall, appendOnlyProfile: checkedProfile });
}
