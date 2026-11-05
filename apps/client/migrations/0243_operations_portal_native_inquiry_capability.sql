-- Mirror a separate audited request.create companion. It never changes the
-- frozen v3 home-authority rows and is useful only while that exact parent is current.
CREATE TABLE operations_portal_native_inquiry_capability_commands (
  operation_id TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL UNIQUE CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  action TEXT NOT NULL CHECK(action IN ('grant','revoke')),
  canonical_command_json TEXT NOT NULL CHECK(json_valid(canonical_command_json) AND json_type(canonical_command_json)='object'
    AND length(CAST(canonical_command_json AS BLOB))<=16384),
  intent_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_revision INTEGER NOT NULL CHECK(target_revision>=1),
  client_authority_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  target_client_record_id TEXT NOT NULL,
  recipient_binding_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  base_operation_id TEXT NOT NULL,
  base_ownership_epoch INTEGER NOT NULL CHECK(base_ownership_epoch>=1),
  base_grant_revision INTEGER NOT NULL CHECK(base_grant_revision>=1),
  publication_operation_id TEXT NOT NULL,
  publication_revision INTEGER NOT NULL CHECK(publication_revision>=1),
  publication_source_sequence INTEGER NOT NULL CHECK(publication_source_sequence>=1),
  publication_snapshot_id TEXT NOT NULL,
  publication_snapshot_sha256 TEXT NOT NULL CHECK(length(publication_snapshot_sha256)=64 AND publication_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
  resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1),
  permission TEXT NOT NULL CHECK(permission='operations.request.create'),
  expires_at TEXT NOT NULL CHECK(length(expires_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS expires_at),
  actor_staff_id TEXT NOT NULL,
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
  intent_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  recipient_binding_id TEXT NOT NULL,
  base_operation_id TEXT NOT NULL,
  base_ownership_epoch INTEGER NOT NULL CHECK(base_ownership_epoch>=1),
  base_grant_revision INTEGER NOT NULL CHECK(base_grant_revision>=1),
  revision INTEGER NOT NULL CHECK(revision>=1),
  state TEXT NOT NULL CHECK(state IN ('prepared','active','revoked')),
  latest_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_inquiry_capability_commands(operation_id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX operations_portal_native_inquiry_capability_active_base
  ON operations_portal_native_inquiry_capability_heads(base_operation_id) WHERE state IN ('prepared','active');

CREATE TABLE operations_portal_native_inquiry_capability_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_inquiry_capability_commands(operation_id) ON DELETE RESTRICT,
  request_fingerprint TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('prepared','active','revoked')),
  resulting_revision INTEGER NOT NULL CHECK(resulting_revision>=1),
  recorded_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE operations_portal_native_inquiry_capability_closures (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_inquiry_capability_receipts(operation_id) ON DELETE RESTRICT,
  request_fingerprint TEXT NOT NULL UNIQUE,
  client_receipt_fingerprint TEXT NOT NULL CHECK(length(client_receipt_fingerprint)=64 AND client_receipt_fingerprint NOT GLOB '*[^0-9a-f]*'),
  operations_receipt_fingerprint TEXT NOT NULL CHECK(length(operations_receipt_fingerprint)=64 AND operations_receipt_fingerprint NOT GLOB '*[^0-9a-f]*'),
  resulting_state TEXT NOT NULL CHECK(resulting_state='active'),
  recorded_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER operations_portal_native_inquiry_capability_command_immutable
BEFORE UPDATE ON operations_portal_native_inquiry_capability_commands
BEGIN SELECT RAISE(ABORT,'native inquiry capability commands are immutable'); END;
CREATE TRIGGER operations_portal_native_inquiry_capability_command_durable
BEFORE DELETE ON operations_portal_native_inquiry_capability_commands
BEGIN SELECT RAISE(ABORT,'native inquiry capability commands are durable'); END;
CREATE TRIGGER operations_portal_native_inquiry_capability_receipt_immutable
BEFORE UPDATE ON operations_portal_native_inquiry_capability_receipts
BEGIN SELECT RAISE(ABORT,'native inquiry capability receipts are immutable'); END;
CREATE TRIGGER operations_portal_native_inquiry_capability_receipt_durable
BEFORE DELETE ON operations_portal_native_inquiry_capability_receipts
BEGIN SELECT RAISE(ABORT,'native inquiry capability receipts are durable'); END;
CREATE TRIGGER operations_portal_native_inquiry_capability_closure_immutable
BEFORE UPDATE ON operations_portal_native_inquiry_capability_closures
BEGIN SELECT RAISE(ABORT,'native inquiry capability closures are immutable'); END;
CREATE TRIGGER operations_portal_native_inquiry_capability_closure_durable
BEFORE DELETE ON operations_portal_native_inquiry_capability_closures
BEGIN SELECT RAISE(ABORT,'native inquiry capability closures are durable'); END;

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
BEGIN SELECT RAISE(ABORT,'native inquiry capability command JSON does not match its columns'); END;

-- The private Operations service can close a prepared mirror only while the
-- exact v3 parent and publication are still current. This repeats the reader
-- predicate inside the write transaction to fence a parent change between the
-- RPC's preflight read and closure.
CREATE TRIGGER operations_portal_native_inquiry_capability_closure_insert_guard
BEFORE INSERT ON operations_portal_native_inquiry_capability_closures
WHEN NOT EXISTS(SELECT 1
  FROM operations_portal_native_inquiry_capability_commands command
  JOIN operations_portal_native_inquiry_capability_receipts receipt
    ON receipt.operation_id=command.operation_id AND receipt.request_fingerprint=command.request_fingerprint
      AND receipt.state='prepared' AND receipt.resulting_revision=command.resulting_revision
  JOIN operations_portal_native_inquiry_capability_heads cap_head
    ON cap_head.intent_id=command.intent_id AND cap_head.latest_operation_id=command.operation_id
      AND cap_head.state='prepared' AND cap_head.revision=command.resulting_revision
  JOIN operations_portal_native_recipient_authority_heads recipient
    ON recipient.recipient_binding_id=command.recipient_binding_id AND recipient.target_id=command.target_id
      AND recipient.enrollment_intent_id=command.intent_id AND recipient.latest_operation_id=command.base_operation_id
      AND recipient.ownership_epoch=command.base_ownership_epoch AND recipient.grant_revision=command.base_grant_revision
      AND recipient.state='active' AND recipient.permissions_json='["operations.service_home.read"]'
      AND recipient.issuer=command.issuer AND recipient.subject=command.subject
  JOIN operations_portal_native_authority_receipts base_receipt
    ON base_receipt.operation_id=recipient.latest_operation_id AND base_receipt.state='active'
      AND base_receipt.action='recipient.grant' AND base_receipt.target_id=recipient.target_id
      AND base_receipt.recipient_binding_id=recipient.recipient_binding_id
      AND base_receipt.ownership_epoch=recipient.ownership_epoch AND base_receipt.grant_revision=recipient.grant_revision
  JOIN operations_portal_native_workspace_authority_heads workspace
    ON workspace.target_id=recipient.target_id AND workspace.state='active'
      AND workspace.ownership_epoch=recipient.ownership_epoch AND workspace.target_revision=command.target_revision
      AND workspace.client_authority_id=command.client_authority_id AND workspace.workspace_id=command.workspace_id
  JOIN operations_portal_workspace_publication_heads publication
    ON publication.target_id=workspace.target_id AND publication.target_revision=workspace.target_revision
      AND publication.client_authority_id=workspace.client_authority_id AND publication.workspace_id=workspace.workspace_id
      AND publication.latest_operation_id=command.publication_operation_id
      AND publication.revision=command.publication_revision AND publication.source_sequence=command.publication_source_sequence
      AND publication.snapshot_id=command.publication_snapshot_id
      AND publication.snapshot_sha256=command.publication_snapshot_sha256
  JOIN operations_portal_workspace_publication_receipts publication_receipt
    ON publication_receipt.operation_id=publication.latest_operation_id
      AND publication_receipt.resulting_revision=publication.revision
      AND publication_receipt.source_sequence=publication.source_sequence
      AND publication_receipt.snapshot_id=publication.snapshot_id
      AND publication_receipt.snapshot_sha256=publication.snapshot_sha256
  JOIN operations_portal_workspace_publication_snapshots snapshot
    ON snapshot.snapshot_id=publication.snapshot_id AND snapshot.operation_id=publication.latest_operation_id
      AND snapshot.target_id=publication.target_id AND snapshot.revision=publication.revision
      AND snapshot.source_sequence=publication.source_sequence AND snapshot.snapshot_sha256=publication.snapshot_sha256
  JOIN operations_portal_workspace_publication_history history
    ON history.operation_id=publication_receipt.operation_id AND history.target_id=publication.target_id
      AND history.revision=publication.revision AND history.source_sequence=publication.source_sequence
      AND history.snapshot_id=publication.snapshot_id AND history.snapshot_sha256=publication.snapshot_sha256
  JOIN json_each(snapshot.snapshot_json,'$.directoryRecords') member
  WHERE command.operation_id=NEW.operation_id AND command.action='grant'
    AND NEW.request_fingerprint=command.request_fingerprint
    AND NEW.client_receipt_fingerprint=receipt.request_fingerprint
    AND NEW.operations_receipt_fingerprint IS NOT NULL AND NEW.resulting_state='active'
    AND command.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND (recipient.expires_at IS NULL OR datetime(command.expires_at)<=datetime(recipient.expires_at))
    AND json_extract(member.value,'$.recordId')=recipient.target_client_record_id
    AND json_extract(member.value,'$.kind')='client'
    AND ((workspace.root_kind='organization' AND json_extract(member.value,'$.parentRecordId')=workspace.root_record_id)
      OR (workspace.root_kind='standalone_client' AND json_extract(member.value,'$.parentRecordId') IS NULL
        AND json_extract(member.value,'$.recordId')=workspace.root_record_id)))
BEGIN SELECT RAISE(ABORT,'native inquiry capability closure is stale or incomplete'); END;

CREATE TRIGGER operations_portal_native_inquiry_capability_head_insert_guard
BEFORE INSERT ON operations_portal_native_inquiry_capability_heads
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_inquiry_capability_commands command
  JOIN operations_portal_native_inquiry_capability_receipts receipt ON receipt.operation_id=command.operation_id
    AND receipt.request_fingerprint=command.request_fingerprint AND receipt.state='prepared'
  JOIN operations_portal_native_recipient_authority_heads base ON base.recipient_binding_id=command.recipient_binding_id
    AND base.target_id=command.target_id AND base.enrollment_intent_id=command.intent_id
    AND base.target_client_record_id=command.target_client_record_id AND base.issuer=command.issuer AND base.subject=command.subject
    AND base.ownership_epoch=command.base_ownership_epoch AND base.grant_revision=command.base_grant_revision
    AND base.latest_operation_id=command.base_operation_id AND base.state='active'
    AND base.permissions_json='["operations.service_home.read"]'
  JOIN operations_portal_native_authority_receipts base_receipt ON base_receipt.operation_id=base.latest_operation_id
    AND base_receipt.request_fingerprint=(SELECT request_fingerprint FROM operations_portal_native_authority_commands WHERE operation_id=base.latest_operation_id)
    AND base_receipt.state='active' AND base_receipt.action='recipient.grant'
    AND base_receipt.target_id=base.target_id AND base_receipt.recipient_binding_id=base.recipient_binding_id
    AND base_receipt.ownership_epoch=base.ownership_epoch AND base_receipt.grant_revision=base.grant_revision
  JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=base.target_id
    AND workspace.state='active' AND workspace.ownership_epoch=base.ownership_epoch
    AND workspace.target_revision=command.target_revision AND workspace.client_authority_id=command.client_authority_id
    AND workspace.workspace_id=command.workspace_id
  JOIN operations_portal_workspace_publication_heads publication ON publication.target_id=workspace.target_id
    AND publication.target_revision=command.target_revision AND publication.client_authority_id=command.client_authority_id
    AND publication.workspace_id=command.workspace_id AND publication.latest_operation_id=command.publication_operation_id
    AND publication.revision=command.publication_revision AND publication.source_sequence=command.publication_source_sequence
    AND publication.snapshot_id=command.publication_snapshot_id AND publication.snapshot_sha256=command.publication_snapshot_sha256
  JOIN operations_portal_workspace_publication_receipts pub_receipt ON pub_receipt.operation_id=publication.latest_operation_id
    AND pub_receipt.resulting_revision=publication.revision AND pub_receipt.source_sequence=publication.source_sequence
    AND pub_receipt.snapshot_id=publication.snapshot_id AND pub_receipt.snapshot_sha256=publication.snapshot_sha256
  JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.snapshot_id=publication.snapshot_id
    AND snapshot.operation_id=publication.latest_operation_id AND snapshot.target_id=publication.target_id
    AND snapshot.revision=publication.revision AND snapshot.source_sequence=publication.source_sequence
    AND snapshot.snapshot_sha256=publication.snapshot_sha256
  JOIN json_each(snapshot.snapshot_json,'$.directoryRecords') member
  WHERE command.operation_id=NEW.latest_operation_id AND command.intent_id=NEW.intent_id AND command.action='grant'
    AND command.expected_revision=0 AND command.resulting_revision=1 AND command.base_operation_id=base.latest_operation_id
    AND NEW.target_id=command.target_id AND NEW.recipient_binding_id=command.recipient_binding_id
    AND NEW.base_operation_id=command.base_operation_id AND NEW.base_ownership_epoch=command.base_ownership_epoch
    AND NEW.base_grant_revision=command.base_grant_revision AND NEW.revision=1 AND NEW.state='prepared'
    AND command.expires_at>command.observed_at AND command.actor_verified_until>command.observed_at
    AND json_extract(member.value,'$.recordId')=command.target_client_record_id AND json_extract(member.value,'$.kind')='client'
    AND ((workspace.root_kind='organization' AND json_extract(member.value,'$.parentRecordId')=workspace.root_record_id)
      OR (workspace.root_kind='standalone_client' AND json_extract(member.value,'$.parentRecordId') IS NULL
        AND json_extract(member.value,'$.recordId')=workspace.root_record_id)))
BEGIN SELECT RAISE(ABORT,'native inquiry capability parent changed or receipt is not prepared'); END;

CREATE TRIGGER operations_portal_native_inquiry_capability_head_update_guard
BEFORE UPDATE ON operations_portal_native_inquiry_capability_heads
WHEN NEW.intent_id IS NOT OLD.intent_id OR NEW.target_id IS NOT OLD.target_id
  OR NEW.recipient_binding_id IS NOT OLD.recipient_binding_id OR NEW.base_operation_id IS NOT OLD.base_operation_id
  OR NEW.base_ownership_epoch<>OLD.base_ownership_epoch OR NEW.base_grant_revision<>OLD.base_grant_revision
  OR (NEW.revision<>OLD.revision+1 AND NOT (OLD.state='prepared' AND NEW.state='active' AND NEW.revision=OLD.revision))
  OR NOT ((OLD.state='prepared' AND NEW.state='active' AND NEW.revision=OLD.revision AND EXISTS(SELECT 1
      FROM operations_portal_native_inquiry_capability_commands command
      JOIN operations_portal_native_inquiry_capability_receipts receipt ON receipt.operation_id=command.operation_id
        AND receipt.request_fingerprint=command.request_fingerprint AND receipt.state='prepared'
      JOIN operations_portal_native_inquiry_capability_closures closure ON closure.operation_id=command.operation_id
        AND closure.request_fingerprint IS NOT NULL
        AND closure.client_receipt_fingerprint=receipt.request_fingerprint
        AND closure.operations_receipt_fingerprint IS NOT NULL AND closure.resulting_state='active'
      WHERE command.operation_id=OLD.latest_operation_id AND command.action='grant' AND command.expected_revision=0
        AND command.resulting_revision=1 AND NEW.latest_operation_id=OLD.latest_operation_id)
    OR OLD.state IN ('prepared','active') AND NEW.state='revoked' AND EXISTS(SELECT 1
      FROM operations_portal_native_inquiry_capability_commands command
      JOIN operations_portal_native_inquiry_capability_receipts receipt ON receipt.operation_id=command.operation_id
        AND receipt.request_fingerprint=command.request_fingerprint AND receipt.state='revoked'
      JOIN operations_portal_native_inquiry_capability_commands original ON original.operation_id=OLD.latest_operation_id
        AND original.action='grant'
      WHERE command.operation_id=NEW.latest_operation_id AND command.intent_id=OLD.intent_id AND command.action='revoke'
        AND command.expected_revision=OLD.revision AND command.resulting_revision=NEW.revision
        AND command.base_operation_id=OLD.base_operation_id AND command.target_id=original.target_id
        AND command.target_revision=original.target_revision AND command.client_authority_id=original.client_authority_id
        AND command.workspace_id=original.workspace_id AND command.target_client_record_id=original.target_client_record_id
        AND command.recipient_binding_id=original.recipient_binding_id AND command.issuer=original.issuer
        AND command.subject=original.subject AND command.base_ownership_epoch=original.base_ownership_epoch
        AND command.base_grant_revision=original.base_grant_revision
        AND command.publication_operation_id=original.publication_operation_id
        AND command.publication_revision=original.publication_revision
        AND command.publication_source_sequence=original.publication_source_sequence
        AND command.publication_snapshot_id=original.publication_snapshot_id
        AND command.publication_snapshot_sha256=original.publication_snapshot_sha256
        AND command.expires_at=original.expires_at)))
BEGIN SELECT RAISE(ABORT,'native inquiry capability transition is not exactly receipted'); END;
