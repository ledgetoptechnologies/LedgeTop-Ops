PRAGMA foreign_keys=ON;

-- Data-only termination evidence for an Ops publication whose remote outcome
-- was ambiguous. This deliberately depends on 0223 only; it creates no
-- principal, enrollment, grant, entitlement, membership, or folder authority.
CREATE TABLE operations_portal_workspace_publication_cancellations (
  operation_id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL UNIQUE CHECK(length(request_fingerprint)=64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  target_id TEXT NOT NULL,
  target_revision INTEGER NOT NULL CHECK(target_revision>=1),
  client_authority_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  root_kind TEXT NOT NULL CHECK(root_kind IN ('organization','standalone_client')),
  root_record_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
  resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1),
  source_sequence INTEGER NOT NULL CHECK(source_sequence=resulting_revision),
  snapshot_id TEXT NOT NULL UNIQUE,
  checkpoint_id TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256)=64
    AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  canonical_publication_json TEXT NOT NULL CHECK(json_valid(canonical_publication_json)
    AND length(CAST(canonical_publication_json AS BLOB))<=1900000),
  observed_at TEXT NOT NULL CHECK(length(observed_at)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',observed_at) IS observed_at),
  cancelled_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    CHECK(length(cancelled_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',cancelled_at) IS cancelled_at)
);

CREATE TRIGGER operations_portal_workspace_publication_cancellation_json_guard
BEFORE INSERT ON operations_portal_workspace_publication_cancellations
WHEN json_type(NEW.canonical_publication_json) IS NOT 'object'
 OR (SELECT count(*) FROM json_each(NEW.canonical_publication_json))<>11
 OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_publication_json) member WHERE member.key NOT IN
   ('protocol','protocolVersion','action','publicationId','operationId','expectedRevision','resultingRevision',
    'target','snapshot','actorProof','observedAt'))
 OR json_extract(NEW.canonical_publication_json,'$.protocol') IS NOT 'operations-portal-workspace-publication'
 OR json_type(NEW.canonical_publication_json,'$.protocolVersion') IS NOT 'integer'
 OR json_extract(NEW.canonical_publication_json,'$.protocolVersion') IS NOT 1
 OR json_extract(NEW.canonical_publication_json,'$.action') IS NOT 'publish'
 OR json_extract(NEW.canonical_publication_json,'$.publicationId') IS NOT NEW.publication_id
 OR json_extract(NEW.canonical_publication_json,'$.operationId') IS NOT NEW.operation_id
 OR json_extract(NEW.canonical_publication_json,'$.expectedRevision') IS NOT CAST(NEW.expected_revision AS TEXT)
 OR json_extract(NEW.canonical_publication_json,'$.resultingRevision') IS NOT CAST(NEW.resulting_revision AS TEXT)
 OR json_extract(NEW.canonical_publication_json,'$.observedAt') IS NOT NEW.observed_at
 OR json_type(NEW.canonical_publication_json,'$.target') IS NOT 'object'
 OR (SELECT count(*) FROM json_each(NEW.canonical_publication_json,'$.target'))<>6
 OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_publication_json,'$.target') member WHERE member.key NOT IN
   ('targetId','targetRevision','clientAuthorityId','workspaceId','rootKind','rootRecordId'))
 OR json_extract(NEW.canonical_publication_json,'$.target.targetId') IS NOT NEW.target_id
 OR json_extract(NEW.canonical_publication_json,'$.target.targetRevision') IS NOT CAST(NEW.target_revision AS TEXT)
 OR json_extract(NEW.canonical_publication_json,'$.target.clientAuthorityId') IS NOT NEW.client_authority_id
 OR json_extract(NEW.canonical_publication_json,'$.target.workspaceId') IS NOT NEW.workspace_id
 OR json_extract(NEW.canonical_publication_json,'$.target.rootKind') IS NOT NEW.root_kind
 OR json_extract(NEW.canonical_publication_json,'$.target.rootRecordId') IS NOT NEW.root_record_id
 OR json_type(NEW.canonical_publication_json,'$.snapshot') IS NOT 'object'
 OR (SELECT count(*) FROM json_each(NEW.canonical_publication_json,'$.snapshot'))<>11
 OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_publication_json,'$.snapshot') member WHERE member.key NOT IN
   ('snapshotId','checkpointId','sourceSequence','complete','counts','snapshotSha256','directoryRecords','projects',
    'folderReservations','recipientAuthorityHeads','deliveryAuthorityHeads'))
 OR json_extract(NEW.canonical_publication_json,'$.snapshot.snapshotId') IS NOT NEW.snapshot_id
 OR json_extract(NEW.canonical_publication_json,'$.snapshot.checkpointId') IS NOT NEW.checkpoint_id
 OR json_extract(NEW.canonical_publication_json,'$.snapshot.sourceSequence') IS NOT CAST(NEW.source_sequence AS TEXT)
 OR json_extract(NEW.canonical_publication_json,'$.snapshot.snapshotSha256') IS NOT NEW.snapshot_sha256
 OR json_type(NEW.canonical_publication_json,'$.snapshot.complete') IS NOT 'true'
 OR json_type(NEW.canonical_publication_json,'$.snapshot.counts') IS NOT 'object'
 OR (SELECT count(*) FROM json_each(NEW.canonical_publication_json,'$.snapshot.counts'))<>5
 OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_publication_json,'$.snapshot.counts') member WHERE member.key NOT IN
   ('directoryRecords','projects','folderReservations','recipientAuthorityHeads','deliveryAuthorityHeads'))
 OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_publication_json,'$.snapshot.counts') member
   WHERE member.type IS NOT 'integer' OR member.value<0)
 OR json_type(NEW.canonical_publication_json,'$.snapshot.directoryRecords') IS NOT 'array'
 OR json_type(NEW.canonical_publication_json,'$.snapshot.projects') IS NOT 'array'
 OR json_type(NEW.canonical_publication_json,'$.snapshot.folderReservations') IS NOT 'array'
 OR json_type(NEW.canonical_publication_json,'$.snapshot.recipientAuthorityHeads') IS NOT 'array'
 OR json_type(NEW.canonical_publication_json,'$.snapshot.deliveryAuthorityHeads') IS NOT 'array'
 OR json_array_length(NEW.canonical_publication_json,'$.snapshot.directoryRecords')<1
 OR json_extract(NEW.canonical_publication_json,'$.snapshot.counts.directoryRecords') IS NOT
   json_array_length(NEW.canonical_publication_json,'$.snapshot.directoryRecords')
 OR json_extract(NEW.canonical_publication_json,'$.snapshot.counts.projects') IS NOT
   json_array_length(NEW.canonical_publication_json,'$.snapshot.projects')
 OR json_extract(NEW.canonical_publication_json,'$.snapshot.counts.folderReservations') IS NOT
   json_array_length(NEW.canonical_publication_json,'$.snapshot.folderReservations')
 OR json_extract(NEW.canonical_publication_json,'$.snapshot.counts.recipientAuthorityHeads') IS NOT
   json_array_length(NEW.canonical_publication_json,'$.snapshot.recipientAuthorityHeads')
 OR json_extract(NEW.canonical_publication_json,'$.snapshot.counts.deliveryAuthorityHeads') IS NOT
   json_array_length(NEW.canonical_publication_json,'$.snapshot.deliveryAuthorityHeads')
 OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_publication_json,'$.snapshot.directoryRecords') item
   WHERE item.type IS NOT 'object' OR (SELECT count(*) FROM json_each(item.value))<>7
     OR (SELECT count(DISTINCT key) FROM json_each(item.value))<>7
     OR EXISTS(SELECT 1 FROM json_each(item.value) member WHERE member.key NOT IN
       ('recordId','kind','version','parentRecordId','relationshipVersion','displayName','externalFences'))
     OR json_type(item.value,'$.recordId') IS NOT 'text' OR json_type(item.value,'$.kind') IS NOT 'text'
     OR json_extract(item.value,'$.kind') NOT IN ('organization','client')
     OR json_type(item.value,'$.version') IS NOT 'text' OR json_type(item.value,'$.displayName') IS NOT 'text'
     OR COALESCE(json_type(item.value,'$.parentRecordId'),'missing') NOT IN ('text','null')
     OR COALESCE(json_type(item.value,'$.relationshipVersion'),'missing') NOT IN ('text','null')
     OR json_type(item.value,'$.externalFences') IS NOT 'array'
     OR json_array_length(item.value,'$.externalFences')>8
     OR (json_extract(item.value,'$.kind')='organization'
       AND (json_type(item.value,'$.parentRecordId') IS NOT 'null'
         OR json_type(item.value,'$.relationshipVersion') IS NOT 'null'))
     OR (json_extract(item.value,'$.kind')='client'
       AND json_type(item.value,'$.relationshipVersion') IS NOT 'text')
     OR EXISTS(SELECT 1 FROM json_each(item.value,'$.externalFences') fence
       WHERE fence.type IS NOT 'object' OR (SELECT count(*) FROM json_each(fence.value))<>8
         OR (SELECT count(DISTINCT key) FROM json_each(fence.value))<>8
         OR EXISTS(SELECT 1 FROM json_each(fence.value) member WHERE member.key NOT IN
           ('sourceId','sourceInstanceId','applicationId','historyEpoch','authorizationGeneration','publicId','revision',
            'projectionSha256'))
         OR EXISTS(SELECT 1 FROM json_each(fence.value) member WHERE member.type IS NOT 'text')))
 OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_publication_json,'$.snapshot.projects') item
   WHERE item.type IS NOT 'object' OR (SELECT count(*) FROM json_each(item.value))<>14
     OR (SELECT count(DISTINCT key) FROM json_each(item.value))<>14
     OR EXISTS(SELECT 1 FROM json_each(item.value) member WHERE member.key NOT IN
       ('externalProjectId','version','name','lifecycle','plannedStart','plannedEnd','completedAt','archived','archivedAt',
        'overdueWarning','published','organizationRecordId','clientRecordId','externalFence'))
     OR json_type(item.value,'$.externalProjectId') IS NOT 'text'
     OR json_type(item.value,'$.version') IS NOT 'text' OR json_type(item.value,'$.name') IS NOT 'text'
     OR json_type(item.value,'$.lifecycle') IS NOT 'text'
     OR COALESCE(json_extract(item.value,'$.lifecycle'),'missing') NOT IN ('not_started','active','completed','cancelled')
     OR COALESCE(json_type(item.value,'$.plannedStart'),'missing') NOT IN ('text','null')
     OR COALESCE(json_type(item.value,'$.plannedEnd'),'missing') NOT IN ('text','null')
     OR COALESCE(json_type(item.value,'$.completedAt'),'missing') NOT IN ('text','null')
     OR COALESCE(json_type(item.value,'$.archived'),'missing') NOT IN ('true','false')
     OR COALESCE(json_type(item.value,'$.archivedAt'),'missing') NOT IN ('text','null')
     OR COALESCE(json_type(item.value,'$.overdueWarning'),'missing') NOT IN ('true','false')
     OR COALESCE(json_type(item.value,'$.published'),'missing') NOT IN ('true','false')
     OR COALESCE(json_type(item.value,'$.organizationRecordId'),'missing') NOT IN ('text','null')
     OR COALESCE(json_type(item.value,'$.clientRecordId'),'missing') NOT IN ('text','null')
     OR COALESCE(json_type(item.value,'$.externalFence'),'missing') NOT IN ('object','null')
     OR (json_type(item.value,'$.externalFence')='object' AND
       ((SELECT count(*) FROM json_each(item.value,'$.externalFence'))<>8
        OR (SELECT count(DISTINCT key) FROM json_each(item.value,'$.externalFence'))<>8
        OR EXISTS(SELECT 1 FROM json_each(item.value,'$.externalFence') member WHERE member.key NOT IN
          ('sourceId','sourceInstanceId','applicationId','historyEpoch','authorizationGeneration','publicId','revision',
           'projectionSha256'))
        OR EXISTS(SELECT 1 FROM json_each(item.value,'$.externalFence') member WHERE member.type IS NOT 'text'))))
 OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_publication_json,'$.snapshot.folderReservations') item
   WHERE item.type IS NOT 'object' OR (SELECT count(*) FROM json_each(item.value))<>8
     OR (SELECT count(DISTINCT key) FROM json_each(item.value))<>8
     OR EXISTS(SELECT 1 FROM json_each(item.value) member WHERE member.key NOT IN
       ('reservationId','externalProjectId','opsFolderProjectId','divisionId','clientFolderBindingId','bindingVersion',
        'r2Prefix','state'))
     OR EXISTS(SELECT 1 FROM json_each(item.value) member WHERE member.type IS NOT 'text')
     OR COALESCE(json_extract(item.value,'$.state'),'missing') NOT IN ('active','revoked'))
 OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_publication_json,'$.snapshot.recipientAuthorityHeads') item
   WHERE item.type IS NOT 'object' OR (SELECT count(*) FROM json_each(item.value))<>14
     OR (SELECT count(DISTINCT key) FROM json_each(item.value))<>14
     OR EXISTS(SELECT 1 FROM json_each(item.value) member WHERE member.key NOT IN
       ('recipientBindingId','enrollmentIntentId','targetClientRecordId','clientAuthorityId','workspaceId','issuer','subject',
        'enrollmentRevision','ownershipEpoch','grantRevision','state','lastOperationId','protocolVersion','permissions'))
     OR EXISTS(SELECT 1 FROM json_each(item.value) member WHERE member.key NOT IN ('protocolVersion','permissions')
       AND member.type IS NOT 'text')
     OR json_type(item.value,'$.protocolVersion') IS NOT 'integer'
     OR json_extract(item.value,'$.protocolVersion') IS NOT 3
     OR json_type(item.value,'$.permissions') IS NOT 'array'
     OR json_array_length(item.value,'$.permissions')>1
     OR EXISTS(SELECT 1 FROM json_each(item.value,'$.permissions') permission
       WHERE permission.type IS NOT 'text' OR permission.value IS NOT 'operations.service_home.read')
     OR (json_extract(item.value,'$.state')='active' AND json_array_length(item.value,'$.permissions')<>1)
     OR (json_extract(item.value,'$.state')='revoked' AND json_array_length(item.value,'$.permissions')<>0)
     OR COALESCE(json_extract(item.value,'$.state'),'missing') NOT IN ('active','revoked'))
 OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_publication_json,'$.snapshot.deliveryAuthorityHeads') item
   WHERE item.type IS NOT 'object' OR (SELECT count(*) FROM json_each(item.value))<>13
     OR (SELECT count(DISTINCT key) FROM json_each(item.value))<>13
     OR EXISTS(SELECT 1 FROM json_each(item.value) member WHERE member.key NOT IN
       ('authorityId','authorityRevision','state','lastOperationId','clientAuthorityId','workspaceId','recipientBindingId',
        'enrollmentIntentId','homeOwnershipEpoch','homeGrantRevision','folderReservationId','folderBindingId','expiresAt'))
     OR EXISTS(SELECT 1 FROM json_each(item.value) member WHERE member.key<>'expiresAt' AND member.type IS NOT 'text')
     OR COALESCE(json_type(item.value,'$.expiresAt'),'missing') NOT IN ('text','null')
     OR COALESCE(json_extract(item.value,'$.state'),'missing') NOT IN ('active','revoked'))
 OR json_type(NEW.canonical_publication_json,'$.actorProof') IS NOT 'object'
 OR (SELECT count(*) FROM json_each(NEW.canonical_publication_json,'$.actorProof'))<>6
 OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_publication_json,'$.actorProof') member WHERE member.key NOT IN
   ('staffId','verifiedAccessSubject','admissionVersion','profileVersion','grantGeneration','verifiedUntil'))
 OR json_type(NEW.canonical_publication_json,'$.actorProof.staffId') IS NOT 'text'
 OR length(json_extract(NEW.canonical_publication_json,'$.actorProof.staffId'))<1
 OR json_type(NEW.canonical_publication_json,'$.actorProof.verifiedAccessSubject') IS NOT 'text'
 OR length(json_extract(NEW.canonical_publication_json,'$.actorProof.verifiedAccessSubject'))<1
 OR json_type(NEW.canonical_publication_json,'$.actorProof.admissionVersion') IS NOT 'text'
 OR json_extract(NEW.canonical_publication_json,'$.actorProof.admissionVersion') NOT GLOB '[1-9]*'
 OR json_extract(NEW.canonical_publication_json,'$.actorProof.admissionVersion') GLOB '*[^0-9]*'
 OR json_type(NEW.canonical_publication_json,'$.actorProof.profileVersion') IS NOT 'text'
 OR json_extract(NEW.canonical_publication_json,'$.actorProof.profileVersion') NOT GLOB '[1-9]*'
 OR json_extract(NEW.canonical_publication_json,'$.actorProof.profileVersion') GLOB '*[^0-9]*'
 OR json_type(NEW.canonical_publication_json,'$.actorProof.grantGeneration') IS NOT 'text'
 OR json_extract(NEW.canonical_publication_json,'$.actorProof.grantGeneration') NOT GLOB '[1-9]*'
 OR json_extract(NEW.canonical_publication_json,'$.actorProof.grantGeneration') GLOB '*[^0-9]*'
 OR json_type(NEW.canonical_publication_json,'$.actorProof.verifiedUntil') IS NOT 'text'
 OR strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(NEW.canonical_publication_json,'$.actorProof.verifiedUntil')) IS NOT
   json_extract(NEW.canonical_publication_json,'$.actorProof.verifiedUntil')
 OR julianday(json_extract(NEW.canonical_publication_json,'$.actorProof.verifiedUntil'))<=julianday(NEW.observed_at)
BEGIN SELECT RAISE(ABORT,'publication cancellation canonical JSON does not match its exact row'); END;

CREATE TRIGGER operations_portal_workspace_publication_cancellation_cas_guard
BEFORE INSERT ON operations_portal_workspace_publication_cancellations
WHEN EXISTS(SELECT 1 FROM operations_portal_workspace_publication_commands command
      WHERE command.operation_id=NEW.operation_id OR command.publication_id=NEW.publication_id
        OR command.request_fingerprint=NEW.request_fingerprint OR command.snapshot_id=NEW.snapshot_id)
 OR NOT ((NEW.expected_revision=0 AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_heads head
      WHERE head.target_id=NEW.target_id))
   OR EXISTS(SELECT 1 FROM operations_portal_workspace_publication_heads head
      WHERE head.target_id=NEW.target_id AND head.revision=NEW.expected_revision
        AND head.target_revision=NEW.target_revision AND head.client_authority_id=NEW.client_authority_id
        AND head.workspace_id=NEW.workspace_id AND head.root_kind=NEW.root_kind
        AND head.root_record_id=NEW.root_record_id AND head.source_sequence=NEW.expected_revision))
BEGIN SELECT RAISE(ABORT,'publication cancellation conflicts with committed state'); END;

-- Both commands are serialized by D1. A durable tombstone that wins first
-- rejects the complete late publication, including cross-field identifier reuse.
CREATE TRIGGER operations_portal_workspace_publication_command_cancellation_guard
BEFORE INSERT ON operations_portal_workspace_publication_commands
WHEN EXISTS(SELECT 1 FROM operations_portal_workspace_publication_cancellations cancellation
  WHERE cancellation.operation_id=NEW.operation_id OR cancellation.publication_id=NEW.publication_id
    OR cancellation.request_fingerprint=NEW.request_fingerprint OR cancellation.snapshot_id=NEW.snapshot_id)
BEGIN SELECT RAISE(ABORT,'publication operation has an exact terminal cancellation'); END;

CREATE TRIGGER operations_portal_workspace_publication_cancellations_immutable
BEFORE UPDATE ON operations_portal_workspace_publication_cancellations
BEGIN SELECT RAISE(ABORT,'publication cancellations are immutable'); END;
CREATE TRIGGER operations_portal_workspace_publication_cancellations_no_delete
BEFORE DELETE ON operations_portal_workspace_publication_cancellations
BEGIN SELECT RAISE(ABORT,'publication cancellations cannot be deleted'); END;
