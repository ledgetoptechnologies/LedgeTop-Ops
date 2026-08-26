-- Explicit Operations presentation links only. No source, portal, identity,
-- billing, or resource authority is copied or changed by this migration.
CREATE TABLE business_parties (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('organization','standalone_client')),
  display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 160 AND instr(display_name,char(0))=0),
  sort_name TEXT NOT NULL CHECK(length(sort_name) BETWEEN 1 AND 512 AND instr(sort_name,char(0))=0),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE TABLE business_party_links (
  id TEXT PRIMARY KEY NOT NULL,
  party_id TEXT NOT NULL REFERENCES business_parties(id),
  source_id TEXT NOT NULL CHECK(substr(source_id,1,14)='project-alpha:' AND length(source_id) BETWEEN 15 AND 78
    AND substr(source_id,15,1) GLOB '[a-z0-9]' AND substr(source_id,15) NOT GLOB '*[^a-z0-9_-]*' AND instr(source_id,char(0))=0),
  record_kind TEXT NOT NULL CHECK(record_kind IN ('organization','client')),
  record_id TEXT NOT NULL,
  linked_by TEXT NOT NULL,
  linked_at TEXT NOT NULL DEFAULT(datetime('now')),
  unlinked_by TEXT,
  unlinked_at TEXT,
  CHECK((unlinked_by IS NULL)=(unlinked_at IS NULL)),
  FOREIGN KEY(source_id,record_kind,record_id) REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id)
);
CREATE UNIQUE INDEX idx_business_party_active_root ON business_party_links(source_id,record_kind,record_id) WHERE unlinked_at IS NULL;
CREATE UNIQUE INDEX idx_business_party_active_source ON business_party_links(party_id,source_id) WHERE unlinked_at IS NULL;
CREATE INDEX idx_business_party_links_history ON business_party_links(party_id,linked_at,id);

CREATE TABLE business_party_mutations (
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 128),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  party_id TEXT NOT NULL REFERENCES business_parties(id),
  result_version INTEGER NOT NULL CHECK(result_version>0),
  result_status TEXT NOT NULL CHECK(result_status IN ('active','closed')),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  PRIMARY KEY(actor_id,idempotency_key)
);
CREATE TABLE business_party_events (
  id TEXT PRIMARY KEY NOT NULL,
  party_id TEXT NOT NULL REFERENCES business_parties(id),
  version INTEGER NOT NULL CHECK(version>0),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('create','add','unlink')),
  details_json TEXT NOT NULL CHECK(json_valid(details_json) AND length(CAST(details_json AS BLOB))<=65536),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  UNIQUE(party_id,version)
);
CREATE INDEX idx_business_party_events_history ON business_party_events(party_id,version DESC);
CREATE TABLE business_party_write_fences (
  party_id TEXT PRIMARY KEY NOT NULL,
  write_guard INTEGER NOT NULL CONSTRAINT business_party_current_context CHECK(write_guard=1)
);

CREATE TRIGGER business_party_insert_identity BEFORE INSERT ON business_parties
WHEN NEW.status<>'active' OR NEW.version<>1 OR EXISTS(SELECT 1 FROM business_parties WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'business party identity conflict'); END;
CREATE TRIGGER business_party_update_identity BEFORE UPDATE ON business_parties
WHEN OLD.id IS NOT NEW.id OR OLD.kind IS NOT NEW.kind OR OLD.created_by IS NOT NEW.created_by OR OLD.created_at IS NOT NEW.created_at
  OR NEW.version<>OLD.version+1 OR OLD.status='closed'
  OR (NEW.status='closed' AND EXISTS(SELECT 1 FROM business_party_links WHERE party_id=OLD.id AND unlinked_at IS NULL))
BEGIN SELECT RAISE(ABORT,'business party version or lifecycle conflict'); END;
CREATE TRIGGER business_party_no_delete BEFORE DELETE ON business_parties
BEGIN SELECT RAISE(ABORT,'business party history is persistent'); END;
CREATE TRIGGER business_party_link_insert BEFORE INSERT ON business_party_links
WHEN NEW.unlinked_at IS NOT NULL OR EXISTS(SELECT 1 FROM business_party_links WHERE id=NEW.id)
  OR NOT EXISTS(SELECT 1 FROM business_parties WHERE id=NEW.party_id AND status='active'
    AND kind=CASE NEW.record_kind WHEN 'organization' THEN 'organization' ELSE 'standalone_client' END)
  OR (SELECT count(*) FROM business_party_links WHERE party_id=NEW.party_id AND unlinked_at IS NULL)>=32
  OR EXISTS(SELECT 1 FROM business_party_links WHERE unlinked_at IS NULL
    AND ((source_id=NEW.source_id AND record_kind=NEW.record_kind AND record_id=NEW.record_id)
      OR (party_id=NEW.party_id AND source_id=NEW.source_id)))
BEGIN SELECT RAISE(ABORT,'business party link conflict'); END;
CREATE TRIGGER business_party_link_update BEFORE UPDATE ON business_party_links
WHEN OLD.id IS NOT NEW.id OR OLD.party_id IS NOT NEW.party_id OR OLD.source_id IS NOT NEW.source_id
  OR OLD.record_kind IS NOT NEW.record_kind OR OLD.record_id IS NOT NEW.record_id
  OR OLD.linked_by IS NOT NEW.linked_by OR OLD.linked_at IS NOT NEW.linked_at
  OR OLD.unlinked_at IS NOT NULL OR NEW.unlinked_at IS NULL OR NEW.unlinked_by IS NULL
BEGIN SELECT RAISE(ABORT,'business party link history is immutable'); END;
CREATE TRIGGER business_party_link_no_delete BEFORE DELETE ON business_party_links
BEGIN SELECT RAISE(ABORT,'business party link history is persistent'); END;
CREATE TRIGGER business_party_mutation_insert BEFORE INSERT ON business_party_mutations
WHEN EXISTS(SELECT 1 FROM business_party_mutations WHERE actor_id=NEW.actor_id AND idempotency_key=NEW.idempotency_key)
BEGIN SELECT RAISE(ABORT,'business party mutation is immutable'); END;
CREATE TRIGGER business_party_mutation_no_update BEFORE UPDATE ON business_party_mutations
BEGIN SELECT RAISE(ABORT,'business party mutation is immutable'); END;
CREATE TRIGGER business_party_mutation_no_delete BEFORE DELETE ON business_party_mutations
BEGIN SELECT RAISE(ABORT,'business party mutation is persistent'); END;
CREATE TRIGGER business_party_event_insert BEFORE INSERT ON business_party_events
WHEN EXISTS(SELECT 1 FROM business_party_events WHERE id=NEW.id OR (party_id=NEW.party_id AND version=NEW.version))
BEGIN SELECT RAISE(ABORT,'business party event is immutable'); END;
CREATE TRIGGER business_party_event_no_update BEFORE UPDATE ON business_party_events
BEGIN SELECT RAISE(ABORT,'business party event is immutable'); END;
CREATE TRIGGER business_party_event_no_delete BEFORE DELETE ON business_party_events
BEGIN SELECT RAISE(ABORT,'business party event is persistent'); END;
CREATE TRIGGER business_party_directory_insert AFTER INSERT ON business_parties
BEGIN UPDATE client_hub_directory_state SET revision=revision+1 WHERE id='directory'; END;
CREATE TRIGGER business_party_directory_update AFTER UPDATE ON business_parties
BEGIN UPDATE client_hub_directory_state SET revision=revision+1 WHERE id='directory'; END;
CREATE TRIGGER business_party_directory_link AFTER INSERT ON business_party_links
BEGIN UPDATE client_hub_directory_state SET revision=revision+1 WHERE id='directory'; END;
CREATE TRIGGER business_party_directory_unlink AFTER UPDATE ON business_party_links
BEGIN UPDATE client_hub_directory_state SET revision=revision+1 WHERE id='directory'; END;
-- Live root eligibility changes grouping before the next display-cache scan.
CREATE TRIGGER business_party_organization_restore AFTER INSERT ON pa_organizations
WHEN EXISTS(SELECT 1 FROM business_party_links WHERE source_id=NEW.projection_source_id
  AND record_kind='organization' AND record_id=NEW.id AND unlinked_at IS NULL)
BEGIN UPDATE client_hub_directory_state SET revision=revision+1 WHERE id='directory'; END;
CREATE TRIGGER business_party_organization_lifecycle AFTER UPDATE OF active ON pa_organizations
WHEN OLD.active IS NOT NEW.active AND EXISTS(SELECT 1 FROM business_party_links
  WHERE source_id=NEW.projection_source_id AND record_kind='organization' AND record_id=NEW.id AND unlinked_at IS NULL)
BEGIN UPDATE client_hub_directory_state SET revision=revision+1 WHERE id='directory'; END;
CREATE TRIGGER business_party_organization_delete AFTER DELETE ON pa_organizations
WHEN EXISTS(SELECT 1 FROM business_party_links WHERE source_id=OLD.projection_source_id
  AND record_kind='organization' AND record_id=OLD.id AND unlinked_at IS NULL)
BEGIN UPDATE client_hub_directory_state SET revision=revision+1 WHERE id='directory'; END;
CREATE TRIGGER business_party_client_lifecycle AFTER UPDATE OF active,organization_id ON pa_clients
WHEN (OLD.active IS NOT NEW.active OR OLD.organization_id IS NOT NEW.organization_id) AND EXISTS(SELECT 1 FROM business_party_links
  WHERE source_id=NEW.projection_source_id AND record_kind='client' AND record_id=NEW.id AND unlinked_at IS NULL)
BEGIN UPDATE client_hub_directory_state SET revision=revision+1 WHERE id='directory'; END;
CREATE TRIGGER business_party_client_restore AFTER INSERT ON pa_clients
WHEN EXISTS(SELECT 1 FROM business_party_links WHERE source_id=NEW.projection_source_id
  AND record_kind='client' AND record_id=NEW.id AND unlinked_at IS NULL)
BEGIN UPDATE client_hub_directory_state SET revision=revision+1 WHERE id='directory'; END;
CREATE TRIGGER business_party_client_delete AFTER DELETE ON pa_clients
WHEN EXISTS(SELECT 1 FROM business_party_links WHERE source_id=OLD.projection_source_id
  AND record_kind='client' AND record_id=OLD.id AND unlinked_at IS NULL)
BEGIN UPDATE client_hub_directory_state SET revision=revision+1 WHERE id='directory'; END;
