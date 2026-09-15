PRAGMA foreign_keys = ON;

-- A client intent's organization decision is durable and version-specific.
-- This is independent of predecessor_intent_id, which orders revisions of
-- the same canonical record. Existing unpinned intents need reconciliation.
CREATE TABLE operations_directory_intent_relationship_dependencies (
  intent_id TEXT NOT NULL PRIMARY KEY REFERENCES operations_directory_intents(intent_id) ON DELETE RESTRICT,
  client_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  client_record_version INTEGER NOT NULL CHECK(typeof(client_record_version)='integer' AND client_record_version>=1),
  relationship_version INTEGER NOT NULL CHECK(typeof(relationship_version)='integer' AND relationship_version>=1),
  relationship_mutation_id TEXT NOT NULL,
  organization_record_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  organization_record_version INTEGER CHECK(organization_record_version>=1),
  source_id TEXT NOT NULL,
  source_instance_uuid TEXT NOT NULL,
  application_uuid TEXT NOT NULL,
  history_epoch_id TEXT NOT NULL,
  destination_origin TEXT NOT NULL,
  parent_external_canonical_id TEXT,
  evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('unlinked','parent_intent','existing_mapping')),
  parent_intent_id TEXT REFERENCES operations_directory_intents(intent_id) ON DELETE RESTRICT,
  parent_mapping_command_id TEXT REFERENCES project_alpha_directory_outbox(command_id) ON DELETE RESTRICT,
  parent_public_id TEXT,
  parent_ack_revision TEXT,
  parent_ack_command_json TEXT CHECK(parent_ack_command_json IS NULL OR
    (json_valid(parent_ack_command_json) AND length(CAST(parent_ack_command_json AS BLOB))<=32768)),
  parent_ack_outcome_json TEXT CHECK(parent_ack_outcome_json IS NULL OR
    (json_valid(parent_ack_outcome_json) AND length(CAST(parent_ack_outcome_json AS BLOB))<=32768)),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(client_record_id,relationship_version)
    REFERENCES operations_directory_client_organization_history(client_record_id,relationship_version) ON DELETE RESTRICT,
  CHECK((organization_record_id IS NULL)=(organization_record_version IS NULL)),
  CHECK((organization_record_id IS NULL)=(parent_external_canonical_id IS NULL)),
  CHECK((evidence_kind='unlinked' AND organization_record_id IS NULL AND parent_intent_id IS NULL
      AND parent_mapping_command_id IS NULL AND parent_public_id IS NULL AND parent_ack_revision IS NULL
      AND parent_ack_command_json IS NULL AND parent_ack_outcome_json IS NULL)
    OR (evidence_kind='parent_intent' AND organization_record_id IS NOT NULL AND parent_intent_id IS NOT NULL
      AND parent_mapping_command_id IS NULL AND parent_public_id IS NULL AND parent_ack_revision IS NULL
      AND parent_ack_command_json IS NULL AND parent_ack_outcome_json IS NULL)
    OR (evidence_kind='existing_mapping' AND organization_record_id IS NOT NULL AND parent_intent_id IS NULL
      AND parent_mapping_command_id IS NOT NULL AND parent_public_id IS NOT NULL AND parent_ack_revision IS NOT NULL
      AND parent_ack_command_json IS NOT NULL AND parent_ack_outcome_json IS NOT NULL))
);
CREATE INDEX operations_directory_intent_relationship_parent
  ON operations_directory_intent_relationship_dependencies(organization_record_id,organization_record_version);

CREATE TRIGGER operations_directory_intent_relationship_dependencies_insert_guard
BEFORE INSERT ON operations_directory_intent_relationship_dependencies
WHEN EXISTS(SELECT 1 FROM operations_directory_intent_relationship_dependencies WHERE intent_id=NEW.intent_id)
  OR NOT EXISTS(SELECT 1 FROM operations_directory_intents intent
    JOIN operations_directory_records client ON client.record_id=intent.record_id AND client.record_kind='client'
    JOIN operations_directory_client_organization_history history
      ON history.client_record_id=intent.record_id AND history.relationship_version=NEW.relationship_version
    JOIN operations_directory_client_organizations current_relation
      ON current_relation.client_record_id=intent.record_id AND current_relation.relationship_version=NEW.relationship_version
    JOIN operations_directory_live_write_fences fence
      ON fence.mutation_id=intent.mutation_id AND fence.record_id=intent.record_id
      AND fence.record_writes=0 AND fence.revision_writes=0 AND fence.audit_writes=0 AND fence.intent_writes=0
    WHERE intent.intent_id=NEW.intent_id AND intent.record_id=NEW.client_record_id
      AND intent.record_version=NEW.client_record_version
      AND history.mutation_id=NEW.relationship_mutation_id
      AND history.client_record_version<=NEW.client_record_version
      AND history.organization_record_id IS NEW.organization_record_id
      AND current_relation.organization_record_id IS NEW.organization_record_id
      AND intent.source_id=NEW.source_id AND intent.source_instance_uuid=NEW.source_instance_uuid
      AND intent.application_uuid=NEW.application_uuid AND intent.expected_history_epoch_id=NEW.history_epoch_id
      AND intent.destination_origin=NEW.destination_origin
      AND ((NEW.evidence_kind='unlinked' AND NEW.organization_record_id IS NULL)
        OR (NEW.organization_record_id IS NOT NULL AND EXISTS(
          SELECT 1 FROM operations_directory_records parent
          JOIN operations_directory_revisions parent_revision
            ON parent_revision.record_id=parent.record_id AND parent_revision.version=NEW.organization_record_version
          JOIN native_directory_enrollments enrollment ON enrollment.record_id=parent.record_id
          WHERE parent.record_id=NEW.organization_record_id AND parent.record_kind='organization'
            AND parent.current_version=NEW.organization_record_version
            AND EXISTS(SELECT 1 FROM json_each(enrollment.destinations_json) destination
              WHERE json_extract(destination.value,'$.sourceId')=NEW.source_id
                AND json_extract(destination.value,'$.sourceInstanceUUID')=NEW.source_instance_uuid
                AND json_extract(destination.value,'$.applicationUUID')=NEW.application_uuid
                AND json_extract(destination.value,'$.historyEpoch')=NEW.history_epoch_id
                AND json_extract(destination.value,'$.origin')=NEW.destination_origin
                AND json_extract(destination.value,'$.externalCanonicalId')=NEW.parent_external_canonical_id)
        ))))
  OR (NEW.evidence_kind='parent_intent' AND NOT EXISTS(
    SELECT 1 FROM operations_directory_intents parent
    JOIN operations_directory_records record ON record.record_id=parent.record_id AND record.record_kind='organization'
    WHERE parent.intent_id=NEW.parent_intent_id AND parent.record_id=NEW.organization_record_id
      AND parent.record_version=NEW.organization_record_version
      AND parent.source_id=NEW.source_id AND parent.source_instance_uuid=NEW.source_instance_uuid
      AND parent.application_uuid=NEW.application_uuid AND parent.expected_history_epoch_id=NEW.history_epoch_id
      AND parent.destination_origin=NEW.destination_origin
      AND parent.external_canonical_id=NEW.parent_external_canonical_id))
  OR (NEW.evidence_kind='existing_mapping' AND NOT EXISTS(
    SELECT 1 FROM project_alpha_directory_mappings mapping
    JOIN project_alpha_directory_outbox outbox ON outbox.command_id=mapping.command_id
    WHERE mapping.command_id=NEW.parent_mapping_command_id
      AND mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_uuid
      AND mapping.application_id=NEW.application_uuid AND mapping.history_epoch_id=NEW.history_epoch_id
      AND mapping.resource_type='organization' AND mapping.external_id=NEW.parent_external_canonical_id
      AND mapping.project_alpha_public_id=NEW.parent_public_id
      AND outbox.state='acknowledged' AND outbox.command_json IS NEW.parent_ack_command_json
      AND outbox.outcome_json IS NEW.parent_ack_outcome_json
      AND outbox.source_id=NEW.source_id AND outbox.expected_source_instance_id=NEW.source_instance_uuid
      AND outbox.application_id=NEW.application_uuid AND outbox.expected_history_epoch_id=NEW.history_epoch_id
      AND outbox.destination_base_url=NEW.destination_origin
      AND outbox.resource_type='organization' AND outbox.external_id=NEW.parent_external_canonical_id
      AND json_extract(outbox.outcome_json,'$.status')='acknowledged'
      AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=NEW.history_epoch_id
      AND json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=NEW.source_instance_uuid
      AND json_extract(outbox.outcome_json,'$.response.applicationId')=NEW.application_uuid
      AND json_extract(outbox.outcome_json,'$.response.result.resource.type')='organization'
      AND json_extract(outbox.outcome_json,'$.response.result.resource.id')=NEW.parent_external_canonical_id
      AND json_extract(outbox.outcome_json,'$.response.result.resource.revision')=NEW.parent_ack_revision
      AND json_extract(outbox.outcome_json,'$.response.result.data.publicId')=NEW.parent_public_id))
BEGIN SELECT RAISE(ABORT,'directory intent relationship dependency requires live canonical evidence'); END;
CREATE TRIGGER operations_directory_intent_relationship_dependencies_no_update
BEFORE UPDATE ON operations_directory_intent_relationship_dependencies
BEGIN SELECT RAISE(ABORT,'directory intent relationship dependency is immutable'); END;
CREATE TRIGGER operations_directory_intent_relationship_dependencies_no_delete
BEFORE DELETE ON operations_directory_intent_relationship_dependencies
BEGIN SELECT RAISE(ABORT,'directory intent relationship dependency is durable'); END;

-- A new client intent cannot become a committed, dispatchable native write
-- without its explicit historical decision. A standalone client create with
-- destinations must use the composed relationship path; old committed rows
-- are not retroactively backfilled and remain blocked at reservation.
DROP TRIGGER operations_directory_write_fences_exhausted;
CREATE TRIGGER operations_directory_write_fences_exhausted
BEFORE DELETE ON operations_directory_write_fences
WHEN OLD.record_writes<>0 OR OLD.revision_writes<>0 OR OLD.audit_writes<>0 OR OLD.intent_writes<>0
  OR (OLD.record_kind='client' AND EXISTS(SELECT 1 FROM operations_directory_intents intent
    WHERE intent.mutation_id=OLD.mutation_id AND NOT EXISTS(
      SELECT 1 FROM operations_directory_intent_relationship_dependencies dependency
      WHERE dependency.intent_id=intent.intent_id AND dependency.client_record_id=intent.record_id
        AND dependency.client_record_version=intent.record_version)))
BEGIN SELECT RAISE(ABORT,'directory write fence is not exhausted'); END;

CREATE VIEW operations_directory_intent_relationship_resolved AS
SELECT dependency.*,NULL AS resolved_parent_public_id
  FROM operations_directory_intent_relationship_dependencies dependency
  WHERE dependency.evidence_kind='unlinked'
UNION ALL
SELECT dependency.*,mapping.project_alpha_public_id
  FROM operations_directory_intent_relationship_dependencies dependency
  JOIN operations_directory_intents parent ON parent.intent_id=dependency.parent_intent_id
    AND parent.record_id=dependency.organization_record_id
    AND parent.record_version=dependency.organization_record_version
    AND parent.source_id=dependency.source_id AND parent.source_instance_uuid=dependency.source_instance_uuid
    AND parent.application_uuid=dependency.application_uuid AND parent.expected_history_epoch_id=dependency.history_epoch_id
    AND parent.destination_origin=dependency.destination_origin
    AND parent.external_canonical_id=dependency.parent_external_canonical_id AND parent.state='acknowledged'
  JOIN operations_directory_materializations materialization ON materialization.intent_id=parent.intent_id
    AND materialization.history_epoch_id=dependency.history_epoch_id
  JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id
    AND outbox.state='acknowledged' AND outbox.source_id=dependency.source_id
    AND outbox.expected_source_instance_id=dependency.source_instance_uuid
    AND outbox.application_id=dependency.application_uuid AND outbox.expected_history_epoch_id=dependency.history_epoch_id
    AND outbox.destination_base_url=dependency.destination_origin AND outbox.resource_type='organization'
    AND outbox.external_id=dependency.parent_external_canonical_id
  JOIN project_alpha_directory_mappings mapping ON mapping.source_id=dependency.source_id
    AND mapping.source_instance_id=dependency.source_instance_uuid AND mapping.application_id=dependency.application_uuid
    AND mapping.history_epoch_id=dependency.history_epoch_id AND mapping.resource_type='organization'
    AND mapping.external_id=dependency.parent_external_canonical_id
    AND mapping.project_alpha_public_id=json_extract(outbox.outcome_json,'$.response.result.data.publicId')
  WHERE dependency.evidence_kind='parent_intent'
    AND json_extract(outbox.outcome_json,'$.status')='acknowledged'
    AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=dependency.history_epoch_id
    AND json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=dependency.source_instance_uuid
    AND json_extract(outbox.outcome_json,'$.response.applicationId')=dependency.application_uuid
    AND json_extract(outbox.outcome_json,'$.response.result.resource.type')='organization'
    AND json_extract(outbox.outcome_json,'$.response.result.resource.id')=dependency.parent_external_canonical_id
UNION ALL
SELECT dependency.*,mapping.project_alpha_public_id
  FROM operations_directory_intent_relationship_dependencies dependency
  JOIN project_alpha_directory_mappings mapping ON mapping.source_id=dependency.source_id
    AND mapping.source_instance_id=dependency.source_instance_uuid
    AND mapping.application_id=dependency.application_uuid AND mapping.history_epoch_id=dependency.history_epoch_id
    AND mapping.resource_type='organization' AND mapping.external_id=dependency.parent_external_canonical_id
    AND mapping.project_alpha_public_id=dependency.parent_public_id
  JOIN project_alpha_directory_outbox outbox ON outbox.command_id=dependency.parent_mapping_command_id
    AND outbox.state='acknowledged' AND outbox.command_json IS dependency.parent_ack_command_json
    AND outbox.outcome_json IS dependency.parent_ack_outcome_json
    AND outbox.source_id=dependency.source_id AND outbox.expected_source_instance_id=dependency.source_instance_uuid
    AND outbox.application_id=dependency.application_uuid AND outbox.expected_history_epoch_id=dependency.history_epoch_id
    AND outbox.destination_base_url=dependency.destination_origin AND outbox.resource_type='organization'
    AND outbox.external_id=dependency.parent_external_canonical_id
  WHERE dependency.evidence_kind='existing_mapping'
    AND json_extract(outbox.outcome_json,'$.status')='acknowledged'
    AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=dependency.history_epoch_id
    AND json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=dependency.source_instance_uuid
    AND json_extract(outbox.outcome_json,'$.response.applicationId')=dependency.application_uuid
    AND json_extract(outbox.outcome_json,'$.response.result.resource.type')='organization'
    AND json_extract(outbox.outcome_json,'$.response.result.resource.id')=dependency.parent_external_canonical_id
    AND json_extract(outbox.outcome_json,'$.response.result.resource.revision')=dependency.parent_ack_revision
    AND json_extract(outbox.outcome_json,'$.response.result.data.publicId')=dependency.parent_public_id;

-- The old 0065 reservation compares client command.fields directly to the
-- stored profile. A parent ID is an additional, pinned transport field, never
-- a mutable profile value. This BEFORE guard is also used for old unpinned
-- client intents: absence blocks rather than inventing an unlinked decision.
CREATE TRIGGER operations_directory_materializations_relationship_guard
BEFORE INSERT ON operations_directory_materializations
WHEN EXISTS(SELECT 1 FROM operations_directory_intents intent
    JOIN operations_directory_records record ON record.record_id=intent.record_id
    WHERE intent.intent_id=NEW.intent_id AND record.record_kind='client')
  AND NOT EXISTS(SELECT 1 FROM operations_directory_intents intent
    JOIN operations_directory_intent_relationship_dependencies dependency ON dependency.intent_id=intent.intent_id
      AND dependency.client_record_id=intent.record_id AND dependency.client_record_version=intent.record_version
      AND dependency.source_id=intent.source_id AND dependency.source_instance_uuid=intent.source_instance_uuid
      AND dependency.application_uuid=intent.application_uuid AND dependency.history_epoch_id=intent.expected_history_epoch_id
      AND dependency.destination_origin=intent.destination_origin
    JOIN operations_directory_client_organization_history history
      ON history.client_record_id=dependency.client_record_id
      AND history.relationship_version=dependency.relationship_version
      AND history.mutation_id=dependency.relationship_mutation_id
      AND history.organization_record_id IS dependency.organization_record_id
    JOIN operations_directory_intent_relationship_resolved resolved ON resolved.intent_id=dependency.intent_id
    WHERE intent.intent_id=NEW.intent_id AND history.client_record_version<=intent.record_version
      AND json_type(NEW.command_json,'$.fields.organizationPublicId')=CASE dependency.evidence_kind
        WHEN 'unlinked' THEN 'null' ELSE 'text' END
      AND json_extract(NEW.command_json,'$.fields.organizationPublicId') IS resolved.resolved_parent_public_id
      AND json_remove(json_extract(NEW.command_json,'$.fields'),'$.organizationPublicId')=json(intent.desired_payload_json))
BEGIN SELECT RAISE(ABORT,'directory client intent requires pinned relationship dependency'); END;

-- Preserve the 0065 reserve transaction fence verbatim except for the
-- client transport-only parent field. The BEFORE guard above pins that field.
DROP TRIGGER operations_directory_materializations_reserve;
CREATE TRIGGER operations_directory_materializations_reserve AFTER INSERT ON operations_directory_materializations
BEGIN
  SELECT CASE WHEN NEW.history_epoch_id IS NULL OR length(NEW.history_epoch_id)<>36
    OR substr(NEW.history_epoch_id,9,1)<>'-' OR substr(NEW.history_epoch_id,14,1)<>'-'
    OR substr(NEW.history_epoch_id,15,1)<>'4' OR substr(NEW.history_epoch_id,19,1)<>'-'
    OR substr(NEW.history_epoch_id,20,1) NOT GLOB '[89ab]' OR substr(NEW.history_epoch_id,24,1)<>'-'
    OR length(replace(NEW.history_epoch_id,'-',''))<>32
    OR replace(NEW.history_epoch_id,'-','') GLOB '*[^0-9a-f]*'
    THEN RAISE(ABORT,'directory materialization history epoch is invalid') END;
  SELECT CASE WHEN (SELECT state FROM operations_directory_intents WHERE intent_id=NEW.intent_id) IS NOT 'ready'
    THEN RAISE(ABORT,'directory intent is not ready') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM operations_directory_intents i WHERE i.intent_id=NEW.intent_id
      AND i.predecessor_intent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM operations_directory_intents p
        JOIN operations_directory_materializations m ON m.intent_id=p.intent_id
        JOIN project_alpha_directory_outbox o ON o.command_id=m.command_id
        WHERE p.intent_id=i.predecessor_intent_id AND p.state='acknowledged' AND o.state='acknowledged'
          AND p.expected_history_epoch_id=i.expected_history_epoch_id AND m.history_epoch_id=i.expected_history_epoch_id
          AND o.expected_history_epoch_id=i.expected_history_epoch_id
          AND json_extract(o.outcome_json,'$.status')='acknowledged'
          AND json_extract(o.outcome_json,'$.response.historyEpoch')=i.expected_history_epoch_id))
    THEN RAISE(ABORT,'directory predecessor is not acknowledged') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM operations_directory_intents i JOIN operations_directory_records r ON r.record_id=i.record_id
    JOIN operations_directory_audit a ON a.mutation_id=i.mutation_id
    WHERE i.intent_id=NEW.intent_id AND i.expected_history_epoch_id=NEW.history_epoch_id
      AND json_extract(NEW.disposition_json,'$.historyEpoch')=i.expected_history_epoch_id
      AND json_extract(NEW.command_json,'$.commandId')=NEW.command_id
      AND json_extract(NEW.command_json,'$.resourceType')=r.record_kind
      AND json_extract(NEW.command_json,'$.externalId')=i.external_canonical_id
      AND json_extract(NEW.disposition_json,'$.sourceId')=i.source_id
      AND json_extract(NEW.disposition_json,'$.sourceInstanceUUID')=i.source_instance_uuid
      AND json_extract(NEW.disposition_json,'$.applicationUUID')=i.application_uuid
      AND json_extract(NEW.disposition_json,'$.origin')=i.destination_origin
      AND json_extract(NEW.disposition_json,'$.externalCanonicalId')=i.external_canonical_id
      AND json_extract(NEW.origin_snapshot_json,'$.actorId')=a.actor_id
      AND json_extract(NEW.origin_snapshot_json,'$.authorityRevision')=CAST(i.record_version AS TEXT)
      AND ((r.record_kind='client' AND json_remove(json_extract(NEW.command_json,'$.fields'),'$.organizationPublicId')=json(i.desired_payload_json))
        OR (r.record_kind<>'client' AND json_extract(NEW.command_json,'$.fields')=json(i.desired_payload_json))))
    THEN RAISE(ABORT,'directory materialization metadata changed') END;
  SELECT CASE WHEN json_extract(NEW.disposition_json,'$.kind') IS NULL
    OR json_extract(NEW.disposition_json,'$.kind') NOT IN ('authorized_create','existing')
    THEN RAISE(ABORT,'directory materialization disposition is invalid') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM operations_directory_intents i JOIN operations_directory_records r ON r.record_id=i.record_id
    WHERE i.intent_id=NEW.intent_id AND json_extract(NEW.disposition_json,'$.kind')='authorized_create'
      AND (json_extract(NEW.command_json,'$.operation') IS NOT 'create' OR json_extract(NEW.command_json,'$.expectedRevision') IS NOT '0'
        OR EXISTS(SELECT 1 FROM project_alpha_directory_mappings x WHERE x.source_id=i.source_id AND x.source_instance_id=i.source_instance_uuid
          AND x.application_id=i.application_uuid AND x.resource_type=r.record_kind AND x.external_id=i.external_canonical_id)))
    THEN RAISE(ABORT,'directory create mapping conflict') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM operations_directory_intents i JOIN operations_directory_records r ON r.record_id=i.record_id
    WHERE i.intent_id=NEW.intent_id AND json_extract(NEW.disposition_json,'$.kind')='existing'
      AND (json_extract(NEW.command_json,'$.operation') IS NOT 'update'
        OR json_extract(NEW.command_json,'$.expectedProjectAlphaPublicId') IS NOT json_extract(NEW.disposition_json,'$.projectAlphaPublicId')
        OR json_extract(NEW.command_json,'$.expectedRevision') IS NOT json_extract(NEW.disposition_json,'$.projectAlphaRevision')
        OR EXISTS(SELECT 1 FROM project_alpha_directory_mappings x WHERE x.source_id=i.source_id AND x.source_instance_id=i.source_instance_uuid
          AND x.application_id=i.application_uuid AND x.resource_type=r.record_kind AND x.external_id=i.external_canonical_id
          AND x.project_alpha_public_id IS NOT json_extract(NEW.disposition_json,'$.projectAlphaPublicId'))))
    THEN RAISE(ABORT,'directory existing mapping conflict') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM operations_directory_intents i JOIN operations_directory_records r ON r.record_id=i.record_id
    JOIN operations_directory_intents p ON p.intent_id=i.predecessor_intent_id
    JOIN operations_directory_materializations m ON m.intent_id=p.intent_id
    JOIN project_alpha_directory_outbox o ON o.command_id=m.command_id
    WHERE i.intent_id=NEW.intent_id AND (p.record_id IS NOT i.record_id OR p.source_id IS NOT i.source_id
      OR p.source_instance_uuid IS NOT i.source_instance_uuid OR p.application_uuid IS NOT i.application_uuid
      OR p.destination_origin IS NOT i.destination_origin OR p.external_canonical_id IS NOT i.external_canonical_id
      OR p.expected_history_epoch_id IS NOT i.expected_history_epoch_id
      OR m.history_epoch_id IS NOT i.expected_history_epoch_id OR o.expected_history_epoch_id IS NOT i.expected_history_epoch_id
      OR json_extract(o.outcome_json,'$.response.historyEpoch') IS NOT i.expected_history_epoch_id
      OR json_extract(NEW.disposition_json,'$.kind') IS NOT 'existing'
      OR json_extract(NEW.disposition_json,'$.projectAlphaPublicId') IS NOT json_extract(o.outcome_json,'$.response.result.data.publicId')
      OR json_extract(NEW.disposition_json,'$.projectAlphaRevision') IS NOT json_extract(o.outcome_json,'$.response.result.resource.revision')
      OR json_extract(NEW.command_json,'$.operation') IS NOT 'update'
      OR json_extract(NEW.command_json,'$.expectedProjectAlphaPublicId') IS NOT json_extract(o.outcome_json,'$.response.result.data.publicId')
      OR json_extract(NEW.command_json,'$.expectedRevision') IS NOT json_extract(o.outcome_json,'$.response.result.resource.revision')))
    THEN RAISE(ABORT,'directory predecessor proof conflict') END;
  INSERT INTO project_alpha_directory_outbox(command_id,source_id,application_id,resource_type,external_id,
    command_json,destination_base_url,expected_source_instance_id,expected_history_epoch_id,origin_snapshot_json,next_attempt_at)
  SELECT NEW.command_id,i.source_id,i.application_uuid,r.record_kind,i.external_canonical_id,
    NEW.command_json,i.destination_origin,i.source_instance_uuid,NEW.history_epoch_id,NEW.origin_snapshot_json,NEW.next_attempt_at
  FROM operations_directory_intents i JOIN operations_directory_records r ON r.record_id=i.record_id WHERE i.intent_id=NEW.intent_id;
  UPDATE operations_directory_intents SET state='materialized' WHERE intent_id=NEW.intent_id AND state='ready';
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'directory intent materialization race') END;
END;
