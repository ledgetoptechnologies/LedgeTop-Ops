PRAGMA foreign_keys = ON;

-- Collection begins when this migration is applied. Existing access-term,
-- invitation and grant rows are intentionally not guessed into history.
CREATE TABLE portal_project_access_authority_history_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  collection_started_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK(julianday(collection_started_at) IS NOT NULL)
);
INSERT INTO portal_project_access_authority_history_state(singleton) VALUES(1);

-- Exact, source-qualified project-access lifecycle events. Actor and subject
-- identifiers stay internal; staff timelines expose only their generic type.
CREATE TABLE portal_project_access_authority_events (
  recorded_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  project_public_id TEXT NOT NULL,
  access_terms_id TEXT NOT NULL,
  authority_type TEXT NOT NULL CHECK(authority_type IN (
    'invitation_request','invitation','authenticated_delivery_grant'
  )),
  authority_id TEXT NOT NULL,
  producer_event_key TEXT NOT NULL UNIQUE CHECK(length(producer_event_key) BETWEEN 16 AND 255),
  event_kind TEXT NOT NULL CHECK(event_kind IN (
    'request_submitted','invitation_created','invitation_approved',
    'invitation_accepted','invitation_revoked','grant_created',
    'grant_restored','grant_revoked','access_expired'
  )),
  actor_type TEXT NOT NULL CHECK(actor_type IN ('staff','identity','system')),
  actor_id TEXT,
  subject_identity_id TEXT,
  occurred_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK(julianday(occurred_at) IS NOT NULL),
  FOREIGN KEY(access_terms_id) REFERENCES portal_project_access_terms(id),
  CHECK((actor_type='system' AND actor_id IS NULL) OR (actor_type<>'system' AND actor_id IS NOT NULL)),
  CHECK((authority_type='invitation_request' AND event_kind='request_submitted')
    OR (authority_type='invitation' AND event_kind IN (
      'invitation_created','invitation_approved','invitation_accepted','invitation_revoked','access_expired'
    ))
    OR (authority_type='authenticated_delivery_grant' AND event_kind IN (
      'grant_created','grant_restored','grant_revoked','access_expired'
    )))
);
CREATE INDEX idx_portal_project_access_authority_scope
  ON portal_project_access_authority_events(workspace_id,source_id,project_public_id,occurred_at DESC,recorded_sequence ASC);
CREATE INDEX idx_portal_project_access_authority_terms
  ON portal_project_access_authority_events(access_terms_id,occurred_at DESC,recorded_sequence ASC);

CREATE TRIGGER portal_project_access_authority_replay_guard
BEFORE INSERT ON portal_project_access_authority_events
WHEN EXISTS(SELECT 1 FROM portal_project_access_authority_events old WHERE old.producer_event_key=NEW.producer_event_key
  AND (old.workspace_id<>NEW.workspace_id OR old.source_id<>NEW.source_id OR old.project_public_id<>NEW.project_public_id
    OR old.access_terms_id<>NEW.access_terms_id OR old.authority_type<>NEW.authority_type OR old.authority_id<>NEW.authority_id
    OR old.event_kind<>NEW.event_kind OR old.actor_type<>NEW.actor_type OR old.actor_id IS NOT NEW.actor_id
    OR old.subject_identity_id IS NOT NEW.subject_identity_id
    OR (NEW.event_kind='access_expired' AND old.occurred_at<>NEW.occurred_at)))
BEGIN SELECT RAISE(ABORT,'project access authority replay conflicts with recorded event'); END;

CREATE TRIGGER portal_project_access_authority_insert_guard
BEFORE INSERT ON portal_project_access_authority_events
WHEN NOT EXISTS(
  SELECT 1 FROM portal_project_access_terms terms
  WHERE terms.id=NEW.access_terms_id AND terms.workspace_id=NEW.workspace_id
    AND terms.source_id=NEW.source_id AND terms.project_public_id=NEW.project_public_id
) OR NOT EXISTS(
  SELECT 1 FROM portal_project_access_authority_history_state state
  WHERE state.singleton=1 AND julianday(NEW.occurred_at)>=julianday(state.collection_started_at)
) OR (
  NEW.authority_type='invitation_request' AND NOT EXISTS(
    SELECT 1 FROM portal_workspace_invitation_requests request
    WHERE request.id=NEW.authority_id AND request.workspace_id=NEW.workspace_id
      AND request.source_id=NEW.source_id AND request.scope_type='project'
      AND request.scope_public_id=NEW.project_public_id AND request.access_terms_id=NEW.access_terms_id
  )
) OR (
  NEW.authority_type='invitation' AND NOT EXISTS(
    SELECT 1 FROM portal_v2_invitations invitation
    JOIN portal_v2_invitation_entitlements entitlement ON entitlement.invitation_id=invitation.id
      AND entitlement.access_terms_id=NEW.access_terms_id
    WHERE invitation.id=NEW.authority_id AND invitation.workspace_id=NEW.workspace_id
  )
) OR (
  NEW.authority_type='authenticated_delivery_grant' AND NOT EXISTS(
    SELECT 1 FROM portal_v2_authenticated_delivery_grants grant_record
    JOIN portal_v2_folder_bindings binding ON binding.id=grant_record.folder_binding_id
      AND binding.workspace_id=grant_record.workspace_id AND binding.owner_scope_type='project'
    WHERE grant_record.id=NEW.authority_id AND grant_record.workspace_id=NEW.workspace_id
      AND grant_record.access_terms_id=NEW.access_terms_id AND binding.owner_public_id=NEW.project_public_id
  )
) OR (
  NEW.subject_identity_id IS NOT NULL AND NEW.authority_type='invitation'
  AND NOT EXISTS(SELECT 1 FROM portal_v2_invitations invitation
    WHERE invitation.id=NEW.authority_id AND invitation.workspace_id=NEW.workspace_id
      AND invitation.accepted_by_identity_id=NEW.subject_identity_id)
) OR (
  NEW.subject_identity_id IS NOT NULL AND NEW.authority_type='authenticated_delivery_grant'
  AND NOT EXISTS(SELECT 1 FROM portal_v2_authenticated_delivery_grant_recipients recipient
    WHERE recipient.grant_id=NEW.authority_id AND recipient.workspace_id=NEW.workspace_id
      AND recipient.identity_id=NEW.subject_identity_id)
) OR (
  NEW.event_kind='invitation_revoked' AND NOT EXISTS(
    SELECT 1 FROM portal_v2_invitations invitation WHERE invitation.id=NEW.authority_id
      AND invitation.workspace_id=NEW.workspace_id AND invitation.status='revoked' AND invitation.revoked_at IS NOT NULL)
) OR (
  NEW.event_kind='access_expired' AND NOT EXISTS(
    SELECT 1 FROM portal_project_access_terms terms
    LEFT JOIN portal_project_access_deadlines deadline ON deadline.access_terms_id=terms.id
    WHERE terms.id=NEW.access_terms_id
      AND EXISTS(SELECT 1 FROM portal_project_access_authority_history_state state
        WHERE state.singleton=1 AND julianday(NEW.occurred_at)>=julianday(state.collection_started_at))
      AND ((NEW.authority_type='invitation' AND EXISTS(
        SELECT 1 FROM portal_v2_invitations invitation
        WHERE invitation.id=NEW.authority_id AND invitation.workspace_id=NEW.workspace_id
          AND julianday(CASE WHEN terms.mode='specific_date' THEN terms.expires_at ELSE deadline.deadline_at END)=julianday(NEW.occurred_at)
          AND julianday(invitation.created_at)<=julianday(NEW.occurred_at)
          AND invitation.accepted_by_identity_id IS NOT NULL AND julianday(invitation.accepted_at)<=julianday(NEW.occurred_at)
          AND (invitation.status='accepted'
            OR (invitation.status='revoked' AND julianday(invitation.revoked_at)>julianday(NEW.occurred_at)))))
      OR (NEW.authority_type='authenticated_delivery_grant' AND EXISTS(
        SELECT 1 FROM portal_v2_authenticated_delivery_grants grant_record
        WHERE grant_record.id=NEW.authority_id AND grant_record.workspace_id=NEW.workspace_id
          AND julianday(CASE
            WHEN (CASE WHEN terms.mode='specific_date' THEN terms.expires_at ELSE deadline.deadline_at END) IS NULL THEN grant_record.expires_at
            WHEN grant_record.expires_at IS NULL THEN (CASE WHEN terms.mode='specific_date' THEN terms.expires_at ELSE deadline.deadline_at END)
            WHEN julianday(grant_record.expires_at)<julianday(CASE WHEN terms.mode='specific_date' THEN terms.expires_at ELSE deadline.deadline_at END) THEN grant_record.expires_at
            ELSE (CASE WHEN terms.mode='specific_date' THEN terms.expires_at ELSE deadline.deadline_at END) END)=julianday(NEW.occurred_at)
          AND julianday(grant_record.created_at)<=julianday(NEW.occurred_at)
          AND (grant_record.status IN('active','expired')
            OR (grant_record.status='revoked' AND julianday(grant_record.revoked_at)>julianday(NEW.occurred_at))))))
  )
)
BEGIN SELECT RAISE(ABORT,'project access authority event requires exact current coordinates'); END;

CREATE TRIGGER portal_project_access_authority_state_no_update
BEFORE UPDATE ON portal_project_access_authority_history_state
BEGIN SELECT RAISE(ABORT,'project access authority coverage state is immutable'); END;
CREATE TRIGGER portal_project_access_authority_state_no_delete
BEFORE DELETE ON portal_project_access_authority_history_state
BEGIN SELECT RAISE(ABORT,'project access authority coverage state is immutable'); END;

CREATE TRIGGER portal_project_access_authority_no_update
BEFORE UPDATE ON portal_project_access_authority_events
BEGIN SELECT RAISE(ABORT,'project access authority history is immutable'); END;
CREATE TRIGGER portal_project_access_authority_no_delete
BEFORE DELETE ON portal_project_access_authority_events
BEGIN SELECT RAISE(ABORT,'project access authority history is immutable'); END;
CREATE TRIGGER portal_project_access_authority_no_replace
BEFORE INSERT ON portal_project_access_authority_events
WHEN EXISTS(SELECT 1 FROM portal_project_access_authority_events WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'project access authority history cannot be replaced'); END;
