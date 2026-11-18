'use strict';

// Staging cleanup must never delete the only copy of a file, must work on
// filesystems whose ACLs override chmod without accepting an unsafe folder,
// must stop retrying a job that keeps failing, must give failed imports a
// cleanup path, and trash purge must make progress past failing entries.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const {
  KEPT_FILES_ROOT, MAX_CLEANUP_ATTEMPTS, journalFailedImportStagingCleanups, processOneImportCleanup, quarantinePrivacy,
} = require('../server/importCleanup');
const { ProcessingRepository } = require('../server/processingRepository');
const { StorageManager } = require('../server/storageManager');
const { purgeExpiredTrash, summarizeTrashPurge } = require('../server/storageLifecycle');

const linux = { skip: process.platform !== 'linux' && 'needs /proc/self/fd and POSIX modes' };
const START = Date.parse('2026-11-01T12:00:00.000Z');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-cleanup-preserve-'));
  const config = {
    datasetsMount: path.join(root, 'datasets'),
    modelsMount: path.join(root, 'models'),
    cacheMount: path.join(root, 'cache'),
    trashMount: path.join(root, 'trash'),
    datasetImportMount: path.join(root, 'imports'),
    storageReserveBytes: 0,
    storageReservePercent: 0,
  };
  const db = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(db);
  const storage = new StorageManager(config);
  storage.initialize();
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const logs = { log: [], warn: [] };
  const log = { log: (line) => logs.log.push(line), warn: (line) => logs.warn.push(line) };
  return { config, db, processing, root, storage, logs, log };
}

function writeFile(root, relative, bytes) {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
}

// A finalized dataset whose files exist on disk and in dataset_files.
function finalizedDataset(c, { projectId = null, files = {}, registry = {} } = {}) {
  const id = crypto.randomUUID();
  c.processing.createDataset({ id, projectId, displayName: `Dataset ${id.slice(0, 8)}`, storageMode: 'adopted', rootKey: 'datasets', relativePath: id, status: 'finalizing' });
  const rows = [];
  for (const [relative, bytes] of Object.entries(files)) {
    writeFile(path.join(c.config.datasetsMount, id), relative, bytes);
    const recorded = registry[relative] || bytes;
    rows.push({ relativePath: relative, byteSize: recorded.length, sha256: sha(recorded) });
  }
  c.processing.finalizeDataset(id, rows, sha(JSON.stringify(rows)));
  return id;
}

function readyStaging(c, datasetId, files) {
  const id = crypto.randomUUID(), createdAt = new Date(START - 60_000).toISOString(), relativePath = `webodm-task-imports/${id}`;
  c.db.prepare(`INSERT INTO retained_imports(id,dataset_id,source_kind,source_root_key,source_relative_path,staging_root_key,
    staging_relative_path,cleanup_jobs_inserted,state,created_at,updated_at) VALUES (?,?,'server_folder','dataset_import',?,'cache',?,1,'ready',?,?)`)
    .run(id, datasetId, `sources/${id}`, relativePath, createdAt, createdAt);
  c.processing.journalRetainedImportCleanup(c.db.prepare('SELECT * FROM retained_imports WHERE id=?').get(id), createdAt);
  const staging = path.join(c.config.cacheMount, ...relativePath.split('/'));
  for (const [relative, bytes] of Object.entries(files)) writeFile(staging, relative, bytes);
  return { id, cleanupId: `${id}:staging`, staging };
}

const job = (c, id) => c.db.prepare('SELECT * FROM import_cleanup_jobs WHERE id=?').get(id);
const run = (c, at = START, options = {}) => processOneImportCleanup(
  { processing: c.processing, storage: c.storage }, 'cleanup-worker', { now: () => at, log: c.log, ...options },
);

function fakeStat({ uid = 1000n, gid = 1000n, mode = 0o40700, dev = 7n, directory = true, symlink = false } = {}) {
  return { uid, gid, mode: BigInt(mode), dev, isDirectory: () => directory, isSymbolicLink: () => symlink };
}
const ids = { uid: 1000n, gid: 1000n };

test('privacy check accepts a private quarantine', () => {
  assert.deepEqual(quarantinePrivacy(fakeStat({ mode: 0o40700 }), fakeStat({ mode: 0o40755 }), ids), { ok: true, method: 'mode' });
});

test('privacy check refuses group or other access it cannot justify', () => {
  const privateRoot = fakeStat({ mode: 0o40770 });
  assert.equal(quarantinePrivacy(fakeStat({ mode: 0o40707 }), privateRoot, ids).reason, 'other_users_have_access');
  assert.equal(quarantinePrivacy(fakeStat({ mode: 0o40701 }), privateRoot, ids).reason, 'other_users_have_access');
  assert.equal(quarantinePrivacy(fakeStat({ mode: 0o40770, gid: 33n }), privateRoot, ids).reason, 'foreign_group_has_access');
  assert.equal(quarantinePrivacy(fakeStat({ mode: 0o40770 }), fakeStat({ mode: 0o40775 }), ids).reason, 'cleanup_root_not_private');
  assert.equal(quarantinePrivacy(fakeStat({ mode: 0o40770 }), fakeStat({ mode: 0o40770, uid: 0n }), ids).reason, 'cleanup_root_not_private');
  assert.equal(quarantinePrivacy(fakeStat({ mode: 0o40700, uid: 0n }), privateRoot, ids).reason, 'not_owned_by_worker');
});

test('privacy check refuses symlinks and folders outside the cleanup root', () => {
  const root = fakeStat({ mode: 0o40770 });
  assert.equal(quarantinePrivacy(fakeStat({ symlink: true }), root, ids).reason, 'not_a_directory');
  assert.equal(quarantinePrivacy(fakeStat({ directory: false }), root, ids).reason, 'not_a_directory');
  assert.equal(quarantinePrivacy(fakeStat({ dev: 8n }), root, ids).reason, 'outside_cleanup_root');
  assert.equal(quarantinePrivacy(fakeStat(), null, ids).reason, 'outside_cleanup_root');
});

test('privacy check accepts inherited group access only inside a private root', () => {
  assert.deepEqual(quarantinePrivacy(fakeStat({ mode: 0o40770 }), fakeStat({ mode: 0o40770 }), ids), { ok: true, method: 'inherited_acl' });
  assert.deepEqual(quarantinePrivacy(fakeStat({ mode: 0o40750 }), fakeStat({ mode: 0o40750 }), ids), { ok: true, method: 'inherited_acl' });
});

// Emulates a ZFS dataset with inherited ACLs: the explicit chmod does not make
// the new quarantine private, it keeps the group bits its parent grants.
const aclChmod = { chmodQuarantine: (fd) => fs.fchmodSync(fd, 0o770) };

test('a filesystem that ignores chmod cleans up when the cleanup root is private', linux, async (t) => {
  const c = fixture(t);
  const photo = Buffer.from('photo bytes');
  const datasetId = finalizedDataset(c, { files: { 'images/DJI_0001.JPG': photo } });
  const staging = readyStaging(c, datasetId, { 'extracted/images/DJI_0001.JPG': photo });
  fs.chmodSync(c.config.cacheMount, 0o770);

  assert.equal(await run(c, START, { hooks: aclChmod }), true);
  assert.equal(job(c, staging.cleanupId).status, 'complete', job(c, staging.cleanupId).last_error);
  assert.equal(fs.existsSync(staging.staging), false);
});

test('a filesystem that ignores chmod is refused when the cleanup root is shared', linux, async (t) => {
  const c = fixture(t);
  const photo = Buffer.from('photo bytes');
  const datasetId = finalizedDataset(c, { files: { 'images/DJI_0001.JPG': photo } });
  const staging = readyStaging(c, datasetId, { 'extracted/images/DJI_0001.JPG': photo });
  fs.chmodSync(c.config.cacheMount, 0o775);

  assert.equal(await run(c, START, { hooks: aclChmod }), true);
  const row = job(c, staging.cleanupId);
  assert.equal(row.status, 'pending');
  assert.match(row.last_error, /^cleanup_path_untrusted: .*cleanup_root_not_private/);
  assert.equal(fs.readFileSync(path.join(staging.staging, 'extracted', 'images', 'DJI_0001.JPG')).equals(photo), true);
});

test('a symlinked quarantine is refused and nothing is moved', linux, async (t) => {
  const c = fixture(t);
  const photo = Buffer.from('photo bytes');
  const datasetId = finalizedDataset(c, { files: { 'a.jpg': photo } });
  const staging = readyStaging(c, datasetId, { 'a.jpg': photo });
  const first = c.processing.claimImportCleanup('intent-worker', { leaseSeconds: 30, at: START });
  const intent = c.processing.persistImportCleanupQuarantineIntent(first.id, 'intent-worker', first.lease_token, first.lease_generation, { at: START + 1 });
  const elsewhere = path.join(c.root, 'elsewhere');
  fs.mkdirSync(elsewhere, { mode: 0o700 });
  fs.symlinkSync(elsewhere, path.join(c.config.cacheMount, ...intent.split('/')));
  c.db.prepare('UPDATE import_cleanup_jobs SET lease_expires_at=? WHERE id=?').run(new Date(START + 29_999).toISOString(), first.id);

  assert.equal(await run(c, START + 30_000), true);
  assert.notEqual(job(c, staging.cleanupId).status, 'complete');
  assert.equal(fs.readFileSync(path.join(staging.staging, 'a.jpg')).equals(photo), true);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('staging cleanup keeps files with no dataset copy, including the georeferenced LAZ', linux, async (t) => {
  const c = fixture(t);
  const photo = Buffer.from('identical photo bytes');
  const laz = Buffer.from('LASF full density georeferenced point cloud');
  const datasetPhoto = Buffer.from('dataset photo A');
  const stagingPhoto = Buffer.from('staging photo B'); // same size, different bytes
  assert.equal(datasetPhoto.length, stagingPhoto.length);
  const datasetId = finalizedDataset(c, { files: { 'DJI_0001.JPG': photo, 'DJI_0002.JPG': datasetPhoto } });
  const staging = readyStaging(c, datasetId, {
    'extracted/DJI_0001.JPG': photo,
    'extracted/DJI_0002.JPG': stagingPhoto,
    'extracted/odm_georeferencing/odm_georeferenced_model.laz': laz,
    'extracted/images/copy-of-DJI_0001.JPG': photo,
  });

  assert.equal(await run(c), true);
  const row = job(c, staging.cleanupId);
  assert.equal(row.status, 'complete', row.last_error);
  assert.equal(fs.existsSync(staging.staging), false);

  const kept = path.join(c.config.cacheMount, KEPT_FILES_ROOT, staging.id);
  assert.equal(fs.readFileSync(path.join(kept, 'extracted', 'odm_georeferencing', 'odm_georeferenced_model.laz')).equals(laz), true);
  assert.equal(fs.readFileSync(path.join(kept, 'extracted', 'DJI_0002.JPG')).equals(stagingPhoto), true, 'hash mismatch is kept');
  assert.equal(fs.existsSync(path.join(kept, 'extracted', 'DJI_0001.JPG')), false, 'duplicate is removed');
  assert.equal(fs.existsSync(path.join(kept, 'extracted', 'images')), false, 'duplicate under another name is removed');
  const manifestName = fs.readdirSync(kept).find((name) => /^kept-files\.\d+\.json$/.test(name));
  const manifest = JSON.parse(fs.readFileSync(path.join(kept, manifestName), 'utf8'));
  assert.deepEqual(manifest.files.map((file) => file.path).sort(), ['extracted/DJI_0002.JPG', 'extracted/odm_georeferencing/odm_georeferenced_model.laz']);
  assert.deepEqual(manifest.comparedDatasetIds, [datasetId]);
  assert.equal(manifest.files.find((file) => file.path.endsWith('.laz')).sha256, sha(laz));

  assert.equal(fs.readFileSync(path.join(c.config.datasetsMount, datasetId, 'DJI_0001.JPG')).equals(photo), true, 'dataset copy untouched');
  const audit = c.db.prepare("SELECT details_json FROM audit_events WHERE action='import_cleanup.kept_unique_files' AND entity_id=?").get(staging.cleanupId);
  assert.equal(JSON.parse(audit.details_json).fileCount, 2);
  assert.ok(c.logs.log.some((line) => line.includes('kept 2 file(s)')));
});

test('a registry row is not enough: a changed dataset file keeps the staging copy', linux, async (t) => {
  const c = fixture(t);
  const original = Buffer.from('original photo bytes');
  const corrupted = Buffer.from('corrupt photo bytes!');
  assert.equal(original.length, corrupted.length);
  // dataset_files says the original is there, but the bytes on disk differ.
  const datasetId = finalizedDataset(c, { files: { 'DJI_0001.JPG': corrupted }, registry: { 'DJI_0001.JPG': original } });
  const staging = readyStaging(c, datasetId, { 'extracted/DJI_0001.JPG': original });

  assert.equal(await run(c), true);
  assert.equal(job(c, staging.cleanupId).status, 'complete');
  const kept = path.join(c.config.cacheMount, KEPT_FILES_ROOT, staging.id, 'extracted', 'DJI_0001.JPG');
  assert.equal(fs.readFileSync(kept).equals(original), true);
});

test('a staging with no finalized dataset is left in place and reported', linux, async (t) => {
  const c = fixture(t);
  const datasetId = finalizedDataset(c, { files: { 'a.jpg': Buffer.from('a') } });
  c.db.prepare("UPDATE datasets SET status='trashed',trashed_at=? WHERE id=?").run(new Date(START).toISOString(), datasetId);
  const staging = readyStaging(c, datasetId, { 'extracted/a.jpg': Buffer.from('a') });

  assert.equal(await run(c), true);
  const row = job(c, staging.cleanupId);
  assert.equal(row.status, 'pending');
  assert.match(row.last_error, /^cleanup_dataset_unavailable:/);
  assert.equal(fs.existsSync(path.join(staging.staging, 'extracted', 'a.jpg')), true);
  assert.ok(c.logs.warn.some((line) => line.includes('cleanup_dataset_unavailable')));
});

test('a job that keeps failing the same way is marked failed and logged', linux, async (t) => {
  const c = fixture(t);
  const datasetId = finalizedDataset(c, { files: { 'a.jpg': Buffer.from('a') } });
  c.db.prepare("UPDATE datasets SET status='trashed',trashed_at=? WHERE id=?").run(new Date(START).toISOString(), datasetId);
  const staging = readyStaging(c, datasetId, { 'extracted/a.jpg': Buffer.from('a') });
  c.db.prepare('UPDATE import_cleanup_jobs SET attempt_count=?,last_error=? WHERE id=?')
    .run(MAX_CLEANUP_ATTEMPTS - 1, 'cleanup_dataset_unavailable: earlier attempt', staging.cleanupId);

  assert.equal(await run(c), true);
  const row = job(c, staging.cleanupId);
  assert.equal(row.status, 'failed');
  assert.equal(row.attempt_count, MAX_CLEANUP_ATTEMPTS);
  assert.match(row.last_error, /^cleanup_retry_exhausted: stopped after 12 attempts; last error cleanup_dataset_unavailable/);
  assert.equal(row.lease_owner, null);
  assert.ok(c.db.prepare("SELECT 1 FROM audit_events WHERE action='import_cleanup.failed' AND entity_id=?").get(staging.cleanupId));
  assert.ok(c.db.prepare("SELECT 1 FROM event_outbox WHERE event_type='import.cleanup_warning'").get());
  assert.ok(c.logs.warn.some((line) => line.includes('marked failed after 12 attempts')));
  assert.equal(c.processing.claimImportCleanup('cleanup-worker', { at: START + 365 * 86400_000 }), null, 'no endless retry');
  assert.equal(fs.existsSync(path.join(staging.staging, 'extracted', 'a.jpg')), true);
  assert.ok(c.processing.retryTerminalImportCleanup(staging.cleanupId, 'operator'), 'operator can re-queue it');
});

test('an old looping job gets a fresh attempt when its error changes', linux, async (t) => {
  const c = fixture(t);
  const datasetId = finalizedDataset(c, { files: { 'a.jpg': Buffer.from('a') } });
  c.db.prepare("UPDATE datasets SET status='trashed',trashed_at=? WHERE id=?").run(new Date(START).toISOString(), datasetId);
  const staging = readyStaging(c, datasetId, { 'extracted/a.jpg': Buffer.from('a') });
  c.db.prepare('UPDATE import_cleanup_jobs SET attempt_count=40,last_error=? WHERE id=?')
    .run('cleanup_path_untrusted: cleanup quarantine is not private to the worker', staging.cleanupId);

  assert.equal(await run(c), true);
  assert.equal(job(c, staging.cleanupId).status, 'pending');
  assert.equal(await run(c, START + 3_600_001), true);
  assert.equal(job(c, staging.cleanupId).status, 'failed');
});

function failedImport(c, { projectId, updatedAt = new Date(START - 8 * 86400_000).toISOString(), status = 'failed' } = {}) {
  const id = crypto.randomUUID();
  const payload = { webodmTaskImport: true, importSource: { kind: 'server_folder' }, request: { projectId, sourceRelativePath: 'operator/flight' }, ids: { datasetId: crypto.randomUUID() } };
  c.db.prepare(`INSERT INTO dataset_operations(id,operation_type,subject,payload_json,status,error_code,available_at,created_at,updated_at)
    VALUES (?,'catalog_map','operator',?,?,'no_supported_assets',?,?,?)`).run(id, JSON.stringify(payload), status, updatedAt, updatedAt, updatedAt);
  return id;
}

test('a failed import gets a staging cleanup that keeps files with no dataset copy', linux, async (t) => {
  const c = fixture(t);
  const project = c.processing.createProject({ displayName: 'Failed import project' });
  const photo = Buffer.from('photo already imported by an earlier task');
  const sideFile = Buffer.from('flight log that exists only here');
  finalizedDataset(c, { projectId: project.id, files: { 'DJI_0001.JPG': photo } });
  const operationId = failedImport(c, { projectId: project.id });
  const staging = path.join(c.config.cacheMount, 'webodm-task-imports', operationId);
  writeFile(staging, 'extracted/DJI_0001.JPG', photo);
  writeFile(staging, 'extracted/DJI_flight.obs', sideFile);
  const recent = failedImport(c, { projectId: project.id, updatedAt: new Date(START - 3600_000).toISOString() });
  writeFile(path.join(c.config.cacheMount, 'webodm-task-imports', recent), 'extracted/x.jpg', photo);
  failedImport(c, { projectId: project.id }); // no staging on disk: nothing to journal

  assert.deepEqual(journalFailedImportStagingCleanups({ processing: c.processing, storage: c.storage }, { now: () => START }), { scanned: 2, journaled: 1 });
  assert.deepEqual(journalFailedImportStagingCleanups({ processing: c.processing, storage: c.storage }, { now: () => START }), { scanned: 1, journaled: 0 }, 'journaling is idempotent');
  const cleanupId = `failed-import:${operationId}:staging`;
  assert.equal(job(c, cleanupId).status, 'pending');

  assert.equal(await run(c), true);
  const row = job(c, cleanupId);
  assert.equal(row.status, 'complete', row.last_error);
  assert.equal(fs.existsSync(staging), false);
  const kept = path.join(c.config.cacheMount, KEPT_FILES_ROOT, operationId, 'extracted');
  assert.equal(fs.readFileSync(path.join(kept, 'DJI_flight.obs')).equals(sideFile), true);
  assert.equal(fs.existsSync(path.join(kept, 'DJI_0001.JPG')), false);
  assert.equal(fs.existsSync(path.join(c.config.cacheMount, 'webodm-task-imports', recent, 'extracted', 'x.jpg')), true, 'grace period respected');
});

test('a failed-import cleanup never runs while the operation is retried', linux, async (t) => {
  const c = fixture(t);
  const project = c.processing.createProject({ displayName: 'Retry project' });
  const photo = Buffer.from('photo');
  finalizedDataset(c, { projectId: project.id, files: { 'a.jpg': photo } });
  const operationId = failedImport(c, { projectId: project.id });
  writeFile(path.join(c.config.cacheMount, 'webodm-task-imports', operationId), 'extracted/a.jpg', photo);
  journalFailedImportStagingCleanups({ processing: c.processing, storage: c.storage }, { now: () => START });

  c.db.prepare("UPDATE dataset_operations SET status='leased' WHERE id=?").run(operationId);
  assert.equal(c.processing.claimImportCleanup('cleanup-worker', { at: START }), null, 'a running import owns its staging');
  c.db.prepare("UPDATE dataset_operations SET status='failed' WHERE id=?").run(operationId);

  const retried = c.processing.retryDatasetOperation(operationId, 'operator');
  assert.equal(retried.status, 'queued');
  assert.equal(job(c, `failed-import:${operationId}:staging`), undefined, 'an idle failed-import cleanup is withdrawn on retry');
  assert.equal(fs.existsSync(path.join(c.config.cacheMount, 'webodm-task-imports', operationId, 'extracted', 'a.jpg')), true);
});

test('a failed-import cleanup with a staging in quarantine blocks an import retry', linux, async (t) => {
  const c = fixture(t);
  const project = c.processing.createProject({ displayName: 'Busy project' });
  finalizedDataset(c, { projectId: project.id, files: { 'a.jpg': Buffer.from('a') } });
  const operationId = failedImport(c, { projectId: project.id });
  writeFile(path.join(c.config.cacheMount, 'webodm-task-imports', operationId), 'extracted/a.jpg', Buffer.from('a'));
  journalFailedImportStagingCleanups({ processing: c.processing, storage: c.storage }, { now: () => START });
  const lease = c.processing.claimImportCleanup('cleanup-worker', { at: START });
  assert.equal(lease.id, `failed-import:${operationId}:staging`);
  assert.equal(c.processing.retryDatasetOperation(operationId, 'operator'), null);
});

test('trash purge does not let failing or deferred entries block the rest', () => {
  const items = [];
  const supersession = new Set();
  for (let index = 0; index < 5; index += 1) {
    const id = crypto.randomUUID(); supersession.add(id); items.push({ id, entityType: 'output', entityId: `superseded-${index}` });
  }
  for (let index = 0; index < 22; index += 1) items.push({ id: crypto.randomUUID(), entityType: 'dataset', entityId: `missing-${index}` });
  const good = { id: crypto.randomUUID(), entityType: 'dataset', entityId: 'external' };
  items.push(good);
  const purged = new Set();
  const processing = {
    database: { prepare: () => ({ get: (trashId) => (supersession.has(trashId) ? { id: 'mutation' } : undefined) }) },
    expiredTrash: () => items.filter((item) => !purged.has(item.id)),
    getDataset: (id) => (id === 'external' ? { id, storageMode: 'external_reference' } : null),
    getModelOutput: () => null,
    markTrashPurged: (id) => { purged.add(id); return true; },
    getTrash: (id) => ({ permanentlyDeletedAt: purged.has(id) ? new Date(START).toISOString() : null }),
  };

  const first = purgeExpiredTrash(processing, null, { limit: 20, now: () => START });
  assert.equal(first.filter((result) => result.status === 'deferred').length, 5, 'deferred entries take no slot');
  assert.equal(first.filter((result) => result.status === 'failed').length, 20);
  assert.equal(purged.has(good.id), false);
  const summary = summarizeTrashPurge(first);
  assert.match(summary.line, /deferred:supersession_reverification_required=5/);
  assert.match(summary.line, /failed:entity_not_found=20/);
  assert.equal(summary.failures.length, 20);
  assert.match(summary.failures[0], /^Trash retention purge failed: trash=[0-9a-f-]{36} code=entity_not_found$/);

  const second = purgeExpiredTrash(processing, null, { limit: 20, now: () => START + 3600_000 });
  assert.equal(second.filter((result) => result.status === 'skipped').length, 20, 'recent failures wait out their backoff');
  assert.equal(purged.has(good.id), true, 'the entry behind them is purged');
  assert.equal(second.find((result) => result.trashId === good.id).status, 'complete');

  const later = purgeExpiredTrash(processing, null, { limit: 20, now: () => START + 7 * 3600_000 });
  assert.equal(later.filter((result) => result.status === 'failed').length, 20, 'failed entries are retried after the backoff');
});
