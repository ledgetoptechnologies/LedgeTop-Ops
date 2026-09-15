PRAGMA foreign_keys = ON;

-- Dormant evidence for a future native Project Alpha v2 sender.  This ledger
-- intentionally records only hashes and protocol identifiers: credentials,
-- destination URLs, response bodies, and public-share URLs never belong here.
-- Existing 0062--0064 rows are historical evidence.  A row becomes eligible
-- only when 0086 created both its native proof and its same-batch reservation.
CREATE TABLE project_alpha_project_v2_request_fingerprints (
  command_id TEXT NOT NULL PRIMARY KEY REFERENCES project_alpha_project_outbox(command_id) ON DELETE RESTRICT,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256=lower(request_sha256)
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER project_alpha_project_v2_request_fingerprints_native_only
BEFORE INSERT ON project_alpha_project_v2_request_fingerprints
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_outbox outbox
  JOIN native_project_command_reservations reservation ON reservation.command_id=outbox.command_id
  JOIN native_project_live_command_proofs proof ON proof.command_id=outbox.command_id
    AND proof.external_project_id=outbox.external_project_id
  WHERE outbox.command_id=NEW.command_id AND outbox.operation IN ('create','update','bind')
)
BEGIN SELECT RAISE(ABORT,'project v2 request requires a live native reservation'); END;
CREATE TRIGGER project_alpha_project_v2_request_fingerprints_no_update
BEFORE UPDATE ON project_alpha_project_v2_request_fingerprints
BEGIN SELECT RAISE(ABORT,'project v2 request fingerprint is immutable'); END;
CREATE TRIGGER project_alpha_project_v2_request_fingerprints_no_delete
BEFORE DELETE ON project_alpha_project_v2_request_fingerprints
BEGIN SELECT RAISE(ABORT,'project v2 request fingerprints are durable'); END;

-- The first pending event reserves a canonical request hash.  An uncertain
-- result may return to pending for the same command; conflict, rejected, and
-- acknowledged are terminal.  The acknowledged edge rechecks live authority.
CREATE TABLE project_alpha_project_v2_events (
  command_id TEXT NOT NULL REFERENCES project_alpha_project_v2_request_fingerprints(command_id) ON DELETE RESTRICT,
  state_version INTEGER NOT NULL CHECK(typeof(state_version)='integer' AND state_version>=1),
  transition_id TEXT NOT NULL UNIQUE CHECK(length(transition_id)=36 AND transition_id=lower(transition_id)
    AND transition_id NOT GLOB '*[^0-9a-f-]*' AND substr(transition_id,9,1)='-'
    AND substr(transition_id,14,1)='-' AND substr(transition_id,15,1)='4'
    AND substr(transition_id,19,1)='-' AND substr(transition_id,20,1) IN ('8','9','a','b')
    AND substr(transition_id,24,1)='-' AND length(replace(transition_id,'-',''))=32),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256=lower(request_sha256)
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('pending','uncertain','conflict','rejected','acknowledged')),
  occurred_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    CHECK(length(occurred_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS occurred_at),
  PRIMARY KEY(command_id,state_version)
);
CREATE TRIGGER project_alpha_project_v2_events_transition_valid
BEFORE INSERT ON project_alpha_project_v2_events
WHEN NEW.request_sha256 IS NOT (SELECT request_sha256 FROM project_alpha_project_v2_request_fingerprints WHERE command_id=NEW.command_id)
 OR (NEW.state_version=1 AND NEW.state<>'pending')
 OR (NEW.state_version>1 AND NOT EXISTS (
   SELECT 1 FROM project_alpha_project_v2_events prior
   WHERE prior.command_id=NEW.command_id AND prior.state_version=NEW.state_version-1
     AND ((prior.state='pending' AND NEW.state IN ('uncertain','conflict','rejected','acknowledged'))
       OR (prior.state='uncertain' AND NEW.state IN ('pending','conflict','rejected','acknowledged')))
 ))
BEGIN SELECT RAISE(ABORT,'project v2 event transition is invalid'); END;
CREATE TRIGGER project_alpha_project_v2_events_acknowledgement_authority
BEFORE INSERT ON project_alpha_project_v2_events
WHEN NEW.state='acknowledged' AND NOT EXISTS (
  SELECT 1 FROM project_alpha_project_outbox outbox
  JOIN native_project_command_reservations reservation ON reservation.command_id=outbox.command_id
  JOIN native_project_live_command_proofs proof ON proof.command_id=outbox.command_id
    AND proof.external_project_id=outbox.external_project_id
  WHERE outbox.command_id=NEW.command_id AND outbox.operation IN ('create','update','bind')
)
BEGIN SELECT RAISE(ABORT,'project v2 acknowledgement requires current native authority'); END;
CREATE TRIGGER project_alpha_project_v2_events_no_update
BEFORE UPDATE ON project_alpha_project_v2_events
BEGIN SELECT RAISE(ABORT,'project v2 events are immutable'); END;
CREATE TRIGGER project_alpha_project_v2_events_no_delete
BEFORE DELETE ON project_alpha_project_v2_events
BEGIN SELECT RAISE(ABORT,'project v2 events are durable'); END;

-- D1 cannot establish that arbitrary caller JSON came from PA.  A future
-- private transport validator/adapter must insert this immutable row only
-- after it validates the response bytes and trusted headers; no route mounts
-- that adapter in this checkpoint.  Receipts require this row, so an event
-- writer cannot forge a success merely by adding an acknowledged event.
CREATE TABLE project_alpha_project_v2_validated_acknowledgements (
  acknowledgement_id TEXT NOT NULL PRIMARY KEY CHECK(length(acknowledgement_id)=36 AND acknowledgement_id=lower(acknowledgement_id)
    AND acknowledgement_id NOT GLOB '*[^0-9a-f-]*' AND substr(acknowledgement_id,9,1)='-'
    AND substr(acknowledgement_id,14,1)='-' AND substr(acknowledgement_id,15,1)='4'
    AND substr(acknowledgement_id,19,1)='-' AND substr(acknowledgement_id,20,1) IN ('8','9','a','b')
    AND substr(acknowledgement_id,24,1)='-' AND length(replace(acknowledgement_id,'-',''))=32),
  command_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_project_v2_request_fingerprints(command_id) ON DELETE RESTRICT,
  acknowledged_state_version INTEGER NOT NULL,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256=lower(request_sha256) AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_instance_id TEXT NOT NULL CHECK(length(source_instance_id)=36),
  application_id TEXT NOT NULL CHECK(length(application_id)=36),
  history_epoch_id TEXT NOT NULL CHECK(length(history_epoch_id)=36),
  destination_origin TEXT NOT NULL CHECK(substr(destination_origin,1,8)='https://' AND length(destination_origin)<=2048 AND substr(destination_origin,-1)<>'/'),
  project_alpha_public_id TEXT NOT NULL CHECK(length(project_alpha_public_id)=32 AND project_alpha_public_id=lower(project_alpha_public_id) AND project_alpha_public_id NOT GLOB '*[^0-9a-f]*'),
  project_alpha_revision TEXT NOT NULL CHECK(length(project_alpha_revision) BETWEEN 1 AND 19 AND project_alpha_revision NOT GLOB '*[^0-9]*' AND substr(project_alpha_revision,1,1)<>'0' AND (length(project_alpha_revision)<19 OR project_alpha_revision<='9223372036854775807')),
  projection_sha256 TEXT NOT NULL CHECK(length(projection_sha256)=64 AND projection_sha256=lower(projection_sha256) AND projection_sha256 NOT GLOB '*[^0-9a-f]*'),
  authorization_generation TEXT NOT NULL CHECK(length(authorization_generation) BETWEEN 1 AND 19 AND authorization_generation NOT GLOB '*[^0-9]*' AND (authorization_generation='0' OR substr(authorization_generation,1,1)<>'0') AND (length(authorization_generation)<19 OR authorization_generation<='9223372036854775807')),
  pa_request_id TEXT NOT NULL CHECK(length(pa_request_id)=36 AND pa_request_id=lower(pa_request_id) AND pa_request_id NOT GLOB '*[^0-9a-f-]*' AND substr(pa_request_id,9,1)='-' AND substr(pa_request_id,14,1)='-' AND substr(pa_request_id,15,1)='4' AND substr(pa_request_id,19,1)='-' AND substr(pa_request_id,20,1) IN ('8','9','a','b') AND substr(pa_request_id,24,1)='-' AND length(replace(pa_request_id,'-',''))=32),
  pa_replayed INTEGER NOT NULL CHECK(typeof(pa_replayed)='integer' AND pa_replayed IN (0,1)),
  response_sha256 TEXT NOT NULL CHECK(length(response_sha256)=64 AND response_sha256=lower(response_sha256) AND response_sha256 NOT GLOB '*[^0-9a-f]*'),
  validated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK(length(validated_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',validated_at) IS validated_at),
  FOREIGN KEY(command_id,acknowledged_state_version) REFERENCES project_alpha_project_v2_events(command_id,state_version) ON DELETE RESTRICT
);
CREATE TRIGGER project_alpha_project_v2_validated_acknowledgements_exact
BEFORE INSERT ON project_alpha_project_v2_validated_acknowledgements
WHEN NEW.request_sha256 IS NOT (SELECT request_sha256 FROM project_alpha_project_v2_request_fingerprints WHERE command_id=NEW.command_id)
 OR NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_events event WHERE event.command_id=NEW.command_id AND event.state_version=NEW.acknowledged_state_version AND event.state='acknowledged')
 OR NOT EXISTS (SELECT 1 FROM project_alpha_project_outbox outbox JOIN native_project_command_reservations reservation ON reservation.command_id=outbox.command_id JOIN native_project_live_command_proofs proof ON proof.command_id=outbox.command_id AND proof.external_project_id=outbox.external_project_id WHERE outbox.command_id=NEW.command_id AND outbox.operation IN ('create','update','bind') AND outbox.expected_source_instance_id=NEW.source_instance_id AND outbox.application_id=NEW.application_id AND outbox.expected_history_epoch_id=NEW.history_epoch_id AND rtrim(outbox.destination_base_url,'/')=NEW.destination_origin)
 OR NOT EXISTS (SELECT 1 FROM project_alpha_project_outbox outbox WHERE outbox.command_id=NEW.command_id AND json_type(outbox.command_json,'$.externalId')='text' AND json_extract(outbox.command_json,'$.externalId')=outbox.external_project_id)
 OR EXISTS (SELECT 1 FROM project_alpha_project_mappings mapping JOIN project_alpha_project_outbox outbox ON outbox.command_id=NEW.command_id WHERE mapping.source_instance_id=NEW.source_instance_id AND mapping.history_epoch_id=NEW.history_epoch_id AND mapping.project_alpha_public_id=NEW.project_alpha_public_id AND mapping.external_project_id<>outbox.external_project_id)
 OR EXISTS (SELECT 1 FROM project_alpha_project_outbox outbox WHERE outbox.command_id=NEW.command_id AND outbox.operation='create' AND (json_type(outbox.command_json,'$.expectedAuthorizationGeneration') IS NOT 'text' OR json_extract(outbox.command_json,'$.expectedAuthorizationGeneration') NOT GLOB '[0-9]*' OR json_extract(outbox.command_json,'$.expectedAuthorizationGeneration') GLOB '*[^0-9]*' OR (json_extract(outbox.command_json,'$.expectedAuthorizationGeneration')<>'0' AND substr(json_extract(outbox.command_json,'$.expectedAuthorizationGeneration'),1,1)='0') OR length(json_extract(outbox.command_json,'$.expectedAuthorizationGeneration'))>19 OR json_extract(outbox.command_json,'$.expectedAuthorizationGeneration')='9223372036854775807' OR CAST(NEW.authorization_generation AS INTEGER)<>CAST(json_extract(outbox.command_json,'$.expectedAuthorizationGeneration') AS INTEGER)+1))
 OR EXISTS (SELECT 1 FROM project_alpha_project_outbox outbox WHERE outbox.command_id=NEW.command_id AND outbox.operation='bind' AND (json_type(outbox.command_json,'$.expectedPublicId') IS NOT 'text' OR json_extract(outbox.command_json,'$.expectedPublicId')<>NEW.project_alpha_public_id OR json_type(outbox.command_json,'$.expectedRevision') IS NOT 'text' OR json_extract(outbox.command_json,'$.expectedRevision')<>NEW.project_alpha_revision OR json_type(outbox.command_json,'$.expectedProjectionSha256') IS NOT 'text' OR json_extract(outbox.command_json,'$.expectedProjectionSha256')<>NEW.projection_sha256 OR json_type(outbox.command_json,'$.expectedAuthorizationGeneration') IS NOT 'text' OR json_extract(outbox.command_json,'$.expectedAuthorizationGeneration') NOT GLOB '[0-9]*' OR json_extract(outbox.command_json,'$.expectedAuthorizationGeneration') GLOB '*[^0-9]*' OR (json_extract(outbox.command_json,'$.expectedAuthorizationGeneration')<>'0' AND substr(json_extract(outbox.command_json,'$.expectedAuthorizationGeneration'),1,1)='0') OR length(json_extract(outbox.command_json,'$.expectedAuthorizationGeneration'))>19 OR json_extract(outbox.command_json,'$.expectedAuthorizationGeneration')='9223372036854775807' OR CAST(NEW.authorization_generation AS INTEGER)<>CAST(json_extract(outbox.command_json,'$.expectedAuthorizationGeneration') AS INTEGER)+1))
 OR EXISTS (SELECT 1 FROM project_alpha_project_outbox outbox LEFT JOIN project_alpha_project_mappings mapping ON mapping.external_project_id=outbox.external_project_id WHERE outbox.command_id=NEW.command_id AND outbox.operation='update' AND (mapping.external_project_id IS NULL OR mapping.source_instance_id<>NEW.source_instance_id OR mapping.history_epoch_id<>NEW.history_epoch_id OR mapping.project_alpha_public_id<>NEW.project_alpha_public_id OR json_type(outbox.command_json,'$.expectedRevision') IS NOT 'text' OR json_extract(outbox.command_json,'$.expectedRevision') NOT GLOB '[1-9]*' OR json_extract(outbox.command_json,'$.expectedRevision') GLOB '*[^0-9]*' OR length(json_extract(outbox.command_json,'$.expectedRevision'))>19 OR json_type(outbox.command_json,'$.expectedProjectionSha256') IS NOT 'text' OR length(json_extract(outbox.command_json,'$.expectedProjectionSha256'))<>64 OR json_extract(outbox.command_json,'$.expectedProjectionSha256')<>lower(json_extract(outbox.command_json,'$.expectedProjectionSha256')) OR json_extract(outbox.command_json,'$.expectedProjectionSha256') GLOB '*[^0-9a-f]*' OR json_type(outbox.command_json,'$.expectedAuthorizationGeneration') IS NOT 'text' OR json_extract(outbox.command_json,'$.expectedAuthorizationGeneration')<>NEW.authorization_generation OR (length(NEW.project_alpha_revision)<length(json_extract(outbox.command_json,'$.expectedRevision')) OR (length(NEW.project_alpha_revision)=length(json_extract(outbox.command_json,'$.expectedRevision')) AND NEW.project_alpha_revision<json_extract(outbox.command_json,'$.expectedRevision')))))
BEGIN SELECT RAISE(ABORT,'project v2 validated acknowledgement is not exact'); END;
CREATE TRIGGER project_alpha_project_v2_validated_acknowledgements_no_update BEFORE UPDATE ON project_alpha_project_v2_validated_acknowledgements
BEGIN SELECT RAISE(ABORT,'project v2 validated acknowledgements are immutable'); END;
CREATE TRIGGER project_alpha_project_v2_validated_acknowledgements_no_delete BEFORE DELETE ON project_alpha_project_v2_validated_acknowledgements
BEGIN SELECT RAISE(ABORT,'project v2 validated acknowledgements are durable'); END;

-- A successful response is represented by its exact protocol fields and a
-- response hash, not by serializing the response.  This has no side effect on
-- legacy mappings, shared projects, Delivery rows, or public links.
CREATE TABLE project_alpha_project_v2_success_receipts (
  receipt_id TEXT NOT NULL PRIMARY KEY CHECK(length(receipt_id)=36 AND receipt_id=lower(receipt_id)
    AND receipt_id NOT GLOB '*[^0-9a-f-]*' AND substr(receipt_id,9,1)='-'
    AND substr(receipt_id,14,1)='-' AND substr(receipt_id,15,1)='4'
    AND substr(receipt_id,19,1)='-' AND substr(receipt_id,20,1) IN ('8','9','a','b')
    AND substr(receipt_id,24,1)='-' AND length(replace(receipt_id,'-',''))=32),
  acknowledgement_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_project_v2_validated_acknowledgements(acknowledgement_id) ON DELETE RESTRICT,
  command_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_project_v2_request_fingerprints(command_id) ON DELETE RESTRICT,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256=lower(request_sha256)
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_instance_id TEXT NOT NULL CHECK(length(source_instance_id)=36),
  application_id TEXT NOT NULL CHECK(length(application_id)=36),
  history_epoch_id TEXT NOT NULL CHECK(length(history_epoch_id)=36),
  destination_origin TEXT NOT NULL CHECK(substr(destination_origin,1,8)='https://' AND length(destination_origin)<=2048 AND substr(destination_origin,-1)<>'/'),
  project_alpha_public_id TEXT NOT NULL CHECK(length(project_alpha_public_id)=32 AND project_alpha_public_id=lower(project_alpha_public_id)
    AND project_alpha_public_id NOT GLOB '*[^0-9a-f]*'),
  project_alpha_revision TEXT NOT NULL CHECK(length(project_alpha_revision) BETWEEN 1 AND 19
    AND project_alpha_revision NOT GLOB '*[^0-9]*' AND substr(project_alpha_revision,1,1)<>'0'
    AND (length(project_alpha_revision)<19 OR project_alpha_revision<='9223372036854775807')),
  projection_sha256 TEXT NOT NULL CHECK(length(projection_sha256)=64 AND projection_sha256=lower(projection_sha256)
    AND projection_sha256 NOT GLOB '*[^0-9a-f]*'),
  authorization_generation TEXT NOT NULL CHECK(length(authorization_generation) BETWEEN 1 AND 19
    AND authorization_generation NOT GLOB '*[^0-9]*'
    AND (authorization_generation='0' OR substr(authorization_generation,1,1)<>'0')
    AND (length(authorization_generation)<19 OR authorization_generation<='9223372036854775807')),
  pa_request_id TEXT NOT NULL CHECK(length(pa_request_id)=36 AND pa_request_id=lower(pa_request_id)
    AND pa_request_id NOT GLOB '*[^0-9a-f-]*' AND substr(pa_request_id,9,1)='-'
    AND substr(pa_request_id,14,1)='-' AND substr(pa_request_id,15,1)='4'
    AND substr(pa_request_id,19,1)='-' AND substr(pa_request_id,20,1) IN ('8','9','a','b')
    AND substr(pa_request_id,24,1)='-' AND length(replace(pa_request_id,'-',''))=32),
  pa_replayed INTEGER NOT NULL CHECK(typeof(pa_replayed)='integer' AND pa_replayed IN (0,1)),
  response_sha256 TEXT NOT NULL CHECK(length(response_sha256)=64 AND response_sha256=lower(response_sha256)
    AND response_sha256 NOT GLOB '*[^0-9a-f]*'),
  received_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER project_alpha_project_v2_success_receipts_exact
BEFORE INSERT ON project_alpha_project_v2_success_receipts
WHEN NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_validated_acknowledgements acknowledgement
  WHERE acknowledgement.acknowledgement_id=NEW.acknowledgement_id AND acknowledgement.command_id=NEW.command_id
    AND acknowledgement.request_sha256=NEW.request_sha256 AND acknowledgement.source_instance_id=NEW.source_instance_id
    AND acknowledgement.application_id=NEW.application_id AND acknowledgement.history_epoch_id=NEW.history_epoch_id
    AND acknowledgement.destination_origin=NEW.destination_origin
    AND acknowledgement.project_alpha_public_id=NEW.project_alpha_public_id
    AND acknowledgement.project_alpha_revision=NEW.project_alpha_revision
    AND acknowledgement.projection_sha256=NEW.projection_sha256
    AND acknowledgement.authorization_generation=NEW.authorization_generation
    AND acknowledgement.pa_request_id=NEW.pa_request_id AND acknowledgement.pa_replayed=NEW.pa_replayed
    AND acknowledgement.response_sha256=NEW.response_sha256)
BEGIN SELECT RAISE(ABORT,'project v2 success receipt is not exact'); END;
CREATE TRIGGER project_alpha_project_v2_success_receipts_no_update
BEFORE UPDATE ON project_alpha_project_v2_success_receipts
BEGIN SELECT RAISE(ABORT,'project v2 success receipts are immutable'); END;
CREATE TRIGGER project_alpha_project_v2_success_receipts_no_delete
BEFORE DELETE ON project_alpha_project_v2_success_receipts
BEGIN SELECT RAISE(ABORT,'project v2 success receipts are durable'); END;
