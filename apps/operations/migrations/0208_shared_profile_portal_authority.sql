PRAGMA foreign_keys=ON;
-- Portal edit authority is additive. Existing PA, portal, login and public-link identities are untouched.
CREATE TABLE shared_profile_portal_authority_heads(
 workspace_id TEXT PRIMARY KEY,source_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=1),
 state TEXT NOT NULL CHECK(state IN('active','blocked')),operation_id TEXT NOT NULL,
 updated_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE TABLE shared_profile_portal_grants(
 id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES shared_profile_portal_authority_heads(workspace_id),
 source_id TEXT NOT NULL,source_instance_id TEXT NOT NULL,application_id TEXT NOT NULL,history_epoch_id TEXT NOT NULL,
 recipient_mode TEXT NOT NULL DEFAULT 'verified_identity' CHECK(recipient_mode IN('verified_identity','first_verified_identity')),
 issuer TEXT,subject TEXT,principal_public_id TEXT NOT NULL,
 target_type TEXT NOT NULL CHECK(target_type IN('client','organization')),target_public_id TEXT NOT NULL,
 record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id),
 group_id TEXT NOT NULL REFERENCES native_directory_shared_profiles(id),group_membership_json TEXT NOT NULL CHECK(json_valid(group_membership_json)),
 revision INTEGER NOT NULL CHECK(revision>=1),state TEXT NOT NULL CHECK(state IN('active','revoked')),
 issued_by TEXT NOT NULL REFERENCES staff_users(id),created_at TEXT NOT NULL DEFAULT(datetime('now')),
 CHECK((issuer IS NOT NULL AND subject IS NOT NULL) OR (recipient_mode='first_verified_identity' AND issuer IS NULL AND subject IS NULL)),
 UNIQUE(workspace_id,principal_public_id,target_type,target_public_id,group_id)
);
CREATE TABLE shared_profile_portal_audit(
 operation_id TEXT PRIMARY KEY,grant_id TEXT REFERENCES shared_profile_portal_grants(id),workspace_id TEXT NOT NULL,
 action TEXT NOT NULL,actor_kind TEXT NOT NULL CHECK(actor_kind IN('staff','portal','system')),
 actor_id TEXT NOT NULL,detail_json TEXT NOT NULL CHECK(json_valid(detail_json)),created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE TABLE shared_profile_portal_write_fences(
 mutation_id TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES shared_profile_portal_grants(id),
 grant_revision INTEGER NOT NULL,authority_revision INTEGER NOT NULL,group_id TEXT NOT NULL,
 expected_group_version INTEGER NOT NULL,issuer TEXT NOT NULL,subject TEXT NOT NULL,context_version TEXT NOT NULL,verified_until TEXT NOT NULL,
 request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64)
);
CREATE TRIGGER shared_profile_portal_write_fence_guard BEFORE INSERT ON shared_profile_portal_write_fences
WHEN NOT EXISTS(SELECT 1 FROM shared_profile_portal_grants g
 JOIN shared_profile_portal_authority_heads a ON a.workspace_id=g.workspace_id AND a.source_id=g.source_id
 JOIN native_directory_shared_profiles p ON p.id=g.group_id
 JOIN native_directory_shared_profile_members member ON member.group_id=p.id AND member.record_id=g.record_id
 JOIN project_alpha_active_directory_mappings mapping ON mapping.record_id=g.record_id AND mapping.source_id=g.source_id
 WHERE g.id=NEW.grant_id AND g.state='active' AND g.revision=NEW.grant_revision
 AND g.issuer=NEW.issuer AND g.subject=NEW.subject AND g.group_id=NEW.group_id
 AND g.target_public_id=mapping.project_alpha_public_id AND mapping.resource_type=g.target_type
 AND mapping.source_instance_id=g.source_instance_id AND mapping.application_id=g.application_id AND mapping.history_epoch_id=g.history_epoch_id
 AND a.state='active' AND a.revision=NEW.authority_revision
 AND datetime(NEW.verified_until)>datetime('now') AND datetime(NEW.verified_until)<=datetime('now','+60 seconds')
 AND p.version=NEW.expected_group_version AND json(p.membership_json)=json(g.group_membership_json))
BEGIN SELECT RAISE(ABORT,'shared_profile_portal_authority_changed'); END;
CREATE TRIGGER shared_profile_portal_fence_immutable BEFORE UPDATE ON shared_profile_portal_write_fences
BEGIN SELECT RAISE(ABORT,'shared_profile_portal_fence_immutable'); END;
CREATE TRIGGER shared_profile_portal_audit_immutable BEFORE UPDATE ON shared_profile_portal_audit
BEGIN SELECT RAISE(ABORT,'shared_profile_portal_audit_immutable'); END;
CREATE TRIGGER shared_profile_portal_audit_no_delete BEFORE DELETE ON shared_profile_portal_audit
BEGIN SELECT RAISE(ABORT,'shared_profile_portal_audit_immutable'); END;
CREATE TRIGGER shared_profile_portal_fence_no_delete BEFORE DELETE ON shared_profile_portal_write_fences
BEGIN SELECT RAISE(ABORT,'shared_profile_portal_fence_immutable'); END;
CREATE TRIGGER shared_profile_portal_grant_identity BEFORE UPDATE ON shared_profile_portal_grants
WHEN NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id OR NEW.source_id<>OLD.source_id
 OR NEW.source_instance_id<>OLD.source_instance_id OR NEW.application_id<>OLD.application_id OR NEW.history_epoch_id<>OLD.history_epoch_id
 OR NEW.recipient_mode<>OLD.recipient_mode OR NEW.principal_public_id<>OLD.principal_public_id
 OR NEW.target_type<>OLD.target_type OR NEW.target_public_id<>OLD.target_public_id OR NEW.record_id<>OLD.record_id
 OR NEW.group_id<>OLD.group_id OR NEW.group_membership_json<>OLD.group_membership_json OR NEW.issued_by<>OLD.issued_by
 OR NOT(NEW.revision=OLD.revision+1 AND ((NEW.state='revoked' AND NEW.issuer IS OLD.issuer AND NEW.subject IS OLD.subject)
  OR (OLD.state='active' AND NEW.state='active' AND OLD.recipient_mode='first_verified_identity'
    AND OLD.issuer IS NULL AND OLD.subject IS NULL AND NEW.issuer IS NOT NULL AND NEW.subject IS NOT NULL)))
BEGIN SELECT RAISE(ABORT,'shared_profile_portal_grant_identity'); END;
