PRAGMA foreign_keys = ON;

ALTER TABLE browser_upload_intent_files RENAME TO browser_upload_intent_files_legacy_0019;

CREATE TABLE browser_upload_intent_files (
  intent_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 100),
  relative_path TEXT NOT NULL,
  object_key TEXT NOT NULL,
  expected_size INTEGER NOT NULL CHECK (expected_size > 0),
  content_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','uploading','completed','skipped','failed','aborted')),
  session_id TEXT,
  conflict_resolution TEXT CHECK (conflict_resolution IN ('skip','rename','replace')),
  result_key TEXT,
  result_etag TEXT,
  error_code TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(intent_id,ordinal),
  UNIQUE(intent_id,relative_path),
  FOREIGN KEY (intent_id) REFERENCES browser_upload_intents(id) ON DELETE CASCADE
);

INSERT INTO browser_upload_intent_files(
  intent_id,ordinal,relative_path,object_key,expected_size,content_type,status,
  session_id,result_key,result_etag,error_code,updated_at)
SELECT intent_id,ordinal,relative_path,object_key,expected_size,content_type,status,
  session_id,result_key,result_etag,error_code,updated_at
FROM browser_upload_intent_files_legacy_0019;

DROP TABLE browser_upload_intent_files_legacy_0019;
