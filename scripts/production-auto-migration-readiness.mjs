import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export const PRODUCTION_MIGRATION_TARGET = Object.freeze({
  accountId: '846c924bf17bf4f3dd15c97a4c5d1d51',
  databases: Object.freeze([
    Object.freeze({ name: 'operations', databaseId: '6ebf7514-d306-4615-ae56-ad869c874dbd', migrationsPath: 'apps/operations/migrations' }),
    Object.freeze({ name: 'client', databaseId: '7f40a7b7-c3ec-470e-a626-e798867f71f8', migrationsPath: 'apps/client/migrations' }),
  ]),
});
export const PRODUCTION_MIGRATION_QUERY = 'SELECT name,id FROM d1_migrations ORDER BY id LIMIT 1025';
const API_ORIGIN = 'https://api.cloudflare.com';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const OPERATION_TIMEOUT_MS = 30_000;
const MAX_LEDGER_ROWS = 1024;
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
function runGit(root, args, options = {}) {
  const remaining = options.deadlineAt === undefined ? 5_000 : options.deadlineAt - options.monotonicNow();
  if (remaining <= 0) fail('readiness_deadline_exceeded');
  try {
    const spawnOptions = {
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      timeout: Math.max(1, Math.min(5_000, remaining)),
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    if (options.encoding !== undefined) spawnOptions.encoding = options.encoding;
    if (options.input !== undefined) spawnOptions.input = options.input;
    return execFileSync('git', ['-C', root, ...args], spawnOptions);
  } catch {
    fail('source_inventory_unavailable');
  }
}
function buildSourceInventory(root, sourceCommit, target, deadline) {
  const rootPath = path.resolve(root);
  const gitOptions = { deadlineAt: deadline.deadlineAt, monotonicNow: deadline.monotonicNow };
  const head = runGit(rootPath, ['rev-parse', '--verify', 'HEAD'], { ...gitOptions, encoding: 'utf8' }).trim();
  if (head !== sourceCommit) fail('source_commit_mismatch');
  const treeText = runGit(rootPath, ['ls-tree', '-r', '--full-tree', sourceCommit, '--', target.migrationsPath], { ...gitOptions, encoding: 'utf8' });
  const tree = treeText.split(/\r?\n/).filter(Boolean).map((line) => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (!match) fail('source_migration_tree_invalid');
    return { oid: match[2], relative: match[3] };
  }).filter((entry) => entry.relative.startsWith(target.migrationsPath + '/') && entry.relative.endsWith('.sql'))
    .sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
  if (!tree.length || tree.length > MAX_LEDGER_ROWS) fail('source_migration_count_invalid');
  const trackedNames = tree.map((entry) => path.posix.basename(entry.relative));
  const localNames = readdirSync(path.join(rootPath, target.migrationsPath), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (JSON.stringify(localNames) !== JSON.stringify(trackedNames)) fail('source_migration_inventory_changed');
  for (const entry of tree) {
    const localPath = path.join(rootPath, ...entry.relative.split('/'));
    let stat;
    try { stat = lstatSync(localPath); } catch { fail('source_migration_file_missing'); }
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.attributes && (stat.attributes & 0x400))) {
      fail('source_migration_file_invalid');
    }
    if (stat.size < 1 || stat.size > 8 * 1024 * 1024) fail('source_migration_blob_too_large');
  }
  const oidInput = tree.map((entry) => entry.oid).join('\n') + '\n';
  const blobs = runGit(rootPath, ['cat-file', '--batch'], {
    ...gitOptions, input: oidInput, maxBuffer: 32 * 1024 * 1024,
  });
  if (!Buffer.isBuffer(blobs)) fail('source_migration_blob_invalid');
  const blobRows = [];
  let blobOffset = 0, aggregateSize = 0;
  for (const entry of tree) {
    const headerEnd = blobs.indexOf(0x0a, blobOffset);
    if (headerEnd < 0) fail('source_migration_blob_invalid');
    const header = blobs.subarray(blobOffset, headerEnd).toString('ascii').split(' ');
    if (header.length !== 3 || header[0] !== entry.oid || header[1] !== 'blob' || !/^\d+$/.test(header[2])) {
      fail('source_migration_blob_invalid');
    }
    const size = Number(header[2]);
    aggregateSize += size;
    if (!Number.isSafeInteger(size) || size < 1 || size > 8 * 1024 * 1024 || aggregateSize > 32 * 1024 * 1024) {
      fail('source_migration_blob_too_large');
    }
    const start = headerEnd + 1, end = start + size;
    if (end >= blobs.length || blobs[end] !== 0x0a) fail('source_migration_blob_invalid');
    blobRows.push({ relative: entry.relative, oid: entry.oid, name: path.posix.basename(entry.relative), bytes: blobs.subarray(start, end) });
    blobOffset = end + 1;
  }
  if (blobOffset !== blobs.length) fail('source_migration_blob_invalid');
  const localObjectIds = runGit(rootPath, ['hash-object', '--stdin-paths'], {
    ...gitOptions, input: tree.map((entry) => entry.relative).join('\n') + '\n',
    maxBuffer: 1024 * 1024, encoding: 'utf8',
  }).trim().split(/\r?\n/);
  if (localObjectIds.length !== tree.length || localObjectIds.some((oid, index) => oid !== tree[index].oid)) {
    fail('source_migration_bytes_changed');
  }
  const rows = [];
  const sourceFiles = [];
  const seen = new Set();
  for (const blob of blobRows) {
    const { name, bytes } = blob;
    if (!/^\d{4}_.+\.sql$/.test(name) || seen.has(name)) fail('source_migration_name_invalid');
    seen.add(name);
    const blobHash = hash(bytes);
    rows.push(Object.freeze({ name, gitBlobOid: blob.oid, sha256: blobHash }));
    sourceFiles.push(Object.freeze({ name, bytes: Buffer.from(bytes) }));
  }
  const inventoryBytes = Buffer.from(JSON.stringify(rows.map((row) => [row.name, row.sha256])), 'utf8');
  return Object.freeze({
    names: Object.freeze(rows.map((row) => row.name)),
    paths: Object.freeze(tree.map((entry) => entry.relative)),
    blobOids: Object.freeze(tree.map((entry) => entry.oid)),
    sourceRows: Object.freeze(rows),
    sourceFiles: Object.freeze(sourceFiles),
    sha256: hash(inventoryBytes),
  });
}
function assertSourceUnchanged(root, sourceCommit, inventories, deadline) {
  const rootPath = path.resolve(root);
  const gitOptions = { deadlineAt: deadline.deadlineAt, monotonicNow: deadline.monotonicNow, encoding: 'utf8' };
  if (runGit(rootPath, ['rev-parse', '--verify', 'HEAD'], gitOptions).trim() !== sourceCommit) {
    fail('source_commit_changed_during_read');
  }
  for (let index = 0; index < inventories.length; index++) {
    const target = PRODUCTION_MIGRATION_TARGET.databases[index], inventory = inventories[index];
    const tree = runGit(rootPath, ['ls-tree', '-r', '--full-tree', sourceCommit, '--', target.migrationsPath], gitOptions)
      .split(/\r?\n/).filter(Boolean).map((line) => /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(line))
      .filter(Boolean).filter((match) => match[3].startsWith(target.migrationsPath + '/') && match[3].endsWith('.sql'));
    if (tree.length !== inventory.paths.length || tree.some((match, row) =>
      match[3] !== inventory.paths[row] || match[2] !== inventory.blobOids[row])) fail('source_migration_tree_changed');
    const localNames = readdirSync(path.join(rootPath, target.migrationsPath), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql')).map((entry) => entry.name)
      .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    if (JSON.stringify(localNames) !== JSON.stringify(inventory.names)) fail('source_migration_inventory_changed');
    const objectIds = runGit(rootPath, ['hash-object', '--stdin-paths'], {
      ...gitOptions, input: inventory.paths.join('\n') + '\n', maxBuffer: 1024 * 1024,
    }).trim().split(/\r?\n/);
    if (objectIds.length !== inventory.blobOids.length || objectIds.some((oid, row) => oid !== inventory.blobOids[row])) {
      fail('source_migration_bytes_changed_during_read');
    }
  }
}
function assertOptionalIdentity(value, expected) {
  const locations = [
    value?.result?.database_id,
    value?.result?.databaseId,
    value?.result?.uuid,
  ].filter((item) => item !== undefined);
  if (locations.some((item) => typeof item !== 'string' || item.toLowerCase() !== expected)) fail('provider_database_identity_mismatch');
  const queryResult = Array.isArray(value?.result) ? value.result[0] : null;
  const meta = queryResult?.meta;
  for (const key of ['database_id', 'databaseId', 'uuid']) {
    if (meta && meta[key] !== undefined &&
        (typeof meta[key] !== 'string' || meta[key].toLowerCase() !== expected)) fail('provider_database_identity_mismatch');
  }
}
function assertZeroWrites(meta) {
  if (!isRecord(meta)) return;
  for (const key of ['changes', 'rows_written', 'rowsWritten']) {
    if (meta[key] !== undefined && (!Number.isSafeInteger(meta[key]) || meta[key] !== 0)) fail('provider_write_detected');
  }
  if (meta.changed_db === true) fail('provider_write_detected');
  if (meta.changed_db !== undefined && typeof meta.changed_db !== 'boolean') fail('provider_meta_invalid');
}
export function validateMigrationLedgerRows(expectedNames, rows, statementMeta) {
  if (!Array.isArray(rows) || rows.length > MAX_LEDGER_ROWS || rows.length !== expectedNames.length) fail('migration_ledger_count_mismatch');
  const actualNames = validateMigrationEvidenceRows(rows, statementMeta);
  let previousId = -1;
  for (const row of rows) {
    if (row.id <= previousId) fail('migration_ledger_row_invalid');
    previousId = row.id;
  }
  for (let index = 0; index < expectedNames.length; index++) {
    if (actualNames[index] !== expectedNames[index]) fail('migration_ledger_names_mismatch');
  }
  return hash(Buffer.from(actualNames.join('\n'), 'utf8'));
}

export function validateMigrationEvidenceRows(rows, statementMeta) {
  if (!Array.isArray(rows) || rows.length > MAX_LEDGER_ROWS) fail('migration_ledger_count_mismatch');
  const actualNames = [];
  const seen = new Set();
  const seenIds = new Set();
  for (const row of rows) {
    if (!keysExact(row, ['name', 'id']) || typeof row.name !== 'string' ||
        !Number.isSafeInteger(row.id) || row.id < 1 || seen.has(row.name) || seenIds.has(row.id)) {
      fail('migration_ledger_row_invalid');
    }
    seen.add(row.name);
    seenIds.add(row.id);
    actualNames.push(row.name);
  }
  assertZeroWrites(statementMeta);
  return Object.freeze(actualNames);
}
function nonblockingCancel(target) {
  try {
    const result = target?.cancel?.();
    if (result && typeof result.catch === 'function') void result.catch(() => {});
  } catch {}
}
function withDeadline(promise, signal) {
  if (signal.aborted) return Promise.reject(Object.assign(new Error('timeout'), { code: 'request_timeout' }));
  let onAbort;
  const timedOut = new Promise((_, reject) => {
    onAbort = () => reject(Object.assign(new Error('timeout'), { code: 'request_timeout' }));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, timedOut]).finally(() => signal.removeEventListener('abort', onAbort));
}
async function readBoundedJson(response, signal) {
  if (!response.body?.getReader) fail('provider_body_missing');
  const encoding = response.headers?.get?.('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') {
    nonblockingCancel(response.body);
    fail('provider_encoding_unsupported');
  }
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength !== null && contentLength !== undefined &&
      (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)) {
    nonblockingCancel(response.body);
    fail('provider_body_too_large');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const item = await withDeadline(reader.read(), signal);
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        nonblockingCancel(reader);
        fail('provider_body_too_large');
      }
      chunks.push(Buffer.from(item.value));
    }
  } catch (error) {
    nonblockingCancel(reader);
    if (error?.code) throw error;
    fail('provider_body_read_failed');
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  let json;
  try { json = JSON.parse(Buffer.concat(chunks, total).toString('utf8')); } catch { fail('provider_json_invalid'); }
  return json;
}
function extractQuery(value) {
  if (!isRecord(value) || value.success !== true ||
      (value.errors !== undefined && (!Array.isArray(value.errors) || value.errors.length !== 0)) ||
      !Array.isArray(value.result) || value.result.length !== 1) fail('provider_envelope_invalid');
  const statement = value.result[0];
  if (!isRecord(statement) || statement.success !== true ||
      (statement.errors !== undefined && (!Array.isArray(statement.errors) || statement.errors.length !== 0)) ||
      !Array.isArray(statement.results) || (statement.meta !== undefined && !isRecord(statement.meta))) fail('provider_statement_invalid');
  return statement;
}
async function readOneLedgerEvidence({ accountId, databaseId, token, fetchImpl, deadlineAt, monotonicNow }) {
  if (accountId !== PRODUCTION_MIGRATION_TARGET.accountId || !PRODUCTION_MIGRATION_TARGET.databases.some((db) => db.databaseId === databaseId)) {
    fail('provider_target_invalid');
  }
  const remaining = deadlineAt - monotonicNow();
  if (remaining <= 0) fail('readiness_deadline_exceeded');
  const controller = new AbortController();
  const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, remaining);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = API_ORIGIN + '/client/v4/accounts/' + accountId + '/d1/database/' + databaseId + '/query';
  let response;
  try {
    response = await withDeadline(fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ sql: PRODUCTION_MIGRATION_QUERY, params: [] }),
    }), controller.signal);
    if (!response || response.redirected || response.status >= 300 && response.status < 400) {
      nonblockingCancel(response?.body);
      fail('provider_redirect_refused');
    }
    if (!response.ok) {
      nonblockingCancel(response.body);
      fail('provider_http_failure');
    }
    const payload = await readBoundedJson(response, controller.signal);
    assertOptionalIdentity(payload, databaseId);
    const statement = extractQuery(payload);
    validateMigrationEvidenceRows(statement.results, statement.meta);
    return Object.freeze({
      databaseId,
      ledgerRows: Object.freeze(statement.results.map(({ name, id }) => Object.freeze({ name, id }))),
      statementMeta: statement.meta,
    });
  } catch (error) {
    if (error?.code) throw error;
    fail('provider_request_failed');
  } finally {
    clearTimeout(timer);
  }
}

export function validateProductionMigrationReadiness(value, { sourceCommit, now = Date.now() } = {}) {
  if (!keysExact(value, ['schemaVersion', 'sourceCommit', 'accountId', 'observedAt', 'databases']) ||
      value.schemaVersion !== 1 || value.sourceCommit !== sourceCommit || !COMMIT.test(sourceCommit ?? '') ||
      value.accountId !== PRODUCTION_MIGRATION_TARGET.accountId || !Array.isArray(value.databases) ||
      value.databases.length !== 2 || !Number.isFinite(now)) fail('migration_readiness_invalid');
  const observed = safeDate(value.observedAt);
  if (observed > now || now - observed > 60_000) fail('migration_readiness_stale');
  for (let index = 0; index < 2; index++) {
    const row = value.databases[index], target = PRODUCTION_MIGRATION_TARGET.databases[index];
    if (!keysExact(row, ['databaseId', 'sourceInventorySha256', 'ledgerNamesSha256', 'migrationCount']) ||
        row.databaseId !== target.databaseId || !SHA256.test(row.sourceInventorySha256 ?? '') ||
        !SHA256.test(row.ledgerNamesSha256 ?? '') || !Number.isSafeInteger(row.migrationCount) ||
        row.migrationCount < 1 || row.migrationCount > MAX_LEDGER_ROWS) fail('migration_readiness_database_invalid');
  }
  return structuredClone(value);
}

export function validateProductionMigrationAdmission(value, { sourceCommit, now = Date.now() } = {}) {
  if (isRecord(value) && value.purpose === 'append-only-migration-inventory-classification') {
    if (value.status === 'migration-required') fail('migration_required_pending');
    if (value.status === 'inventory-current-schema-check-required') {
      fail('migration_application_schema_confirmation_required');
    }
    fail('migration_readiness_diagnostic_invalid');
  }
  return validateProductionMigrationReadiness(value, { sourceCommit, now });
}

export async function collectProductionMigrationEvidence({
  sourceCommit, root, token, env = process.env, fetchImpl = globalThis.fetch,
  now = () => new Date(), monotonicNow = () => performance.now(),
} = {}, { processLedgerEvidence } = {}) {
  if (processLedgerEvidence !== undefined && typeof processLedgerEvidence !== 'function') {
    fail('migration_evidence_processor_invalid');
  }
  if (!COMMIT.test(sourceCommit ?? '') || typeof root !== 'string' || !path.isAbsolute(root) ||
      typeof token !== 'string' || token.length < 16 || token.length > 16_384 || !/^[\x21-\x7e]+$/.test(token) ||
      typeof fetchImpl !== 'function') fail('migration_readiness_input_invalid');
  if (env.CLOUDFLARE_ACCOUNT_ID !== undefined && env.CLOUDFLARE_ACCOUNT_ID !== PRODUCTION_MIGRATION_TARGET.accountId) {
    fail('migration_readiness_account_mismatch');
  }
  const startWall = now().getTime(), startMono = monotonicNow();
  if (!Number.isFinite(startWall) || !Number.isFinite(startMono)) fail('readiness_clock_invalid');
  let lastMono = startMono;
  const checkedMonotonicNow = () => {
    const value = monotonicNow();
    if (!Number.isFinite(value) || value < lastMono) fail('readiness_monotonic_clock_regressed');
    lastMono = value;
    if (value - startMono > OPERATION_TIMEOUT_MS) fail('readiness_deadline_exceeded');
    return value;
  };
  const deadlineAt = startMono + OPERATION_TIMEOUT_MS;
  const deadline = { deadlineAt, monotonicNow: checkedMonotonicNow };
  const inventories = PRODUCTION_MIGRATION_TARGET.databases.map((db) => buildSourceInventory(root, sourceCommit, db, deadline));
  const databases = [];
  for (let index = 0; index < PRODUCTION_MIGRATION_TARGET.databases.length; index++) {
    if (checkedMonotonicNow() > deadlineAt) fail('readiness_deadline_exceeded');
    const ledger = await readOneLedgerEvidence({
      accountId: PRODUCTION_MIGRATION_TARGET.accountId,
      databaseId: PRODUCTION_MIGRATION_TARGET.databases[index].databaseId,
      token, fetchImpl, deadlineAt, monotonicNow: checkedMonotonicNow,
    });
    assertSourceUnchanged(root, sourceCommit, inventories, deadline);
    checkedMonotonicNow();
    const inventory = inventories[index];
    const classification = processLedgerEvidence?.(Object.freeze({ ...ledger, inventory }), index);
    databases.push(Object.freeze({ ...ledger, inventory, ...(classification === undefined ? {} : { classification }) }));
  }
  const endWall = now().getTime();
  if (!Number.isFinite(startWall) || !Number.isFinite(endWall) || endWall < startWall) fail('readiness_clock_moved_backwards');
  assertSourceUnchanged(root, sourceCommit, inventories, deadline);
  checkedMonotonicNow();
  return Object.freeze({
    schemaVersion: 1,
    sourceCommit,
    accountId: PRODUCTION_MIGRATION_TARGET.accountId,
    observedAt: new Date(endWall).toISOString(),
    databases: Object.freeze(databases),
  });
}

export async function readProductionMigrationReadiness(options = {}) {
  const evidence = await collectProductionMigrationEvidence(options, {
    processLedgerEvidence: ({ inventory, ledgerRows, statementMeta }) =>
      validateMigrationLedgerRows(inventory.names, ledgerRows, statementMeta),
  });
  const databases = evidence.databases.map(({ databaseId, inventory, classification: ledgerNamesSha256 }) => {
    return Object.freeze({ databaseId, sourceInventorySha256: inventory.sha256, ledgerNamesSha256,
      migrationCount: inventory.names.length });
  });
  const result = { schemaVersion: 1, sourceCommit: evidence.sourceCommit, accountId: evidence.accountId,
    observedAt: evidence.observedAt, databases };
  return validateProductionMigrationReadiness(result, { sourceCommit: evidence.sourceCommit, now: Date.parse(evidence.observedAt) });
}
