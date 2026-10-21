'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../server/auth');
const { openDatabase } = require('../server/database');
const { executeStagingCleanup, executeZipCleanup, processOneImportCleanup } = require('../server/importCleanup');
const { createProcessingApi } = require('../server/processingApi');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const { StorageManager } = require('../server/storageManager');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-import-cleanup-'));
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
  return { config, db, processing, root, storage };
}

function insertCleanup(c, id, { state = 'ready', status = 'pending', availableAt = '2026-09-01T12:00:00.000Z', relativePath = `webodm-task-imports/${id}` } = {}) {
  const createdAt = '2026-09-01T11:00:00.000Z';
  c.db.prepare(`INSERT INTO retained_imports(
    id,source_kind,source_root_key,source_relative_path,staging_root_key,staging_relative_path,
    cleanup_jobs_inserted,state,created_at,updated_at
  ) VALUES (?,'server_folder','dataset_import',?,'cache',?,1,?,?,?)`).run(
    id, `sources/${id}`, relativePath, state, createdAt, createdAt,
  );
  c.db.prepare(`INSERT INTO import_cleanup_jobs(
    id,retained_import_id,cleanup_type,root_key,relative_path,status,available_at,created_at,updated_at
  ) VALUES (?,?,'staging_tree','cache',?,?,?,?,?)`).run(
    `${id}:cleanup`, id, relativePath, status, availableAt, createdAt, createdAt,
  );
  return `${id}:cleanup`;
}

function insertZipCleanup(c, id, relativePath, bytes) {
  const absolutePath = path.join(c.config.datasetImportMount, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, bytes);
  const stat = fs.statSync(absolutePath, { bigint: true });
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const createdAt = new Date(START - 60_000).toISOString();
  c.db.prepare(`INSERT INTO retained_imports(
    id,source_kind,source_root_key,source_relative_path,source_byte_size,source_sha256,
    source_dev,source_ino,source_ctime_ns,source_mtime_ns,staging_root_key,staging_relative_path,
    cleanup_jobs_inserted,state,created_at,updated_at
  ) VALUES (?,'backup_zip','dataset_import',?,?,?,?,?,?,?,'cache',?,1,'ready',?,?)`).run(
    id, relativePath, bytes.length, sha256, String(stat.dev), String(stat.ino), String(stat.ctimeNs),
    String(stat.mtimeNs), `webodm-task-imports/${id}`, createdAt, createdAt,
  );
  const cleanupId = `${id}:source`;
  c.db.prepare(`INSERT INTO import_cleanup_jobs(
    id,retained_import_id,cleanup_type,root_key,relative_path,expected_byte_size,expected_sha256,
    expected_dev,expected_ino,expected_ctime_ns,expected_mtime_ns,status,available_at,created_at,updated_at
  ) VALUES (?,?,'source_zip','dataset_import',?,?,?,?,?,?,?,'pending',?,?,?)`).run(
    cleanupId, id, relativePath, bytes.length, sha256, String(stat.dev), String(stat.ino), String(stat.ctimeNs),
    String(stat.mtimeNs), new Date(START).toISOString(), createdAt, createdAt,
  );
  return { absolutePath, cleanupId, sha256, stat };
}

function row(c, id) {
  return c.db.prepare('SELECT * FROM import_cleanup_jobs WHERE id=?').get(id);
}

function hasHeldDirectoryDescriptor(stat) {
  for (const name of fs.readdirSync('/proc/self/fd')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const held = fs.fstatSync(Number(name), { bigint: true });
      if (held.isDirectory() && held.dev === stat.dev && held.ino === stat.ino && held.mode === stat.mode) return true;
    } catch (error) {
      if (error?.code !== 'EBADF') throw error;
    }
  }
  return false;
}

const START = Date.parse('2026-09-01T12:00:00.000Z');

test('cleanup claims are ready-gated, single-item, bounded, and token fenced', (t) => {
  const c = fixture(t);
  insertCleanup(c, 'not-ready', { state: 'failed', availableAt: new Date(START - 1000).toISOString() });
  const firstId = insertCleanup(c, 'ready-one', { availableAt: new Date(START - 500).toISOString() });
  const secondId = insertCleanup(c, 'ready-two', { availableAt: new Date(START - 250).toISOString() });

  const first = c.processing.claimImportCleanup('cleanup-owner', { leaseSeconds: 1, at: START });
  assert.equal(first.id, firstId);
  assert.equal(first.status, 'leased');
  assert.equal(first.lease_owner, 'cleanup-owner');
  assert.match(first.lease_token, /^[a-f0-9]{32}$/);
  assert.equal(first.lease_generation, 1);
  assert.equal(first.attempt_count, 1);
  assert.equal(first.lease_expires_at, new Date(START + 30_000).toISOString());
  assert.equal(row(c, secondId).status, 'pending', 'one claim leases only one job');

  const second = c.processing.claimImportCleanup('cleanup-owner', { leaseSeconds: 86_400, at: START });
  assert.equal(second.id, secondId);
  assert.equal(second.lease_expires_at, new Date(START + 3_600_000).toISOString());
  assert.equal(c.processing.claimImportCleanup('cleanup-owner', { at: START }), null);
  assert.equal(row(c, 'not-ready:cleanup').status, 'pending');
});

test('an expired leased cleanup is reclaimed with a fresh token and generation', (t) => {
  const c = fixture(t), id = insertCleanup(c, 'expired-leased');
  const first = c.processing.claimImportCleanup('first-owner', { leaseSeconds: 30, at: START });
  const successor = c.processing.claimImportCleanup('successor-owner', { leaseSeconds: 30, at: START + 30_000 });

  assert.equal(successor.id, id);
  assert.equal(successor.status, 'leased');
  assert.equal(successor.lease_owner, 'successor-owner');
  assert.notEqual(successor.lease_token, first.lease_token);
  assert.equal(successor.lease_generation, 2);
  assert.equal(successor.attempt_count, 2);
  assert.equal(c.processing.completeImportCleanup(id, 'first-owner', first.lease_token, first.lease_generation, { at: START + 30_001 }), false);
});

test('quarantine intent is repository-derived and the leased lifecycle is fully fenced', (t) => {
  const c = fixture(t), relativePath = 'webodm-task-imports/quarantine-me', id = insertCleanup(c, 'quarantine-me', { relativePath });
  const lease = c.processing.claimImportCleanup('worker-a', { leaseSeconds: 60, at: START });

  assert.equal(c.processing.heartbeatImportCleanup(id, 'worker-b', lease.lease_token, lease.lease_generation, { at: START + 1000 }), false);
  assert.equal(c.processing.heartbeatImportCleanup(id, 'worker-a', lease.lease_token, lease.lease_generation, { leaseSeconds: 120, at: START + 1000 }), true);
  const quarantinePath = c.processing.persistImportCleanupQuarantineIntent(id, 'worker-a', lease.lease_token, lease.lease_generation, { at: START + 2000 });
  assert.equal(quarantinePath, `${relativePath}.cleanup-${lease.lease_token}.quarantine`);
  assert.equal(c.processing.persistImportCleanupQuarantineIntent(id, 'worker-a', lease.lease_token, lease.lease_generation, { at: START + 2001 }), quarantinePath);
  assert.equal(c.processing.markImportCleanupQuarantined(id, 'worker-a', lease.lease_token, lease.lease_generation + 1, { at: START + 3000 }), false);
  assert.equal(c.processing.markImportCleanupQuarantined(id, 'worker-a', lease.lease_token, lease.lease_generation, { at: START + 3000 }), true);
  assert.equal(c.processing.heartbeatImportCleanup(id, 'worker-a', lease.lease_token, lease.lease_generation, { at: START + 4000 }), true);
  assert.equal(c.processing.completeImportCleanup(id, 'worker-a', lease.lease_token, lease.lease_generation, { at: START + 5000 }), true);

  const completed = row(c, id);
  assert.equal(completed.status, 'complete');
  assert.equal(completed.quarantine_relative_path, quarantinePath);
  assert.equal(completed.lease_owner, null);
  assert.equal(completed.lease_token, null);
  assert.ok(completed.completed_at);
});

test('invalid cleanup paths cannot become quarantine intents', (t) => {
  const c = fixture(t), id = insertCleanup(c, 'unsafe-path', { relativePath: '../escape' });
  const lease = c.processing.claimImportCleanup('worker', { at: START });
  assert.throws(
    () => c.processing.persistImportCleanupQuarantineIntent(id, 'worker', lease.lease_token, lease.lease_generation, { at: START + 1 }),
    (error) => error?.code === 'invalid_cleanup_path',
  );
  assert.equal(row(c, id).quarantine_relative_path, null);
});

test('cleanup retry uses exponential backoff without changing retained or model readiness', (t) => {
  const c = fixture(t), id = insertCleanup(c, 'retry-me');
  c.db.prepare("INSERT INTO models(id,provider,provider_model_id,display_name,status,metadata_json,created_at,updated_at) VALUES ('ready-model','webodm','ready-model','Ready model','ready','{}',?,?)").run(new Date(START).toISOString(), new Date(START).toISOString());
  const first = c.processing.claimImportCleanup('worker', { at: START });

  assert.equal(c.processing.retryImportCleanup(id, 'worker', first.lease_token, first.lease_generation, 'temporary delete failure', { at: START + 1000 }), true);
  let retried = row(c, id);
  assert.equal(retried.status, 'pending');
  assert.equal(retried.available_at, new Date(START + 6000).toISOString());
  assert.equal(retried.last_error, 'temporary delete failure');
  assert.equal(c.db.prepare('SELECT state FROM retained_imports WHERE id=?').get('retry-me').state, 'ready');
  assert.equal(c.db.prepare("SELECT status FROM models WHERE id='ready-model'").get().status, 'ready');
  assert.equal(c.processing.claimImportCleanup('too-early', { at: START + 5999 }), null);

  const second = c.processing.claimImportCleanup('worker-two', { at: START + 6000 });
  assert.equal(second.attempt_count, 2);
  assert.equal(second.lease_generation, 2);
  const quarantinePath = c.processing.persistImportCleanupQuarantineIntent(id, 'worker-two', second.lease_token, second.lease_generation, { at: START + 6001 });
  assert.equal(c.processing.markImportCleanupQuarantined(id, 'worker-two', second.lease_token, second.lease_generation, { at: START + 6002 }), true);
  assert.equal(c.processing.retryImportCleanup(id, 'worker-two', second.lease_token, second.lease_generation, 'phase-losing retry', { at: START + 7000 }), false);
  assert.equal(c.processing.deferQuarantinedImportCleanup(id, 'worker-two', second.lease_token, second.lease_generation, 'still busy', { at: START + 7000 }), true);
  retried = row(c, id);
  assert.equal(retried.status, 'quarantined');
  assert.equal(retried.available_at, new Date(START + 17_000).toISOString());
  assert.equal(retried.lease_expires_at, new Date(START + 17_000).toISOString());
  assert.equal(retried.quarantine_relative_path, quarantinePath, 'retry preserves durable quarantine intent');
  assert.equal(c.db.prepare('SELECT state FROM retained_imports WHERE id=?').get('retry-me').state, 'ready');
  assert.equal(c.db.prepare("SELECT status FROM models WHERE id='ready-model'").get().status, 'ready');
});

test('explicit no-delete outcomes are terminal and reject arbitrary statuses', (t) => {
  const c = fixture(t), id = insertCleanup(c, 'hardlink-skip');
  const lease = c.processing.claimImportCleanup('worker', { at: START });

  assert.throws(
    () => c.processing.completeImportCleanupWithoutDelete(id, 'worker', lease.lease_token, lease.lease_generation, 'complete', 'not explicit', { at: START + 1 }),
    (error) => error?.code === 'invalid_cleanup_outcome',
  );
  assert.equal(c.processing.completeImportCleanupWithoutDelete(id, 'worker', lease.lease_token, lease.lease_generation, 'cleanup_skipped_hardlink', 'source has multiple links', { at: START + 2 }), true);
  const terminal = row(c, id);
  assert.equal(terminal.status, 'cleanup_skipped_hardlink');
  assert.equal(terminal.last_error, 'source has multiple links');
  assert.equal(terminal.quarantine_relative_path, null);
  assert.equal(terminal.lease_owner, null);
  assert.ok(terminal.completed_at);
  const audit = c.db.prepare("SELECT action,entity_type,entity_id,details_json FROM audit_events WHERE action='import_cleanup.no_delete'").get();
  assert.deepEqual({ action: audit.action, entityType: audit.entity_type, entityId: audit.entity_id }, {
    action: 'import_cleanup.no_delete', entityType: 'import_cleanup_job', entityId: id,
  });
  assert.deepEqual(JSON.parse(audit.details_json), {
    retainedImportId: 'hardlink-skip', cleanupType: 'staging_tree', outcome: 'cleanup_skipped_hardlink',
  });
  const warning = c.db.prepare("SELECT event_type,payload_json,status FROM event_outbox WHERE event_type='import.cleanup_warning'").get();
  const payload = JSON.parse(warning.payload_json);
  assert.equal(warning.status, 'pending');
  assert.equal(payload.cleanupJobId, id);
  assert.equal(payload.retainedImportId, 'hardlink-skip');
  assert.equal(payload.outcome, 'cleanup_skipped_hardlink');
  assert.equal(Object.hasOwn(payload, 'relativePath'), false);
});

test('terminal cleanup warning and state transition roll back together', (t) => {
  const c = fixture(t), id = insertCleanup(c, 'terminal-rollback');
  const lease = c.processing.claimImportCleanup('worker', { at: START });
  c.db.exec(`CREATE TRIGGER reject_cleanup_warning_audit BEFORE INSERT ON audit_events
    WHEN NEW.action='import_cleanup.no_delete' BEGIN SELECT RAISE(ABORT,'injected cleanup audit failure'); END`);

  assert.throws(
    () => c.processing.completeImportCleanupWithoutDelete(
      id, 'worker', lease.lease_token, lease.lease_generation,
      'source_changed', 'changed source', { at: START + 1 },
    ),
    /injected cleanup audit failure/,
  );
  const unchanged = row(c, id);
  assert.equal(unchanged.status, 'leased');
  assert.equal(unchanged.lease_token, lease.lease_token);
  assert.equal(c.db.prepare("SELECT COUNT(*) n FROM event_outbox WHERE event_type='import.cleanup_warning'").get().n, 0);
});

test('expired quarantined cleanup preserves its path and rejects every stale mutation', (t) => {
  const c = fixture(t), id = insertCleanup(c, 'quarantined-reclaim');
  const stale = c.processing.claimImportCleanup('stale-owner', { leaseSeconds: 30, at: START });
  const quarantinePath = c.processing.persistImportCleanupQuarantineIntent(id, 'stale-owner', stale.lease_token, stale.lease_generation, { at: START + 1 });
  assert.equal(c.processing.markImportCleanupQuarantined(id, 'stale-owner', stale.lease_token, stale.lease_generation, { at: START + 2 }), true);

  const successor = c.processing.claimImportCleanup('successor', { leaseSeconds: 60, at: START + 30_000 });
  assert.equal(successor.status, 'quarantined');
  assert.equal(successor.quarantine_relative_path, quarantinePath);
  assert.equal(successor.lease_generation, stale.lease_generation + 1);
  assert.notEqual(successor.lease_token, stale.lease_token);
  const staleFence = [id, 'stale-owner', stale.lease_token, stale.lease_generation];
  assert.equal(c.processing.heartbeatImportCleanup(...staleFence, { at: START + 30_001 }), false);
  assert.equal(c.processing.persistImportCleanupQuarantineIntent(...staleFence, { at: START + 30_001 }), null);
  assert.equal(c.processing.markImportCleanupQuarantined(...staleFence, { at: START + 30_001 }), false);
  assert.equal(c.processing.retryImportCleanup(...staleFence, 'stale retry', { at: START + 30_001 }), false);
  assert.equal(c.processing.completeImportCleanupWithoutDelete(...staleFence, 'source_changed', 'stale terminal', { at: START + 30_001 }), false);
  assert.equal(c.processing.completeImportCleanup(...staleFence, { at: START + 30_001 }), false);

  assert.equal(c.processing.heartbeatImportCleanup(id, 'successor', successor.lease_token, successor.lease_generation, { at: START + 30_001 }), true);
  assert.equal(c.processing.completeImportCleanup(id, 'successor', successor.lease_token, successor.lease_generation, { at: START + 30_002 }), true);
  assert.equal(row(c, id).status, 'complete');
});

test('ready staging cleanup removes only the exact operation-owned cache tree', async (t) => {
  const c = fixture(t), retainedId = 'staging-executor';
  const cleanupId = insertCleanup(c, retainedId);
  const staging = path.join(c.config.cacheMount, 'webodm-task-imports', retainedId);
  const source = path.join(c.config.datasetImportMount, 'sources', retainedId);
  fs.mkdirSync(path.join(staging, 'extracted', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'extracted', 'nested', 'discard.txt'), 'discard');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'operator.txt'), 'preserve');

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    { now: () => START },
  ), true);

  assert.equal(fs.existsSync(staging), false, row(c, cleanupId).last_error || 'staging still exists');
  assert.equal(fs.readFileSync(path.join(source, 'operator.txt'), 'utf8'), 'preserve');
  assert.equal(row(c, cleanupId).status, 'complete');
  assert.equal(c.db.prepare('SELECT state FROM retained_imports WHERE id=?').get(retainedId).state, 'ready');
});

test('unchanged source ZIP is hash-bound, quarantined, and deleted after readiness', async (t) => {
  const c = fixture(t), bytes = Buffer.from('verified backup zip bytes');
  const cleanup = insertZipCleanup(c, 'zip-executor', 'incoming/client-backup.zip', bytes);

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    { now: () => START },
  ), true);

  assert.equal(fs.existsSync(cleanup.absolutePath), false, row(c, cleanup.cleanupId).last_error || 'ZIP still exists');
  assert.equal(row(c, cleanup.cleanupId).status, 'complete');
  assert.equal(c.db.prepare('SELECT state FROM retained_imports WHERE id=?').get('zip-executor').state, 'ready');
});

test('same-size replacement at the source ZIP path is never deleted', async (t) => {
  const c = fixture(t), original = Buffer.from('original backup bytes'), replacement = Buffer.from('replacement bytes!!!!');
  assert.equal(replacement.length, original.length);
  const cleanup = insertZipCleanup(c, 'zip-replacement', 'incoming/replaced.zip', original);
  const preservedOriginal = `${cleanup.absolutePath}.original`;
  fs.renameSync(cleanup.absolutePath, preservedOriginal);
  fs.writeFileSync(cleanup.absolutePath, replacement);

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    { now: () => START },
  ), true);

  assert.equal(fs.readFileSync(cleanup.absolutePath).equals(replacement), true);
  assert.equal(fs.readFileSync(preservedOriginal).equals(original), true);
  assert.equal(row(c, cleanup.cleanupId).status, 'source_changed');
  assert.equal(c.db.prepare('SELECT state FROM retained_imports WHERE id=?').get('zip-replacement').state, 'ready');
});

test('hardlinked source ZIP is a terminal no-delete outcome', async (t) => {
  const c = fixture(t), cleanup = insertZipCleanup(c, 'zip-hardlink', 'incoming/hardlinked.zip', Buffer.from('hardlink bytes'));
  const secondLink = `${cleanup.absolutePath}.second-link`;
  fs.linkSync(cleanup.absolutePath, secondLink);

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    { now: () => START },
  ), true);

  assert.equal(fs.readFileSync(cleanup.absolutePath, 'utf8'), 'hardlink bytes');
  assert.equal(fs.readFileSync(secondLink, 'utf8'), 'hardlink bytes');
  assert.equal(row(c, cleanup.cleanupId).status, 'cleanup_skipped_hardlink');
});

test('atomic same-path replacement immediately before quarantine is preserved, never deleted', async (t) => {
  const c = fixture(t), original = Buffer.from('original race bytes'), replacement = Buffer.from('replacement bytes!!');
  assert.equal(replacement.length, original.length);
  const cleanup = insertZipCleanup(c, 'zip-rename-race', 'incoming/race.zip', original);
  const preservedOriginal = `${cleanup.absolutePath}.original`;

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    {
      now: () => START,
      hooks: {
        beforeQuarantineRename() {
          fs.renameSync(cleanup.absolutePath, preservedOriginal);
          fs.writeFileSync(cleanup.absolutePath, replacement);
        },
      },
    },
  ), true);

  const terminal = row(c, cleanup.cleanupId);
  const quarantinePayload = path.join(c.config.datasetImportMount, ...terminal.quarantine_relative_path.split('/'), 'payload');
  assert.equal(terminal.status, 'source_changed');
  assert.equal(fs.readFileSync(quarantinePayload).equals(replacement), true);
  assert.equal(fs.readFileSync(preservedOriginal).equals(original), true);
});

test('symlink replacement after ZIP quarantine cannot redirect deletion', async (t) => {
  const c = fixture(t), bytes = Buffer.from('symlink race bytes');
  const cleanup = insertZipCleanup(c, 'zip-symlink-race', 'incoming/symlink-race.zip', bytes);
  const victim = path.join(c.root, 'victim.txt');
  const preserved = path.join(c.config.datasetImportMount, 'preserved-quarantined.zip');
  fs.writeFileSync(victim, 'do not delete');

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    {
      now: () => START,
      hooks: {
        afterQuarantineRename() {
          const intent = row(c, cleanup.cleanupId).quarantine_relative_path;
          const payload = path.join(c.config.datasetImportMount, ...intent.split('/'), 'payload');
          fs.renameSync(payload, preserved);
          fs.symlinkSync(victim, payload);
        },
      },
    },
  ), true);

  const terminal = row(c, cleanup.cleanupId);
  const quarantinePayload = path.join(c.config.datasetImportMount, ...terminal.quarantine_relative_path.split('/'), 'payload');
  assert.equal(terminal.status, 'source_changed');
  assert.equal(fs.lstatSync(quarantinePayload).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'do not delete');
  assert.equal(fs.readFileSync(preserved).equals(bytes), true);
});

test('in-place ZIP mutation during quarantine hashing is preserved and terminal', async (t) => {
  const c = fixture(t), original = Buffer.from('hash original bytes'), modified = Buffer.from('hash modified bytes');
  assert.equal(modified.length, original.length);
  const cleanup = insertZipCleanup(c, 'zip-hash-race', 'incoming/hash-race.zip', original);

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    {
      now: () => START,
      hooks: {
        beforeQuarantineHash() {
          const intent = row(c, cleanup.cleanupId).quarantine_relative_path;
          const payload = path.join(c.config.datasetImportMount, ...intent.split('/'), 'payload');
          fs.writeFileSync(payload, modified);
        },
      },
    },
  ), true);

  const terminal = row(c, cleanup.cleanupId);
  const quarantinePayload = path.join(c.config.datasetImportMount, ...terminal.quarantine_relative_path.split('/'), 'payload');
  assert.equal(terminal.status, 'source_changed');
  assert.equal(fs.readFileSync(quarantinePayload).equals(modified), true);
});

test('crash after ZIP quarantine rename replays only after parent durability sync', async (t) => {
  const c = fixture(t), bytes = Buffer.from('crash replay bytes');
  const cleanup = insertZipCleanup(c, 'zip-crash-replay', 'incoming/crash.zip', bytes);
  const first = c.processing.claimImportCleanup('crashed-worker', { leaseSeconds: 30, at: START });

  await assert.rejects(
    executeZipCleanup(
      { processing: c.processing, storage: c.storage },
      first,
      'crashed-worker',
      {
        now: () => START + 1,
        hooks: { afterQuarantineRename() { throw Object.assign(new Error('simulated crash'), { code: 'simulated_crash' }); } },
      },
    ),
    (error) => error?.code === 'simulated_crash',
  );
  const interrupted = row(c, cleanup.cleanupId);
  const quarantine = path.join(c.config.datasetImportMount, ...interrupted.quarantine_relative_path.split('/'));
  assert.equal(interrupted.status, 'leased');
  assert.equal(fs.existsSync(cleanup.absolutePath), false);
  assert.equal(fs.readFileSync(path.join(quarantine, 'payload')).equals(bytes), true);

  c.db.prepare('UPDATE import_cleanup_jobs SET lease_expires_at=? WHERE id=?').run(
    new Date(START + 29_999).toISOString(), cleanup.cleanupId,
  );
  const successorDb = openDatabase(path.join(c.root, 'viewer.sqlite'));
  const successor = new ProcessingRepository(successorDb);
  t.after(() => successorDb.close());
  const parentIdentity = fs.statSync(path.dirname(cleanup.absolutePath), { bigint: true });
  const realFsync = fs.fsyncSync;
  const realMark = successor.markImportCleanupQuarantined.bind(successor);
  let parentSynced = false;
  fs.fsyncSync = (fd) => {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (stat.dev === parentIdentity.dev && stat.ino === parentIdentity.ino) parentSynced = true;
    return realFsync(fd);
  };
  successor.markImportCleanupQuarantined = (...args) => {
    assert.equal(parentSynced, true, 'quarantine parent must be fsynced before delete authorization');
    return realMark(...args);
  };
  try {
    assert.equal(await processOneImportCleanup(
      { processing: successor, storage: c.storage },
      'successor-worker',
      { now: () => START + 30_000 },
    ), true);
  } finally {
    fs.fsyncSync = realFsync;
    successor.markImportCleanupQuarantined = realMark;
  }

  assert.equal(row(c, cleanup.cleanupId).status, 'complete');
  assert.equal(fs.existsSync(quarantine), false);
});

test('crash after authorized ZIP unlink completes idempotently on restart', async (t) => {
  const c = fixture(t), bytes = Buffer.from('unlink crash bytes');
  const cleanup = insertZipCleanup(c, 'zip-unlink-crash', 'incoming/unlink-crash.zip', bytes);
  const first = c.processing.claimImportCleanup('crashed-worker', { leaseSeconds: 30, at: START });

  await assert.rejects(
    executeZipCleanup(
      { processing: c.processing, storage: c.storage },
      first,
      'crashed-worker',
      {
        now: () => START + 1,
        hooks: { afterQuarantineDelete() { throw Object.assign(new Error('simulated crash'), { code: 'simulated_crash' }); } },
      },
    ),
    (error) => error?.code === 'simulated_crash',
  );
  const interrupted = row(c, cleanup.cleanupId);
  const quarantine = path.join(c.config.datasetImportMount, ...interrupted.quarantine_relative_path.split('/'));
  assert.equal(interrupted.status, 'quarantined');
  assert.equal(fs.existsSync(cleanup.absolutePath), false);
  assert.equal(fs.existsSync(path.join(quarantine, 'payload')), false);

  c.db.prepare('UPDATE import_cleanup_jobs SET lease_expires_at=? WHERE id=?').run(
    new Date(START + 29_999).toISOString(), cleanup.cleanupId,
  );
  const successorDb = openDatabase(path.join(c.root, 'viewer.sqlite'));
  const successor = new ProcessingRepository(successorDb);
  t.after(() => successorDb.close());
  assert.equal(await processOneImportCleanup(
    { processing: successor, storage: c.storage },
    'successor-worker',
    { now: () => START + 30_000 },
  ), true);

  assert.equal(row(c, cleanup.cleanupId).status, 'complete');
  assert.equal(fs.existsSync(quarantine), false);
});

test('transient error after authorized ZIP unlink preserves the quarantined replay phase', async (t) => {
  const c = fixture(t), bytes = Buffer.from('post-unlink retry bytes');
  const cleanup = insertZipCleanup(c, 'zip-post-unlink-retry', 'incoming/post-unlink-retry.zip', bytes);

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    {
      now: () => START,
      hooks: { afterQuarantineDelete() { throw Object.assign(new Error('transient fsync boundary'), { code: 'EIO' }); } },
    },
  ), true);
  const deferred = row(c, cleanup.cleanupId);
  const quarantine = path.join(c.config.datasetImportMount, ...deferred.quarantine_relative_path.split('/'));
  assert.equal(deferred.status, 'quarantined');
  assert.equal(deferred.lease_expires_at, new Date(START + 5000).toISOString());
  assert.equal(JSON.parse(c.db.prepare("SELECT payload_json FROM event_outbox WHERE event_type='import.cleanup_warning'").get().payload_json).outcome, 'cleanup_deferred');
  assert.equal(fs.existsSync(cleanup.absolutePath), false);
  assert.equal(fs.existsSync(path.join(quarantine, 'payload')), false);

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'successor-worker',
    { now: () => START + 5000 },
  ), true);
  assert.equal(row(c, cleanup.cleanupId).status, 'complete');
  assert.equal(fs.existsSync(quarantine), false);
});

test('crash after ZIP quarantine directory removal completes from the durable quarantined state', async (t) => {
  const c = fixture(t), bytes = Buffer.from('quarantine removal crash bytes');
  const cleanup = insertZipCleanup(c, 'zip-quarantine-remove-crash', 'incoming/quarantine-remove-crash.zip', bytes);
  const first = c.processing.claimImportCleanup('crashed-worker', { leaseSeconds: 30, at: START });

  await assert.rejects(
    executeZipCleanup(
      { processing: c.processing, storage: c.storage },
      first,
      'crashed-worker',
      {
        now: () => START + 1,
        hooks: { afterQuarantineRemove() { throw Object.assign(new Error('simulated crash'), { code: 'simulated_crash' }); } },
      },
    ),
    (error) => error?.code === 'simulated_crash',
  );
  const interrupted = row(c, cleanup.cleanupId);
  const quarantine = path.join(c.config.datasetImportMount, ...interrupted.quarantine_relative_path.split('/'));
  assert.equal(interrupted.status, 'quarantined');
  assert.equal(fs.existsSync(cleanup.absolutePath), false);
  assert.equal(fs.existsSync(quarantine), false);

  c.db.prepare('UPDATE import_cleanup_jobs SET lease_expires_at=? WHERE id=?').run(
    new Date(START + 29_999).toISOString(), cleanup.cleanupId,
  );
  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'successor-worker',
    { now: () => START + 30_000 },
  ), true);
  assert.equal(row(c, cleanup.cleanupId).status, 'complete');
});

test('crash after staging quarantine rename resumes with a successor lease', async (t) => {
  const c = fixture(t), retainedId = 'staging-crash-replay';
  const cleanupId = insertCleanup(c, retainedId);
  const staging = path.join(c.config.cacheMount, 'webodm-task-imports', retainedId);
  fs.mkdirSync(path.join(staging, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'nested', 'discard.txt'), 'discard');
  const first = c.processing.claimImportCleanup('crashed-worker', { leaseSeconds: 30, at: START });

  await assert.rejects(
    executeStagingCleanup(
      { processing: c.processing, storage: c.storage },
      first,
      'crashed-worker',
      {
        now: () => START + 1,
        hooks: { afterQuarantineRename() { throw Object.assign(new Error('simulated crash'), { code: 'simulated_crash' }); } },
      },
    ),
    (error) => error?.code === 'simulated_crash',
  );
  const interrupted = row(c, cleanupId);
  const quarantine = path.join(c.config.cacheMount, ...interrupted.quarantine_relative_path.split('/'));
  assert.equal(interrupted.status, 'leased');
  assert.equal(fs.existsSync(staging), false);
  assert.equal(fs.readFileSync(path.join(quarantine, 'payload', 'nested', 'discard.txt'), 'utf8'), 'discard');

  c.db.prepare('UPDATE import_cleanup_jobs SET lease_expires_at=? WHERE id=?').run(
    new Date(START + 29_999).toISOString(), cleanupId,
  );
  const successorDb = openDatabase(path.join(c.root, 'viewer.sqlite'));
  const successor = new ProcessingRepository(successorDb);
  t.after(() => successorDb.close());
  assert.equal(await processOneImportCleanup(
    { processing: successor, storage: c.storage },
    'successor-worker',
    { now: () => START + 30_000 },
  ), true);

  assert.equal(row(c, cleanupId).status, 'complete');
  assert.equal(fs.existsSync(quarantine), false);
});

test('crash after staging quarantine directory removal completes from the durable quarantined state', async (t) => {
  const c = fixture(t), retainedId = 'staging-quarantine-remove-crash';
  const cleanupId = insertCleanup(c, retainedId);
  const staging = path.join(c.config.cacheMount, 'webodm-task-imports', retainedId);
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'discard.txt'), 'discard');
  const first = c.processing.claimImportCleanup('crashed-worker', { leaseSeconds: 30, at: START });

  await assert.rejects(
    executeStagingCleanup(
      { processing: c.processing, storage: c.storage },
      first,
      'crashed-worker',
      {
        now: () => START + 1,
        hooks: { afterQuarantineRemove() { throw Object.assign(new Error('simulated crash'), { code: 'simulated_crash' }); } },
      },
    ),
    (error) => error?.code === 'simulated_crash',
  );
  const interrupted = row(c, cleanupId);
  const quarantine = path.join(c.config.cacheMount, ...interrupted.quarantine_relative_path.split('/'));
  assert.equal(interrupted.status, 'quarantined');
  assert.equal(fs.existsSync(staging), false);
  assert.equal(fs.existsSync(quarantine), false);

  c.db.prepare('UPDATE import_cleanup_jobs SET lease_expires_at=? WHERE id=?').run(
    new Date(START + 29_999).toISOString(), cleanupId,
  );
  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'successor-worker',
    { now: () => START + 30_000 },
  ), true);
  assert.equal(row(c, cleanupId).status, 'complete');
});

test('staging symlink swap after validation never follows the victim and retries durably', async (t) => {
  const c = fixture(t), retainedId = 'staging-symlink-race';
  const cleanupId = insertCleanup(c, retainedId);
  const staging = path.join(c.config.cacheMount, 'webodm-task-imports', retainedId);
  const victim = path.join(c.root, 'staging-victim.txt');
  fs.mkdirSync(path.join(staging, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'nested', 'discard.txt'), 'discard');
  fs.writeFileSync(victim, 'preserve victim');

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    {
      now: () => START,
      hooks: {
        afterStagingValidation() {
          const intent = row(c, cleanupId).quarantine_relative_path;
          const nested = path.join(c.config.cacheMount, ...intent.split('/'), 'payload', 'nested');
          fs.renameSync(path.join(nested, 'discard.txt'), path.join(nested, 'preserved.txt'));
          fs.symlinkSync(victim, path.join(nested, 'discard.txt'));
        },
      },
    },
  ), true);

  const retried = row(c, cleanupId);
  const quarantine = path.join(c.config.cacheMount, ...retried.quarantine_relative_path.split('/'));
  assert.equal(retried.status, 'pending');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'preserve victim');
  assert.equal(fs.lstatSync(path.join(quarantine, 'payload', 'nested', 'discard.txt')).isSymbolicLink(), true);
  assert.equal(c.db.prepare('SELECT state FROM retained_imports WHERE id=?').get(retainedId).state, 'ready');
});

test('same-name staging file replacement immediately before unlink is never deleted', async (t) => {
  const c = fixture(t), retainedId = 'staging-unlink-replacement';
  const cleanupId = insertCleanup(c, retainedId);
  const staging = path.join(c.config.cacheMount, 'webodm-task-imports', retainedId);
  const preserved = path.join(c.root, 'preserved-original.txt');
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'discard.txt'), 'original sentinel');
  const realMutate = c.processing.mutateImportCleanupFilesystem.bind(c.processing);
  let replacement;
  c.processing.mutateImportCleanupFilesystem = (id, owner, token, generation, mutate, options) => {
    const current = row(c, cleanupId);
    if (!replacement && current.status === 'quarantined') {
      const quarantine = path.join(c.config.cacheMount, ...current.quarantine_relative_path.split('/'));
      const target = path.join(quarantine, 'payload', 'discard.txt');
      fs.renameSync(target, preserved);
      fs.writeFileSync(target, 'replacement sentinel');
      replacement = target;
    }
    return realMutate(id, owner, token, generation, mutate, options);
  };

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    { now: () => START },
  ), true);

  assert.equal(row(c, cleanupId).status, 'quarantined');
  assert.equal(fs.readFileSync(preserved, 'utf8'), 'original sentinel');
  assert.equal(fs.readFileSync(replacement, 'utf8'), 'replacement sentinel');
});

test('same-name staging directory replacement immediately before rmdir is never deleted', async (t) => {
  const c = fixture(t), retainedId = 'staging-rmdir-replacement';
  const cleanupId = insertCleanup(c, retainedId);
  const staging = path.join(c.config.cacheMount, 'webodm-task-imports', retainedId);
  const nested = path.join(staging, 'nested');
  const preserved = path.join(c.root, 'preserved-original-directory');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'discard.txt'), 'discard');
  const realMutate = c.processing.mutateImportCleanupFilesystem.bind(c.processing);
  let replacement;
  c.processing.mutateImportCleanupFilesystem = (id, owner, token, generation, mutate, options) => {
    const current = row(c, cleanupId);
    if (!replacement && current.status === 'quarantined') {
      const quarantine = path.join(c.config.cacheMount, ...current.quarantine_relative_path.split('/'));
      const target = path.join(quarantine, 'payload', 'nested');
      if (fs.existsSync(target) && fs.readdirSync(target).length === 0) {
        fs.renameSync(target, preserved);
        fs.mkdirSync(target);
        replacement = target;
      }
    }
    return realMutate(id, owner, token, generation, mutate, options);
  };

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    { now: () => START },
  ), true);

  assert.equal(row(c, cleanupId).status, 'quarantined');
  assert.equal(fs.statSync(preserved).isDirectory(), true);
  assert.equal(fs.statSync(replacement).isDirectory(), true);
});

test('same-name staging payload replacement immediately before outer rmdir is never deleted', async (t) => {
  const c = fixture(t), retainedId = 'staging-payload-rmdir-replacement';
  const cleanupId = insertCleanup(c, retainedId);
  const staging = path.join(c.config.cacheMount, 'webodm-task-imports', retainedId);
  const preserved = path.join(c.root, 'preserved-payload-directory');
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'discard.txt'), 'discard');
  const realMutate = c.processing.mutateImportCleanupFilesystem.bind(c.processing);
  let replacement;
  c.processing.mutateImportCleanupFilesystem = (id, owner, token, generation, mutate, options) => {
    const current = row(c, cleanupId);
    if (!replacement && current.status === 'quarantined') {
      const quarantine = path.join(c.config.cacheMount, ...current.quarantine_relative_path.split('/'));
      const target = path.join(quarantine, 'payload');
      if (fs.existsSync(target) && fs.readdirSync(target).length === 0) {
        fs.renameSync(target, preserved);
        fs.mkdirSync(target);
        replacement = target;
      }
    }
    return realMutate(id, owner, token, generation, mutate, options);
  };

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    { now: () => START },
  ), true);

  assert.equal(row(c, cleanupId).status, 'quarantined');
  assert.equal(fs.statSync(preserved).isDirectory(), true);
  assert.equal(fs.statSync(replacement).isDirectory(), true);
});

test('same-name staging quarantine replacement immediately before final rmdir is never deleted', async (t) => {
  const c = fixture(t), retainedId = 'staging-quarantine-rmdir-replacement';
  const cleanupId = insertCleanup(c, retainedId);
  const staging = path.join(c.config.cacheMount, 'webodm-task-imports', retainedId);
  const preserved = path.join(c.root, 'preserved-quarantine-directory');
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'discard.txt'), 'discard');
  const realMutate = c.processing.mutateImportCleanupFilesystem.bind(c.processing);
  let replacement;
  c.processing.mutateImportCleanupFilesystem = (id, owner, token, generation, mutate, options) => {
    const current = row(c, cleanupId);
    if (!replacement && current.status === 'quarantined') {
      const target = path.join(c.config.cacheMount, ...current.quarantine_relative_path.split('/'));
      if (fs.existsSync(target) && fs.readdirSync(target).length === 0) {
        fs.renameSync(target, preserved);
        fs.mkdirSync(target, { mode: 0o700 });
        replacement = target;
      }
    }
    return realMutate(id, owner, token, generation, mutate, options);
  };

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    { now: () => START },
  ), true);

  assert.equal(row(c, cleanupId).status, 'quarantined');
  assert.equal(fs.statSync(preserved).isDirectory(), true);
  assert.equal(fs.statSync(replacement).isDirectory(), true);
});

test('staging validation detects an entry added after directory enumeration', async (t) => {
  const c = fixture(t), retainedId = 'staging-enumeration-race';
  const cleanupId = insertCleanup(c, retainedId);
  const staging = path.join(c.config.cacheMount, 'webodm-task-imports', retainedId);
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'original.txt'), 'original');
  const stagingIdentity = fs.statSync(staging, { bigint: true });
  const realReaddir = fs.readdirSync;
  let injected = false;
  fs.readdirSync = (target, options) => {
    const entries = realReaddir(target, options);
    const directory = String(target).startsWith('/proc/self/fd/')
      ? fs.statSync(target, { bigint: true })
      : null;
    if (!injected && directory?.dev === stagingIdentity.dev && directory.ino === stagingIdentity.ino) {
      injected = true;
      fs.writeFileSync(path.join(String(target), 'late-entry.txt'), 'late');
    }
    return entries;
  };
  try {
    assert.equal(await processOneImportCleanup(
      { processing: c.processing, storage: c.storage },
      'cleanup-worker',
      { now: () => START },
    ), true);
  } finally {
    fs.readdirSync = realReaddir;
  }

  const pending = row(c, cleanupId);
  const quarantine = path.join(c.config.cacheMount, ...pending.quarantine_relative_path.split('/'));
  assert.equal(pending.status, 'pending');
  assert.equal(fs.readFileSync(path.join(quarantine, 'payload', 'late-entry.txt'), 'utf8'), 'late');
});

test('staging delete failure retries independently and later completes', async (t) => {
  const c = fixture(t), retainedId = 'staging-delete-retry';
  const cleanupId = insertCleanup(c, retainedId);
  const staging = path.join(c.config.cacheMount, 'webodm-task-imports', retainedId);
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'discard.txt'), 'discard');
  const realUnlink = fs.unlinkSync;
  let injected = false;
  fs.unlinkSync = (target) => {
    if (!injected && String(target).includes('/proc/self/fd/')) {
      injected = true;
      throw Object.assign(new Error('injected delete failure'), { code: 'EACCES' });
    }
    return realUnlink(target);
  };
  try {
    assert.equal(await processOneImportCleanup(
      { processing: c.processing, storage: c.storage },
      'cleanup-worker',
      { now: () => START },
    ), true);
  } finally {
    fs.unlinkSync = realUnlink;
  }

  const deferred = row(c, cleanupId);
  const quarantine = path.join(c.config.cacheMount, ...deferred.quarantine_relative_path.split('/'));
  assert.equal(deferred.status, 'quarantined');
  assert.equal(deferred.lease_expires_at, new Date(START + 5000).toISOString());
  assert.equal(fs.readFileSync(path.join(quarantine, 'payload', 'discard.txt'), 'utf8'), 'discard');
  assert.equal(c.db.prepare('SELECT state FROM retained_imports WHERE id=?').get(retainedId).state, 'ready');

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'successor-worker',
    { now: () => START + 5000 },
  ), true);
  assert.equal(row(c, cleanupId).status, 'complete');
  assert.equal(fs.existsSync(quarantine), false);
});

for (const scenario of [
  { code: 'EXDEV', outcome: 'cleanup_skipped_cross_mount' },
  { code: 'EROFS', outcome: 'cleanup_skipped_read_only' },
]) test(`${scenario.code} during ZIP quarantine is terminal and leaves the source untouched`, async (t) => {
  const c = fixture(t), bytes = Buffer.from(`${scenario.code} source bytes`);
  const retainedId = `zip-${scenario.code.toLowerCase()}`;
  const cleanup = insertZipCleanup(c, retainedId, `incoming/${scenario.code.toLowerCase()}.zip`, bytes);

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    {
      now: () => START,
      hooks: {
        beforeQuarantineRename() {
          throw Object.assign(new Error(`injected ${scenario.code}`), { code: scenario.code });
        },
      },
    },
  ), true);

  const terminal = row(c, cleanup.cleanupId);
  assert.equal(terminal.status, scenario.outcome);
  assert.equal(fs.readFileSync(cleanup.absolutePath).equals(bytes), true);
  assert.equal(c.db.prepare('SELECT state FROM retained_imports WHERE id=?').get(retainedId).state, 'ready');
});

test('disappeared source ZIP terminalizes without changing model readiness', async (t) => {
  const c = fixture(t), cleanup = insertZipCleanup(c, 'zip-disappeared', 'incoming/disappeared.zip', Buffer.from('gone bytes'));
  fs.unlinkSync(cleanup.absolutePath);

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage }, 'cleanup-worker', { now: () => START },
  ), true);
  assert.equal(row(c, cleanup.cleanupId).status, 'source_changed');
  assert.equal(c.db.prepare('SELECT state FROM retained_imports WHERE id=?').get('zip-disappeared').state, 'ready');
});

test('ZIP hash mismatch leaves the quarantined bytes intact', async (t) => {
  const c = fixture(t), bytes = Buffer.from('hash mismatch bytes');
  const cleanup = insertZipCleanup(c, 'zip-hash-mismatch', 'incoming/hash-mismatch.zip', bytes);
  c.db.prepare('UPDATE import_cleanup_jobs SET expected_sha256=? WHERE id=?').run('0'.repeat(64), cleanup.cleanupId);

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage }, 'cleanup-worker', { now: () => START },
  ), true);
  const terminal = row(c, cleanup.cleanupId);
  const payload = path.join(c.config.datasetImportMount, ...terminal.quarantine_relative_path.split('/'), 'payload');
  assert.equal(terminal.status, 'source_changed');
  assert.equal(fs.readFileSync(payload).equals(bytes), true);
});

test('source recreated during ZIP hash preserves both the replacement and quarantine', async (t) => {
  const c = fixture(t), original = Buffer.from('quarantined original'), replacement = Buffer.from('new source replacement');
  const cleanup = insertZipCleanup(c, 'zip-source-recreated', 'incoming/source-recreated.zip', original);

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    {
      now: () => START,
      hooks: { beforeQuarantineHash() { fs.writeFileSync(cleanup.absolutePath, replacement); } },
    },
  ), true);
  const terminal = row(c, cleanup.cleanupId);
  const payload = path.join(c.config.datasetImportMount, ...terminal.quarantine_relative_path.split('/'), 'payload');
  assert.equal(terminal.status, 'source_changed');
  assert.equal(fs.readFileSync(cleanup.absolutePath).equals(replacement), true);
  assert.equal(fs.readFileSync(payload).equals(original), true);
});

test('configured cleanup root replacement is rejected against the startup pin', async (t) => {
  const c = fixture(t), retainedId = 'staging-root-swap';
  const cleanupId = insertCleanup(c, retainedId);
  const staging = path.join(c.config.cacheMount, 'webodm-task-imports', retainedId);
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'discard.txt'), 'discard');
  const originalRoot = `${c.config.cacheMount}.original`;
  fs.renameSync(c.config.cacheMount, originalRoot);
  fs.mkdirSync(c.config.cacheMount);

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage }, 'cleanup-worker', { now: () => START },
  ), true);

  const pending = row(c, cleanupId);
  assert.equal(pending.status, 'pending');
  assert.match(pending.last_error, /cleanup_root_changed/);
  assert.equal(fs.readFileSync(path.join(originalRoot, 'webodm-task-imports', retainedId, 'discard.txt'), 'utf8'), 'discard');
  assert.deepEqual(fs.readdirSync(c.config.cacheMount), []);
});

for (const collisionType of ['file', 'directory']) test(`ZIP quarantine ${collisionType} collision is never overwritten`, async (t) => {
  const c = fixture(t), bytes = Buffer.from(`${collisionType} collision source`);
  const cleanup = insertZipCleanup(c, `zip-collision-${collisionType}`, `incoming/collision-${collisionType}.zip`, bytes);
  const first = c.processing.claimImportCleanup('intent-worker', { leaseSeconds: 30, at: START });
  const intent = c.processing.persistImportCleanupQuarantineIntent(
    first.id, 'intent-worker', first.lease_token, first.lease_generation, { at: START + 1 },
  );
  const collision = path.join(c.config.datasetImportMount, ...intent.split('/'));
  if (collisionType === 'file') fs.writeFileSync(collision, 'collision sentinel');
  else fs.mkdirSync(collision);
  c.db.prepare('UPDATE import_cleanup_jobs SET lease_expires_at=? WHERE id=?').run(
    new Date(START + 29_999).toISOString(), cleanup.cleanupId,
  );

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage }, 'successor-worker', { now: () => START + 30_000 },
  ), true);

  assert.equal(row(c, cleanup.cleanupId).status, 'source_changed');
  assert.equal(fs.readFileSync(cleanup.absolutePath).equals(bytes), true);
  if (collisionType === 'file') assert.equal(fs.readFileSync(collision, 'utf8'), 'collision sentinel');
  else assert.deepEqual(fs.readdirSync(collision), []);
});

test('ZIP quarantine payload collision appearing at rename time is preserved as terminal no-delete', async (t) => {
  const c = fixture(t), bytes = Buffer.from('rename-time collision source');
  const cleanup = insertZipCleanup(c, 'zip-rename-collision', 'incoming/rename-collision.zip', bytes);
  let collision;

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    {
      now: () => START,
      hooks: {
        beforeQuarantineRename() {
          const intent = row(c, cleanup.cleanupId).quarantine_relative_path;
          collision = path.join(c.config.datasetImportMount, ...intent.split('/'), 'payload');
          fs.writeFileSync(collision, 'collision sentinel');
        },
      },
    },
  ), true);

  assert.equal(row(c, cleanup.cleanupId).status, 'cleanup_quarantine_conflict');
  assert.equal(fs.readFileSync(cleanup.absolutePath).equals(bytes), true);
  assert.equal(fs.readFileSync(collision, 'utf8'), 'collision sentinel');
});

test('ZIP quarantine rejects any unexpected entry before moving the source', async (t) => {
  const c = fixture(t), bytes = Buffer.from('non-payload collision source');
  const cleanup = insertZipCleanup(c, 'zip-non-payload-collision', 'incoming/non-payload-collision.zip', bytes);
  let collision;

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    {
      now: () => START,
      hooks: {
        beforeQuarantineRename() {
          const intent = row(c, cleanup.cleanupId).quarantine_relative_path;
          collision = path.join(c.config.datasetImportMount, ...intent.split('/'), 'unexpected');
          fs.writeFileSync(collision, 'collision sentinel');
        },
      },
    },
  ), true);

  assert.equal(row(c, cleanup.cleanupId).status, 'cleanup_quarantine_conflict');
  assert.equal(fs.readFileSync(cleanup.absolutePath).equals(bytes), true);
  assert.equal(fs.readFileSync(collision, 'utf8'), 'collision sentinel');
});

test('staging quarantine payload collision appearing at rename time preserves both trees', async (t) => {
  const c = fixture(t), retainedId = 'staging-rename-collision';
  const cleanupId = insertCleanup(c, retainedId);
  const staging = path.join(c.config.cacheMount, 'webodm-task-imports', retainedId);
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'source.txt'), 'source sentinel');
  let collision;

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    {
      now: () => START,
      hooks: {
        beforeQuarantineRename() {
          const intent = row(c, cleanupId).quarantine_relative_path;
          collision = path.join(c.config.cacheMount, ...intent.split('/'), 'payload');
          fs.mkdirSync(collision);
          fs.writeFileSync(path.join(collision, 'collision.txt'), 'collision sentinel');
        },
      },
    },
  ), true);

  assert.equal(row(c, cleanupId).status, 'cleanup_quarantine_conflict');
  assert.equal(fs.readFileSync(path.join(staging, 'source.txt'), 'utf8'), 'source sentinel');
  assert.equal(fs.readFileSync(path.join(collision, 'collision.txt'), 'utf8'), 'collision sentinel');
});

test('staging quarantine rejects any unexpected entry before moving the source tree', async (t) => {
  const c = fixture(t), retainedId = 'staging-non-payload-collision';
  const cleanupId = insertCleanup(c, retainedId);
  const staging = path.join(c.config.cacheMount, 'webodm-task-imports', retainedId);
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'source.txt'), 'source sentinel');
  let collision;

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    {
      now: () => START,
      hooks: {
        beforeQuarantineRename() {
          const intent = row(c, cleanupId).quarantine_relative_path;
          collision = path.join(c.config.cacheMount, ...intent.split('/'), 'unexpected');
          fs.writeFileSync(collision, 'collision sentinel');
        },
      },
    },
  ), true);

  assert.equal(row(c, cleanupId).status, 'cleanup_quarantine_conflict');
  assert.equal(fs.readFileSync(path.join(staging, 'source.txt'), 'utf8'), 'source sentinel');
  assert.equal(fs.readFileSync(collision, 'utf8'), 'collision sentinel');
});

test('unexpected ZIP quarantine entry after rename preserves the verified phase for retry', async (t) => {
  const c = fixture(t), bytes = Buffer.from('post-rename ZIP collision');
  const cleanup = insertZipCleanup(c, 'zip-post-rename-collision', 'incoming/post-rename-collision.zip', bytes);
  let collision;

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    {
      now: () => START,
      hooks: {
        afterQuarantineRename() {
          const intent = row(c, cleanup.cleanupId).quarantine_relative_path;
          collision = path.join(c.config.datasetImportMount, ...intent.split('/'), 'unexpected');
          fs.writeFileSync(collision, 'collision sentinel');
        },
      },
    },
  ), true);

  const deferred = row(c, cleanup.cleanupId);
  assert.equal(deferred.status, 'quarantined');
  assert.equal(deferred.lease_expires_at, new Date(START + 5000).toISOString());
  assert.equal(fs.existsSync(cleanup.absolutePath), false);
  assert.equal(fs.readFileSync(collision, 'utf8'), 'collision sentinel');
  fs.unlinkSync(collision);
  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'successor-worker',
    { now: () => START + 5000 },
  ), true);
  assert.equal(row(c, cleanup.cleanupId).status, 'complete');
});

test('same-name ZIP quarantine replacement immediately before final rmdir is never deleted', async (t) => {
  const c = fixture(t), bytes = Buffer.from('ZIP quarantine replacement');
  const cleanup = insertZipCleanup(c, 'zip-quarantine-rmdir-replacement', 'incoming/quarantine-rmdir-replacement.zip', bytes);
  const preserved = path.join(c.root, 'preserved-zip-quarantine');
  const realMutate = c.processing.mutateImportCleanupFilesystem.bind(c.processing);
  let replacement;
  c.processing.mutateImportCleanupFilesystem = (id, owner, token, generation, mutate, options) => {
    const current = row(c, cleanup.cleanupId);
    if (!replacement && current.status === 'quarantined') {
      const target = path.join(c.config.datasetImportMount, ...current.quarantine_relative_path.split('/'));
      if (fs.existsSync(target) && fs.readdirSync(target).length === 0) {
        fs.renameSync(target, preserved);
        fs.mkdirSync(target, { mode: 0o700 });
        replacement = target;
      }
    }
    return realMutate(id, owner, token, generation, mutate, options);
  };

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    { now: () => START },
  ), true);

  assert.equal(row(c, cleanup.cleanupId).status, 'quarantined');
  assert.equal(fs.statSync(preserved).isDirectory(), true);
  assert.equal(fs.statSync(replacement).isDirectory(), true);
});

test('unexpected staging quarantine entry after rename preserves the verified phase for retry', async (t) => {
  const c = fixture(t), retainedId = 'staging-post-rename-collision';
  const cleanupId = insertCleanup(c, retainedId);
  const staging = path.join(c.config.cacheMount, 'webodm-task-imports', retainedId);
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'discard.txt'), 'discard');
  let collision;

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    {
      now: () => START,
      hooks: {
        afterQuarantineRename() {
          const intent = row(c, cleanupId).quarantine_relative_path;
          collision = path.join(c.config.cacheMount, ...intent.split('/'), 'unexpected');
          fs.writeFileSync(collision, 'collision sentinel');
        },
      },
    },
  ), true);

  const deferred = row(c, cleanupId);
  assert.equal(deferred.status, 'quarantined');
  assert.equal(deferred.lease_expires_at, new Date(START + 5000).toISOString());
  const warning = c.db.prepare("SELECT payload_json FROM event_outbox WHERE event_type='import.cleanup_warning'").get();
  assert.equal(JSON.parse(warning.payload_json).outcome, 'cleanup_quarantine_conflict');
  assert.ok(c.db.prepare("SELECT 1 FROM audit_events WHERE action='import_cleanup.deferred' AND entity_id=?").get(cleanupId));
  assert.equal(fs.existsSync(staging), false);
  assert.equal(fs.readFileSync(collision, 'utf8'), 'collision sentinel');
  fs.unlinkSync(collision);
  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'successor-worker',
    { now: () => START + 5000 },
  ), true);
  assert.equal(row(c, cleanupId).status, 'complete');
});

test('stale cleanup token cannot perform filesystem mutation after successor reclaim', async (t) => {
  const c = fixture(t), bytes = Buffer.from('stale token source');
  const cleanup = insertZipCleanup(c, 'zip-stale-token', 'incoming/stale-token.zip', bytes);
  const stale = c.processing.claimImportCleanup('stale-worker', { leaseSeconds: 30, at: START });
  const successor = c.processing.claimImportCleanup('successor-worker', { leaseSeconds: 60, at: START + 30_000 });
  let staleMutationReached = false;

  await assert.rejects(
    executeZipCleanup(
      { processing: c.processing, storage: c.storage },
      stale,
      'stale-worker',
      {
        now: () => START + 30_001,
        hooks: { beforeQuarantineRename() { staleMutationReached = true; } },
      },
    ),
    (error) => error?.code === 'lease_lost',
  );
  assert.equal(staleMutationReached, false);
  assert.equal(fs.readFileSync(cleanup.absolutePath).equals(bytes), true);

  await executeZipCleanup(
    { processing: c.processing, storage: c.storage },
    successor,
    'successor-worker',
    { now: () => START + 30_001 },
  );
  assert.equal(row(c, cleanup.cleanupId).status, 'complete');
  assert.equal(fs.existsSync(cleanup.absolutePath), false);
});

test('worker owns a dedicated durable import-cleanup lane', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'worker.js'), 'utf8');
  assert.match(source, /require\('\.\/importCleanup'\)/);
  assert.match(source, /lane\('import-cleanup',\(\)=>processOneImportCleanup/);
  assert.match(source, /lanes=dataset-operation,processing,provider-health,derivative,event,import-cleanup/);
});

test('worker activity counts expose active import cleanup leases', (t) => {
  const c = fixture(t);
  insertCleanup(c, 'cleanup-count');
  c.processing.claimImportCleanup('count-worker', { at: START });
  assert.equal(c.processing.workerWorkCounts().importCleanups, 1);
});

test('cleanup execution refreshes its fenced lease during long filesystem work', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'importCleanup.js'), 'utf8');
  assert.match(source, /heartbeatImportCleanup/);
  assert.match(source, /setInterval\(heartbeat/);
  assert.match(source, /controller\.abort\(\)/);
});

test('authenticated terminal cleanup retry cannot replace the journaled target', async (t) => {
  const c = fixture(t), bytes = Buffer.from('operator retry bytes');
  const cleanup = insertZipCleanup(c, 'zip-operator-retry', 'incoming/operator-retry.zip', bytes);
  const lease = c.processing.claimImportCleanup('cleanup-worker', { at: START });
  assert.equal(c.processing.completeImportCleanupWithoutDelete(
    cleanup.cleanupId,
    'cleanup-worker',
    lease.lease_token,
    lease.lease_generation,
    'source_changed',
    'operator action required',
    { at: START + 1 },
  ), true);
  const before = c.db.prepare(`SELECT relative_path,expected_byte_size,expected_sha256,expected_dev,
    expected_ino,expected_ctime_ns,expected_mtime_ns,quarantine_relative_path FROM import_cleanup_jobs WHERE id=?`).get(cleanup.cleanupId);

  const token = 'cleanup-retry-token-0000000000000000';
  c.processing.createAdminSession({
    tokenHash: auth.hashToken(token),
    subject: 'ops:cleanup',
    permissions: ['viewer.storage.purge'],
    displayUnits: 'imperial',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const app = express();
  app.use(express.json());
  app.use(createProcessingApi({
    repository: new ViewerRepository(c.db), processing: c.processing, storage: c.storage,
  }));
  const server = await new Promise((resolve) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/storage/import-cleanups/${encodeURIComponent(cleanup.cleanupId)}/retry`;
  const baseHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const injected = await fetch(url, {
    method: 'POST', headers: { ...baseHeaders, 'idempotency-key': 'cleanup-path-injection' },
    body: JSON.stringify({ relativePath: 'incoming/other.zip' }),
  });
  assert.equal(injected.status, 400);
  assert.equal((await injected.json()).code, 'invalid_request');

  const retriedResponse = await fetch(url, {
    method: 'POST', headers: { ...baseHeaders, 'idempotency-key': 'cleanup-retry-exact' }, body: '{}',
  });
  assert.equal(retriedResponse.status, 202);
  const responseBody = await retriedResponse.json();
  assert.equal(responseBody.cleanup.id, cleanup.cleanupId);
  assert.equal(responseBody.cleanup.status, 'pending');
  assert.equal(Object.hasOwn(responseBody.cleanup, 'relativePath'), false);
  const after = c.db.prepare(`SELECT relative_path,expected_byte_size,expected_sha256,expected_dev,
    expected_ino,expected_ctime_ns,expected_mtime_ns,quarantine_relative_path FROM import_cleanup_jobs WHERE id=?`).get(cleanup.cleanupId);
  assert.deepEqual(after, before);
  const audit = c.db.prepare("SELECT actor_id FROM audit_events WHERE action='import_cleanup.retry_requested' AND entity_id=?").get(cleanup.cleanupId);
  assert.equal(audit.actor_id, 'ops:cleanup');
});

test('cleanup journal matrix never schedules operator folders or mounted catalogs for deletion', (t) => {
  const c = fixture(t), created = new Date(START).toISOString();
  c.db.prepare(`INSERT INTO retained_imports(
    id,source_kind,source_root_key,source_relative_path,source_byte_size,source_sha256,source_dev,source_ino,
    source_ctime_ns,source_mtime_ns,staging_root_key,staging_relative_path,cleanup_jobs_inserted,state,created_at,updated_at
  ) VALUES ('matrix-zip','backup_zip','dataset_import','incoming/matrix.zip',4,?,'1','2','3','4','cache',
    'webodm-task-imports/matrix-zip',1,'ready',?,?)`).run('a'.repeat(64), created, created);
  c.db.prepare(`INSERT INTO retained_imports(
    id,source_kind,source_root_key,source_relative_path,staging_root_key,staging_relative_path,
    cleanup_jobs_inserted,state,created_at,updated_at
  ) VALUES ('matrix-folder','server_folder','dataset_import','operator/folder','cache',
    'webodm-task-imports/matrix-folder',1,'ready',?,?)`).run(created, created);
  c.db.prepare(`INSERT INTO retained_imports(
    id,source_kind,staging_root_key,staging_relative_path,cleanup_jobs_inserted,state,created_at,updated_at
  ) VALUES ('matrix-node','nodeodm_result','cache','webodm-task-imports/matrix-node',1,'ready',?,?)`).run(created, created);
  for (const id of ['matrix-zip', 'matrix-folder', 'matrix-node']) {
    c.processing.journalRetainedImportCleanup(c.db.prepare('SELECT * FROM retained_imports WHERE id=?').get(id), created);
  }

  const matrix = Object.fromEntries(['matrix-zip', 'matrix-folder', 'matrix-node'].map((id) => [
    id,
    c.db.prepare('SELECT cleanup_type FROM import_cleanup_jobs WHERE retained_import_id=? ORDER BY cleanup_type').all(id).map((item) => item.cleanup_type),
  ]));
  assert.deepEqual(matrix, {
    'matrix-zip': ['source_zip', 'staging_tree'],
    'matrix-folder': ['staging_tree'],
    'matrix-node': ['staging_tree'],
  });
  assert.equal(c.db.prepare("SELECT COUNT(*) n FROM import_cleanup_jobs WHERE root_key IN ('webodm','terra_import')").get().n, 0);
});

test('transient ZIP quarantine rename failure resumes from its empty private intent', async (t) => {
  const c = fixture(t), bytes = Buffer.from('transient rename bytes');
  const cleanup = insertZipCleanup(c, 'zip-transient-rename', 'incoming/transient-rename.zip', bytes);
  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    {
      now: () => START,
      hooks: { beforeQuarantineRename() { throw Object.assign(new Error('temporarily busy'), { code: 'EBUSY' }); } },
    },
  ), true);
  const pending = row(c, cleanup.cleanupId);
  const quarantine = path.join(c.config.datasetImportMount, ...pending.quarantine_relative_path.split('/'));
  assert.equal(pending.status, 'pending');
  assert.equal(fs.readFileSync(cleanup.absolutePath).equals(bytes), true);
  assert.deepEqual(fs.readdirSync(quarantine), []);

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'successor-worker',
    { now: () => START + 5000 },
  ), true);
  assert.equal(row(c, cleanup.cleanupId).status, 'complete');
  assert.equal(fs.existsSync(cleanup.absolutePath), false);
  assert.equal(fs.existsSync(quarantine), false);
});

test('transient staging quarantine rename failure resumes from its empty private intent', async (t) => {
  const c = fixture(t), retainedId = 'staging-transient-rename';
  const cleanupId = insertCleanup(c, retainedId);
  const staging = path.join(c.config.cacheMount, 'webodm-task-imports', retainedId);
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'discard.txt'), 'discard');
  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'cleanup-worker',
    {
      now: () => START,
      hooks: { beforeQuarantineRename() { throw Object.assign(new Error('temporarily busy'), { code: 'EBUSY' }); } },
    },
  ), true);
  const pending = row(c, cleanupId);
  const quarantine = path.join(c.config.cacheMount, ...pending.quarantine_relative_path.split('/'));
  assert.equal(pending.status, 'pending');
  assert.equal(fs.readFileSync(path.join(staging, 'discard.txt'), 'utf8'), 'discard');
  assert.deepEqual(fs.readdirSync(quarantine), []);

  assert.equal(await processOneImportCleanup(
    { processing: c.processing, storage: c.storage },
    'successor-worker',
    { now: () => START + 5000 },
  ), true);
  assert.equal(row(c, cleanupId).status, 'complete');
  assert.equal(fs.existsSync(staging), false);
  assert.equal(fs.existsSync(quarantine), false);
});

test('database requires complete fencing fields for every active cleanup state', (t) => {
  const c = fixture(t), id = insertCleanup(c, 'cleanup-schema-fence');
  assert.throws(
    () => c.db.prepare("UPDATE import_cleanup_jobs SET status='quarantined',quarantine_relative_path='owned.quarantine' WHERE id=?").run(id),
    /CHECK constraint failed/,
  );
  assert.equal(row(c, id).status, 'pending');
});

test('ZIP quarantine fsyncs destination then source parent before delete authorization', async (t) => {
  const c = fixture(t), cleanup = insertZipCleanup(c, 'zip-fsync-order', 'incoming/fsync-order.zip', Buffer.from('fsync bytes'));
  const sourceParent = fs.statSync(path.dirname(cleanup.absolutePath), { bigint: true });
  const realFsync = fs.fsyncSync;
  const realMark = c.processing.markImportCleanupQuarantined.bind(c.processing);
  const synced = [];
  fs.fsyncSync = (fd) => {
    const stat = fs.fstatSync(fd, { bigint: true });
    synced.push(`${stat.dev}:${stat.ino}`);
    return realFsync(fd);
  };
  c.processing.markImportCleanupQuarantined = (...args) => {
    const intent = row(c, cleanup.cleanupId).quarantine_relative_path;
    const quarantine = fs.statSync(path.join(c.config.datasetImportMount, ...intent.split('/')), { bigint: true });
    const quarantineKey = `${quarantine.dev}:${quarantine.ino}`;
    const sourceKey = `${sourceParent.dev}:${sourceParent.ino}`;
    assert.ok(synced.indexOf(quarantineKey) >= 0, 'destination quarantine directory was not fsynced');
    assert.ok(synced.indexOf(sourceKey) > synced.indexOf(quarantineKey), 'source parent must fsync after destination parent');
    return realMark(...args);
  };
  try {
    assert.equal(await processOneImportCleanup(
      { processing: c.processing, storage: c.storage }, 'cleanup-worker', { now: () => START },
    ), true);
  } finally {
    fs.fsyncSync = realFsync;
    c.processing.markImportCleanupQuarantined = realMark;
  }
  assert.equal(row(c, cleanup.cleanupId).status, 'complete');
});

test('every staging rmdir keeps the exact target descriptor open through deletion authorization', async (t) => {
  const c = fixture(t), retainedId = 'staging-held-rmdir';
  const cleanupId = insertCleanup(c, retainedId);
  const staging = path.join(c.config.cacheMount, 'webodm-task-imports', retainedId);
  fs.mkdirSync(path.join(staging, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'nested', 'discard.txt'), 'discard');
  const lease = c.processing.claimImportCleanup('cleanup-worker', { at: START });
  const realRmdir = fs.rmdirSync;
  const removed = [];
  fs.rmdirSync = (target, ...args) => {
    const named = fs.lstatSync(target, { bigint: true });
    assert.equal(
      hasHeldDirectoryDescriptor(named),
      true,
      `rmdir target ${path.basename(String(target))} has no held descriptor`,
    );
    removed.push(path.basename(String(target)));
    return realRmdir(target, ...args);
  };
  try {
    await executeStagingCleanup(
      { processing: c.processing, storage: c.storage },
      lease,
      'cleanup-worker',
      { now: () => START + 1 },
    );
  } finally {
    fs.rmdirSync = realRmdir;
  }
  assert.ok(removed.includes('nested'));
  assert.ok(removed.includes('payload'));
  assert.ok(removed.some((name) => name.endsWith('.quarantine')));
  assert.equal(row(c, cleanupId).status, 'complete');
});

test('ZIP quarantine rmdir keeps the exact target descriptor open through deletion authorization', async (t) => {
  const c = fixture(t);
  const cleanup = insertZipCleanup(c, 'zip-held-rmdir', 'incoming/held-rmdir.zip', Buffer.from('held ZIP bytes'));
  const lease = c.processing.claimImportCleanup('cleanup-worker', { at: START });
  const realRmdir = fs.rmdirSync;
  let removed = 0;
  fs.rmdirSync = (target, ...args) => {
    const named = fs.lstatSync(target, { bigint: true });
    assert.equal(hasHeldDirectoryDescriptor(named), true, 'ZIP quarantine rmdir has no held descriptor');
    removed += 1;
    return realRmdir(target, ...args);
  };
  try {
    await executeZipCleanup(
      { processing: c.processing, storage: c.storage },
      lease,
      'cleanup-worker',
      { now: () => START + 1 },
    );
  } finally {
    fs.rmdirSync = realRmdir;
  }
  assert.equal(removed, 1);
  assert.equal(row(c, cleanup.cleanupId).status, 'complete');
});

test('staging quarantine refuses a same-name root replacement at rename authorization', async (t) => {
  const c = fixture(t), retainedId = 'staging-root-rename-swap';
  const cleanupId = insertCleanup(c, retainedId);
  const staging = path.join(c.config.cacheMount, 'webodm-task-imports', retainedId);
  const preserved = path.join(c.root, 'preserved-staging-root');
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'original.txt'), 'original staging tree');
  const lease = c.processing.claimImportCleanup('cleanup-worker', { at: START });

  await assert.rejects(
    executeStagingCleanup(
      { processing: c.processing, storage: c.storage },
      lease,
      'cleanup-worker',
      {
        now: () => START + 1,
        hooks: {
          beforeQuarantineRename() {
            fs.renameSync(staging, preserved);
            fs.mkdirSync(staging);
            fs.writeFileSync(path.join(staging, 'replacement.txt'), 'replacement staging tree');
          },
        },
      },
    ),
    (error) => error?.code === 'cleanup_path_changed',
  );
  assert.equal(fs.readFileSync(path.join(preserved, 'original.txt'), 'utf8'), 'original staging tree');
  assert.equal(fs.readFileSync(path.join(staging, 'replacement.txt'), 'utf8'), 'replacement staging tree');
  assert.equal(row(c, cleanupId).status, 'leased');
});
