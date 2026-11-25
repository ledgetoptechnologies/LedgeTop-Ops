'use strict';

const { createHash } = require('node:crypto');
const { MARK_GEOMETRY_MAX_VERTICES, validateGeometry } = require('./viewerMarkGeometry.mjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COLOR = /^#[0-9a-f]{6}$/i;
const ICON = /^[a-z0-9-]{1,32}$/;
const ACCOUNT = /^direct_client_grant:[A-Za-z0-9._:-]{1,200}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const NOTE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// Limits are per person, so nobody else's marks use up one's own. Bytes are of the
// stored documents: ownerBytes bounds one answer with a person's own marks,
// pageBytes one page of marks shared by others.
const LIMITS = Object.freeze({ perOwner: 1000, ownerBytes: 4_000_000, categories: 100, vertices: MARK_GEOMETRY_MAX_VERTICES, batch: 500, accounts: 200,
  deleted: 1000, deletedBytes: 4_000_000, pageRows: 500, pageBytes: 1_000_000,
  history: 10 });
const RECOVERY_DAYS = 30;
const recoveryCutoff = now => new Date(now - RECOVERY_DAYS * 86_400_000).toISOString();
const OWN_LIVE = 'model_id=? AND owner_audience=? AND owner_subject=? AND deleted_at IS NULL';
// Starter categories the client offers; their names and looks are the client's.
const STARTERS = Object.freeze(['poi', 'building', 'access', 'road', 'utility', 'water', 'vegetation', 'hazard', 'boundary', 'equipment', 'photo', 'other']);
const OWN_DELETED = 'model_id=? AND owner_audience=? AND owner_subject=? AND deleted_at IS NOT NULL';
// The sharing choices each audience may use. The first entry is the default when
// a request omits visibility. What is not listed cannot be written, and a row
// stored with it is read, changed and deleted by its owner only.
//
// SERVED_SHARING is what the API serves. A client mark is Only me unless its
// owner picks "Me and project staff"; staff then read it, and only its owner
// changes, deletes or restores it.
// A staff mark is shared unless its owner picks Only me. Shared: all staff read
// and manage it; every verified client session issued for that model reads it, and changes
// its content (nothing else) if its access is 'edit'; a public link reads it,
// without its note, if that link shows marks.
const SERVED_SHARING = Object.freeze({ client: Object.freeze(['private', 'staff']), ops: Object.freeze(['shared', 'private']) });
const ACCESS = Object.freeze(['edit', 'view']);
// Held: staff-to-client sharing (needs client names from Operations) and
// staff-wide marks. Not served; only tests use it.
const HELD_SHARING = Object.freeze({ client: Object.freeze(['private', 'staff']), ops: Object.freeze(['internal', 'client', 'private']) });
const VISIBILITIES = Object.freeze(['private', 'staff', 'internal', 'client', 'shared']);
// Every read of a mark goes through this, so nothing decides without its share row.
const MARKS = 'viewer_marks m LEFT JOIN viewer_mark_shares s ON s.model_id=m.model_id AND s.mark_id=m.id';
const SHARED_ROW = "m.owner_audience='ops' AND m.visibility='internal' AND s.access IS NOT NULL";
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

// A client session Ops issued for this model, by either kind of authorization.
const boundClient = principal => principal.audience === 'client'
  && ['direct_client_grant', 'model_association'].includes(principal.session?.sourceAuthorization?.type);
// Whose permissions attest one individual (personalPersistence is off without measure, though).
const verifiedClient = principal => boundClient(principal) && principal.session.permissions?.personalMeasurements === true;

const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !CONTROL.test(value);
const MARK_FIELDS = ['id', 'geometry', 'name', 'note', 'categoryId', 'color', 'icon', 'elevationNavd88M', 'visibility', 'shareAccount', 'access'];

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
    || (input.access !== undefined && input.access !== null && !ACCESS.includes(input.access))
    || (input.shareAccount !== undefined && input.shareAccount !== null && (typeof input.shareAccount !== 'string' || !ACCOUNT.test(input.shareAccount)))
    || (update && (!Number.isSafeInteger(input.revision) || input.revision < 1))) throw markError('invalid_mark');
  return {
    document: {
      id: input.id.toLowerCase(), geometry, name: input.name.trim(), note: input.note?.trim() || '',
      categoryId: input.categoryId ? input.categoryId.toLowerCase() : null, color: input.color.toLowerCase(),
      icon: input.icon || 'pin', elevationNavd88M: Number.isFinite(elevation) ? Math.round(elevation * 1000) / 1000 : null,
    },
    visibility: input.visibility, shareAccount: input.shareAccount, access: input.access ?? undefined,
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

const SERVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-8/i;
function validateNewCategory(input) {
  const category = validateCategory(input);
  if (SERVER_ID.test(category.id)) throw markError('invalid_mark_category');
  return category;
}

const isOwner = (principal, row) => principal.personalPersistence !== false && row.owner_audience === principal.audience && row.owner_subject === principal.subject;
const staff = principal => principal.audience === 'ops';
// One fixed id per person, model and starter, so two devices never make two of it.
// Version 8 ids are the server's own: nobody can create a category with one, so
// knowing someone's subject does not let anyone take or block their starters.
function starterId(principal, key) {
  const hex = createHash('sha256').update(JSON.stringify(['viewer-mark-starter', principal.modelId, principal.audience, principal.subject, key])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const categoryKey = (row, id) => JSON.stringify(row.owner_audience === 'ops' ? ['ops', id] : [row.owner_audience, row.owner_subject, id]);

class ViewerMarkRepository {
  constructor(database, { visibility = SERVED_SHARING } = {}) {
    this.database = database;
    this.visibility = visibility;
  }

  isShared(row) {
    return row.owner_audience === 'ops' && row.visibility === 'internal' && Boolean(row.share_access) && this.visibility.ops.includes('shared');
  }

  // Who reads marks shared on their model. Public principals exist only for a live link that shows marks.
  readsShared(principal) { return staff(principal) || verifiedClient(principal) || principal.audience === 'public'; }

  // The owner always reads. Anyone else needs a sharing choice that is being
  // served: staff then read every mark except someone else's private one, and
  // a client reads staff marks shared on the model or with their account, never another client's.
  readable(principal, row) {
    if (!row || row.deleted_at) return false;
    if (isOwner(principal, row)) return true;
    if (this.isShared(row)) return this.readsShared(principal);
    if (principal.personalPersistence === false) return false;
    if (row.visibility === 'private' || !this.visibility[row.owner_audience].includes(row.visibility)) return false;
    if (staff(principal)) return true;
    const account = principalAccount(principal);
    return row.visibility === 'client' && account !== null && row.share_account === account;
  }

  // Sharing, deleting, restoring and going back to an earlier version.
  manageable(principal, row) { return isOwner(principal, row) || (staff(principal) && this.isShared(row)); }

  editable(principal, row) {
    return this.readable(principal, row) && (this.manageable(principal, row)
      || (verifiedClient(principal) && principal.personalPersistence !== false && this.isShared(row) && row.share_access === 'edit'));
  }

  // Held staff-wide marks come with one list of categories for all staff.
  teamCategories() { return this.visibility.ops.includes('internal'); }

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
    return this.database.prepare(`SELECT m.*, s.access AS share_access FROM ${MARKS} WHERE m.model_id=? AND m.id=?`).get(principal.modelId, id);
  }

  liveCategoryIds(modelId) {
    return new Set(this.database.prepare('SELECT id FROM viewer_mark_categories WHERE model_id=? AND deleted_at IS NULL')
      .all(modelId).map(row => row.id));
  }

  view(principal, row, categories = this.liveCategoryIds(principal.modelId)) {
    if (!this.readable(principal, row)) return null;
    return this.describe(principal, row, categories);
  }

  describe(principal, row, categories = this.liveCategoryIds(principal.modelId)) {
    const { note, ...document } = JSON.parse(row.document_json), shared = this.isShared(row);
    const author = row.owner_audience === 'ops' ? 'staff' : 'client';
    const categoryId = document.categoryId && categories.has(document.categoryId) ? document.categoryId : null;
    // A public link gets what it draws: no note, and nothing about people or times.
    if (principal.audience === 'public') return { ...document, categoryId, visibility: 'shared', access: 'view', revision: row.revision, author, mine: false, editable: false, deletable: false };
    return {
      ...document, note, categoryId,
      visibility: shared ? 'shared' : row.visibility, access: shared ? row.share_access : null,
      revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
      author, mine: isOwner(principal, row), editable: this.editable(principal, row), deletable: this.manageable(principal, row),
      ...(shared && staff(principal) ? { changedBy: row.updated_by_audience === 'ops' ? 'staff' : 'client' } : {}),
      // Nobody else's identity is sent; a share target only goes back to the staff member who set it.
      ...(staff(principal) && isOwner(principal, row) ? { shareAccount: row.share_account } : {}),
    };
  }

  // The person's own marks, all of them.
  list(principal) {
    const categories = this.liveCategoryIds(principal.modelId);
    return this.database.prepare(`SELECT m.*, s.access AS share_access FROM ${MARKS} WHERE ${OWN_LIVE.replace('model_id', 'm.model_id')}
      ORDER BY created_at, id`).all(...this.owner(principal))
      .map(row => this.view(principal, row, categories));
  }

  // The sharing choices through which this person can read somebody else's mark.
  readableChoices(principal) {
    const served = [...this.visibility.client, ...this.visibility.ops].filter(choice => choice !== 'private');
    if (staff(principal)) return served;
    return served.filter(choice => (choice === 'shared' ? this.readsShared(principal)
      : choice === 'client' && principal.personalPersistence !== false && principalAccount(principal) !== null));
  }

  // One page of the marks others share with this person, with the categories
  // those marks use. Sizes are read before any document, so a page is bounded.
  sharedPage(principal, after = null) {
    const choices = this.readableChoices(principal);
    if (!choices.length) return { marks: [], categories: [], next: null };
    const stored = choices.filter(choice => choice !== 'shared');
    const account = staff(principal) || !stored.length ? [] : [principalAccount(principal)];
    const which = [choices.includes('shared') && `(${SHARED_ROW})`,
      stored.length && `(m.visibility IN (${stored.map(() => '?').join(',')}) ${account.length ? 'AND m.share_account=?' : ''})`].filter(Boolean).join(' OR ');
    const sizes = this.database.prepare(`SELECT m.id, m.created_at, length(CAST(m.document_json AS BLOB)) AS bytes FROM ${MARKS}
      WHERE m.model_id=? AND m.deleted_at IS NULL AND (${which})
      AND NOT (m.owner_audience=? AND m.owner_subject=?) AND (m.created_at>? OR (m.created_at=? AND m.id>?)) ORDER BY m.created_at, m.id LIMIT ?`)
      .all(principal.modelId, ...stored, ...account, principal.audience, principal.subject ?? '', after?.at ?? '', after?.at ?? '', after?.id ?? '', LIMITS.pageRows + 1);
    let bytes = 0, take = 0;
    while (take < Math.min(sizes.length, LIMITS.pageRows) && (take === 0 || bytes + sizes[take].bytes <= LIMITS.pageBytes)) bytes += sizes[take++].bytes;
    const live = this.liveCategoryIds(principal.modelId), categories = new Map();
    const marks = sizes.slice(0, take).map(({ id }) => {
      const row = this.row(principal, id), mark = this.view(principal, row, live);
      if (mark?.categoryId && !categories.has(mark.categoryId)) {
        const category = this.categoryRow(principal, mark.categoryId);
        if (category && !category.deleted_at && categoryKey(category, category.id) === categoryKey(row, mark.categoryId))
          categories.set(category.id, this.categoryView(principal, category));
      }
      return mark;
    }).filter(Boolean);
    const last = sizes[take - 1];
    return { marks, categories: [...categories.values()], next: take < sizes.length ? `${last.created_at}~${last.id}` : null };
  }

  // What sharing this person may choose for a mark of their own.
  sharingCapabilities(principal) {
    const shared = this.visibility[principal.audience].includes('shared');
    return { visibility: this.visibility[principal.audience], access: shared ? [...ACCESS] : [], shareAll: shared, history: shared };
  }

  get(principal, id) { return this.view(principal, this.row(principal, id)); }

  // Whether a live shared mark on this model uses it: then whoever reads that mark reads the category.
  sharedCategory(principal, id) {
    return this.visibility.ops.includes('shared') && Boolean(this.database.prepare(`SELECT 1 FROM ${MARKS}
      WHERE m.model_id=? AND m.deleted_at IS NULL AND ${SHARED_ROW} AND json_extract(m.document_json,'$.categoryId')=? LIMIT 1`).get(principal.modelId, id));
  }

  // Clients attach only their own categories to their marks; a staff mark takes only
  // staff categories: one's own, or one already seen on a shared mark.
  checkCategory(principal, categoryId, existing = null, ownerAudience = principal.audience) {
    if (!categoryId || categoryId === existing) return;
    const category = this.categoryRow(principal, categoryId);
    const allowed = category && !category.deleted_at && category.owner_audience === ownerAudience
      && (isOwner(principal, category) || (ownerAudience === 'ops'
        && ((staff(principal) && this.teamCategories()) || (this.readsShared(principal) && this.sharedCategory(principal, categoryId)))));
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

  // How a requested choice is kept: "shared" is a row marked internal plus its access.
  sharing(principal, ownerAudience, { visibility, shareAccount, access }, held = null) {
    const account = this.checkVisibility(principal, ownerAudience, visibility, shareAccount);
    if (visibility !== 'shared') {
      if (access) throw markError('invalid_mark');
      return { stored: visibility, account, access: null };
    }
    return { stored: 'internal', account, access: access || held || ACCESS[0] };
  }

  saveAccess(modelId, id, access) {
    if (access) this.database.prepare(`INSERT INTO viewer_mark_shares(model_id, mark_id, access) VALUES (?, ?, ?)
      ON CONFLICT(model_id, mark_id) DO UPDATE SET access=excluded.access`).run(modelId, id, access);
    else this.database.prepare('DELETE FROM viewer_mark_shares WHERE model_id=? AND mark_id=?').run(modelId, id);
  }

  // Keeps the version about to be replaced: the last few, and always the newest one staff made.
  keepVersion(row) {
    const key = [row.model_id, row.id];
    this.database.prepare(`INSERT OR REPLACE INTO viewer_mark_history(model_id, mark_id, revision, document_json, changed_by_audience, changed_by_subject, changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(...key, row.revision, row.document_json, row.updated_by_audience, row.updated_by_subject, row.updated_at);
    this.database.prepare(`DELETE FROM viewer_mark_history WHERE model_id=? AND mark_id=?
      AND revision NOT IN (SELECT revision FROM viewer_mark_history WHERE model_id=? AND mark_id=? ORDER BY revision DESC LIMIT ?)
      AND revision<>coalesce((SELECT max(revision) FROM viewer_mark_history WHERE model_id=? AND mark_id=? AND changed_by_audience='ops'), 0)`)
      .run(...key, ...key, LIMITS.history, ...key);
  }

  // What a person may still add: marks and bytes, live or recently deleted.
  room(principal, where, limits, extra = []) {
    const used = this.database.prepare(`SELECT count(*) n, coalesce(sum(length(CAST(document_json AS BLOB))), 0) bytes FROM viewer_marks WHERE ${where}`)
      .get(...this.owner(principal), ...extra);
    return { marks: limits.marks - used.n, bytes: limits.bytes - used.bytes };
  }
  // A mark counts for the person who made it, whoever changes it.
  liveRoom(principal) { return this.room(principal, OWN_LIVE, { marks: LIMITS.perOwner, bytes: LIMITS.ownerBytes }); }
  takeRoom(room, document) {
    room.marks -= 1;
    room.bytes -= Buffer.byteLength(document);
    if (room.marks < 0) throw markError('mark_limit_reached', 429);
    if (room.bytes < 0) throw markError('mark_storage_limit', 429);
  }

  insert(principal, input, room = this.liveRoom(principal)) {
    const { document: mark, visibility: requested, shareAccount: requestedAccount, access: requestedAccess } = validateMark(input);
    const visibility = requested || this.visibility[principal.audience][0];
    const { stored, account: shareAccount, access } = this.sharing(principal, principal.audience,
      { visibility, shareAccount: requestedAccount, access: requestedAccess });
    const document = JSON.stringify(mark);
    const hash = createHash('sha256').update(JSON.stringify([document, visibility, shareAccount, ...(access ? [access] : [])])).digest('hex');
    const existing = this.row(principal, mark.id);
    if (existing) {
      if (existing.deleted_at || !isOwner(principal, existing) || existing.creation_hash !== hash) throw markError('mark_id_conflict', 409);
      return { mark: this.view(principal, existing), replayed: true };
    }
    this.checkCategory(principal, mark.categoryId);
    this.takeRoom(room, document);
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO viewer_marks
      (id, model_id, owner_audience, owner_subject, owner_account, visibility, share_account, document_json, creation_hash,
       revision, created_at, updated_at, updated_by_audience, updated_by_subject)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(mark.id, principal.modelId, principal.audience, principal.subject,
      principalAccount(principal), stored, shareAccount, document, hash, now, now, principal.audience, principal.subject);
    if (access) this.saveAccess(principal.modelId, mark.id, access);
    return { mark: this.get(principal, mark.id), replayed: false };
  }

  create(principal, input) { return this.transaction(() => this.insert(principal, input)); }

  // One SQLite snapshot covers live marks, deletions and retained IDs. An
  // empty result says none of these IDs belongs to this person on this model.
  reservedImportIds(principal, ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > LIMITS.batch
      || ids.some(id => typeof id !== 'string' || !UUID.test(id))) throw markError('invalid_mark_batch');
    const keys = ids.map(id => id.toLowerCase());
    return this.database.prepare(`SELECT id FROM viewer_marks
      WHERE model_id=? AND owner_audience=? AND owner_subject=? AND id IN (SELECT value FROM json_each(?))`)
      .all(...this.owner(principal), JSON.stringify(keys)).map(row => row.id);
  }

  // Import: its new categories and all its marks land together, or nothing does.
  createMany(principal, { marks, categories = [] }) {
    if (!Array.isArray(marks) || !marks.length || marks.length > LIMITS.batch
      || !Array.isArray(categories) || categories.length > LIMITS.categories) throw markError('invalid_mark_batch');
    return this.transaction(() => {
      const made = categories.map(input => this.addCategory(principal, validateNewCategory(input)).category);
      const room = this.liveRoom(principal);
      return { marks: marks.map(input => this.insert(principal, input, room).mark), categories: made };
    });
  }

  update(principal, id, input) {
    const { document: mark, visibility: requested, shareAccount: requestedAccount, access: requestedAccess } = validateMark(input, { update: true });
    if (mark.id !== id) throw markError('mark_id_mismatch');
    return this.transaction(() => {
      const row = this.row(principal, id);
      if (!this.readable(principal, row)) throw markError('mark_not_found', 404);
      if (!this.editable(principal, row)) throw markError('mark_edit_forbidden', 403);
      if (row.revision !== input.revision) throw markError('mark_revision_conflict', 409);
      const shared = this.isShared(row), current = shared ? 'shared' : row.visibility;
      let sharing = { stored: row.visibility, account: row.share_account, access: row.share_access };
      const changing = (requested !== undefined && requested !== current)
        || (requestedAccount !== undefined && (requestedAccount || null) !== row.share_account)
        || (requestedAccess !== undefined && requestedAccess !== (shared ? row.share_access : null));
      if (changing) {
        if (!this.manageable(principal, row)) throw markError('mark_visibility_forbidden', 403);
        sharing = this.sharing(principal, row.owner_audience, { visibility: requested ?? current,
          shareAccount: requestedAccount === undefined ? row.share_account : requestedAccount, access: requestedAccess }, shared ? row.share_access : null);
      }
      this.checkCategory(principal, mark.categoryId, JSON.parse(row.document_json).categoryId, row.owner_audience);
      return this.write(principal, row, JSON.stringify(mark), sharing);
    });
  }

  // The new version of a mark. Earlier content of a shared mark is kept.
  write(principal, row, document, { stored = row.visibility, account = row.share_account, access = row.share_access } = {}) {
    const growth = Buffer.byteLength(document) - Buffer.byteLength(row.document_json);
    if (growth > 0 && growth > this.liveRoom(this.ownerOf(row)).bytes) throw markError('mark_storage_limit', 429);
    if (this.isShared(row) && document !== row.document_json) this.keepVersion(row);
    this.database.prepare(`UPDATE viewer_marks SET document_json=?, visibility=?, share_account=?, revision=revision+1, updated_at=?,
      updated_by_audience=?, updated_by_subject=? WHERE model_id=? AND id=?`).run(document, stored, account,
      new Date().toISOString(), principal.audience, principal.subject, principal.modelId, row.id);
    if (access !== row.share_access) this.saveAccess(principal.modelId, row.id, access);
    // Also answers the colleague who just made it its owner's alone, with what they sent.
    return this.describe(principal, this.row(principal, row.id));
  }

  // All of one's own marks on a model at once, in requests of a bounded size: all of them or none.
  shareMany(principal, { marks: items, access = undefined }) {
    if (!staff(principal) || !this.visibility.ops.includes('shared')) throw markError('mark_visibility_forbidden', 403);
    if (access !== undefined && !ACCESS.includes(access)) throw markError('invalid_mark_batch');
    if (!Array.isArray(items) || !items.length || items.length > LIMITS.batch
      || items.some(item => !plainObject(item) || typeof item.id !== 'string' || Object.keys(item).some(key => !['id', 'revision'].includes(key)))
      || new Set(items.map(item => item.id)).size !== items.length) throw markError('invalid_mark_batch');
    return this.transaction(() => items.map(({ id, revision }) => {
      if (!Number.isSafeInteger(revision) || revision < 1) throw markError('mark_revision_required', 428);
      const row = this.row(principal, id);
      if (!this.readable(principal, row)) throw markError('mark_not_found', 404);
      if (!isOwner(principal, row)) throw markError('mark_edit_forbidden', 403);
      if (row.revision !== revision) throw markError('mark_revision_conflict', 409);
      const shared = this.isShared(row), wanted = access || (shared ? row.share_access : ACCESS[0]);
      if (shared && wanted === row.share_access) return this.describe(principal, row);
      return this.write(principal, row, row.document_json, { stored: 'internal', account: null, access: wanted });
    }));
  }

  managedRow(principal, id) {
    const row = this.row(principal, id);
    if (!staff(principal) || !this.readable(principal, row)) throw markError('mark_not_found', 404);
    if (!this.manageable(principal, row)) throw markError('mark_edit_forbidden', 403);
    return row;
  }

  // Earlier versions of a shared mark, newest first: for staff, without anyone's identity.
  history(principal, id) {
    this.managedRow(principal, id);
    return this.database.prepare('SELECT * FROM viewer_mark_history WHERE model_id=? AND mark_id=? ORDER BY revision DESC').all(principal.modelId, id)
      .map(row => ({ revision: row.revision, changedBy: row.changed_by_audience === 'ops' ? 'staff' : 'client', changedAt: row.changed_at, mark: JSON.parse(row.document_json) }));
  }

  // Puts an earlier version's content back as a new one (the last, if none is named). Sharing stays as it is.
  revert(principal, id, { revision, to }) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw markError('mark_revision_required', 428);
    if (to !== undefined && (!Number.isSafeInteger(to) || to < 1)) throw markError('invalid_mark_revert');
    return this.transaction(() => {
      const row = this.managedRow(principal, id);
      if (row.revision !== revision) throw markError('mark_revision_conflict', 409);
      const version = this.database.prepare(`SELECT document_json FROM viewer_mark_history WHERE model_id=? AND mark_id=? ${to ? 'AND revision=?' : ''}
        ORDER BY revision DESC LIMIT 1`).get(principal.modelId, id, ...(to ? [to] : []));
      if (!version) throw markError('mark_version_not_found', 404);
      return this.write(principal, row, version.document_json);
    });
  }

  removeOne(principal, id, revision, roomOf) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw markError('mark_revision_required', 428);
    const row = this.row(principal, id);
    if (!this.readable(principal, row)) throw markError('mark_not_found', 404);
    if (!this.manageable(principal, row)) throw markError('mark_edit_forbidden', 403);
    if (row.revision !== revision) throw markError('mark_revision_conflict', 409);
    // The owner (for a shared mark, any staff) can restore it for RECOVERY_DAYS; purgeDeleted then
    // drops the content. The id stays used. A full list refuses instead of dropping older
    // ones early; without room (the person said for good) the content goes now.
    const room = roomOf?.(row);
    if (room) {
      room.marks -= 1;
      room.bytes -= Buffer.byteLength(row.document_json);
      if (room.marks < 0 || room.bytes < 0) throw markError('mark_deleted_full', 409);
    } else {
      this.database.prepare('DELETE FROM viewer_mark_history WHERE model_id=? AND mark_id=?').run(principal.modelId, id);
    }
    const now = new Date().toISOString();
    this.database.prepare(`UPDATE viewer_marks SET deleted_at=?, updated_at=?, document_json=?,
      updated_by_audience=?, updated_by_subject=? WHERE model_id=? AND id=?`)
      .run(now, now, room ? row.document_json : '{}', principal.audience, principal.subject, principal.modelId, id);
  }

  // One Recently deleted per owner, whoever deletes.
  deletedRooms() {
    const rooms = new Map();
    return row => {
      const key = JSON.stringify([row.owner_audience, row.owner_subject]);
      if (!rooms.has(key)) rooms.set(key, this.deletedRoom(this.ownerOf(row)));
      return rooms.get(key);
    };
  }

  deletedRoom(principal) {
    return this.room(principal, `${OWN_DELETED} AND document_json<>'{}' AND deleted_at>=?`, { marks: LIMITS.deleted, bytes: LIMITS.deletedBytes },
      [recoveryCutoff(Date.now())]);
  }

  delete(principal, id, revision, { permanent = false } = {}) {
    return this.transaction(() => this.removeOne(principal, id, revision, permanent ? null : this.deletedRooms()));
  }

  // Undo of an import: all of them or none.
  deleteMany(principal, items) {
    if (!Array.isArray(items) || !items.length || items.length > LIMITS.batch
      || items.some(item => !plainObject(item) || typeof item.id !== 'string' || Object.keys(item).some(key => !['id', 'revision'].includes(key)))) throw markError('invalid_mark_batch');
    return this.transaction(() => {
      const rooms = this.deletedRooms();
      for (const { id, revision } of items) this.removeOne(principal, id, revision, rooms);
    });
  }

  owner(principal) { return [principal.modelId, principal.audience, principal.subject]; }
  ownerOf(row) { return { modelId: row.model_id, audience: row.owner_audience, subject: row.owner_subject }; }

  // The deleted marks that can still come back, newest first: one's own, all of them, and for
  // staff also shared ones of other staff, as many as fit. Sizes are read before any document.
  deleted(principal, now = Date.now()) {
    const others = staff(principal) && this.visibility.ops.includes('shared');
    const rows = this.database.prepare(`SELECT m.id, m.owner_audience, m.owner_subject, length(CAST(m.document_json AS BLOB)) AS bytes FROM ${MARKS}
      WHERE m.model_id=? AND ((m.owner_audience=? AND m.owner_subject=?) ${others ? `OR (${SHARED_ROW})` : ''})
      AND m.deleted_at IS NOT NULL AND m.document_json<>'{}' AND m.deleted_at>=?
      ORDER BY (m.owner_audience=? AND m.owner_subject=?) DESC, m.deleted_at DESC, m.rowid DESC LIMIT ?`)
      .all(...this.owner(principal), recoveryCutoff(now), principal.audience, principal.subject, LIMITS.deleted);
    let bytes = LIMITS.deletedBytes;
    return rows.filter(row => isOwner(principal, row) || (bytes -= row.bytes) >= 0).map(({ id }) => {
      const row = this.row(principal, id), shared = this.isShared(row);
      return { ...JSON.parse(row.document_json), visibility: shared ? 'shared' : row.visibility, access: shared ? row.share_access : null,
        revision: row.revision, deletedAt: row.deleted_at, mine: isOwner(principal, row) };
    }).sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0));
  }

  restore(principal, id, revision, now = Date.now()) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw markError('mark_revision_required', 428);
    return this.transaction(() => {
      const row = this.row(principal, id);
      if (!row || !row.deleted_at || !this.manageable(principal, row) || row.document_json === '{}'
        || row.deleted_at < recoveryCutoff(now)) throw markError('mark_not_found', 404);
      if (row.revision !== revision) throw markError('mark_revision_conflict', 409);
      // It comes back with the sharing it had, if that is still served.
      if (!this.isShared(row) && !this.visibility[row.owner_audience].includes(row.visibility)) throw markError('mark_visibility_forbidden', 403);
      this.takeRoom(this.liveRoom(this.ownerOf(row)), row.document_json);
      this.database.prepare(`UPDATE viewer_marks SET deleted_at=NULL, revision=revision+1, updated_at=?,
        updated_by_audience=?, updated_by_subject=? WHERE model_id=? AND id=?`)
        .run(new Date(now).toISOString(), principal.audience, principal.subject, principal.modelId, id);
      return this.get(principal, id);
    });
  }

  // Run by the worker's maintenance pass: after RECOVERY_DAYS only the empty row (and its id) remains.
  purgeDeleted(now = Date.now()) {
    const cutoff = recoveryCutoff(now);
    this.database.prepare(`DELETE FROM viewer_mark_history WHERE EXISTS (SELECT 1 FROM viewer_marks m
      WHERE m.model_id=viewer_mark_history.model_id AND m.id=viewer_mark_history.mark_id AND m.deleted_at<?)`).run(cutoff);
    return this.database.prepare("UPDATE viewer_marks SET document_json='{}' WHERE deleted_at<? AND document_json<>'{}'").run(cutoff).changes;
  }

  categoryRow(principal, id) {
    return this.database.prepare('SELECT * FROM viewer_mark_categories WHERE model_id=? AND id=?').get(principal.modelId, id);
  }

  categoryView(principal, row) {
    if (principal.audience === 'public') return { ...JSON.parse(row.document_json), revision: row.revision, mine: false, editable: false, author: 'staff' };
    return { ...JSON.parse(row.document_json), revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
      mine: isOwner(principal, row), editable: isOwner(principal, row),
      author: row.owner_audience === 'ops' ? 'staff' : 'client' };
  }

  // The person's own, all of them. Others' come with the marks that use them.
  categories(principal) {
    const team = staff(principal) && this.teamCategories() ? "OR owner_audience='ops'" : '';
    return this.database.prepare(`SELECT * FROM viewer_mark_categories WHERE model_id=? AND deleted_at IS NULL
      AND ((owner_audience=? AND owner_subject=?) ${team}) ORDER BY name COLLATE NOCASE, id`).all(...this.owner(principal))
      .map(row => this.categoryView(principal, row));
  }

  nameTaken(principal, name, exceptId = null) {
    return Boolean(this.database.prepare(`SELECT 1 FROM viewer_mark_categories WHERE model_id=? AND owner_audience=? AND owner_subject=?
      AND deleted_at IS NULL AND name=? COLLATE NOCASE AND id<>?`).get(principal.modelId, principal.audience, principal.subject, name, exceptId || ''));
  }

  createCategory(principal, input) {
    const category = validateNewCategory(input);
    return this.transaction(() => this.addCategory(principal, category));
  }

  addCategory(principal, category) {
    const existing = this.categoryRow(principal, category.id);
    if (existing) {
      if (existing.deleted_at || !isOwner(principal, existing) || existing.document_json !== JSON.stringify(category))
        throw markError('mark_category_id_conflict', 409);
      return { category: this.categoryView(principal, existing), replayed: true };
    }
    if (this.nameTaken(principal, category.name)) throw markError('mark_category_name_taken', 409);
    return this.insertCategory(principal, category);
  }

  insertCategory(principal, category) {
    const count = this.database.prepare(`SELECT count(*) n FROM viewer_mark_categories WHERE model_id=? AND owner_audience=?
      AND owner_subject=? AND deleted_at IS NULL`).get(...this.owner(principal)).n;
    if (count >= LIMITS.categories) throw markError('mark_category_limit_reached', 429);
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO viewer_mark_categories
      (id, model_id, owner_audience, owner_subject, owner_account, name, document_json, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(category.id, principal.modelId, principal.audience, principal.subject,
      principalAccount(principal), category.name, JSON.stringify(category), now, now);
    return { category: this.categoryView(principal, this.categoryRow(principal, category.id)), replayed: false };
  }

  // Starters still to offer: to a person with no categories of their own, or who
  // began from starters. One they used or deleted is not offered again. Reading
  // this writes nothing.
  starters(principal) {
    const rows = this.database.prepare('SELECT id, deleted_at FROM viewer_mark_categories WHERE model_id=? AND owner_audience=? AND owner_subject=?')
      .all(...this.owner(principal));
    const ids = new Map(STARTERS.map(key => [starterId(principal, key), key]));
    const used = new Set(rows.map(row => ids.get(row.id)).filter(Boolean));
    if (!used.size && rows.some(row => !row.deleted_at)) return [];
    return STARTERS.filter(key => !used.has(key));
  }

  // Makes the starter the person chose, or hands back the one they already have
  // (renamed, or made on another device, or their own with that name).
  createStarter(principal, input) {
    const { key, ...fields } = plainObject(input) ? input : {};
    if (!STARTERS.includes(key) || 'id' in fields) throw markError('invalid_mark_category');
    const category = validateCategory({ ...fields, id: starterId(principal, key) });
    return this.transaction(() => {
      const existing = this.categoryRow(principal, category.id);
      if (existing && (existing.deleted_at || !isOwner(principal, existing))) throw markError('mark_category_id_conflict', 409);
      const own = existing || this.database.prepare(`SELECT * FROM viewer_mark_categories WHERE model_id=? AND owner_audience=? AND owner_subject=?
        AND deleted_at IS NULL AND name=? COLLATE NOCASE`).get(...this.owner(principal), category.name);
      if (own) return { category: this.categoryView(principal, own), replayed: true };
      return this.insertCategory(principal, category);
    });
  }

  editableCategory(principal, id, revision) {
    const row = this.categoryRow(principal, id);
    // Others see a category only with a mark that uses it, and never change it.
    if (!row || row.deleted_at || !isOwner(principal, row)) throw markError('mark_category_not_found', 404);
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
      // Marks keep their own colour and icon; their category reads as none. It cannot
      // be undone (the panel says so), so nothing of it is kept but its used id.
      const now = new Date().toISOString();
      this.database.prepare("UPDATE viewer_mark_categories SET deleted_at=?, updated_at=?, name='', document_json='{}' WHERE model_id=? AND id=?")
        .run(now, now, principal.modelId, id);
    });
  }
}

module.exports = { ViewerMarkRepository, SERVED_SHARING, HELD_SHARING, ACCESS, RECOVERY_DAYS, STARTERS, markError, validateMark, validateCategory, principalAccount, LIMITS };
