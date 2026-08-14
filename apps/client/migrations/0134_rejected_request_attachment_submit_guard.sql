PRAGMA foreign_keys = ON;

-- A rejected security scan must be resolved explicitly. Rejected rows remain
-- visible on the draft until the client removes them and may never be carried
-- silently past submission as though no file had been supplied.
DROP TRIGGER IF EXISTS trg_client_request_attachment_submit_guard;

CREATE TRIGGER trg_client_request_attachment_submit_guard
BEFORE UPDATE OF state ON client_service_request_drafts
WHEN NEW.state='submitted' AND OLD.state='draft' AND EXISTS (
  SELECT 1 FROM client_service_request_attachments attachment
  WHERE attachment.draft_id=OLD.id AND attachment.status NOT IN ('accepted','aborted','expired')
)
BEGIN
  SELECT RAISE(ABORT,'request attachments must be accepted or removed');
END;
