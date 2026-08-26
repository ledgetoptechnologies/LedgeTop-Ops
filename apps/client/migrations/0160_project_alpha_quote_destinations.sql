PRAGMA foreign_keys = ON;

-- Reserve the exact command before network I/O. A retry can rotate credentials,
-- but cannot silently change producer, destination, payload or revision key.
-- Secrets are never persisted. This is not an enabled connector registry.
CREATE TABLE request_pa_draft_quote_commands (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL,
  request_revision INTEGER NOT NULL CHECK (request_revision > 0),
  area_revision INTEGER NOT NULL CHECK (area_revision >= 0),
  source_id TEXT NOT NULL CHECK (
    substr(source_id,1,14)='project-alpha:' AND length(source_id) BETWEEN 15 AND 78
    AND substr(source_id,15,1) GLOB '[a-z0-9]'
    AND substr(source_id,15) NOT GLOB '*[^a-z0-9_-]*' AND instr(source_id,char(0))=0
  ),
  command_endpoint TEXT NOT NULL CHECK (length(command_endpoint) BETWEEN 2 AND 2048
    AND instr(command_endpoint,char(0))=0 AND instr(command_endpoint,char(9))=0
    AND instr(command_endpoint,char(10))=0 AND instr(command_endpoint,char(13))=0
    AND instr(command_endpoint,' ')=0),
  application_key TEXT NOT NULL CHECK (length(application_key) BETWEEN 1 AND 128
    AND substr(application_key,1,1) GLOB '[A-Za-z0-9]'
    AND application_key NOT GLOB '*[^A-Za-z0-9._:-]*' AND instr(application_key,char(0))=0),
  editor_origin TEXT NOT NULL CHECK (length(editor_origin) BETWEEN 2 AND 2048
    AND instr(editor_origin,char(0))=0 AND instr(editor_origin,char(9))=0
    AND instr(editor_origin,char(10))=0 AND instr(editor_origin,char(13))=0
    AND instr(editor_origin,' ')=0),
  destination_fingerprint TEXT NOT NULL CHECK (length(destination_fingerprint)=64
    AND destination_fingerprint NOT GLOB '*[^0-9a-f]*' AND instr(destination_fingerprint,char(0))=0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 160),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'
    AND instr(payload_hash,char(0))=0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json)='object'
    AND length(CAST(payload_json AS BLOB))<=98304),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (request_id,request_revision,area_revision),
  FOREIGN KEY (request_id,source_id) REFERENCES client_service_requests(id,catalog_source_id)
);

CREATE TRIGGER request_pa_draft_quote_command_no_update
BEFORE UPDATE ON request_pa_draft_quote_commands
BEGIN SELECT RAISE(ABORT,'Project Alpha draft command is immutable'); END;
CREATE TRIGGER request_pa_draft_quote_command_no_delete
BEFORE DELETE ON request_pa_draft_quote_commands
BEGIN SELECT RAISE(ABORT,'Project Alpha draft command cannot be deleted'); END;
CREATE TRIGGER request_pa_draft_quote_command_insert_identity
BEFORE INSERT ON request_pa_draft_quote_commands
WHEN EXISTS (SELECT 1 FROM request_pa_draft_quote_commands existing WHERE
  (existing.id=NEW.id AND (existing.request_id IS NOT NEW.request_id
    OR existing.request_revision IS NOT NEW.request_revision OR existing.area_revision IS NOT NEW.area_revision
    OR existing.source_id IS NOT NEW.source_id OR existing.command_endpoint IS NOT NEW.command_endpoint
    OR existing.application_key IS NOT NEW.application_key OR existing.editor_origin IS NOT NEW.editor_origin
    OR existing.destination_fingerprint IS NOT NEW.destination_fingerprint
    OR existing.idempotency_key IS NOT NEW.idempotency_key OR existing.payload_hash IS NOT NEW.payload_hash
    OR existing.payload_json IS NOT NEW.payload_json OR existing.created_by IS NOT NEW.created_by
    OR existing.created_at IS NOT NEW.created_at))
  OR (existing.request_id=NEW.request_id AND existing.request_revision=NEW.request_revision
    AND existing.area_revision=NEW.area_revision AND existing.id<>NEW.id)
  OR (existing.idempotency_key=NEW.idempotency_key AND existing.id<>NEW.id))
BEGIN SELECT RAISE(ABORT,'Project Alpha draft command identity conflicts'); END;

-- Existing commands were sent only through primary, but their old destinations
-- were never recorded. Keep them unknown: no migration-time current-URL guess,
-- no manufactured command row and no rewrite of receipt hashes or snapshots.
ALTER TABLE request_pa_draft_quote_receipts ADD COLUMN source_id TEXT NOT NULL DEFAULT 'project-alpha:primary'
  CHECK (substr(source_id,1,14)='project-alpha:' AND length(source_id) BETWEEN 15 AND 78
    AND substr(source_id,15,1) GLOB '[a-z0-9]'
    AND substr(source_id,15) NOT GLOB '*[^a-z0-9_-]*' AND instr(source_id,char(0))=0);
ALTER TABLE request_pa_draft_quote_receipts ADD COLUMN command_id TEXT
  REFERENCES request_pa_draft_quote_commands(id);
CREATE INDEX idx_request_pa_draft_quote_receipt_command ON request_pa_draft_quote_receipts(command_id)
  WHERE command_id IS NOT NULL;

CREATE TRIGGER request_pa_draft_quote_receipt_requires_command
BEFORE INSERT ON request_pa_draft_quote_receipts
WHEN NEW.command_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM request_pa_draft_quote_commands command WHERE command.id=NEW.command_id
    AND command.source_id=NEW.source_id AND command.request_id=NEW.request_id
    AND command.request_revision=NEW.request_revision AND command.area_revision=NEW.area_revision
    AND command.idempotency_key=NEW.idempotency_key AND command.payload_hash=NEW.payload_hash
)
BEGIN SELECT RAISE(ABORT,'Project Alpha draft receipt requires its exact command'); END;

-- The original UPDATE/DELETE immutability triggers remain unchanged. INSERT
-- checks also cover SQLite REPLACE, including stealing either existing unique
-- owner key, so it cannot rebind a historical receipt to today's destination.
CREATE TRIGGER request_pa_draft_quote_receipt_insert_identity
BEFORE INSERT ON request_pa_draft_quote_receipts
WHEN EXISTS (SELECT 1 FROM request_pa_draft_quote_receipts existing WHERE
  (existing.id=NEW.id AND (existing.request_id IS NOT NEW.request_id
    OR existing.request_revision IS NOT NEW.request_revision OR existing.area_revision IS NOT NEW.area_revision
    OR existing.idempotency_key IS NOT NEW.idempotency_key OR existing.payload_hash IS NOT NEW.payload_hash
    OR existing.project_alpha_receipt_id IS NOT NEW.project_alpha_receipt_id
    OR existing.project_alpha_artifact_public_id IS NOT NEW.project_alpha_artifact_public_id
    OR existing.document_number IS NOT NEW.document_number OR existing.artifact_status IS NOT NEW.artifact_status
    OR existing.artifact_version IS NOT NEW.artifact_version OR existing.editor_path IS NOT NEW.editor_path
    OR existing.scope_stale_at IS NOT NEW.scope_stale_at OR existing.created_by IS NOT NEW.created_by
    OR existing.created_at IS NOT NEW.created_at OR existing.source_id IS NOT NEW.source_id
    OR existing.command_id IS NOT NEW.command_id))
  OR (existing.request_id=NEW.request_id AND existing.request_revision=NEW.request_revision
    AND existing.area_revision=NEW.area_revision AND existing.id<>NEW.id)
  OR (existing.idempotency_key=NEW.idempotency_key AND existing.id<>NEW.id))
BEGIN SELECT RAISE(ABORT,'Project Alpha draft receipt identity conflicts'); END;
