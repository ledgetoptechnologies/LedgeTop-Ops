'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

const MAX_GCP_SOURCE_BYTES = 2 * 1024 * 1024;
const TABLE = 'viewer_gcp_source_originals';
const fail = (code) => Object.assign(new Error(code), { code });

function sourceText(bytes) {
  try {
    // Keep the BOM in the text used for parsing/checksums. Browser File.text()
    // strips it, so that path cannot establish preservation of original bytes.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch { throw fail('gcp_original_encoding_unsupported'); }
}

function metadata(row) {
  return row && { id: row.id, datasetId: row.dataset_id, originProjectId: row.project_id,
    sourceFileId: row.source_file_id, fileName: row.file_name, sha256: row.sha256,
    byteSize: Number(row.byte_size), fidelity: row.fidelity, retainedAt: row.retained_at };
}

class GcpSourceOriginals {
  constructor(database) { this.database = database; }

  get(id, datasetId) {
    const row = datasetId == null
      ? this.database.prepare(`SELECT * FROM ${TABLE} WHERE id=?`).get(id)
      : this.database.prepare(`SELECT * FROM ${TABLE} WHERE id=? AND dataset_id=?`).get(id, datasetId);
    if (!row) return null;
    const bytes = Buffer.from(row.content);
    if (bytes.length !== Number(row.byte_size) || crypto.createHash('sha256').update(bytes).digest('hex') !== row.sha256)
      throw fail('gcp_original_integrity_failed');
    return { ...metadata(row), bytes };
  }

  describe(id, datasetId) {
    const row = this.database.prepare(`SELECT id,dataset_id,project_id,source_file_id,file_name,sha256,byte_size,fidelity,retained_at
      FROM ${TABLE} WHERE id=? AND dataset_id=?`).get(id, datasetId);
    return metadata(row) || null;
  }

  list(datasetId) {
    return this.database.prepare(`SELECT id,dataset_id,project_id,source_file_id,file_name,sha256,byte_size,fidelity,retained_at
      FROM ${TABLE} WHERE dataset_id=? ORDER BY retained_at,id`).all(datasetId).map(metadata);
  }

  insert({ datasetId, projectId = null, sourceFileId = null, fileName = 'gcp-source.csv', bytes,
    fidelity = 'original_bytes', actorId = null }) {
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw fail('invalid_gcp_original');
    const content = Buffer.from(bytes);
    if (content.length > MAX_GCP_SOURCE_BYTES) throw fail('gcp_original_size_invalid');
    if (!['original_bytes', 'legacy_utf8_snapshot'].includes(fidelity)) throw fail('invalid_gcp_original');
    if (typeof fileName !== 'string' || !fileName || fileName.length > 1024 || /[\r\n\0]/.test(fileName))
      throw fail('invalid_gcp_filename');
    if (typeof datasetId !== 'string' || !datasetId || (projectId !== null && (typeof projectId !== 'string' || !projectId)))
      throw fail('invalid_gcp_original_lineage');
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    this.database.prepare(`INSERT INTO ${TABLE}
      (id,dataset_id,project_id,source_file_id,file_name,sha256,byte_size,content,fidelity,created_by,retained_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dataset_id,sha256,file_name,fidelity) DO NOTHING`)
      .run(crypto.randomUUID(), datasetId, projectId, sourceFileId, fileName, sha256, content.length,
        content, fidelity, actorId, new Date().toISOString());
    const saved = this.database.prepare(`SELECT * FROM ${TABLE} WHERE dataset_id=? AND sha256=? AND file_name=? AND fidelity=?`)
      .get(datasetId, sha256, fileName, fidelity);
    // The dataset may later move projects; preserve the ORIGINAL lineage rather
    // than rewriting it or treating that historical project as a new ACL grant.
    if (!saved || !Buffer.from(saved.content).equals(content))
      throw fail('gcp_original_retention_conflict');
    return metadata(saved);
  }

  retain(input) {
    // This operation owns its transaction; callers retain BEFORE starting a set
    // mutation. A failed later import deliberately leaves the original retained.
    const previous = Number(this.database.prepare('PRAGMA synchronous').get().synchronous);
    if (![0, 1, 2, 3].includes(previous)) throw fail('gcp_original_durability_unavailable');
    this.database.exec('PRAGMA synchronous=FULL');
    let begun = false;
    try {
      this.database.exec('BEGIN IMMEDIATE'); begun = true;
      const saved = this.insert(input);
      this.database.exec('COMMIT'); begun = false;
      // Also flush a matching artifact written by an earlier NORMAL migration
      // or a lost-response retry. No destructive caller may proceed on BUSY.
      const checkpoint = this.database.prepare('PRAGMA wal_checkpoint(FULL)').get();
      if (Number(checkpoint.busy) !== 0) throw fail('gcp_original_durability_unavailable');
      return saved;
    } catch (error) {
      if (begun) this.database.exec('ROLLBACK');
      throw error;
    } finally {
      this.database.exec(`PRAGMA synchronous=${previous}`);
    }
  }
}

function migrateGcpSourceOriginals(database) {
  // Registration/version belongs to the Merger's migration reservation. Never
  // run ad-hoc from a repository constructor or allocate a placeholder number.
  database.exec(`CREATE TABLE ${TABLE} (
    id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    project_id TEXT,
    source_file_id TEXT,
    file_name TEXT NOT NULL,
    sha256 TEXT NOT NULL CHECK(length(sha256)=64),
    byte_size INTEGER NOT NULL CHECK(byte_size>=0 AND byte_size<=${MAX_GCP_SOURCE_BYTES}),
    content BLOB NOT NULL CHECK(typeof(content)='blob' AND length(content)=byte_size),
    fidelity TEXT NOT NULL CHECK(fidelity IN ('original_bytes','legacy_utf8_snapshot')),
    created_by TEXT,
    retained_at TEXT NOT NULL,
    UNIQUE(dataset_id,sha256,file_name,fidelity)
  );
  CREATE INDEX viewer_gcp_original_dataset ON ${TABLE}(dataset_id,retained_at);
  CREATE TRIGGER viewer_gcp_original_no_update BEFORE UPDATE ON ${TABLE}
    BEGIN SELECT RAISE(ABORT,'original GCP source is immutable'); END;
  CREATE TRIGGER viewer_gcp_original_no_delete BEFORE DELETE ON ${TABLE}
    BEGIN SELECT RAISE(ABORT,'original GCP source is permanently retained'); END;
  ALTER TABLE gcp_sets ADD COLUMN source_original_id TEXT REFERENCES ${TABLE}(id) ON DELETE RESTRICT;`);
  const archive = new GcpSourceOriginals(database);
  const page = database.prepare('SELECT id FROM gcp_sets WHERE (? IS NULL OR id>?) ORDER BY id LIMIT 64');
  const legacy = database.prepare(`SELECT sets.*,datasets.project_id FROM gcp_sets sets
    LEFT JOIN datasets ON datasets.id=sets.dataset_id WHERE sets.id=?`);
  const link = database.prepare('UPDATE gcp_sets SET source_original_id=? WHERE id=?');
  let after = null;
  for (;;) {
    const ids = page.all(after, after); if (!ids.length) break;
    for (const { id } of ids) {
      const row = legacy.get(id);
      if (row.source_content == null || row.source_content === '') continue;
      const bytes = Buffer.from(row.source_content, 'utf8');
      // Preserve unsupported legacy content IN ITS EXISTING ROW. It cannot be
      // deleted through the repository unless an independent archive succeeds.
      if (bytes.length > MAX_GCP_SOURCE_BYTES) continue;
      const fileName = String(row.source_filename || 'gcp-source.csv').replace(/[\r\n\0]/g, '_').slice(0, 1024);
      const source = archive.insert({ datasetId: row.dataset_id, projectId: row.project_id || null,
        sourceFileId: row.source_file_id, fileName,
        bytes, fidelity: 'legacy_utf8_snapshot', actorId: row.created_by });
      link.run(source.id, row.id);
    }
    after = ids[ids.length - 1].id;
  }
}

module.exports = { GcpSourceOriginals, MAX_GCP_SOURCE_BYTES, migrateGcpSourceOriginals, sourceText };
