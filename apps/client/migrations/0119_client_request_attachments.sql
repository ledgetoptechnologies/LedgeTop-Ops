PRAGMA foreign_keys = ON;

-- Opaque private quarantine objects for client service-request attachments.
-- The browser writes multipart bodies directly to R2; the Worker stores only
-- authorization/session metadata and per-part ETags. `accepted` is reachable
-- only through the separately authenticated scanner receipt endpoint.
CREATE TABLE IF NOT EXISTS client_service_request_attachments (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_by_identity_id TEXT NOT NULL,
  client_upload_id TEXT NOT NULL CHECK (length(client_upload_id) BETWEEN 16 AND 128),
  object_key TEXT NOT NULL UNIQUE CHECK (object_key GLOB '_ltds/quarantine/request-attachments/*/object'),
  multipart_upload_id TEXT NOT NULL,
  original_name TEXT NOT NULL CHECK (length(trim(original_name)) BETWEEN 1 AND 255),
  declared_size INTEGER NOT NULL CHECK (declared_size BETWEEN 1 AND 26214400),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf')),
  status TEXT NOT NULL CHECK (status IN ('uploading','quarantined','scanning','accepted','rejected','aborted','expired')),
  actual_size INTEGER CHECK (actual_size IS NULL OR actual_size BETWEEN 1 AND 26214400),
  etag TEXT,
  completion_claimed_at TEXT,
  completed_at TEXT,
  scanner_verdict TEXT CHECK (scanner_verdict IS NULL OR scanner_verdict IN ('clean','rejected')),
  verified_sha256 TEXT CHECK (verified_sha256 IS NULL OR (length(verified_sha256)=64 AND verified_sha256 NOT GLOB '*[^0-9a-f]*')),
  scanned_at TEXT,
  rejection_reason TEXT,
  submitted_request_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status!='accepted' OR (actual_size=declared_size AND scanner_verdict='clean' AND verified_sha256 IS NOT NULL AND scanned_at IS NOT NULL)),
  CHECK (submitted_request_id IS NULL OR status='accepted'),
  UNIQUE (draft_id,client_upload_id),
  FOREIGN KEY (draft_id) REFERENCES client_service_request_drafts(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES client_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_identity_id,account_id) REFERENCES client_identity_links(id,account_id),
  FOREIGN KEY (submitted_request_id) REFERENCES client_service_requests(id)
);
CREATE INDEX IF NOT EXISTS idx_client_request_attachments_draft
  ON client_service_request_attachments(draft_id,status,created_at,id);
CREATE INDEX IF NOT EXISTS idx_client_request_attachments_expiry
  ON client_service_request_attachments(status,expires_at) WHERE submitted_request_id IS NULL;

CREATE TABLE IF NOT EXISTS client_service_request_attachment_parts (
  attachment_id TEXT NOT NULL,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 4),
  etag TEXT NOT NULL CHECK (length(etag)=32 AND etag NOT GLOB '*[^0-9a-f]*'),
  size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 8388608),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (attachment_id,part_number),
  FOREIGN KEY (attachment_id) REFERENCES client_service_request_attachments(id) ON DELETE CASCADE
);

-- A submitted request cannot refer to unscanned content. Once linked, both the
-- attachment metadata and its request link are immutable.
CREATE TRIGGER IF NOT EXISTS trg_client_request_attachment_submit_guard
BEFORE UPDATE OF state ON client_service_request_drafts
WHEN NEW.state='submitted' AND OLD.state='draft' AND EXISTS (
  SELECT 1 FROM client_service_request_attachments attachment
  WHERE attachment.draft_id=OLD.id AND attachment.status NOT IN ('accepted','rejected','aborted','expired')
)
BEGIN
  SELECT RAISE(ABORT,'request attachments are not scan-complete');
END;

CREATE TRIGGER IF NOT EXISTS trg_client_request_attachment_link_submission
AFTER UPDATE OF state ON client_service_request_drafts
WHEN NEW.state='submitted' AND OLD.state='draft'
BEGIN
  UPDATE client_service_request_attachments
  SET submitted_request_id=NEW.submitted_request_id,updated_at=datetime('now')
  WHERE draft_id=NEW.id AND status='accepted' AND submitted_request_id IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_client_request_attachment_linked_update_guard
BEFORE UPDATE ON client_service_request_attachments
WHEN OLD.submitted_request_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'submitted request attachments are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_client_request_attachment_linked_delete_guard
BEFORE DELETE ON client_service_request_attachments
WHEN OLD.submitted_request_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'submitted request attachments are immutable');
END;
