-- Approval requests are not invitations. No token, membership, entitlement or
-- mail is created until a separately authorized review stages an invitation.
CREATE TABLE portal_workspace_invitation_requests (
 id TEXT PRIMARY KEY NOT NULL,
 workspace_id TEXT NOT NULL,
 source_id TEXT NOT NULL CHECK(source_id='project-alpha:primary'),
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
CREATE INDEX idx_portal_invitation_requests_own ON portal_workspace_invitation_requests(workspace_id,requester_identity_id,created_at DESC,id DESC);
CREATE INDEX idx_portal_invitation_requests_review ON portal_workspace_invitation_requests(status,created_at DESC,id DESC);
CREATE INDEX idx_portal_invitation_requests_source ON portal_workspace_invitation_requests(source_id,workspace_id,created_at DESC,id DESC);
CREATE TABLE portal_workspace_invitation_request_commands (
 workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('submit','cancel','reject','approve','policy')),
 request_hash TEXT NOT NULL, request_id TEXT REFERENCES portal_workspace_invitation_requests(id),
 authorization_id TEXT, result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(result_json)<=4096),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(workspace_id,actor_id,idempotency_key)
);
CREATE TABLE portal_workspace_invitation_approvals (
 id TEXT PRIMARY KEY NOT NULL,
 request_id TEXT NOT NULL REFERENCES portal_workspace_invitation_requests(id),
 request_version INTEGER NOT NULL CHECK(request_version>=1),
 invitation_id TEXT UNIQUE NOT NULL,
 actor_staff_id TEXT NOT NULL,
 authorization_fingerprint TEXT NOT NULL CHECK(length(authorization_fingerprint)=64 AND authorization_fingerprint NOT GLOB '*[^0-9a-f]*'),
 context_version TEXT NOT NULL CHECK(length(context_version)=64 AND context_version NOT GLOB '*[^0-9a-f]*'),
 delegation_proof TEXT NOT NULL CHECK(length(CAST(delegation_proof AS BLOB))<=196608),
 publication_deadline TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'staged' CHECK(status IN ('staged','published','closed')),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE portal_workspace_invitation_request_audit (
 id TEXT PRIMARY KEY NOT NULL,workspace_id TEXT NOT NULL REFERENCES portal_v2_workspaces(id),
 request_id TEXT REFERENCES portal_workspace_invitation_requests(id),actor_type TEXT NOT NULL CHECK(actor_type IN ('identity','staff')),
 actor_id TEXT NOT NULL,action TEXT NOT NULL,authorization_id TEXT,
 details_json TEXT NOT NULL CHECK(json_valid(details_json) AND length(details_json)<=8192),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_portal_invitation_approval_expiry ON portal_workspace_invitation_approvals(publication_deadline,id) WHERE status='staged';
CREATE TABLE portal_workspace_invitation_approval_fences (
 id TEXT PRIMARY KEY NOT NULL,write_guard INTEGER NOT NULL CONSTRAINT portal_invitation_approval_guard CHECK(write_guard=1)
);
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
CREATE TRIGGER portal_invitation_approval_insert BEFORE INSERT ON portal_workspace_invitation_approvals
WHEN NEW.status<>'staged' OR EXISTS(SELECT 1 FROM portal_workspace_invitation_approvals WHERE id=NEW.id OR invitation_id=NEW.invitation_id)
 OR EXISTS(SELECT 1 FROM portal_v2_invitations WHERE id=NEW.invitation_id)
 OR NOT EXISTS(SELECT 1 FROM portal_workspace_invitation_requests r JOIN portal_workspace_invitation_policies p ON p.workspace_id=r.workspace_id
   WHERE r.id=NEW.request_id AND r.version=NEW.request_version AND r.status='pending' AND p.policy='require_approval' AND p.version=r.policy_version)
 OR datetime(NEW.publication_deadline) IS NULL OR datetime(NEW.publication_deadline)<=datetime('now')
 OR datetime(NEW.publication_deadline)>datetime('now','+10 minutes')
BEGIN SELECT RAISE(ABORT,'invalid invitation approval reservation'); END;
CREATE TRIGGER portal_invitation_approval_update BEFORE UPDATE ON portal_workspace_invitation_approvals
WHEN NEW.id IS NOT OLD.id OR NEW.request_id IS NOT OLD.request_id OR NEW.request_version IS NOT OLD.request_version
 OR NEW.invitation_id IS NOT OLD.invitation_id OR NEW.actor_staff_id IS NOT OLD.actor_staff_id
 OR NEW.authorization_fingerprint IS NOT OLD.authorization_fingerprint OR NEW.context_version IS NOT OLD.context_version
 OR NEW.delegation_proof IS NOT OLD.delegation_proof
 OR NEW.publication_deadline IS NOT OLD.publication_deadline OR NEW.created_at IS NOT OLD.created_at
 OR NOT(OLD.status='staged' AND NEW.status IN ('published','closed'))
 OR (NEW.status='published' AND datetime(NEW.publication_deadline)<=datetime('now'))
BEGIN SELECT RAISE(ABORT,'invitation approval is immutable'); END;
CREATE TRIGGER portal_invitation_approval_delete BEFORE DELETE ON portal_workspace_invitation_approvals
BEGIN SELECT RAISE(ABORT,'invitation approval history is persistent'); END;
CREATE TRIGGER portal_invitation_request_command_insert BEFORE INSERT ON portal_workspace_invitation_request_commands
WHEN EXISTS(SELECT 1 FROM portal_workspace_invitation_request_commands WHERE workspace_id=NEW.workspace_id AND actor_id=NEW.actor_id AND idempotency_key=NEW.idempotency_key)
 OR (NEW.operation='submit' AND EXISTS(SELECT 1 FROM portal_v2_invitation_commands old
   WHERE old.workspace_id=NEW.workspace_id AND old.actor_identity_id=NEW.actor_id AND old.idempotency_key=NEW.idempotency_key))
BEGIN SELECT RAISE(ABORT,'invitation command is immutable'); END;
CREATE TRIGGER portal_invitation_command_approval_namespace BEFORE INSERT ON portal_v2_invitation_commands
WHEN EXISTS(SELECT 1 FROM portal_workspace_invitation_request_commands request
 WHERE request.workspace_id=NEW.workspace_id AND request.actor_id=NEW.actor_identity_id AND request.idempotency_key=NEW.idempotency_key AND request.operation='submit')
BEGIN SELECT RAISE(ABORT,'invitation key already belongs to an approval request'); END;
CREATE TRIGGER portal_invitation_request_command_update BEFORE UPDATE ON portal_workspace_invitation_request_commands
BEGIN SELECT RAISE(ABORT,'invitation command is immutable'); END;
CREATE TRIGGER portal_invitation_request_command_delete BEFORE DELETE ON portal_workspace_invitation_request_commands
BEGIN SELECT RAISE(ABORT,'invitation command is immutable'); END;
CREATE TRIGGER portal_invitation_request_audit_insert BEFORE INSERT ON portal_workspace_invitation_request_audit
WHEN EXISTS(SELECT 1 FROM portal_workspace_invitation_request_audit WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'invitation audit is immutable'); END;
CREATE TRIGGER portal_invitation_request_audit_update BEFORE UPDATE ON portal_workspace_invitation_request_audit
BEGIN SELECT RAISE(ABORT,'invitation audit is immutable'); END;
CREATE TRIGGER portal_invitation_request_audit_delete BEFORE DELETE ON portal_workspace_invitation_request_audit
BEGIN SELECT RAISE(ABORT,'invitation audit is immutable'); END;

-- Tracked invitations never inherit an Allowed-policy bypass: a staged token
-- remains unusable even if the workspace policy changes during coordination.
CREATE VIEW portal_workspace_invitation_publications AS
 SELECT a.invitation_id,r.workspace_id,r.source_id,r.id request_id,
 CASE WHEN a.status='published' AND r.status='approved' AND r.current_approval_id=a.id
   AND p.policy='require_approval' AND p.version=r.policy_version
   AND w.status='active' AND w.project_alpha_source_id=r.source_id THEN 1 ELSE 0 END published
 FROM portal_workspace_invitation_approvals a JOIN portal_workspace_invitation_requests r ON r.id=a.request_id
 JOIN portal_workspace_invitation_policies p ON p.workspace_id=r.workspace_id
 JOIN portal_v2_workspaces w ON w.id=r.workspace_id;
DROP TRIGGER portal_invitation_policy_issue;
CREATE TRIGGER portal_invitation_policy_issue BEFORE INSERT ON portal_v2_invitations
WHEN EXISTS(SELECT 1 FROM portal_workspace_invitation_approvals a WHERE a.invitation_id=NEW.id)
 AND NOT EXISTS(SELECT 1 FROM portal_workspace_invitation_approvals a JOIN portal_workspace_invitation_requests r ON r.id=a.request_id
   JOIN portal_workspace_invitation_policies p ON p.workspace_id=r.workspace_id AND p.policy='require_approval' AND p.version=r.policy_version
   WHERE a.invitation_id=NEW.id AND a.status='staged' AND r.status='approving' AND r.current_approval_id=a.id
     AND r.workspace_id=NEW.workspace_id AND r.recipient_email=NEW.invited_email AND r.requester_identity_id=NEW.invited_by_identity_id
     AND datetime(a.publication_deadline)>datetime('now'))
 OR (NOT EXISTS(SELECT 1 FROM portal_workspace_invitation_approvals a WHERE a.invitation_id=NEW.id)
   AND EXISTS(SELECT 1 FROM portal_workspace_invitation_policies p WHERE p.workspace_id=NEW.workspace_id AND p.policy<>'allowed'))
BEGIN SELECT RAISE(ABORT,'portal invitation policy blocks issuance'); END;
CREATE TRIGGER portal_invitation_approved_identity_update BEFORE UPDATE ON portal_v2_invitations
WHEN EXISTS(SELECT 1 FROM portal_workspace_invitation_approvals a WHERE a.invitation_id=OLD.id)
 AND (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.token_hash IS NOT OLD.token_hash
   OR NEW.invited_email IS NOT OLD.invited_email OR NEW.invited_by_identity_id IS NOT OLD.invited_by_identity_id
   OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at)
BEGIN SELECT RAISE(ABORT,'approved invitation identity is immutable'); END;
CREATE TRIGGER portal_invitation_approved_replace BEFORE INSERT ON portal_v2_invitations
WHEN EXISTS(SELECT 1 FROM portal_v2_invitations i JOIN portal_workspace_invitation_approvals a ON a.invitation_id=i.id WHERE i.id=NEW.id)
BEGIN SELECT RAISE(ABORT,'approved invitation cannot be replaced'); END;
CREATE TRIGGER portal_invitation_approved_entitlement_insert BEFORE INSERT ON portal_v2_invitation_entitlements
WHEN EXISTS(SELECT 1 FROM portal_workspace_invitation_approvals a WHERE a.invitation_id=NEW.invitation_id)
 AND NOT EXISTS(SELECT 1 FROM portal_workspace_invitation_approvals a JOIN portal_workspace_invitation_requests r ON r.id=a.request_id
   WHERE a.invitation_id=NEW.invitation_id AND a.status='staged' AND r.current_approval_id=a.id AND r.status='approving'
     AND NEW.access_terms_id IS r.access_terms_id
     AND ((NEW.capability='workspace.view' AND NEW.scope_type='workspace' AND NEW.scope_public_id=r.workspace_id)
       OR (NEW.capability IN (SELECT value FROM json_each(r.capabilities_json)) AND NEW.scope_type=r.scope_type AND NEW.scope_public_id=r.scope_public_id)))
BEGIN SELECT RAISE(ABORT,'approved invitation grant differs from request'); END;
CREATE TRIGGER portal_invitation_approved_entitlement_update BEFORE UPDATE ON portal_v2_invitation_entitlements
WHEN EXISTS(SELECT 1 FROM portal_workspace_invitation_approvals a WHERE a.invitation_id=OLD.invitation_id)
BEGIN SELECT RAISE(ABORT,'approved invitation grants are immutable'); END;
DROP TRIGGER portal_invitation_policy_accept;
CREATE TRIGGER portal_invitation_policy_accept BEFORE UPDATE OF status ON portal_v2_invitations
WHEN NEW.status='accepted' AND OLD.status<>'accepted' AND (
 (EXISTS(SELECT 1 FROM portal_workspace_invitation_approvals a WHERE a.invitation_id=NEW.id)
   AND (NOT EXISTS(SELECT 1 FROM portal_workspace_invitation_publications p WHERE p.invitation_id=NEW.id AND p.published=1)
     OR NOT EXISTS(SELECT 1 FROM portal_v2_invitation_access_enrollment_receipts receipt
       JOIN portal_v2_invitation_email_outbox outbox ON outbox.invitation_id=receipt.invitation_id AND outbox.recipient_email_hash=receipt.invited_email_hash
       WHERE receipt.invitation_id=NEW.id AND receipt.workspace_id=NEW.workspace_id AND receipt.invitation_token_hash=NEW.token_hash
         AND receipt.revoked_at IS NULL AND datetime(receipt.enrolled_at)<=datetime('now') AND datetime(receipt.expires_at)>datetime('now'))))
 OR (NOT EXISTS(SELECT 1 FROM portal_workspace_invitation_approvals a WHERE a.invitation_id=NEW.id)
   AND EXISTS(SELECT 1 FROM portal_workspace_invitation_policies p WHERE p.workspace_id=NEW.workspace_id AND p.policy<>'allowed'))
 OR EXISTS(SELECT 1 FROM portal_v2_invitation_entitlements e JOIN portal_project_access_terms t ON t.id=e.access_terms_id
 LEFT JOIN portal_project_access_deadlines d ON d.access_terms_id=t.id WHERE e.invitation_id=NEW.id AND (
   (t.mode='specific_date' AND datetime(t.expires_at)<=datetime('now')) OR (t.mode='project_end' AND NOT (
     (d.access_terms_id IS NOT NULL AND datetime(d.deadline_at)>datetime('now')) OR
     (d.access_terms_id IS NULL AND EXISTS(SELECT 1 FROM portal_project_access_current_lifecycle l WHERE l.workspace_id=t.workspace_id
       AND l.source_id=t.source_id AND l.project_public_id=t.project_public_id AND l.lifecycle_status='active')))))))
BEGIN SELECT RAISE(ABORT,'portal invitation policy or access terms block acceptance'); END;
CREATE TRIGGER portal_invitation_approved_mail_claim BEFORE UPDATE OF status ON portal_v2_invitation_email_outbox
WHEN NEW.status IN ('processing','sent') AND EXISTS(SELECT 1 FROM portal_workspace_invitation_approvals a WHERE a.invitation_id=NEW.invitation_id)
 AND NOT EXISTS(SELECT 1 FROM portal_workspace_invitation_publications p WHERE p.invitation_id=NEW.invitation_id AND p.published=1)
BEGIN SELECT RAISE(ABORT,'approval invitation is not published'); END;
