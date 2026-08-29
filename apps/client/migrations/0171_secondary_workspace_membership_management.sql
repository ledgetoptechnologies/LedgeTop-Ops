PRAGMA foreign_keys=OFF;
PRAGMA legacy_alter_table=ON;

-- 0165 intentionally began as a primary-only approval workflow. Rebuild only
-- its request parent so source provenance can be represented without guessing
-- or rewriting any existing request. Secondary approval publication remains
-- unsupported by the Client worker until a source-owned reviewer contract is
-- available; direct invitations use the authority ledger below.
DROP TRIGGER IF EXISTS portal_invitation_request_insert;
DROP TRIGGER IF EXISTS portal_invitation_request_update;
DROP TRIGGER IF EXISTS portal_invitation_request_delete;
DROP INDEX IF EXISTS idx_portal_invitation_requests_own;
DROP INDEX IF EXISTS idx_portal_invitation_requests_review;
DROP INDEX IF EXISTS idx_portal_invitation_requests_source;
ALTER TABLE portal_workspace_invitation_requests RENAME TO portal_workspace_invitation_requests_0165;
CREATE TABLE portal_workspace_invitation_requests (
 id TEXT PRIMARY KEY NOT NULL,
 workspace_id TEXT NOT NULL,
 source_id TEXT NOT NULL,
 requester_identity_id TEXT NOT NULL REFERENCES portal_v2_identities(id),
 recipient_email TEXT NOT NULL CHECK(length(recipient_email) BETWEEN 3 AND 320),
 scope_type TEXT NOT NULL CHECK(scope_type IN ('workspace','organization','department','client','project')),
 scope_public_id TEXT NOT NULL,
 capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json) AND length(capabilities_json)<=256),
 access_terms_id TEXT REFERENCES portal_project_access_terms(id),
 request_hash TEXT NOT NULL,
 policy_version INTEGER NOT NULL CHECK(policy_version>=1),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approving','approved','rejected','cancelled')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
 current_approval_id TEXT,
 reason_code TEXT,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 FOREIGN KEY(workspace_id,source_id) REFERENCES pa_portal_workspace_sources(workspace_id,projection_source_id),
 CHECK((scope_type='project' AND access_terms_id IS NOT NULL) OR (scope_type<>'project' AND access_terms_id IS NULL))
);
INSERT INTO portal_workspace_invitation_requests
 SELECT * FROM portal_workspace_invitation_requests_0165;
DROP TABLE portal_workspace_invitation_requests_0165;
CREATE INDEX idx_portal_invitation_requests_own ON portal_workspace_invitation_requests(workspace_id,requester_identity_id,created_at DESC,id DESC);
CREATE INDEX idx_portal_invitation_requests_review ON portal_workspace_invitation_requests(status,created_at DESC,id DESC);
CREATE INDEX idx_portal_invitation_requests_source ON portal_workspace_invitation_requests(source_id,workspace_id,created_at DESC,id DESC);

CREATE TRIGGER portal_invitation_request_insert BEFORE INSERT ON portal_workspace_invitation_requests
WHEN EXISTS(SELECT 1 FROM portal_workspace_invitation_requests WHERE id=NEW.id)
 OR NEW.status<>'pending' OR NEW.version<>1 OR NEW.current_approval_id IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM portal_v2_workspaces w JOIN pa_portal_workspace_sources s ON s.workspace_id=w.id AND s.projection_source_id=w.project_alpha_source_id
   JOIN portal_workspace_invitation_policies p ON p.workspace_id=w.id AND p.policy='require_approval' AND p.version=NEW.policy_version
   WHERE w.id=NEW.workspace_id AND w.project_alpha_source_id=NEW.source_id AND w.status='active')
 OR (NEW.access_terms_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM portal_project_access_terms t WHERE t.id=NEW.access_terms_id
   AND t.source_id=NEW.source_id AND t.workspace_id=NEW.workspace_id AND t.project_public_id=NEW.scope_public_id AND t.kind='collaborator'
   AND t.created_by_actor_type='identity' AND t.created_by_actor_id=NEW.requester_identity_id))
 OR json_type(NEW.capabilities_json)<>'array' OR json_array_length(NEW.capabilities_json) NOT BETWEEN 1 AND 3
 OR EXISTS(SELECT 1 FROM json_each(NEW.capabilities_json) WHERE type<>'text' OR value NOT IN ('workspace.view','delivery.view','request.create'))
BEGIN SELECT RAISE(ABORT,'invalid invitation approval request'); END;
CREATE TRIGGER portal_invitation_request_update BEFORE UPDATE ON portal_workspace_invitation_requests
WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.source_id IS NOT OLD.source_id
 OR NEW.requester_identity_id IS NOT OLD.requester_identity_id OR NEW.recipient_email IS NOT OLD.recipient_email
 OR NEW.scope_type IS NOT OLD.scope_type OR NEW.scope_public_id IS NOT OLD.scope_public_id OR NEW.capabilities_json IS NOT OLD.capabilities_json
 OR NEW.access_terms_id IS NOT OLD.access_terms_id OR NEW.request_hash IS NOT OLD.request_hash OR NEW.policy_version IS NOT OLD.policy_version
 OR NEW.created_at IS NOT OLD.created_at OR NEW.version<>OLD.version+1
 OR NOT ((OLD.status='pending' AND NEW.status IN ('approving','rejected','cancelled'))
   OR (OLD.status='approving' AND NEW.status IN ('approved','pending','cancelled')))
 OR (NEW.status IN ('approving','approved') AND NOT EXISTS(SELECT 1 FROM portal_workspace_invitation_approvals a
   WHERE a.id=NEW.current_approval_id AND a.request_id=NEW.id AND a.status=CASE NEW.status WHEN 'approved' THEN 'published' ELSE 'staged' END))
BEGIN SELECT RAISE(ABORT,'invitation request requires immutable next-version transition'); END;
CREATE TRIGGER portal_invitation_request_delete BEFORE DELETE ON portal_workspace_invitation_requests
BEGIN SELECT RAISE(ABORT,'invitation request history is persistent'); END;

-- A secondary invitation is authorized by this immutable, invitation-specific
-- record. It records the exact producer, manager identity and selected complete
-- generation that were reviewed. There is deliberately no migration backfill.
CREATE TABLE portal_secondary_workspace_invitation_authority (
 invitation_id TEXT PRIMARY KEY NOT NULL,
 workspace_id TEXT NOT NULL,
 source_id TEXT NOT NULL CHECK(source_id<>'project-alpha:primary'),
 inviter_identity_id TEXT NOT NULL,
 inviter_issuer TEXT NOT NULL,
 inviter_subject TEXT NOT NULL,
 inviter_email TEXT NOT NULL COLLATE NOCASE,
 authority_revision INTEGER NOT NULL CHECK(authority_revision>0),
 authority_version INTEGER NOT NULL CHECK(authority_version>0),
 connector_revision INTEGER NOT NULL CHECK(connector_revision>0),
 connector_version INTEGER NOT NULL CHECK(connector_version>0),
 generation_id TEXT NOT NULL,
 source_sequence INTEGER NOT NULL CHECK(source_sequence>0),
 context_hash TEXT NOT NULL CHECK(length(context_hash)=64 AND context_hash NOT GLOB '*[^0-9a-f]*'),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(invitation_id,workspace_id,source_id),
 FOREIGN KEY(workspace_id,source_id) REFERENCES pa_portal_workspace_sources(workspace_id,projection_source_id),
 FOREIGN KEY(inviter_identity_id) REFERENCES portal_v2_identities(id)
);
CREATE TABLE portal_secondary_workspace_membership_fences (
 id TEXT PRIMARY KEY NOT NULL,
 write_guard INTEGER NOT NULL CONSTRAINT portal_secondary_membership_write_guard CHECK(write_guard=1)
);
CREATE TRIGGER portal_secondary_invitation_authority_insert BEFORE INSERT ON portal_secondary_workspace_invitation_authority
WHEN EXISTS(SELECT 1 FROM portal_secondary_workspace_invitation_authority WHERE invitation_id=NEW.invitation_id)
 OR NOT EXISTS(SELECT 1 FROM portal_v2_workspaces w
   JOIN pa_portal_workspace_sources owner ON owner.workspace_id=w.id AND owner.projection_source_id=w.project_alpha_source_id
   JOIN pa_portal_source_authorities authority ON authority.source_id=owner.projection_source_id AND authority.state='active'
     AND authority.active_revision=NEW.authority_revision AND authority.version=NEW.authority_version
     AND authority.connector_revision=NEW.connector_revision AND authority.connector_version=NEW.connector_version
   JOIN pa_portal_source_authority_revisions revision ON revision.source_id=authority.source_id AND revision.revision=authority.active_revision
   JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=w.id AND checkpoint.active_generation_id=NEW.generation_id
     AND checkpoint.source_sequence=NEW.source_sequence
   JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id AND generation.workspace_id=w.id
     AND generation.status='active' AND generation.complete=1 AND generation.source_sequence=checkpoint.source_sequence
   JOIN portal_v2_directory_entities root ON root.workspace_id=w.id AND root.generation_id=generation.id AND root.active=1
     AND root.entity_type=w.root_type AND root.public_id=COALESCE(w.pa_organization_public_id,w.pa_client_public_id)
   JOIN portal_v2_identities identity ON identity.id=NEW.inviter_identity_id AND identity.issuer=NEW.inviter_issuer
     AND identity.subject=NEW.inviter_subject AND lower(identity.verified_email)=lower(NEW.inviter_email)
     AND identity.status='active' AND identity.revoked_at IS NULL
   JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=w.id AND membership.identity_id=identity.id
     AND membership.source_type='project_alpha' AND membership.status='active' AND membership.revoked_at IS NULL
     AND membership.expires_at IS NULL
   JOIN pa_portal_principals principal ON principal.workspace_id=w.id AND principal.identity_id=identity.id
     AND principal.status='active' AND principal.source_version=membership.source_version
     AND lower(principal.email_hint)=lower(identity.verified_email)
   WHERE w.id=NEW.workspace_id AND w.project_alpha_source_id=NEW.source_id AND w.legacy_account_id IS NULL AND w.status='active')
BEGIN SELECT RAISE(ABORT,'secondary invitation authority is stale or unavailable'); END;
CREATE TRIGGER portal_secondary_invitation_authority_update BEFORE UPDATE ON portal_secondary_workspace_invitation_authority
BEGIN SELECT RAISE(ABORT,'secondary invitation authority is immutable'); END;
CREATE TRIGGER portal_secondary_invitation_authority_delete BEFORE DELETE ON portal_secondary_workspace_invitation_authority
BEGIN SELECT RAISE(ABORT,'secondary invitation authority is immutable'); END;

CREATE TRIGGER portal_secondary_invitation_issue BEFORE INSERT ON portal_v2_invitations
WHEN EXISTS(SELECT 1 FROM portal_v2_workspaces w WHERE w.id=NEW.workspace_id AND w.project_alpha_source_id<>'project-alpha:primary')
 AND NOT EXISTS(SELECT 1 FROM portal_secondary_workspace_invitation_authority binding
   WHERE binding.invitation_id=NEW.id AND binding.workspace_id=NEW.workspace_id
     AND binding.inviter_identity_id=NEW.invited_by_identity_id)
BEGIN SELECT RAISE(ABORT,'secondary invitation requires exact authority binding'); END;
CREATE TRIGGER portal_secondary_invitation_identity_update BEFORE UPDATE ON portal_v2_invitations
WHEN EXISTS(SELECT 1 FROM portal_secondary_workspace_invitation_authority binding WHERE binding.invitation_id=OLD.id)
 AND (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.token_hash IS NOT OLD.token_hash
   OR NEW.invited_email IS NOT OLD.invited_email OR NEW.invited_by_identity_id IS NOT OLD.invited_by_identity_id
   OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at)
BEGIN SELECT RAISE(ABORT,'secondary invitation identity is immutable'); END;

-- Acceptance is legal only while the exact source authority and selected
-- complete generation recorded at issuance remain current. A source refresh,
-- suspension or replacement therefore invalidates an unaccepted token.
CREATE TRIGGER portal_secondary_invitation_accept BEFORE UPDATE OF status ON portal_v2_invitations
WHEN NEW.status='accepted' AND OLD.status<>'accepted'
 AND EXISTS(SELECT 1 FROM portal_secondary_workspace_invitation_authority binding WHERE binding.invitation_id=NEW.id)
 AND NOT EXISTS(SELECT 1 FROM portal_secondary_workspace_invitation_authority binding
   JOIN portal_v2_workspaces w ON w.id=binding.workspace_id AND w.status='active' AND w.legacy_account_id IS NULL
     AND w.project_alpha_source_id=binding.source_id
   JOIN pa_portal_source_authorities authority ON authority.source_id=binding.source_id AND authority.state='active'
     AND authority.active_revision=binding.authority_revision AND authority.version=binding.authority_version
     AND authority.connector_revision=binding.connector_revision AND authority.connector_version=binding.connector_version
   JOIN pa_portal_source_authority_revisions revision ON revision.source_id=authority.source_id AND revision.revision=authority.active_revision
   JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=w.id
     AND checkpoint.active_generation_id=binding.generation_id AND checkpoint.source_sequence=binding.source_sequence
   JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id AND generation.workspace_id=w.id
     AND generation.status='active' AND generation.complete=1 AND generation.source_sequence=checkpoint.source_sequence
   WHERE binding.invitation_id=NEW.id AND binding.workspace_id=NEW.workspace_id
     AND EXISTS(SELECT 1 FROM portal_v2_identities inviter
       JOIN portal_v2_workspace_memberships inviter_membership
         ON inviter_membership.workspace_id=w.id AND inviter_membership.identity_id=inviter.id
         AND inviter_membership.source_type='project_alpha' AND inviter_membership.status='active'
         AND inviter_membership.revoked_at IS NULL AND inviter_membership.expires_at IS NULL
       JOIN pa_portal_principals inviter_principal
         ON inviter_principal.workspace_id=w.id AND inviter_principal.identity_id=inviter.id
         AND inviter_principal.status='active' AND inviter_principal.source_version=inviter_membership.source_version
         AND lower(inviter_principal.email_hint)=lower(inviter.verified_email)
       JOIN portal_v2_directory_entities inviter_root
         ON inviter_root.workspace_id=w.id AND inviter_root.generation_id=generation.id
         AND inviter_root.entity_type=w.root_type
         AND inviter_root.public_id=COALESCE(w.pa_organization_public_id,w.pa_client_public_id)
         AND inviter_root.active=1
       WHERE inviter.id=binding.inviter_identity_id AND inviter.issuer=binding.inviter_issuer
         AND inviter.subject=binding.inviter_subject AND lower(inviter.verified_email)=lower(binding.inviter_email)
         AND inviter.status='active' AND inviter.revoked_at IS NULL
         AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_denials denial
           WHERE denial.identity_id=inviter.id AND denial.status='active' AND denial.revoked_at IS NULL
             AND datetime(denial.valid_from)<=datetime('now')
             AND (denial.expires_at IS NULL OR datetime(denial.expires_at)>datetime('now'))
             AND (denial.scope_type='global' OR denial.workspace_id=w.id))
         AND EXISTS(SELECT 1 FROM portal_v2_entitlements view_allow
           WHERE view_allow.workspace_id=w.id AND view_allow.identity_id=inviter.id
             AND view_allow.capability='workspace.view' AND view_allow.effect='allow'
             AND view_allow.scope_type='workspace' AND view_allow.scope_public_id=w.id
             AND view_allow.source_type='project_alpha' AND view_allow.source_version=inviter_membership.source_version
             AND view_allow.status='active' AND view_allow.revoked_at IS NULL
             AND datetime(view_allow.valid_from)<=datetime('now') AND view_allow.expires_at IS NULL)
         AND EXISTS(SELECT 1 FROM portal_v2_entitlements manage_allow
           WHERE manage_allow.workspace_id=w.id AND manage_allow.identity_id=inviter.id
             AND manage_allow.capability='member.manage' AND manage_allow.effect='allow'
             AND manage_allow.scope_type='workspace' AND manage_allow.scope_public_id=w.id
             AND manage_allow.source_type='project_alpha' AND manage_allow.source_version=inviter_membership.source_version
             AND manage_allow.status='active' AND manage_allow.revoked_at IS NULL
             AND datetime(manage_allow.valid_from)<=datetime('now') AND manage_allow.expires_at IS NULL)
         AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements deny
           WHERE deny.workspace_id=w.id AND deny.identity_id=inviter.id
             AND deny.capability IN ('workspace.view','member.manage') AND deny.effect='deny'
             AND deny.scope_type='workspace' AND deny.scope_public_id=w.id
             AND deny.status='active' AND deny.revoked_at IS NULL
             AND datetime(deny.valid_from)<=datetime('now')
             AND (deny.expires_at IS NULL OR datetime(deny.expires_at)>datetime('now')))))
BEGIN SELECT RAISE(ABORT,'secondary invitation authority changed'); END;

-- Source-projected people and locally invited collaborators are disjoint. A
-- projected row cannot be silently converted and an invitation cannot replace
-- a current source-owned membership.
CREATE TRIGGER portal_secondary_invited_membership_insert BEFORE INSERT ON portal_v2_workspace_memberships
WHEN NEW.source_type='client_invitation'
 AND EXISTS(SELECT 1 FROM portal_v2_workspaces w WHERE w.id=NEW.workspace_id AND w.project_alpha_source_id<>'project-alpha:primary')
 AND NOT EXISTS(SELECT 1 FROM portal_v2_invitations invitation
   JOIN portal_secondary_workspace_invitation_authority binding ON binding.invitation_id=invitation.id
     AND binding.workspace_id=invitation.workspace_id
   WHERE invitation.workspace_id=NEW.workspace_id AND invitation.accepted_by_identity_id=NEW.identity_id
     AND invitation.status='accepted' AND NEW.id='invitation-membership-' || invitation.id)
BEGIN SELECT RAISE(ABORT,'secondary invited membership lacks accepted authority'); END;

CREATE TRIGGER portal_secondary_membership_authority_update
BEFORE UPDATE OF id,workspace_id,identity_id,source_type,source_version ON portal_v2_workspace_memberships
WHEN EXISTS(SELECT 1 FROM portal_v2_workspaces w WHERE w.id=OLD.workspace_id
  AND w.project_alpha_source_id<>'project-alpha:primary')
 AND OLD.source_type IN ('project_alpha','client_invitation')
 AND (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.identity_id IS NOT OLD.identity_id
   OR NEW.source_type IS NOT OLD.source_type OR NEW.source_version IS NOT OLD.source_version)
BEGIN SELECT RAISE(ABORT,'secondary membership authority is immutable'); END;

PRAGMA legacy_alter_table=OFF;
PRAGMA foreign_keys=ON;
