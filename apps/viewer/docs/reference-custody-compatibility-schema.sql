-- DESIGN PREVIEW ONLY. Not a migration, not allocated, not executed at startup.
-- Do not relax these gates without a separately reviewed successor schema and
-- independent storage/authority qualification. No SQL row proves custody.
CREATE TABLE custody_candidate_intents (
  intent_id TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES processing_attempts(id),
  dataset_id TEXT NOT NULL REFERENCES datasets(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  idempotency_sha256 TEXT NOT NULL UNIQUE CHECK(length(idempotency_sha256)=64 AND idempotency_sha256 NOT GLOB '*[^0-9a-f]*'),
  object_count INTEGER NOT NULL CHECK(object_count BETWEEN 1 AND 20001),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0)
);
CREATE TABLE custody_candidate_objects (
  intent_id TEXT NOT NULL REFERENCES custody_candidate_intents(intent_id),
  file_id TEXT NOT NULL REFERENCES dataset_files(id),
  relative_path TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size>=0),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  selection TEXT NOT NULL CHECK(selection IN ('selected','retained_excluded')),
  PRIMARY KEY(intent_id,file_id), UNIQUE(intent_id,relative_path)
);
CREATE TABLE custody_candidate_authority_evidence (
  intent_id TEXT PRIMARY KEY NOT NULL REFERENCES custody_candidate_intents(intent_id),
  authority_id TEXT NOT NULL,
  authority_epoch TEXT NOT NULL,
  volume_identity TEXT NOT NULL,
  retained_view_identity TEXT NOT NULL,
  hold_identity TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>=0)
);
CREATE TABLE custody_candidate_outbox (
  intent_id TEXT PRIMARY KEY NOT NULL REFERENCES custody_candidate_intents(intent_id),
  canonical_body BLOB NOT NULL CHECK(typeof(canonical_body)='blob' AND length(canonical_body) BETWEEN 1 AND 16384),
  body_sha256 TEXT NOT NULL CHECK(length(body_sha256)=64 AND body_sha256 NOT GLOB '*[^0-9a-f]*'),
  signature BLOB,
  state TEXT NOT NULL CHECK(state IN ('committed','signed')),
  key_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  CHECK((state='committed' AND signature IS NULL) OR (state='signed' AND typeof(signature)='blob' AND length(signature)=64))
);
CREATE TRIGGER custody_candidate_intents_disabled BEFORE INSERT ON custody_candidate_intents BEGIN SELECT RAISE(ABORT,'custody candidate disabled'); END;
CREATE TRIGGER custody_candidate_objects_disabled BEFORE INSERT ON custody_candidate_objects BEGIN SELECT RAISE(ABORT,'custody candidate disabled'); END;
CREATE TRIGGER custody_candidate_evidence_disabled BEFORE INSERT ON custody_candidate_authority_evidence BEGIN SELECT RAISE(ABORT,'custody candidate disabled'); END;
CREATE TRIGGER custody_candidate_outbox_disabled BEFORE INSERT ON custody_candidate_outbox BEGIN SELECT RAISE(ABORT,'custody candidate disabled'); END;
CREATE TRIGGER custody_candidate_intents_no_update BEFORE UPDATE ON custody_candidate_intents BEGIN SELECT RAISE(ABORT,'custody candidate immutable'); END;
CREATE TRIGGER custody_candidate_intents_no_delete BEFORE DELETE ON custody_candidate_intents BEGIN SELECT RAISE(ABORT,'custody candidate retained'); END;
CREATE TRIGGER custody_candidate_objects_no_update BEFORE UPDATE ON custody_candidate_objects BEGIN SELECT RAISE(ABORT,'custody candidate immutable'); END;
CREATE TRIGGER custody_candidate_objects_no_delete BEFORE DELETE ON custody_candidate_objects BEGIN SELECT RAISE(ABORT,'custody candidate retained'); END;
CREATE TRIGGER custody_candidate_evidence_no_update BEFORE UPDATE ON custody_candidate_authority_evidence BEGIN SELECT RAISE(ABORT,'custody candidate immutable'); END;
CREATE TRIGGER custody_candidate_evidence_no_delete BEFORE DELETE ON custody_candidate_authority_evidence BEGIN SELECT RAISE(ABORT,'custody candidate retained'); END;
CREATE TRIGGER custody_candidate_outbox_no_update BEFORE UPDATE ON custody_candidate_outbox BEGIN SELECT RAISE(ABORT,'custody candidate immutable'); END;
CREATE TRIGGER custody_candidate_outbox_no_delete BEFORE DELETE ON custody_candidate_outbox BEGIN SELECT RAISE(ABORT,'custody candidate retained'); END;
