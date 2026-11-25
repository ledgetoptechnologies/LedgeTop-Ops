'use strict';

// Viewer schema 84 (reserved for Marks in the shared ledger). Marks belong to a model, not a version: a pin placed on
// the map stays when a new flight is published.
//
// Who reads a mark (visibility). The API serves the first two
// (viewerMarkRepository SERVED_SHARING), and "shared" staff marks (schema 90 below):
//   private  - only the person who made it
//   staff    - a client's mark shared with project staff (never other clients)
//   internal - a staff mark for staff only
//   client   - a staff mark shared with one named client account (share_account)
// A share recipient is a direct client grant ("direct_client_grant:<id>"),
// which Ops issues to one client workspace. Model-association sessions have no
// recipient key (one association serves every account on a model), so they
// read only their own marks. Clients never read another client's marks or
// categories.
const VIEWER_MARKS_SQL = `
  CREATE TABLE viewer_marks (
    id TEXT NOT NULL,
    model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    owner_audience TEXT NOT NULL CHECK(owner_audience IN ('ops','client')),
    owner_subject TEXT NOT NULL,
    owner_account TEXT,
    visibility TEXT NOT NULL CHECK(visibility IN ('private','staff','internal','client')),
    share_account TEXT,
    document_json TEXT NOT NULL,
    creation_hash TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_audience TEXT NOT NULL CHECK(updated_by_audience IN ('ops','client')),
    updated_by_subject TEXT NOT NULL,
    deleted_at TEXT,
    CHECK(visibility NOT IN ('internal','client') OR owner_audience = 'ops'),
    CHECK(visibility <> 'staff' OR owner_audience = 'client'),
    CHECK((visibility = 'client') = (share_account IS NOT NULL)),
    PRIMARY KEY(model_id, id)
  );
  CREATE INDEX viewer_marks_shared_idx ON viewer_marks(model_id, visibility, share_account, deleted_at);
  CREATE INDEX viewer_marks_owner_idx ON viewer_marks(model_id, owner_audience, owner_subject, deleted_at);
  CREATE TABLE viewer_mark_categories (
    id TEXT NOT NULL,
    model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    owner_audience TEXT NOT NULL CHECK(owner_audience IN ('ops','client')),
    owner_subject TEXT NOT NULL,
    owner_account TEXT,
    name TEXT NOT NULL,
    document_json TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    PRIMARY KEY(model_id, id)
  );
  CREATE UNIQUE INDEX viewer_mark_categories_name_idx
    ON viewer_mark_categories(model_id, owner_audience, owner_subject, name COLLATE NOCASE) WHERE deleted_at IS NULL;
  CREATE TABLE viewer_mark_accounts (
    model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    account_key TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY(model_id, account_key)
  );
`;

// Viewer schema 90. Staff marks shared with everyone on the model ("shared"): the
// mark row keeps visibility 'internal' and a row here says who may change it. Both
// are needed, so a build without this table reads such a mark as its owner's alone.
// viewer_mark_history keeps earlier versions of a shared mark, with who made them,
// so that staff can undo a client's change.
const VIEWER_MARK_SHARING_SQL = `
  CREATE TABLE viewer_mark_shares (
    model_id TEXT NOT NULL,
    mark_id TEXT NOT NULL,
    access TEXT NOT NULL CHECK(access IN ('view','edit')),
    PRIMARY KEY(model_id, mark_id),
    FOREIGN KEY(model_id, mark_id) REFERENCES viewer_marks(model_id, id) ON DELETE CASCADE
  );
  CREATE TABLE viewer_mark_history (
    model_id TEXT NOT NULL,
    mark_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    document_json TEXT NOT NULL,
    changed_by_audience TEXT NOT NULL CHECK(changed_by_audience IN ('ops','client')),
    changed_by_subject TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    PRIMARY KEY(model_id, mark_id, revision),
    FOREIGN KEY(model_id, mark_id) REFERENCES viewer_marks(model_id, id) ON DELETE CASCADE
  );
`;

const OBJECTS = ['viewer_marks', 'viewer_marks_shared_idx', 'viewer_marks_owner_idx',
  'viewer_mark_categories', 'viewer_mark_categories_name_idx', 'viewer_mark_accounts'];

function verifyObjects(database, sql, names) {
  const definitions = sql.split(';').map(statement => statement.trim()).filter(Boolean);
  const objects = database.prepare(`SELECT sql FROM sqlite_schema WHERE name IN (${names.map(() => '?').join(',')})`).all(...names);
  const canonical = statement => String(statement).trim().replace(/\s+/g, ' ');
  return objects.length === definitions.length && definitions.every(definition => objects.some(object => canonical(object.sql) === canonical(definition)));
}
const verifyViewerMarksSchema = database => verifyObjects(database, VIEWER_MARKS_SQL, OBJECTS);
const verifyViewerMarkSharingSchema = database => verifyObjects(database, VIEWER_MARK_SHARING_SQL, ['viewer_mark_shares', 'viewer_mark_history']);

module.exports = { VIEWER_MARKS_SQL, VIEWER_MARK_SHARING_SQL, verifyViewerMarksSchema, verifyViewerMarkSharingSchema };
