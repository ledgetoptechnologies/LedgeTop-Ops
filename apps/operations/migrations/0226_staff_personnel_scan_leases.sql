PRAGMA foreign_keys=ON;
CREATE TABLE staff_personnel_scan_jobs(
 document_id TEXT PRIMARY KEY REFERENCES staff_personnel_documents(id) ON DELETE RESTRICT,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','completed','manual_review')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
 retry_after TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 lease_sha256 TEXT CHECK(lease_sha256 IS NULL OR (length(lease_sha256)=64 AND lease_sha256 NOT GLOB '*[^0-9a-f]*')),
 lease_until TEXT,worker_id TEXT,last_error TEXT,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 CHECK((state='leased' AND lease_sha256 IS NOT NULL AND lease_until IS NOT NULL AND worker_id IS NOT NULL)
  OR (state<>'leased' AND lease_until IS NULL))
);
CREATE INDEX staff_personnel_scan_pending ON staff_personnel_scan_jobs(state,retry_after,created_at,document_id);
INSERT INTO staff_personnel_scan_jobs(document_id) SELECT id FROM staff_personnel_documents WHERE status='quarantined';
CREATE TRIGGER staff_personnel_scan_enqueue AFTER UPDATE ON staff_personnel_documents
WHEN NEW.status='quarantined' AND OLD.status='uploading'
BEGIN INSERT INTO staff_personnel_scan_jobs(document_id) VALUES(NEW.id); END;
CREATE TRIGGER staff_personnel_scan_jobs_no_delete BEFORE DELETE ON staff_personnel_scan_jobs
BEGIN SELECT RAISE(ABORT,'personnel scan jobs are retained'); END;
CREATE TRIGGER staff_personnel_scan_jobs_identity BEFORE UPDATE ON staff_personnel_scan_jobs
WHEN NEW.document_id IS NOT OLD.document_id OR NEW.created_at IS NOT OLD.created_at
 OR NEW.attempts<OLD.attempts OR NEW.attempts>OLD.attempts+1
 OR OLD.state IN ('completed','manual_review')
BEGIN SELECT RAISE(ABORT,'invalid personnel scan job transition'); END;

-- A scanner receipt cannot commit without the current, unexpired lease. The
-- claim hash is used as its immutable command ID, never the plaintext token.
CREATE TRIGGER staff_personnel_scan_receipt_lease BEFORE INSERT ON staff_personnel_events
WHEN NEW.capability='scanner' AND NOT EXISTS(SELECT 1 FROM staff_personnel_scan_jobs job
 JOIN staff_personnel_documents document ON document.id=job.document_id
 WHERE job.document_id=NEW.document_id AND job.state='leased'
 AND job.lease_sha256=NEW.command_id AND job.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND document.staff_id=NEW.staff_id
 AND document.status=CASE NEW.event_kind WHEN 'scan_accepted' THEN 'accepted' WHEN 'scan_rejected' THEN 'rejected' ELSE '' END)
BEGIN SELECT RAISE(ABORT,'personnel scan lease changed'); END;
CREATE TRIGGER staff_personnel_scan_receipt_complete AFTER INSERT ON staff_personnel_events
WHEN NEW.capability='scanner'
BEGIN UPDATE staff_personnel_scan_jobs SET state='completed',lease_until=NULL,last_error=NULL
 WHERE document_id=NEW.document_id AND state='leased' AND lease_sha256=NEW.command_id; END;
