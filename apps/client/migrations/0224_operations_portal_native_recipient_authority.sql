PRAGMA foreign_keys=ON;

CREATE TABLE operations_portal_native_authority_commands (
  operation_id TEXT PRIMARY KEY, request_fingerprint TEXT NOT NULL UNIQUE CHECK(length(request_fingerprint)=64),
  action TEXT NOT NULL CHECK(action IN ('recipient.grant','recipient.revoke','workspace.revoke')),
  target_id TEXT NOT NULL, target_revision INTEGER NOT NULL CHECK(target_revision>=1), client_authority_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL, root_kind TEXT NOT NULL CHECK(root_kind IN ('organization','standalone_client')),
  root_record_id TEXT NOT NULL, recipient_binding_id TEXT, enrollment_intent_id TEXT, target_client_record_id TEXT,
  issuer TEXT, subject TEXT, expected_ownership_epoch INTEGER NOT NULL CHECK(expected_ownership_epoch>=0),
  expected_grant_revision INTEGER, resulting_ownership_epoch INTEGER NOT NULL CHECK(resulting_ownership_epoch>=1),
  resulting_grant_revision INTEGER, permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json)), expires_at TEXT,
  publication_operation_id TEXT, publication_id TEXT, publication_revision INTEGER, publication_source_sequence INTEGER,
  publication_snapshot_id TEXT, publication_snapshot_sha256 TEXT, publication_request_fingerprint TEXT,
  actor_staff_id TEXT NOT NULL, actor_access_subject TEXT NOT NULL, actor_admission_version INTEGER NOT NULL,
  actor_profile_version INTEGER NOT NULL, actor_grant_generation INTEGER NOT NULL, actor_verified_until TEXT NOT NULL,
  observed_at TEXT NOT NULL, canonical_command_json TEXT NOT NULL CHECK(json_valid(canonical_command_json))
    CHECK(length(CAST(canonical_command_json AS BLOB))<=32768),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((action='workspace.revoke' AND recipient_binding_id IS NULL AND expected_grant_revision IS NULL
    AND resulting_grant_revision IS NULL AND permissions_json='[]' AND publication_operation_id IS NULL)
    OR (action='recipient.revoke' AND recipient_binding_id IS NOT NULL AND expected_grant_revision>=1
      AND resulting_grant_revision=expected_grant_revision+1 AND permissions_json='[]' AND publication_operation_id IS NULL)
    OR (action='recipient.grant' AND recipient_binding_id IS NOT NULL AND expected_grant_revision>=0
      AND resulting_grant_revision=expected_grant_revision+1 AND permissions_json='["operations.service_home.read"]'
      AND publication_operation_id IS NOT NULL))
);

CREATE TABLE operations_portal_native_authority_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_authority_commands(operation_id) ON DELETE RESTRICT,
  request_fingerprint TEXT NOT NULL UNIQUE, action TEXT NOT NULL, target_id TEXT NOT NULL,
  recipient_binding_id TEXT, ownership_epoch INTEGER NOT NULL, grant_revision INTEGER, state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE operations_portal_native_workspace_authority_heads (
  target_id TEXT PRIMARY KEY, target_revision INTEGER NOT NULL, client_authority_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL UNIQUE, root_kind TEXT NOT NULL, root_record_id TEXT NOT NULL,
  ownership_epoch INTEGER NOT NULL CHECK(ownership_epoch>=1), state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  latest_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_authority_receipts(operation_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE operations_portal_native_recipient_authority_heads (
  recipient_binding_id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES operations_portal_native_workspace_authority_heads(target_id) ON DELETE RESTRICT,
  enrollment_intent_id TEXT NOT NULL UNIQUE, target_client_record_id TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
  ownership_epoch INTEGER NOT NULL, grant_revision INTEGER NOT NULL CHECK(grant_revision>=1),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')), permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json)),
  expires_at TEXT, latest_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_authority_receipts(operation_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX operations_portal_native_recipient_one_active_principal
  ON operations_portal_native_recipient_authority_heads(target_id,issuer,subject) WHERE state='active';

CREATE TABLE operations_portal_native_authority_history (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_authority_commands(operation_id) ON DELETE RESTRICT,
  action TEXT NOT NULL, target_id TEXT NOT NULL, recipient_binding_id TEXT, ownership_epoch INTEGER NOT NULL,
  grant_revision INTEGER, state TEXT NOT NULL, request_fingerprint TEXT NOT NULL UNIQUE,
  recorded_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER operations_portal_native_authority_command_json_guard
BEFORE INSERT ON operations_portal_native_authority_commands
WHEN NEW.canonical_command_json IS NOT json_object(
  'protocol','operations-portal-native-authority','protocolVersion',1,'permissionSchemaVersion',3,'action',NEW.action,
  'operationId',NEW.operation_id,'target',json(json_object('targetId',NEW.target_id,'targetRevision',CAST(NEW.target_revision AS TEXT),
    'clientAuthorityId',NEW.client_authority_id,'workspaceId',NEW.workspace_id,'rootKind',NEW.root_kind,'rootRecordId',NEW.root_record_id)),
  'recipient',CASE WHEN NEW.recipient_binding_id IS NULL THEN NULL ELSE json(json_object('recipientBindingId',NEW.recipient_binding_id,
    'enrollmentIntentId',NEW.enrollment_intent_id,'targetClientRecordId',NEW.target_client_record_id,'issuer',NEW.issuer,'subject',NEW.subject)) END,
  'expected',json(json_object('ownershipEpoch',CAST(NEW.expected_ownership_epoch AS TEXT),'grantRevision',
    CASE WHEN NEW.expected_grant_revision IS NULL THEN NULL ELSE CAST(NEW.expected_grant_revision AS TEXT) END)),
  'resulting',json(json_object('ownershipEpoch',CAST(NEW.resulting_ownership_epoch AS TEXT),'grantRevision',
    CASE WHEN NEW.resulting_grant_revision IS NULL THEN NULL ELSE CAST(NEW.resulting_grant_revision AS TEXT) END)),
  'permissions',json(NEW.permissions_json),'expiresAt',NEW.expires_at,
  'publication',CASE WHEN NEW.publication_operation_id IS NULL THEN NULL ELSE json(json_object('operationId',NEW.publication_operation_id,
    'publicationId',NEW.publication_id,'revision',CAST(NEW.publication_revision AS TEXT),'sourceSequence',CAST(NEW.publication_source_sequence AS TEXT),
    'snapshotId',NEW.publication_snapshot_id,'snapshotSha256',NEW.publication_snapshot_sha256,
    'requestFingerprint',NEW.publication_request_fingerprint)) END,
  'actorProof',json(json_object('staffId',NEW.actor_staff_id,'verifiedAccessSubject',NEW.actor_access_subject,
    'admissionVersion',CAST(NEW.actor_admission_version AS TEXT),'profileVersion',CAST(NEW.actor_profile_version AS TEXT),
    'grantGeneration',CAST(NEW.actor_grant_generation AS TEXT),'verifiedUntil',NEW.actor_verified_until)),
  'observedAt',NEW.observed_at)
BEGIN SELECT RAISE(ABORT,'native authority command JSON does not match its exact row'); END;

CREATE TRIGGER operations_portal_native_authority_grant_publication_guard
BEFORE INSERT ON operations_portal_native_authority_commands WHEN NEW.action='recipient.grant' AND NOT EXISTS(
  SELECT 1 FROM operations_portal_workspace_publication_receipts receipt
  JOIN operations_portal_workspace_publication_commands publication ON publication.operation_id=receipt.operation_id
  JOIN operations_portal_workspace_publication_heads head ON head.target_id=publication.target_id AND head.latest_operation_id=publication.operation_id
  JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.operation_id=publication.operation_id
  WHERE receipt.operation_id=NEW.publication_operation_id AND receipt.publication_id=NEW.publication_id
    AND receipt.request_fingerprint=NEW.publication_request_fingerprint AND receipt.resulting_revision=NEW.publication_revision
    AND receipt.source_sequence=NEW.publication_source_sequence AND receipt.snapshot_id=NEW.publication_snapshot_id
    AND receipt.snapshot_sha256=NEW.publication_snapshot_sha256
    AND head.target_id=NEW.target_id AND head.target_revision=NEW.target_revision
    AND head.client_authority_id=NEW.client_authority_id AND head.workspace_id=NEW.workspace_id
    AND head.root_kind=NEW.root_kind AND head.root_record_id=NEW.root_record_id
    AND ((NEW.root_kind='standalone_client' AND NEW.target_client_record_id=NEW.root_record_id
        AND EXISTS(SELECT 1 FROM json_each(snapshot.snapshot_json,'$.directoryRecords') member
          WHERE json_extract(member.value,'$.recordId')=NEW.target_client_record_id
            AND json_extract(member.value,'$.kind')='client'
            AND json_extract(member.value,'$.parentRecordId') IS NULL))
      OR (NEW.root_kind='organization' AND EXISTS(SELECT 1 FROM json_each(snapshot.snapshot_json,'$.directoryRecords') member
        WHERE json_extract(member.value,'$.recordId')=NEW.target_client_record_id
          AND json_extract(member.value,'$.kind')='client'
          AND json_extract(member.value,'$.parentRecordId')=NEW.root_record_id)))
) BEGIN SELECT RAISE(ABORT,'native authority grant requires exact current published client membership'); END;

CREATE TRIGGER operations_portal_native_workspace_authority_insert_guard
BEFORE INSERT ON operations_portal_native_workspace_authority_heads WHEN NOT EXISTS(
  SELECT 1 FROM operations_portal_native_authority_commands command
  WHERE command.operation_id=NEW.latest_operation_id AND command.action='recipient.grant'
    AND command.target_id=NEW.target_id AND command.target_revision=NEW.target_revision
    AND command.client_authority_id=NEW.client_authority_id AND command.workspace_id=NEW.workspace_id
    AND command.root_kind=NEW.root_kind AND command.root_record_id=NEW.root_record_id
    AND command.expected_ownership_epoch=0 AND command.resulting_ownership_epoch=NEW.ownership_epoch
    AND NEW.ownership_epoch=1 AND NEW.state='active'
) BEGIN SELECT RAISE(ABORT,'native workspace authority requires its exact grant command'); END;

CREATE TRIGGER operations_portal_native_workspace_authority_update_guard
BEFORE UPDATE ON operations_portal_native_workspace_authority_heads
BEGIN SELECT RAISE(ABORT,'native workspace authority transitions require a later reviewed migration'); END;

CREATE TRIGGER operations_portal_native_recipient_authority_insert_guard
BEFORE INSERT ON operations_portal_native_recipient_authority_heads WHEN NOT EXISTS(
  SELECT 1 FROM operations_portal_native_authority_commands command
  JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=command.target_id
  WHERE command.operation_id=NEW.latest_operation_id AND command.action='recipient.grant'
    AND command.target_id=NEW.target_id AND command.recipient_binding_id=NEW.recipient_binding_id
    AND command.enrollment_intent_id=NEW.enrollment_intent_id
    AND command.target_client_record_id=NEW.target_client_record_id
    AND command.issuer=NEW.issuer AND command.subject=NEW.subject
    AND command.resulting_ownership_epoch=NEW.ownership_epoch
    AND command.resulting_grant_revision=NEW.grant_revision
    AND command.permissions_json=NEW.permissions_json AND command.expires_at IS NEW.expires_at
    AND workspace.ownership_epoch=NEW.ownership_epoch AND workspace.state='active'
    AND NEW.grant_revision=1 AND NEW.state='active'
) BEGIN SELECT RAISE(ABORT,'native recipient authority requires its exact grant command'); END;

CREATE TRIGGER operations_portal_native_recipient_authority_update_guard
BEFORE UPDATE ON operations_portal_native_recipient_authority_heads
WHEN NEW.recipient_binding_id IS NOT OLD.recipient_binding_id OR NEW.target_id IS NOT OLD.target_id
  OR NEW.enrollment_intent_id IS NOT OLD.enrollment_intent_id
  OR NEW.target_client_record_id IS NOT OLD.target_client_record_id OR NEW.issuer IS NOT OLD.issuer
  OR NEW.subject IS NOT OLD.subject OR NEW.ownership_epoch<>OLD.ownership_epoch
  OR OLD.state<>'active' OR NEW.state<>'revoked' OR NEW.grant_revision<>OLD.grant_revision+1
  OR NEW.permissions_json<>'[]' OR NEW.expires_at IS NOT OLD.expires_at
  OR NOT EXISTS(SELECT 1 FROM operations_portal_native_authority_commands command
    WHERE command.operation_id=NEW.latest_operation_id AND command.action='recipient.revoke'
      AND command.target_id=OLD.target_id AND command.recipient_binding_id=OLD.recipient_binding_id
      AND command.enrollment_intent_id=OLD.enrollment_intent_id
      AND command.target_client_record_id=OLD.target_client_record_id
      AND command.issuer=OLD.issuer AND command.subject=OLD.subject
      AND command.expected_ownership_epoch=OLD.ownership_epoch
      AND command.resulting_ownership_epoch=NEW.ownership_epoch
      AND command.expected_grant_revision=OLD.grant_revision
      AND command.resulting_grant_revision=NEW.grant_revision)
BEGIN SELECT RAISE(ABORT,'native recipient authority revoke does not match its exact command'); END;

CREATE TRIGGER operations_portal_native_authority_history_guard
BEFORE INSERT ON operations_portal_native_authority_history WHEN NOT EXISTS(
  SELECT 1 FROM operations_portal_native_authority_commands command
  JOIN operations_portal_native_recipient_authority_heads recipient
    ON recipient.recipient_binding_id=command.recipient_binding_id
  WHERE command.operation_id=NEW.operation_id AND command.action=NEW.action
    AND command.request_fingerprint=NEW.request_fingerprint AND command.target_id=NEW.target_id
    AND command.recipient_binding_id IS NEW.recipient_binding_id
    AND command.resulting_ownership_epoch=NEW.ownership_epoch
    AND command.resulting_grant_revision IS NEW.grant_revision
    AND recipient.target_id=NEW.target_id AND recipient.ownership_epoch=NEW.ownership_epoch
    AND recipient.grant_revision=NEW.grant_revision AND recipient.state=NEW.state
    AND recipient.latest_operation_id=NEW.operation_id
) BEGIN SELECT RAISE(ABORT,'native authority history does not close its exact head'); END;

CREATE TRIGGER operations_portal_native_authority_receipt_guard
BEFORE INSERT ON operations_portal_native_authority_receipts WHEN NOT EXISTS(
  SELECT 1 FROM operations_portal_native_authority_commands command
  JOIN operations_portal_native_authority_history history ON history.operation_id=command.operation_id
  JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=command.target_id
  LEFT JOIN operations_portal_native_recipient_authority_heads recipient ON recipient.recipient_binding_id=command.recipient_binding_id
  WHERE command.operation_id=NEW.operation_id AND command.request_fingerprint=NEW.request_fingerprint
    AND command.action=NEW.action AND command.target_id=NEW.target_id
    AND NEW.ownership_epoch=command.resulting_ownership_epoch AND NEW.grant_revision IS command.resulting_grant_revision
    AND NEW.recipient_binding_id IS command.recipient_binding_id AND history.request_fingerprint=NEW.request_fingerprint
    AND ((command.action='workspace.revoke' AND workspace.state='revoked' AND workspace.ownership_epoch=NEW.ownership_epoch
      AND workspace.latest_operation_id=NEW.operation_id
      AND NOT EXISTS(SELECT 1 FROM operations_portal_native_recipient_authority_heads child WHERE child.target_id=command.target_id AND child.state='active'))
      OR (command.action<>'workspace.revoke' AND recipient.latest_operation_id=NEW.operation_id
        AND recipient.ownership_epoch=NEW.ownership_epoch AND recipient.grant_revision=NEW.grant_revision AND recipient.state=NEW.state))
) BEGIN SELECT RAISE(ABORT,'native authority receipt does not close exact durable heads'); END;

CREATE TRIGGER operations_portal_native_authority_commands_immutable BEFORE UPDATE ON operations_portal_native_authority_commands BEGIN SELECT RAISE(ABORT,'native authority commands are immutable'); END;
CREATE TRIGGER operations_portal_native_authority_commands_no_delete BEFORE DELETE ON operations_portal_native_authority_commands BEGIN SELECT RAISE(ABORT,'native authority commands cannot be deleted'); END;
CREATE TRIGGER operations_portal_native_authority_receipts_immutable BEFORE UPDATE ON operations_portal_native_authority_receipts BEGIN SELECT RAISE(ABORT,'native authority receipts are immutable'); END;
CREATE TRIGGER operations_portal_native_authority_receipts_no_delete BEFORE DELETE ON operations_portal_native_authority_receipts BEGIN SELECT RAISE(ABORT,'native authority receipts cannot be deleted'); END;
CREATE TRIGGER operations_portal_native_authority_history_immutable BEFORE UPDATE ON operations_portal_native_authority_history BEGIN SELECT RAISE(ABORT,'native authority history is immutable'); END;
CREATE TRIGGER operations_portal_native_authority_history_no_delete BEFORE DELETE ON operations_portal_native_authority_history BEGIN SELECT RAISE(ABORT,'native authority history cannot be deleted'); END;
CREATE TRIGGER operations_portal_native_workspace_authority_no_delete BEFORE DELETE ON operations_portal_native_workspace_authority_heads BEGIN SELECT RAISE(ABORT,'native workspace authority cannot be deleted'); END;
CREATE TRIGGER operations_portal_native_recipient_authority_no_delete BEFORE DELETE ON operations_portal_native_recipient_authority_heads BEGIN SELECT RAISE(ABORT,'native recipient authority cannot be deleted'); END;
