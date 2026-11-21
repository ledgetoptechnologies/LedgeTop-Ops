'use strict';

const { createHash } = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COLOR = /^#[0-9a-f]{6}$/i;
const ICON = /^[a-z0-9-]{1,32}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const NOTE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const LIMITS = Object.freeze({ perOwner: 1000, perModel: 5000, categories: 100, vertices: 500, batch: 500 });
const VISIBILITY = ['private', 'shared', 'internal'];

function markError(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !CONTROL.test(value);
const round = value => Math.round(value * 1e8) / 1e8;

function position(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) return null;
  const [lon, lat] = value;
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  // Heights live in elevationNavd88M; a third GeoJSON value is never trusted as one.
  return [round(lon), round(lat)];
}

function validateGeometry(geometry) {
  if (!plainObject(geometry) || Object.keys(geometry).some(key => !['type', 'coordinates'].includes(key))) return null;
  const { type, coordinates } = geometry;
  if (type === 'Point') {
    const point = position(coordinates);
    return point && { type, coordinates: point };
  }
  if (type === 'LineString') {
    if (!Array.isArray(coordinates) || coordinates.length < 2 || coordinates.length > LIMITS.vertices) return null;
    const line = coordinates.map(position);
    return line.every(Boolean) ? { type, coordinates: line } : null;
  }
  if (type === 'Polygon') {
    // One outer ring. Holes are not part of the markup tool.
    if (!Array.isArray(coordinates) || coordinates.length !== 1 || !Array.isArray(coordinates[0])) return null;
    const ring = coordinates[0].map(position);
    if (!ring.every(Boolean)) return null;
    const [first] = ring, last = ring[ring.length - 1];
    if (ring.length > 1 && first[0] === last[0] && first[1] === last[1]) ring.pop();
    if (ring.length < 3 || ring.length > LIMITS.vertices) return null;
    return { type, coordinates: [[...ring, [...ring[0]]]] };
  }
  return null;
}

const MARK_FIELDS = ['id', 'geometry', 'name', 'note', 'categoryId', 'color', 'icon', 'elevationNavd88M', 'visibility'];

function validateMark(input, { update = false } = {}) {
  const allowed = [...MARK_FIELDS, ...(update ? ['revision'] : [])];
  if (!plainObject(input) || Object.keys(input).some(key => !allowed.includes(key))) throw markError('invalid_mark');
  const geometry = validateGeometry(input.geometry);
  const elevation = input.elevationNavd88M;
  if (typeof input.id !== 'string' || !UUID.test(input.id) || !geometry
    || !cleanText(input.name, 100)
    || typeof input.color !== 'string' || !COLOR.test(input.color)
    || (input.icon !== undefined && (typeof input.icon !== 'string' || !ICON.test(input.icon)))
    || (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 2000 || NOTE_CONTROL.test(input.note)))
    || (input.categoryId !== undefined && input.categoryId !== null && (typeof input.categoryId !== 'string' || !UUID.test(input.categoryId)))
    || (elevation !== undefined && elevation !== null && (!Number.isFinite(elevation) || elevation < -500 || elevation > 9000))
    || (input.visibility !== undefined && !VISIBILITY.includes(input.visibility))
    || (update && (!Number.isSafeInteger(input.revision) || input.revision < 1))) throw markError('invalid_mark');
  return {
    id: input.id.toLowerCase(), geometry, name: input.name.trim(), note: input.note?.trim() || '',
    categoryId: input.categoryId ? input.categoryId.toLowerCase() : null, color: input.color.toLowerCase(),
    icon: input.icon || 'pin', elevationNavd88M: Number.isFinite(elevation) ? Math.round(elevation * 1000) / 1000 : null,
    visibility: input.visibility,
  };
}

function validateCategory(input, { update = false } = {}) {
  const allowed = ['id', 'name', 'color', 'icon', ...(update ? ['revision'] : [])];
  if (!plainObject(input) || Object.keys(input).some(key => !allowed.includes(key))
    || typeof input.id !== 'string' || !UUID.test(input.id)
    || !cleanText(input.name, 60)
    || typeof input.color !== 'string' || !COLOR.test(input.color)
    || typeof input.icon !== 'string' || !ICON.test(input.icon)
    || (update && (!Number.isSafeInteger(input.revision) || input.revision < 1))) throw markError('invalid_mark_category');
  return { id: input.id.toLowerCase(), name: input.name.trim(), color: input.color.toLowerCase(), icon: input.icon };
}

const isOwner = (principal, row) => row.owner_audience === principal.audience && row.owner_subject === principal.subject;
const staff = principal => principal.audience === 'ops';

function readable(principal, row) {
  if (!row || row.deleted_at) return false;
  if (isOwner(principal, row)) return true;
  return row.visibility === 'shared' || (row.visibility === 'internal' && staff(principal));
}

// Staff edit every mark they can read except someone else's private one
// (which they cannot read). Clients edit only their own.
const editable = (principal, row) => readable(principal, row) && (isOwner(principal, row) || staff(principal));

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
    return this.database.prepare('SELECT * FROM viewer_marks WHERE model_id=? AND id=?').get(principal.modelId, id);
  }

  liveCategoryIds(modelId) {
    return new Set(this.database.prepare('SELECT id FROM viewer_mark_categories WHERE model_id=? AND deleted_at IS NULL')
      .all(modelId).map(row => row.id));
  }

  view(principal, row, categories = this.liveCategoryIds(principal.modelId)) {
    if (!readable(principal, row)) return null;
    const document = JSON.parse(row.document_json);
    return {
      ...document,
      categoryId: document.categoryId && categories.has(document.categoryId) ? document.categoryId : null,
      visibility: row.visibility, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
      author: row.owner_audience === 'ops' ? 'staff' : 'client',
      mine: isOwner(principal, row), editable: editable(principal, row),
      // Staff may see which person made a mark; clients never see other people's identities.
      ...(staff(principal) ? { owner: row.owner_subject, updatedBy: row.updated_by_subject } : {}),
    };
  }

  list(principal) {
    const categories = this.liveCategoryIds(principal.modelId);
    const visible = staff(principal) ? "visibility IN ('shared','internal')" : "visibility='shared'";
    return this.database.prepare(`SELECT * FROM viewer_marks WHERE model_id=? AND deleted_at IS NULL
      AND (${visible} OR (owner_audience=? AND owner_subject=?)) ORDER BY created_at,id LIMIT ?`)
      .all(principal.modelId, principal.audience, principal.subject, LIMITS.perModel)
      .map(row => this.view(principal, row, categories));
  }

  get(principal, id) { return this.view(principal, this.row(principal, id)); }

  checkCategory(principal, categoryId) {
    if (!categoryId) return;
    const category = this.database.prepare('SELECT 1 FROM viewer_mark_categories WHERE model_id=? AND id=? AND deleted_at IS NULL')
      .get(principal.modelId, categoryId);
    if (!category) throw markError('mark_category_not_found');
  }

  insert(principal, input) {
    const mark = validateMark(input);
    const visibility = mark.visibility || 'private';
    if (visibility === 'internal' && !staff(principal)) throw markError('mark_visibility_forbidden', 403);
    delete mark.visibility;
    const document = JSON.stringify(mark);
    const hash = createHash('sha256').update(JSON.stringify([document, visibility])).digest('hex');
    const existing = this.row(principal, mark.id);
    if (existing) {
      if (existing.deleted_at || !isOwner(principal, existing) || existing.creation_hash !== hash) throw markError('mark_id_conflict', 409);
      return { mark: this.view(principal, existing), replayed: true };
    }
    this.checkCategory(principal, mark.categoryId);
    const count = sql => this.database.prepare(`SELECT count(*) n FROM viewer_marks WHERE model_id=? AND deleted_at IS NULL ${sql}`);
    if (count('AND owner_audience=? AND owner_subject=?').get(principal.modelId, principal.audience, principal.subject).n >= LIMITS.perOwner
      || count('').get(principal.modelId).n >= LIMITS.perModel) throw markError('mark_limit_reached', 429);
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO viewer_marks
      (id, model_id, owner_audience, owner_subject, visibility, document_json, creation_hash, revision,
       created_at, updated_at, updated_by_audience, updated_by_subject)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(mark.id, principal.modelId, principal.audience, principal.subject,
      visibility, document, hash, now, now, principal.audience, principal.subject);
    return { mark: this.get(principal, mark.id), replayed: false };
  }

  create(principal, input) { return this.transaction(() => this.insert(principal, input)); }

  // Import: all marks land or none do.
  createMany(principal, inputs) {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > LIMITS.batch) throw markError('invalid_mark_batch');
    return this.transaction(() => inputs.map(input => this.insert(principal, input).mark));
  }

  update(principal, id, input) {
    const mark = validateMark(input, { update: true });
    if (mark.id !== id) throw markError('mark_id_mismatch');
    return this.transaction(() => {
      const row = this.row(principal, id);
      if (!readable(principal, row)) throw markError('mark_not_found', 404);
      if (!editable(principal, row)) throw markError('mark_edit_forbidden', 403);
      if (row.revision !== input.revision) throw markError('mark_revision_conflict', 409);
      const visibility = mark.visibility || row.visibility;
      // Only the owner moves a mark between private, shared and internal.
      if (visibility !== row.visibility && !isOwner(principal, row)) throw markError('mark_visibility_forbidden', 403);
      if (visibility === 'internal' && row.owner_audience !== 'ops') throw markError('mark_visibility_forbidden', 403);
      const previous = JSON.parse(row.document_json).categoryId;
      if (mark.categoryId !== previous) this.checkCategory(principal, mark.categoryId);
      delete mark.visibility;
      this.database.prepare(`UPDATE viewer_marks SET document_json=?, visibility=?, revision=revision+1, updated_at=?,
        updated_by_audience=?, updated_by_subject=? WHERE model_id=? AND id=?`).run(JSON.stringify(mark), visibility,
        new Date().toISOString(), principal.audience, principal.subject, principal.modelId, id);
      return this.get(principal, id);
    });
  }

  delete(principal, id, revision) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw markError('mark_revision_required', 428);
    return this.transaction(() => {
      const row = this.row(principal, id);
      if (!readable(principal, row)) throw markError('mark_not_found', 404);
      if (!editable(principal, row)) throw markError('mark_edit_forbidden', 403);
      if (row.revision !== revision) throw markError('mark_revision_conflict', 409);
      const now = new Date().toISOString();
      // Soft delete keeps the row (and its id) but drops the content.
      this.database.prepare(`UPDATE viewer_marks SET deleted_at=?, updated_at=?, document_json='{}',
        updated_by_audience=?, updated_by_subject=? WHERE model_id=? AND id=?`)
        .run(now, now, principal.audience, principal.subject, principal.modelId, id);
    });
  }

  categoryRow(principal, id) {
    return this.database.prepare('SELECT * FROM viewer_mark_categories WHERE model_id=? AND id=?').get(principal.modelId, id);
  }

  categoryView(principal, row) {
    if (!row || row.deleted_at) return null;
    return { ...JSON.parse(row.document_json), revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
      mine: isOwner(principal, row), editable: isOwner(principal, row) || staff(principal) };
  }

  categories(principal) {
    return this.database.prepare(`SELECT * FROM viewer_mark_categories WHERE model_id=? AND deleted_at IS NULL
      ORDER BY name COLLATE NOCASE, id LIMIT ?`).all(principal.modelId, LIMITS.categories).map(row => this.categoryView(principal, row));
  }

  nameTaken(principal, name, exceptId = null) {
    return Boolean(this.database.prepare(`SELECT 1 FROM viewer_mark_categories WHERE model_id=? AND deleted_at IS NULL
      AND name=? COLLATE NOCASE AND id<>?`).get(principal.modelId, name, exceptId || ''));
  }

  createCategory(principal, input) {
    const category = validateCategory(input);
    return this.transaction(() => {
      const existing = this.categoryRow(principal, category.id);
      if (existing) {
        if (existing.deleted_at || !isOwner(principal, existing) || existing.document_json !== JSON.stringify(category))
          throw markError('mark_category_id_conflict', 409);
        return { category: this.categoryView(principal, existing), replayed: true };
      }
      if (this.nameTaken(principal, category.name)) throw markError('mark_category_name_taken', 409);
      const count = this.database.prepare('SELECT count(*) n FROM viewer_mark_categories WHERE model_id=? AND deleted_at IS NULL').get(principal.modelId).n;
      if (count >= LIMITS.categories) throw markError('mark_category_limit_reached', 429);
      const now = new Date().toISOString();
      this.database.prepare(`INSERT INTO viewer_mark_categories
        (id, model_id, owner_audience, owner_subject, name, document_json, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(category.id, principal.modelId, principal.audience, principal.subject,
        category.name, JSON.stringify(category), now, now);
      return { category: this.categoryView(principal, this.categoryRow(principal, category.id)), replayed: false };
    });
  }

  updateCategory(principal, id, input) {
    const category = validateCategory(input, { update: true });
    if (category.id !== id) throw markError('mark_category_id_mismatch');
    return this.transaction(() => {
      const row = this.categoryRow(principal, id);
      const current = this.categoryView(principal, row);
      if (!current) throw markError('mark_category_not_found', 404);
      if (!current.editable) throw markError('mark_category_edit_forbidden', 403);
      if (row.revision !== input.revision) throw markError('mark_category_revision_conflict', 409);
      if (this.nameTaken(principal, category.name, id)) throw markError('mark_category_name_taken', 409);
      this.database.prepare(`UPDATE viewer_mark_categories SET name=?, document_json=?, revision=revision+1, updated_at=?
        WHERE model_id=? AND id=?`).run(category.name, JSON.stringify(category), new Date().toISOString(), principal.modelId, id);
      return this.categoryView(principal, this.categoryRow(principal, id));
    });
  }

  deleteCategory(principal, id, revision) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw markError('mark_revision_required', 428);
    return this.transaction(() => {
      const row = this.categoryRow(principal, id);
      const current = this.categoryView(principal, row);
      if (!current) throw markError('mark_category_not_found', 404);
      if (!current.editable) throw markError('mark_category_edit_forbidden', 403);
      if (row.revision !== revision) throw markError('mark_category_revision_conflict', 409);
      // Marks keep their own colour and icon; their category reads as none.
      const now = new Date().toISOString();
      this.database.prepare('UPDATE viewer_mark_categories SET deleted_at=?, updated_at=? WHERE model_id=? AND id=?')
        .run(now, now, principal.modelId, id);
    });
  }
}

module.exports = { ViewerMarkRepository, markError, validateMark, validateCategory, LIMITS };
