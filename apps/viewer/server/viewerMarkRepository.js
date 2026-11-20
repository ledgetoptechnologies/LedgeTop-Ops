'use strict';

const { createHash } = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MARKS = 1000;

const scope = 'model_id=? AND model_version_id=? AND owner_audience=? AND owner_subject=?';
const owner = ({ modelId, modelVersionId, audience, subject }) => [modelId, modelVersionId, audience, subject];

function markError(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

function validateMark(input, update = false) {
  const allowed = ['id', 'kind', 'name', 'color', 'note', 'latitude', 'longitude', ...(update ? ['revision'] : [])];
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !allowed.includes(key))
    || typeof input.id !== 'string' || !UUID.test(input.id)
    || !['point', 'treeStand'].includes(input.kind)
    || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || /[\u0000-\u001f\u007f]/.test(input.name)
    || typeof input.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(input.color)
    || (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.note)))
    || !Number.isFinite(input.latitude) || Math.abs(input.latitude) > 90
    || !Number.isFinite(input.longitude) || Math.abs(input.longitude) > 180
    || (update && (!Number.isSafeInteger(input.revision) || input.revision < 1))) throw markError('invalid_mark');
  return { id: input.id.toLowerCase(), kind: input.kind, name: input.name.trim(), color: input.color.toLowerCase(),
    note: input.note?.trim() || '', latitude: input.latitude, longitude: input.longitude };
}

function view(row) {
  return row && !row.deleted_at ? { ...JSON.parse(row.document_json), modelId: row.model_id,
    modelVersionId: row.model_version_id, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

class ViewerMarkRepository {
  constructor(database) { this.database = database; }

  transaction(fn) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  row(principal, id) {
    return this.database.prepare(`SELECT * FROM private_viewer_marks WHERE id=? AND ${scope}`).get(id, ...owner(principal));
  }

  list(principal) {
    return this.database.prepare(`SELECT * FROM private_viewer_marks WHERE ${scope} AND deleted_at IS NULL
      ORDER BY created_at,id LIMIT ?`).all(...owner(principal), MAX_MARKS).map(view);
  }

  get(principal, id) { return view(this.row(principal, id)); }

  create(principal, input) {
    const mark = validateMark(input), document = JSON.stringify(mark);
    const hash = createHash('sha256').update(document).digest('hex');
    return this.transaction(() => {
      const existing = this.row(principal, mark.id);
      if (existing) {
        if (existing.deleted_at || existing.creation_hash !== hash) throw markError('mark_id_conflict', 409);
        return { mark: view(existing), replayed: true };
      }
      const count = this.database.prepare(`SELECT count(*) n FROM private_viewer_marks WHERE ${scope} AND deleted_at IS NULL`).get(...owner(principal)).n;
      if (count >= MAX_MARKS) throw markError('mark_limit_reached', 429);
      const now = new Date().toISOString();
      this.database.prepare(`INSERT INTO private_viewer_marks
        (id, model_id, model_version_id, owner_audience, owner_subject, document_json, creation_hash, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(mark.id, ...owner(principal), document, hash, now, now);
      return { mark: this.get(principal, mark.id), replayed: false };
    });
  }

  update(principal, id, input) {
    const mark = validateMark(input, true);
    if (mark.id !== id) throw markError('mark_id_mismatch');
    return this.transaction(() => {
      const old = this.get(principal, id);
      if (!old) throw markError('mark_not_found', 404);
      if (old.revision !== input.revision) throw markError('mark_revision_conflict', 409);
      this.database.prepare(`UPDATE private_viewer_marks SET document_json=?, revision=revision+1, updated_at=?
        WHERE id=? AND ${scope}`).run(JSON.stringify(mark), new Date().toISOString(), id, ...owner(principal));
      return this.get(principal, id);
    });
  }

  delete(principal, id, revision) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw markError('mark_revision_required', 428);
    return this.transaction(() => {
      const row = this.row(principal, id);
      if (!row) throw markError('mark_not_found', 404);
      if (row.revision !== revision) throw markError('mark_revision_conflict', 409);
      if (!row.deleted_at) {
        const now = new Date().toISOString();
        this.database.prepare(`UPDATE private_viewer_marks SET deleted_at=?, updated_at=?, document_json='{}'
          WHERE id=? AND ${scope}`).run(now, now, id, ...owner(principal));
      }
    });
  }
}

module.exports = { ViewerMarkRepository, markError, validateMark };
