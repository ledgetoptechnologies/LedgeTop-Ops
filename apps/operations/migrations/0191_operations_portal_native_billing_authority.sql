PRAGMA foreign_keys=ON;

-- Explicit billing disclosure administration. Deliberately no role seed:
-- installation creates no effective authority until an administrator records
-- an allow through the dedicated immutable billing permission ledger below.
INSERT INTO permissions(key,description) VALUES
 ('billing.portal_access.manage','Grant or revoke one explicit native billing entity in an enrolled client portal');

CREATE TABLE operations_portal_native_billing_permission_generations (
  staff_id TEXT PRIMARY KEY REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE operations_portal_native_billing_permission_commands (
  operation_id TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL UNIQUE CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  action TEXT NOT NULL CHECK(action IN ('issue','revoke')),
  grant_id TEXT NOT NULL,
  staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('global','resource')),
  resource_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  expected_generation INTEGER NOT NULL CHECK(expected_generation>=0),
  resulting_generation INTEGER NOT NULL CHECK(resulting_generation=expected_generation+1),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL,
  actor_admission_version INTEGER NOT NULL CHECK(actor_admission_version>=1),
  actor_profile_version INTEGER NOT NULL CHECK(actor_profile_version>=1),
  actor_verified_until TEXT NOT NULL CHECK(length(actor_verified_until)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',actor_verified_until) IS actor_verified_until),
  observed_at TEXT NOT NULL CHECK(length(observed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',observed_at) IS observed_at),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((scope_kind='global' AND resource_id IS NULL) OR (scope_kind='resource' AND resource_id IS NOT NULL))
);

CREATE TABLE operations_portal_native_billing_permissions (
  grant_id TEXT PRIMARY KEY,
  issue_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_billing_permission_commands(operation_id) ON DELETE RESTRICT,
  staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('global','resource')),
  resource_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  issued_generation INTEGER NOT NULL CHECK(issued_generation>=1),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((scope_kind='global' AND resource_id IS NULL) OR (scope_kind='resource' AND resource_id IS NOT NULL))
);

CREATE TABLE operations_portal_native_billing_permission_revocations (
  grant_id TEXT PRIMARY KEY REFERENCES operations_portal_native_billing_permissions(grant_id) ON DELETE RESTRICT,
  revoke_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_billing_permission_commands(operation_id) ON DELETE RESTRICT,
  revoked_generation INTEGER NOT NULL CHECK(revoked_generation>=1),
  revoked_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER operations_portal_native_billing_permission_command_guard BEFORE INSERT
ON operations_portal_native_billing_permission_commands
WHEN NOT EXISTS(SELECT 1 FROM native_staff_admissions admission
 JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
 JOIN staff_users staff ON staff.id=admission.staff_id
 WHERE admission.staff_id=NEW.actor_staff_id AND admission.active=1
  AND admission.bound_access_subject=NEW.actor_access_subject AND admission.version=NEW.actor_admission_version
  AND profile.version=NEW.actor_profile_version AND staff.status='active' AND staff.access_subject=NEW.actor_access_subject
  AND NEW.actor_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND NEW.observed_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND NEW.observed_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes')
  AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=NEW.actor_staff_id
    AND role.role_id='role-owner' AND role.scope='global')
  AND EXISTS(SELECT 1 FROM native_directory_grants grant_row WHERE grant_row.staff_id=NEW.actor_staff_id
    AND grant_row.permission='directory.portal_access.manage' AND grant_row.effect='allow' AND grant_row.active=1
    AND grant_row.scope_kind='global')
  AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=NEW.actor_staff_id
    AND deny.permission='directory.portal_access.manage' AND deny.effect='deny' AND deny.active=1
    AND (deny.scope_kind='global' OR (deny.scope_kind='resource' AND deny.resource_id=NEW.resource_id))))
 OR NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_permission_generations generation
   WHERE generation.staff_id=NEW.staff_id AND generation.generation=NEW.expected_generation)
 OR (NEW.action='issue' AND EXISTS(SELECT 1 FROM operations_portal_native_billing_permissions grant_row
   WHERE (grant_row.grant_id=NEW.grant_id OR (grant_row.staff_id=NEW.staff_id AND grant_row.effect=NEW.effect
    AND grant_row.scope_kind=NEW.scope_kind AND grant_row.resource_id IS NEW.resource_id))
    AND NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_permission_revocations revoked
      WHERE revoked.grant_id=grant_row.grant_id)))
 OR (NEW.action='revoke' AND NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_permissions grant_row
   WHERE grant_row.grant_id=NEW.grant_id AND grant_row.staff_id=NEW.staff_id AND grant_row.effect=NEW.effect
    AND grant_row.scope_kind=NEW.scope_kind AND grant_row.resource_id IS NEW.resource_id
    AND NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_permission_revocations revoked
      WHERE revoked.grant_id=grant_row.grant_id)))
BEGIN SELECT RAISE(ABORT,'native billing permission command is not currently authorized and exact'); END;

CREATE TRIGGER operations_portal_native_billing_permission_issue_guard BEFORE INSERT
ON operations_portal_native_billing_permissions
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_permission_commands command
 WHERE command.operation_id=NEW.issue_operation_id AND command.action='issue' AND command.grant_id=NEW.grant_id
  AND command.staff_id=NEW.staff_id AND command.effect=NEW.effect AND command.scope_kind=NEW.scope_kind
  AND command.resource_id IS NEW.resource_id AND command.resulting_generation=NEW.issued_generation)
BEGIN SELECT RAISE(ABORT,'native billing permission issue is not exact'); END;

CREATE TRIGGER operations_portal_native_billing_permission_revoke_guard BEFORE INSERT
ON operations_portal_native_billing_permission_revocations
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_permission_commands command
 JOIN operations_portal_native_billing_permissions grant_row ON grant_row.grant_id=command.grant_id
 WHERE command.operation_id=NEW.revoke_operation_id AND command.action='revoke' AND command.grant_id=NEW.grant_id
  AND command.staff_id=grant_row.staff_id AND command.effect=grant_row.effect AND command.scope_kind=grant_row.scope_kind
  AND command.resource_id IS grant_row.resource_id AND command.resulting_generation=NEW.revoked_generation)
BEGIN SELECT RAISE(ABORT,'native billing permission revoke is not exact'); END;

CREATE TRIGGER operations_portal_native_billing_permission_generation_guard BEFORE UPDATE
ON operations_portal_native_billing_permission_generations
WHEN NEW.staff_id<>OLD.staff_id OR NEW.generation<>OLD.generation+1
BEGIN SELECT RAISE(ABORT,'native billing permission generation transition is invalid'); END;
CREATE TRIGGER operations_portal_native_billing_permission_commands_no_update BEFORE UPDATE ON operations_portal_native_billing_permission_commands BEGIN SELECT RAISE(ABORT,'native billing permission command is immutable'); END;
CREATE TRIGGER operations_portal_native_billing_permission_commands_no_delete BEFORE DELETE ON operations_portal_native_billing_permission_commands BEGIN SELECT RAISE(ABORT,'native billing permission command is durable'); END;
CREATE TRIGGER operations_portal_native_billing_permissions_no_update BEFORE UPDATE ON operations_portal_native_billing_permissions BEGIN SELECT RAISE(ABORT,'native billing permission is immutable'); END;
CREATE TRIGGER operations_portal_native_billing_permissions_no_delete BEFORE DELETE ON operations_portal_native_billing_permissions BEGIN SELECT RAISE(ABORT,'native billing permission is durable'); END;
CREATE TRIGGER operations_portal_native_billing_permission_revocations_no_update BEFORE UPDATE ON operations_portal_native_billing_permission_revocations BEGIN SELECT RAISE(ABORT,'native billing permission revocation is immutable'); END;
CREATE TRIGGER operations_portal_native_billing_permission_revocations_no_delete BEFORE DELETE ON operations_portal_native_billing_permission_revocations BEGIN SELECT RAISE(ABORT,'native billing permission revocation is durable'); END;

CREATE VIEW operations_portal_workspace_effective_billing_permissions AS
SELECT grant_row.staff_id,grant_row.effect,record.record_id
FROM operations_portal_native_billing_permissions grant_row JOIN operations_directory_records record
WHERE grant_row.scope_kind='global' AND NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_permission_revocations revoked
 WHERE revoked.grant_id=grant_row.grant_id)
UNION ALL
SELECT grant_row.staff_id,grant_row.effect,grant_row.resource_id
FROM operations_portal_native_billing_permissions grant_row
WHERE grant_row.scope_kind='resource' AND NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_permission_revocations revoked
 WHERE revoked.grant_id=grant_row.grant_id);

CREATE TABLE operations_portal_native_billing_authority_commands (
  operation_id TEXT PRIMARY KEY,
  request_sha256 TEXT NOT NULL UNIQUE CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  canonical_command_json TEXT NOT NULL CHECK(json_valid(canonical_command_json) AND json_type(canonical_command_json)='object'
    AND length(CAST(canonical_command_json AS BLOB))<=32768),
  action TEXT NOT NULL CHECK(action IN ('billing.grant','billing.revoke')),
  grant_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
  resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1),
  target_id TEXT NOT NULL REFERENCES operations_portal_native_workspace_authority_heads(target_id) ON DELETE RESTRICT,
  target_revision INTEGER NOT NULL CHECK(target_revision>=1),
  client_authority_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  root_kind TEXT NOT NULL CHECK(root_kind IN ('organization','standalone_client')),
  root_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  recipient_binding_id TEXT NOT NULL REFERENCES operations_portal_native_recipient_authority_heads(recipient_binding_id) ON DELETE RESTRICT,
  enrollment_intent_id TEXT NOT NULL, target_client_record_id TEXT NOT NULL,
  issuer TEXT NOT NULL, subject TEXT NOT NULL,
  ownership_epoch INTEGER NOT NULL CHECK(ownership_epoch>=1),
  recipient_grant_revision INTEGER NOT NULL CHECK(recipient_grant_revision>=1),
  recipient_grant_operation_id TEXT NOT NULL,
  recipient_request_fingerprint TEXT NOT NULL CHECK(length(recipient_request_fingerprint)=64 AND recipient_request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  publication_operation_id TEXT NOT NULL REFERENCES operations_portal_workspace_publication_receipts(operation_id) ON DELETE RESTRICT,
  publication_id TEXT NOT NULL, publication_revision INTEGER NOT NULL CHECK(publication_revision>=1),
  publication_source_sequence INTEGER NOT NULL CHECK(publication_source_sequence>=1),
  publication_snapshot_id TEXT NOT NULL,
  publication_snapshot_sha256 TEXT NOT NULL CHECK(length(publication_snapshot_sha256)=64 AND publication_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  publication_request_fingerprint TEXT NOT NULL CHECK(length(publication_request_fingerprint)=64 AND publication_request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  entity_kind TEXT NOT NULL CHECK(entity_kind IN ('organization','client','project')),
  native_entity_id TEXT NOT NULL,
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL, actor_admission_version INTEGER NOT NULL CHECK(actor_admission_version>=1),
  actor_profile_version INTEGER NOT NULL CHECK(actor_profile_version>=1),
  actor_grant_generation INTEGER NOT NULL CHECK(actor_grant_generation>=1),
  actor_verified_until TEXT NOT NULL CHECK(length(actor_verified_until)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',actor_verified_until) IS actor_verified_until),
  expires_at TEXT CHECK(expires_at IS NULL OR (length(expires_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS expires_at)),
  observed_at TEXT NOT NULL CHECK(length(observed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',observed_at) IS observed_at),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((action='billing.grant' AND (expires_at IS NULL OR expires_at>observed_at))
    OR (action='billing.revoke' AND expires_at IS NULL)),
  CHECK((entity_kind='organization' AND root_kind='organization' AND native_entity_id=root_record_id)
    OR (entity_kind='client' AND native_entity_id=target_client_record_id)
    OR entity_kind='project')
);
CREATE UNIQUE INDEX operations_portal_native_billing_operation_per_revision
 ON operations_portal_native_billing_authority_commands(grant_id,resulting_revision);

CREATE TABLE operations_portal_native_billing_authority_outbox (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_billing_authority_commands(operation_id) ON DELETE RESTRICT,
  request_sha256 TEXT NOT NULL, canonical_wire_json TEXT NOT NULL CHECK(json_valid(canonical_wire_json)
    AND json_type(canonical_wire_json)='object' AND length(CAST(canonical_wire_json AS BLOB))<=32768),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','acknowledged','dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), available_at INTEGER NOT NULL DEFAULT(unixepoch()*1000),
  lease_token TEXT, lease_expires_at INTEGER, acknowledged_claim_token TEXT, last_error_code TEXT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((state='claimed' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND acknowledged_claim_token IS NULL)
    OR (state='acknowledged' AND lease_token IS NULL AND lease_expires_at IS NULL AND acknowledged_claim_token IS NOT NULL)
    OR (state IN ('pending','dead') AND lease_token IS NULL AND lease_expires_at IS NULL AND acknowledged_claim_token IS NULL))
);

CREATE TABLE operations_portal_native_billing_authority_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_billing_authority_outbox(operation_id) ON DELETE RESTRICT,
  request_sha256 TEXT NOT NULL, grant_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL CHECK(resulting_revision>=1),
  resulting_state TEXT NOT NULL CHECK(resulting_state IN ('active','revoked')),
  acknowledged_claim_token TEXT NOT NULL UNIQUE,
  recorded_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE operations_portal_native_billing_grant_finalizations (
  finalization_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_billing_authority_receipts(operation_id) ON DELETE RESTRICT,
  request_sha256 TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  current_target_revision INTEGER NOT NULL CHECK(current_target_revision>=1),
  current_ownership_epoch INTEGER NOT NULL CHECK(current_ownership_epoch>=1),
  current_recipient_grant_revision INTEGER NOT NULL CHECK(current_recipient_grant_revision>=1),
  current_recipient_grant_operation_id TEXT NOT NULL,
  current_publication_operation_id TEXT NOT NULL,
  current_publication_revision INTEGER NOT NULL CHECK(current_publication_revision>=1),
  current_publication_source_sequence INTEGER NOT NULL CHECK(current_publication_source_sequence>=1),
  current_publication_snapshot_id TEXT NOT NULL,
  current_publication_snapshot_sha256 TEXT NOT NULL CHECK(length(current_publication_snapshot_sha256)=64
    AND current_publication_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL,
  actor_admission_version INTEGER NOT NULL CHECK(actor_admission_version>=1),
  actor_profile_version INTEGER NOT NULL CHECK(actor_profile_version>=1),
  actor_grant_generation INTEGER NOT NULL CHECK(actor_grant_generation>=1),
  actor_verified_until TEXT NOT NULL CHECK(length(actor_verified_until)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',actor_verified_until) IS actor_verified_until),
  observed_at TEXT NOT NULL CHECK(length(observed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',observed_at) IS observed_at),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE operations_portal_native_billing_authority_heads (
  grant_id TEXT PRIMARY KEY, recipient_binding_id TEXT NOT NULL, entity_kind TEXT NOT NULL,
  native_entity_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')), expires_at TEXT,
  latest_grant_finalization_id TEXT NOT NULL REFERENCES operations_portal_native_billing_grant_finalizations(finalization_id) ON DELETE RESTRICT,
  creation_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_billing_authority_receipts(operation_id) ON DELETE RESTRICT,
  latest_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_billing_authority_receipts(operation_id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(recipient_binding_id,entity_kind,native_entity_id)
);

-- A command is admissible only against the exact current native home,
-- publication and entity ownership, with a fresh deny-aware billing grant.
-- Split admission into bounded guards for D1.
CREATE TRIGGER operations_portal_native_billing_command_lineage_guard BEFORE INSERT
ON operations_portal_native_billing_authority_commands
WHEN (NEW.action='billing.grant' AND NOT EXISTS(
 SELECT 1 FROM operations_portal_native_workspace_authority_heads workspace
 JOIN operations_portal_native_recipient_authority_heads recipient ON recipient.target_id=workspace.target_id
 JOIN operations_portal_native_authority_receipts recipient_receipt ON recipient_receipt.operation_id=recipient.latest_operation_id
 JOIN client_onboarding_recipient_identity_bindings binding ON binding.binding_id=recipient.recipient_binding_id
 JOIN operations_portal_workspace_publication_heads publication ON publication.target_id=workspace.target_id
 JOIN operations_portal_workspace_publication_receipts publication_receipt ON publication_receipt.operation_id=NEW.publication_operation_id
 WHERE workspace.target_id=NEW.target_id AND workspace.state='active' AND workspace.target_revision=NEW.target_revision
  AND workspace.client_authority_id=NEW.client_authority_id AND workspace.workspace_id=NEW.workspace_id
  AND workspace.root_kind=NEW.root_kind AND workspace.root_record_id=NEW.root_record_id AND workspace.ownership_epoch=NEW.ownership_epoch
  AND recipient.recipient_binding_id=NEW.recipient_binding_id AND recipient.state='active'
  AND recipient.enrollment_intent_id=NEW.enrollment_intent_id AND recipient.target_client_record_id=NEW.target_client_record_id
  AND recipient.issuer=NEW.issuer AND recipient.subject=NEW.subject AND recipient.ownership_epoch=NEW.ownership_epoch
  AND recipient.grant_revision=NEW.recipient_grant_revision AND recipient.latest_operation_id=NEW.recipient_grant_operation_id
  AND recipient_receipt.request_fingerprint=NEW.recipient_request_fingerprint AND binding.status='active'
  AND (binding.expires_at IS NULL OR binding.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  AND binding.target_client_record_id=NEW.target_client_record_id AND binding.access_issuer=NEW.issuer AND binding.access_subject=NEW.subject
  AND publication.latest_operation_id=NEW.publication_operation_id AND publication_receipt.publication_id=NEW.publication_id
  AND publication_receipt.operation_fingerprint=NEW.publication_request_fingerprint
  AND publication.publication_revision=NEW.publication_revision AND publication.source_sequence=NEW.publication_source_sequence
  AND publication.snapshot_id=NEW.publication_snapshot_id AND publication.snapshot_sha256=NEW.publication_snapshot_sha256))
 OR (NEW.action='billing.revoke' AND NOT EXISTS(
 SELECT 1 FROM operations_portal_native_billing_authority_heads head
 JOIN operations_portal_native_billing_authority_receipts receipt ON receipt.operation_id=head.latest_operation_id
 JOIN operations_portal_native_billing_authority_commands prior ON prior.operation_id=receipt.operation_id
 WHERE head.grant_id=NEW.grant_id AND head.state='active' AND head.revision=NEW.expected_revision
  AND receipt.resulting_state='active' AND prior.action='billing.grant'
  AND prior.target_id=NEW.target_id AND prior.target_revision=NEW.target_revision
  AND prior.client_authority_id=NEW.client_authority_id AND prior.workspace_id=NEW.workspace_id
  AND prior.root_kind=NEW.root_kind AND prior.root_record_id=NEW.root_record_id
  AND prior.recipient_binding_id=NEW.recipient_binding_id AND prior.enrollment_intent_id=NEW.enrollment_intent_id
  AND prior.target_client_record_id=NEW.target_client_record_id AND prior.issuer=NEW.issuer AND prior.subject=NEW.subject
  AND prior.ownership_epoch=NEW.ownership_epoch AND prior.recipient_grant_revision=NEW.recipient_grant_revision
  AND prior.recipient_grant_operation_id=NEW.recipient_grant_operation_id
  AND prior.recipient_request_fingerprint=NEW.recipient_request_fingerprint
  AND prior.publication_operation_id=NEW.publication_operation_id AND prior.publication_id=NEW.publication_id
  AND prior.publication_revision=NEW.publication_revision AND prior.publication_source_sequence=NEW.publication_source_sequence
  AND prior.publication_snapshot_id=NEW.publication_snapshot_id
  AND prior.publication_snapshot_sha256=NEW.publication_snapshot_sha256
  AND prior.publication_request_fingerprint=NEW.publication_request_fingerprint
  AND prior.entity_kind=NEW.entity_kind AND prior.native_entity_id=NEW.native_entity_id))
BEGIN SELECT RAISE(ABORT,'native billing command lineage is not current and exact'); END;
CREATE TRIGGER operations_portal_native_billing_command_actor_guard BEFORE INSERT
ON operations_portal_native_billing_authority_commands
WHEN NOT EXISTS(SELECT 1 FROM native_staff_admissions admission
 JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
 JOIN operations_portal_native_billing_permission_generations generation ON generation.staff_id=admission.staff_id
 JOIN staff_users staff ON staff.id=admission.staff_id
 WHERE admission.staff_id=NEW.actor_staff_id AND admission.active=1 AND admission.bound_access_subject=NEW.actor_access_subject
  AND admission.version=NEW.actor_admission_version AND profile.version=NEW.actor_profile_version
  AND staff.status='active' AND staff.access_subject=NEW.actor_access_subject AND generation.generation=NEW.actor_grant_generation
  AND NEW.actor_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND NEW.observed_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND NEW.observed_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes'))
 OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_billing_permissions permission
   WHERE permission.staff_id=NEW.actor_staff_id AND permission.effect='allow' AND permission.record_id=NEW.root_record_id)
 OR EXISTS(SELECT 1 FROM operations_portal_workspace_effective_billing_permissions permission
   WHERE permission.staff_id=NEW.actor_staff_id AND permission.effect='deny' AND permission.record_id=NEW.root_record_id)
BEGIN SELECT RAISE(ABORT,'native billing command actor is not currently authorized'); END;

CREATE TRIGGER operations_portal_native_billing_command_entity_guard BEFORE INSERT
ON operations_portal_native_billing_authority_commands
WHEN NEW.action='billing.grant' AND NOT ((NEW.entity_kind='organization' AND NEW.root_kind='organization' AND NEW.native_entity_id=NEW.root_record_id)
 OR (NEW.entity_kind='client' AND NEW.native_entity_id=NEW.target_client_record_id)
 OR (NEW.entity_kind='project' AND EXISTS(SELECT 1 FROM operations_portal_workspace_publication_project_sources source
   JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.checkpoint_id=source.checkpoint_id
   JOIN operations_shared_projects project ON project.external_project_id=source.external_project_id
   WHERE snapshot.snapshot_id=NEW.publication_snapshot_id AND source.external_project_id=NEW.native_entity_id
    AND source.project_version=project.current_version AND source.archived=project.archived
    AND source.organization_record_id IS project.organization_record_id AND source.client_record_id IS project.client_record_id
    AND ((NEW.root_kind='organization' AND project.organization_record_id=NEW.root_record_id)
     OR (NEW.root_kind='standalone_client' AND project.organization_record_id IS NULL
      AND project.client_record_id=NEW.target_client_record_id)))))
BEGIN SELECT RAISE(ABORT,'native billing entity is not current and exact'); END;

CREATE TRIGGER operations_portal_native_billing_command_cas_guard BEFORE INSERT
ON operations_portal_native_billing_authority_commands
WHEN NOT ((NEW.expected_revision=0 AND NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_authority_heads head
 WHERE head.grant_id=NEW.grant_id)) OR EXISTS(SELECT 1 FROM operations_portal_native_billing_authority_heads head
 WHERE head.grant_id=NEW.grant_id AND head.recipient_binding_id=NEW.recipient_binding_id
  AND head.entity_kind=NEW.entity_kind AND head.native_entity_id=NEW.native_entity_id AND head.revision=NEW.expected_revision
  AND (NEW.action='billing.grant' OR head.state='active')))
BEGIN SELECT RAISE(ABORT,'native billing command revision is stale'); END;

-- Keep the exact-byte audit bounded below D1's expression-depth limit.
CREATE TRIGGER operations_portal_native_billing_command_json_guard BEFORE INSERT
ON operations_portal_native_billing_authority_commands
WHEN NEW.canonical_command_json<>json_object(
 'protocol','operations-portal-native-billing-authority','protocolVersion',1,'action',NEW.action,'operationId',NEW.operation_id,
 'authority',json_object('grantId',NEW.grant_id,'expectedRevision',CAST(NEW.expected_revision AS TEXT),
   'resultingRevision',CAST(NEW.resulting_revision AS TEXT)),
 'workspace',json_object('targetId',NEW.target_id,'targetRevision',CAST(NEW.target_revision AS TEXT),
   'clientAuthorityId',NEW.client_authority_id,'workspaceId',NEW.workspace_id,'rootKind',NEW.root_kind,'rootRecordId',NEW.root_record_id),
 'recipient',json_object('recipientBindingId',NEW.recipient_binding_id,'enrollmentIntentId',NEW.enrollment_intent_id,
   'targetClientRecordId',NEW.target_client_record_id,'issuer',NEW.issuer,'subject',NEW.subject,
   'ownershipEpoch',CAST(NEW.ownership_epoch AS TEXT),'grantRevision',CAST(NEW.recipient_grant_revision AS TEXT),
   'grantOperationId',NEW.recipient_grant_operation_id,'requestFingerprint',NEW.recipient_request_fingerprint),
 'publication',json_object('operationId',NEW.publication_operation_id,'publicationId',NEW.publication_id,
   'revision',CAST(NEW.publication_revision AS TEXT),'sourceSequence',CAST(NEW.publication_source_sequence AS TEXT),
   'snapshotId',NEW.publication_snapshot_id,'snapshotSha256',NEW.publication_snapshot_sha256,
   'requestFingerprint',NEW.publication_request_fingerprint),
 'entity',json_object('kind',NEW.entity_kind,'nativeId',NEW.native_entity_id),
 'actorProof',json_object('staffId',NEW.actor_staff_id,'verifiedAccessSubject',NEW.actor_access_subject,
   'admissionVersion',CAST(NEW.actor_admission_version AS TEXT),'profileVersion',CAST(NEW.actor_profile_version AS TEXT),
   'grantGeneration',CAST(NEW.actor_grant_generation AS TEXT),'verifiedUntil',NEW.actor_verified_until),
 'expiresAt',NEW.expires_at,'observedAt',NEW.observed_at)
BEGIN SELECT RAISE(ABORT,'native billing command bytes are not exact'); END;

CREATE TRIGGER operations_portal_native_billing_outbox_guard BEFORE INSERT
ON operations_portal_native_billing_authority_outbox
WHEN NEW.state<>'pending' OR NEW.attempts<>0 OR NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
 OR NEW.acknowledged_claim_token IS NOT NULL OR NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_authority_commands command
 WHERE command.operation_id=NEW.operation_id AND command.request_sha256=NEW.request_sha256
  AND command.canonical_command_json=NEW.canonical_wire_json)
BEGIN SELECT RAISE(ABORT,'native billing outbox is not exact'); END;

CREATE TRIGGER operations_portal_native_billing_outbox_transition_guard BEFORE UPDATE
ON operations_portal_native_billing_authority_outbox
WHEN NEW.operation_id<>OLD.operation_id OR NEW.request_sha256<>OLD.request_sha256
 OR NEW.canonical_wire_json<>OLD.canonical_wire_json OR NEW.created_at<>OLD.created_at
 OR NOT ((OLD.state='pending' AND NEW.state='claimed' AND NEW.attempts=OLD.attempts+1
      AND NEW.lease_token IS NOT NULL AND NEW.lease_expires_at>unixepoch()*1000
      AND NEW.acknowledged_claim_token IS NULL)
   OR (OLD.state='claimed' AND NEW.state='acknowledged' AND NEW.attempts=OLD.attempts
      AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL
      AND NEW.acknowledged_claim_token=OLD.lease_token)
   OR (OLD.state='claimed' AND NEW.state='dead' AND NEW.attempts=OLD.attempts
      AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL AND NEW.acknowledged_claim_token IS NULL))
BEGIN SELECT RAISE(ABORT,'native billing outbox transition is invalid'); END;

CREATE TRIGGER operations_portal_native_billing_receipt_guard BEFORE INSERT
ON operations_portal_native_billing_authority_receipts
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_authority_outbox outbox
 JOIN operations_portal_native_billing_authority_commands command ON command.operation_id=outbox.operation_id
 WHERE outbox.operation_id=NEW.operation_id AND outbox.state='acknowledged'
  AND outbox.request_sha256=NEW.request_sha256 AND command.grant_id=NEW.grant_id
  AND command.resulting_revision=NEW.resulting_revision
  AND outbox.acknowledged_claim_token=NEW.acknowledged_claim_token
  AND NEW.resulting_state=CASE command.action WHEN 'billing.grant' THEN 'active' ELSE 'revoked' END)
BEGIN SELECT RAISE(ABORT,'native billing receipt is not exact'); END;

CREATE TRIGGER operations_portal_native_billing_finalization_lineage_guard BEFORE INSERT
ON operations_portal_native_billing_grant_finalizations
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_authority_receipts receipt
 JOIN operations_portal_native_billing_authority_commands command ON command.operation_id=receipt.operation_id
 JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=command.target_id
 JOIN operations_portal_native_recipient_authority_heads recipient ON recipient.target_id=workspace.target_id
 JOIN client_onboarding_recipient_identity_bindings binding ON binding.binding_id=recipient.recipient_binding_id
 JOIN operations_portal_workspace_publication_heads publication ON publication.target_id=workspace.target_id
 WHERE receipt.operation_id=NEW.operation_id AND receipt.resulting_state='active' AND command.action='billing.grant'
  AND command.request_sha256=NEW.request_sha256 AND command.grant_id=NEW.grant_id
  AND (command.expires_at IS NULL OR command.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  AND workspace.state='active' AND workspace.target_revision=NEW.current_target_revision
  AND workspace.client_authority_id=command.client_authority_id AND workspace.workspace_id=command.workspace_id
  AND workspace.root_kind=command.root_kind AND workspace.root_record_id=command.root_record_id
  AND workspace.ownership_epoch=NEW.current_ownership_epoch
  AND recipient.recipient_binding_id=command.recipient_binding_id AND recipient.state='active'
  AND recipient.enrollment_intent_id=command.enrollment_intent_id
  AND recipient.target_client_record_id=command.target_client_record_id
  AND recipient.issuer=command.issuer AND recipient.subject=command.subject
  AND recipient.ownership_epoch=NEW.current_ownership_epoch
  AND recipient.grant_revision=NEW.current_recipient_grant_revision
  AND recipient.latest_operation_id=NEW.current_recipient_grant_operation_id
  AND binding.status='active' AND (binding.expires_at IS NULL OR binding.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  AND binding.target_client_record_id=recipient.target_client_record_id
  AND binding.access_issuer=recipient.issuer AND binding.access_subject=recipient.subject
  AND publication.latest_operation_id=NEW.current_publication_operation_id
  AND publication.publication_revision=NEW.current_publication_revision
  AND publication.source_sequence=NEW.current_publication_source_sequence
  AND publication.snapshot_id=NEW.current_publication_snapshot_id
  AND publication.snapshot_sha256=NEW.current_publication_snapshot_sha256)
BEGIN SELECT RAISE(ABORT,'native billing grant finalization lineage is not current'); END;

CREATE TRIGGER operations_portal_native_billing_finalization_actor_guard BEFORE INSERT
ON operations_portal_native_billing_grant_finalizations
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_authority_commands command
 JOIN native_staff_admissions admission ON admission.staff_id=NEW.actor_staff_id
 JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
 JOIN operations_portal_native_billing_permission_generations generation ON generation.staff_id=admission.staff_id
 JOIN staff_users staff ON staff.id=admission.staff_id
 WHERE command.operation_id=NEW.operation_id AND admission.active=1
  AND admission.bound_access_subject=NEW.actor_access_subject AND admission.version=NEW.actor_admission_version
  AND profile.version=NEW.actor_profile_version AND staff.status='active' AND staff.access_subject=NEW.actor_access_subject
  AND generation.generation=NEW.actor_grant_generation AND NEW.actor_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND NEW.observed_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND NEW.observed_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes')
  AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_billing_permissions permission
    WHERE permission.staff_id=NEW.actor_staff_id AND permission.effect='allow' AND permission.record_id=command.root_record_id)
  AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_billing_permissions permission
    WHERE permission.staff_id=NEW.actor_staff_id AND permission.effect='deny' AND permission.record_id=command.root_record_id))
BEGIN SELECT RAISE(ABORT,'native billing grant finalization actor is not current'); END;

CREATE TRIGGER operations_portal_native_billing_finalization_entity_guard BEFORE INSERT
ON operations_portal_native_billing_grant_finalizations
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_authority_commands command
 JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=command.target_id
 JOIN operations_portal_native_recipient_authority_heads recipient ON recipient.target_id=workspace.target_id
 WHERE command.operation_id=NEW.operation_id AND ((command.entity_kind='organization'
    AND workspace.root_kind='organization' AND command.native_entity_id=workspace.root_record_id)
  OR (command.entity_kind='client' AND command.native_entity_id=recipient.target_client_record_id)
  OR (command.entity_kind='project' AND EXISTS(SELECT 1 FROM operations_portal_workspace_publication_project_sources source
    JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.checkpoint_id=source.checkpoint_id
    JOIN operations_shared_projects project ON project.external_project_id=source.external_project_id
    WHERE snapshot.snapshot_id=NEW.current_publication_snapshot_id AND source.external_project_id=command.native_entity_id
     AND source.project_version=project.current_version AND source.archived=project.archived
     AND source.organization_record_id IS project.organization_record_id AND source.client_record_id IS project.client_record_id
     AND ((workspace.root_kind='organization' AND project.organization_record_id=workspace.root_record_id)
      OR (workspace.root_kind='standalone_client' AND project.organization_record_id IS NULL
       AND project.client_record_id=recipient.target_client_record_id))))))
BEGIN SELECT RAISE(ABORT,'native billing grant finalization entity is not current'); END;

CREATE VIEW operations_portal_native_billing_current_finalization_actor AS
SELECT finalization.finalization_id
FROM operations_portal_native_billing_grant_finalizations finalization
JOIN operations_portal_native_billing_authority_commands command ON command.operation_id=finalization.operation_id
JOIN native_staff_admissions admission ON admission.staff_id=finalization.actor_staff_id
JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
JOIN operations_portal_native_billing_permission_generations generation ON generation.staff_id=admission.staff_id
JOIN staff_users staff ON staff.id=admission.staff_id
WHERE admission.active=1 AND admission.bound_access_subject=finalization.actor_access_subject
 AND admission.version=finalization.actor_admission_version AND profile.version=finalization.actor_profile_version
 AND staff.status='active' AND staff.access_subject=finalization.actor_access_subject
 AND generation.generation=finalization.actor_grant_generation
 AND finalization.actor_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_billing_permissions permission
   WHERE permission.staff_id=finalization.actor_staff_id AND permission.effect='allow' AND permission.record_id=command.root_record_id)
 AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_billing_permissions permission
   WHERE permission.staff_id=finalization.actor_staff_id AND permission.effect='deny' AND permission.record_id=command.root_record_id);

-- Action-time session freshness above gates finalization and head activation.
-- A successfully activated durable grant remains readable after that session
-- expires, while current staff/admission/profile/generation and deny-aware
-- permission state continue to be required.
CREATE VIEW operations_portal_native_billing_effective_finalization_actor AS
SELECT finalization.finalization_id
FROM operations_portal_native_billing_grant_finalizations finalization
JOIN operations_portal_native_billing_authority_commands command ON command.operation_id=finalization.operation_id
JOIN native_staff_admissions admission ON admission.staff_id=finalization.actor_staff_id
JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
JOIN operations_portal_native_billing_permission_generations generation ON generation.staff_id=admission.staff_id
JOIN staff_users staff ON staff.id=admission.staff_id
WHERE admission.active=1 AND admission.bound_access_subject=finalization.actor_access_subject
 AND admission.version=finalization.actor_admission_version AND profile.version=finalization.actor_profile_version
 AND staff.status='active' AND staff.access_subject=finalization.actor_access_subject
 AND generation.generation=finalization.actor_grant_generation
 AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_billing_permissions permission
   WHERE permission.staff_id=finalization.actor_staff_id AND permission.effect='allow' AND permission.record_id=command.root_record_id)
 AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_billing_permissions permission
   WHERE permission.staff_id=finalization.actor_staff_id AND permission.effect='deny' AND permission.record_id=command.root_record_id);

CREATE VIEW operations_portal_native_billing_current_finalization_lineage AS
SELECT finalization.finalization_id
FROM operations_portal_native_billing_grant_finalizations finalization
JOIN operations_portal_native_billing_authority_commands command ON command.operation_id=finalization.operation_id
JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=command.target_id
JOIN operations_portal_native_recipient_authority_heads recipient ON recipient.target_id=workspace.target_id
JOIN client_onboarding_recipient_identity_bindings binding ON binding.binding_id=recipient.recipient_binding_id
JOIN operations_portal_workspace_publication_heads publication ON publication.target_id=workspace.target_id
WHERE workspace.state='active' AND workspace.target_revision=finalization.current_target_revision
 AND workspace.client_authority_id=command.client_authority_id AND workspace.workspace_id=command.workspace_id
 AND workspace.root_kind=command.root_kind AND workspace.root_record_id=command.root_record_id
 AND workspace.ownership_epoch=finalization.current_ownership_epoch
 AND recipient.recipient_binding_id=command.recipient_binding_id AND recipient.state='active'
 AND recipient.enrollment_intent_id=command.enrollment_intent_id
 AND recipient.target_client_record_id=command.target_client_record_id AND recipient.issuer=command.issuer
 AND recipient.subject=command.subject AND recipient.ownership_epoch=finalization.current_ownership_epoch
 AND recipient.grant_revision=finalization.current_recipient_grant_revision
 AND recipient.latest_operation_id=finalization.current_recipient_grant_operation_id
 AND binding.status='active' AND (binding.expires_at IS NULL OR binding.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 AND binding.target_client_record_id=recipient.target_client_record_id
 AND binding.access_issuer=recipient.issuer AND binding.access_subject=recipient.subject
 AND publication.latest_operation_id=finalization.current_publication_operation_id
 AND publication.publication_revision=finalization.current_publication_revision
 AND publication.source_sequence=finalization.current_publication_source_sequence
 AND publication.snapshot_id=finalization.current_publication_snapshot_id
 AND publication.snapshot_sha256=finalization.current_publication_snapshot_sha256;

CREATE VIEW operations_portal_native_billing_current_finalization_entity AS
SELECT finalization.finalization_id
FROM operations_portal_native_billing_grant_finalizations finalization
JOIN operations_portal_native_billing_authority_commands command ON command.operation_id=finalization.operation_id
JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=command.target_id
JOIN operations_portal_native_recipient_authority_heads recipient ON recipient.target_id=workspace.target_id
WHERE (command.entity_kind='organization' AND workspace.root_kind='organization' AND command.native_entity_id=workspace.root_record_id)
 OR (command.entity_kind='client' AND command.native_entity_id=recipient.target_client_record_id)
 OR (command.entity_kind='project' AND EXISTS(SELECT 1 FROM operations_portal_workspace_publication_project_sources source
   JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.checkpoint_id=source.checkpoint_id
   JOIN operations_shared_projects project ON project.external_project_id=source.external_project_id
   WHERE snapshot.snapshot_id=finalization.current_publication_snapshot_id AND source.external_project_id=command.native_entity_id
    AND source.project_version=project.current_version AND source.archived=project.archived
    AND source.organization_record_id IS project.organization_record_id AND source.client_record_id IS project.client_record_id
    AND ((workspace.root_kind='organization' AND project.organization_record_id=workspace.root_record_id)
     OR (workspace.root_kind='standalone_client' AND project.organization_record_id IS NULL
      AND project.client_record_id=recipient.target_client_record_id))));

CREATE TRIGGER operations_portal_native_billing_head_activation_current_insert BEFORE INSERT
ON operations_portal_native_billing_authority_heads
WHEN NEW.state='active' AND (NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_current_finalization_actor proof
    WHERE proof.finalization_id=NEW.latest_grant_finalization_id)
 OR NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_current_finalization_lineage proof
    WHERE proof.finalization_id=NEW.latest_grant_finalization_id)
 OR NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_current_finalization_entity proof
    WHERE proof.finalization_id=NEW.latest_grant_finalization_id))
BEGIN SELECT RAISE(ABORT,'native billing head activation authority is not current'); END;

CREATE TRIGGER operations_portal_native_billing_head_activation_current_update BEFORE UPDATE
ON operations_portal_native_billing_authority_heads
WHEN NEW.state='active' AND (NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_current_finalization_actor proof
    WHERE proof.finalization_id=NEW.latest_grant_finalization_id)
 OR NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_current_finalization_lineage proof
    WHERE proof.finalization_id=NEW.latest_grant_finalization_id)
 OR NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_current_finalization_entity proof
    WHERE proof.finalization_id=NEW.latest_grant_finalization_id))
BEGIN SELECT RAISE(ABORT,'native billing head activation authority is not current'); END;

CREATE TRIGGER operations_portal_native_billing_head_insert_guard BEFORE INSERT
ON operations_portal_native_billing_authority_heads
WHEN NEW.revision<>1 OR NEW.state<>'active' OR NOT EXISTS(
 SELECT 1 FROM operations_portal_native_billing_authority_receipts receipt
 JOIN operations_portal_native_billing_authority_commands command ON command.operation_id=receipt.operation_id
 WHERE receipt.operation_id=NEW.creation_operation_id AND receipt.operation_id=NEW.latest_operation_id
  AND command.action='billing.grant' AND command.grant_id=NEW.grant_id AND command.expected_revision=0
  AND command.resulting_revision=NEW.revision AND command.recipient_binding_id=NEW.recipient_binding_id
  AND command.entity_kind=NEW.entity_kind AND command.native_entity_id=NEW.native_entity_id
  AND command.expires_at IS NEW.expires_at AND receipt.resulting_state='active'
  AND EXISTS(SELECT 1 FROM operations_portal_native_billing_grant_finalizations finalization
    WHERE finalization.finalization_id=NEW.latest_grant_finalization_id AND finalization.operation_id=receipt.operation_id
      AND finalization.grant_id=NEW.grant_id AND finalization.actor_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'native billing head insert is not acknowledged'); END;

CREATE TRIGGER operations_portal_native_billing_head_update_guard BEFORE UPDATE
ON operations_portal_native_billing_authority_heads
WHEN NEW.grant_id<>OLD.grant_id OR NEW.recipient_binding_id<>OLD.recipient_binding_id
 OR NEW.entity_kind<>OLD.entity_kind OR NEW.native_entity_id<>OLD.native_entity_id
 OR NEW.creation_operation_id<>OLD.creation_operation_id OR NEW.revision<>OLD.revision+1
 OR NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_authority_receipts receipt
  JOIN operations_portal_native_billing_authority_commands command ON command.operation_id=receipt.operation_id
  WHERE receipt.operation_id=NEW.latest_operation_id AND command.grant_id=OLD.grant_id
   AND command.expected_revision=OLD.revision AND command.resulting_revision=NEW.revision
   AND command.recipient_binding_id=OLD.recipient_binding_id AND command.entity_kind=OLD.entity_kind
   AND command.native_entity_id=OLD.native_entity_id AND command.expires_at IS NEW.expires_at
   AND NEW.state=CASE command.action WHEN 'billing.grant' THEN 'active' ELSE 'revoked' END
   AND receipt.resulting_state=NEW.state
   AND ((command.action='billing.grant' AND EXISTS(SELECT 1 FROM operations_portal_native_billing_grant_finalizations finalization
      WHERE finalization.finalization_id=NEW.latest_grant_finalization_id AND finalization.operation_id=receipt.operation_id
       AND finalization.grant_id=NEW.grant_id AND finalization.actor_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
    OR (command.action='billing.revoke' AND NEW.latest_grant_finalization_id=OLD.latest_grant_finalization_id)))
BEGIN SELECT RAISE(ABORT,'native billing head transition is not acknowledged'); END;

CREATE VIEW operations_portal_native_billing_live_authority AS
SELECT head.grant_id,head.recipient_binding_id,head.entity_kind,head.native_entity_id,head.revision,head.expires_at
FROM operations_portal_native_billing_authority_heads head
JOIN operations_portal_native_billing_authority_receipts receipt ON receipt.operation_id=head.latest_operation_id
JOIN operations_portal_native_billing_authority_commands command ON command.operation_id=receipt.operation_id
JOIN operations_portal_native_billing_grant_finalizations finalization
 ON finalization.finalization_id=head.latest_grant_finalization_id
JOIN operations_portal_native_recipient_authority_heads recipient ON recipient.recipient_binding_id=head.recipient_binding_id
JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=recipient.target_id
JOIN client_onboarding_recipient_identity_bindings binding ON binding.binding_id=recipient.recipient_binding_id
 AND binding.target_client_record_id=recipient.target_client_record_id AND binding.access_issuer=recipient.issuer
 AND binding.access_subject=recipient.subject
JOIN operations_portal_workspace_publication_heads publication ON publication.target_id=workspace.target_id
WHERE head.state='active' AND (head.expires_at IS NULL OR head.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 AND EXISTS(SELECT 1 FROM operations_portal_native_billing_effective_finalization_actor proof
   WHERE proof.finalization_id=head.latest_grant_finalization_id)
 AND EXISTS(SELECT 1 FROM operations_portal_native_billing_current_finalization_lineage proof
   WHERE proof.finalization_id=head.latest_grant_finalization_id)
 AND EXISTS(SELECT 1 FROM operations_portal_native_billing_current_finalization_entity proof
   WHERE proof.finalization_id=head.latest_grant_finalization_id)
 AND receipt.resulting_state='active' AND command.action='billing.grant'
 AND recipient.state='active' AND workspace.state='active' AND binding.status='active'
 AND (binding.expires_at IS NULL OR binding.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 AND command.target_id=workspace.target_id AND finalization.current_target_revision=workspace.target_revision
 AND command.client_authority_id=workspace.client_authority_id AND command.workspace_id=workspace.workspace_id
 AND command.root_kind=workspace.root_kind AND command.root_record_id=workspace.root_record_id
 AND finalization.current_ownership_epoch=workspace.ownership_epoch AND finalization.current_ownership_epoch=recipient.ownership_epoch
 AND command.recipient_binding_id=recipient.recipient_binding_id AND command.enrollment_intent_id=recipient.enrollment_intent_id
 AND command.target_client_record_id=recipient.target_client_record_id AND command.issuer=recipient.issuer
 AND command.subject=recipient.subject AND finalization.current_recipient_grant_revision=recipient.grant_revision
 AND finalization.current_recipient_grant_operation_id=recipient.latest_operation_id
 AND finalization.current_publication_operation_id=publication.latest_operation_id
 AND finalization.current_publication_revision=publication.publication_revision
 AND finalization.current_publication_source_sequence=publication.source_sequence
 AND finalization.current_publication_snapshot_id=publication.snapshot_id
 AND finalization.current_publication_snapshot_sha256=publication.snapshot_sha256
 AND ((command.entity_kind='organization' AND workspace.root_kind='organization'
      AND command.native_entity_id=workspace.root_record_id)
   OR (command.entity_kind='client' AND command.native_entity_id=recipient.target_client_record_id)
   OR (command.entity_kind='project' AND EXISTS(SELECT 1 FROM operations_portal_workspace_publication_project_sources source
     JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.checkpoint_id=source.checkpoint_id
     JOIN operations_shared_projects project ON project.external_project_id=source.external_project_id
     WHERE snapshot.snapshot_id=finalization.current_publication_snapshot_id AND source.external_project_id=command.native_entity_id
      AND source.project_version=project.current_version AND source.archived=project.archived
      AND source.organization_record_id IS project.organization_record_id AND source.client_record_id IS project.client_record_id
      AND ((workspace.root_kind='organization' AND project.organization_record_id=workspace.root_record_id)
       OR (workspace.root_kind='standalone_client' AND project.organization_record_id IS NULL
        AND project.client_record_id=recipient.target_client_record_id)))));

CREATE TRIGGER operations_portal_native_billing_commands_no_update BEFORE UPDATE ON operations_portal_native_billing_authority_commands BEGIN SELECT RAISE(ABORT,'native billing command is immutable'); END;
CREATE TRIGGER operations_portal_native_billing_commands_no_delete BEFORE DELETE ON operations_portal_native_billing_authority_commands BEGIN SELECT RAISE(ABORT,'native billing command is durable'); END;
CREATE TRIGGER operations_portal_native_billing_outbox_wire_immutable BEFORE UPDATE ON operations_portal_native_billing_authority_outbox
WHEN NEW.operation_id<>OLD.operation_id OR NEW.request_sha256<>OLD.request_sha256 OR NEW.canonical_wire_json<>OLD.canonical_wire_json
BEGIN SELECT RAISE(ABORT,'native billing outbox wire is immutable'); END;
CREATE TRIGGER operations_portal_native_billing_outbox_no_delete BEFORE DELETE ON operations_portal_native_billing_authority_outbox BEGIN SELECT RAISE(ABORT,'native billing outbox is durable'); END;
CREATE TRIGGER operations_portal_native_billing_receipts_no_update BEFORE UPDATE ON operations_portal_native_billing_authority_receipts BEGIN SELECT RAISE(ABORT,'native billing receipt is immutable'); END;
CREATE TRIGGER operations_portal_native_billing_receipts_no_delete BEFORE DELETE ON operations_portal_native_billing_authority_receipts BEGIN SELECT RAISE(ABORT,'native billing receipt is durable'); END;
CREATE TRIGGER operations_portal_native_billing_finalizations_no_update BEFORE UPDATE ON operations_portal_native_billing_grant_finalizations BEGIN SELECT RAISE(ABORT,'native billing grant finalization is immutable'); END;
CREATE TRIGGER operations_portal_native_billing_finalizations_no_delete BEFORE DELETE ON operations_portal_native_billing_grant_finalizations BEGIN SELECT RAISE(ABORT,'native billing grant finalization is durable'); END;
CREATE TRIGGER operations_portal_native_billing_heads_no_delete BEFORE DELETE ON operations_portal_native_billing_authority_heads BEGIN SELECT RAISE(ABORT,'native billing head is durable'); END;
