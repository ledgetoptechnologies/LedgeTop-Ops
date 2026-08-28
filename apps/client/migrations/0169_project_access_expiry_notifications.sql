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

-- Companion notices are intentionally isolated from the collaborator outbox.
-- A successful collaborator delivery never implies that an inviter or access
-- creator was notified, and a companion retry can never replay the
-- collaborator message. Actor e-mail addresses are resolved at final send
-- time and are not persisted here.
CREATE TABLE IF NOT EXISTS portal_project_access_companion_notice_outbox (
  id TEXT PRIMARY KEY CHECK(length(id)=64 AND id NOT GLOB '*[^a-f0-9]*'),
  access_terms_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  project_public_id TEXT NOT NULL,
  recipient_role TEXT NOT NULL CHECK(recipient_role IN ('inviter','access_creator')),
  origin_id TEXT NOT NULL CHECK(length(origin_id) BETWEEN 1 AND 180),
  companion_actor_id TEXT NOT NULL CHECK(length(companion_actor_id) BETWEEN 1 AND 180),
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
  UNIQUE(access_terms_id,recipient_role,origin_id,event_type,effective_expires_at),
  FOREIGN KEY(access_terms_id) REFERENCES portal_project_access_terms(id),
  CHECK(
    (status='pending' AND lease_token IS NULL AND lease_expires_at IS NULL AND delivered_at IS NULL AND suppressed_at IS NULL) OR
    (status='processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND delivered_at IS NULL AND suppressed_at IS NULL) OR
    (status='sent' AND lease_token IS NULL AND lease_expires_at IS NULL AND delivered_at IS NOT NULL AND suppressed_at IS NULL) OR
    (status='suppressed' AND lease_token IS NULL AND lease_expires_at IS NULL AND delivered_at IS NULL AND suppressed_at IS NOT NULL) OR
    (status='failed' AND lease_token IS NULL AND lease_expires_at IS NULL AND delivered_at IS NULL AND suppressed_at IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_portal_project_access_companion_notice_ready
  ON portal_project_access_companion_notice_outbox(status,next_attempt_at,lease_expires_at,created_at,id);
CREATE INDEX IF NOT EXISTS idx_portal_project_access_companion_notice_scope
  ON portal_project_access_companion_notice_outbox(workspace_id,project_public_id,recipient_role,created_at DESC);

CREATE TABLE IF NOT EXISTS portal_project_access_companion_notice_audit (
  id TEXT PRIMARY KEY CHECK(length(id)=64 AND id NOT GLOB '*[^a-f0-9]*'),
  outbox_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_public_id TEXT NOT NULL,
  recipient_role TEXT NOT NULL CHECK(recipient_role IN ('inviter','access_creator')),
  event_type TEXT NOT NULL CHECK(event_type IN ('warning_7d','warning_24h','expired')),
  action TEXT NOT NULL CHECK(action IN (
    'notice.staged','notice.sent','notice.suppressed',
    'notice.retry_scheduled','notice.failed'
  )),
  attempt_count INTEGER NOT NULL CHECK(attempt_count BETWEEN 0 AND 3),
  reason_code TEXT CHECK(reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  FOREIGN KEY(outbox_id) REFERENCES portal_project_access_companion_notice_outbox(id)
);
CREATE INDEX IF NOT EXISTS idx_portal_project_access_companion_notice_audit_scope
  ON portal_project_access_companion_notice_audit(workspace_id,project_public_id,created_at DESC,id DESC);

-- Normalized recipient addresses are represented only by SHA-256. The claim
-- keeps independently staged inviter/access-creator rows from sending the same
-- term/event/deadline mail twice while preserving each row's own terminal
-- delivery state and audit trail.
CREATE TABLE IF NOT EXISTS portal_project_access_companion_recipient_claims (
  id TEXT PRIMARY KEY CHECK(length(id)=64 AND id NOT GLOB '*[^a-f0-9]*'),
  access_terms_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('warning_7d','warning_24h','expired')),
  effective_expires_at TEXT NOT NULL CHECK(datetime(effective_expires_at) IS NOT NULL),
  recipient_email_hash TEXT NOT NULL CHECK(length(recipient_email_hash)=64 AND recipient_email_hash NOT GLOB '*[^a-f0-9]*'),
  winner_outbox_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  UNIQUE(access_terms_id,event_type,effective_expires_at,recipient_email_hash),
  FOREIGN KEY(access_terms_id) REFERENCES portal_project_access_terms(id),
  FOREIGN KEY(winner_outbox_id) REFERENCES portal_project_access_companion_notice_outbox(id)
);

-- A short-lived reservation is acquired while the final recipient authority
-- is reread. It is intentionally releasable when an unsent actor changes
-- address. The immutable claim above is created only immediately before the
-- SMTP hand-off, so an accepted-but-unacknowledged send remains deduplicated.
CREATE TABLE IF NOT EXISTS portal_project_access_companion_recipient_reservations (
  id TEXT PRIMARY KEY CHECK(length(id)=64 AND id NOT GLOB '*[^a-f0-9]*'),
  access_terms_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('warning_7d','warning_24h','expired')),
  effective_expires_at TEXT NOT NULL CHECK(datetime(effective_expires_at) IS NOT NULL),
  recipient_email_hash TEXT NOT NULL CHECK(length(recipient_email_hash)=64 AND recipient_email_hash NOT GLOB '*[^a-f0-9]*'),
  winner_outbox_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL CHECK(datetime(lease_expires_at) IS NOT NULL),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  updated_at TEXT NOT NULL DEFAULT(datetime('now')),
  UNIQUE(access_terms_id,event_type,effective_expires_at,recipient_email_hash),
  FOREIGN KEY(access_terms_id) REFERENCES portal_project_access_terms(id),
  FOREIGN KEY(winner_outbox_id) REFERENCES portal_project_access_companion_notice_outbox(id)
);
CREATE INDEX IF NOT EXISTS idx_portal_project_access_companion_recipient_reservation_lease
  ON portal_project_access_companion_recipient_reservations(lease_expires_at,id);
CREATE TRIGGER IF NOT EXISTS portal_project_access_companion_recipient_reservation_identity_guard
BEFORE UPDATE ON portal_project_access_companion_recipient_reservations
WHEN NEW.id<>OLD.id OR NEW.access_terms_id<>OLD.access_terms_id OR NEW.event_type<>OLD.event_type
  OR NEW.effective_expires_at<>OLD.effective_expires_at
  OR NEW.recipient_email_hash<>OLD.recipient_email_hash OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'project access companion recipient reservation identity is immutable'); END;

CREATE TRIGGER IF NOT EXISTS portal_project_access_companion_notice_identity_guard
BEFORE UPDATE ON portal_project_access_companion_notice_outbox
WHEN NEW.id<>OLD.id OR NEW.access_terms_id<>OLD.access_terms_id
  OR NEW.workspace_id<>OLD.workspace_id OR NEW.source_id<>OLD.source_id
  OR NEW.project_public_id<>OLD.project_public_id OR NEW.recipient_role<>OLD.recipient_role
  OR NEW.origin_id<>OLD.origin_id OR NEW.companion_actor_id<>OLD.companion_actor_id
  OR NEW.event_type<>OLD.event_type OR NEW.effective_expires_at<>OLD.effective_expires_at
  OR NEW.message_id_key<>OLD.message_id_key OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'project access companion notice identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS portal_project_access_companion_notice_terminal_guard
BEFORE UPDATE ON portal_project_access_companion_notice_outbox
WHEN OLD.status IN ('sent','suppressed','failed')
  OR NEW.attempt_count<OLD.attempt_count OR NEW.attempt_count>OLD.attempt_count+1
  OR (NEW.status='processing' AND (OLD.status NOT IN ('pending','processing') OR NEW.attempt_count<>OLD.attempt_count+1))
  OR (OLD.status='pending' AND NEW.status NOT IN ('pending','processing','suppressed'))
  OR (OLD.status='processing' AND NEW.status NOT IN ('pending','processing','sent','suppressed','failed'))
BEGIN SELECT RAISE(ABORT,'project access companion notice state transition is invalid'); END;
CREATE TRIGGER IF NOT EXISTS portal_project_access_companion_notice_no_delete
BEFORE DELETE ON portal_project_access_companion_notice_outbox
BEGIN SELECT RAISE(ABORT,'project access companion notice history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS portal_project_access_companion_notice_audit_no_update
BEFORE UPDATE ON portal_project_access_companion_notice_audit
BEGIN SELECT RAISE(ABORT,'project access companion notice audit is immutable'); END;
CREATE TRIGGER IF NOT EXISTS portal_project_access_companion_notice_audit_no_delete
BEFORE DELETE ON portal_project_access_companion_notice_audit
BEGIN SELECT RAISE(ABORT,'project access companion notice audit is immutable'); END;
CREATE TRIGGER IF NOT EXISTS portal_project_access_companion_recipient_claim_no_update
BEFORE UPDATE ON portal_project_access_companion_recipient_claims
BEGIN SELECT RAISE(ABORT,'project access companion recipient claim is immutable'); END;
CREATE TRIGGER IF NOT EXISTS portal_project_access_companion_recipient_claim_no_delete
BEFORE DELETE ON portal_project_access_companion_recipient_claims
BEGIN SELECT RAISE(ABORT,'project access companion recipient claim is immutable'); END;

-- Before acceptance an unlinked invitation can still be corrected. Once the
-- invitation has been accepted or attached to explicit project access terms,
-- inviter and accepted identity are durable provenance. The one legitimate
-- pending-to-accepted assignment is allowed; later UPDATE or REPLACE cannot
-- rewrite provenance. No delete guard interferes with workspace cascades.
CREATE TRIGGER IF NOT EXISTS portal_project_access_invitation_provenance_immutable
BEFORE UPDATE OF invited_by_identity_id,accepted_by_identity_id ON portal_v2_invitations
WHEN (
    NEW.invited_by_identity_id IS NOT OLD.invited_by_identity_id
    OR NEW.accepted_by_identity_id IS NOT OLD.accepted_by_identity_id
  ) AND (
    OLD.status='accepted' OR NEW.status='accepted'
    OR EXISTS(SELECT 1 FROM portal_v2_invitation_entitlements entitlement
      WHERE entitlement.invitation_id=OLD.id AND entitlement.access_terms_id IS NOT NULL)
  ) AND NOT (
    NEW.invited_by_identity_id IS OLD.invited_by_identity_id
    AND OLD.status='pending' AND NEW.status='accepted'
    AND OLD.accepted_by_identity_id IS NULL AND NEW.accepted_by_identity_id IS NOT NULL
  )
BEGIN SELECT RAISE(ABORT,'project access invitation provenance is immutable'); END;
CREATE TRIGGER IF NOT EXISTS portal_project_access_invitation_provenance_replace
BEFORE INSERT ON portal_v2_invitations
WHEN EXISTS(SELECT 1 FROM portal_v2_invitations existing
  WHERE existing.id=NEW.id AND (
    existing.status='accepted'
    OR EXISTS(SELECT 1 FROM portal_v2_invitation_entitlements entitlement
      WHERE entitlement.invitation_id=existing.id AND entitlement.access_terms_id IS NOT NULL)
  ))
BEGIN SELECT RAISE(ABORT,'project access invitation provenance cannot be replaced'); END;

-- These older event ledgers were append-only by contract but lacked database
-- guards. Existing writers only insert, so the guards are upgrade-compatible.
CREATE TRIGGER IF NOT EXISTS portal_v2_membership_audit_no_update
BEFORE UPDATE ON portal_v2_membership_audit
BEGIN SELECT RAISE(ABORT,'portal membership audit is immutable'); END;
CREATE TRIGGER IF NOT EXISTS client_delegated_share_events_no_update
BEFORE UPDATE ON client_delegated_share_events
BEGIN SELECT RAISE(ABORT,'delegated share event is immutable'); END;
