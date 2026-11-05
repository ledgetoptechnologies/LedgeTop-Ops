import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const splitters = Object.freeze(Object.fromEntries(['operations', 'client'].map(application => {
  const app = path.join(ROOT, 'apps', application);
  const lock = JSON.parse(fs.readFileSync(path.join(app, 'package-lock.json'), 'utf8'));
  const installed = JSON.parse(fs.readFileSync(path.join(app, 'node_modules/wrangler/package.json'), 'utf8'));
  assert.equal(installed.name, 'wrangler', `${application} Wrangler package identity mismatch`);
  assert.equal(installed.version, lock.packages?.['node_modules/wrangler']?.version,
    `${application} installed Wrangler must match its lockfile`);
  const splitter = createRequire(path.join(app, 'package.json'))('wrangler').unstable_splitSqlQuery;
  assert.equal(typeof splitter, 'function', `${application} Wrangler SQL splitter is unavailable`);
  return [application, splitter];
})));
export const STAGING_V4_CAPSULE_SHA256 = '9f887ff0bdab02858641e1fb3fd926842117b4b008711e0720b5042517b1035a';
export const STAGING_V4_SCHEMA_CHUNK_BYTES = 750_000;
export const STAGING_V4_MAX_SQL_BYTES = 100_000;
export const STAGING_V4_MAX_PARAM_BYTES = 1_500_000;
export const STAGING_V4_MAX_PARAMS = 100;
export const STAGING_V4_MAX_BATCH_STATEMENTS = 100;
export const STAGING_V4_CONTROL_MAX_AGE_MS = 5 * 60 * 1000;
export const STAGING_V4_CONTROL_FUTURE_SKEW_MS = 30 * 1000;
export const STAGING_V4_JOURNAL_PARENT = path.resolve('C:/Users/fstor/.codex/artifacts/production-ops-retained-resume-execution-20261031');
export const STAGING_V4_JOURNAL_ROOT = path.join(STAGING_V4_JOURNAL_PARENT, 'staging-v4-migrations');
export const STAGING_V4_LEGACY_JOURNAL_ROOT = path.resolve('C:/Users/fstor/.codex/artifacts/staging-v4-migration-journal');
const MAX_BATCH_BYTES = 8 * 1024 * 1024;
const INTERNAL_SCHEMA_SQL = `SELECT type,name,tbl_name,sql FROM sqlite_schema
  WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'
    AND type IN ('table','view','index','trigger') ORDER BY type,name`;
const MIGRATIONS = Object.freeze({
  operations: Object.freeze([
    Object.freeze({ name: '0233_operations_portal_native_recipient_capability_intents.sql',
      sha256: '34062381b898ecb3ba0cb3202a946f7b27eb19b595ef68c860093e8b8a0af54b',
      blobOid: 'eba1181aa8f1c6adba92c9c100a9530645392448' }),
    Object.freeze({ name: '0234_operations_portal_native_inquiry_capability.sql',
      sha256: '3357007f0d2e09148ee80324423d1347ad8bf1c9da422c8daf56079d7d5909c4',
      blobOid: 'b56e543fc90ac7ab97709c9eac283bcf80484dea' }),
    Object.freeze({ name: '0235_ops_principal_inquiries.sql',
      sha256: 'b937a6500d970f2d5e19225404b4490c3961c2d2dedd0f2cce00c1e8db6a9bfc',
      blobOid: 'f61d0fe41d43c9af38e5d40832e61d2151cefcc1' }),
  ]),
  client: Object.freeze([
    Object.freeze({ name: '0243_operations_portal_native_inquiry_capability.sql',
      sha256: 'bf07c859f85649d34e63bfb44143cbafed936514713613aa56d2d28e60855592',
      blobOid: 'c37c781b01be52da777371f63b1e9274bffd6d63' }),
  ]),
});
const TARGETS = Object.freeze({
  operations: Object.freeze({ binding: 'OPS_DB', worker: 'ledgetop-ops-staging', databaseName: 'ltds-ops-staging',
    databaseId: '78b34173-b168-4e3d-9832-bb9d245cc6b8', ledgerCount: 225,
    ledgerNamesSha256: 'e9ca08f7e051a7581da54ba585b740d0cbf033c91f69470649750ae2fdabd8a7',
    schemaCount: 2443, schemaJsonSha256: '2edb8a61a1594b58c3fe55106a473f792fc1af2378e734a2b3dbcf37f96e9415',
    parentColumnCount: 23, parentJsonSha256: '466de85531fa541a00ed3c29e0647d8a4d10bd4441417b53ba439b5090d56f47' }),
  client: Object.freeze({ binding: 'DELIVERY_DB', worker: 'ledgetop-clients-staging', databaseName: 'client-data-staging',
    databaseId: 'b6f653ab-9acd-4421-9ad0-207754b59aeb', ledgerCount: 156,
    ledgerNamesSha256: 'f4a00c5fb45c7f9a0fe01c012fdbb135d277fadafa23add270b6e173acebfdc4',
    schemaCount: 1168, schemaJsonSha256: '8946a7110f87e999dd296f94d80bc5b4b8558661d692443bae4ebaf1a42e777b',
    parentColumnCount: 13, parentJsonSha256: '150d20005ca3e611b49cdceb3a36a3a08348e595f82a89060172b45a99501283' }),
});

const sha256 = value => createHash('sha256').update(value).digest('hex');
const gitBlobOid = bytes => createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`, 'ascii')).update(bytes).digest('hex');
const canonical = value => JSON.stringify(value);
const canonicalSorted = value => Array.isArray(value) ? `[${value.map(canonicalSorted).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalSorted(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const safeError = code => Object.assign(new Error(code), { code });
const compiledSteps = new WeakSet();
const verifiedCapsules = new WeakSet();
export function isCompiledStagingV4Step(step) { return Boolean(step && compiledSteps.has(step)); }
export function stagingV4JournalPaths(intentId) {
  if (typeof intentId !== 'string' || !/^[a-f0-9]{32}$/u.test(intentId)) throw safeError('intent_id_invalid');
  return Object.freeze({ root: STAGING_V4_JOURNAL_ROOT,
    attempt: path.join(STAGING_V4_JOURNAL_ROOT, `${intentId}.attempt.json`),
    completion: path.join(STAGING_V4_JOURNAL_ROOT, `${intentId}.postcheck.json`) });
}
export function isStagingV4LegacyJournalMarker(name) {
  return typeof name === 'string' && /^[a-f0-9]{32}\.(?:attempt|postcheck)\.json$/u.test(name);
}
function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function splitMigrationSql(sql, application = 'operations') {
  if (typeof sql !== 'string' || !Object.hasOwn(splitters, application)) throw safeError('migration_sql_invalid');
  return splitters[application](sql.replace(/\r\n/gu, '\n')).map(statement => statement.trim()).filter(statement => statement
    && !/^PRAGMA\s+foreign_keys\s*=\s*ON\s*;?$/iu.test(statement));
}

function validateSnapshotRows(application, ledger, schema, parent) {
  const target = TARGETS[application];
  if (!target) throw safeError('application_not_selected');
  if (!Array.isArray(ledger) || ledger.length !== target.ledgerCount
    || !ledger.every((row, i) => row && row.id === i + 1 && typeof row.name === 'string' && row.name.length > 0)
    || sha256(ledger.map(row => row.name).join('\n')) !== target.ledgerNamesSha256) throw safeError('baseline_ledger_mismatch');
  if (!Array.isArray(schema) || schema.length !== target.schemaCount
    || sha256(canonical(schema)) !== target.schemaJsonSha256) throw safeError('baseline_schema_mismatch');
  const seen = new Set();
  for (const row of schema) {
    if (!row || !['table', 'view', 'index', 'trigger'].includes(row.type)
      || typeof row.name !== 'string' || !row.name || typeof row.tbl_name !== 'string' || !row.tbl_name
      || typeof row.sql !== 'string' || !row.sql) throw safeError('baseline_schema_object_invalid');
    const key = `${row.type}\0${row.name}`;
    if (seen.has(key)) throw safeError('baseline_schema_duplicate');
    seen.add(key);
  }
  if (!Array.isArray(parent) || parent.length !== target.parentColumnCount
    || sha256(canonical(parent)) !== target.parentJsonSha256) throw safeError('baseline_parent_shape_mismatch');
}

function selectedD1Binding(bindings, bindingName, databaseId) {
  const found = Array.isArray(bindings) ? bindings.find(item => item?.name === bindingName) : bindings?.[bindingName];
  if (!found || found.name !== bindingName || found.type !== 'd1'
    || (found.database_id ?? found.id) !== databaseId || (found.id ?? found.database_id) !== databaseId) {
    throw safeError('worker_d1_binding_identity_mismatch');
  }
  return Object.freeze({ name: bindingName, type: 'd1', databaseId });
}

function controlPinFromCapsule(capsule, application, { requireOffFlags = true } = {}) {
  const worker = capsule.workers?.[application], target = TARGETS[application];
  const requiredOffFlags = application === 'operations'
    ? ['OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED', 'CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED']
    : ['CLIENT_PORTAL_NATIVE_INQUIRY_CAPABILITY_WRITER_ENABLED', 'CLIENT_PORTAL_OPS_INQUIRIES_ENABLED'];
  if (!worker || worker.workerName !== target.worker || !worker.activeVersionId || !worker.latestVersionId
    || !worker.deployment?.id || !worker.modern?.id || !Number.isSafeInteger(worker.modern.number)
    || typeof worker.modern.main_module !== 'string' || typeof worker.modern.compatibility_date !== 'string'
    || !/^[a-f0-9]{64}$/u.test(worker.rawBindingsSHA256 ?? '')
    || !/^[a-f0-9]{64}$/u.test(worker.rawControlSHA256 ?? '')
    || !worker.selectedFlags || !worker.schedules || !Array.isArray(worker.schedules.schedules)
    || requiredOffFlags.some(name => !Object.hasOwn(worker.selectedFlags, name)
      || !(requireOffFlags ? [null, 'false'] : [null, 'false', 'true']).includes(worker.selectedFlags[name]))) {
    throw safeError('worker_controls_capsule_invalid');
  }
  return deepFreeze({
    workerName: worker.workerName,
    activeVersionId: worker.activeVersionId,
    latestVersionId: worker.latestVersionId,
    deploymentId: worker.deployment.id,
    runtimeVersionId: worker.modern.id,
    runtimeNumber: worker.modern.number,
    runtimeMainModule: worker.modern.main_module,
    runtimeCompatibilityDate: worker.modern.compatibility_date,
    runtimeCompatibilityFlagsSha256: sha256(canonicalSorted(worker.modern.compatibility_flags ?? [])),
    runtimeExportsSha256: sha256(canonicalSorted(worker.modern.exports ?? [])),
    settingsD1Binding: selectedD1Binding(worker.settings?.bindings, target.binding, target.databaseId),
    runtimeD1Binding: selectedD1Binding(worker.modern.bindings, target.binding, target.databaseId),
    rawBindingsSha256: worker.rawBindingsSHA256,
    rawControlSha256: worker.rawControlSHA256,
    selectedFlagsSha256: sha256(canonicalSorted(worker.selectedFlags)),
    schedulesSha256: sha256(canonicalSorted(worker.schedules)),
  });
}

export function buildCurrentStagingV4ControlSnapshot(readResult, application) {
  const target = TARGETS[application];
  if (!target || !readResult || readResult.accountId !== '846c924bf17bf4f3dd15c97a4c5d1d51'
    || readResult.environment !== 'staging' || !Number.isFinite(Date.parse(readResult.observedAt))
    || new Date(readResult.observedAt).toISOString() !== readResult.observedAt) throw safeError('current_controls_read_result_invalid');
  const controls = controlPinFromCapsule(readResult, application, { requireOffFlags: false });
  return deepFreeze({ schemaVersion: 1, observedAt: readResult.observedAt,
    accountId: readResult.accountId, environment: readResult.environment, databaseId: target.databaseId,
    workerName: target.worker, binding: target.binding, controls });
}

const CONTROL_KEYS = Object.freeze(['schemaVersion', 'observedAt', 'accountId', 'environment', 'databaseId', 'workerName', 'binding', 'controls']);

export function assertFreshStagingV4Controls(snapshot, target, expectedControls, now = Date.now()) {
  if (!snapshot || Object.getPrototypeOf(snapshot) !== Object.prototype || Object.keys(snapshot).sort().join(',')
    !== [...CONTROL_KEYS].sort().join(',') || snapshot.schemaVersion !== 1
    || !Number.isFinite(Date.parse(snapshot.observedAt)) || new Date(snapshot.observedAt).toISOString() !== snapshot.observedAt) {
    throw safeError('current_controls_snapshot_invalid');
  }
  const observed = Date.parse(snapshot.observedAt);
  if (observed > now + STAGING_V4_CONTROL_FUTURE_SKEW_MS || now - observed > STAGING_V4_CONTROL_MAX_AGE_MS) {
    throw safeError('current_controls_snapshot_stale');
  }
  if (snapshot.accountId !== target.accountId || snapshot.environment !== 'staging'
    || snapshot.databaseId !== target.databaseId || snapshot.workerName !== target.worker
    || snapshot.binding !== target.binding || canonicalSorted(snapshot.controls) !== canonicalSorted(expectedControls)) {
    throw safeError('current_controls_drift');
  }
  return true;
}

export function readCapturedStagingV4Capsule(file) {
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== STAGING_V4_CAPSULE_SHA256) throw safeError('controls_capsule_sha256_mismatch');
  let capsule;
  try { capsule = JSON.parse(bytes.toString('utf8')); } catch { throw safeError('controls_capsule_invalid_json'); }
  if (capsule.schemaVersion !== 1 || capsule.environment !== 'staging'
    || capsule.accountId !== '846c924bf17bf4f3dd15c97a4c5d1d51'
    || capsule.secretValuesPersisted !== false || capsule.applicationRowsRead !== 0 || capsule.resourceWrites !== 0
    || !capsule.schema || typeof capsule.schema !== 'object') throw safeError('controls_capsule_scope_invalid');
  const byApp = {};
  const controls = {};
  for (const application of ['operations', 'client']) {
    const key = application === 'operations' ? 'OPS_DB' : 'DELIVERY_DB';
    const target = TARGETS[application], source = capsule.schema[key];
    const pin = controlPinFromCapsule(capsule, application);
    if (!source || source.id !== target.databaseId || !Array.isArray(source.results) || source.results.length !== 3
      || !Array.isArray(source.results[0]) || !Array.isArray(source.results[1]) || !Array.isArray(source.results[2])) {
      throw safeError(`${application}_capsule_shape_invalid`);
    }
    validateSnapshotRows(application, source.results[0], source.results[1], source.results[2]);
    byApp[application] = { ledger: source.results[0], schema: source.results[1], parent: source.results[2] };
    controls[application] = pin;
  }
  const verified = deepFreeze({ capsuleSha256: STAGING_V4_CAPSULE_SHA256,
    accountId: capsule.accountId, environment: capsule.environment,
    observedAt: capsule.observedAt, byApplication: byApp, controls });
  verifiedCapsules.add(verified);
  return verified;
}

function chunkSchema(schema) {
  const chunks = [];
  let current = [];
  for (const row of schema) {
    const candidate = [...current, row];
    if (Buffer.byteLength(canonical(candidate), 'utf8') > STAGING_V4_SCHEMA_CHUNK_BYTES) {
      if (!current.length) throw safeError('schema_object_exceeds_chunk_limit');
      chunks.push(current); current = [row];
      if (Buffer.byteLength(canonical(current), 'utf8') > STAGING_V4_SCHEMA_CHUNK_BYTES) throw safeError('schema_object_exceeds_chunk_limit');
    } else current = candidate;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function validateBatchLimits(batch) {
  if (!Array.isArray(batch) || batch.length > STAGING_V4_MAX_BATCH_STATEMENTS) throw safeError('batch_statement_limit');
  for (const item of batch) {
    if (Buffer.byteLength(item.sql, 'utf8') > STAGING_V4_MAX_SQL_BYTES) throw safeError('sql_statement_limit');
    if (!Array.isArray(item.params) || item.params.length > STAGING_V4_MAX_PARAMS) throw safeError('sql_parameter_count_limit');
    for (const value of item.params) {
      if (Buffer.byteLength(typeof value === 'string' ? value : canonical(value), 'utf8') > STAGING_V4_MAX_PARAM_BYTES) {
        throw safeError('sql_parameter_value_limit');
      }
    }
  }
  if (Buffer.byteLength(canonical({ batch }), 'utf8') > MAX_BATCH_BYTES) throw safeError('batch_request_size_limit');
}

function guardBatch({ application, migration, schema, ledgerRows, runId, stepIndex }) {
  const target = TARGETS[application];
  const guard = `__codex_staging_v4_${runId.replaceAll('-', '')}_${String(stepIndex).padStart(2, '0')}`;
  if (schema.some(row => row.name === guard)) throw safeError('guard_name_collision');
  const chunks = chunkSchema(schema);
  const batch = [{ sql: `CREATE TABLE "${guard}"(chunk_index INTEGER PRIMARY KEY,ok INTEGER NOT NULL CHECK(ok=1))`, params: [] }];
  const schemaGuardSql = `INSERT INTO "${guard}"(chunk_index,ok) SELECT ?,CASE WHEN
    (SELECT COUNT(*) FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'
      AND type IN ('table','view','index','trigger'))=?
    AND NOT EXISTS(SELECT 1 FROM json_each(?) expected LEFT JOIN sqlite_schema current
      ON current.type=json_extract(expected.value,'$.type') AND current.name=json_extract(expected.value,'$.name')
      WHERE current.name IS NULL OR current.tbl_name IS NOT json_extract(expected.value,'$.tbl_name')
        OR current.sql IS NOT json_extract(expected.value,'$.sql'))
    THEN 1 ELSE 0 END`;
  chunks.forEach((chunk, index) => batch.push({ sql: schemaGuardSql,
    params: [index, schema.length + 1, canonical(chunk)] }));
  const ledgerSql = `INSERT INTO "${guard}"(chunk_index,ok) SELECT ?,CASE WHEN
    (SELECT COUNT(*) FROM d1_migrations)=?
    AND NOT EXISTS(SELECT 1 FROM json_each(?) expected LEFT JOIN d1_migrations actual
      ON actual.id=CAST(json_extract(expected.value,'$.id') AS INTEGER)
      WHERE actual.id IS NULL OR actual.name IS NOT json_extract(expected.value,'$.name'))
    THEN 1 ELSE 0 END`;
  batch.push({ sql: ledgerSql, params: [chunks.length, ledgerRows.length, canonical(ledgerRows)] });
  batch.push({ sql: `INSERT INTO "${guard}"(chunk_index,ok) SELECT ?,CASE WHEN
    (SELECT COUNT(*) FROM "${guard}")=? THEN 1 ELSE 0 END`, params: [chunks.length + 1, chunks.length + 1] });
  batch.push({ sql: `DROP TABLE "${guard}"`, params: [] });
  batch.push(...migration.statements.map(sql => ({ sql, params: [] })));
  batch.push({ sql: 'INSERT INTO d1_migrations(id,name) VALUES(?,?)',
    params: [ledgerRows.length + 1, migration.name] });
  validateBatchLimits(batch);
  return Object.freeze({ guard, chunks: chunks.length, batch: Object.freeze(batch.map(item => Object.freeze({
    sql: item.sql, params: Object.freeze(item.params),
  }))) });
}

function ledgerDigest(rows) { return sha256(rows.map(row => row.name).join('\n')); }
function schemaDigest(rows) { return sha256(canonical(rows)); }
function getSchemaRows(db) { return db.prepare(INTERNAL_SCHEMA_SQL).all().map(row => ({ type: row.type, name: row.name, tbl_name: row.tbl_name, sql: row.sql })); }
function cloneCapturedSchema(schema, ledger) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  try {
    for (const type of ['table', 'index', 'view', 'trigger']) {
      for (const row of schema.filter(item => item.type === type)) db.exec(row.sql);
    }
    const recreated = getSchemaRows(db);
    assert.deepEqual(recreated, schema, 'Node SQLite recreation must preserve every captured schema definition exactly');
    const ledgerShape = schema.find(row => row.type === 'table' && row.name === 'd1_migrations');
    assert(ledgerShape, 'migration ledger table required');
    const insert = db.prepare('INSERT INTO d1_migrations(id,name) VALUES(?,?)');
    for (const row of ledger) insert.run(row.id, row.name);
    return db;
  } catch (error) { db.close(); throw error; }
}

function migrationBytes(application, migration, root) {
  const file = path.join(root, 'apps', application, 'migrations', migration.name);
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== migration.sha256 || gitBlobOid(bytes) !== migration.blobOid) throw safeError('migration_source_pin_mismatch');
  const sql = bytes.toString('utf8');
  if (!Buffer.from(sql, 'utf8').equals(bytes)) throw safeError('migration_utf8_invalid');
  const statements = splitMigrationSql(sql.replace(/\r\n/gu, '\n'), application);
  if (!statements.length || statements.some(statement => Buffer.byteLength(statement, 'utf8') > STAGING_V4_MAX_SQL_BYTES)) {
    throw safeError('migration_statement_set_invalid');
  }
  return Object.freeze({ ...migration, bytes: bytes.length, statements: Object.freeze(statements) });
}

export function compileStagingV4MigrationPlan({ capsule, application, runId = randomUUID(), root = ROOT } = {}) {
  if (!capsule || !verifiedCapsules.has(capsule) || capsule.capsuleSha256 !== STAGING_V4_CAPSULE_SHA256
    || !capsule.byApplication?.[application]) {
    throw safeError('pinned_controls_capsule_required');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(runId)) throw safeError('run_id_invalid');
  const target = TARGETS[application], base = capsule.byApplication[application];
  validateSnapshotRows(application, base.ledger, base.schema, base.parent);
  const db = cloneCapturedSchema(base.schema, base.ledger);
  const migrations = MIGRATIONS[application].map(migration => migrationBytes(application, migration, root));
  const steps = [];
  try {
    for (const [stepIndex, migration] of migrations.entries()) {
      const schema = getSchemaRows(db);
      const ledger = db.prepare('SELECT id,name FROM d1_migrations ORDER BY id').all();
      const batch = guardBatch({ application, migration, schema, ledgerRows: ledger, runId, stepIndex });
      const pre = Object.freeze({ schemaObjects: schema.length, schemaSha256: schemaDigest(schema),
        ledgerRows: ledger.length, ledgerNamesSha256: ledgerDigest(ledger), ledgerRowsSha256: sha256(canonical(ledger)) });
      // Replay only in this in-memory qualification database. It creates the
      // next separately guarded step; no provider or durable target is opened.
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const [statementIndex, item] of batch.batch.entries()) {
          try { db.prepare(item.sql).run(...item.params); }
          catch (error) {
            const failure = safeError(`offline_batch_statement_${statementIndex}_failed`);
            failure.cause = error;
            throw failure;
          }
        }
        db.exec('COMMIT');
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
      const postSchema = getSchemaRows(db);
      const postLedger = db.prepare('SELECT id,name FROM d1_migrations ORDER BY id').all();
      const step = Object.freeze({ application, migration: migration.name, migrationSha256: migration.sha256,
        intentId: sha256(`${target.databaseId}\0${migration.name}\0${pre.schemaSha256}\0${pre.ledgerRowsSha256}`).slice(0, 32),
        target: Object.freeze({ accountId: '846c924bf17bf4f3dd15c97a4c5d1d51', worker: target.worker,
          binding: target.binding, databaseName: target.databaseName, databaseId: target.databaseId }),
        controls: capsule.controls[application],
        pre, post: Object.freeze({ schemaObjects: postSchema.length, schemaSha256: schemaDigest(postSchema),
          ledgerRows: postLedger.length, ledgerNamesSha256: ledgerDigest(postLedger), ledgerRowsSha256: sha256(canonical(postLedger)) }),
        guardChunks: batch.chunks, requestBody: Object.freeze({ batch: batch.batch }),
        requestBodySha256: sha256(canonical({ batch: batch.batch })),
        statementCount: batch.batch.length, parameterBytesMax: Math.max(0, ...batch.batch.flatMap(item => item.params
          .map(value => Buffer.byteLength(typeof value === 'string' ? value : canonical(value), 'utf8')))),
        schemaComparisonComplete: true, ddlAfterAllGuards: true, retryAllowed: false });
      compiledSteps.add(step);
      steps.push(step);
    }
  } finally { db.close(); }
  return deepFreeze({ schemaVersion: 1, profile: 'staging-v4-inquiries-narrow-migrations', runId,
    environment: 'staging', capsuleSha256: capsule.capsuleSha256, targetApplication: application, steps: Object.freeze(steps),
    providerAccessed: false, providerWrites: 0, executed: false, deployed: false,
    featureFlagsChanged: false, grantsChanged: false, retriesAllowed: false });
}

export function validatePreparedStagingV4Plan(plan, capsule, { root = ROOT } = {}) {
  if (!plan || plan.schemaVersion !== 1 || plan.profile !== 'staging-v4-inquiries-narrow-migrations'
    || plan.capsuleSha256 !== STAGING_V4_CAPSULE_SHA256 || !['operations', 'client'].includes(plan.targetApplication)) {
    throw safeError('prepared_plan_invalid');
  }
  const rebuilt = compileStagingV4MigrationPlan({ capsule, application: plan.targetApplication, runId: plan.runId, root });
  if (canonical(plan) !== canonical(rebuilt)) throw safeError('prepared_plan_content_mismatch');
  return rebuilt;
}

function assertRegularPathChain(targetPath, allowMissingLeaf = false) {
  const absolute = path.resolve(targetPath);
  const root = path.parse(absolute).root;
  let current = root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (allowMissingLeaf && index === parts.length - 1 && error?.code === 'ENOENT') return false;
      throw safeError('fixed_private_journal_path_invalid');
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw safeError('fixed_private_journal_path_invalid');
    }
  }
  return true;
}

function verifyJournalAcl({ child = false, file } = {}) {
  const helper = path.join(ROOT, 'scripts/verify-staging-v4-journal-acl.ps1');
  const args = ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', helper,
    '-LiteralParent', STAGING_V4_JOURNAL_PARENT];
  if (child) args.push('-LiteralChild', STAGING_V4_JOURNAL_ROOT);
  if (file) args.push('-LiteralFile', file);
  const result = spawnSync('powershell.exe', args, { windowsHide: true, encoding: 'utf8', timeout: 30000,
    stdio: ['ignore', 'ignore', 'ignore'] });
  if (result.error || result.status !== 0) throw safeError('private_journal_acl_verification_failed');
}

function rejectLegacyJournalMarkers() {
  if (!assertRegularPathChain(STAGING_V4_LEGACY_JOURNAL_ROOT, true)) return;
  const stat = fs.lstatSync(STAGING_V4_LEGACY_JOURNAL_ROOT);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw safeError('legacy_journal_path_invalid');
  const names = fs.readdirSync(STAGING_V4_LEGACY_JOURNAL_ROOT);
  if (names.some(isStagingV4LegacyJournalMarker)) throw safeError('legacy_journal_contains_markers');
}

function ensureFixedJournalRoot() {
  if (process.platform !== 'win32' || path.resolve(STAGING_V4_JOURNAL_PARENT) !== STAGING_V4_JOURNAL_PARENT
    || path.resolve(STAGING_V4_JOURNAL_ROOT) !== STAGING_V4_JOURNAL_ROOT
    || path.dirname(STAGING_V4_JOURNAL_ROOT) !== STAGING_V4_JOURNAL_PARENT) throw safeError('fixed_private_journal_unavailable');
  if (!assertRegularPathChain(STAGING_V4_JOURNAL_PARENT)) throw safeError('fixed_private_journal_parent_missing');
  verifyJournalAcl();
  rejectLegacyJournalMarkers();
  if (!assertRegularPathChain(STAGING_V4_JOURNAL_ROOT, true)) {
    // This dedicated directory inherits the already-reviewed private parent ACL.
    // Never create parents recursively or change permissions here.
    fs.mkdirSync(STAGING_V4_JOURNAL_ROOT);
  }
  assertRegularPathChain(STAGING_V4_JOURNAL_ROOT);
  verifyJournalAcl({ child: true });
}

function writeOnce(file, value) {
  ensureFixedJournalRoot();
  if (path.dirname(path.resolve(file)) !== STAGING_V4_JOURNAL_ROOT) throw safeError('fixed_private_journal_path_invalid');
  const bytes = Buffer.from(`${canonical(value)}\n`, 'utf8');
  const createFd = fs.openSync(file, 'wx');
  fs.closeSync(createFd);
  verifyJournalAcl({ child: true, file });
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw safeError('private_journal_file_invalid');
  const fd = fs.openSync(file, 'r+');
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function snapshotMatches(snapshot, expected, target) {
  if (!snapshot) return false;
  if (snapshot.accountId !== target.accountId || snapshot.environment !== 'staging'
    || snapshot.databaseId !== target.databaseId || snapshot.workerName !== target.worker || snapshot.binding !== target.binding
    || snapshot.readOnly !== true || snapshot.servedByPrimary !== true
    || !Number.isFinite(Date.parse(snapshot.observedAt)) || new Date(snapshot.observedAt).toISOString() !== snapshot.observedAt) return false;
  if (Array.isArray(snapshot.schema) && Array.isArray(snapshot.ledger)) {
    return snapshot.schema.length === expected.schemaObjects && schemaDigest(snapshot.schema) === expected.schemaSha256
      && snapshot.ledger.length === expected.ledgerRows && ledgerDigest(snapshot.ledger) === expected.ledgerNamesSha256
      && sha256(canonical(snapshot.ledger)) === expected.ledgerRowsSha256;
  }
  // A reviewed read adapter may return only the exact digests it just computed
  // from the complete ordered result sets; it must not invent partial counts.
  return snapshot.schemaObjects === expected.schemaObjects && snapshot.schemaSha256 === expected.schemaSha256
    && snapshot.ledgerRows === expected.ledgerRows && snapshot.ledgerNamesSha256 === expected.ledgerNamesSha256
    && snapshot.ledgerRowsSha256 === expected.ledgerRowsSha256;
}

/**
 * Separate execution seam. It never resolves credentials or creates a client;
 * callers must supply a reviewed provider adapter. The attempt marker is
 * exclusive and written before the single submission. Any uncertain outcome
 * leaves it behind and blocks replay.
 */
export async function executePreparedStagingV4Step(step, options = {}) {
  const allowedOptions = ['readSnapshot', 'readControls', 'executeBatch', 'now'];
  if (!options || Object.getPrototypeOf(options) !== Object.prototype
    || Object.keys(options).some(key => !allowedOptions.includes(key))) throw safeError('executor_options_invalid');
  const { readSnapshot, readControls, executeBatch, now = () => new Date().toISOString() } = options;
  if (!step || step.target?.accountId !== '846c924bf17bf4f3dd15c97a4c5d1d51'
    || !compiledSteps.has(step) || !['operations', 'client'].includes(step.application)
    || typeof readSnapshot !== 'function' || typeof readControls !== 'function' || typeof executeBatch !== 'function') {
    throw safeError('reviewed_execution_adapter_required');
  }
  const { attempt: attemptPath, completion: completionPath } = stagingV4JournalPaths(step.intentId);
  if (fs.existsSync(attemptPath)) throw safeError('attempt_exists_reconcile_only');
  if (fs.existsSync(completionPath)) throw safeError('completion_exists_reconcile_only');
  let beforeControls, before;
  try {
    before = await readSnapshot(step.target);
  } catch { throw safeError('current_preflight_read_unavailable'); }
  if (!snapshotMatches(before, step.pre, step.target)) throw safeError('preflight_snapshot_mismatch');
  try {
    beforeControls = await readControls(step.target);
    const beforeNowValue = now();
    const beforeNowMs = typeof beforeNowValue === 'number' ? beforeNowValue : Date.parse(beforeNowValue);
    if (!Number.isFinite(beforeNowMs)) throw safeError('executor_clock_invalid');
    if (beforeNowMs - Date.parse(before.observedAt) > STAGING_V4_CONTROL_MAX_AGE_MS
      || Date.parse(before.observedAt) > beforeNowMs + STAGING_V4_CONTROL_FUTURE_SKEW_MS) throw safeError('schema_snapshot_stale');
    assertFreshStagingV4Controls(beforeControls, step.target, step.controls, beforeNowMs);
  } catch { throw safeError('current_preflight_read_unavailable'); }
  const nowValue = now();
  const attempt = Object.freeze({ schemaVersion: 1, status: 'submitted-outcome-must-be-reconciled',
    intentId: step.intentId, application: step.application, migration: step.migration,
    migrationSha256: step.migrationSha256, target: step.target, pre: step.pre, controls: step.controls,
    requestBodySha256: step.requestBodySha256, attemptedAt: nowValue, retryAllowed: false });
  try { writeOnce(attemptPath, attempt); }
  catch (error) { if (error?.code === 'EEXIST') throw safeError('attempt_exists_reconcile_only'); throw error; }
  let response;
  try { response = await executeBatch(step.target, step.requestBody); }
  catch { throw safeError('submission_outcome_uncertain_reconcile_only'); }
  if (!response || response.success !== true) throw safeError('submission_response_uncertain_reconcile_only');
  let afterControls, after;
  try {
    after = await readSnapshot(step.target);
    afterControls = await readControls(step.target);
    const postNowValue = now();
    const postNowMs = typeof postNowValue === 'number' ? postNowValue : Date.parse(postNowValue);
    if (!Number.isFinite(postNowMs)) throw safeError('executor_clock_invalid');
    if (postNowMs - Date.parse(after.observedAt) > STAGING_V4_CONTROL_MAX_AGE_MS
      || Date.parse(after.observedAt) > postNowMs + STAGING_V4_CONTROL_FUTURE_SKEW_MS) throw safeError('schema_snapshot_stale');
    assertFreshStagingV4Controls(afterControls, step.target, step.controls, postNowMs);
  }
  catch { throw safeError('postcheck_unavailable_reconcile_only'); }
  if (!snapshotMatches(after, step.post, step.target)) throw safeError('postcheck_mismatch_reconcile_only');
  const completion = Object.freeze({ schemaVersion: 1, status: 'postchecked', intentId: step.intentId,
    application: step.application, migration: step.migration, target: step.target, controls: step.controls,
    requestBodySha256: step.requestBodySha256, post: step.post, postcheckedAt: now(), retryAllowed: false });
  try { writeOnce(completionPath, completion); }
  catch { throw safeError('completion_receipt_write_uncertain_reconcile_only'); }
  return completion;
}

export const stagingV4MigrationOperatorProfiles = TARGETS;
