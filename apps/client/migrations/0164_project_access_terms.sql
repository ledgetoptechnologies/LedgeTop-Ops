PRAGMA foreign_keys=ON;

-- Explicit new delegations only. NULL on existing grants means unclassified;
-- no email, membership source, or historical row is reclassified.
CREATE TABLE portal_project_access_terms (
 id TEXT PRIMARY KEY NOT NULL,
 workspace_id TEXT NOT NULL,
 source_id TEXT NOT NULL,
 project_public_id TEXT NOT NULL CHECK(length(project_public_id) BETWEEN 1 AND 128),
 kind TEXT NOT NULL CHECK(kind IN ('customer','collaborator')),
 mode TEXT NOT NULL CHECK(mode IN ('specific_date','project_end','until_revoked')),
 expires_at TEXT,
 created_by_actor_type TEXT NOT NULL CHECK(created_by_actor_type IN ('staff','identity')),
 created_by_actor_id TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 CHECK(kind<>'customer' OR (mode='until_revoked' AND created_by_actor_type='staff')),
 CHECK((mode='specific_date' AND expires_at IS NOT NULL AND datetime(expires_at) IS NOT NULL)
   OR (mode<>'specific_date' AND expires_at IS NULL)),
 FOREIGN KEY(workspace_id,source_id) REFERENCES pa_portal_workspace_sources(workspace_id,projection_source_id)
);
CREATE INDEX idx_portal_project_access_terms_project ON portal_project_access_terms(workspace_id,project_public_id,mode);
CREATE INDEX idx_portal_project_lifecycle_receipt ON pa_portal_projection_receipts(workspace_id,projection_source_id,source_sequence)
 WHERE status='completed' AND delivery_kind IN ('snapshot_activate','event');

-- An authoritative lifecycle is a published v3 directory, never an inactive
-- staging row or a receipt for a different producer/sequence.
CREATE VIEW portal_project_access_current_lifecycle AS
 SELECT w.id workspace_id,w.project_alpha_source_id source_id,l.project_public_id,
   g.id generation_id,g.source_sequence,l.lifecycle_status,l.completed_at,l.source_version
 FROM portal_v2_workspaces w
 JOIN pa_portal_workspace_sources owner ON owner.workspace_id=w.id AND owner.projection_source_id=w.project_alpha_source_id
 JOIN portal_v2_directory_checkpoints cp ON cp.workspace_id=w.id
 JOIN portal_v2_directory_generations g ON g.id=cp.active_generation_id AND g.workspace_id=w.id
   AND g.status='active' AND g.complete=1 AND g.source_sequence=cp.source_sequence
 JOIN portal_v2_directory_generation_contracts contract ON contract.workspace_id=w.id AND contract.generation_id=g.id AND contract.schema_version=3
 JOIN portal_v2_project_lifecycle l ON l.workspace_id=w.id AND l.generation_id=g.id
 JOIN portal_v2_directory_entities project ON project.workspace_id=w.id AND project.generation_id=g.id
   AND project.entity_type='project' AND project.public_id=l.project_public_id AND project.active=1
 WHERE EXISTS(SELECT 1 FROM pa_portal_projection_receipts receipt WHERE receipt.workspace_id=w.id
   AND receipt.projection_source_id=w.project_alpha_source_id AND receipt.source_sequence=g.source_sequence
   AND receipt.status='completed' AND receipt.delivery_kind IN ('snapshot_activate','event'));

CREATE TABLE portal_project_access_deadlines (
 access_terms_id TEXT PRIMARY KEY NOT NULL REFERENCES portal_project_access_terms(id),
 completed_at TEXT NOT NULL CHECK(datetime(completed_at) IS NOT NULL),
 deadline_at TEXT NOT NULL CHECK(datetime(deadline_at) IS NOT NULL AND datetime(deadline_at)=datetime(completed_at,'+7 days')),
 source_version TEXT NOT NULL,
 generation_id TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER portal_project_access_terms_insert BEFORE INSERT ON portal_project_access_terms
WHEN EXISTS(SELECT 1 FROM portal_project_access_terms WHERE id=NEW.id)
 OR NOT EXISTS(SELECT 1 FROM portal_v2_workspaces w JOIN portal_v2_directory_checkpoints cp ON cp.workspace_id=w.id
   JOIN portal_v2_directory_generations g ON g.id=cp.active_generation_id AND g.workspace_id=w.id AND g.status='active' AND g.complete=1
   JOIN portal_v2_directory_entities p ON p.workspace_id=w.id AND p.generation_id=g.id AND p.entity_type='project' AND p.active=1
   WHERE w.id=NEW.workspace_id AND w.project_alpha_source_id=NEW.source_id AND w.status='active' AND p.public_id=NEW.project_public_id)
 OR (NEW.mode='specific_date' AND datetime(NEW.expires_at)<=datetime('now'))
 OR (NEW.mode='project_end' AND NOT EXISTS(SELECT 1 FROM portal_project_access_current_lifecycle l
   WHERE l.workspace_id=NEW.workspace_id AND l.source_id=NEW.source_id AND l.project_public_id=NEW.project_public_id
   AND (l.lifecycle_status='active' OR datetime(l.completed_at,'+7 days')>datetime('now'))))
BEGIN SELECT RAISE(ABORT,'portal project access terms unavailable or immutable'); END;
CREATE TRIGGER portal_project_access_terms_update BEFORE UPDATE ON portal_project_access_terms
BEGIN SELECT RAISE(ABORT,'portal project access terms are immutable'); END;
CREATE TRIGGER portal_project_access_terms_delete BEFORE DELETE ON portal_project_access_terms
BEGIN SELECT RAISE(ABORT,'portal project access terms are immutable'); END;

CREATE TRIGGER portal_project_access_deadlines_insert BEFORE INSERT ON portal_project_access_deadlines
WHEN EXISTS(SELECT 1 FROM portal_project_access_deadlines WHERE access_terms_id=NEW.access_terms_id)
 OR NOT EXISTS(SELECT 1 FROM portal_project_access_terms t JOIN portal_project_access_current_lifecycle l
   ON l.workspace_id=t.workspace_id AND l.source_id=t.source_id AND l.project_public_id=t.project_public_id
   WHERE t.id=NEW.access_terms_id AND t.mode='project_end' AND l.lifecycle_status='completed'
   AND NEW.completed_at=l.completed_at AND NEW.source_version=l.source_version AND NEW.generation_id=l.generation_id)
BEGIN SELECT RAISE(ABORT,'portal project completion deadline requires current signed lifecycle'); END;
CREATE TRIGGER portal_project_access_deadlines_update BEFORE UPDATE ON portal_project_access_deadlines
BEGIN SELECT RAISE(ABORT,'portal project completion deadline is immutable'); END;
CREATE TRIGGER portal_project_access_deadlines_delete BEFORE DELETE ON portal_project_access_deadlines
BEGIN SELECT RAISE(ABORT,'portal project completion deadline is immutable'); END;

ALTER TABLE portal_v2_entitlements ADD COLUMN access_terms_id TEXT REFERENCES portal_project_access_terms(id);
ALTER TABLE portal_v2_invitation_entitlements ADD COLUMN access_terms_id TEXT REFERENCES portal_project_access_terms(id);
ALTER TABLE portal_v2_authenticated_delivery_grants ADD COLUMN access_terms_id TEXT REFERENCES portal_project_access_terms(id);
CREATE INDEX idx_portal_entitlement_access_terms ON portal_v2_entitlements(access_terms_id) WHERE access_terms_id IS NOT NULL;
CREATE INDEX idx_portal_delivery_access_terms ON portal_v2_authenticated_delivery_grants(access_terms_id) WHERE access_terms_id IS NOT NULL;
CREATE TABLE portal_project_invitation_fences (
 id TEXT PRIMARY KEY NOT NULL,
 write_guard INTEGER NOT NULL CONSTRAINT portal_project_invitation_write_guard CHECK(write_guard=1)
);
CREATE TABLE portal_project_access_write_fences (
 id TEXT PRIMARY KEY NOT NULL,
 write_guard INTEGER NOT NULL CONSTRAINT portal_project_access_write_guard CHECK(write_guard=1)
);

CREATE TABLE portal_workspace_invitation_policies (
 workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES portal_v2_workspaces(id),
 policy TEXT NOT NULL CHECK(policy IN ('allowed','disabled','require_approval')),
 version INTEGER NOT NULL CHECK(version>=1),
 updated_by_staff_id TEXT NOT NULL,
 updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER portal_workspace_invitation_policy_insert BEFORE INSERT ON portal_workspace_invitation_policies
WHEN NEW.version<>1 OR EXISTS(SELECT 1 FROM portal_workspace_invitation_policies WHERE workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT,'portal invitation policy requires explicit version'); END;
CREATE TRIGGER portal_workspace_invitation_policy_update BEFORE UPDATE ON portal_workspace_invitation_policies
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'portal invitation policy requires next version'); END;
CREATE TRIGGER portal_workspace_invitation_policy_delete BEFORE DELETE ON portal_workspace_invitation_policies
BEGIN SELECT RAISE(ABORT,'portal invitation policy cannot be deleted'); END;
CREATE TRIGGER portal_invitation_policy_issue BEFORE INSERT ON portal_v2_invitations
WHEN EXISTS(SELECT 1 FROM portal_workspace_invitation_policies p WHERE p.workspace_id=NEW.workspace_id AND p.policy<>'allowed')
BEGIN SELECT RAISE(ABORT,'portal invitation policy blocks issuance'); END;
CREATE TRIGGER portal_invitation_policy_accept BEFORE UPDATE OF status ON portal_v2_invitations
WHEN NEW.status='accepted' AND OLD.status<>'accepted' AND (
 EXISTS(SELECT 1 FROM portal_workspace_invitation_policies p WHERE p.workspace_id=NEW.workspace_id AND p.policy<>'allowed')
 OR EXISTS(SELECT 1 FROM portal_v2_invitation_entitlements e JOIN portal_project_access_terms t ON t.id=e.access_terms_id
 LEFT JOIN portal_project_access_deadlines d ON d.access_terms_id=t.id WHERE e.invitation_id=NEW.id AND (
   (t.mode='specific_date' AND datetime(t.expires_at)<=datetime('now')) OR (t.mode='project_end' AND NOT (
     (d.access_terms_id IS NOT NULL AND datetime(d.deadline_at)>datetime('now')) OR
     (d.access_terms_id IS NULL AND EXISTS(SELECT 1 FROM portal_project_access_current_lifecycle l WHERE l.workspace_id=t.workspace_id
       AND l.source_id=t.source_id AND l.project_public_id=t.project_public_id AND l.lifecycle_status='active')))))))
BEGIN SELECT RAISE(ABORT,'portal invitation policy or access terms block acceptance'); END;

CREATE TRIGGER portal_project_terms_latch AFTER INSERT ON portal_project_access_terms BEGIN INSERT INTO portal_project_access_deadlines(access_terms_id,completed_at,deadline_at,source_version,generation_id)
 SELECT t.id,l.completed_at,strftime('%Y-%m-%dT%H:%M:%fZ',l.completed_at,'+7 days'),l.source_version,l.generation_id
 FROM portal_project_access_terms t JOIN portal_project_access_current_lifecycle l
 ON l.workspace_id=t.workspace_id AND l.source_id=t.source_id AND l.project_public_id=t.project_public_id
 WHERE t.mode='project_end' AND l.lifecycle_status='completed'
 AND NOT EXISTS(SELECT 1 FROM portal_project_access_deadlines d WHERE d.access_terms_id=t.id) AND t.id=NEW.id; END;
CREATE TRIGGER portal_project_terms_checkpoint_insert_latch AFTER INSERT ON portal_v2_directory_checkpoints BEGIN INSERT INTO portal_project_access_deadlines(access_terms_id,completed_at,deadline_at,source_version,generation_id)
 SELECT t.id,l.completed_at,strftime('%Y-%m-%dT%H:%M:%fZ',l.completed_at,'+7 days'),l.source_version,l.generation_id
 FROM portal_project_access_terms t JOIN portal_project_access_current_lifecycle l
 ON l.workspace_id=t.workspace_id AND l.source_id=t.source_id AND l.project_public_id=t.project_public_id
 WHERE t.mode='project_end' AND l.lifecycle_status='completed'
 AND NOT EXISTS(SELECT 1 FROM portal_project_access_deadlines d WHERE d.access_terms_id=t.id) AND l.workspace_id=NEW.workspace_id; END;
CREATE TRIGGER portal_project_terms_checkpoint_update_latch AFTER UPDATE OF active_generation_id,source_sequence ON portal_v2_directory_checkpoints BEGIN INSERT INTO portal_project_access_deadlines(access_terms_id,completed_at,deadline_at,source_version,generation_id)
 SELECT t.id,l.completed_at,strftime('%Y-%m-%dT%H:%M:%fZ',l.completed_at,'+7 days'),l.source_version,l.generation_id
 FROM portal_project_access_terms t JOIN portal_project_access_current_lifecycle l
 ON l.workspace_id=t.workspace_id AND l.source_id=t.source_id AND l.project_public_id=t.project_public_id
 WHERE t.mode='project_end' AND l.lifecycle_status='completed'
 AND NOT EXISTS(SELECT 1 FROM portal_project_access_deadlines d WHERE d.access_terms_id=t.id) AND l.workspace_id=NEW.workspace_id; END;
CREATE TRIGGER portal_project_terms_lifecycle_insert_latch AFTER INSERT ON portal_v2_project_lifecycle BEGIN INSERT INTO portal_project_access_deadlines(access_terms_id,completed_at,deadline_at,source_version,generation_id)
 SELECT t.id,l.completed_at,strftime('%Y-%m-%dT%H:%M:%fZ',l.completed_at,'+7 days'),l.source_version,l.generation_id
 FROM portal_project_access_terms t JOIN portal_project_access_current_lifecycle l
 ON l.workspace_id=t.workspace_id AND l.source_id=t.source_id AND l.project_public_id=t.project_public_id
 WHERE t.mode='project_end' AND l.lifecycle_status='completed'
 AND NOT EXISTS(SELECT 1 FROM portal_project_access_deadlines d WHERE d.access_terms_id=t.id) AND l.workspace_id=NEW.workspace_id AND l.generation_id=NEW.generation_id AND l.project_public_id=NEW.project_public_id; END;
CREATE TRIGGER portal_project_terms_lifecycle_update_latch AFTER UPDATE OF lifecycle_status,completed_at,source_version ON portal_v2_project_lifecycle BEGIN INSERT INTO portal_project_access_deadlines(access_terms_id,completed_at,deadline_at,source_version,generation_id)
 SELECT t.id,l.completed_at,strftime('%Y-%m-%dT%H:%M:%fZ',l.completed_at,'+7 days'),l.source_version,l.generation_id
 FROM portal_project_access_terms t JOIN portal_project_access_current_lifecycle l
 ON l.workspace_id=t.workspace_id AND l.source_id=t.source_id AND l.project_public_id=t.project_public_id
 WHERE t.mode='project_end' AND l.lifecycle_status='completed'
 AND NOT EXISTS(SELECT 1 FROM portal_project_access_deadlines d WHERE d.access_terms_id=t.id) AND l.workspace_id=NEW.workspace_id AND l.generation_id=NEW.generation_id AND l.project_public_id=NEW.project_public_id; END;
CREATE TRIGGER portal_v2_entitlements_terms_insert BEFORE INSERT ON portal_v2_entitlements
 WHEN (NEW.access_terms_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM portal_project_access_terms t WHERE t.id=NEW.access_terms_id AND t.workspace_id=NEW.workspace_id
 AND NEW.effect='allow' AND ((NEW.scope_type='project' AND NEW.scope_public_id=t.project_public_id)
 OR (NEW.capability='workspace.view' AND NEW.scope_type='workspace' AND NEW.scope_public_id=t.workspace_id))))
 OR EXISTS(SELECT 1 FROM portal_v2_entitlements old WHERE old.id=NEW.id AND old.access_terms_id IS NOT NEW.access_terms_id)
 BEGIN SELECT RAISE(ABORT,'portal access terms ownership is immutable'); END;
CREATE TRIGGER portal_v2_entitlements_terms_update BEFORE UPDATE ON portal_v2_entitlements
 WHEN NEW.access_terms_id IS NOT OLD.access_terms_id OR (OLD.access_terms_id IS NOT NULL AND
 (NEW.id IS NOT OLD.id OR NEW.identity_id IS NOT OLD.identity_id OR NEW.workspace_id IS NOT OLD.workspace_id
 OR NEW.capability IS NOT OLD.capability OR NEW.effect IS NOT OLD.effect OR NEW.scope_type IS NOT OLD.scope_type
 OR NEW.scope_public_id IS NOT OLD.scope_public_id OR NEW.source_type IS NOT OLD.source_type OR NEW.expires_at IS NOT OLD.expires_at))
 OR (NEW.access_terms_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM portal_project_access_terms t WHERE t.id=NEW.access_terms_id AND t.workspace_id=NEW.workspace_id
 AND NEW.effect='allow' AND ((NEW.scope_type='project' AND NEW.scope_public_id=t.project_public_id)
 OR (NEW.capability='workspace.view' AND NEW.scope_type='workspace' AND NEW.scope_public_id=t.workspace_id))))
 BEGIN SELECT RAISE(ABORT,'portal access terms ownership is immutable'); END;
CREATE TRIGGER portal_entitlement_terms_replace BEFORE INSERT ON portal_v2_entitlements
WHEN EXISTS(SELECT 1 FROM portal_v2_entitlements old WHERE old.id=NEW.id AND old.access_terms_id IS NOT NULL AND
 (NEW.identity_id IS NOT old.identity_id OR NEW.workspace_id IS NOT old.workspace_id OR NEW.capability IS NOT old.capability
 OR NEW.effect IS NOT old.effect OR NEW.scope_type IS NOT old.scope_type OR NEW.scope_public_id IS NOT old.scope_public_id
 OR NEW.source_type IS NOT old.source_type OR NEW.expires_at IS NOT old.expires_at))
BEGIN SELECT RAISE(ABORT,'portal access terms ownership is immutable'); END;
CREATE TRIGGER portal_v2_authenticated_delivery_grants_terms_insert BEFORE INSERT ON portal_v2_authenticated_delivery_grants
 WHEN (NEW.access_terms_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM portal_project_access_terms t JOIN portal_v2_folder_bindings b ON b.workspace_id=t.workspace_id
 WHERE t.id=NEW.access_terms_id AND t.workspace_id=NEW.workspace_id AND b.id=NEW.folder_binding_id
 AND b.owner_scope_type='project' AND b.owner_public_id=t.project_public_id))
 OR EXISTS(SELECT 1 FROM portal_v2_authenticated_delivery_grants old WHERE old.id=NEW.id AND old.access_terms_id IS NOT NEW.access_terms_id)
 BEGIN SELECT RAISE(ABORT,'portal access terms ownership is immutable'); END;
CREATE TRIGGER portal_v2_authenticated_delivery_grants_terms_update BEFORE UPDATE ON portal_v2_authenticated_delivery_grants
 WHEN NEW.access_terms_id IS NOT OLD.access_terms_id OR (NEW.access_terms_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM portal_project_access_terms t JOIN portal_v2_folder_bindings b ON b.workspace_id=t.workspace_id
 WHERE t.id=NEW.access_terms_id AND t.workspace_id=NEW.workspace_id AND b.id=NEW.folder_binding_id
 AND b.owner_scope_type='project' AND b.owner_public_id=t.project_public_id))
 BEGIN SELECT RAISE(ABORT,'portal access terms ownership is immutable'); END;
CREATE TRIGGER portal_v2_invitation_entitlements_terms_insert BEFORE INSERT ON portal_v2_invitation_entitlements
 WHEN (NEW.access_terms_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM portal_project_access_terms t JOIN portal_v2_invitations i ON i.workspace_id=t.workspace_id
 WHERE t.id=NEW.access_terms_id AND i.id=NEW.invitation_id AND t.kind='collaborator'
 AND ((NEW.scope_type='project' AND NEW.scope_public_id=t.project_public_id)
 OR (NEW.capability='workspace.view' AND NEW.scope_type='workspace' AND NEW.scope_public_id=t.workspace_id))))
 OR EXISTS(SELECT 1 FROM portal_v2_invitation_entitlements old WHERE old.invitation_id=NEW.invitation_id AND old.capability=NEW.capability AND old.scope_type=NEW.scope_type AND old.scope_public_id=NEW.scope_public_id AND old.access_terms_id IS NOT NEW.access_terms_id)
 BEGIN SELECT RAISE(ABORT,'portal access terms ownership is immutable'); END;
CREATE TRIGGER portal_v2_invitation_entitlements_terms_update BEFORE UPDATE ON portal_v2_invitation_entitlements
 WHEN NEW.access_terms_id IS NOT OLD.access_terms_id OR (NEW.access_terms_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM portal_project_access_terms t JOIN portal_v2_invitations i ON i.workspace_id=t.workspace_id
 WHERE t.id=NEW.access_terms_id AND i.id=NEW.invitation_id AND t.kind='collaborator'
 AND ((NEW.scope_type='project' AND NEW.scope_public_id=t.project_public_id)
 OR (NEW.capability='workspace.view' AND NEW.scope_type='workspace' AND NEW.scope_public_id=t.workspace_id))))
 BEGIN SELECT RAISE(ABORT,'portal access terms ownership is immutable'); END;
