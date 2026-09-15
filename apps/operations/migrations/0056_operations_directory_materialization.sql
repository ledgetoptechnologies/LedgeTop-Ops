PRAGMA foreign_keys = ON;

CREATE TABLE operations_directory_materializations (
  intent_id TEXT NOT NULL PRIMARY KEY REFERENCES operations_directory_intents(intent_id) ON DELETE RESTRICT,
  command_id TEXT NOT NULL UNIQUE,
  command_json TEXT NOT NULL CHECK(json_valid(command_json)),
  origin_snapshot_json TEXT NOT NULL CHECK(json_valid(origin_snapshot_json)),
  disposition_json TEXT NOT NULL CHECK(json_valid(disposition_json)),
  next_attempt_at INTEGER NOT NULL CHECK(next_attempt_at >= 0),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER operations_directory_materializations_reserve AFTER INSERT ON operations_directory_materializations
BEGIN
  SELECT CASE WHEN (SELECT state FROM operations_directory_intents WHERE intent_id=NEW.intent_id) IS NOT 'ready'
    THEN RAISE(ABORT,'directory intent is not ready') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM operations_directory_intents i WHERE i.intent_id=NEW.intent_id
      AND i.predecessor_intent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM operations_directory_intents p
        JOIN operations_directory_materializations m ON m.intent_id=p.intent_id
        JOIN project_alpha_directory_outbox o ON o.command_id=m.command_id
        WHERE p.intent_id=i.predecessor_intent_id AND p.state='acknowledged' AND o.state='acknowledged'
          AND json_extract(o.outcome_json,'$.status')='acknowledged'))
    THEN RAISE(ABORT,'directory predecessor is not acknowledged') END;
  -- Recheck all mutable metadata used to construct the reservation. The
  -- materializer's preflight is advisory; this trigger is the batch fence.
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM operations_directory_intents i JOIN operations_directory_records r ON r.record_id=i.record_id
    JOIN operations_directory_audit a ON a.mutation_id=i.mutation_id
    WHERE i.intent_id=NEW.intent_id
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
      AND json_extract(NEW.command_json,'$.fields')=json(i.desired_payload_json))
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
    WHERE i.intent_id=NEW.intent_id AND (json_extract(NEW.disposition_json,'$.kind') IS NOT 'existing'
      OR json_extract(NEW.disposition_json,'$.projectAlphaPublicId') IS NOT json_extract(o.outcome_json,'$.response.result.data.publicId')
      OR json_extract(NEW.disposition_json,'$.projectAlphaRevision') IS NOT json_extract(o.outcome_json,'$.response.result.resource.revision')
      OR json_extract(NEW.command_json,'$.expectedProjectAlphaPublicId') IS NOT json_extract(o.outcome_json,'$.response.result.data.publicId')
      OR json_extract(NEW.command_json,'$.expectedRevision') IS NOT json_extract(o.outcome_json,'$.response.result.resource.revision')))
    THEN RAISE(ABORT,'directory predecessor proof conflict') END;
  INSERT INTO project_alpha_directory_outbox(command_id,source_id,application_id,resource_type,external_id,
    command_json,destination_base_url,expected_source_instance_id,origin_snapshot_json,next_attempt_at)
  SELECT NEW.command_id,i.source_id,i.application_uuid,r.record_kind,i.external_canonical_id,
    NEW.command_json,i.destination_origin,i.source_instance_uuid,NEW.origin_snapshot_json,NEW.next_attempt_at
  FROM operations_directory_intents i JOIN operations_directory_records r ON r.record_id=i.record_id
  WHERE i.intent_id=NEW.intent_id;
  UPDATE operations_directory_intents SET state='materialized'
    WHERE intent_id=NEW.intent_id AND state='ready';
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'directory intent materialization race') END;
END;

CREATE TRIGGER operations_directory_materializations_immutable BEFORE UPDATE ON operations_directory_materializations
BEGIN SELECT RAISE(ABORT,'directory intent materialization is immutable'); END;
CREATE TRIGGER operations_directory_materializations_no_delete BEFORE DELETE ON operations_directory_materializations
BEGIN SELECT RAISE(ABORT,'directory intent materializations are durable'); END;
