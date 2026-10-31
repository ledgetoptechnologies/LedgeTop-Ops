-- Audited companion request.create authority. This ledger never replaces the
-- v3 recipient-home grant; consumers require an exact current-home join.
CREATE TABLE operations_portal_native_inquiry_capability_commands (
  operation_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES operations_portal_native_recipient_intents(intent_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('grant','revoke')),
  request_fingerprint TEXT NOT NULL UNIQUE CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  canonical_command_json TEXT NOT NULL CHECK(json_valid(canonical_command_json) AND json_type(canonical_command_json)='object'
    AND length(CAST(canonical_command_json AS BLOB))<=16384),
  target_id TEXT NOT NULL REFERENCES operations_portal_workspace_reservation_heads(target_id) ON DELETE RESTRICT,
  target_revision INTEGER NOT NULL CHECK(target_revision>=1),
  client_authority_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  target_client_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  recipient_binding_id TEXT NOT NULL REFERENCES client_onboarding_recipient_identity_bindings(binding_id) ON DELETE RESTRICT,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  base_operation_id TEXT NOT NULL REFERENCES operations_portal_native_authority_commands(operation_id) ON DELETE RESTRICT,
  base_ownership_epoch INTEGER NOT NULL CHECK(base_ownership_epoch>=1),
  base_grant_revision INTEGER NOT NULL CHECK(base_grant_revision>=1),
  publication_operation_id TEXT NOT NULL REFERENCES operations_portal_workspace_publication_commands(operation_id) ON DELETE RESTRICT,
  publication_revision INTEGER NOT NULL CHECK(publication_revision>=1),
  publication_source_sequence INTEGER NOT NULL CHECK(publication_source_sequence>=1),
  publication_snapshot_id TEXT NOT NULL REFERENCES operations_portal_workspace_publication_snapshots(snapshot_id) ON DELETE RESTRICT,
  publication_snapshot_sha256 TEXT NOT NULL CHECK(length(publication_snapshot_sha256)=64 AND publication_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
  resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1),
  permission TEXT NOT NULL CHECK(permission='operations.request.create'),
  expires_at TEXT NOT NULL CHECK(length(expires_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS expires_at),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL,
  actor_admission_version INTEGER NOT NULL CHECK(actor_admission_version>=1),
  actor_profile_version INTEGER NOT NULL CHECK(actor_profile_version>=1),
  actor_grant_generation INTEGER NOT NULL CHECK(actor_grant_generation>=1),
  actor_verified_until TEXT NOT NULL CHECK(length(actor_verified_until)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',actor_verified_until) IS actor_verified_until),
  observed_at TEXT NOT NULL CHECK(length(observed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',observed_at) IS observed_at),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((action='grant' AND expected_revision=0 AND resulting_revision=1)
    OR (action='revoke' AND expected_revision>=1))
);

CREATE TABLE operations_portal_native_inquiry_capability_heads (
  intent_id TEXT PRIMARY KEY REFERENCES operations_portal_native_recipient_intents(intent_id) ON DELETE RESTRICT,
  target_id TEXT NOT NULL REFERENCES operations_portal_workspace_reservation_heads(target_id) ON DELETE RESTRICT,
  recipient_binding_id TEXT NOT NULL REFERENCES client_onboarding_recipient_identity_bindings(binding_id) ON DELETE RESTRICT,
  base_operation_id TEXT NOT NULL REFERENCES operations_portal_native_authority_commands(operation_id) ON DELETE RESTRICT,
  base_ownership_epoch INTEGER NOT NULL CHECK(base_ownership_epoch>=1),
  base_grant_revision INTEGER NOT NULL CHECK(base_grant_revision>=1),
  revision INTEGER NOT NULL CHECK(revision>=1),
  state TEXT NOT NULL CHECK(state IN ('prepared','active','revoked')),
  latest_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_inquiry_capability_commands(operation_id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE operations_portal_native_inquiry_capability_outbox (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_inquiry_capability_commands(operation_id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','prepared','acknowledged','revoked')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  available_at INTEGER NOT NULL DEFAULT(unixepoch()*1000),
  lease_token TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((lease_token IS NULL AND lease_expires_at IS NULL) OR (state='claimed' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE TABLE operations_portal_native_inquiry_capability_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_inquiry_capability_commands(operation_id) ON DELETE RESTRICT,
  request_fingerprint TEXT NOT NULL UNIQUE CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  client_receipt_fingerprint TEXT NOT NULL CHECK(length(client_receipt_fingerprint)=64 AND client_receipt_fingerprint NOT GLOB '*[^0-9a-f]*'),
  operations_receipt_fingerprint TEXT CHECK(operations_receipt_fingerprint IS NULL OR
    (length(operations_receipt_fingerprint)=64 AND operations_receipt_fingerprint NOT GLOB '*[^0-9a-f]*')),
  state TEXT NOT NULL CHECK(state IN ('prepared','active','revoked')),
  recorded_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Receipt rows are immutable. The closure records the second service receipt
-- and is the only transition from prepared to effective.
CREATE TABLE operations_portal_native_inquiry_capability_closures (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_inquiry_capability_receipts(operation_id) ON DELETE RESTRICT,
  request_fingerprint TEXT NOT NULL UNIQUE CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  client_receipt_fingerprint TEXT NOT NULL CHECK(length(client_receipt_fingerprint)=64 AND client_receipt_fingerprint NOT GLOB '*[^0-9a-f]*'),
  operations_receipt_fingerprint TEXT NOT NULL CHECK(length(operations_receipt_fingerprint)=64 AND operations_receipt_fingerprint NOT GLOB '*[^0-9a-f]*'),
  resulting_state TEXT NOT NULL CHECK(resulting_state='active'),
  recorded_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE operations_portal_native_inquiry_capability_history (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_inquiry_capability_commands(operation_id) ON DELETE RESTRICT,
  intent_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('grant','revoke')),
  expected_revision INTEGER NOT NULL,
  resulting_revision INTEGER NOT NULL,
  resulting_state TEXT NOT NULL CHECK(resulting_state IN ('prepared','active','revoked')),
  request_fingerprint TEXT NOT NULL UNIQUE,
  recorded_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER operations_portal_native_inquiry_capability_command_guard
BEFORE INSERT ON operations_portal_native_inquiry_capability_commands
WHEN NOT EXISTS(
  SELECT 1 FROM operations_portal_native_recipient_intents intent
  JOIN operations_portal_native_recipient_authority_heads base ON base.recipient_binding_id=intent.recipient_binding_id
    AND base.enrollment_intent_id=intent.intent_id AND base.target_id=intent.target_id
    AND base.target_client_record_id=intent.target_client_record_id AND base.issuer=intent.access_issuer
    AND base.subject=intent.access_subject AND base.permission_schema_version=3
    AND base.permissions_json='["operations.service_home.read"]' AND base.state='active'
  JOIN operations_portal_native_authority_receipts base_receipt ON base_receipt.operation_id=base.latest_operation_id
    AND base_receipt.operation_id=NEW.base_operation_id AND base_receipt.target_id=base.target_id
    AND base_receipt.recipient_binding_id=base.recipient_binding_id AND base_receipt.ownership_epoch=base.ownership_epoch
    AND base_receipt.grant_revision=base.grant_revision AND base_receipt.resulting_state='active'
    AND base_receipt.permission_schema_version=3 AND base_receipt.permissions_json='["operations.service_home.read"]'
  JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=base.target_id
    AND workspace.state='active' AND workspace.ownership_epoch=base.ownership_epoch
    AND workspace.target_revision=NEW.target_revision AND workspace.client_authority_id=NEW.client_authority_id
    AND workspace.workspace_id=NEW.workspace_id
  JOIN operations_portal_workspace_publication_receipts publication ON publication.operation_id=NEW.publication_operation_id
    AND publication.resulting_revision=NEW.publication_revision AND publication.source_sequence=NEW.publication_source_sequence
    AND publication.snapshot_id=NEW.publication_snapshot_id AND publication.snapshot_sha256=NEW.publication_snapshot_sha256
  JOIN operations_portal_workspace_publication_commands publication_command
    ON publication_command.operation_id=publication.operation_id
      AND publication_command.publication_id=publication.publication_id
      AND publication_command.operation_fingerprint=publication.operation_fingerprint
      AND publication_command.target_id=publication.target_id
      AND publication_command.resulting_revision=publication.resulting_revision
      AND publication_command.source_sequence=publication.source_sequence
      AND publication_command.snapshot_id=publication.snapshot_id
      AND publication_command.snapshot_sha256=publication.snapshot_sha256
  JOIN operations_portal_workspace_publication_heads pub_head ON pub_head.target_id=publication.target_id
    AND pub_head.latest_operation_id=publication.operation_id AND pub_head.publication_revision=publication.resulting_revision
    AND pub_head.source_sequence=publication.source_sequence AND pub_head.snapshot_id=publication.snapshot_id
    AND pub_head.snapshot_sha256=publication.snapshot_sha256 AND pub_head.target_revision=NEW.target_revision
    AND pub_head.client_authority_id=NEW.client_authority_id AND pub_head.workspace_id=NEW.workspace_id
  JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.snapshot_id=publication.snapshot_id
    AND snapshot.checkpoint_id=publication_command.checkpoint_id
    AND snapshot.target_id=publication.target_id AND snapshot.source_sequence=publication.source_sequence
    AND snapshot.snapshot_sha256=publication.snapshot_sha256
  JOIN json_each(snapshot.snapshot_json,'$.directoryRecords') member
  WHERE intent.intent_id=NEW.intent_id AND intent.permission_schema_version=4
    AND intent.requested_permissions_json='["operations.request.create","operations.service_home.read"]'
    AND intent.state='active' AND intent.recipient_binding_id=NEW.recipient_binding_id
    AND intent.grant_operation_id=NEW.base_operation_id AND intent.expires_at=NEW.expires_at
    AND NEW.operation_id<>NEW.base_operation_id
    AND base.ownership_epoch=NEW.base_ownership_epoch AND base.grant_revision=NEW.base_grant_revision
    AND base.latest_operation_id=NEW.base_operation_id AND base.enrollment_intent_id=NEW.intent_id AND base.state='active'
    AND ((base.expires_at IS NULL) OR datetime(NEW.expires_at)<=datetime(base.expires_at))
    AND base.target_id=NEW.target_id
    AND base_receipt.client_authority_id=NEW.client_authority_id AND base_receipt.workspace_id=NEW.workspace_id
    AND json_extract(member.value,'$.recordId')=NEW.target_client_record_id
    AND json_extract(member.value,'$.kind')='client'
    AND ((pub_head.root_kind='organization' AND json_extract(member.value,'$.parentRecordId')=pub_head.root_record_id)
      OR (pub_head.root_kind='standalone_client' AND json_extract(member.value,'$.parentRecordId') IS NULL
        AND json_extract(member.value,'$.recordId')=pub_head.root_record_id))
    AND NEW.expires_at>NEW.observed_at AND NEW.actor_verified_until>NEW.observed_at
    AND NEW.actor_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND EXISTS(SELECT 1 FROM native_staff_admissions actor
      JOIN native_staff_profiles profile ON profile.staff_id=actor.staff_id
        AND profile.version=NEW.actor_profile_version
      JOIN native_directory_grant_generations generation ON generation.staff_id=actor.staff_id
        AND generation.generation=NEW.actor_grant_generation
      JOIN operations_portal_workspace_reservation_heads actor_target ON actor_target.target_id=NEW.target_id
        AND actor_target.state='active'
      WHERE actor.staff_id=NEW.actor_staff_id AND actor.active=1
        AND actor.bound_access_subject=NEW.actor_access_subject AND actor.version=NEW.actor_admission_version
        AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=actor.staff_id
          AND ((role.role_id IN ('role-owner','role-admin') AND role.scope='global')
            OR (role.role_id='role-division-manager' AND role.scope='division'
              AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
                WHERE scope.record_id=actor_target.root_record_id AND scope.active=1
                  AND scope.division_id=role.division_id))))
        AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions allowed
          WHERE allowed.staff_id=actor.staff_id AND allowed.effect='allow' AND allowed.record_id=actor_target.root_record_id)
        AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions denied
          WHERE denied.staff_id=actor.staff_id AND denied.effect='deny' AND denied.record_id=actor_target.root_record_id))
    AND (NEW.action='grant' AND NEW.expected_revision=0 AND NEW.resulting_revision=1
      OR NEW.action='revoke' AND NEW.expected_revision=1 AND NEW.resulting_revision=2)
    AND ((NEW.action='grant' AND NOT EXISTS(SELECT 1
        FROM operations_portal_native_inquiry_capability_heads existing WHERE existing.intent_id=NEW.intent_id))
      OR (NEW.action='revoke' AND EXISTS(SELECT 1
        FROM operations_portal_native_inquiry_capability_heads existing
        JOIN operations_portal_native_inquiry_capability_commands original ON original.operation_id=existing.latest_operation_id
          AND original.action='grant'
        WHERE existing.intent_id=NEW.intent_id AND existing.state IN ('prepared','active')
          AND existing.revision=NEW.expected_revision AND existing.base_operation_id=NEW.base_operation_id
          AND existing.base_ownership_epoch=NEW.base_ownership_epoch AND existing.base_grant_revision=NEW.base_grant_revision
          AND original.target_id=NEW.target_id AND original.target_revision=NEW.target_revision
          AND original.client_authority_id=NEW.client_authority_id AND original.workspace_id=NEW.workspace_id
          AND original.target_client_record_id=NEW.target_client_record_id
          AND original.recipient_binding_id=NEW.recipient_binding_id AND original.issuer=NEW.issuer
          AND original.subject=NEW.subject AND original.publication_operation_id=NEW.publication_operation_id
          AND original.publication_revision=NEW.publication_revision
          AND original.publication_source_sequence=NEW.publication_source_sequence
          AND original.publication_snapshot_id=NEW.publication_snapshot_id
          AND original.publication_snapshot_sha256=NEW.publication_snapshot_sha256
          AND original.expires_at=NEW.expires_at)))
)
BEGIN SELECT RAISE(ABORT,'Operations inquiry capability parent or owner pins are stale'); END;

CREATE TRIGGER operations_portal_native_inquiry_capability_command_json_guard
BEFORE INSERT ON operations_portal_native_inquiry_capability_commands
WHEN json_type(NEW.canonical_command_json)<>'object'
  OR (SELECT count(*) FROM json_each(NEW.canonical_command_json))<>14
  OR (SELECT count(*) FROM json_each(NEW.canonical_command_json,'$.target'))<>5
  OR (SELECT count(*) FROM json_each(NEW.canonical_command_json,'$.recipient'))<>4
  OR (SELECT count(*) FROM json_each(NEW.canonical_command_json,'$.baseAuthority'))<>3
  OR (SELECT count(*) FROM json_each(NEW.canonical_command_json,'$.publication'))<>5
  OR (SELECT count(*) FROM json_each(NEW.canonical_command_json,'$.transition'))<>2
  OR (SELECT count(*) FROM json_each(NEW.canonical_command_json,'$.actorProof'))<>6
  OR json_extract(NEW.canonical_command_json,'$.protocol')<>'operations-portal-native-inquiry-capability'
  OR json_extract(NEW.canonical_command_json,'$.protocolVersion')<>1
  OR json_extract(NEW.canonical_command_json,'$.permissionSchemaVersion')<>4
  OR json_extract(NEW.canonical_command_json,'$.operationId')<>NEW.operation_id
  OR json_extract(NEW.canonical_command_json,'$.action')<>NEW.action
  OR json_extract(NEW.canonical_command_json,'$.target.targetId')<>NEW.target_id
  OR json_extract(NEW.canonical_command_json,'$.target.targetRevision')<>CAST(NEW.target_revision AS TEXT)
  OR json_extract(NEW.canonical_command_json,'$.target.clientAuthorityId')<>NEW.client_authority_id
  OR json_extract(NEW.canonical_command_json,'$.target.workspaceId')<>NEW.workspace_id
  OR json_extract(NEW.canonical_command_json,'$.target.targetClientRecordId')<>NEW.target_client_record_id
  OR json_extract(NEW.canonical_command_json,'$.recipient.recipientBindingId')<>NEW.recipient_binding_id
  OR json_extract(NEW.canonical_command_json,'$.recipient.enrollmentIntentId')<>NEW.intent_id
  OR json_extract(NEW.canonical_command_json,'$.recipient.issuer')<>NEW.issuer
  OR json_extract(NEW.canonical_command_json,'$.recipient.subject')<>NEW.subject
  OR json_extract(NEW.canonical_command_json,'$.baseAuthority.operationId')<>NEW.base_operation_id
  OR json_extract(NEW.canonical_command_json,'$.baseAuthority.ownershipEpoch')<>CAST(NEW.base_ownership_epoch AS TEXT)
  OR json_extract(NEW.canonical_command_json,'$.baseAuthority.grantRevision')<>CAST(NEW.base_grant_revision AS TEXT)
  OR json_extract(NEW.canonical_command_json,'$.publication.operationId')<>NEW.publication_operation_id
  OR json_extract(NEW.canonical_command_json,'$.publication.revision')<>CAST(NEW.publication_revision AS TEXT)
  OR json_extract(NEW.canonical_command_json,'$.publication.sourceSequence')<>CAST(NEW.publication_source_sequence AS TEXT)
  OR json_extract(NEW.canonical_command_json,'$.publication.snapshotId')<>NEW.publication_snapshot_id
  OR json_extract(NEW.canonical_command_json,'$.publication.snapshotSha256')<>NEW.publication_snapshot_sha256
  OR json_extract(NEW.canonical_command_json,'$.transition.expectedRevision')<>CAST(NEW.expected_revision AS TEXT)
  OR json_extract(NEW.canonical_command_json,'$.transition.resultingRevision')<>CAST(NEW.resulting_revision AS TEXT)
  OR json_extract(NEW.canonical_command_json,'$.permission')<>'operations.request.create'
  OR json_extract(NEW.canonical_command_json,'$.expiresAt')<>NEW.expires_at
  OR json_extract(NEW.canonical_command_json,'$.actorProof.staffId')<>NEW.actor_staff_id
  OR json_extract(NEW.canonical_command_json,'$.actorProof.verifiedAccessSubject')<>NEW.actor_access_subject
  OR json_extract(NEW.canonical_command_json,'$.actorProof.admissionVersion')<>CAST(NEW.actor_admission_version AS TEXT)
  OR json_extract(NEW.canonical_command_json,'$.actorProof.profileVersion')<>CAST(NEW.actor_profile_version AS TEXT)
  OR json_extract(NEW.canonical_command_json,'$.actorProof.grantGeneration')<>CAST(NEW.actor_grant_generation AS TEXT)
  OR json_extract(NEW.canonical_command_json,'$.actorProof.verifiedUntil')<>NEW.actor_verified_until
  OR json_extract(NEW.canonical_command_json,'$.observedAt')<>NEW.observed_at
BEGIN SELECT RAISE(ABORT,'Operations inquiry capability command JSON does not match its columns'); END;

CREATE TRIGGER operations_portal_native_inquiry_capability_commands_no_update
BEFORE UPDATE ON operations_portal_native_inquiry_capability_commands
BEGIN SELECT RAISE(ABORT,'Operations inquiry capability commands are immutable'); END;
CREATE TRIGGER operations_portal_native_inquiry_capability_commands_no_delete
BEFORE DELETE ON operations_portal_native_inquiry_capability_commands
BEGIN SELECT RAISE(ABORT,'Operations inquiry capability commands are durable'); END;
CREATE TRIGGER operations_portal_native_inquiry_capability_receipts_no_update
BEFORE UPDATE ON operations_portal_native_inquiry_capability_receipts
BEGIN SELECT RAISE(ABORT,'Operations inquiry capability receipts are immutable'); END;
CREATE TRIGGER operations_portal_native_inquiry_capability_receipts_no_delete
BEFORE DELETE ON operations_portal_native_inquiry_capability_receipts
BEGIN SELECT RAISE(ABORT,'Operations inquiry capability receipts are durable'); END;
CREATE TRIGGER operations_portal_native_inquiry_capability_history_insert_guard
BEFORE INSERT ON operations_portal_native_inquiry_capability_history
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_inquiry_capability_commands command
  WHERE command.operation_id=NEW.operation_id AND command.intent_id=NEW.intent_id AND command.action=NEW.action
    AND command.expected_revision=NEW.expected_revision AND command.resulting_revision=NEW.resulting_revision
    AND command.request_fingerprint=NEW.request_fingerprint
    AND ((NEW.resulting_state='prepared' AND NEW.action='grant')
      OR (NEW.resulting_state='revoked' AND NEW.action='revoke')))
BEGIN SELECT RAISE(ABORT,'Operations inquiry capability history must match its immutable command'); END;
CREATE TRIGGER operations_portal_native_inquiry_capability_history_update_guard
BEFORE UPDATE ON operations_portal_native_inquiry_capability_history
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.intent_id IS NOT OLD.intent_id OR NEW.action IS NOT OLD.action
  OR NEW.expected_revision<>OLD.expected_revision OR NEW.resulting_revision<>OLD.resulting_revision
  OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
  OR NOT (OLD.resulting_state='prepared' AND NEW.resulting_state='active' AND EXISTS(
    SELECT 1 FROM operations_portal_native_inquiry_capability_closures closure
    WHERE closure.operation_id=OLD.operation_id AND closure.request_fingerprint=OLD.request_fingerprint
      AND closure.resulting_state='active'))
BEGIN SELECT RAISE(ABORT,'Operations inquiry capability history is immutable'); END;
CREATE TRIGGER operations_portal_native_inquiry_capability_history_delete_guard
BEFORE DELETE ON operations_portal_native_inquiry_capability_history
BEGIN SELECT RAISE(ABORT,'Operations inquiry capability history is durable'); END;
CREATE TRIGGER operations_portal_native_inquiry_capability_outbox_update_guard
BEFORE UPDATE ON operations_portal_native_inquiry_capability_outbox
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.created_at IS NOT OLD.created_at
  OR NOT ((OLD.state='pending' AND NEW.state IN ('prepared','revoked'))
    OR (OLD.state='prepared' AND NEW.state='prepared')
    OR (OLD.state='prepared' AND NEW.state='acknowledged'))
  OR NEW.attempts<OLD.attempts
BEGIN SELECT RAISE(ABORT,'Operations inquiry capability outbox transition is invalid'); END;
CREATE TRIGGER operations_portal_native_inquiry_capability_outbox_delete_guard
BEFORE DELETE ON operations_portal_native_inquiry_capability_outbox
BEGIN SELECT RAISE(ABORT,'Operations inquiry capability outbox is durable'); END;
CREATE TRIGGER operations_portal_native_inquiry_capability_closures_no_update
BEFORE UPDATE ON operations_portal_native_inquiry_capability_closures
BEGIN SELECT RAISE(ABORT,'Operations inquiry capability closures are immutable'); END;
CREATE TRIGGER operations_portal_native_inquiry_capability_closures_no_delete
BEFORE DELETE ON operations_portal_native_inquiry_capability_closures
BEGIN SELECT RAISE(ABORT,'Operations inquiry capability closures are durable'); END;

CREATE TRIGGER operations_portal_native_inquiry_capability_head_insert_guard
BEFORE INSERT ON operations_portal_native_inquiry_capability_heads
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_inquiry_capability_commands command
  JOIN operations_portal_native_inquiry_capability_receipts receipt ON receipt.operation_id=command.operation_id
    AND receipt.request_fingerprint=command.request_fingerprint AND receipt.state='prepared'
  WHERE command.operation_id=NEW.latest_operation_id AND command.action='grant' AND command.expected_revision=0
    AND command.resulting_revision=1 AND command.intent_id=NEW.intent_id AND command.target_id=NEW.target_id
    AND command.recipient_binding_id=NEW.recipient_binding_id AND command.base_operation_id=NEW.base_operation_id
    AND command.base_ownership_epoch=NEW.base_ownership_epoch AND command.base_grant_revision=NEW.base_grant_revision
    AND NEW.revision=1 AND NEW.state='prepared')
BEGIN SELECT RAISE(ABORT,'Operations inquiry capability head requires its prepared receipt'); END;

CREATE TRIGGER operations_portal_native_inquiry_capability_head_update_guard
BEFORE UPDATE ON operations_portal_native_inquiry_capability_heads
WHEN NEW.intent_id IS NOT OLD.intent_id OR NEW.target_id IS NOT OLD.target_id
  OR NEW.recipient_binding_id IS NOT OLD.recipient_binding_id OR NEW.base_operation_id IS NOT OLD.base_operation_id
  OR NEW.base_ownership_epoch<>OLD.base_ownership_epoch OR NEW.base_grant_revision<>OLD.base_grant_revision
  OR NOT ((OLD.state='prepared' AND NEW.state='active' AND NEW.revision=OLD.revision
      AND NEW.latest_operation_id=OLD.latest_operation_id AND EXISTS(SELECT 1
        FROM operations_portal_native_inquiry_capability_receipts receipt
        JOIN operations_portal_native_inquiry_capability_closures closure ON closure.operation_id=receipt.operation_id
          AND closure.request_fingerprint=receipt.request_fingerprint
          AND closure.client_receipt_fingerprint=receipt.client_receipt_fingerprint
          AND closure.operations_receipt_fingerprint=receipt.operations_receipt_fingerprint
          AND closure.resulting_state='active'
        WHERE receipt.operation_id=OLD.latest_operation_id AND receipt.state='prepared'))
    OR OLD.state IN ('prepared','active') AND NEW.state='revoked' AND NEW.revision=OLD.revision+1
      AND EXISTS(SELECT 1 FROM operations_portal_native_inquiry_capability_commands command
        JOIN operations_portal_native_inquiry_capability_receipts receipt ON receipt.operation_id=command.operation_id
          AND receipt.request_fingerprint=command.request_fingerprint AND receipt.state='revoked'
        JOIN operations_portal_native_inquiry_capability_commands original ON original.operation_id=OLD.latest_operation_id
          AND original.action='grant'
        WHERE command.operation_id=NEW.latest_operation_id AND command.intent_id=OLD.intent_id
          AND command.action='revoke' AND command.expected_revision=OLD.revision
          AND command.resulting_revision=NEW.revision AND command.base_operation_id=OLD.base_operation_id
          AND command.target_id=original.target_id AND command.target_revision=original.target_revision
          AND command.client_authority_id=original.client_authority_id AND command.workspace_id=original.workspace_id
          AND command.target_client_record_id=original.target_client_record_id
          AND command.recipient_binding_id=original.recipient_binding_id AND command.issuer=original.issuer
          AND command.subject=original.subject AND command.base_ownership_epoch=original.base_ownership_epoch
          AND command.base_grant_revision=original.base_grant_revision
          AND command.publication_operation_id=original.publication_operation_id
          AND command.publication_revision=original.publication_revision
          AND command.publication_source_sequence=original.publication_source_sequence
          AND command.publication_snapshot_id=original.publication_snapshot_id
          AND command.publication_snapshot_sha256=original.publication_snapshot_sha256
          AND command.expires_at=original.expires_at))
BEGIN SELECT RAISE(ABORT,'Operations inquiry capability transition is not exactly receipted'); END;

CREATE TRIGGER operations_portal_native_inquiry_capability_closure_insert_guard
BEFORE INSERT ON operations_portal_native_inquiry_capability_closures
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_inquiry_capability_commands command
  JOIN operations_portal_native_inquiry_capability_receipts receipt ON receipt.operation_id=command.operation_id
    AND receipt.request_fingerprint=command.request_fingerprint AND receipt.client_receipt_fingerprint=NEW.client_receipt_fingerprint
    AND receipt.state='prepared'
  JOIN operations_portal_native_inquiry_capability_heads head ON head.intent_id=command.intent_id
    AND head.latest_operation_id=command.operation_id AND head.state='prepared'
  JOIN operations_portal_native_recipient_authority_heads base ON base.recipient_binding_id=command.recipient_binding_id
    AND base.target_id=command.target_id AND base.enrollment_intent_id=command.intent_id
    AND base.latest_operation_id=command.base_operation_id AND base.ownership_epoch=command.base_ownership_epoch
    AND base.grant_revision=command.base_grant_revision AND base.state='active'
    AND base.permissions_json='["operations.service_home.read"]'
  JOIN operations_portal_workspace_publication_heads publication ON publication.target_id=command.target_id
    AND publication.latest_operation_id=command.publication_operation_id AND publication.publication_revision=command.publication_revision
    AND publication.source_sequence=command.publication_source_sequence AND publication.snapshot_id=command.publication_snapshot_id
    AND publication.snapshot_sha256=command.publication_snapshot_sha256
  JOIN operations_portal_workspace_publication_receipts publication_receipt
    ON publication_receipt.operation_id=publication.latest_operation_id
      AND publication_receipt.resulting_revision=publication.publication_revision
      AND publication_receipt.source_sequence=publication.source_sequence
      AND publication_receipt.snapshot_id=publication.snapshot_id
      AND publication_receipt.snapshot_sha256=publication.snapshot_sha256
  JOIN operations_portal_workspace_publication_commands publication_command
    ON publication_command.operation_id=publication_receipt.operation_id
      AND publication_command.publication_id=publication_receipt.publication_id
      AND publication_command.operation_fingerprint=publication_receipt.operation_fingerprint
      AND publication_command.target_id=publication_receipt.target_id
      AND publication_command.resulting_revision=publication_receipt.resulting_revision
      AND publication_command.source_sequence=publication_receipt.source_sequence
      AND publication_command.snapshot_id=publication_receipt.snapshot_id
      AND publication_command.snapshot_sha256=publication_receipt.snapshot_sha256
  JOIN operations_portal_workspace_publication_snapshots snapshot
    ON snapshot.snapshot_id=publication_receipt.snapshot_id AND snapshot.checkpoint_id=publication_command.checkpoint_id
      AND snapshot.target_id=publication_receipt.target_id AND snapshot.source_sequence=publication_receipt.source_sequence
      AND snapshot.snapshot_sha256=publication_receipt.snapshot_sha256
  JOIN json_each(snapshot.snapshot_json,'$.directoryRecords') member
  WHERE command.operation_id=NEW.operation_id AND command.action='grant'
    AND NEW.request_fingerprint=receipt.request_fingerprint AND NEW.operations_receipt_fingerprint=receipt.operations_receipt_fingerprint
    AND NEW.resulting_state='active' AND command.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND json_extract(member.value,'$.recordId')=command.target_client_record_id
    AND json_extract(member.value,'$.kind')='client'
    AND ((publication.root_kind='organization' AND json_extract(member.value,'$.parentRecordId')=publication.root_record_id)
      OR (publication.root_kind='standalone_client' AND json_extract(member.value,'$.parentRecordId') IS NULL
        AND json_extract(member.value,'$.recordId')=publication.root_record_id)))
BEGIN SELECT RAISE(ABORT,'Operations inquiry capability closure is stale or incomplete'); END;
