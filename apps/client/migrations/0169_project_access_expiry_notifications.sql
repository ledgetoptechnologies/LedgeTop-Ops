PRAGMA foreign_keys = ON;

-- Durable, non-authorizing notices for explicit collaborator terms. The
-- runtime flag remains off by default; applying this migration sends no mail
-- and changes no membership, entitlement, grant, delegation, or access term.
CREATE TABLE IF NOT EXISTS portal_project_access_notice_outbox (
  id TEXT PRIMARY KEY CHECK(length(id)=64 AND id NOT GLOB '*[^a-f0-9]*'),
  access_terms_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  project_public_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('warning_7d','warning_24h','expired')),
  effective_expires_at TEXT NOT NULL CHECK(datetime(effective_expires_at) IS NOT NULL),
  message_id_key TEXT NOT NULL UNIQUE CHECK(length(message_id_key) BETWEEN 16 AND 180),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','processing','sent','suppressed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3),
  next_attempt_at TEXT NOT NULL DEFAULT(datetime('now')),
  lease_token TEXT,
  lease_expires_at TEXT,
  error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
  delivered_at TEXT,
  suppressed_at TEXT,
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  updated_at TEXT NOT NULL DEFAULT(datetime('now')),
  UNIQUE(access_terms_id,identity_id,event_type,effective_expires_at),
  FOREIGN KEY(access_terms_id) REFERENCES portal_project_access_terms(id),
  FOREIGN KEY(workspace_id,identity_id)
    REFERENCES portal_v2_workspace_memberships(workspace_id,identity_id),
  CHECK(
    (status='pending' AND lease_token IS NULL AND lease_expires_at IS NULL AND delivered_at IS NULL AND suppressed_at IS NULL) OR
    (status='processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND delivered_at IS NULL AND suppressed_at IS NULL) OR
    (status='sent' AND lease_token IS NULL AND lease_expires_at IS NULL AND delivered_at IS NOT NULL AND suppressed_at IS NULL) OR
    (status='suppressed' AND lease_token IS NULL AND lease_expires_at IS NULL AND delivered_at IS NULL AND suppressed_at IS NOT NULL) OR
    (status='failed' AND lease_token IS NULL AND lease_expires_at IS NULL AND delivered_at IS NULL AND suppressed_at IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_portal_project_access_notice_ready
  ON portal_project_access_notice_outbox(status,next_attempt_at,lease_expires_at,created_at,id);
CREATE INDEX IF NOT EXISTS idx_portal_project_access_notice_scope
  ON portal_project_access_notice_outbox(workspace_id,project_public_id,identity_id,created_at DESC);

CREATE TABLE IF NOT EXISTS portal_project_access_notice_audit (
  id TEXT PRIMARY KEY CHECK(length(id)=64 AND id NOT GLOB '*[^a-f0-9]*'),
  outbox_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_public_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('warning_7d','warning_24h','expired')),
  action TEXT NOT NULL CHECK(action IN (
    'notice.staged','notice.sent','notice.suppressed',
    'notice.retry_scheduled','notice.failed'
  )),
  attempt_count INTEGER NOT NULL CHECK(attempt_count BETWEEN 0 AND 3),
  reason_code TEXT CHECK(reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  FOREIGN KEY(outbox_id) REFERENCES portal_project_access_notice_outbox(id),
  FOREIGN KEY(workspace_id,identity_id)
    REFERENCES portal_v2_workspace_memberships(workspace_id,identity_id)
);
CREATE INDEX IF NOT EXISTS idx_portal_project_access_notice_audit_scope
  ON portal_project_access_notice_audit(workspace_id,project_public_id,created_at DESC,id DESC);

-- The outbox authority/snapshot is immutable. Only its bounded delivery state
-- may progress. REPLACE is covered by the existing primary/unique constraints
-- and this identity comparison under SQLite's default trigger behavior.
CREATE TRIGGER IF NOT EXISTS portal_project_access_notice_outbox_identity_guard
BEFORE UPDATE ON portal_project_access_notice_outbox
WHEN NEW.id<>OLD.id OR NEW.access_terms_id<>OLD.access_terms_id
  OR NEW.workspace_id<>OLD.workspace_id OR NEW.source_id<>OLD.source_id
  OR NEW.project_public_id<>OLD.project_public_id OR NEW.identity_id<>OLD.identity_id
  OR NEW.event_type<>OLD.event_type OR NEW.effective_expires_at<>OLD.effective_expires_at
  OR NEW.message_id_key<>OLD.message_id_key OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'project access notice identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS portal_project_access_notice_outbox_terminal_guard
BEFORE UPDATE ON portal_project_access_notice_outbox
WHEN OLD.status IN ('sent','suppressed','failed')
  OR NEW.attempt_count<OLD.attempt_count OR NEW.attempt_count>OLD.attempt_count+1
  OR (NEW.status='processing' AND (OLD.status NOT IN ('pending','processing') OR NEW.attempt_count<>OLD.attempt_count+1))
  OR (OLD.status='pending' AND NEW.status NOT IN ('pending','processing','suppressed'))
  OR (OLD.status='processing' AND NEW.status NOT IN ('pending','processing','sent','suppressed','failed'))
BEGIN SELECT RAISE(ABORT,'project access notice state transition is invalid'); END;
CREATE TRIGGER IF NOT EXISTS portal_project_access_notice_outbox_no_delete
BEFORE DELETE ON portal_project_access_notice_outbox
BEGIN SELECT RAISE(ABORT,'project access notice history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS portal_project_access_notice_audit_no_update
BEFORE UPDATE ON portal_project_access_notice_audit
BEGIN SELECT RAISE(ABORT,'project access notice audit is immutable'); END;
CREATE TRIGGER IF NOT EXISTS portal_project_access_notice_audit_no_delete
BEFORE DELETE ON portal_project_access_notice_audit
BEGIN SELECT RAISE(ABORT,'project access notice audit is immutable'); END;

-- These older event ledgers were append-only by contract but lacked database
-- guards. Existing writers only insert, so the guards are upgrade-compatible.
CREATE TRIGGER IF NOT EXISTS portal_v2_membership_audit_no_update
BEFORE UPDATE ON portal_v2_membership_audit
BEGIN SELECT RAISE(ABORT,'portal membership audit is immutable'); END;
CREATE TRIGGER IF NOT EXISTS client_delegated_share_events_no_update
BEFORE UPDATE ON client_delegated_share_events
BEGIN SELECT RAISE(ABORT,'delegated share event is immutable'); END;
