PRAGMA foreign_keys = ON;

-- Project Alpha remains the financial system of record. This table records
-- only the immutable result of an idempotent, staff-triggered command that
-- asks PA to create a private draft. It contains no pricing or payment data.
CREATE TABLE IF NOT EXISTS request_pa_draft_quote_receipts (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  request_revision INTEGER NOT NULL CHECK (request_revision > 0),
  area_revision INTEGER NOT NULL CHECK (area_revision >= 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 160),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  project_alpha_receipt_id TEXT NOT NULL CHECK (length(trim(project_alpha_receipt_id)) BETWEEN 1 AND 128),
  project_alpha_artifact_public_id TEXT NOT NULL CHECK (length(trim(project_alpha_artifact_public_id)) BETWEEN 1 AND 128),
  document_number TEXT CHECK (document_number IS NULL OR length(trim(document_number)) BETWEEN 1 AND 120),
  artifact_status TEXT NOT NULL CHECK (artifact_status='draft'),
  artifact_version INTEGER NOT NULL CHECK (artifact_version > 0),
  editor_path TEXT NOT NULL CHECK (
    length(editor_path) BETWEEN 2 AND 500 AND
    substr(editor_path,1,1)='/' AND substr(editor_path,1,2)!='//' AND
    instr(editor_path,'\\')=0
  ),
  scope_stale_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (request_id,request_revision,area_revision),
  FOREIGN KEY (request_id) REFERENCES client_service_requests(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_request_pa_draft_quote_receipts_request
  ON request_pa_draft_quote_receipts(request_id,created_at DESC,id DESC);

CREATE TRIGGER IF NOT EXISTS trg_request_pa_draft_quote_receipts_no_update
BEFORE UPDATE ON request_pa_draft_quote_receipts
BEGIN
  SELECT RAISE(ABORT,'Project Alpha draft-quote receipts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_request_pa_draft_quote_receipts_no_delete
BEFORE DELETE ON request_pa_draft_quote_receipts
BEGIN
  SELECT RAISE(ABORT,'Project Alpha draft-quote receipts are immutable');
END;
