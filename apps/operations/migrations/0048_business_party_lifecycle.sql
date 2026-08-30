-- Recoverable lifecycle for the existing Operations presentation umbrella.
-- The compatible storage status remains active/closed; lifecycle_state is the
-- public active/archived vocabulary. Parties and links never grant access.
DROP TRIGGER business_party_update_identity;
DROP TRIGGER business_party_link_insert;

ALTER TABLE business_parties ADD COLUMN lifecycle_origin TEXT NOT NULL DEFAULT 'source_backed'
  CHECK(lifecycle_origin IN ('source_backed','operations'));
ALTER TABLE business_parties ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active'
  CHECK(lifecycle_state IN ('active','archived'));
ALTER TABLE business_parties ADD COLUMN lifecycle_cause TEXT NOT NULL DEFAULT 'created'
  CHECK(lifecycle_cause IN ('created','source_unavailable','operator_closed','exact_source_return','reviewed_relink'));
ALTER TABLE business_parties ADD COLUMN archived_at TEXT;

-- Existing link history proves source ownership. A row without link history is
-- a legitimate Operations-only party and is not source-lifecycle managed.
UPDATE business_parties
SET lifecycle_origin=CASE WHEN EXISTS(
      SELECT 1 FROM business_party_links link WHERE link.party_id=business_parties.id
    ) THEN 'source_backed' ELSE 'operations' END,
    lifecycle_state=CASE status WHEN 'closed' THEN 'archived' ELSE 'active' END,
    lifecycle_cause=CASE status WHEN 'closed' THEN 'operator_closed' ELSE 'created' END,
    archived_at=CASE status WHEN 'closed' THEN updated_at ELSE NULL END;

CREATE TABLE business_party_lifecycle_events (
  id TEXT PRIMARY KEY NOT NULL,
  party_id TEXT NOT NULL REFERENCES business_parties(id),
  party_version INTEGER NOT NULL CHECK(party_version>0),
  lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN ('active','archived')),
  cause TEXT NOT NULL CHECK(cause IN ('created','source_unavailable','operator_closed','exact_source_return','reviewed_relink')),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  UNIQUE(party_id,party_version)
);
CREATE INDEX idx_business_party_lifecycle_history
  ON business_party_lifecycle_events(party_id,party_version DESC);
CREATE TRIGGER business_party_lifecycle_event_insert BEFORE INSERT ON business_party_lifecycle_events
WHEN EXISTS(SELECT 1 FROM business_party_lifecycle_events
  WHERE id=NEW.id OR (party_id=NEW.party_id AND party_version=NEW.party_version))
BEGIN SELECT RAISE(ABORT,'business party lifecycle event is immutable'); END;
CREATE TRIGGER business_party_lifecycle_event_no_update BEFORE UPDATE ON business_party_lifecycle_events
BEGIN SELECT RAISE(ABORT,'business party lifecycle event is immutable'); END;
CREATE TRIGGER business_party_lifecycle_event_no_delete BEFORE DELETE ON business_party_lifecycle_events
BEGIN SELECT RAISE(ABORT,'business party lifecycle history is persistent'); END;
INSERT INTO business_party_lifecycle_events
  (id,party_id,party_version,lifecycle_state,cause,actor_id,created_at)
SELECT lower(hex(randomblob(16))),id,version,lifecycle_state,lifecycle_cause,updated_by,updated_at
FROM business_parties;

-- This view is presentation eligibility, not authorization. Exact immutable
-- source-qualified handles remain in business_party_links and the mapping table.
CREATE VIEW business_party_live_links AS
SELECT link.id,link.party_id,link.source_id,link.record_kind,link.record_id
FROM business_party_links link
WHERE link.unlinked_at IS NULL AND (
  (link.record_kind='organization' AND EXISTS(
    SELECT 1 FROM pa_organizations organization
    WHERE organization.projection_source_id=link.source_id
      AND organization.id=link.record_id AND organization.active=1
  )) OR
  (link.record_kind='client' AND EXISTS(
    SELECT 1 FROM pa_clients client
    WHERE client.projection_source_id=link.source_id AND client.id=link.record_id
      AND client.active=1 AND client.organization_id IS NULL
  ))
);

-- A reviewed relink fence exists only inside one atomic mutation batch. It is
-- removed before commit and cannot confer application access.
CREATE TABLE business_party_relink_fences (
  party_id TEXT PRIMARY KEY NOT NULL REFERENCES business_parties(id),
  source_id TEXT NOT NULL,
  record_kind TEXT NOT NULL CHECK(record_kind IN ('organization','client')),
  record_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  write_guard INTEGER NOT NULL CHECK(write_guard=1),
  FOREIGN KEY(source_id,record_kind,record_id)
    REFERENCES pa_projection_record_ids(projection_source_id,record_kind,local_id)
);
CREATE TRIGGER business_party_relink_fence_no_update BEFORE UPDATE ON business_party_relink_fences
BEGIN SELECT RAISE(ABORT,'business party relink fence is immutable'); END;

-- Exact source return reopens only source-loss archives. Operator closure needs
-- an exact reviewed relink fence plus a newly live source-qualified link.
CREATE TRIGGER business_party_update_identity BEFORE UPDATE ON business_parties
WHEN OLD.id IS NOT NEW.id OR OLD.kind IS NOT NEW.kind OR OLD.created_by IS NOT NEW.created_by
  OR OLD.created_at IS NOT NEW.created_at OR OLD.lifecycle_origin IS NOT NEW.lifecycle_origin
  OR NEW.version<>OLD.version+1
  OR (NEW.lifecycle_state='active' AND (NEW.status<>'active' OR NEW.archived_at IS NOT NULL
      OR NEW.lifecycle_cause NOT IN ('created','exact_source_return','reviewed_relink')))
  OR (NEW.lifecycle_state='archived' AND (NEW.status<>'closed' OR NEW.archived_at IS NULL
      OR NEW.lifecycle_cause NOT IN ('source_unavailable','operator_closed')))
  OR (OLD.lifecycle_state='active' AND NEW.lifecycle_state='active'
      AND OLD.lifecycle_cause IS NOT NEW.lifecycle_cause)
  OR (OLD.lifecycle_state='active' AND NEW.lifecycle_state='archived' AND (
      NEW.lifecycle_origin<>'source_backed'
      OR (NEW.lifecycle_cause='operator_closed' AND EXISTS(
        SELECT 1 FROM business_party_links link WHERE link.party_id=OLD.id AND link.unlinked_at IS NULL
      ))
      OR (NEW.lifecycle_cause='source_unavailable' AND EXISTS(
        SELECT 1 FROM business_party_live_links live WHERE live.party_id=OLD.id
      ))
    ))
  OR (OLD.lifecycle_state='archived' AND NEW.lifecycle_state='archived'
      AND OLD.lifecycle_cause IS NOT NEW.lifecycle_cause
      AND NOT (NEW.lifecycle_cause='operator_closed' AND NOT EXISTS(
        SELECT 1 FROM business_party_links link WHERE link.party_id=OLD.id AND link.unlinked_at IS NULL
      )))
  OR (OLD.lifecycle_state='archived' AND NEW.lifecycle_state='active' AND NOT (
      (OLD.lifecycle_cause='source_unavailable' AND NEW.lifecycle_cause='exact_source_return'
        AND EXISTS(SELECT 1 FROM business_party_live_links live WHERE live.party_id=OLD.id))
      OR
      (NEW.lifecycle_cause='reviewed_relink' AND EXISTS(
        SELECT 1 FROM business_party_relink_fences fence
        JOIN business_party_live_links live ON live.party_id=fence.party_id
          AND live.source_id=fence.source_id AND live.record_kind=fence.record_kind
          AND live.record_id=fence.record_id
        WHERE fence.party_id=OLD.id AND fence.write_guard=1
      ))
    ))
BEGIN SELECT RAISE(ABORT,'business party version or lifecycle conflict'); END;

CREATE TRIGGER business_party_link_insert BEFORE INSERT ON business_party_links
WHEN NEW.unlinked_at IS NOT NULL OR EXISTS(SELECT 1 FROM business_party_links WHERE id=NEW.id)
  OR NOT EXISTS(SELECT 1 FROM business_parties party WHERE party.id=NEW.party_id
    AND party.kind=CASE NEW.record_kind WHEN 'organization' THEN 'organization' ELSE 'standalone_client' END
    AND (party.lifecycle_state='active' OR (party.lifecycle_state='archived' AND EXISTS(
      SELECT 1 FROM business_party_relink_fences fence WHERE fence.party_id=party.id
        AND fence.source_id=NEW.source_id AND fence.record_kind=NEW.record_kind
        AND fence.record_id=NEW.record_id AND fence.write_guard=1
    ))))
  OR (SELECT count(*) FROM business_party_links WHERE party_id=NEW.party_id AND unlinked_at IS NULL)>=32
  OR EXISTS(SELECT 1 FROM business_party_links WHERE unlinked_at IS NULL
    AND ((source_id=NEW.source_id AND record_kind=NEW.record_kind AND record_id=NEW.record_id)
      OR (party_id=NEW.party_id AND source_id=NEW.source_id)))
BEGIN SELECT RAISE(ABORT,'business party link conflict'); END;

CREATE TRIGGER business_party_lifecycle_history AFTER UPDATE ON business_parties
WHEN OLD.lifecycle_state IS NOT NEW.lifecycle_state OR OLD.lifecycle_cause IS NOT NEW.lifecycle_cause
BEGIN
  INSERT INTO business_party_lifecycle_events
    (id,party_id,party_version,lifecycle_state,cause,actor_id)
  VALUES(lower(hex(randomblob(16))),NEW.id,NEW.version,NEW.lifecycle_state,NEW.lifecycle_cause,NEW.updated_by);
END;
CREATE TRIGGER business_party_lifecycle_history_insert AFTER INSERT ON business_parties
BEGIN
  INSERT INTO business_party_lifecycle_events
    (id,party_id,party_version,lifecycle_state,cause,actor_id)
  VALUES(lower(hex(randomblob(16))),NEW.id,NEW.version,NEW.lifecycle_state,NEW.lifecycle_cause,NEW.created_by);
END;

-- Reconcile stale pre-upgrade source-backed parties. Operations-only rows and
-- every immutable link/history row remain unchanged.
UPDATE business_parties
SET status='closed',lifecycle_state='archived',lifecycle_cause='source_unavailable',
  archived_at=datetime('now'),version=version+1,updated_by='system:source-lifecycle',updated_at=datetime('now')
WHERE lifecycle_origin='source_backed' AND lifecycle_state='active'
  AND EXISTS(SELECT 1 FROM business_party_links link WHERE link.party_id=business_parties.id AND link.unlinked_at IS NULL)
  AND NOT EXISTS(SELECT 1 FROM business_party_live_links live WHERE live.party_id=business_parties.id);

-- Projection changes update presentation only. They never unlink a source,
-- change the immutable mapping, or create a portal/resource grant.
CREATE TRIGGER business_party_organization_archive AFTER UPDATE OF active ON pa_organizations
WHEN OLD.active IS NOT NEW.active AND NEW.active<>1
BEGIN
  UPDATE business_parties SET status='closed',lifecycle_state='archived',lifecycle_cause='source_unavailable',
    archived_at=datetime('now'),version=version+1,updated_by='system:source-lifecycle',updated_at=datetime('now')
  WHERE lifecycle_origin='source_backed' AND lifecycle_state='active'
    AND EXISTS(SELECT 1 FROM business_party_links affected WHERE affected.party_id=business_parties.id
      AND affected.source_id=NEW.projection_source_id AND affected.record_kind='organization'
      AND affected.record_id=NEW.id AND affected.unlinked_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM business_party_live_links live WHERE live.party_id=business_parties.id);
END;
CREATE TRIGGER business_party_organization_archive_delete AFTER DELETE ON pa_organizations
BEGIN
  UPDATE business_parties SET status='closed',lifecycle_state='archived',lifecycle_cause='source_unavailable',
    archived_at=datetime('now'),version=version+1,updated_by='system:source-lifecycle',updated_at=datetime('now')
  WHERE lifecycle_origin='source_backed' AND lifecycle_state='active'
    AND EXISTS(SELECT 1 FROM business_party_links affected WHERE affected.party_id=business_parties.id
      AND affected.source_id=OLD.projection_source_id AND affected.record_kind='organization'
      AND affected.record_id=OLD.id AND affected.unlinked_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM business_party_live_links live WHERE live.party_id=business_parties.id);
END;
CREATE TRIGGER business_party_organization_return_insert AFTER INSERT ON pa_organizations
WHEN NEW.active=1
BEGIN
  UPDATE business_parties SET status='active',lifecycle_state='active',lifecycle_cause='exact_source_return',
    archived_at=NULL,version=version+1,updated_by='system:source-lifecycle',updated_at=datetime('now')
  WHERE lifecycle_origin='source_backed' AND lifecycle_state='archived'
    AND lifecycle_cause='source_unavailable'
    AND EXISTS(SELECT 1 FROM business_party_links affected WHERE affected.party_id=business_parties.id
      AND affected.source_id=NEW.projection_source_id AND affected.record_kind='organization'
      AND affected.record_id=NEW.id AND affected.unlinked_at IS NULL);
END;
CREATE TRIGGER business_party_organization_return_update AFTER UPDATE OF active ON pa_organizations
WHEN OLD.active IS NOT NEW.active AND NEW.active=1
BEGIN
  UPDATE business_parties SET status='active',lifecycle_state='active',lifecycle_cause='exact_source_return',
    archived_at=NULL,version=version+1,updated_by='system:source-lifecycle',updated_at=datetime('now')
  WHERE lifecycle_origin='source_backed' AND lifecycle_state='archived'
    AND lifecycle_cause='source_unavailable'
    AND EXISTS(SELECT 1 FROM business_party_links affected WHERE affected.party_id=business_parties.id
      AND affected.source_id=NEW.projection_source_id AND affected.record_kind='organization'
      AND affected.record_id=NEW.id AND affected.unlinked_at IS NULL);
END;

CREATE TRIGGER business_party_client_state AFTER UPDATE OF active,organization_id ON pa_clients
WHEN OLD.active IS NOT NEW.active OR OLD.organization_id IS NOT NEW.organization_id
BEGIN
  UPDATE business_parties SET status='closed',lifecycle_state='archived',lifecycle_cause='source_unavailable',
    archived_at=datetime('now'),version=version+1,updated_by='system:source-lifecycle',updated_at=datetime('now')
  WHERE lifecycle_origin='source_backed' AND lifecycle_state='active'
    AND EXISTS(SELECT 1 FROM business_party_links affected WHERE affected.party_id=business_parties.id
      AND affected.source_id=NEW.projection_source_id AND affected.record_kind='client'
      AND affected.record_id=NEW.id AND affected.unlinked_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM business_party_live_links live WHERE live.party_id=business_parties.id);
  UPDATE business_parties SET status='active',lifecycle_state='active',lifecycle_cause='exact_source_return',
    archived_at=NULL,version=version+1,updated_by='system:source-lifecycle',updated_at=datetime('now')
  WHERE NEW.active=1 AND NEW.organization_id IS NULL AND lifecycle_origin='source_backed'
    AND lifecycle_state='archived' AND lifecycle_cause='source_unavailable'
    AND EXISTS(SELECT 1 FROM business_party_links affected WHERE affected.party_id=business_parties.id
      AND affected.source_id=NEW.projection_source_id AND affected.record_kind='client'
      AND affected.record_id=NEW.id AND affected.unlinked_at IS NULL);
END;
CREATE TRIGGER business_party_client_archive_delete AFTER DELETE ON pa_clients
BEGIN
  UPDATE business_parties SET status='closed',lifecycle_state='archived',lifecycle_cause='source_unavailable',
    archived_at=datetime('now'),version=version+1,updated_by='system:source-lifecycle',updated_at=datetime('now')
  WHERE lifecycle_origin='source_backed' AND lifecycle_state='active'
    AND EXISTS(SELECT 1 FROM business_party_links affected WHERE affected.party_id=business_parties.id
      AND affected.source_id=OLD.projection_source_id AND affected.record_kind='client'
      AND affected.record_id=OLD.id AND affected.unlinked_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM business_party_live_links live WHERE live.party_id=business_parties.id);
END;
CREATE TRIGGER business_party_client_return_insert AFTER INSERT ON pa_clients
WHEN NEW.active=1 AND NEW.organization_id IS NULL
BEGIN
  UPDATE business_parties SET status='active',lifecycle_state='active',lifecycle_cause='exact_source_return',
    archived_at=NULL,version=version+1,updated_by='system:source-lifecycle',updated_at=datetime('now')
  WHERE lifecycle_origin='source_backed' AND lifecycle_state='archived'
    AND lifecycle_cause='source_unavailable'
    AND EXISTS(SELECT 1 FROM business_party_links affected WHERE affected.party_id=business_parties.id
      AND affected.source_id=NEW.projection_source_id AND affected.record_kind='client'
      AND affected.record_id=NEW.id AND affected.unlinked_at IS NULL);
END;
