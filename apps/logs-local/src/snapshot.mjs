// Snapshot import: brings the existing Cloudflare Logs history (D1 rows and R2 objects, exported read-only by the
// operator) into the local Logs host, exactly and only by adding.
//
// A snapshot is a folder:
//   manifest.json          { format, label, source, tables: { <table>: { file, rows, bytes, sha256 } },
//                            objects?: { file, count, bytes, sha256 } }
//   tables/<table>.jsonl   one JSON object per line: the row exactly as exported (column -> value)
//   objects.jsonl          (operator input to pack) one { key, file, sourceBytes, sourceEtag, sourceSha256? } per
//                          line: an R2 object, the local file holding its ORIGINAL bytes, and the source's own size
//                          and ETag from R2 head/list (sourceSha256 only for multipart objects)
//   objects.manifest.jsonl (written by pack) the same plus each file's bytes and sha256
//   objects/...            the object files
// The snapshot id is the SHA-256 of manifest.json; every file is checked against the manifest's size and SHA-256
// before anything is written.
//
// Rules:
//   - Add only. A row whose key already exists must be identical (compared by SQLite, column by column), else the
//     import stops before writing anything (planned) or at that row (raced): nothing is ever overwritten or deleted.
//   - Original ids, messages, tracks, raw logs, owners and attributions are kept as exported. Unknown pilots stay as
//     exported (attribution changes are admin-only and audited elsewhere).
//   - DJI keychains are kept as the EXACT sealed ciphertext and iv, with provenance (keychain_provenance). They were
//     sealed with the source's key: a new local key cannot open them, and nothing here decrypts, re-seals or drops them.
//   - Objects are stored create-only with their SHA-256 checked while writing; objects go in before the rows that
//     reference them.
//   - Resumable: running again after an interruption skips identical rows and objects and finishes the rest.
//   - Controller sign-ins (device tokens) need an explicit operator choice: 'preserve' keeps devices as exported
//     (controllers keep working once the local host serves them, still subject to Ops eligibility), 'revoke' imports
//     them revoked (every controller signs in again). Pending sign-in requests are never imported.
//   - Receipts are aggregate counts only: no row contents, ids, coordinates, serials or key material.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

export const SNAPSHOT_FORMAT = 'ledgetop-logs-snapshot/1';
/** The only importable tables, in foreign-key order. */
export const SNAPSHOT_TABLES = Object.freeze(['aircraft', 'batteries', 'controllers', 'imports', 'flights', 'import_items',
  'flight_tags', 'flight_messages', 'keychains', 'audit_events', 'devices', 'raw_logs']);
const OBJECT_PREFIXES = ['telemetry/', 'raw/'];
const MANIFEST_LIMIT = 1024 * 1024;
const LINE_LIMIT = 4 * 1024 * 1024;
const CHUNK_ROWS = 500;
const SAFE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IMPORT_ACTOR = 'system:snapshot-import';

export class SnapshotError extends Error {
  /** Messages carry codes, table names, column names and counts only. */
  constructor(code, message) { super(message); this.name = 'SnapshotError'; this.code = code; }
}

const sha256Hex = data => createHash('sha256').update(data).digest('hex');
const isCount = n => Number.isSafeInteger(n) && n >= 0;

/** A file inside the snapshot folder: a plain relative path, no links anywhere along it, a regular file. */
function snapshotFile(root, relative) {
  if (typeof relative !== 'string' || !SAFE_PATH.test(relative) || relative.split('/').some(part => part === '.' || part === '..'))
    throw new SnapshotError('snapshot_path', 'A snapshot file path is not a plain relative path.');
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) throw new SnapshotError('snapshot_file_missing', `Snapshot file missing: ${relative}`);
    if (stat.isSymbolicLink()) throw new SnapshotError('snapshot_path', `Snapshot paths may not contain links: ${relative}`);
  }
  if (!fs.lstatSync(current).isFile()) throw new SnapshotError('snapshot_path', `Not a regular file: ${relative}`);
  return current;
}

async function fileDigest(file) {
  const hash = createHash('sha256'), md5 = createHash('md5');
  let bytes = 0, head = Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk); md5.update(chunk); bytes += chunk.length;
    if (head.length < 2) head = Buffer.concat([head, chunk.subarray(0, 2 - head.length)]);
  }
  return { bytes, sha256: hash.digest('hex'), md5: md5.digest('hex'), gzip: head[0] === 0x1f && head[1] === 0x8b };
}

/**
 * The object file must be the source's ORIGINAL bytes, not a transport's re-encoding (an R2 read that decompressed
 * a .json.gz, or a JSON wrapper that re-serialized it). It is checked against the source's own metadata (taken from
 * an R2 head/list, which reports what was stored): the original size, and either the single-part ETag (an MD5 of the
 * bytes) or, for a multipart ETag, a source SHA-256. A .gz key must still be gzip.
 */
function checkSourceIdentity(o, digest) {
  const etag = typeof o.sourceEtag === 'string' ? o.sourceEtag.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1').toLowerCase() : null;
  if (!isCount(o.sourceBytes) || !etag) throw new SnapshotError('snapshot_object_source', 'Each object needs the source size and ETag (from R2 head or list).');
  if (digest.bytes !== o.sourceBytes) throw new SnapshotError('snapshot_object_transformed', 'An object file is not the original size: the export changed its bytes.');
  if (/^[0-9a-f]{32}$/.test(etag)) {
    if (digest.md5 !== etag) throw new SnapshotError('snapshot_object_transformed', 'An object file does not match its source ETag: the export changed its bytes.');
  } else if (/^[0-9a-f]{32}-\d{1,5}$/.test(etag)) {
    if (!SHA256.test(o.sourceSha256 ?? '')) throw new SnapshotError('snapshot_object_source', 'A multipart object needs its source SHA-256 (its ETag is not a content hash).');
    if (digest.sha256 !== o.sourceSha256) throw new SnapshotError('snapshot_object_transformed', 'An object file does not match its source SHA-256: the export changed its bytes.');
  } else throw new SnapshotError('snapshot_object_source', 'An object has an unrecognised source ETag.');
  if (/\.gz$/i.test(o.key) && !digest.gzip) throw new SnapshotError('snapshot_object_transformed', 'A .gz object is no longer gzip: the export decompressed it.');
  return { sourceBytes: o.sourceBytes, sourceEtag: etag, ...(o.sourceSha256 ? { sourceSha256: o.sourceSha256 } : {}) };
}

async function checkFile(root, entry, what, check) {
  const file = snapshotFile(root, entry.file);
  const actual = await fileDigest(file);
  if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256)
    throw new SnapshotError('snapshot_checksum', `${what} does not match the manifest (size or SHA-256).`);
  check?.(actual);
  return file;
}

/** Each line as a parsed JSON object (bounded line length). */
async function* jsonLines(file, what) {
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024 }), crlfDelay: Infinity });
  let number = 0;
  for await (const line of lines) {
    number++;
    if (!line.trim()) continue;
    if (line.length > LINE_LIMIT) throw new SnapshotError('snapshot_row', `${what}: line ${number} is too long.`);
    let value;
    try { value = JSON.parse(line); } catch { throw new SnapshotError('snapshot_row', `${what}: line ${number} is not JSON.`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SnapshotError('snapshot_row', `${what}: line ${number} is not an object.`);
    yield value;
  }
}

/** Reads and checks manifest.json and every file it lists. */
export async function readSnapshot(root) {
  root = path.resolve(root);
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new SnapshotError('snapshot_path', 'The snapshot must be a real folder.');
  const manifestFile = snapshotFile(root, 'manifest.json');
  if (fs.statSync(manifestFile).size > MANIFEST_LIMIT) throw new SnapshotError('snapshot_manifest', 'manifest.json is too large.');
  const bytes = fs.readFileSync(manifestFile);
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch { throw new SnapshotError('snapshot_manifest', 'manifest.json is not JSON.'); }
  if (manifest?.format !== SNAPSHOT_FORMAT) throw new SnapshotError('snapshot_manifest', `Unsupported snapshot format (expected ${SNAPSHOT_FORMAT}).`);
  if (manifest.source !== 'cloudflare-d1') throw new SnapshotError('snapshot_manifest', 'Unsupported snapshot source.');
  if (typeof manifest.label !== 'string' || !/^[A-Za-z0-9._ -]{1,80}$/.test(manifest.label)) throw new SnapshotError('snapshot_manifest', 'The snapshot label is missing or invalid.');
  if (!manifest.tables || typeof manifest.tables !== 'object' || Array.isArray(manifest.tables)) throw new SnapshotError('snapshot_manifest', 'The manifest lists no tables.');
  const unknown = Object.keys(manifest.tables).filter(name => !SNAPSHOT_TABLES.includes(name));
  if (unknown.length) throw new SnapshotError('table_not_importable', `Not importable: ${unknown.join(', ')}`);
  const entries = [...Object.entries(manifest.tables).map(([name, e]) => [`table ${name}`, e]), ...(manifest.objects ? [['objects list', manifest.objects]] : [])];
  for (const [what, e] of entries) {
    if (!e || typeof e.file !== 'string' || !isCount(e.bytes) || !SHA256.test(e.sha256 ?? '') || !isCount(e.rows ?? e.count))
      throw new SnapshotError('snapshot_manifest', `The manifest entry for ${what} is incomplete.`);
  }
  const files = {};
  for (const name of SNAPSHOT_TABLES) if (manifest.tables[name]) files[name] = await checkFile(root, manifest.tables[name], `table ${name}`);
  let objects = [];
  if (manifest.objects) {
    const list = await checkFile(root, manifest.objects, 'objects list');
    const seen = new Set();
    for await (const o of jsonLines(list, 'objects list')) {
      if (typeof o.key !== 'string' || !OBJECT_PREFIXES.some(p => o.key.startsWith(p)) || o.key.length > 1024 || o.key.includes('\0'))
        throw new SnapshotError('snapshot_object', 'An object key is outside telemetry/ and raw/.');
      if (seen.has(o.key)) throw new SnapshotError('snapshot_object', 'An object key is listed twice.');
      if (!isCount(o.bytes) || !SHA256.test(o.sha256 ?? '')) throw new SnapshotError('snapshot_object', 'An object entry is incomplete.');
      seen.add(o.key);
      objects.push({ key: o.key, bytes: o.bytes, sha256: o.sha256, path: await checkFile(root, o, 'an object file', digest => checkSourceIdentity(o, digest)) });
    }
    if (objects.length !== manifest.objects.count) throw new SnapshotError('snapshot_object', 'The objects list does not match the manifest count.');
  }
  return { root, id: sha256Hex(bytes), label: manifest.label, source: manifest.source, manifest, files, objects };
}

/** The local table's columns and primary key (from SQLite itself). */
function tableShape(db, table) {
  const columns = db.transaction(raw => raw.prepare(`PRAGMA table_info(${table})`).all());
  if (!columns.length) throw new SnapshotError('table_missing', `The local database has no ${table} table.`);
  const key = columns.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
  return { columns: new Set(columns.map(c => c.name)), key };
}

function checkRow(table, shape, row, line) {
  for (const [column, value] of Object.entries(row)) {
    if (!shape.columns.has(column)) throw new SnapshotError('snapshot_column', `${table}: unknown column ${column}.`);
    if (!(value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))))
      throw new SnapshotError('snapshot_row', `${table}: row ${line}, column ${column} has an unsupported value type.`);
  }
  for (const column of shape.key) if (row[column] == null) throw new SnapshotError('snapshot_row', `${table}: row ${line} has no ${column}.`);
}

/** Applies the operator's controller sign-in choice (the same way when planning and importing). */
function shapeRow(table, row, { deviceTokens, at }) {
  if (table !== 'devices' || deviceTokens !== 'revoke' || row.status === 'revoked') return row;
  return { ...row, status: 'revoked', revoked_at: at, revoked_by: IMPORT_ACTOR };
}

/** 'absent' | 'same' | 'different', decided by SQLite with column affinity (IS compares NULLs too). */
function compare(raw, table, shape, row) {
  const columns = Object.keys(row);
  const sql = `SELECT ${columns.map(c => `(${c} IS ?)`).join(' AND ')} AS same FROM ${table} WHERE ${shape.key.map(c => `${c} = ?`).join(' AND ')}`;
  const found = raw.prepare(sql).get(...columns.map(c => row[c]), ...shape.key.map(c => row[c]));
  return !found ? 'absent' : found.same ? 'same' : 'different';
}

function insert(raw, table, row) {
  const columns = Object.keys(row);
  raw.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...columns.map(c => row[c]));
}

const empty = () => ({ rows: 0, inserted: 0, present: 0, conflicts: 0 });

/**
 * Read-only plan: what an import would add, what is already present, and every conflict, before any write.
 * @returns {Promise<{ ok: boolean, snapshot: string, tables: object, objects: object, references: object }>}
 */
export async function planSnapshot(db, store, snapshot, { deviceTokens, acceptMissingObjects = false, at = new Date().toISOString() } = {}) {
  if (!['preserve', 'revoke'].includes(deviceTokens)) throw new SnapshotError('device_tokens_required', 'Choose --device-tokens preserve or revoke.');
  const tables = {}, referenced = new Set(), rawSizes = new Map();
  for (const table of SNAPSHOT_TABLES) {
    if (!snapshot.files[table]) continue;
    const shape = tableShape(db, table), counts = (tables[table] = empty()), seen = new Set();
    for await (const exported of jsonLines(snapshot.files[table], table)) {
      counts.rows++;
      checkRow(table, shape, exported, counts.rows);
      const id = JSON.stringify(shape.key.map(c => exported[c]));
      if (seen.has(id)) throw new SnapshotError('snapshot_row', `${table}: a key appears twice in the snapshot.`);
      seen.add(id);
      if (table === 'flights' && typeof exported.telemetry_key === 'string') referenced.add(exported.telemetry_key);
      if (table === 'raw_logs' && typeof exported.r2_key === 'string') { referenced.add(exported.r2_key); rawSizes.set(exported.r2_key, exported.size_bytes); }
      const state = db.transaction(raw => compare(raw, table, shape, shapeRow(table, exported, { deviceTokens, at })));
      if (state === 'absent') counts.inserted++; else if (state === 'same') counts.present++; else counts.conflicts++;
    }
    if (counts.rows !== snapshot.manifest.tables[table].rows) throw new SnapshotError('snapshot_row', `${table}: row count does not match the manifest.`);
  }
  const objects = { listed: snapshot.objects.length, stored: 0, present: 0, conflicts: 0, sizeMismatches: 0 };
  const listed = new Set();
  for (const o of snapshot.objects) {
    listed.add(o.key);
    // A raw log's row records its size: the object must be exactly that long.
    if (rawSizes.has(o.key) && Number(rawSizes.get(o.key)) !== o.bytes) { objects.sizeMismatches++; continue; }
    const head = await store.head(o.key);
    if (!head) objects.stored++; else if (head.etag === o.sha256 && head.size === o.bytes) objects.present++; else objects.conflicts++;
  }
  let missing = 0;
  for (const key of referenced) if (!listed.has(key) && !(await store.head(key))) missing++;
  const references = { objectsReferenced: referenced.size, missing, missingAccepted: acceptMissingObjects };
  const conflicts = objects.conflicts + objects.sizeMismatches + Object.values(tables).reduce((n, t) => n + t.conflicts, 0);
  return { ok: conflicts === 0 && (missing === 0 || acceptMissingObjects), snapshot: snapshot.id, label: snapshot.label, deviceTokens, tables, objects, references };
}

/**
 * Plans, then imports: objects first (create-only, SHA-256 checked), then rows in foreign-key order, each chunk in
 * one transaction that re-checks every row. Stops, without overwriting, at the first conflict.
 * @param {import('./sqlite-d1.mjs').SqliteD1} db
 * @param {import('./fs-r2.mjs').FsR2} store
 */
export async function importSnapshot(db, store, snapshot, { deviceTokens, acceptMissingObjects = false, now = () => new Date(), faults = {} } = {}) {
  const prior = db.transaction(raw => raw.prepare('SELECT status, device_tokens, receipt FROM snapshot_imports WHERE id = ?').get(snapshot.id));
  if (prior && prior.device_tokens !== deviceTokens)
    throw new SnapshotError('device_tokens_changed', `This snapshot was started with --device-tokens ${prior.device_tokens}; finish it the same way.`);
  if (prior?.status === 'completed') return { ...JSON.parse(prior.receipt), alreadyCompleted: true };
  const at = now().toISOString();
  // A resumed import keeps the revocation time it started with, so its rows compare identical.
  const startedAt = prior ? db.transaction(raw => raw.prepare('SELECT started_at FROM snapshot_imports WHERE id = ?').get(snapshot.id).started_at) : at;
  const plan = await planSnapshot(db, store, snapshot, { deviceTokens, acceptMissingObjects, at: startedAt });
  if (!plan.ok) throw Object.assign(new SnapshotError('snapshot_conflicts', 'The snapshot conflicts with existing data or misses referenced objects; nothing was written.'), { plan });

  if (!prior) db.transaction(raw => raw.prepare(`INSERT INTO snapshot_imports (id, label, source, device_tokens, status, started_at)
    VALUES (?, ?, ?, ?, 'running', ?)`).run(snapshot.id, snapshot.label, snapshot.source, deviceTokens, startedAt));

  const objects = { listed: snapshot.objects.length, stored: 0, present: 0 };
  for (const o of snapshot.objects) {
    const stored = await store.put(o.key, Readable.toWeb(fs.createReadStream(o.path)), { sha256: o.sha256, onlyIf: { etagDoesNotMatch: '*' } });
    if (stored) { objects.stored++; await faults.afterObject?.(o.key); continue; }
    const head = await store.head(o.key);
    if (head?.etag !== o.sha256) throw new SnapshotError('snapshot_conflicts', 'An object changed while importing; nothing was overwritten.');
    objects.present++;
  }

  const tables = {};
  for (const table of SNAPSHOT_TABLES) {
    if (!snapshot.files[table]) continue;
    const shape = tableShape(db, table), counts = (tables[table] = { rows: 0, inserted: 0, present: 0 });
    let chunk = [];
    const flush = () => {
      if (!chunk.length) return;
      const rows = chunk; chunk = [];
      const result = db.transaction(raw => {
        let inserted = 0, present = 0;
        for (const row of rows) {
          const state = compare(raw, table, shape, row);
          if (state === 'different') throw new SnapshotError('snapshot_conflicts', `${table}: a row changed while importing; nothing was overwritten.`);
          if (state === 'absent') { insert(raw, table, row); inserted++; } else present++;
          if (table === 'keychains') raw.prepare(`INSERT OR IGNORE INTO keychain_provenance (file_hash, snapshot_id, sealed_by, source_key_version, imported_at)
            VALUES (?, ?, 'source-key', ?, ?)`).run(row.file_hash, snapshot.id, row.key_version, at);
        }
        return { inserted, present };
      });
      counts.inserted += result.inserted; counts.present += result.present;
    };
    for await (const exported of jsonLines(snapshot.files[table], table)) {
      counts.rows++;
      checkRow(table, shape, exported, counts.rows);
      chunk.push(shapeRow(table, exported, { deviceTokens, at: startedAt }));
      if (chunk.length >= CHUNK_ROWS) { flush(); await faults.afterChunk?.(table); }
    }
    flush();
    await faults.afterChunk?.(table);
  }

  // The sealed keychains must be byte-for-byte what was exported.
  let keychainsVerified = 0;
  if (snapshot.files.keychains) {
    for await (const row of jsonLines(snapshot.files.keychains, 'keychains')) {
      const local = db.transaction(raw => raw.prepare(`SELECT k.ciphertext, k.iv, k.key_version, p.snapshot_id FROM keychains k
        LEFT JOIN keychain_provenance p ON p.file_hash = k.file_hash WHERE k.file_hash = ?`).get(row.file_hash));
      if (!local || local.ciphertext !== row.ciphertext || local.iv !== row.iv || Number(local.key_version) !== Number(row.key_version) || !local.snapshot_id)
        throw new SnapshotError('keychain_mismatch', 'An imported keychain is not the exact exported ciphertext.');
      keychainsVerified++;
    }
  }

  const receipt = { snapshot: snapshot.id, label: snapshot.label, source: snapshot.source, deviceTokens, tables, objects,
    references: plan.references, keychainsVerified, completedAt: now().toISOString() };
  db.transaction(raw => {
    raw.prepare(`UPDATE snapshot_imports SET status = 'completed', completed_at = ?, receipt = ? WHERE id = ? AND status = 'running'`)
      .run(receipt.completedAt, JSON.stringify(receipt), snapshot.id);
    raw.prepare(`INSERT OR IGNORE INTO audit_events (id, actor_id, action, subject, detail, at) VALUES (?, ?, 'snapshot_imported', ?, ?, ?)`)
      .run(`snapshot-import:${snapshot.id}`, IMPORT_ACTOR, `snapshot:${snapshot.id}`, JSON.stringify({ tables, objects, keychainsVerified, deviceTokens }), receipt.completedAt);
  });
  return receipt;
}

/**
 * Writes manifest.json for a snapshot folder prepared by the operator (tables/<table>.jsonl, objects.jsonl and the
 * object files). Wrangler `d1 execute --json` pages in tables/<table>/*.json are first joined into <table>.jsonl.
 * Never overwrites an existing manifest or table file.
 */
export async function packSnapshot(root, { label }) {
  root = path.resolve(root);
  if (fs.existsSync(path.join(root, 'manifest.json'))) throw new SnapshotError('snapshot_exists', 'manifest.json already exists; packing never overwrites it.');
  const tables = {};
  for (const table of SNAPSHOT_TABLES) {
    const jsonl = path.join(root, 'tables', `${table}.jsonl`), pages = path.join(root, 'tables', table);
    if (!fs.existsSync(jsonl) && fs.lstatSync(pages, { throwIfNoEntry: false })?.isDirectory()) {
      // Joined into a private temporary file first, so a failed pack never leaves a partial table behind.
      const partial = `${jsonl}.partial`;
      const out = fs.openSync(partial, 'wx', 0o600);
      let complete = false;
      try {
        for (const name of fs.readdirSync(pages).filter(n => n.endsWith('.json')).sort()) {
          let parsed;
          try { parsed = JSON.parse(fs.readFileSync(snapshotFile(root, `tables/${table}/${name}`), 'utf8')); }
          catch (error) { if (error instanceof SnapshotError) throw error; throw new SnapshotError('snapshot_row', `tables/${table}/${name} is not JSON.`); }
          for (const result of Array.isArray(parsed) ? parsed : [parsed]) {
            if (!Array.isArray(result?.results)) throw new SnapshotError('snapshot_row', `tables/${table}/${name} is not wrangler --json output.`);
            for (const row of result.results) fs.writeSync(out, `${JSON.stringify(row)}\n`);
          }
        }
        fs.fsyncSync(out);
        complete = true;
      } finally {
        fs.closeSync(out);
        if (!complete) fs.rmSync(partial, { force: true });
      }
      fs.linkSync(partial, jsonl); // fails if <table>.jsonl appeared meanwhile: never overwritten
      fs.rmSync(partial);
    }
    if (!fs.existsSync(jsonl)) continue;
    const file = `tables/${table}.jsonl`;
    let rows = 0;
    for await (const _ of jsonLines(snapshotFile(root, file), table)) rows++;
    tables[table] = { file, rows, ...(await fileDigest(snapshotFile(root, file))) };
  }
  let objects;
  if (fs.existsSync(path.join(root, 'objects.jsonl'))) {
    // The operator lists key, file and the source's size and ETag (from R2 head/list; plus sourceSha256 for a
    // multipart object). Each file is checked to be those original bytes, then its size and SHA-256 are recorded.
    const lines = [];
    for await (const o of jsonLines(snapshotFile(root, 'objects.jsonl'), 'objects list')) {
      const digest = await fileDigest(snapshotFile(root, o.file));
      const source = checkSourceIdentity(o, digest);
      lines.push(JSON.stringify({ key: o.key, file: o.file, bytes: digest.bytes, sha256: digest.sha256, ...source }));
    }
    const listFile = 'objects.manifest.jsonl';
    fs.writeFileSync(path.join(root, listFile), lines.map(l => `${l}\n`).join(''), { flag: 'wx', mode: 0o600 });
    objects = { file: listFile, count: lines.length, ...(await fileDigest(path.join(root, listFile))) };
  }
  const manifest = { format: SNAPSHOT_FORMAT, label, source: 'cloudflare-d1', createdAt: new Date().toISOString(), tables, ...(objects ? { objects } : {}) };
  fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { snapshot: sha256Hex(fs.readFileSync(path.join(root, 'manifest.json'))), tables: Object.fromEntries(Object.entries(tables).map(([t, e]) => [t, e.rows])), objects: objects?.count ?? 0 };
}
