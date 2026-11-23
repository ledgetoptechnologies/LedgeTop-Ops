'use strict';

// Builds 1 MiB chunk hashes for files that are already registered. Sets are
// keyed by the whole-file SHA-256 the registry recorded when the file was
// imported, never by anything read from disk: a set is stored only when the
// same read pass that produced the chunk hashes also reproduced that SHA-256
// and size. A changed file can therefore never receive a set.
//
// model_asset_chunks is deliberately left alone: LOD recovery and supersession
// compare those rows byte for byte with plans saved earlier.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { scopedStorageRootKey } = require('./storageManager');

const CONTENT_CHUNK_BYTES = 1024 * 1024;
const MIN_FILE_BYTES = 4 * 1024 * 1024;
const BYTES_PER_SECOND = 50 * 1024 * 1024;
// One scan returns at most SCAN_LIMIT digests and LOCATIONS_PER_DIGEST rows for
// each, however often a file is registered.
const SCAN_LIMIT = 500;
const LOCATIONS_PER_DIGEST = 8;
const RESCAN_MS = 10 * 60 * 1000;
const HOLD_POLL_MS = 250;
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_RETRY_MS = 60 * 60 * 1000;
const RECENT_SESSION_MS = 30 * DAY_MS;
const PAUSE_KEY = 'content_chunk_backfill_paused';
// The registry and the bytes disagree; retried daily, audited once per digest.
const MISMATCH_REASONS = new Set(['digest_mismatch', 'size_mismatch', 'manifest_mismatch']);
// Reported when several locations of one digest fail for different reasons.
const REASON_RANK = ['unavailable', 'unsafe_path', 'read_error', 'manifest_mismatch', 'size_mismatch', 'digest_mismatch'];

const isDigest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Same roots as delivery (canonicalAssetRoot in assets.js). Kept as a copy only
// until the delivery change that shares it; the test compares the two.
function backfillRoot({ provider, locator }, rootKey, config) {
  const legacyRoot = locator.legacyAssetRoots && locator.legacyAssetRoots[rootKey];
  if (legacyRoot) return legacyRoot;
  const scoped = scopedStorageRootKey(rootKey);
  if (scoped === 'webodm') return config.webodmMediaMount;
  if (scoped === 'terra_import') return config.terraImportMount;
  if (rootKey === 'models') return config.modelsMount;
  if (rootKey === 'datasets') return config.datasetsMount;
  if (locator.catalogImport && rootKey === 'webodm') return config.webodmMediaMount;
  if (locator.catalogImport && rootKey === 'terra') return config.terraImportMount;
  if (provider === 'webodm' && locator.projectId !== null && locator.taskId !== null) {
    if (rootKey === 'webodm') return path.join(config.webodmMediaMount, 'project', String(locator.projectId), 'task', String(locator.taskId), 'assets');
    if (rootKey === 'derivatives' && config.derivativesMount) return path.join(config.derivativesMount, `${locator.projectId}-${locator.taskId}`);
  }
  return null;
}

// Every registered location of a delivered file of at least 4 MiB, best first:
// 1 shared or recently viewed rasters, 2 those models' photos, 3 other
// published files, 4 review files, 5 downloads (GLB, OBJ, LAZ).
const LOCATED_SQL = `
  WITH live_models AS MATERIALIZED (
    SELECT model_id FROM public_shares WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at>:now)
    UNION SELECT o.model_id FROM public_project_shares s JOIN model_outputs o ON o.project_id=s.project_id
      WHERE s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>:now)
    UNION SELECT model_id FROM viewer_sessions WHERE created_at>:recent
  ), versions AS MATERIALIZED (
    SELECT v.id,COALESCE(m.active_version_id=v.id,0) AS active,m.id IN (SELECT model_id FROM live_models) AS live
    FROM model_versions v JOIN models m ON m.id=v.model_id LEFT JOIN model_outputs o ON o.id=v.id
    WHERE v.status='ready' AND m.status<>'unregistered' AND COALESCE(o.status,'') NOT IN ('trashed','failed','staged')
  ), located AS MATERIALIZED (
    SELECT a.sha256,a.byte_size,
      CASE WHEN a.kind IN ('glb','obj','pointCloud') THEN 5
        WHEN a.published=0 OR NOT v.active THEN 4
        WHEN v.live AND a.kind IN ('ortho','dsm','dtm') THEN 1 ELSE 3 END AS tier,
      a.kind AS kind,v.id AS version_id,a.root_key,a.relative_path,NULL AS asset_id
    FROM model_assets a JOIN versions v ON v.id=a.version_id
    WHERE a.kind NOT IN ('ept','tiles') AND a.sha256 IS NOT NULL AND a.byte_size>=:minimum
    UNION ALL
    SELECT f.sha256,f.byte_size,CASE WHEN a.published=0 OR NOT v.active THEN 4 ELSE 3 END,
      a.kind,v.id,a.root_key,f.relative_path,a.id
    FROM model_asset_files f JOIN model_assets a ON a.id=f.asset_id JOIN versions v ON v.id=a.version_id
    WHERE a.kind IN ('ept','tiles') AND a.manifest_sha256 IS NOT NULL AND f.byte_size>=:minimum
    UNION ALL
    SELECT p.sha256,p.byte_size,CASE WHEN NOT v.active THEN 4 WHEN v.live THEN 2 ELSE 3 END,
      'cameraPhoto',v.id,p.root_key,p.relative_path,NULL
    FROM model_camera_photos p JOIN versions v ON v.id=p.version_id
    WHERE p.byte_size>=:minimum
  )`;

const CANDIDATES_SQL = `${LOCATED_SQL}, picked AS MATERIALIZED (
    SELECT l.sha256,l.byte_size,MIN(l.tier) AS tier,COUNT(*) OVER () AS total_files,SUM(l.byte_size) OVER () AS total_bytes
    FROM located l
    WHERE length(l.sha256)=64 AND l.sha256 NOT GLOB '*[^0-9a-f]*'
      AND NOT EXISTS (SELECT 1 FROM content_chunk_sets s WHERE s.content_sha256=l.sha256)
      AND NOT EXISTS (SELECT 1 FROM content_chunk_failures f WHERE f.content_sha256=l.sha256 AND f.byte_size=l.byte_size AND f.next_attempt_at>:now)
    GROUP BY l.sha256,l.byte_size
    ORDER BY 3,2,1 LIMIT :limit
  )
  , places AS MATERIALIZED (
    -- One physical file is one place: models and datasets paths do not depend
    -- on the version. A retry of a failed digest moves on to the next places.
    SELECT p.sha256,p.byte_size,p.tier,p.total_files,p.total_bytes,l.kind,l.version_id,l.root_key,l.relative_path,l.asset_id,l.place_tier,
      ROW_NUMBER() OVER (PARTITION BY p.sha256,p.byte_size ORDER BY l.place_tier,l.root_key,l.relative_path,l.version_id,l.asset_id)-1 AS place,
      COUNT(*) OVER (PARTITION BY p.sha256,p.byte_size) AS place_count,
      COALESCE(f.attempts,0) AS attempts
    FROM picked p JOIN (
      SELECT q.sha256,q.byte_size,MIN(q.kind) AS kind,MIN(q.version_id) AS version_id,q.root_key,q.relative_path,q.asset_id,MIN(q.tier) AS place_tier
      FROM located q WHERE (q.sha256,q.byte_size) IN (SELECT sha256,byte_size FROM picked)
      GROUP BY q.sha256,q.byte_size,q.root_key,q.relative_path,q.asset_id,CASE WHEN q.root_key IN ('models','datasets') THEN '' ELSE q.version_id END
    ) l ON l.sha256=p.sha256 AND l.byte_size=p.byte_size
    LEFT JOIN content_chunk_failures f ON f.content_sha256=p.sha256 AND f.byte_size=p.byte_size
  )
  SELECT * FROM places
  WHERE (place+place_count-(attempts*:places)%place_count)%place_count<:places
  ORDER BY tier,byte_size,sha256,(place+place_count-(attempts*:places)%place_count)%place_count`;

function scanParameters(at) {
  return { now: new Date(at).toISOString(), recent: new Date(at - RECENT_SESSION_MS).toISOString(), minimum: MIN_FILE_BYTES };
}

function scanCandidates(database, { at = Date.now(), limit = SCAN_LIMIT } = {}) {
  const items = new Map();
  let totalFiles = 0, totalBytes = 0;
  for (const row of database.prepare(CANDIDATES_SQL).all({ ...scanParameters(at), limit, places: LOCATIONS_PER_DIGEST })) {
    totalFiles = row.total_files;
    totalBytes = row.total_bytes;
    const key = `${row.sha256}:${row.byte_size}`;
    if (!items.has(key)) items.set(key, { sha256: row.sha256, byteSize: row.byte_size, tier: row.tier, kind: row.kind, locations: [] });
    items.get(key).locations.push({ versionId: row.version_id, rootKey: row.root_key, relativePath: row.relative_path, assetId: row.asset_id });
  }
  return { items: [...items.values()], totalFiles, totalBytes };
}

// Counts only. Files without a usable recorded hash have no source of truth, so
// they are listed here and never hashed.
function contentChunkReport(database, { at = Date.now() } = {}) {
  const pending = database.prepare(`${LOCATED_SQL}
    SELECT COUNT(*) AS files,COALESCE(SUM(byte_size),0) AS bytes FROM (
      SELECT DISTINCT l.sha256,l.byte_size FROM located l
      WHERE length(l.sha256)=64 AND l.sha256 NOT GLOB '*[^0-9a-f]*'
        AND NOT EXISTS (SELECT 1 FROM content_chunk_sets s WHERE s.content_sha256=l.sha256)
        AND NOT EXISTS (SELECT 1 FROM content_chunk_failures f WHERE f.content_sha256=l.sha256 AND f.byte_size=l.byte_size AND f.next_attempt_at>:now))`)
    .get(scanParameters(at));
  const done = database.prepare('SELECT COUNT(*) AS files,COALESCE(SUM(byte_size),0) AS bytes FROM content_chunk_sets').get();
  const failed = Object.fromEntries(database.prepare('SELECT reason,COUNT(*) AS n FROM content_chunk_failures GROUP BY reason ORDER BY reason').all().map((row) => [row.reason, row.n]));
  const skipped = {
    noRecordedHash: database.prepare("SELECT COUNT(*) AS n FROM model_assets WHERE sha256 IS NULL AND kind NOT IN ('ept','tiles')").get().n,
    invalidRecordedHash: database.prepare(`SELECT
        (SELECT COUNT(*) FROM model_assets WHERE sha256 IS NOT NULL AND (length(sha256)<>64 OR sha256 GLOB '*[^0-9a-f]*'))
        +(SELECT COUNT(*) FROM model_asset_files WHERE byte_size>=:minimum AND sha256 GLOB '*[^0-9a-f]*')
        +(SELECT COUNT(*) FROM model_camera_photos WHERE byte_size>=:minimum AND sha256 GLOB '*[^0-9a-f]*') AS n`).get({ minimum: MIN_FILE_BYTES }).n,
    noRecordedManifest: database.prepare("SELECT COUNT(*) AS n FROM model_assets WHERE kind IN ('ept','tiles') AND manifest_sha256 IS NULL").get().n,
    // One hash recorded with two sizes: the stored set proves one of them wrong.
    sizeConflict: database.prepare(`${LOCATED_SQL} SELECT COUNT(*) AS n FROM located l JOIN content_chunk_sets s ON s.content_sha256=l.sha256 WHERE s.byte_size<>l.byte_size`).get(scanParameters(at)).n,
  };
  return { pending: { files: pending.files, bytes: pending.bytes }, done: { files: done.files, bytes: done.bytes }, failed, skipped, paused: isPaused(database) };
}

function isPaused(database) {
  return database.prepare('SELECT value FROM app_state WHERE key=?').get(PAUSE_KEY)?.value === 'true';
}

function setPaused(database, paused) {
  database.prepare('INSERT INTO app_state(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
    .run(PAUSE_KEY, paused ? 'true' : 'false', new Date().toISOString());
}

// Paces reads to a fixed rate with no saved-up burst after an idle period.
function createByteBudget({ bytesPerSecond = BYTES_PER_SECOND, now = Date.now, wait = (ms, signal) => sleep(ms, undefined, { signal }) } = {}) {
  let freeAt = 0;
  return async function take(bytes, signal) {
    const at = now(), startsAt = Math.max(at, freeAt);
    freeAt = startsAt + (bytes / bytesPerSecond) * 1000;
    if (startsAt > at) await wait(startsAt - at, signal);
  };
}

function failure(reason) { return Object.assign(new Error(reason), { backfillReason: reason }); }

function reasonFor(error) {
  if (error.backfillReason) return error.backfillReason;
  if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return 'unavailable';
  if (error.code === 'ELOOP') return 'unsafe_path';
  return 'read_error';
}

// Opens one regular file strictly inside its root, following no symbolic link.
// Only O_RDONLY is ever used; nothing here creates, changes or removes a file.
async function openRegistered(root, relativePath) {
  if (!root || !path.isAbsolute(root)) throw failure('unavailable');
  const normalized = String(relativePath || '').replaceAll('\\', '/');
  if (!normalized || normalized.includes('\0') || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)
    || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) throw failure('unsafe_path');
  const realRoot = await fs.promises.realpath(root);
  let current = realRoot;
  for (const segment of normalized.split('/')) {
    current = path.join(current, segment);
    if ((await fs.promises.lstat(current)).isSymbolicLink()) throw failure('unsafe_path');
  }
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
  const handle = await fs.promises.open(current, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw failure('unsafe_path');
    // The descriptor, not the name, has to be the registered path in the root:
    // a directory swapped between the checks above and the open is refused.
    if (process.platform === 'linux') {
      if (await fs.promises.readlink(`/proc/self/fd/${handle.fd}`) !== current) throw failure('unsafe_path');
    } else {
      const opened = await fs.promises.realpath(current), named = await fs.promises.stat(opened, { bigint: true });
      if (!opened.startsWith(`${realRoot}${path.sep}`) || named.dev !== stat.dev || named.ino !== stat.ino) throw failure('unsafe_path');
    }
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

const sameFile = (left, right) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) => left[key] === right[key]);

class ContentChunkBackfill {
  constructor({ database, config, signal = new AbortController().signal, busy = () => false, log = console.log, now = Date.now, budget = createByteBudget(), hold = (ms, aborted) => sleep(ms, undefined, { signal: aborted }) }) {
    Object.assign(this, { database, config, signal, busy, log, now, budget, hold });
    this.queue = [];
    this.nextScanAt = 0;
    this.manifests = new Map();
    this.pauseCheckedAt = -Infinity;
    this.paused = false;
    this.lastSkipped = '';
    this.progress = { remaining: null, remainingBytes: null, stored: 0, failed: 0 };
  }

  // One file per turn. False means there is nothing to do right now.
  async runOne() {
    if (this.signal.aborted || this.held()) return false;
    if (!this.queue.length && !this.scan()) return false;
    const item = this.queue.shift();
    try {
      await this.backfill(item);
      return true;
    } catch (error) {
      // A stop leaves nothing behind: the file is simply hashed again later.
      if (this.signal.aborted) return false;
      this.nextScanAt = this.now() + RESCAN_MS;
      throw error;
    }
  }

  status() { return { ...this.progress, paused: this.paused }; }

  held({ fresh = false } = {}) {
    const at = this.now();
    if (fresh || at - this.pauseCheckedAt >= 1000) { this.paused = isPaused(this.database); this.pauseCheckedAt = at; }
    return this.paused || this.busy();
  }

  async waitWhileHeld(options) {
    while (!this.signal.aborted && this.held(options)) await this.hold(HOLD_POLL_MS, this.signal);
    this.signal.throwIfAborted();
  }

  // Every result, good or bad, is recorded here: after the file is closed, with
  // no await between the last stop and pause check and the commit.
  async publish(record) {
    for (;;) {
      await this.waitWhileHeld({ fresh: true });
      const published = this.transaction(() => {
        this.signal.throwIfAborted();
        return isPaused(this.database) ? null : { value: record() };
      });
      if (published) return published.value;
    }
  }

  scan() {
    const at = this.now();
    if (at < this.nextScanAt) return false;
    const { items, totalFiles, totalBytes } = scanCandidates(this.database, { at });
    this.manifests.clear();
    this.queue = items;
    this.progress.remaining = totalFiles;
    this.progress.remainingBytes = totalBytes;
    if (items.length) { this.log(`Content chunk backfill: remaining=${totalFiles} remaining-mib=${Math.round(totalBytes / CONTENT_CHUNK_BYTES)}`); return true; }
    this.nextScanAt = at + RESCAN_MS;
    const report = contentChunkReport(this.database, { at }), skipped = JSON.stringify([report.skipped, report.failed]);
    if (skipped !== this.lastSkipped) {
      this.lastSkipped = skipped;
      this.log(`Content chunk backfill idle: done=${report.done.files} failed=${JSON.stringify(report.failed)} skipped=${JSON.stringify(report.skipped)}`);
    }
    return false;
  }

  version(versionId) {
    const row = this.database.prepare('SELECT m.provider,v.source_locator_json FROM model_versions v JOIN models m ON m.id=v.model_id WHERE v.id=?').get(versionId);
    if (!row) throw failure('unavailable');
    let locator = {};
    try { locator = JSON.parse(row.source_locator_json) || {}; } catch { /* an unreadable locator resolves only the fixed roots */ }
    return { provider: row.provider, locator };
  }

  // The tree digest has to follow from the rows it was recorded with; the sort
  // and fields are the ones hashTree used (see lodRecoveryCompanions.js).
  manifestIntact(assetId) {
    if (!this.manifests.has(assetId)) {
      const asset = this.database.prepare('SELECT relative_path,manifest_sha256 FROM model_assets WHERE id=?').get(assetId);
      const files = this.database.prepare('SELECT relative_path AS relativePath,byte_size AS byteSize,sha256 FROM model_asset_files WHERE asset_id=?').all(assetId)
        .map(({ relativePath, byteSize, sha256 }) => ({ relativePath, byteSize, sha256 })).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      this.manifests.set(assetId, { directory: asset && path.posix.dirname(asset.relative_path),
        intact: Boolean(asset) && crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex') === asset.manifest_sha256 });
    }
    return this.manifests.get(assetId);
  }

  async backfill(item) {
    // Another worker may have finished this file since the scan.
    if (this.database.prepare('SELECT 1 FROM content_chunk_sets WHERE content_sha256=?').get(item.sha256)) { this.settled(item); return; }
    const startedAt = this.now(), tried = new Set();
    let reason = null;
    for (const location of item.locations) {
      try {
        let relativePath = location.relativePath;
        if (location.assetId) {
          const manifest = this.manifestIntact(location.assetId);
          if (!manifest.intact) throw failure('manifest_mismatch');
          relativePath = path.posix.join(manifest.directory, relativePath);
        }
        const root = backfillRoot(this.version(location.versionId), location.rootKey, this.config);
        if (tried.has(`${root}\0${relativePath}`)) continue;
        tried.add(`${root}\0${relativePath}`);
        const digests = await this.hash(root, relativePath, item);
        // A tampered copy elsewhere is still reported when another copy is good.
        const mismatch = MISMATCH_REASONS.has(reason) ? reason : null;
        const stored = await this.publish(() => { if (mismatch) this.audit(item, mismatch); return this.store(item, digests); });
        if (stored) this.progress.stored += 1;
        this.settled(item);
        this.log(`Content chunk backfill: ${stored ? 'stored' : 'already stored'} sha256=${item.sha256.slice(0, 12)} kind=${item.kind} bytes=${item.byteSize} ms=${this.now() - startedAt}`);
        return;
      } catch (error) {
        // Only a file that cannot be proven is a result; anything else is a bug
        // or a database problem and must not be recorded against the file.
        if (this.signal.aborted || !(error.backfillReason || error.syscall)) throw error;
        const next = reasonFor(error);
        if (reason === null || REASON_RANK.indexOf(next) > REASON_RANK.indexOf(reason)) reason = next;
      }
    }
    const outcome = reason || 'unavailable', recorded = await this.publish(() => this.fail(item, outcome));
    if (recorded) this.progress.failed += 1;
    this.settled(item);
    this.log(`Content chunk backfill: ${outcome}${recorded ? '' : ' (already stored from another copy)'} sha256=${item.sha256.slice(0, 12)} kind=${item.kind} bytes=${item.byteSize}`);
  }

  settled(item) {
    if (this.progress.remaining) { this.progress.remaining -= 1; this.progress.remainingBytes -= item.byteSize; }
  }

  // One sequential pass. The same buffer feeds the whole-file hash and the
  // chunk hash, so the chunk hashes describe exactly the bytes that were proven.
  async hash(root, relativePath, { sha256, byteSize }) {
    const { handle, stat } = await openRegistered(root, relativePath);
    try {
      if (stat.size !== BigInt(byteSize)) throw failure('size_mismatch');
      const whole = crypto.createHash('sha256'), digests = Buffer.alloc(32 * Math.ceil(byteSize / CONTENT_CHUNK_BYTES));
      const buffer = Buffer.allocUnsafe(Math.min(CONTENT_CHUNK_BYTES, byteSize));
      for (let offset = 0, index = 0; offset < byteSize; index += 1) {
        await this.waitWhileHeld();
        const size = Math.min(CONTENT_CHUNK_BYTES, byteSize - offset);
        await this.budget(size, this.signal);
        this.signal.throwIfAborted();
        let filled = 0;
        while (filled < size) {
          const { bytesRead } = await handle.read(buffer, filled, size - filled, offset + filled);
          if (!bytesRead) throw failure('size_mismatch');
          filled += bytesRead;
        }
        const bytes = buffer.subarray(0, size);
        whole.update(bytes);
        crypto.createHash('sha256').update(bytes).digest().copy(digests, 32 * index);
        offset += size;
      }
      if ((await handle.read(Buffer.allocUnsafe(1), 0, 1, byteSize)).bytesRead) throw failure('size_mismatch');
      if (whole.digest('hex') !== sha256) throw failure('digest_mismatch');
      // A file touched while it was read is read again later, even though the
      // bytes of this pass were the recorded ones.
      if (!sameFile(stat, await handle.stat({ bigint: true }))) throw failure('read_error');
      return digests;
    } finally { await handle.close(); }
  }

  transaction(run) {
    this.database.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.database.exec('COMMIT'); return result; }
    catch (error) { if (this.database.isTransaction) this.database.exec('ROLLBACK'); throw error; }
  }

  // Idempotent: a second worker that raced on the same file changes nothing.
  store({ sha256, byteSize }, digests) {
    const inserted = this.database.prepare('INSERT INTO content_chunk_sets(content_sha256,byte_size,chunk_size,digests,created_at) VALUES (?,?,?,?,?) ON CONFLICT(content_sha256) DO NOTHING')
      .run(sha256, byteSize, CONTENT_CHUNK_BYTES, digests, new Date(this.now()).toISOString()).changes === 1;
    this.database.prepare('DELETE FROM content_chunk_failures WHERE content_sha256=? AND byte_size=?').run(sha256, byteSize);
    return inserted;
  }

  // Runs in the same transaction as the check for a finished set, so a worker
  // that failed on one copy can never leave a retry record for a digest another
  // worker has just proven. A mismatch is still audited.
  fail(item, reason) {
    if (MISMATCH_REASONS.has(reason)) this.audit(item, reason);
    if (this.database.prepare('SELECT 1 FROM content_chunk_sets WHERE content_sha256=?').get(item.sha256)) {
      this.database.prepare('DELETE FROM content_chunk_failures WHERE content_sha256=? AND byte_size=?').run(item.sha256, item.byteSize);
      return false;
    }
    const at = this.now(), previous = this.database.prepare('SELECT attempts FROM content_chunk_failures WHERE content_sha256=? AND byte_size=?').get(item.sha256, item.byteSize);
    const attempts = (previous?.attempts || 0) + 1;
    const delay = MISMATCH_REASONS.has(reason) ? DAY_MS : Math.min(DAY_MS, FIRST_RETRY_MS * 2 ** Math.min(attempts - 1, 10));
    this.database.prepare(`INSERT INTO content_chunk_failures(content_sha256,byte_size,reason,attempts,next_attempt_at,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(content_sha256,byte_size) DO UPDATE SET reason=excluded.reason,attempts=excluded.attempts,next_attempt_at=excluded.next_attempt_at,updated_at=excluded.updated_at`)
      .run(item.sha256, item.byteSize, reason, attempts, new Date(at + delay).toISOString(), new Date(at).toISOString());
    return true;
  }

  // Once per digest, size and reason, however often the daily retry fails again.
  audit(item, reason) {
    if (this.database.prepare(`SELECT 1 FROM audit_events WHERE entity_type='content_chunks' AND entity_id=?
      AND json_extract(details_json,'$.reason')=? AND json_extract(details_json,'$.byteSize')=? LIMIT 1`).get(item.sha256, reason, item.byteSize)) return;
    const details = JSON.stringify({ reason, kind: item.kind, byteSize: item.byteSize, versionId: item.locations[0].versionId });
    this.database.prepare("INSERT INTO audit_events(id,actor_type,actor_id,action,entity_type,entity_id,details_json,created_at) VALUES (?,'system',NULL,'content_chunks.verification_failed','content_chunks',?,?,?)")
      .run(crypto.randomUUID(), item.sha256, details, new Date(this.now()).toISOString());
  }
}

module.exports = { BYTES_PER_SECOND, CONTENT_CHUNK_BYTES, ContentChunkBackfill, MIN_FILE_BYTES, RESCAN_MS, backfillRoot, contentChunkReport, createByteBudget, isPaused, LOCATIONS_PER_DIGEST, openRegistered, scanCandidates, setPaused };
