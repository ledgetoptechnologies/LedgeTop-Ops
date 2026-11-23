'use strict';

const { createHash } = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COLOR = /^#[0-9a-f]{6}$/i;
const ICON = /^[a-z0-9-]{1,32}$/;
const ACCOUNT = /^direct_client_grant:[A-Za-z0-9._:-]{1,200}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const NOTE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const LIMITS = Object.freeze({ perOwner: 1000, perModel: 5000, categories: 100, vertices: 500, batch: 500, accounts: 200, deleted: 1000 });
const RECOVERY_DAYS = 30;
const recoveryCutoff = now => new Date(now - RECOVERY_DAYS * 86_400_000).toISOString();
const OWN_DELETED = 'model_id=? AND owner_audience=? AND owner_subject=? AND deleted_at IS NOT NULL';
// The sharing choices each audience may use. The first entry is the default when
// a request omits visibility. What is not listed cannot be written, and a row
// stored with it is read, changed and deleted by its owner only.
//
// SERVED_SHARING is what the API serves. A client mark is Only me unless its
// owner picks "Me and project staff"; staff then read it. Staff marks are Only me.
// Under any rule only the owner changes, deletes or restores a mark.
const SERVED_SHARING = Object.freeze({ client: Object.freeze(['private', 'staff']), ops: Object.freeze(['private']) });
// Held: staff-to-client sharing (needs client names from Operations) and
// staff-wide marks. Not served; only tests use it.
const HELD_SHARING = Object.freeze({ client: Object.freeze(['private', 'staff']), ops: Object.freeze(['internal', 'client', 'private']) });
const VISIBILITIES = Object.freeze(['private', 'staff', 'internal', 'client']);
const ACCOUNT_TOUCH_MS = 60 * 60 * 1000;

function markError(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

// The client account a session is bound to, as a share recipient key. Only a
// direct client grant qualifies: Ops issues it to one client workspace and
// checks it when minting the session. A model_association id is shared by
// every client account on the same model (Ops authorizes the individual
// account underneath it), so it is never a recipient key: those sessions keep
// their own marks but neither appear as share targets nor read shared marks.
function principalAccount(principal) {
  const source = principal.session?.sourceAuthorization;
  if (principal.audience !== 'client' || source?.type !== 'direct_client_grant') return null;
  const key = `${source.type}:${source.id}`;
  return ACCOUNT.test(key) ? key : null;
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

const MARK_FIELDS = ['id', 'geometry', 'name', 'note', 'categoryId', 'color', 'icon', 'elevationNavd88M', 'visibility', 'shareAccount'];

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
    || (input.visibility !== undefined && !VISIBILITIES.includes(input.visibility))
    || (input.shareAccount !== undefined && input.shareAccount !== null && (typeof input.shareAccount !== 'string' || !ACCOUNT.test(input.shareAccount)))
    || (update && (!Number.isSafeInteger(input.revision) || input.revision < 1))) throw markError('invalid_mark');
  return {
    document: {
      id: input.id.toLowerCase(), geometry, name: input.name.trim(), note: input.note?.trim() || '',
      categoryId: input.categoryId ? input.categoryId.toLowerCase() : null, color: input.color.toLowerCase(),
      icon: input.icon || 'pin', elevationNavd88M: Number.isFinite(elevation) ? Math.round(elevation * 1000) / 1000 : null,
    },
    visibility: input.visibility, shareAccount: input.shareAccount,
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
const categoryKey = (row, id) => JSON.stringify(row.owner_audience === 'ops' ? ['ops', id] : [row.owner_audience, row.owner_subject, id]);

class ViewerMarkRepository {
  constructor(database, { visibility = SERVED_SHARING } = {}) {
    this.database = database;
    this.visibility = visibility;
  }

  // The owner always reads. Anyone else needs a sharing choice that is being
  // served: staff then read every mark except someone else's private one, and
  // a client reads staff marks shared with their account, never another client's.
  readable(principal, row) {
    if (!row || row.deleted_at) return false;
    if (isOwner(principal, row)) return true;
    if (row.visibility === 'private' || !this.visibility[row.owner_audience].includes(row.visibility)) return false;
    if (staff(principal)) return true;
    const account = principalAccount(principal);
    return row.visibility === 'client' && account !== null && row.share_account === account;
  }

  editable(principal, row) { return this.readable(principal, row) && isOwner(principal, row); }

  // Whether marks made by this audience can have readers besides their owner.
  shares(audience) { return this.visibility[audience].some(choice => choice !== 'private'); }

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

  // Remember which client accounts use Marks on a model so staff can share to
  // one of them by name. Written at most hourly per account.
  touchAccount(principal) {
    const account = principalAccount(principal);
    if (!account || !this.visibility.ops.includes('client')) return;
    const now = new Date();
    this.database.prepare(`INSERT INTO viewer_mark_accounts(model_id, account_key, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(model_id, account_key) DO UPDATE SET last_seen_at=excluded.last_seen_at WHERE last_seen_at < ?`)
      .run(principal.modelId, account, now.toISOString(), now.toISOString(), new Date(now - ACCOUNT_TOUCH_MS).toISOString());
  }

  audiences(principal) {
    if (!staff(principal) || !this.visibility.ops.includes('client')) throw markError('mark_audiences_forbidden', 403);
    return this.database.prepare(`SELECT account_key, last_seen_at FROM viewer_mark_accounts WHERE model_id=?
      ORDER BY last_seen_at DESC LIMIT ?`).all(principal.modelId, LIMITS.accounts)
      .map(row => ({ account: row.account_key, lastSeenAt: row.last_seen_at }));
  }

  row(principal, id) {
    return this.database.prepare('SELECT * FROM viewer_marks WHERE model_id=? AND id=?').get(principal.modelId, id);
  }

  liveCategoryIds(modelId) {
    return new Set(this.database.prepare('SELECT id FROM viewer_mark_categories WHERE model_id=? AND deleted_at IS NULL')
      .all(modelId).map(row => row.id));
  }

  view(principal, row, categories = this.liveCategoryIds(principal.modelId)) {
    if (!this.readable(principal, row)) return null;
    const document = JSON.parse(row.document_json);
    return {
      ...document,
      categoryId: document.categoryId && categories.has(document.categoryId) ? document.categoryId : null,
      visibility: row.visibility, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
      author: row.owner_audience === 'ops' ? 'staff' : 'client',
      mine: isOwner(principal, row), editable: this.editable(principal, row),
      // Nobody else's identity is sent; a share target only goes back to the staff member who set it.
      ...(staff(principal) && isOwner(principal, row) ? { shareAccount: row.share_account } : {}),
    };
  }

  rows(principal) {
    const shared = staff(principal) ? "visibility IN ('staff','internal','client')" : "(visibility='client' AND share_account=?)";
    const args = staff(principal) ? [] : [principalAccount(principal)];
    return this.database.prepare(`SELECT * FROM viewer_marks WHERE model_id=? AND deleted_at IS NULL
      AND (${shared} OR (owner_audience=? AND owner_subject=?)) ORDER BY created_at,id LIMIT ?`)
      .all(principal.modelId, ...args, principal.audience, principal.subject, LIMITS.perModel)
      .filter(row => this.readable(principal, row));
  }

  list(principal) {
    const categories = this.liveCategoryIds(principal.modelId);
    return this.rows(principal).map(row => this.view(principal, row, categories));
  }

  get(principal, id) { return this.view(principal, this.row(principal, id)); }

  // Clients attach only their own categories; staff only staff categories.
  checkCategory(principal, categoryId, existing = null) {
    if (!categoryId || categoryId === existing) return;
    const category = this.categoryRow(principal, categoryId);
    const allowed = category && !category.deleted_at
      && (isOwner(principal, category) || (staff(principal) && category.owner_audience === 'ops' && this.shares('ops')));
    if (!allowed) throw markError('mark_category_not_found');
  }

  checkVisibility(principal, ownerAudience, visibility, shareAccount) {
    if (!this.visibility[ownerAudience].includes(visibility)) throw markError('mark_visibility_forbidden', 403);
    if (visibility !== 'client') {
      if (shareAccount) throw markError('invalid_mark');
      return null;
    }
    // Staff share with one named client account that has used Marks on this model.
    const known = shareAccount && this.database.prepare('SELECT 1 FROM viewer_mark_accounts WHERE model_id=? AND account_key=?')
      .get(principal.modelId, shareAccount);
    if (!known) throw markError('mark_share_account_unknown');
    return shareAccount;
  }

  checkRoom(principal) {
    const count = sql => this.database.prepare(`SELECT count(*) n FROM viewer_marks WHERE model_id=? AND deleted_at IS NULL ${sql}`);
    if (count('AND owner_audience=? AND owner_subject=?').get(principal.modelId, principal.audience, principal.subject).n >= LIMITS.perOwner
      || count('').get(principal.modelId).n >= LIMITS.perModel) throw markError('mark_limit_reached', 429);
  }

  insert(principal, input) {
    const { document: mark, visibility: requested, shareAccount: requestedAccount } = validateMark(input);
    const visibility = requested || this.visibility[principal.audience][0];
    const shareAccount = this.checkVisibility(principal, principal.audience, visibility, requestedAccount);
    const document = JSON.stringify(mark);
    const hash = createHash('sha256').update(JSON.stringify([document, visibility, shareAccount])).digest('hex');
    const existing = this.row(principal, mark.id);
    if (existing) {
      if (existing.deleted_at || !isOwner(principal, existing) || existing.creation_hash !== hash) throw markError('mark_id_conflict', 409);
      return { mark: this.view(principal, existing), replayed: true };
    }
    this.checkCategory(principal, mark.categoryId);
    this.checkRoom(principal);
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO viewer_marks
      (id, model_id, owner_audience, owner_subject, owner_account, visibility, share_account, document_json, creation_hash,
       revision, created_at, updated_at, updated_by_audience, updated_by_subject)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(mark.id, principal.modelId, principal.audience, principal.subject,
      principalAccount(principal), visibility, shareAccount, document, hash, now, now, principal.audience, principal.subject);
    return { mark: this.get(principal, mark.id), replayed: false };
  }

  create(principal, input) { return this.transaction(() => this.insert(principal, input)); }

  // Import: all marks land or none do.
  createMany(principal, inputs) {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > LIMITS.batch) throw markError('invalid_mark_batch');
    return this.transaction(() => inputs.map(input => this.insert(principal, input).mark));
  }

  update(principal, id, input) {
    const { document: mark, visibility: requested, shareAccount: requestedAccount } = validateMark(input, { update: true });
    if (mark.id !== id) throw markError('mark_id_mismatch');
    return this.transaction(() => {
      const row = this.row(principal, id);
      if (!this.readable(principal, row)) throw markError('mark_not_found', 404);
      if (!this.editable(principal, row)) throw markError('mark_edit_forbidden', 403);
      if (row.revision !== input.revision) throw markError('mark_revision_conflict', 409);
      let visibility = row.visibility, shareAccount = row.share_account;
      const changing = (requested !== undefined && requested !== row.visibility)
        || (requestedAccount !== undefined && (requestedAccount || null) !== row.share_account);
      if (changing) {
        visibility = requested ?? row.visibility;
        shareAccount = this.checkVisibility(principal, row.owner_audience, visibility,
          requestedAccount === undefined ? row.share_account : requestedAccount);
      }
      this.checkCategory(principal, mark.categoryId, JSON.parse(row.document_json).categoryId);
      this.database.prepare(`UPDATE viewer_marks SET document_json=?, visibility=?, share_account=?, revision=revision+1, updated_at=?,
        updated_by_audience=?, updated_by_subject=? WHERE model_id=? AND id=?`).run(JSON.stringify(mark), visibility, shareAccount,
        new Date().toISOString(), principal.audience, principal.subject, principal.modelId, id);
      return this.get(principal, id);
    });
  }

  delete(principal, id, revision) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw markError('mark_revision_required', 428);
    return this.transaction(() => {
      const row = this.row(principal, id);
      if (!this.readable(principal, row)) throw markError('mark_not_found', 404);
      if (!this.editable(principal, row)) throw markError('mark_edit_forbidden', 403);
      if (row.revision !== revision) throw markError('mark_revision_conflict', 409);
      const now = new Date().toISOString();
      // The owner can restore it for RECOVERY_DAYS; purgeDeleted then drops the content. The id stays used.
      this.database.prepare(`UPDATE viewer_marks SET deleted_at=?, updated_at=?,
        updated_by_audience=?, updated_by_subject=? WHERE model_id=? AND id=?`)
        .run(now, now, principal.audience, principal.subject, principal.modelId, id);
      // Repeated adding and deleting cannot pile up content: the oldest deleted marks beyond the limit go first.
      this.database.prepare(`UPDATE viewer_marks SET document_json='{}' WHERE ${OWN_DELETED} AND document_json<>'{}' AND id NOT IN
        (SELECT id FROM viewer_marks WHERE ${OWN_DELETED} AND document_json<>'{}' ORDER BY deleted_at DESC, rowid DESC LIMIT ?)`)
        .run(...this.owner(principal), ...this.owner(principal), LIMITS.deleted);
    });
  }

  owner(principal) { return [principal.modelId, principal.audience, principal.subject]; }

  // The owner's own deleted marks that can still come back, newest first.
  deleted(principal, now = Date.now()) {
    return this.database.prepare(`SELECT * FROM viewer_marks WHERE ${OWN_DELETED} AND document_json<>'{}' AND deleted_at>=?
      ORDER BY deleted_at DESC, rowid DESC LIMIT ?`).all(...this.owner(principal), recoveryCutoff(now), LIMITS.deleted)
      .map(row => ({ ...JSON.parse(row.document_json), visibility: row.visibility, revision: row.revision, deletedAt: row.deleted_at }));
  }

  restore(principal, id, revision, now = Date.now()) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw markError('mark_revision_required', 428);
    return this.transaction(() => {
      const row = this.row(principal, id);
      if (!row || !row.deleted_at || !isOwner(principal, row) || row.document_json === '{}'
        || row.deleted_at < recoveryCutoff(now)) throw markError('mark_not_found', 404);
      if (row.revision !== revision) throw markError('mark_revision_conflict', 409);
      // It comes back with the sharing it had, if that is still served.
      if (!this.visibility[row.owner_audience].includes(row.visibility)) throw markError('mark_visibility_forbidden', 403);
      this.checkRoom(principal);
      this.database.prepare(`UPDATE viewer_marks SET deleted_at=NULL, revision=revision+1, updated_at=?,
        updated_by_audience=?, updated_by_subject=? WHERE model_id=? AND id=?`)
        .run(new Date(now).toISOString(), principal.audience, principal.subject, principal.modelId, id);
      return this.get(principal, id);
    });
  }

  // Run by the worker's maintenance pass: after RECOVERY_DAYS only the empty row (and its id) remains.
  purgeDeleted(now = Date.now()) {
    return this.database.prepare("UPDATE viewer_marks SET document_json='{}' WHERE deleted_at<? AND document_json<>'{}'")
      .run(recoveryCutoff(now)).changes;
  }

  categoryRow(principal, id) {
    return this.database.prepare('SELECT * FROM viewer_mark_categories WHERE model_id=? AND id=?').get(principal.modelId, id);
  }

  // The owner reads a category. Anyone else reads it only while a mark they can
  // read uses it (so that mark shows a name), and only from that mark's own side:
  // the same person's, or any staff member's for a staff mark.
  categoriesUsedBySharedMarks(principal) {
    return new Set(this.rows(principal).filter(row => !isOwner(principal, row))
      .map(row => categoryKey(row, JSON.parse(row.document_json).categoryId)));
  }

  categoryReadable(principal, row, shared = null) {
    if (!row || row.deleted_at) return false;
    if (isOwner(principal, row)) return true;
    if (row.owner_audience === 'ops' && staff(principal) && this.shares('ops')) return true;
    return (shared || this.categoriesUsedBySharedMarks(principal)).has(categoryKey(row, row.id));
  }

  categoryView(principal, row) {
    return { ...JSON.parse(row.document_json), revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
      mine: isOwner(principal, row), editable: isOwner(principal, row),
      author: row.owner_audience === 'ops' ? 'staff' : 'client' };
  }

  categories(principal) {
    const shared = this.categoriesUsedBySharedMarks(principal);
    return this.database.prepare(`SELECT * FROM viewer_mark_categories WHERE model_id=? AND deleted_at IS NULL
      ORDER BY name COLLATE NOCASE, id`).all(principal.modelId)
      .filter(row => this.categoryReadable(principal, row, shared)).slice(0, LIMITS.categories * 2)
      .map(row => this.categoryView(principal, row));
  }

  nameTaken(principal, name, exceptId = null) {
    return Boolean(this.database.prepare(`SELECT 1 FROM viewer_mark_categories WHERE model_id=? AND owner_audience=? AND owner_subject=?
      AND deleted_at IS NULL AND name=? COLLATE NOCASE AND id<>?`).get(principal.modelId, principal.audience, principal.subject, name, exceptId || ''));
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
      const count = this.database.prepare(`SELECT count(*) n FROM viewer_mark_categories WHERE model_id=? AND owner_audience=?
        AND owner_subject=? AND deleted_at IS NULL`).get(principal.modelId, principal.audience, principal.subject).n;
      if (count >= LIMITS.categories) throw markError('mark_category_limit_reached', 429);
      const now = new Date().toISOString();
      this.database.prepare(`INSERT INTO viewer_mark_categories
        (id, model_id, owner_audience, owner_subject, owner_account, name, document_json, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(category.id, principal.modelId, principal.audience, principal.subject,
        principalAccount(principal), category.name, JSON.stringify(category), now, now);
      return { category: this.categoryView(principal, this.categoryRow(principal, category.id)), replayed: false };
    });
  }

  editableCategory(principal, id, revision) {
    const row = this.categoryRow(principal, id);
    if (!this.categoryReadable(principal, row)) throw markError('mark_category_not_found', 404);
    if (!isOwner(principal, row)) throw markError('mark_category_edit_forbidden', 403);
    if (row.revision !== revision) throw markError('mark_category_revision_conflict', 409);
    return row;
  }

  updateCategory(principal, id, input) {
    const category = validateCategory(input, { update: true });
    if (category.id !== id) throw markError('mark_category_id_mismatch');
    return this.transaction(() => {
      this.editableCategory(principal, id, input.revision);
      if (this.nameTaken(principal, category.name, id)) throw markError('mark_category_name_taken', 409);
      this.database.prepare(`UPDATE viewer_mark_categories SET name=?, document_json=?, revision=revision+1, updated_at=?
        WHERE model_id=? AND id=?`).run(category.name, JSON.stringify(category), new Date().toISOString(), principal.modelId, id);
      return this.categoryView(principal, this.categoryRow(principal, id));
    });
  }

  deleteCategory(principal, id, revision) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw markError('mark_revision_required', 428);
    return this.transaction(() => {
      this.editableCategory(principal, id, revision);
      // Marks keep their own colour and icon; their category reads as none.
      const now = new Date().toISOString();
      this.database.prepare('UPDATE viewer_mark_categories SET deleted_at=?, updated_at=? WHERE model_id=? AND id=?')
        .run(now, now, principal.modelId, id);
    });
  }
}

module.exports = { ViewerMarkRepository, SERVED_SHARING, HELD_SHARING, RECOVERY_DAYS, markError, validateMark, validateCategory, principalAccount, LIMITS };
