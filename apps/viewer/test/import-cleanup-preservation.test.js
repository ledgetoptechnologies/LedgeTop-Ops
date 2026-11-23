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
const { storedZip } = require('./helpers/storedZip');

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
  const privateRoot = fakeStat({ mode: 0o40700 });
  assert.equal(quarantinePrivacy(fakeStat({ mode: 0o40707 }), privateRoot, ids).reason, 'other_users_have_access');
  assert.equal(quarantinePrivacy(fakeStat({ mode: 0o40701 }), privateRoot, ids).reason, 'other_users_have_access');
  assert.equal(quarantinePrivacy(fakeStat({ mode: 0o40770, gid: 33n }), privateRoot, ids).reason, 'foreign_group_has_access');
  assert.equal(quarantinePrivacy(fakeStat({ mode: 0o40700, uid: 0n }), privateRoot, ids).reason, 'not_owned_by_worker');
});

test('a shared group on the cleanup root or its parent is not private', () => {
  const quarantine = fakeStat({ mode: 0o40770 });
  // Group access through the worker's own group is refused when the root
  // grants it too: on a NAS the apps group is shared by every app.
  assert.equal(quarantinePrivacy(quarantine, fakeStat({ mode: 0o40770 }), ids).reason, 'cleanup_root_not_private');
  assert.equal(quarantinePrivacy(quarantine, fakeStat({ mode: 0o40750 }), ids).reason, 'cleanup_root_not_private');
  assert.equal(quarantinePrivacy(quarantine, fakeStat({ mode: 0o40700, uid: 0n }), ids).reason, 'cleanup_root_not_private');
  assert.equal(quarantinePrivacy(quarantine, fakeStat({ mode: 0o40700 }), ids, fakeStat({ mode: 0o40770 })).reason, 'cleanup_parent_not_private');
  assert.equal(quarantinePrivacy(quarantine, fakeStat({ mode: 0o40700 }), ids, fakeStat({ mode: 0o40700, dev: 9n })).reason, 'cleanup_parent_not_private');
});

test('privacy check refuses symlinks and folders outside the cleanup root', () => {
  const root = fakeStat({ mode: 0o40700 });
  assert.equal(quarantinePrivacy(fakeStat({ symlink: true }), root, ids).reason, 'not_a_directory');
  assert.equal(quarantinePrivacy(fakeStat({ directory: false }), root, ids).reason, 'not_a_directory');
  assert.equal(quarantinePrivacy(fakeStat({ dev: 8n }), root, ids).reason, 'outside_cleanup_root');
  assert.equal(quarantinePrivacy(fakeStat(), null, ids).reason, 'outside_cleanup_root');
});

test('privacy check accepts inherited group bits only when root and parent are strictly private', () => {
  const strict = fakeStat({ mode: 0o40700 });
  assert.deepEqual(quarantinePrivacy(fakeStat({ mode: 0o40770 }), strict, ids, strict), { ok: true, method: 'private_root' });
  assert.deepEqual(quarantinePrivacy(fakeStat({ mode: 0o40750 }), strict, ids, strict), { ok: true, method: 'private_root' });
});

// Emulates a ZFS dataset with inherited ACLs: the explicit chmod does not make
// the new quarantine private, it keeps the group bits its parent grants.
const aclChmod = { chmodQuarantine: (fd) => fs.fchmodSync(fd, 0o770) };

test('a filesystem that ignores chmod cleans up when the root and parent are private', linux, async (t) => {
  const c = fixture(t);
  const photo = Buffer.from('photo bytes');
  const datasetId = finalizedDataset(c, { files: { 'images/DJI_0001.JPG': photo } });
  const staging = readyStaging(c, datasetId, { 'extracted/images/DJI_0001.JPG': photo });
  fs.chmodSync(c.config.cacheMount, 0o700);
  fs.chmodSync(path.dirname(staging.staging), 0o700);

  assert.equal(await run(c, START, { hooks: aclChmod }), true);
  assert.equal(job(c, staging.cleanupId).status, 'complete', job(c, staging.cleanupId).last_error);
  assert.equal(fs.existsSync(staging.staging), false);
});

for (const scenario of [
  { name: 'the cleanup root is shared with a group', root: 0o770, parent: 0o700, reason: 'cleanup_root_not_private' },
  { name: 'webodm-task-imports is shared with a group', root: 0o700, parent: 0o770, reason: 'cleanup_parent_not_private' },
]) test(`a filesystem that ignores chmod is refused when ${scenario.name}`, linux, async (t) => {
  const c = fixture(t);
  const photo = Buffer.from('photo bytes');
  const datasetId = finalizedDataset(c, { files: { 'images/DJI_0001.JPG': photo } });
  const staging = readyStaging(c, datasetId, { 'extracted/images/DJI_0001.JPG': photo });
  fs.chmodSync(c.config.cacheMount, scenario.root);
  fs.chmodSync(path.dirname(staging.staging), scenario.parent);

  assert.equal(await run(c, START, { hooks: aclChmod }), true);
  let row = job(c, staging.cleanupId);
  assert.equal(row.status, 'pending');
  assert.equal(row.last_error, `cleanup_skipped_not_private: skipped: cache folder not private (${scenario.reason})`);
  assert.equal(row.available_at, new Date(START + 24 * 3600_000).toISOString(), 're-checked daily, not hourly');
  assert.deepEqual(fs.readdirSync(path.dirname(staging.staging)), [staging.id], 'no quarantine folder is left behind');
  assert.equal(fs.readFileSync(path.join(staging.staging, 'extracted', 'images', 'DJI_0001.JPG')).equals(photo), true);

  assert.equal(c.processing.claimImportCleanup('cleanup-worker', { at: START + 3600_000 }), null, 'not retried within the day');
  assert.equal(await run(c, START + 24 * 3600_000, { hooks: aclChmod }), true);
  row = job(c, staging.cleanupId);
  assert.equal(row.status, 'pending');
  assert.notEqual(row.status, 'failed');
  assert.deepEqual(fs.readdirSync(path.dirname(staging.staging)), [staging.id]);
  const warnings = c.db.prepare("SELECT COUNT(*) AS n FROM event_outbox WHERE event_type='import.cleanup_warning'").get().n;
  assert.equal(warnings, 1, 'one warning when the skip starts, not one per run');
  assert.equal(c.logs.warn.filter((line) => line.includes('cache folder not private')).length, 1);
});

test('an empty quarantine left by an earlier run is removed when the folder is not private', linux, async (t) => {
  const c = fixture(t);
  const photo = Buffer.from('photo bytes');
  const datasetId = finalizedDataset(c, { files: { 'a.jpg': photo } });
  const staging = readyStaging(c, datasetId, { 'extracted/a.jpg': photo });
  const first = c.processing.claimImportCleanup('old-worker', { leaseSeconds: 30, at: START });
  const intent = c.processing.persistImportCleanupQuarantineIntent(first.id, 'old-worker', first.lease_token, first.lease_generation, { at: START + 1 });
  const leftover = path.join(c.config.cacheMount, ...intent.split('/'));
  fs.mkdirSync(leftover, { mode: 0o770 });
  fs.chmodSync(leftover, 0o770);
  fs.chmodSync(c.config.cacheMount, 0o770);
  c.db.prepare('UPDATE import_cleanup_jobs SET lease_expires_at=? WHERE id=?').run(new Date(START + 29_999).toISOString(), first.id);

  assert.equal(await run(c, START + 30_000), true);
  assert.match(job(c, staging.cleanupId).last_error, /^cleanup_skipped_not_private:/);
  assert.equal(fs.existsSync(leftover), false);
  assert.equal(fs.existsSync(path.join(staging.staging, 'extracted', 'a.jpg')), true);
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
  const manifest = keptManifest(c, staging.id);
  assert.deepEqual(manifest.map((entry) => entry.path).sort(), ['extracted/DJI_0002.JPG', 'extracted/odm_georeferencing/odm_georeferenced_model.laz']);
  assert.ok(manifest.every((entry) => entry.event === 'kept' && entry.origin === `webodm-task-imports/${staging.id}/${entry.path}`));
  assert.deepEqual(manifest[0].comparedDatasetIds, [datasetId]);
  assert.equal(manifest.find((entry) => entry.path.endsWith('.laz')).sha256, sha(laz));

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
  const otherDatasetId = finalizedDataset(c, { projectId: project.id, files: { 'DJI_0001.JPG': photo } });
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
  const classified = c.db.prepare("SELECT details_json FROM audit_events WHERE action='import_cleanup.staging_classified' AND entity_id=?").get(cleanupId);
  assert.deepEqual(JSON.parse(classified.details_json).reliedOnDatasets, { [otherDatasetId]: 1 }, 'records which dataset was relied on');
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

function keptManifest(c, id) {
  const file = path.join(c.config.cacheMount, KEPT_FILES_ROOT, id, 'kept-files.jsonl');
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function listFiles(root, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(path.join(root, entry.name), relative));
    else files.push(relative);
  }
  return files;
}

function payloadPath(c, cleanupId, relative) {
  const intent = job(c, cleanupId).quarantine_relative_path;
  return path.join(c.config.cacheMount, ...intent.split('/'), 'payload', ...relative.split('/'));
}

test('a dataset file changed between classification and unlink keeps the staging file', linux, async (t) => {
  const c = fixture(t);
  const photo = Buffer.from('identical photo bytes');
  const datasetId = finalizedDataset(c, { files: { 'DJI_0001.JPG': photo } });
  const staging = readyStaging(c, datasetId, { 'extracted/DJI_0001.JPG': photo });
  const datasetFile = path.join(c.config.datasetsMount, datasetId, 'DJI_0001.JPG');

  assert.equal(await run(c, START, { hooks: { afterStagingClassification() { fs.writeFileSync(datasetFile, Buffer.from('rewritten photo bytes')); } } }), true);
  let row = job(c, staging.cleanupId);
  assert.equal(row.status, 'quarantined');
  assert.match(row.last_error, /^cleanup_copy_changed:/);
  assert.equal(fs.readFileSync(payloadPath(c, staging.cleanupId, 'extracted/DJI_0001.JPG')).equals(photo), true, 'staging copy not deleted');

  assert.equal(await run(c, START + 6000), true);
  row = job(c, staging.cleanupId);
  assert.equal(row.status, 'complete', row.last_error);
  const kept = path.join(c.config.cacheMount, KEPT_FILES_ROOT, staging.id, 'extracted', 'DJI_0001.JPG');
  assert.equal(fs.readFileSync(kept).equals(photo), true, 'the only remaining original is kept');
});

test('a dataset trashed between classification and unlink keeps the staging file', linux, async (t) => {
  const c = fixture(t);
  const photo = Buffer.from('identical photo bytes');
  const datasetId = finalizedDataset(c, { files: { 'DJI_0001.JPG': photo } });
  const staging = readyStaging(c, datasetId, { 'extracted/DJI_0001.JPG': photo });

  assert.equal(await run(c, START, { hooks: { afterStagingClassification() {
    c.db.prepare("UPDATE datasets SET status='trashed',trashed_at=? WHERE id=?").run(new Date(START).toISOString(), datasetId);
  } } }), true);
  assert.equal(job(c, staging.cleanupId).status, 'quarantined');
  assert.equal(fs.readFileSync(payloadPath(c, staging.cleanupId, 'extracted/DJI_0001.JPG')).equals(photo), true);

  assert.equal(await run(c, START + 6000), true);
  assert.equal(job(c, staging.cleanupId).status, 'complete');
  assert.equal(fs.readFileSync(path.join(c.config.cacheMount, KEPT_FILES_ROOT, staging.id, 'extracted', 'DJI_0001.JPG')).equals(photo), true);
});

test('a preserve interrupted partway leaves no kept file unlisted', linux, async (t) => {
  const c = fixture(t);
  const datasetId = finalizedDataset(c, { files: { 'DJI_0001.JPG': Buffer.from('dataset photo') } });
  const staging = readyStaging(c, datasetId, {
    'extracted/a.laz': Buffer.from('unique point cloud A'),
    'extracted/b.log': Buffer.from('unique log B'),
    'extracted/c.pdf': Buffer.from('unique report C'),
  });
  let interrupted = false;
  assert.equal(await run(c, START, { hooks: { beforeKeepRename({ index }) {
    if (index === 1 && !interrupted) { interrupted = true; throw Object.assign(new Error('simulated crash'), { code: 'simulated_crash' }); }
  } } }), true);
  assert.equal(interrupted, true);
  const keptRoot = path.join(c.config.cacheMount, KEPT_FILES_ROOT, staging.id);
  assert.deepEqual(listFiles(keptRoot).filter((name) => name !== 'kept-files.jsonl'), ['extracted/a.laz']);
  const afterCrash = keptManifest(c, staging.id).map((entry) => entry.path);
  assert.ok(afterCrash.includes('extracted/a.laz'), 'the moved file was listed before it moved');
  assert.ok(afterCrash.includes('extracted/b.log'), 'the entry is written before the rename');
  // A file that reached the kept folder without an entry is reconciled.
  writeFile(keptRoot, 'stray/orphan.bin', Buffer.from('arrived without an entry'));

  c.db.prepare('UPDATE import_cleanup_jobs SET available_at=?,lease_expires_at=? WHERE id=?')
    .run(new Date(START).toISOString(), new Date(START).toISOString(), staging.cleanupId);
  assert.equal(await run(c, START + 60_000), true);
  assert.equal(job(c, staging.cleanupId).status, 'complete', job(c, staging.cleanupId).last_error);
  const listed = new Set(keptManifest(c, staging.id).map((entry) => entry.path));
  const present = listFiles(keptRoot).filter((name) => name !== 'kept-files.jsonl');
  assert.deepEqual(present.sort(), ['extracted/a.laz', 'extracted/b.log', 'extracted/c.pdf', 'stray/orphan.bin']);
  for (const file of present) assert.ok(listed.has(file), `${file} is listed in the manifest`);
  const orphan = keptManifest(c, staging.id).find((entry) => entry.path === 'stray/orphan.bin');
  assert.equal(orphan.event, 'reconciled');
  assert.equal(orphan.sha256, sha(Buffer.from('arrived without an entry')));
});

test('a symlink inside the staging payload stops cleanup without following it', linux, async (t) => {
  const c = fixture(t);
  const photo = Buffer.from('photo');
  const datasetId = finalizedDataset(c, { files: { 'a.jpg': photo } });
  const staging = readyStaging(c, datasetId, { 'extracted/a.jpg': photo });
  const victim = writeFile(c.root, 'victim/keep.txt', Buffer.from('outside the staging'));
  fs.symlinkSync(victim, path.join(staging.staging, 'extracted', 'link.txt'));

  assert.equal(await run(c), true);
  const row = job(c, staging.cleanupId);
  assert.notEqual(row.status, 'complete');
  assert.match(row.last_error, /^cleanup_path_changed: .*symbolic link/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'outside the staging');
  assert.equal(fs.readFileSync(payloadPath(c, staging.cleanupId, 'extracted/a.jpg')).equals(photo), true);
});

test('a hard link inside the staging payload stops cleanup and keeps both names', linux, async (t) => {
  const c = fixture(t);
  const photo = Buffer.from('photo');
  const datasetId = finalizedDataset(c, { files: { 'a.jpg': photo } });
  const staging = readyStaging(c, datasetId, { 'extracted/a.jpg': photo });
  const outside = writeFile(c.config.cacheMount, 'elsewhere/shared.bin', Buffer.from('hard linked bytes'));
  fs.linkSync(outside, path.join(staging.staging, 'extracted', 'shared.bin'));

  assert.equal(await run(c), true);
  const row = job(c, staging.cleanupId);
  assert.notEqual(row.status, 'complete');
  assert.match(row.last_error, /^cleanup_path_changed:/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'hard linked bytes');
  assert.equal(fs.statSync(outside).nlink, 2);
});

test('a kept-files root on another mount moves and deletes nothing and stays claimable', linux, async (t) => {
  const c = fixture(t);
  const photo = Buffer.from('duplicate photo');
  const datasetId = finalizedDataset(c, { files: { 'a.jpg': photo } });
  const staging = readyStaging(c, datasetId, { 'extracted/a.jpg': photo, 'extracted/model.laz': Buffer.from('unique') });
  const realOpen = c.storage.openCleanupRoot.bind(c.storage);
  let calls = 0;
  c.storage.openCleanupRoot = (key) => {
    const opened = realOpen(key);
    calls += 1;
    return calls > 1 ? { ...opened, mountId: `${opened.mountId}-other` } : opened;
  };

  assert.equal(await run(c), true);
  const row = job(c, staging.cleanupId);
  assert.equal(row.status, 'quarantined');
  assert.match(row.last_error, /^cleanup_kept_root_unavailable:/);
  assert.equal(fs.existsSync(path.join(c.config.cacheMount, KEPT_FILES_ROOT)), false);
  assert.equal(fs.readFileSync(payloadPath(c, staging.cleanupId, 'extracted/model.laz'), 'utf8'), 'unique');
  assert.equal(fs.readFileSync(payloadPath(c, staging.cleanupId, 'extracted/a.jpg')).equals(photo), true, 'duplicates wait too');
});

test('a quarantined job that keeps failing stays claimable instead of being stranded', linux, async (t) => {
  const c = fixture(t);
  const photo = Buffer.from('duplicate photo');
  const datasetId = finalizedDataset(c, { files: { 'a.jpg': photo } });
  const staging = readyStaging(c, datasetId, { 'extracted/model.laz': Buffer.from('unique') });
  const realOpen = c.storage.openCleanupRoot.bind(c.storage);
  let calls = 0;
  c.storage.openCleanupRoot = (key) => {
    const opened = realOpen(key);
    calls += 1;
    return calls % 2 === 0 ? { ...opened, mountId: `${opened.mountId}-other` } : opened;
  };
  assert.equal(await run(c), true);
  assert.equal(job(c, staging.cleanupId).status, 'quarantined');
  c.db.prepare('UPDATE import_cleanup_jobs SET attempt_count=?,available_at=?,lease_expires_at=? WHERE id=?')
    .run(MAX_CLEANUP_ATTEMPTS - 1, new Date(START).toISOString(), new Date(START).toISOString(), staging.cleanupId);

  assert.equal(await run(c, START + 60_000), true);
  const row = job(c, staging.cleanupId);
  assert.equal(row.status, 'quarantined', 'never failed while its payload is in quarantine');
  assert.equal(row.available_at, new Date(START + 60_000 + 24 * 3600_000).toISOString());
  assert.ok(c.logs.warn.some((line) => line.includes('kept claimable once a day')));
  assert.equal(fs.readFileSync(payloadPath(c, staging.cleanupId, 'extracted/model.laz'), 'utf8'), 'unique');
});

test('hashing is bounded per run and resumes without re-hashing', linux, async (t) => {
  const c = fixture(t);
  const files = {};
  const datasetFiles = {};
  for (let index = 0; index < 5; index += 1) {
    const bytes = Buffer.from(`photo ${index} `.repeat(20));
    files[`extracted/DJI_000${index}.JPG`] = bytes;
    datasetFiles[`DJI_000${index}.JPG`] = bytes;
  }
  const datasetId = finalizedDataset(c, { files: datasetFiles });
  const staging = readyStaging(c, datasetId, files);
  const hashed = [];
  const options = { maxHashBytes: 300, hooks: { afterFileHashed: ({ kind, key }) => hashed.push(`${kind}:${key}`) } };

  let at = START;
  let runs = 0;
  while (job(c, staging.cleanupId).status !== 'complete' && runs < 20) {
    assert.equal(await run(c, at, options), true);
    runs += 1;
    at += 2000;
    const row = job(c, staging.cleanupId);
    if (row.status !== 'complete') assert.match(row.last_error, /^cleanup_in_progress:/);
  }
  assert.equal(job(c, staging.cleanupId).status, 'complete');
  assert.ok(runs >= 3, `bounded runs: ${runs}`);
  assert.equal(new Set(hashed).size, hashed.length, 'no file is hashed twice');
  assert.equal(hashed.filter((key) => key.startsWith('staging:')).length, 5);
  assert.equal(hashed.filter((key) => key.startsWith('dataset:')).length, 5);
  assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM app_state WHERE key LIKE 'import_cleanup_%'").get().n, 0, 'progress is cleared on completion');
});

function backupZipImport(c, datasetId, stagingFiles, { extraZipEntries = {} } = {}) {
  const staging = readyStaging(c, datasetId, stagingFiles);
  const zipFiles = {};
  for (const [relative, bytes] of Object.entries(stagingFiles)) if (relative.startsWith('extracted/')) zipFiles[relative.slice('extracted/'.length)] = bytes;
  const zipBytes = storedZip({ ...zipFiles, ...extraZipEntries });
  const relativePath = `incoming/${staging.id}.zip`;
  const absolute = writeFile(c.config.datasetImportMount, relativePath, zipBytes);
  const stat = fs.statSync(absolute, { bigint: true });
  c.db.prepare(`UPDATE retained_imports SET source_kind='backup_zip',source_relative_path=?,source_byte_size=?,source_sha256=?,
    source_dev=?,source_ino=?,source_ctime_ns=?,source_mtime_ns=? WHERE id=?`)
    .run(relativePath, zipBytes.length, sha(zipBytes), String(stat.dev), String(stat.ino), String(stat.ctimeNs), String(stat.mtimeNs), staging.id);
  c.processing.journalRetainedImportCleanup(c.db.prepare('SELECT * FROM retained_imports WHERE id=?').get(staging.id), new Date(START - 60_000).toISOString());
  return { ...staging, zip: absolute, zipBytes, zipCleanupId: `${staging.id}:source` };
}

test('a source ZIP is never claimed while its staging cleanup is still pending', linux, async (t) => {
  const c = fixture(t);
  const photo = Buffer.from('photo');
  const datasetId = finalizedDataset(c, { files: { 'a.jpg': photo } });
  const imported = backupZipImport(c, datasetId, { 'extracted/a.jpg': photo });
  c.db.prepare('UPDATE import_cleanup_jobs SET available_at=? WHERE id=?').run(new Date(START + 86400_000).toISOString(), imported.cleanupId);
  assert.equal(c.processing.claimImportCleanup('cleanup-worker', { at: START }), null);
  assert.equal(fs.existsSync(imported.zip), true);
});

test('a source ZIP is kept and the job says why when its staging cleanup did not verify', linux, async (t) => {
  const c = fixture(t);
  const photo = Buffer.from('photo');
  const datasetId = finalizedDataset(c, { files: { 'a.jpg': photo } });
  const imported = backupZipImport(c, datasetId, { 'extracted/a.jpg': photo });
  const { zipBytes } = imported;
  c.db.prepare("UPDATE import_cleanup_jobs SET status='failed',last_error='cleanup_retry_exhausted: x',completed_at=? WHERE id=?")
    .run(new Date(START).toISOString(), imported.cleanupId);

  assert.equal(await run(c), true);
  const row = job(c, imported.zipCleanupId);
  assert.equal(row.status, 'failed');
  assert.match(row.last_error, /^zip_staging_unverified: source ZIP kept because staging_cleanup_failed/);
  assert.equal(fs.readFileSync(imported.zip).equals(zipBytes), true);

  // A staging job completed without classification evidence does not count either.
  c.db.prepare("UPDATE import_cleanup_jobs SET status='complete' WHERE id=?").run(imported.cleanupId);
  assert.deepEqual(c.processing.importCleanupStagingProof(imported.id), { ok: false, reason: 'staging_cleanup_not_verified' });
});

test('a source ZIP is deleted only after its staging cleanup completed and verified', linux, async (t) => {
  const c = fixture(t);
  const photo = Buffer.from('photo');
  const datasetId = finalizedDataset(c, { files: { 'a.jpg': photo } });
  const imported = backupZipImport(c, datasetId, { 'extracted/a.jpg': photo, 'extracted/odm_georeferencing/model.laz': Buffer.from('only in the zip') });

  assert.equal(await run(c), true);
  assert.equal(job(c, imported.cleanupId).status, 'complete', job(c, imported.cleanupId).last_error);
  assert.equal(c.processing.importCleanupStagingProof(imported.id).ok, true);
  assert.equal(fs.readFileSync(path.join(c.config.cacheMount, KEPT_FILES_ROOT, imported.id, 'extracted', 'odm_georeferencing', 'model.laz'), 'utf8'), 'only in the zip');
  assert.equal(await run(c, START + 1000), true);
  assert.equal(job(c, imported.zipCleanupId).status, 'complete', job(c, imported.zipCleanupId).last_error);
  assert.equal(fs.existsSync(imported.zip), false);
});

test('ZIP deletion re-reads the staging proof inside the delete fence', linux, async (t) => {
  const c = fixture(t);
  const photo = Buffer.from('photo');
  const datasetId = finalizedDataset(c, { files: { 'a.jpg': photo } });
  const imported = backupZipImport(c, datasetId, { 'extracted/a.jpg': photo });
  const { zipBytes } = imported;
  assert.equal(await run(c), true);
  assert.equal(job(c, imported.cleanupId).status, 'complete');

  assert.equal(await run(c, START + 1000, { hooks: { beforeQuarantineHash() {
    c.db.prepare("DELETE FROM audit_events WHERE action='import_cleanup.staging_verified'").run();
  } } }), true);
  assert.notEqual(job(c, imported.zipCleanupId).status, 'complete');
  const intent = job(c, imported.zipCleanupId).quarantine_relative_path;
  const quarantined = path.join(c.config.datasetImportMount, ...intent.split('/'), 'payload');
  assert.equal(fs.readFileSync(quarantined).equals(zipBytes), true, 'the ZIP is kept in its quarantine');
});

test('kept import files are reported apart from the disposable cache', async (t) => {
  const { measureStorageUsage } = require('../server/storageUsage');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-kept-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const roots = { cache: path.join(root, 'cache') };
  writeFile(roots.cache, 'webodm-task-imports/x/extracted/a.jpg', Buffer.alloc(5));
  writeFile(roots.cache, `${KEPT_FILES_ROOT}/x/extracted/model.laz`, Buffer.alloc(7));
  const usage = await measureStorageUsage({ roots, categories: new Map() });
  assert.equal(usage.categories.cache.bytes, 5);
  assert.equal(usage.categories.keptImports.bytes, 7);
});

test('a source ZIP whose entries do not match the staged files is kept in place', linux, async (t) => {
  const c = fixture(t);
  const photo = Buffer.from('photo');
  const datasetId = finalizedDataset(c, { files: { 'a.jpg': photo } });
  const imported = backupZipImport(c, datasetId, { 'extracted/a.jpg': photo }, { extraZipEntries: { 'never-extracted.laz': Buffer.from('only in the zip') } });
  assert.equal(await run(c), true);
  assert.equal(job(c, imported.cleanupId).status, 'complete');

  assert.equal(await run(c, START + 1000), true);
  const row = job(c, imported.zipCleanupId);
  assert.equal(row.status, 'failed');
  assert.match(row.last_error, /^zip_staging_unverified: source ZIP kept because its entries do not match the staged file list/);
  assert.equal(fs.readFileSync(imported.zip).equals(imported.zipBytes), true, 'the ZIP was not moved');
  assert.equal(fs.readdirSync(path.dirname(imported.zip)).length, 1, 'no quarantine folder was created');
});

test('a source ZIP is kept when its staging held no extracted files', linux, async (t) => {
  const c = fixture(t);
  const datasetId = finalizedDataset(c, { files: { 'a.jpg': Buffer.from('photo') } });
  const imported = backupZipImport(c, datasetId, { 'retained/leftover.txt': Buffer.from('not extracted') });
  assert.equal(await run(c), true);
  assert.equal(job(c, imported.cleanupId).status, 'complete');
  assert.equal(c.processing.importCleanupStagingProof(imported.id).extractedFiles, 0);

  assert.equal(await run(c, START + 1000), true);
  assert.match(job(c, imported.zipCleanupId).last_error, /^zip_staging_unverified: source ZIP kept because the staging held no extracted files/);
  assert.equal(fs.existsSync(imported.zip), true);
});

test('a ZIP job stopped for a missing proof is re-queued when its staging later completes', linux, async (t) => {
  const c = fixture(t);
  const photo = Buffer.from('photo');
  const datasetId = finalizedDataset(c, { files: { 'a.jpg': photo } });
  const imported = backupZipImport(c, datasetId, { 'extracted/a.jpg': photo });
  c.db.prepare("UPDATE import_cleanup_jobs SET status='failed',last_error='cleanup_retry_exhausted: earlier',completed_at=? WHERE id=?")
    .run(new Date(START).toISOString(), imported.cleanupId);
  assert.equal(await run(c), true);
  assert.equal(job(c, imported.zipCleanupId).status, 'failed');

  assert.ok(c.processing.retryTerminalImportCleanup(imported.cleanupId, 'operator', { at: START + 1000 }));
  assert.equal(await run(c, START + 2000), true);
  assert.equal(job(c, imported.cleanupId).status, 'complete', job(c, imported.cleanupId).last_error);
  const requeued = job(c, imported.zipCleanupId);
  assert.equal(requeued.status, 'pending', 'the later successful pass supersedes the failure');
  assert.equal(requeued.last_error, null);
  assert.ok(c.db.prepare("SELECT 1 FROM audit_events WHERE action='import_cleanup.zip_requeued' AND entity_id=?").get(imported.zipCleanupId));

  assert.equal(await run(c, START + 3000), true);
  assert.equal(job(c, imported.zipCleanupId).status, 'complete', job(c, imported.zipCleanupId).last_error);
  assert.equal(fs.existsSync(imported.zip), false);
});

test('saved hashes are one row per file and are pruned when files disappear', linux, async (t) => {
  const c = fixture(t);
  const files = {};
  for (let index = 0; index < 4; index += 1) files[`extracted/unique-${index}.bin`] = Buffer.from(`unique bytes ${index} `.repeat(10));
  const datasetId = finalizedDataset(c, { files: { 'other.jpg': Buffer.from('unrelated') } });
  const staging = readyStaging(c, datasetId, files);
  const rows = () => c.db.prepare("SELECT key,value FROM app_state WHERE key LIKE ? ORDER BY key").all(`import_cleanup_hash:${staging.cleanupId}:%`);

  assert.equal(await run(c, START, { maxHashBytes: 250 }), true);
  assert.match(job(c, staging.cleanupId).last_error, /^cleanup_in_progress:/);
  const first = rows();
  assert.ok(first.length >= 1 && first.length < 4, `partial progress saved: ${first.length}`);
  for (const row of first) assert.match(row.value, /^[a-f0-9]{64}$/, 'each row holds one hash, not a rewritten blob');

  // A file already hashed disappears from the quarantine before the next run.
  const stagingPrefix = `import_cleanup_hash:${staging.cleanupId}:staging:`;
  const gone = first.find((row) => row.key.startsWith(stagingPrefix)).key.slice(stagingPrefix.length).split('|')[0];
  fs.unlinkSync(payloadPath(c, staging.cleanupId, gone));
  c.db.prepare('UPDATE import_cleanup_jobs SET available_at=?,lease_expires_at=? WHERE id=?')
    .run(new Date(START).toISOString(), new Date(START).toISOString(), staging.cleanupId);
  // The next run hashes the rest without a cap, prunes, then the job keeps the
  // remaining unique files and completes; the progress rows are cleared.
  let pruned = null;
  assert.equal(await run(c, START + 2000, { hooks: { afterStagingClassification() { pruned = rows().map((row) => row.key); } } }), true);
  const stagingRows = (pruned || []).filter((key) => key.startsWith(stagingPrefix));
  assert.ok(pruned && !stagingRows.some((key) => key === `${stagingPrefix}${gone}` || key.startsWith(`${stagingPrefix}${gone}|`)), 'the vanished file\'s entry is pruned');
  assert.equal(stagingRows.length, 3);
  assert.equal(job(c, staging.cleanupId).status, 'complete', job(c, staging.cleanupId).last_error);
  assert.equal(rows().length, 0);
});
