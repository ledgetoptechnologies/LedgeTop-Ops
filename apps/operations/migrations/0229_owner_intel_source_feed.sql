PRAGMA foreign_keys=ON;

-- Source-only Owner Intel v2. It is independently default-off and does not
-- widen frozen v1 inbox kinds or seed any identities, grants, keys or bindings.
CREATE TABLE owner_intel_source_control (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 schema_version INTEGER NOT NULL CHECK(schema_version=1),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
 storage_accepted INTEGER NOT NULL DEFAULT 0 CHECK(storage_accepted IN(0,1)),
 CHECK(enabled=0 OR storage_accepted=1)
);
INSERT INTO owner_intel_source_control(singleton,schema_version) VALUES(1,1);

-- This is the reviewed allowlist/context. Payloads cannot supply or select it.
CREATE TABLE owner_intel_source_bindings (
 producer_id TEXT NOT NULL,
 binding_id TEXT NOT NULL,
 configuration_revision INTEGER NOT NULL CHECK(configuration_revision>=1),
 observation_kind TEXT NOT NULL CHECK(observation_kind IN('search_console_summary','own_site')),
 subject_key TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source IN('google_search_console','hermes_site_monitor')),
 source_account_ref TEXT,
 collected_by TEXT NOT NULL,
 reviewed_context_json TEXT NOT NULL CHECK(json_valid(reviewed_context_json) AND length(CAST(reviewed_context_json AS BLOB))<=32768),
 active INTEGER NOT NULL CHECK(active IN(0,1)),
 PRIMARY KEY(producer_id,binding_id,configuration_revision,observation_kind,subject_key),
 FOREIGN KEY(binding_id) REFERENCES owner_intel_bindings(binding_id) ON DELETE RESTRICT
);
CREATE TRIGGER owner_intel_source_binding_context_immutable BEFORE UPDATE ON owner_intel_source_bindings
WHEN NEW.producer_id IS NOT OLD.producer_id OR NEW.binding_id IS NOT OLD.binding_id OR NEW.configuration_revision IS NOT OLD.configuration_revision
 OR NEW.observation_kind IS NOT OLD.observation_kind OR NEW.subject_key IS NOT OLD.subject_key OR NEW.source IS NOT OLD.source
 OR NEW.source_account_ref IS NOT OLD.source_account_ref OR NEW.collected_by IS NOT OLD.collected_by
 OR NEW.reviewed_context_json IS NOT OLD.reviewed_context_json OR (OLD.active=0 AND NEW.active<>0)
BEGIN SELECT RAISE(ABORT,'owner_intel_source_binding_context_immutable'); END;
CREATE TRIGGER owner_intel_source_binding_retained BEFORE DELETE ON owner_intel_source_bindings
BEGIN SELECT RAISE(ABORT,'owner_intel_source_binding_retained'); END;

CREATE TABLE owner_intel_source_inbox (
 operation_id TEXT PRIMARY KEY NOT NULL,
 producer_id TEXT NOT NULL,
 key_id TEXT NOT NULL,
 key_revision INTEGER NOT NULL CHECK(key_revision>=1),
 binding_id TEXT NOT NULL,
 configuration_revision INTEGER NOT NULL,
 subject_key TEXT NOT NULL,
 observation_kind TEXT NOT NULL CHECK(observation_kind IN('search_console_summary','own_site')),
 epoch TEXT NOT NULL,
 counter TEXT NOT NULL,
 payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=43),
 raw_body TEXT NOT NULL CHECK(json_valid(raw_body) AND length(CAST(raw_body AS BLOB))<=262144),
 observation_json TEXT NOT NULL CHECK(json_valid(observation_json) AND length(CAST(observation_json AS BLOB))<=262144),
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
 accepted_at TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN('accepted_head','accepted_history')),
 UNIQUE(binding_id,configuration_revision,subject_key,epoch,counter),
 FOREIGN KEY(binding_id) REFERENCES owner_intel_bindings(binding_id) ON DELETE RESTRICT
);
CREATE INDEX owner_intel_source_inbox_scope ON owner_intel_source_inbox(binding_id,configuration_revision,observation_kind,accepted_at);
CREATE TABLE owner_intel_source_epochs(binding_id TEXT NOT NULL,configuration_revision INTEGER NOT NULL,epoch TEXT NOT NULL,PRIMARY KEY(binding_id,configuration_revision));
CREATE TABLE owner_intel_source_subject_heads(binding_id TEXT NOT NULL,configuration_revision INTEGER NOT NULL,subject_key TEXT NOT NULL,epoch TEXT NOT NULL,counter TEXT NOT NULL,operation_id TEXT NOT NULL REFERENCES owner_intel_source_inbox(operation_id),PRIMARY KEY(binding_id,configuration_revision,subject_key));
CREATE TABLE owner_intel_source_kind_heads(binding_id TEXT NOT NULL,configuration_revision INTEGER NOT NULL,subject_key TEXT NOT NULL,observation_kind TEXT NOT NULL,operation_id TEXT NOT NULL REFERENCES owner_intel_source_inbox(operation_id),PRIMARY KEY(binding_id,configuration_revision,subject_key,observation_kind));
-- GSC has one reviewed site subject but may keep separate exact-period read
-- heads. Each range head points to a signed source event; no range is derived
-- from another period's totals or ranked rows.
CREATE TABLE owner_intel_source_range_heads(binding_id TEXT NOT NULL,configuration_revision INTEGER NOT NULL,subject_key TEXT NOT NULL,period_days INTEGER NOT NULL CHECK(period_days BETWEEN 1 AND 93),operation_id TEXT NOT NULL REFERENCES owner_intel_source_inbox(operation_id),PRIMARY KEY(binding_id,configuration_revision,subject_key,period_days));
CREATE TABLE owner_intel_source_epoch_audit(operation_id TEXT PRIMARY KEY REFERENCES owner_intel_source_inbox(operation_id),binding_id TEXT NOT NULL,configuration_revision INTEGER NOT NULL,previous_epoch TEXT,epoch TEXT NOT NULL,accepted_at TEXT NOT NULL);

-- Read DTO projections retain the complete accepted source payload and its
-- source-to-projection receipt. A new sequence head appends; history survives.
CREATE TABLE owner_intel_source_projections (
 projection_id TEXT PRIMARY KEY NOT NULL,
 binding_id TEXT NOT NULL,
 configuration_revision INTEGER NOT NULL,
 observation_kind TEXT NOT NULL CHECK(observation_kind IN('search_console_summary','own_site')),
 subject_key TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>=1),
 source_operation_id TEXT NOT NULL REFERENCES owner_intel_source_inbox(operation_id),
 source_contract_sha256 TEXT NOT NULL CHECK(source_contract_sha256='ff354e29fbb8e751317db502e18b3654af42f24652a30e67eb61bb60cde0e567'),
 read_schema TEXT NOT NULL CHECK(read_schema='ops.intel.owner-source.v1'),
 dto_json TEXT NOT NULL CHECK(json_valid(dto_json) AND length(CAST(dto_json AS BLOB))<=262144),
 dto_sha256 TEXT NOT NULL CHECK(length(dto_sha256)=64 AND dto_sha256 NOT GLOB '*[^0-9a-f]*'),
 accepted_at TEXT NOT NULL CHECK(julianday(accepted_at) IS NOT NULL),
 FOREIGN KEY(binding_id) REFERENCES owner_intel_bindings(binding_id) ON DELETE RESTRICT,
 UNIQUE(binding_id,configuration_revision,observation_kind,subject_key,revision)
);
CREATE INDEX owner_intel_source_projection_read ON owner_intel_source_projections(binding_id,configuration_revision,observation_kind,subject_key,revision DESC);

CREATE TABLE owner_intel_source_batch_guards(operation_id TEXT PRIMARY KEY,assertion INTEGER NOT NULL CHECK(assertion=1));
CREATE TRIGGER owner_intel_source_inbox_immutable BEFORE UPDATE ON owner_intel_source_inbox BEGIN SELECT RAISE(ABORT,'owner_intel_source_inbox_immutable'); END;
CREATE TRIGGER owner_intel_source_inbox_retained BEFORE DELETE ON owner_intel_source_inbox BEGIN SELECT RAISE(ABORT,'owner_intel_source_inbox_retained'); END;
CREATE TRIGGER owner_intel_source_epoch_audit_immutable BEFORE UPDATE ON owner_intel_source_epoch_audit BEGIN SELECT RAISE(ABORT,'owner_intel_source_epoch_audit_immutable'); END;
CREATE TRIGGER owner_intel_source_epoch_audit_retained BEFORE DELETE ON owner_intel_source_epoch_audit BEGIN SELECT RAISE(ABORT,'owner_intel_source_epoch_audit_retained'); END;
CREATE TRIGGER owner_intel_source_projection_immutable BEFORE UPDATE ON owner_intel_source_projections BEGIN SELECT RAISE(ABORT,'owner_intel_source_projection_immutable'); END;
CREATE TRIGGER owner_intel_source_projection_retained BEFORE DELETE ON owner_intel_source_projections BEGIN SELECT RAISE(ABORT,'owner_intel_source_projection_retained'); END;
-- Operation IDs share a replay namespace across the frozen v1 lane and this
-- source lane without changing v1's schema or observation-kind allowlist.
CREATE TRIGGER owner_intel_source_no_v1_operation BEFORE INSERT ON owner_intel_source_inbox
WHEN EXISTS(SELECT 1 FROM ci_ingest_inbox WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'intel_operation_id_cross_lane_conflict'); END;
CREATE TRIGGER owner_intel_v1_no_source_operation BEFORE INSERT ON ci_ingest_inbox
WHEN EXISTS(SELECT 1 FROM owner_intel_source_inbox WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'intel_operation_id_cross_lane_conflict'); END;
