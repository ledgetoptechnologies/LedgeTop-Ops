PRAGMA foreign_keys = ON;

-- Schema-only foundation for a later private canonical settler.  Nothing in
-- this migration mounts a caller or permits 0119 evidence to mutate the 0086
-- mapping/head/history.  In particular, an acknowledged remote command is
-- historical evidence, not current native authority.

-- The current PA v2 shared-project projection contains these fields but the
-- original 0086 head predated them.  Existing rows remain unarchived and keep
-- their prior lifecycle/name/date/customer values.
ALTER TABLE operations_shared_projects ADD COLUMN description TEXT
  CHECK(description IS NULL OR (length(description)<=10000 AND instr(description,char(0))=0));
ALTER TABLE operations_shared_projects ADD COLUMN completed_at TEXT
  CHECK(completed_at IS NULL OR (length(completed_at) BETWEEN 20 AND 32 AND instr(completed_at,char(0))=0));
ALTER TABLE operations_shared_projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0
  CHECK(typeof(archived)='integer' AND archived IN (0,1));
ALTER TABLE operations_shared_projects ADD COLUMN archived_at TEXT
  CHECK(archived_at IS NULL OR (length(archived_at) BETWEEN 20 AND 32 AND instr(archived_at,char(0))=0));
-- NULL marks legacy/native heads that have not gone through an explicit
-- canonical-hash backfill. They cannot issue a version-pinned v2 intent.
ALTER TABLE operations_shared_projects ADD COLUMN canonical_projection_sha256 TEXT
  CHECK(canonical_projection_sha256 IS NULL OR (length(canonical_projection_sha256)=64
    AND canonical_projection_sha256=lower(canonical_projection_sha256)
    AND canonical_projection_sha256 NOT GLOB '*[^0-9a-f]*'));

CREATE TRIGGER operations_shared_projects_archive_shape_insert
BEFORE INSERT ON operations_shared_projects
WHEN (NEW.archived=1) IS NOT (NEW.archived_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'shared project archive state is invalid'); END;

-- A later adapter must insert this immutable intent after the 0119 request
-- fingerprint is reserved and before network dispatch.  The expected local
-- version prevents an acknowledgement from being applied over a later edit.
CREATE TABLE project_alpha_project_v2_canonical_intents (
  command_id TEXT NOT NULL PRIMARY KEY
    REFERENCES project_alpha_project_v2_request_fingerprints(command_id) ON DELETE RESTRICT,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256=lower(request_sha256)
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  operation TEXT NOT NULL CHECK(operation IN ('create','update','bind')),
  external_project_id TEXT NOT NULL
    REFERENCES project_alpha_project_destinations(external_project_id) ON DELETE RESTRICT,
  expected_local_version INTEGER NOT NULL
    CHECK(typeof(expected_local_version)='integer' AND expected_local_version BETWEEN 0 AND 9007199254740991),
  expected_local_projection_sha256 TEXT
    CHECK(expected_local_projection_sha256 IS NULL OR (length(expected_local_projection_sha256)=64
      AND expected_local_projection_sha256=lower(expected_local_projection_sha256)
      AND expected_local_projection_sha256 NOT GLOB '*[^0-9a-f]*')),
  expected_grant_generation INTEGER NOT NULL
    CHECK(typeof(expected_grant_generation)='integer' AND expected_grant_generation BETWEEN 1 AND 9007199254740991),
  expected_mapping_state TEXT NOT NULL CHECK(expected_mapping_state IN ('absent','exact')),
  expected_project_alpha_public_id TEXT
    CHECK(expected_project_alpha_public_id IS NULL OR (length(expected_project_alpha_public_id)=32
      AND expected_project_alpha_public_id=lower(expected_project_alpha_public_id)
      AND expected_project_alpha_public_id NOT GLOB '*[^0-9a-f]*')),
  source_id TEXT NOT NULL CHECK(substr(source_id,1,14)='project-alpha:' AND length(source_id)<=128),
  source_instance_id TEXT NOT NULL CHECK(length(source_instance_id)=36),
  application_id TEXT NOT NULL CHECK(length(application_id)=36),
  history_epoch_id TEXT NOT NULL CHECK(length(history_epoch_id)=36),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((expected_mapping_state='absent' AND expected_project_alpha_public_id IS NULL)
    OR (expected_mapping_state='exact' AND expected_project_alpha_public_id IS NOT NULL)),
  CHECK((expected_local_version=0 AND expected_local_projection_sha256 IS NULL)
    OR (expected_local_version>=1 AND expected_local_projection_sha256 IS NOT NULL)),
  CHECK((operation IN ('create','bind') AND expected_mapping_state='absent')
    OR (operation='update' AND expected_mapping_state='exact' AND expected_local_version>=1))
);

CREATE TRIGGER project_alpha_project_v2_canonical_intents_exact
BEFORE INSERT ON project_alpha_project_v2_canonical_intents
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_v2_request_fingerprints fingerprint
  JOIN project_alpha_project_outbox outbox ON outbox.command_id=fingerprint.command_id
  JOIN native_project_command_reservations reservation ON reservation.command_id=outbox.command_id
  JOIN native_project_live_command_proofs proof ON proof.command_id=outbox.command_id
    AND proof.external_project_id=outbox.external_project_id
  WHERE fingerprint.command_id=NEW.command_id AND fingerprint.request_sha256=NEW.request_sha256
    AND outbox.operation=NEW.operation AND outbox.external_project_id=NEW.external_project_id
    AND outbox.source_id=NEW.source_id AND outbox.expected_source_instance_id=NEW.source_instance_id
    AND outbox.application_id=NEW.application_id AND outbox.expected_history_epoch_id=NEW.history_epoch_id
    AND proof.grant_generation=NEW.expected_grant_generation
    AND json_type(outbox.command_json,'$.commandId')='text'
    AND json_extract(outbox.command_json,'$.commandId')=NEW.command_id
    AND json_type(outbox.command_json,'$.externalId')='text'
    AND json_extract(outbox.command_json,'$.externalId')=NEW.external_project_id
)
 OR NOT (
   (NEW.expected_local_version=0 AND NOT EXISTS (
      SELECT 1 FROM operations_shared_projects project
      WHERE project.external_project_id=NEW.external_project_id))
   OR (NEW.expected_local_version>=1 AND EXISTS (
      SELECT 1 FROM operations_shared_projects project
      WHERE project.external_project_id=NEW.external_project_id
        AND project.current_version=NEW.expected_local_version
        AND project.canonical_projection_sha256=NEW.expected_local_projection_sha256))
 )
 OR (NEW.expected_mapping_state='absent' AND EXISTS (
      SELECT 1 FROM project_alpha_project_mappings mapping
      WHERE mapping.external_project_id=NEW.external_project_id))
 OR (NEW.expected_mapping_state='exact' AND NOT EXISTS (
      SELECT 1 FROM project_alpha_project_mappings mapping
      WHERE mapping.external_project_id=NEW.external_project_id
        AND mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
        AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
        AND mapping.project_alpha_public_id=NEW.expected_project_alpha_public_id))
BEGIN SELECT RAISE(ABORT,'project v2 canonical intent is not current and exact'); END;

CREATE TRIGGER project_alpha_project_v2_canonical_intents_no_update
BEFORE UPDATE ON project_alpha_project_v2_canonical_intents
BEGIN SELECT RAISE(ABORT,'project v2 canonical intents are immutable'); END;
CREATE TRIGGER project_alpha_project_v2_canonical_intents_no_delete
BEFORE DELETE ON project_alpha_project_v2_canonical_intents
BEGIN SELECT RAISE(ABORT,'project v2 canonical intents are durable'); END;

-- This is intentionally inactive evidence.  A future private, bounded GET
-- adapter may record an exact current PA read here, but this row does not create
-- a mapping, change a head, append history, grant access, or publish anything.
CREATE TABLE project_alpha_project_v2_canonical_settlement_receipts (
  settlement_id TEXT NOT NULL PRIMARY KEY CHECK(length(settlement_id)=36 AND settlement_id=lower(settlement_id)
    AND settlement_id NOT GLOB '*[^0-9a-f-]*' AND substr(settlement_id,9,1)='-'
    AND substr(settlement_id,14,1)='-' AND substr(settlement_id,15,1)='4'
    AND substr(settlement_id,19,1)='-' AND substr(settlement_id,20,1) IN ('8','9','a','b')
    AND substr(settlement_id,24,1)='-' AND length(replace(settlement_id,'-',''))=32),
  success_receipt_id TEXT NOT NULL UNIQUE
    REFERENCES project_alpha_project_v2_success_receipts(receipt_id) ON DELETE RESTRICT,
  command_id TEXT NOT NULL UNIQUE
    REFERENCES project_alpha_project_v2_canonical_intents(command_id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK(operation IN ('create','update','bind')),
  external_project_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL CHECK(length(source_instance_id)=36),
  application_id TEXT NOT NULL CHECK(length(application_id)=36),
  history_epoch_id TEXT NOT NULL CHECK(length(history_epoch_id)=36),
  project_alpha_public_id TEXT NOT NULL CHECK(length(project_alpha_public_id)=32
    AND project_alpha_public_id=lower(project_alpha_public_id)
    AND project_alpha_public_id NOT GLOB '*[^0-9a-f]*'),
  project_alpha_revision TEXT NOT NULL CHECK(length(project_alpha_revision) BETWEEN 1 AND 19
    AND project_alpha_revision NOT GLOB '*[^0-9]*' AND substr(project_alpha_revision,1,1)<>'0'
    AND (length(project_alpha_revision)<19 OR project_alpha_revision<='9223372036854775807')),
  projection_sha256 TEXT NOT NULL CHECK(length(projection_sha256)=64 AND projection_sha256=lower(projection_sha256)
    AND projection_sha256 NOT GLOB '*[^0-9a-f]*'),
  prior_local_version INTEGER NOT NULL CHECK(typeof(prior_local_version)='integer' AND prior_local_version>=0),
  resulting_local_version INTEGER NOT NULL CHECK(typeof(resulting_local_version)='integer'
    AND resulting_local_version IN (prior_local_version,prior_local_version+1)),
  read_request_id TEXT NOT NULL CHECK(length(read_request_id)=36 AND read_request_id=lower(read_request_id)
    AND read_request_id NOT GLOB '*[^0-9a-f-]*' AND substr(read_request_id,9,1)='-'
    AND substr(read_request_id,14,1)='-' AND substr(read_request_id,15,1)='4'
    AND substr(read_request_id,19,1)='-' AND substr(read_request_id,20,1) IN ('8','9','a','b')
    AND substr(read_request_id,24,1)='-' AND length(replace(read_request_id,'-',''))=32),
  read_response_sha256 TEXT NOT NULL CHECK(length(read_response_sha256)=64
    AND read_response_sha256=lower(read_response_sha256) AND read_response_sha256 NOT GLOB '*[^0-9a-f]*'),
  read_json TEXT NOT NULL CHECK(json_valid(read_json) AND json_type(read_json)='object'),
  settlement_state TEXT NOT NULL DEFAULT 'inactive' CHECK(settlement_state='inactive'),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER project_alpha_project_v2_canonical_settlement_receipts_exact
BEFORE INSERT ON project_alpha_project_v2_canonical_settlement_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_v2_canonical_intents intent
  JOIN project_alpha_project_v2_success_receipts receipt ON receipt.command_id=intent.command_id
  JOIN project_alpha_project_outbox outbox ON outbox.command_id=intent.command_id
  JOIN native_project_live_command_proofs proof ON proof.command_id=outbox.command_id
    AND proof.external_project_id=outbox.external_project_id
  WHERE intent.command_id=NEW.command_id AND receipt.receipt_id=NEW.success_receipt_id
    AND intent.operation=NEW.operation AND intent.external_project_id=NEW.external_project_id
    AND intent.source_id=NEW.source_id AND intent.source_instance_id=NEW.source_instance_id
    AND intent.application_id=NEW.application_id AND intent.history_epoch_id=NEW.history_epoch_id
    AND intent.expected_local_version=NEW.prior_local_version
    AND proof.grant_generation=intent.expected_grant_generation
    AND receipt.source_instance_id=NEW.source_instance_id AND receipt.application_id=NEW.application_id
    AND receipt.history_epoch_id=NEW.history_epoch_id
    AND receipt.project_alpha_public_id=NEW.project_alpha_public_id
    AND receipt.project_alpha_revision=NEW.project_alpha_revision
    AND receipt.projection_sha256=NEW.projection_sha256
    AND ((intent.expected_local_version=0 AND NOT EXISTS (
        SELECT 1 FROM operations_shared_projects project
        WHERE project.external_project_id=intent.external_project_id))
      OR (intent.expected_local_version>=1 AND EXISTS (
        SELECT 1 FROM operations_shared_projects project
        WHERE project.external_project_id=intent.external_project_id
          AND project.current_version=intent.expected_local_version
          AND project.canonical_projection_sha256=intent.expected_local_projection_sha256)))
    AND ((intent.expected_mapping_state='absent' AND NOT EXISTS (
        SELECT 1 FROM project_alpha_project_mappings mapping
        WHERE mapping.external_project_id=intent.external_project_id))
      OR (intent.expected_mapping_state='exact' AND EXISTS (
        SELECT 1 FROM project_alpha_project_mappings mapping
        WHERE mapping.external_project_id=intent.external_project_id
          AND mapping.source_id=intent.source_id
          AND mapping.source_instance_id=intent.source_instance_id
          AND mapping.application_id=intent.application_id
          AND mapping.history_epoch_id=intent.history_epoch_id
          AND mapping.project_alpha_public_id=intent.expected_project_alpha_public_id)))
)
BEGIN SELECT RAISE(ABORT,'project v2 canonical settlement receipt is not exact'); END;

CREATE TRIGGER project_alpha_project_v2_canonical_settlement_receipts_envelope_exact
BEFORE INSERT ON project_alpha_project_v2_canonical_settlement_receipts
WHEN (SELECT count(*) FROM json_each(NEW.read_json))<>9
 OR EXISTS (SELECT 1 FROM json_each(NEW.read_json) member
      WHERE member.key NOT IN ('apiVersion','sourceInstanceId','applicationId','historyEpoch','requestId',
        'replayed','accepted','resource','data'))
 OR json_type(NEW.read_json,'$.apiVersion') IS NOT 'text'
 OR json_extract(NEW.read_json,'$.apiVersion')<>'2'
 OR json_type(NEW.read_json,'$.sourceInstanceId') IS NOT 'text'
 OR json_extract(NEW.read_json,'$.sourceInstanceId')<>NEW.source_instance_id
 OR json_type(NEW.read_json,'$.applicationId') IS NOT 'text'
 OR json_extract(NEW.read_json,'$.applicationId')<>NEW.application_id
 OR json_type(NEW.read_json,'$.historyEpoch') IS NOT 'text'
 OR json_extract(NEW.read_json,'$.historyEpoch')<>NEW.history_epoch_id
 OR json_type(NEW.read_json,'$.requestId') IS NOT 'text'
 OR json_extract(NEW.read_json,'$.requestId')<>NEW.read_request_id
 OR json_type(NEW.read_json,'$.replayed') IS NOT 'false'
 OR json_type(NEW.read_json,'$.accepted') IS NOT 'true'
 OR json_type(NEW.read_json,'$.resource') IS NOT 'object'
 OR (SELECT count(*) FROM json_each(NEW.read_json,'$.resource'))<>4
 OR EXISTS (SELECT 1 FROM json_each(NEW.read_json,'$.resource') member
      WHERE member.key NOT IN ('type','id','revision','projectionSha256'))
 OR json_type(NEW.read_json,'$.resource.type') IS NOT 'text'
 OR json_extract(NEW.read_json,'$.resource.type')<>'project'
 OR json_type(NEW.read_json,'$.resource.id') IS NOT 'text'
 OR json_extract(NEW.read_json,'$.resource.id')<>NEW.project_alpha_public_id
 OR json_type(NEW.read_json,'$.resource.revision') IS NOT 'text'
 OR json_extract(NEW.read_json,'$.resource.revision')<>NEW.project_alpha_revision
 OR json_type(NEW.read_json,'$.resource.projectionSha256') IS NOT 'text'
 OR json_extract(NEW.read_json,'$.resource.projectionSha256')<>NEW.projection_sha256
 OR json_type(NEW.read_json,'$.data') IS NOT 'object'
BEGIN SELECT RAISE(ABORT,'project v2 canonical settlement read envelope is not exact'); END;

CREATE TRIGGER project_alpha_project_v2_canonical_settlement_receipts_data_exact
BEFORE INSERT ON project_alpha_project_v2_canonical_settlement_receipts
WHEN (SELECT count(*) FROM json_each(NEW.read_json,'$.data'))<>11
 OR EXISTS (SELECT 1 FROM json_each(NEW.read_json,'$.data') member
      WHERE member.key NOT IN ('name','description','status','archived','overdueWarning','completedAt',
        'archivedAt','estimatedStart','estimatedEnd','clientPublicId','organizationPublicId'))
 OR json_type(NEW.read_json,'$.data.name') IS NOT 'text'
 OR length(json_extract(NEW.read_json,'$.data.name')) NOT BETWEEN 1 AND 150
 OR instr(json_extract(NEW.read_json,'$.data.name'),char(0))<>0
 OR json_type(NEW.read_json,'$.data.status') IS NOT 'text'
 OR json_extract(NEW.read_json,'$.data.status') NOT IN ('not_started','active','completed','cancelled')
 OR json_type(NEW.read_json,'$.data.archived') IS NULL
 OR json_type(NEW.read_json,'$.data.archived') NOT IN ('true','false')
 OR json_type(NEW.read_json,'$.data.overdueWarning') IS NULL
 OR json_type(NEW.read_json,'$.data.overdueWarning') NOT IN ('true','false')
 OR json_type(NEW.read_json,'$.data.description') IS NULL
 OR (json_type(NEW.read_json,'$.data.description') NOT IN ('null','text'))
 OR (json_type(NEW.read_json,'$.data.description')='text'
      AND length(json_extract(NEW.read_json,'$.data.description'))>10000)
 OR json_type(NEW.read_json,'$.data.completedAt') IS NULL
 OR (json_type(NEW.read_json,'$.data.completedAt') NOT IN ('null','text'))
 OR json_type(NEW.read_json,'$.data.archivedAt') IS NULL
 OR (json_type(NEW.read_json,'$.data.archivedAt') NOT IN ('null','text'))
 OR json_type(NEW.read_json,'$.data.estimatedStart') IS NULL
 OR (json_type(NEW.read_json,'$.data.estimatedStart') NOT IN ('null','text'))
 OR json_type(NEW.read_json,'$.data.estimatedEnd') IS NULL
 OR (json_type(NEW.read_json,'$.data.estimatedEnd') NOT IN ('null','text'))
 OR json_type(NEW.read_json,'$.data.clientPublicId') IS NULL
 OR (json_type(NEW.read_json,'$.data.clientPublicId') NOT IN ('null','text'))
 OR json_type(NEW.read_json,'$.data.organizationPublicId') IS NULL
 OR (json_type(NEW.read_json,'$.data.organizationPublicId') NOT IN ('null','text'))
 OR (json_type(NEW.read_json,'$.data.clientPublicId')='text'
      AND (length(json_extract(NEW.read_json,'$.data.clientPublicId'))<>32
        OR json_extract(NEW.read_json,'$.data.clientPublicId')<>lower(json_extract(NEW.read_json,'$.data.clientPublicId'))
        OR json_extract(NEW.read_json,'$.data.clientPublicId') GLOB '*[^0-9a-f]*'))
 OR (json_type(NEW.read_json,'$.data.organizationPublicId')='text'
      AND (length(json_extract(NEW.read_json,'$.data.organizationPublicId'))<>32
        OR json_extract(NEW.read_json,'$.data.organizationPublicId')<>lower(json_extract(NEW.read_json,'$.data.organizationPublicId'))
        OR json_extract(NEW.read_json,'$.data.organizationPublicId') GLOB '*[^0-9a-f]*'))
BEGIN SELECT RAISE(ABORT,'project v2 canonical settlement read data is not exact'); END;

CREATE TRIGGER project_alpha_project_v2_canonical_settlement_receipts_no_update
BEFORE UPDATE ON project_alpha_project_v2_canonical_settlement_receipts
BEGIN SELECT RAISE(ABORT,'project v2 canonical settlement receipts are immutable'); END;
CREATE TRIGGER project_alpha_project_v2_canonical_settlement_receipts_no_delete
BEFORE DELETE ON project_alpha_project_v2_canonical_settlement_receipts
BEGIN SELECT RAISE(ABORT,'project v2 canonical settlement receipts are durable'); END;

-- Reserve explicit provenance on the existing canonical history table without
-- weakening 0086's legacy CHECK or insert guard.  The always-deny trigger makes
-- the schema-only boundary executable: a later migration must replace it with
-- an exact mapping/head/history transaction after the private GET settler exists.
ALTER TABLE operations_shared_project_revisions ADD COLUMN v2_settlement_id TEXT
  REFERENCES project_alpha_project_v2_canonical_settlement_receipts(settlement_id) ON DELETE RESTRICT;

CREATE TRIGGER operations_shared_project_revisions_v2_settlement_deferred
BEFORE INSERT ON operations_shared_project_revisions
WHEN NEW.v2_settlement_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'project v2 canonical history settlement is not enabled'); END;
