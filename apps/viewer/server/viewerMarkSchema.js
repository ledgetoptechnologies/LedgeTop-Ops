'use strict';

// Viewer schema 84 (shared-ledger ordinal for Marks). Marks belong to a
// model, not a version: a pin placed on the map stays when a new flight is
// published. Visibility decides who reads a mark:
//   private  - only the person who made it
//   shared   - everyone with live access to the model (staff and clients)
//   internal - staff only (only staff can make internal marks)
// Categories are per model and user-defined, so no domain wording lives here.
const VIEWER_MARKS_SQL = `
  CREATE TABLE viewer_marks (
    id TEXT NOT NULL,
    model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    owner_audience TEXT NOT NULL CHECK(owner_audience IN ('ops','client')),
    owner_subject TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK(visibility IN ('private','shared','internal')),
    document_json TEXT NOT NULL,
    creation_hash TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_audience TEXT NOT NULL CHECK(updated_by_audience IN ('ops','client')),
    updated_by_subject TEXT NOT NULL,
    deleted_at TEXT,
    CHECK(visibility <> 'internal' OR owner_audience = 'ops'),
    PRIMARY KEY(model_id, id)
  );
  CREATE INDEX viewer_marks_model_idx ON viewer_marks(model_id, deleted_at, visibility);
  CREATE INDEX viewer_marks_owner_idx ON viewer_marks(model_id, owner_audience, owner_subject, deleted_at);
  CREATE TABLE viewer_mark_categories (
    id TEXT NOT NULL,
    model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    owner_audience TEXT NOT NULL CHECK(owner_audience IN ('ops','client')),
    owner_subject TEXT NOT NULL,
    name TEXT NOT NULL,
    document_json TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    PRIMARY KEY(model_id, id)
  );
  CREATE UNIQUE INDEX viewer_mark_categories_name_idx
    ON viewer_mark_categories(model_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;
`;

const OBJECTS = ['viewer_marks', 'viewer_marks_model_idx', 'viewer_marks_owner_idx',
  'viewer_mark_categories', 'viewer_mark_categories_name_idx'];

function verifyViewerMarksSchema(database) {
  const definitions = VIEWER_MARKS_SQL.split(';').map(sql => sql.trim()).filter(Boolean);
  const objects = database.prepare(`SELECT sql FROM sqlite_schema WHERE name IN (${OBJECTS.map(() => '?').join(',')})`).all(...OBJECTS);
  const canonical = sql => String(sql).trim().replace(/\s+/g, ' ');
  return objects.length === definitions.length && definitions.every(sql => objects.some(object => canonical(object.sql) === canonical(sql)));
}

module.exports = { VIEWER_MARKS_SQL, verifyViewerMarksSchema };
