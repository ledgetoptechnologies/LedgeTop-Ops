PRAGMA foreign_keys=ON;

-- Proposed, independent Owner Google Ads reader storage. This migration does
-- not widen frozen v1 or 0229 source-feed CHECK constraints and seeds no
-- business mapping, producer, key, binding, grant, or metric data.
CREATE TABLE owner_intel_google_ads_control (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 schema_version INTEGER NOT NULL CHECK(schema_version=1),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
 storage_accepted INTEGER NOT NULL DEFAULT 0 CHECK(storage_accepted IN(0,1)),
 CHECK(enabled=0 OR storage_accepted=1)
);
INSERT INTO owner_intel_google_ads_control(singleton,schema_version) VALUES(1,1);

-- One exact owner-business binding. Account identity, owner binding revision,
-- and collector are immutable. For a verified no-account result, all provider
-- account context is explicitly NULL; no absence-based inference is stored.
CREATE TABLE owner_intel_google_ads_bindings (
 producer_id TEXT NOT NULL,
 binding_id TEXT NOT NULL,
 configuration_revision INTEGER NOT NULL CHECK(configuration_revision>=1),
 subject_key TEXT NOT NULL CHECK(subject_key='own:google-ads'),
 observation_kind TEXT NOT NULL CHECK(observation_kind='google_ads_summary'),
 account_state TEXT NOT NULL CHECK(account_state IN('connected','no_account')),
 manager_customer_ref TEXT,
 advertiser_customer_ref TEXT,
 source_account_ref TEXT,
 currency_code TEXT,
 time_zone TEXT,
 collected_by TEXT NOT NULL CHECK(length(collected_by) BETWEEN 1 AND 64),
 active INTEGER NOT NULL CHECK(active IN(0,1)),
 CHECK((account_state='connected' AND manager_customer_ref GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' AND advertiser_customer_ref GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' AND source_account_ref=advertiser_customer_ref AND currency_code GLOB '[A-Z][A-Z][A-Z]' AND length(time_zone) BETWEEN 1 AND 64)
   OR (account_state='no_account' AND manager_customer_ref IS NULL AND advertiser_customer_ref IS NULL AND source_account_ref IS NULL AND currency_code IS NULL AND time_zone IS NULL)),
 PRIMARY KEY(producer_id,binding_id,configuration_revision,subject_key),
 UNIQUE(binding_id,configuration_revision,subject_key),
 FOREIGN KEY(binding_id,configuration_revision) REFERENCES owner_intel_bindings(binding_id,configuration_revision) ON DELETE RESTRICT
);
CREATE TRIGGER owner_intel_google_ads_binding_context_immutable BEFORE UPDATE ON owner_intel_google_ads_bindings
WHEN NEW.producer_id IS NOT OLD.producer_id OR NEW.binding_id IS NOT OLD.binding_id OR NEW.configuration_revision IS NOT OLD.configuration_revision
 OR NEW.subject_key IS NOT OLD.subject_key OR NEW.observation_kind IS NOT OLD.observation_kind OR NEW.account_state IS NOT OLD.account_state
 OR NEW.manager_customer_ref IS NOT OLD.manager_customer_ref OR NEW.advertiser_customer_ref IS NOT OLD.advertiser_customer_ref
 OR NEW.source_account_ref IS NOT OLD.source_account_ref OR NEW.currency_code IS NOT OLD.currency_code OR NEW.time_zone IS NOT OLD.time_zone
 OR NEW.collected_by IS NOT OLD.collected_by OR (OLD.active=0 AND NEW.active<>0)
BEGIN SELECT RAISE(ABORT,'owner_intel_google_ads_binding_context_immutable'); END;
CREATE TRIGGER owner_intel_google_ads_binding_retained BEFORE DELETE ON owner_intel_google_ads_bindings
BEGIN SELECT RAISE(ABORT,'owner_intel_google_ads_binding_retained'); END;

CREATE TABLE owner_intel_google_ads_inbox (
 operation_id TEXT PRIMARY KEY NOT NULL,
 producer_id TEXT NOT NULL,
 key_id TEXT NOT NULL,
 key_revision INTEGER NOT NULL CHECK(key_revision>=1),
 binding_id TEXT NOT NULL,
 configuration_revision INTEGER NOT NULL,
 subject_key TEXT NOT NULL CHECK(subject_key='own:google-ads'),
 epoch TEXT NOT NULL,
 counter TEXT NOT NULL,
 period_key TEXT NOT NULL CHECK(period_key IN('status','7d','28d','90d')),
 period_days INTEGER CHECK(period_days IS NULL OR period_days IN(7,28,90)),
 payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=43),
 raw_body TEXT NOT NULL CHECK(json_valid(raw_body) AND length(CAST(raw_body AS BLOB))<=262144),
 observation_json TEXT NOT NULL CHECK(json_valid(observation_json) AND length(CAST(observation_json AS BLOB))<=262144),
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
 accepted_at TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN('accepted_head','accepted_history')),
 CHECK((period_key='status' AND period_days IS NULL) OR (period_key='7d' AND period_days=7) OR (period_key='28d' AND period_days=28) OR (period_key='90d' AND period_days=90)),
 UNIQUE(binding_id,configuration_revision,subject_key,epoch,counter),
 FOREIGN KEY(producer_id,binding_id,configuration_revision,subject_key) REFERENCES owner_intel_google_ads_bindings(producer_id,binding_id,configuration_revision,subject_key) ON DELETE RESTRICT
);
CREATE INDEX owner_intel_google_ads_inbox_scope ON owner_intel_google_ads_inbox(binding_id,configuration_revision,period_key,accepted_at);
CREATE TABLE owner_intel_google_ads_epochs(binding_id TEXT NOT NULL,configuration_revision INTEGER NOT NULL,epoch TEXT NOT NULL,PRIMARY KEY(binding_id,configuration_revision));
CREATE TABLE owner_intel_google_ads_subject_heads(binding_id TEXT NOT NULL,configuration_revision INTEGER NOT NULL,subject_key TEXT NOT NULL,epoch TEXT NOT NULL,counter TEXT NOT NULL,operation_id TEXT NOT NULL REFERENCES owner_intel_google_ads_inbox(operation_id),PRIMARY KEY(binding_id,configuration_revision,subject_key));
CREATE TABLE owner_intel_google_ads_range_heads(binding_id TEXT NOT NULL,configuration_revision INTEGER NOT NULL,subject_key TEXT NOT NULL,period_key TEXT NOT NULL CHECK(period_key IN('status','7d','28d','90d')),operation_id TEXT NOT NULL REFERENCES owner_intel_google_ads_inbox(operation_id),PRIMARY KEY(binding_id,configuration_revision,subject_key,period_key));
CREATE TABLE owner_intel_google_ads_epoch_audit(operation_id TEXT PRIMARY KEY REFERENCES owner_intel_google_ads_inbox(operation_id),binding_id TEXT NOT NULL,configuration_revision INTEGER NOT NULL,previous_epoch TEXT,epoch TEXT NOT NULL,accepted_at TEXT NOT NULL);
CREATE TABLE owner_intel_google_ads_projections (
 projection_id TEXT PRIMARY KEY NOT NULL,
 binding_id TEXT NOT NULL,
 configuration_revision INTEGER NOT NULL,
 subject_key TEXT NOT NULL CHECK(subject_key='own:google-ads'),
 period_key TEXT NOT NULL CHECK(period_key IN('status','7d','28d','90d')),
 period_days INTEGER CHECK(period_days IS NULL OR period_days IN(7,28,90)),
 revision INTEGER NOT NULL CHECK(revision>=1),
 source_operation_id TEXT NOT NULL REFERENCES owner_intel_google_ads_inbox(operation_id),
 source_contract TEXT NOT NULL CHECK(source_contract='ops.owner-google-ads-observation.v1'),
 read_schema TEXT NOT NULL CHECK(read_schema='ops.intel.owner-google-ads.v1'),
 dto_json TEXT NOT NULL CHECK(json_valid(dto_json) AND length(CAST(dto_json AS BLOB))<=262144),
 dto_sha256 TEXT NOT NULL CHECK(length(dto_sha256)=64 AND dto_sha256 NOT GLOB '*[^0-9a-f]*'),
 accepted_at TEXT NOT NULL CHECK(julianday(accepted_at) IS NOT NULL),
 CHECK((period_key='status' AND period_days IS NULL) OR (period_key='7d' AND period_days=7) OR (period_key='28d' AND period_days=28) OR (period_key='90d' AND period_days=90)),
 FOREIGN KEY(binding_id,configuration_revision,subject_key) REFERENCES owner_intel_google_ads_bindings(binding_id,configuration_revision,subject_key) ON DELETE RESTRICT,
 UNIQUE(binding_id,configuration_revision,subject_key,period_key,revision)
);
CREATE INDEX owner_intel_google_ads_projection_read ON owner_intel_google_ads_projections(binding_id,configuration_revision,subject_key,period_key,revision DESC);
CREATE TABLE owner_intel_google_ads_batch_guards(operation_id TEXT PRIMARY KEY,assertion INTEGER NOT NULL CHECK(assertion=1));

CREATE TRIGGER owner_intel_google_ads_inbox_immutable BEFORE UPDATE ON owner_intel_google_ads_inbox BEGIN SELECT RAISE(ABORT,'owner_intel_google_ads_inbox_immutable'); END;
CREATE TRIGGER owner_intel_google_ads_inbox_retained BEFORE DELETE ON owner_intel_google_ads_inbox BEGIN SELECT RAISE(ABORT,'owner_intel_google_ads_inbox_retained'); END;
CREATE TRIGGER owner_intel_google_ads_epoch_audit_immutable BEFORE UPDATE ON owner_intel_google_ads_epoch_audit BEGIN SELECT RAISE(ABORT,'owner_intel_google_ads_epoch_audit_immutable'); END;
CREATE TRIGGER owner_intel_google_ads_epoch_audit_retained BEFORE DELETE ON owner_intel_google_ads_epoch_audit BEGIN SELECT RAISE(ABORT,'owner_intel_google_ads_epoch_audit_retained'); END;
CREATE TRIGGER owner_intel_google_ads_projection_immutable BEFORE UPDATE ON owner_intel_google_ads_projections BEGIN SELECT RAISE(ABORT,'owner_intel_google_ads_projection_immutable'); END;
CREATE TRIGGER owner_intel_google_ads_projection_retained BEFORE DELETE ON owner_intel_google_ads_projections BEGIN SELECT RAISE(ABORT,'owner_intel_google_ads_projection_retained'); END;

-- A single operation ID is unique across the three independently versioned
-- observation lanes. Inserts on either old lane remain unchanged unless an ID
-- actually collides with an immutable Ads event.
CREATE TRIGGER owner_intel_google_ads_no_v1_operation BEFORE INSERT ON owner_intel_google_ads_inbox
WHEN EXISTS(SELECT 1 FROM ci_ingest_inbox WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'intel_operation_id_cross_lane_conflict'); END;
CREATE TRIGGER owner_intel_v1_no_google_ads_operation BEFORE INSERT ON ci_ingest_inbox
WHEN EXISTS(SELECT 1 FROM owner_intel_google_ads_inbox WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'intel_operation_id_cross_lane_conflict'); END;
CREATE TRIGGER owner_intel_google_ads_no_source_operation BEFORE INSERT ON owner_intel_google_ads_inbox
WHEN EXISTS(SELECT 1 FROM owner_intel_source_inbox WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'intel_operation_id_cross_lane_conflict'); END;
CREATE TRIGGER owner_intel_source_no_google_ads_operation BEFORE INSERT ON owner_intel_source_inbox
WHEN EXISTS(SELECT 1 FROM owner_intel_google_ads_inbox WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'intel_operation_id_cross_lane_conflict'); END;
CREATE TRIGGER owner_intel_google_ads_inbox_subject_key BEFORE INSERT ON owner_intel_google_ads_inbox
WHEN NOT EXISTS(SELECT 1 FROM owner_intel_google_ads_bindings b JOIN owner_intel_bindings m ON m.binding_id=b.binding_id AND m.configuration_revision=b.configuration_revision JOIN owner_intel_businesses x ON x.business_id=m.business_id
 WHERE b.producer_id=NEW.producer_id AND b.binding_id=NEW.binding_id AND b.configuration_revision=NEW.configuration_revision AND b.subject_key=NEW.subject_key AND b.active=1 AND m.status='reviewed' AND x.status='reviewed')
BEGIN SELECT RAISE(ABORT,'owner_intel_google_ads_binding_not_current'); END;
