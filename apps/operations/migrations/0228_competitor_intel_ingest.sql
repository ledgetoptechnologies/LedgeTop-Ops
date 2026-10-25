PRAGMA foreign_keys=ON;
-- No producer, key, business, binding, read grant or control activation is seeded.
CREATE TABLE ci_ingest_control(singleton INTEGER PRIMARY KEY CHECK(singleton=1),enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)));
CREATE TABLE ci_ingest_producer_keys(
 producer_id TEXT NOT NULL,key_id TEXT NOT NULL,public_key TEXT NOT NULL CHECK(length(public_key)=43),
 key_revision INTEGER NOT NULL CHECK(key_revision>=1),state TEXT NOT NULL CHECK(state IN('active','previous','retired','revoked')),
 PRIMARY KEY(producer_id,key_id)
);
CREATE TABLE ci_ingest_producer_bindings(
 producer_id TEXT NOT NULL,binding_id TEXT NOT NULL REFERENCES owner_intel_bindings(binding_id) ON DELETE RESTRICT,
 configuration_revision INTEGER NOT NULL CHECK(configuration_revision>=1),active INTEGER NOT NULL CHECK(active IN(0,1)),
 PRIMARY KEY(producer_id,binding_id)
);
CREATE TABLE ci_ingest_inbox(
 operation_id TEXT PRIMARY KEY NOT NULL,producer_id TEXT NOT NULL,key_id TEXT NOT NULL,key_revision INTEGER NOT NULL,
 binding_id TEXT NOT NULL REFERENCES owner_intel_bindings(binding_id) ON DELETE RESTRICT,configuration_revision INTEGER NOT NULL,
 subject_key TEXT NOT NULL,observation_kind TEXT NOT NULL CHECK(observation_kind IN('competitor_profile','baseline_assessment','change','ad_activity','scan_run','self_assessment')),
 epoch TEXT NOT NULL,counter TEXT NOT NULL,payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=43),
 raw_body TEXT NOT NULL CHECK(json_valid(raw_body) AND length(CAST(raw_body AS BLOB))<=262144),
 observation_json TEXT NOT NULL CHECK(json_valid(observation_json) AND length(CAST(observation_json AS BLOB))<=262144),
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),accepted_at TEXT NOT NULL,outcome TEXT NOT NULL CHECK(outcome IN('accepted_head','accepted_history')),
 UNIQUE(binding_id,configuration_revision,subject_key,epoch,counter)
);
CREATE INDEX ci_ingest_scope ON ci_ingest_inbox(binding_id,configuration_revision,observation_kind,accepted_at);
CREATE TABLE ci_ingest_binding_epochs(binding_id TEXT NOT NULL,configuration_revision INTEGER NOT NULL,epoch TEXT NOT NULL,
 PRIMARY KEY(binding_id,configuration_revision));
CREATE TABLE ci_ingest_subject_heads(binding_id TEXT NOT NULL,configuration_revision INTEGER NOT NULL,subject_key TEXT NOT NULL,
 epoch TEXT NOT NULL,counter TEXT NOT NULL,operation_id TEXT NOT NULL REFERENCES ci_ingest_inbox(operation_id),
 PRIMARY KEY(binding_id,configuration_revision,subject_key));
CREATE TABLE ci_ingest_kind_heads(binding_id TEXT NOT NULL,configuration_revision INTEGER NOT NULL,subject_key TEXT NOT NULL,
 observation_kind TEXT NOT NULL,operation_id TEXT NOT NULL REFERENCES ci_ingest_inbox(operation_id),
 PRIMARY KEY(binding_id,configuration_revision,subject_key,observation_kind));
CREATE TABLE ci_ingest_epoch_audit(operation_id TEXT PRIMARY KEY REFERENCES ci_ingest_inbox(operation_id),binding_id TEXT NOT NULL,
 configuration_revision INTEGER NOT NULL,previous_epoch TEXT,epoch TEXT NOT NULL,accepted_at TEXT NOT NULL);
-- Transaction-local assertion row: any stale authority/head/projection witness
-- fails the entire batch before inbox insertion. Removed before commit.
CREATE TABLE ci_ingest_batch_guards(operation_id TEXT PRIMARY KEY,assertion INTEGER NOT NULL CHECK(assertion=1));
CREATE TRIGGER ci_ingest_inbox_immutable BEFORE UPDATE ON ci_ingest_inbox BEGIN SELECT RAISE(ABORT,'ci_inbox_immutable'); END;
CREATE TRIGGER ci_ingest_inbox_retained BEFORE DELETE ON ci_ingest_inbox BEGIN SELECT RAISE(ABORT,'ci_inbox_retained'); END;
CREATE TRIGGER ci_ingest_epoch_audit_immutable BEFORE UPDATE ON ci_ingest_epoch_audit BEGIN SELECT RAISE(ABORT,'ci_epoch_audit_immutable'); END;
CREATE TRIGGER ci_ingest_epoch_audit_retained BEFORE DELETE ON ci_ingest_epoch_audit BEGIN SELECT RAISE(ABORT,'ci_epoch_audit_retained'); END;
