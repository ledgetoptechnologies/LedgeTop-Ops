PRAGMA foreign_keys = ON;

-- Existing directory history is deliberately left unpinned. It must be
-- reconciled explicitly after a PA history-epoch change; a worker never learns
-- an epoch from a probe or rewrites an immutable receipt.
ALTER TABLE project_alpha_directory_outbox ADD COLUMN expected_history_epoch_id TEXT NULL;
ALTER TABLE project_alpha_directory_mappings ADD COLUMN history_epoch_id TEXT NULL;
ALTER TABLE operations_directory_intents ADD COLUMN expected_history_epoch_id TEXT NULL;
ALTER TABLE operations_directory_materializations ADD COLUMN history_epoch_id TEXT NULL;

DROP TRIGGER native_directory_create_admissions_shape;
CREATE TRIGGER native_directory_create_admissions_shape BEFORE INSERT ON native_directory_create_admissions
WHEN EXISTS(SELECT 1 FROM json_each(NEW.scopes_json) scope WHERE json_type(scope.value)<>'object'
 OR coalesce(json_type(scope.value,'$.businessAreaId'),'missing')<>'text' OR coalesce(json_type(scope.value,'$.divisionId'),'missing') NOT IN ('text','null') OR (SELECT count(*) FROM json_each(scope.value))<>2)
 OR EXISTS(SELECT 1 FROM json_each(NEW.destinations_json) d WHERE json_type(d.value)<>'object'
 OR coalesce(json_type(d.value,'$.sourceId'),'missing')<>'text' OR coalesce(json_type(d.value,'$.sourceInstanceUUID'),'missing')<>'text'
 OR coalesce(json_type(d.value,'$.applicationUUID'),'missing')<>'text' OR coalesce(json_type(d.value,'$.historyEpoch'),'missing')<>'text'
 OR coalesce(json_type(d.value,'$.origin'),'missing')<>'text' OR coalesce(json_type(d.value,'$.externalCanonicalId'),'missing')<>'text'
 OR (SELECT count(*) FROM json_each(d.value))<>6 OR length(json_extract(d.value,'$.historyEpoch'))<>36
 OR substr(json_extract(d.value,'$.historyEpoch'),9,1)<>'-' OR substr(json_extract(d.value,'$.historyEpoch'),14,1)<>'-'
 OR substr(json_extract(d.value,'$.historyEpoch'),15,1)<>'4' OR substr(json_extract(d.value,'$.historyEpoch'),19,1)<>'-'
 OR substr(json_extract(d.value,'$.historyEpoch'),20,1) NOT GLOB '[89ab]' OR substr(json_extract(d.value,'$.historyEpoch'),24,1)<>'-'
 OR length(replace(json_extract(d.value,'$.historyEpoch'),'-',''))<>32 OR replace(json_extract(d.value,'$.historyEpoch'),'-','') GLOB '*[^0-9a-f]*')
 OR EXISTS(SELECT 1 FROM json_each(NEW.scopes_json) s LEFT JOIN native_business_areas a ON a.id=json_extract(s.value,'$.businessAreaId') AND a.active=1 LEFT JOIN native_business_divisions d ON d.id=json_extract(s.value,'$.divisionId') AND d.business_area_id=json_extract(s.value,'$.businessAreaId') AND d.active=1 WHERE a.id IS NULL OR (json_type(s.value,'$.divisionId')='text' AND d.id IS NULL))
 OR (SELECT count(*) FROM json_each(NEW.scopes_json))<>(SELECT count(*) FROM (SELECT json_extract(value,'$.businessAreaId'),json_extract(value,'$.divisionId') FROM json_each(NEW.scopes_json) GROUP BY 1,2))
 OR (SELECT count(*) FROM json_each(NEW.destinations_json))<>(SELECT count(*) FROM (SELECT json_extract(value,'$.sourceId'),json_extract(value,'$.sourceInstanceUUID'),json_extract(value,'$.applicationUUID') FROM json_each(NEW.destinations_json) GROUP BY 1,2,3))
BEGIN SELECT RAISE(ABORT,'native directory create admission is invalid'); END;

DROP TRIGGER operations_directory_intents_write_guard;
CREATE TRIGGER operations_directory_intents_write_guard BEFORE INSERT ON operations_directory_intents
WHEN NOT EXISTS(SELECT 1 FROM operations_directory_live_write_fences f,json_each(f.destinations_json) d WHERE f.mutation_id=NEW.mutation_id AND f.record_id=NEW.record_id AND NEW.record_version=f.expected_version+1 AND f.record_writes=0 AND f.revision_writes=0 AND f.audit_writes=0 AND f.intent_writes>0
 AND json_extract(d.value,'$.sourceId')=NEW.source_id AND json_extract(d.value,'$.sourceInstanceUUID')=NEW.source_instance_uuid AND json_extract(d.value,'$.applicationUUID')=NEW.application_uuid AND json_extract(d.value,'$.historyEpoch')=NEW.expected_history_epoch_id AND json_extract(d.value,'$.origin')=NEW.destination_origin AND json_extract(d.value,'$.externalCanonicalId')=NEW.external_canonical_id AND json(NEW.desired_payload_json)=json(f.profile_json))
BEGIN SELECT RAISE(ABORT,'directory intent requires current native authority and enrollment'); END;

CREATE TRIGGER project_alpha_directory_outbox_epoch_immutable BEFORE UPDATE ON project_alpha_directory_outbox
WHEN NEW.expected_history_epoch_id IS NOT OLD.expected_history_epoch_id
BEGIN SELECT RAISE(ABORT,'directory outbox history epoch is immutable'); END;
CREATE TRIGGER operations_directory_intents_epoch_immutable BEFORE UPDATE ON operations_directory_intents
WHEN NEW.expected_history_epoch_id IS NOT OLD.expected_history_epoch_id
BEGIN SELECT RAISE(ABORT,'directory intent history epoch is immutable'); END;
CREATE TRIGGER operations_directory_materializations_epoch_immutable BEFORE UPDATE ON operations_directory_materializations
WHEN NEW.history_epoch_id IS NOT OLD.history_epoch_id
BEGIN SELECT RAISE(ABORT,'directory materialization history epoch is immutable'); END;

CREATE TRIGGER operations_directory_intents_epoch_valid BEFORE INSERT ON operations_directory_intents
WHEN NEW.expected_history_epoch_id IS NULL OR length(NEW.expected_history_epoch_id)<>36
 OR substr(NEW.expected_history_epoch_id,9,1)<>'-' OR substr(NEW.expected_history_epoch_id,14,1)<>'-'
 OR substr(NEW.expected_history_epoch_id,15,1)<>'4' OR substr(NEW.expected_history_epoch_id,19,1)<>'-'
 OR substr(NEW.expected_history_epoch_id,20,1) NOT GLOB '[89ab]' OR substr(NEW.expected_history_epoch_id,24,1)<>'-'
 OR length(replace(NEW.expected_history_epoch_id,'-',''))<>32
 OR replace(NEW.expected_history_epoch_id,'-','') GLOB '*[^0-9a-f]*'
BEGIN SELECT RAISE(ABORT,'directory intent history epoch is invalid'); END;
CREATE TRIGGER project_alpha_directory_outbox_epoch_valid BEFORE INSERT ON project_alpha_directory_outbox
WHEN NEW.expected_history_epoch_id IS NULL OR length(NEW.expected_history_epoch_id)<>36
 OR substr(NEW.expected_history_epoch_id,9,1)<>'-' OR substr(NEW.expected_history_epoch_id,14,1)<>'-'
 OR substr(NEW.expected_history_epoch_id,15,1)<>'4' OR substr(NEW.expected_history_epoch_id,19,1)<>'-'
 OR substr(NEW.expected_history_epoch_id,20,1) NOT GLOB '[89ab]' OR substr(NEW.expected_history_epoch_id,24,1)<>'-'
 OR length(replace(NEW.expected_history_epoch_id,'-',''))<>32
 OR replace(NEW.expected_history_epoch_id,'-','') GLOB '*[^0-9a-f]*'
BEGIN SELECT RAISE(ABORT,'directory outbox history epoch is invalid'); END;
CREATE TRIGGER project_alpha_directory_mappings_epoch_valid BEFORE INSERT ON project_alpha_directory_mappings
WHEN NEW.history_epoch_id IS NULL OR length(NEW.history_epoch_id)<>36
 OR substr(NEW.history_epoch_id,9,1)<>'-' OR substr(NEW.history_epoch_id,14,1)<>'-'
 OR substr(NEW.history_epoch_id,15,1)<>'4' OR substr(NEW.history_epoch_id,19,1)<>'-'
 OR substr(NEW.history_epoch_id,20,1) NOT GLOB '[89ab]' OR substr(NEW.history_epoch_id,24,1)<>'-'
 OR length(replace(NEW.history_epoch_id,'-',''))<>32
 OR replace(NEW.history_epoch_id,'-','') GLOB '*[^0-9a-f]*'
 OR NOT EXISTS(SELECT 1 FROM project_alpha_directory_outbox o
  WHERE o.command_id=NEW.command_id AND o.state='leased' AND o.expected_history_epoch_id=NEW.history_epoch_id)
BEGIN SELECT RAISE(ABORT,'directory mapping history epoch is invalid'); END;

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
