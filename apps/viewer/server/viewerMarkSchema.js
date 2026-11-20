'use strict';

// Release integration assigns this DDL an ordinal in the Viewer migration ledger.
const VIEWER_MARKS_SQL = `
  CREATE TABLE private_viewer_marks (
    id TEXT NOT NULL,
    model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    model_version_id TEXT NOT NULL REFERENCES model_versions(id) ON DELETE CASCADE,
    owner_audience TEXT NOT NULL CHECK(owner_audience IN ('ops','client')),
    owner_subject TEXT NOT NULL,
    document_json TEXT NOT NULL,
    creation_hash TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    PRIMARY KEY(model_id, model_version_id, owner_audience, owner_subject, id)
  );
  CREATE INDEX private_viewer_marks_owner_idx
    ON private_viewer_marks(model_id, model_version_id, owner_audience, owner_subject, deleted_at);
`;

module.exports = { VIEWER_MARKS_SQL };
