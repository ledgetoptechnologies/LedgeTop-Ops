PRAGMA foreign_keys = ON;

-- Secondary Project Alpha sources deliberately have no legacy client account.
-- Keep their feedback additive and source-qualified instead of manufacturing a
-- legacy account or weakening the primary feedback foreign-key contract.
CREATE TABLE portal_native_feedback (
  id TEXT PRIMARY KEY CHECK (id GLOB 'native_*'),
  source_id TEXT NOT NULL CHECK (source_id GLOB 'project-alpha:*'),
  workspace_id TEXT NOT NULL REFERENCES portal_v2_workspaces(id),
  creator_identity_id TEXT NOT NULL REFERENCES portal_v2_identities(id),
  principal_issuer TEXT NOT NULL CHECK (length(principal_issuer) BETWEEN 1 AND 512),
  principal_subject TEXT NOT NULL CHECK (length(principal_subject) BETWEEN 1 AND 512),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('project','folder','file')),
  owner_scope_type TEXT NOT NULL CHECK (owner_scope_type IN ('organization','department','client','project')),
  owner_public_id TEXT NOT NULL,
  project_public_id TEXT,
  target_json TEXT NOT NULL CHECK (json_valid(target_json) AND json_type(target_json)='object'),
  target_fingerprint TEXT NOT NULL CHECK (length(target_fingerprint)=64),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 5000),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','done')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 3),
  completion_note TEXT CHECK (completion_note IS NULL OR length(completion_note) BETWEEN 1 AND 2000),
  completed_at TEXT,
  completed_by_staff_id TEXT,
  mutation_key TEXT NOT NULL CHECK (length(mutation_key) BETWEEN 16 AND 128),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint)=64),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (source_id,workspace_id,principal_issuer,principal_subject,mutation_key),
  CHECK ((owner_scope_type='project' AND project_public_id=owner_public_id)
    OR (owner_scope_type<>'project' AND project_public_id IS NULL)),
  CHECK ((status='done' AND completed_at IS NOT NULL AND completed_by_staff_id IS NOT NULL)
    OR (status<>'done' AND completion_note IS NULL AND completed_at IS NULL AND completed_by_staff_id IS NULL))
);
CREATE INDEX idx_portal_native_feedback_author ON portal_native_feedback(
  source_id,workspace_id,principal_issuer,principal_subject,created_at DESC,id DESC);
CREATE INDEX idx_portal_native_feedback_status ON portal_native_feedback(status,created_at,id);
CREATE INDEX idx_portal_native_feedback_project ON portal_native_feedback(source_id,project_public_id,status,created_at,id);
CREATE INDEX idx_portal_native_feedback_owner ON portal_native_feedback(
  source_id,owner_scope_type,owner_public_id,status,created_at,id);

CREATE TRIGGER portal_native_feedback_immutable
BEFORE UPDATE ON portal_native_feedback
WHEN NEW.id IS NOT OLD.id OR NEW.source_id IS NOT OLD.source_id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.creator_identity_id IS NOT OLD.creator_identity_id OR NEW.principal_issuer IS NOT OLD.principal_issuer
  OR NEW.principal_subject IS NOT OLD.principal_subject OR NEW.target_kind IS NOT OLD.target_kind
  OR NEW.owner_scope_type IS NOT OLD.owner_scope_type OR NEW.owner_public_id IS NOT OLD.owner_public_id
  OR NEW.project_public_id IS NOT OLD.project_public_id OR NEW.target_json IS NOT OLD.target_json
  OR NEW.target_fingerprint IS NOT OLD.target_fingerprint OR NEW.message IS NOT OLD.message
  OR NEW.mutation_key IS NOT OLD.mutation_key OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT,'native feedback identity and submission are immutable');
END;
CREATE TRIGGER portal_native_feedback_monotonic
BEFORE UPDATE ON portal_native_feedback
WHEN NEW.revision<>OLD.revision+1 OR NOT (
  (OLD.status='new' AND NEW.status IN ('in_progress','done')) OR
  (OLD.status='in_progress' AND NEW.status='done'))
BEGIN
  SELECT RAISE(ABORT,'native feedback lifecycle transition is invalid');
END;

CREATE TABLE portal_native_feedback_events (
  id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL REFERENCES portal_native_feedback(id),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 3),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('client','staff')),
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('new','in_progress','done')),
  note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (feedback_id,revision)
);
CREATE TRIGGER portal_native_feedback_event_no_update BEFORE UPDATE ON portal_native_feedback_events
BEGIN SELECT RAISE(ABORT,'native feedback events are immutable'); END;
CREATE TRIGGER portal_native_feedback_event_no_delete BEFORE DELETE ON portal_native_feedback_events
BEGIN SELECT RAISE(ABORT,'native feedback events are immutable'); END;

CREATE TABLE portal_native_feedback_mutations (
  actor_staff_id TEXT NOT NULL,
  mutation_key TEXT NOT NULL CHECK (length(mutation_key) BETWEEN 16 AND 128),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint)=64),
  feedback_id TEXT NOT NULL REFERENCES portal_native_feedback(id),
  result_revision INTEGER NOT NULL CHECK (result_revision BETWEEN 2 AND 3),
  result_status TEXT NOT NULL CHECK (result_status IN ('in_progress','done')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (actor_staff_id,mutation_key)
);
CREATE TRIGGER portal_native_feedback_mutation_result BEFORE INSERT ON portal_native_feedback_mutations
WHEN NOT EXISTS (SELECT 1 FROM portal_native_feedback WHERE id=NEW.feedback_id
  AND revision=NEW.result_revision AND status=NEW.result_status)
BEGIN SELECT RAISE(ABORT,'native feedback mutation requires an applied transition'); END;
