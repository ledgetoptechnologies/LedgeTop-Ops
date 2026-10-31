// Fixed-target, one-file production Client D1 migration operator.
// The imported targeted packet compiler remains held and non-authorizing;
// this separate operator requires an explicit reviewed packet hash to execute.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { compileClient0242Packet, ACCOUNT_ID, DATABASE_ID, MIGRATION_NAME,
  MIGRATION_SHA256, MIGRATION_BLOB_OID, TARGET_LEDGER_ID, SOURCE_PENDING,
  REMAINING_PENDING } from './production-auto-migration-profile/client-0242-targeted-v1/packet.mjs';
import { SOURCE_COMMIT } from './production-auto-migration-profile/source38-inventory-v2/gate.mjs';

export const TARGET = Object.freeze({ accountId: ACCOUNT_ID, databaseId: DATABASE_ID,
  workerName: 'ledgetop-clients', environment: 'production', binding: 'DELIVERY_DB' });
export const PROFILE = 'production-client-0242-one-shot-v1';
export const BASE_LEDGER_COUNT = 158;
export const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(ROOT, 'apps/client/migrations');
const PROFILE_DIR = path.join(ROOT, 'scripts/production-auto-migration-profile/source38-inventory-v2');
const ARTIFACT_DIR = 'C:/Users/fstor/.codex/artifacts/client-production-0242-once-20261031';
const OWNER_ADAPTER = 'C:/Users/fstor/.codex/artifacts/ops-cloudflare-oauth-refresh-adapter-v3-20261028/adapter.mjs';
const OWNER_ADAPTER_SHA256 = '0ecaff11d5faddaf66c6121546915438af58c3bc2c01c7ee4a896c3895a3b6e7';
const SHA256 = /^[0-9a-f]{64}$/u;
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value);
const need = (condition, code) => { if (!condition) throw new Error(code); };

export const READ_SQL = Object.freeze([
  'SELECT id,name FROM d1_migrations ORDER BY id',
  "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name",
  "PRAGMA table_info('portal_v2_identities')",
]);
export const EMPTY_TARGET_SQL = 'SELECT (SELECT COUNT(*) FROM client_ops_triage_inquiries) AS inquiries,(SELECT COUNT(*) FROM client_ops_triage_notification_outbox) AS outbox';
export function snapshotStateSha256(snapshot) {
  return hash(Buffer.from(canonical({ schemaVersion: snapshot.schemaVersion, accountId: snapshot.accountId,
    databaseId: snapshot.databaseId, metadataOnly: snapshot.metadataOnly, ledger: snapshot.ledger,
    schema: snapshot.schema, parent: snapshot.parent })));
}

export function selectProductionClientBindings(settings) {
  need(settings && typeof settings === 'object' && Array.isArray(settings.bindings), 'client_settings_shape_invalid');
  const env = settings.bindings.filter(row => row?.name === 'ENVIRONMENT' && row?.type === 'plain_text');
  const db = settings.bindings.filter(row => row?.name === TARGET.binding && row?.type === 'd1');
  const allD1 = settings.bindings.filter(row => row?.type === 'd1');
  need(env.length === 1 && env[0].text === 'production', 'client_worker_not_production');
  need(db.length === 1 && db[0].id === TARGET.databaseId && allD1.length === 1,
    'client_database_binding_mismatch');
  return Object.freeze({ environment: env[0].text, worker: TARGET.workerName,
    binding: TARGET.binding, databaseId: db[0].id });
}

function verifyQueryResult(value, count) {
  need(Array.isArray(value) && value.length === count, 'd1_query_result_shape_invalid');
  for (const row of value) need(row?.success === true && Array.isArray(row.results)
    && row.meta?.rows_written === 0 && row.meta?.changed_db === false,
  'd1_read_only_metadata_contract_failed');
  return value;
}

export function makeMetadataSnapshot(accountId, databaseId, result, observedAt = new Date().toISOString()) {
  need(accountId === TARGET.accountId && databaseId === TARGET.databaseId, 'd1_target_identity_mismatch');
  verifyQueryResult(result, READ_SQL.length);
  const ledger = result[0].results.map(row => ({ id: row.id, name: row.name }));
  const schema = result[1].results.map(row => ({ type: row.type, name: row.name,
    tbl_name: row.tbl_name, sql: row.sql }));
  const parent = result[2].results.map(row => ({ cid: row.cid, name: row.name,
    type: row.type, notnull: row.notnull, dflt_value: row.dflt_value, pk: row.pk }));
  return { schemaVersion: 1, observedAt, accountId, databaseId, metadataOnly: true, ledger, schema, parent };
}

export function assertTargetDatabase(info) {
  need(info && info.uuid === TARGET.databaseId && info.name === 'client-data', 'd1_metadata_identity_mismatch');
  return true;
}

function sourceInputs(snapshot, statementMeta, runId) {
  const manifestBytes = fs.readFileSync(path.join(PROFILE_DIR, 'reconciliation-manifest.json'));
  const appendPlanBytes = fs.readFileSync(path.join(PROFILE_DIR, 'append-plan.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const names = fs.readdirSync(MIGRATIONS).filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort();
  const sourceFiles = names.map(name => ({ name, bytes: fs.readFileSync(path.join(MIGRATIONS, name)) }));
  const migrationSql = sourceFiles.find(row => row.name === MIGRATION_NAME)?.bytes;
  need(manifest.source?.commit === SOURCE_COMMIT && migrationSql && hash(migrationSql) === MIGRATION_SHA256,
    'pinned_client_source_missing_or_changed');
  const packet = compileClient0242Packet({ manifestBytes, appendPlanBytes, sourceCommit: SOURCE_COMMIT,
    databaseId: TARGET.databaseId, sourceRows: manifest.databases.client.sourceMigrations,
    sourceFiles, localMigrationNames: names, ledgerRows: manifest.databases.client.orderedRows,
    statementMeta, schemaSnapshot: snapshot,
    migrationSql, runId });
  // This must stay a held review candidate. The executor's separate CLI/hash
  // gate does not change the packet's authority fields.
  need(packet.held === true && packet.authorizesMigration === false
    && packet.authorizesFeatureActivation === false && packet.applicationReady === false
    && packet.requestBody && packet.requestBody.batch.length === 9
    && packet.target?.accountId === TARGET.accountId && packet.target?.databaseId === TARGET.databaseId
    && packet.selected === MIGRATION_NAME && packet.batchStatementCount === 9
    && canonical(packet.remainsPending) === canonical(REMAINING_PENDING)
    && canonical(packet.sourcePending) === canonical(SOURCE_PENDING), 'held_packet_scope_changed');
  need(packet.source.migration.gitBlobOid === MIGRATION_BLOB_OID
    && packet.source.migration.sha256 === MIGRATION_SHA256
    && packet.source.migration.ledgerId === TARGET_LEDGER_ID, 'migration_source_pin_mismatch');
  return packet;
}

function verifyPreSnapshot(snapshot) {
  need(snapshot?.schemaVersion === 1 && snapshot.accountId === TARGET.accountId
    && snapshot.databaseId === TARGET.databaseId && snapshot.metadataOnly === true,
  'production_metadata_snapshot_invalid');
  need(snapshot.ledger.length === BASE_LEDGER_COUNT, 'production_ledger_baseline_changed');
  need(!snapshot.schema.some(row => ['client_ops_triage_inquiries', 'idx_client_ops_triage_inquiries_queue',
    'idx_client_ops_triage_inquiries_identity', 'client_ops_triage_notification_outbox',
    'idx_client_ops_triage_outbox_ready'].includes(row.name)), 'target_0242_objects_already_present');
  return true;
}

function targetSqlRows(packet) {
  const sql = packet.requestBody.batch.slice(3, 8).map(row => row.sql);
  need(sql.length === 5 && sql.every(statement => /^CREATE\s+(?:TABLE|INDEX)\b/iu.test(statement)),
    'target_migration_statement_set_invalid');
  return sql;
}

export function verifyPostSnapshot(before, after, packet) {
  const originalLedger = before.ledger;
  const expectedLedger = [...originalLedger, { id: TARGET_LEDGER_ID, name: MIGRATION_NAME }];
  need(canonical(after.ledger) === canonical(expectedLedger), 'post_ledger_not_exact');
  need(canonical(after.parent) === canonical(before.parent), 'post_parent_identity_changed');
  const beforeByName = new Map(before.schema.map(row => [row.name, row]));
  const added = after.schema.filter(row => !beforeByName.has(row.name));
  const removed = before.schema.filter(row => !after.schema.some(current => current.name === row.name));
  const changed = after.schema.filter(row => beforeByName.has(row.name)
    && canonical(row) !== canonical(beforeByName.get(row.name)));
  const expectedSql = targetSqlRows(packet).sort();
  need(changed.length === 0 && removed.length === 0 && after.schema.length === before.schema.length + 5 && added.length === 5
    && canonical(added.map(row => row.sql).sort()) === canonical(expectedSql),
  'post_schema_delta_not_exact');
  const pendingIds = new Set(SOURCE_PENDING.slice(0, -1));
  need(!after.ledger.some(row => pendingIds.has(row.name)), 'optional_or_prior_migration_applied');
  return Object.freeze({ ledgerCount: after.ledger.length, schemaObjects: after.schema.length,
    addedObjects: added.length, pendingMigrationsPreserved: [...REMAINING_PENDING] });
}

function writeExclusive(filename, bytes) {
  const fd = fs.openSync(filename, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeJsonExclusive(filename, value) { writeExclusive(filename, Buffer.from(JSON.stringify(value, null, 2) + '\n')); }
function readPinnedFile(filename, maxBytes) {
  const stat = fs.lstatSync(filename);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
    && Number.isSafeInteger(stat.size) && stat.size > 0 && stat.size <= maxBytes,
  'private_artifact_file_invalid');
  const fd = fs.openSync(filename, 'r');
  try {
    const before = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    need(before.dev === after.dev && before.ino === after.ino && before.size === after.size
      && before.mtimeMs === after.mtimeMs && bytes.length === before.size, 'private_artifact_changed_during_read');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function readJson(filename, maxBytes = 64 * 1024) {
  return JSON.parse(readPinnedFile(filename, maxBytes).toString('utf8'));
}
function assertPrivateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  need(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(directory) === path.resolve(directory),
    'private_artifact_directory_invalid');
}
function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  assertPrivateDirectory(directory);
  if (process.platform === 'win32') {
    need(process.env.USERDOMAIN && process.env.USERNAME, 'private_journal_owner_missing');
    const account = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    const acl = spawnSync('icacls', [directory, '/inheritance:r', '/grant:r',
      `${account}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F'], { windowsHide: true, stdio: 'ignore' });
    need(!acl.error && acl.status === 0, 'private_journal_acl_failed');
  }
}
function assertReleaseCheckout() {
  const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const originHead = execFileSync('git', ['-C', ROOT, 'rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();
  const branch = execFileSync('git', ['-C', ROOT, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  const ancestry = spawnSync('git', ['-C', ROOT, 'merge-base', '--is-ancestor', SOURCE_COMMIT, head],
    { windowsHide: true, stdio: 'ignore' });
  need(head && head === originHead && branch === 'main' && dirty === ''
    && !ancestry.error && ancestry.status === 0,
    'release_checkout_not_clean_current_main');
}

function createBoundedApi(request, record) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${TARGET.accountId}`;
  const dbPath = `/d1/database/${TARGET.databaseId}`;
  const settingsPath = `/workers/scripts/${TARGET.workerName}/settings`;
  let writes = 0;
  async function call(route, method = 'GET', body) {
    need([settingsPath, dbPath, `${dbPath}/query`].includes(route), 'api_route_refused');
    const readOnlyQuery = route === `${dbPath}/query` && method === 'POST' && body && (
      canonical(body) === canonical({ batch: READ_SQL.map(sql => ({ sql })) })
      || canonical(body) === canonical({ sql: EMPTY_TARGET_SQL }));
    const migrationWrite = route === `${dbPath}/query` && method === 'POST' && body
      && Array.isArray(body.batch) && body.batch.length === 9 && writes === 0;
    if (method === 'GET') need(body === undefined, 'safe_method_body_refused');
    else need(readOnlyQuery || migrationWrite, 'api_mutation_scope_refused');
    if (migrationWrite) writes++;
    const rawBody = body === undefined ? undefined : JSON.stringify(body);
    const response = await request(base + route, { method, redirect: 'error', cache: 'no-store',
      ...(rawBody === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: rawBody }),
      signal: AbortSignal.timeout(20_000) });
    need(response instanceof Response && !response.redirected, 'api_response_invalid');
    const chunks = []; let size = 0;
    const reader = response.body?.getReader();
    if (reader) for (;;) { const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength; need(size <= MAX_RESPONSE_BYTES, 'api_response_too_large'); chunks.push(Buffer.from(next.value)); }
    const bytes = Buffer.concat(chunks, size); let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('api_response_invalid_json'); }
    record({ route, method, status: response.status, responseSha256: hash(bytes), responseBytes: bytes.length });
    need(response.status === 200 && value?.success === true && value.result !== undefined,
      method === 'GET' ? 'read_failed' : 'write_result_uncertain_no_retry');
    return value.result;
  }
  return Object.freeze({
    getSettings: () => call(settingsPath),
    getDatabase: () => call(dbPath),
    readMetadata: async () => {
      const result = await call(`${dbPath}/query`, 'POST', { batch: READ_SQL.map(sql => ({ sql })) });
      return { snapshot: makeMetadataSnapshot(TARGET.accountId, TARGET.databaseId, result),
        statementMeta: result[0].meta };
    },
    writeBatch: body => call(`${dbPath}/query`, 'POST', body),
    get writeCount() { return writes; },
  });
}

export async function runOneShot({ mode, request, artifactDir, preparedSha256, now = () => Date.now() }) {
  need(['prepare', 'execute'].includes(mode) && typeof request === 'function', 'invocation_refused');
  const dir = artifactDir ?? ARTIFACT_DIR;
  need(path.isAbsolute(dir), 'artifact_path_not_absolute');
  const reads = [];
  const api = createBoundedApi(request, row => reads.push(row));
  const controls = selectProductionClientBindings(await api.getSettings());
  assertTargetDatabase(await api.getDatabase());
  const firstRead = await api.readMetadata();
  const snapshot = firstRead.snapshot;
  if (mode === 'prepare') {
    verifyPreSnapshot(snapshot);
    const runId = randomUUID();
    const packet = sourceInputs(snapshot, firstRead.statementMeta, runId);
    const bodyBytes = Buffer.from(JSON.stringify(packet.requestBody));
    const snapshotBytes = Buffer.from(JSON.stringify(snapshot));
    const snapshotSha256 = snapshotStateSha256(snapshot);
    const prep = { schemaVersion: 1, profile: PROFILE, status: 'review-candidate-requires-explicit-execute',
      createdAt: new Date(now()).toISOString(), expiresAt: new Date(now() + 10 * 60_000).toISOString(),
      target: TARGET, sourceCommit: SOURCE_COMMIT, migration: { name: MIGRATION_NAME,
        gitBlobOid: MIGRATION_BLOB_OID, sha256: MIGRATION_SHA256, ledgerId: TARGET_LEDGER_ID },
      priorPendingPreserved: [...REMAINING_PENDING], runId,
      bindingProjection: controls, requestBodySha256: hash(bodyBytes), requestBodyBytes: bodyBytes.length,
      heldCompilerStatus: packet.status, heldCompilerAuthorization: false,
      heldCompilerFeatureAuthorization: false, executionAuthorization: false,
      schemaObjectsBefore: snapshot.schema.length, ledgerRowsBefore: snapshot.ledger.length,
      baselineSnapshotSha256: snapshotSha256,
      baselineSnapshotFileSha256: hash(snapshotBytes),
      readStatementMeta: firstRead.statementMeta,
      readReceipts: reads };
    prep.preparedSha256 = hash(Buffer.from(canonical(prep)));
    ensurePrivateDirectory(dir);
    writeExclusive(path.join(dir, 'batch.private.json'), bodyBytes);
    writeExclusive(path.join(dir, 'snapshot.private.json'), snapshotBytes);
    writeJsonExclusive(path.join(dir, 'prepared.private.json'), prep);
    return { status: prep.status, preparedSha256: prep.preparedSha256, target: TARGET,
      ledgerRows: snapshot.ledger.length, schemaObjects: snapshot.schema.length,
      pendingMigrationsPreserved: [...REMAINING_PENDING], providerWrites: api.writeCount };
  }

  need(SHA256.test(preparedSha256 ?? '') && fs.existsSync(dir), 'prepared_packet_required');
  assertPrivateDirectory(dir);
  const prepPath = path.join(dir, 'prepared.private.json');
  const bodyPath = path.join(dir, 'batch.private.json');
  const snapshotPath = path.join(dir, 'snapshot.private.json');
  const intentPath = path.join(dir, 'mutation-intent.private.json');
  const terminalPath = path.join(dir, 'terminal.private.json');
  need(!fs.existsSync(intentPath) && !fs.existsSync(terminalPath), 'one_shot_already_consumed_reconcile_only');
  const prep = readJson(prepPath);
  const claimedHash = prep.preparedSha256; delete prep.preparedSha256;
  need(hash(Buffer.from(canonical(prep))) === claimedHash && claimedHash === preparedSha256,
    'prepared_receipt_hash_mismatch');
  prep.preparedSha256 = claimedHash;
  need(prep.profile === PROFILE && prep.status === 'review-candidate-requires-explicit-execute'
    && prep.executionAuthorization === false && prep.heldCompilerAuthorization === false
    && prep.heldCompilerFeatureAuthorization === false
    && prep.target.accountId === TARGET.accountId && prep.target.databaseId === TARGET.databaseId
    && prep.target.workerName === TARGET.workerName && prep.target.environment === 'production'
    && prep.migration?.name === MIGRATION_NAME && prep.migration?.gitBlobOid === MIGRATION_BLOB_OID
    && prep.migration?.sha256 === MIGRATION_SHA256 && prep.migration?.ledgerId === TARGET_LEDGER_ID
    && canonical(prep.priorPendingPreserved) === canonical(REMAINING_PENDING)
    && prep.heldCompilerStatus === 'review-candidate-not-executable'
    && Number.isFinite(Date.parse(prep.createdAt)) && Number.isFinite(Date.parse(prep.expiresAt))
    && Date.parse(prep.createdAt) <= now() && Date.parse(prep.expiresAt) > now()
    && Date.parse(prep.expiresAt) - Date.parse(prep.createdAt) <= 10 * 60_000,
  'prepared_scope_or_expiry_invalid');
  const baselineBytes = readPinnedFile(snapshotPath, 8 * 1024 * 1024);
  const baseline = JSON.parse(baselineBytes.toString('utf8'));
  need(hash(baselineBytes) === prep.baselineSnapshotFileSha256
    && snapshotStateSha256(baseline) === prep.baselineSnapshotSha256, 'prepared_snapshot_hash_mismatch');
  const savedBody = readPinnedFile(bodyPath, 12 * 1024 * 1024);
  need(hash(savedBody) === prep.requestBodySha256, 'prepared_batch_hash_mismatch');
  const body = JSON.parse(savedBody.toString('utf8'));
  need(canonical(controls) === canonical(prep.bindingProjection), 'production_binding_changed');
  need(snapshotStateSha256(snapshot) === prep.baselineSnapshotSha256,
    'production_metadata_changed_after_prepare');
  const packet = sourceInputs(snapshot, firstRead.statementMeta, prep.runId);
  need(hash(Buffer.from(JSON.stringify(packet.requestBody))) === prep.requestBodySha256
    && canonical(packet.requestBody) === canonical(body), 'compiled_batch_changed');
  const intent = { at: new Date(now()).toISOString(), target: TARGET, profile: PROFILE,
    preparedSha256: claimedHash, requestBodySha256: prep.requestBodySha256,
    action: 'one_exact_client0242_rest_batch', automaticRetry: false,
    remainingPending: [...REMAINING_PENDING] };
  writeJsonExclusive(intentPath, intent);
  let writeResponse = null, writeError = null;
  try {
    const result = await api.writeBatch(body);
    need(Array.isArray(result) && result.length === 9 && result.every(row => row?.success === true),
      'migration_batch_ack_invalid_no_retry');
    writeResponse = result;
  }
  catch { writeError = 'write_response_or_transport_uncertain'; }

  // A single GET-only reconciliation path. An unchanged baseline does not
  // authorize replay; ambiguous outcomes remain terminally held.
  let afterControls = null, after = null, exactApplied = null, reconciliationFailed = false;
  try {
    afterControls = selectProductionClientBindings(await api.getSettings());
    assertTargetDatabase(await api.getDatabase());
    after = (await api.readMetadata()).snapshot;
    try { exactApplied = verifyPostSnapshot(baseline, after, packet); } catch { exactApplied = null; }
  } catch { reconciliationFailed = true; }
  const bindingsUnchanged = Boolean(afterControls && canonical(afterControls) === canonical(controls));
  let status = reconciliationFailed ? 'held_postwrite_reconciliation_incomplete_no_retry'
    : exactApplied && bindingsUnchanged
      ? (writeResponse ? 'applied_and_verified' : 'applied_reconciled_after_uncertain_response')
      : exactApplied ? 'applied_schema_verified_but_binding_changed_review_required'
        : 'held_uncertain_or_poststate_mismatch_no_retry';
  let emptyNewTables = false;
  if (exactApplied && bindingsUnchanged) {
    try {
      const rows = await api.writeBatch({ sql: EMPTY_TARGET_SQL });
      need(Array.isArray(rows) && rows.length === 1 && rows[0].success === true
        && rows[0].results?.length === 1 && rows[0].results[0].inquiries === 0
        && rows[0].results[0].outbox === 0 && rows[0].meta?.rows_written === 0,
      'new_target_tables_not_empty');
      emptyNewTables = true;
    } catch { status = 'applied_schema_verified_data_state_requires_review'; }
  }
  const terminal = { at: new Date(now()).toISOString(), status, target: TARGET,
    preparedSha256: claimedHash, requestBodySha256: prep.requestBodySha256,
    apiWriteAcknowledged: Boolean(writeResponse), writeErrorCode: writeError,
    ledgerRowsBefore: baseline.ledger.length, ledgerRowsAfter: after?.ledger.length ?? null,
    schemaObjectsBefore: baseline.schema.length, schemaObjectsAfter: after?.schema.length ?? null,
    exactSchemaLedgerDelta: Boolean(exactApplied), newTablesEmpty: emptyNewTables,
    parentIdentityUnchanged: Boolean(after && canonical(after.parent) === canonical(baseline.parent)),
    productionBindingsUnchanged: bindingsUnchanged,
    optionalMigrationsApplied: 0, featureFlagsChanged: false, workersChanged: false,
    reads, providerWrites: api.writeCount, automaticRetry: false };
  writeJsonExclusive(terminalPath, terminal);
  return { status: terminal.status, target: TARGET, exactSchemaLedgerDelta: terminal.exactSchemaLedgerDelta,
    newTablesEmpty: emptyNewTables, providerWrites: api.writeCount, automaticRetry: false };
}

async function main(argv) {
  need(argv[0] === '--prepare' && argv.length === 1
    || argv[0] === '--execute' && argv.length === 3 && argv[1] === '--prepared-sha256',
  'usage: --prepare | --execute --prepared-sha256 <reviewed-sha256>');
  const mode = argv[0] === '--prepare' ? 'prepare' : 'execute';
  const preparedSha256 = mode === 'execute' ? argv[2] : undefined;
  need(!process.execArgv.length, 'node_flags_refused');
  assertReleaseCheckout();
  const adapterBytes = fs.readFileSync(OWNER_ADAPTER);
  need(hash(adapterBytes) === OWNER_ADAPTER_SHA256, 'oauth_adapter_pin_mismatch');
  const adapter = await import(pathToFileURL(OWNER_ADAPTER));
  const request = await adapter.createProductionOpsCloudflareFetchAdapter();
  const result = await runOneShot({ mode, request, preparedSha256 });
  console.log(JSON.stringify(result));
  if (mode === 'execute' && !['applied_and_verified', 'applied_reconciled_after_uncertain_response'].includes(result.status)) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({ status: 'held', code: /^[a-z0-9_]+$/u.test(error?.message ?? '')
      ? error.message : 'operator_failed', automaticRetry: false }));
    process.exitCode = 1;
  });
}
