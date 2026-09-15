PRAGMA foreign_keys = ON;

-- This history is deliberately Operations-local and inactive.  It records
-- only successful, versioned grant state transitions; it creates no grant,
-- route, or administrative authority.
CREATE TABLE native_workforce_authority_grant_changes (
  change_id TEXT NOT NULL PRIMARY KEY CHECK(length(change_id) BETWEEN 1 AND 191 AND instr(change_id,char(0))=0),
  grant_id TEXT NOT NULL REFERENCES native_workforce_authority_grants(id) ON DELETE RESTRICT,
  from_version INTEGER NOT NULL CHECK(typeof(from_version)='integer' AND from_version BETWEEN 1 AND 9007199254740990),
  to_version INTEGER NOT NULL CHECK(typeof(to_version)='integer' AND to_version=from_version+1),
  previous_active INTEGER NOT NULL CHECK(typeof(previous_active)='integer' AND previous_active IN (0,1)),
  active INTEGER NOT NULL CHECK(typeof(active)='integer' AND active IN (0,1) AND active<>previous_active),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL CHECK(length(actor_access_subject) BETWEEN 1 AND 191 AND instr(actor_access_subject,char(0))=0),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(grant_id,to_version)
);
CREATE TRIGGER native_workforce_authority_grant_changes_insert_guard BEFORE INSERT ON native_workforce_authority_grant_changes
WHEN NOT EXISTS(SELECT 1 FROM native_workforce_authority_grants grant
  JOIN native_staff_admissions actor ON actor.staff_id=NEW.actor_staff_id
  WHERE grant.id=NEW.grant_id AND grant.version=NEW.to_version AND grant.active=NEW.active
    AND grant.granted_by=NEW.actor_staff_id AND actor.active=1 AND actor.bound_access_subject=NEW.actor_access_subject)
BEGIN SELECT RAISE(ABORT,'native workforce authority grant change is invalid'); END;
CREATE TRIGGER native_workforce_authority_grant_changes_no_update BEFORE UPDATE ON native_workforce_authority_grant_changes
BEGIN SELECT RAISE(ABORT,'native workforce authority grant change is immutable'); END;
CREATE TRIGGER native_workforce_authority_grant_changes_no_delete BEFORE DELETE ON native_workforce_authority_grant_changes
BEGIN SELECT RAISE(ABORT,'native workforce authority grant change is durable'); END;

CREATE TABLE native_workforce_authority_grant_change_receipts (
  command_id TEXT NOT NULL PRIMARY KEY CHECK(length(command_id) BETWEEN 1 AND 191 AND instr(command_id,char(0))=0),
  change_id TEXT NOT NULL UNIQUE REFERENCES native_workforce_authority_grant_changes(change_id) ON DELETE RESTRICT,
  grant_id TEXT NOT NULL REFERENCES native_workforce_authority_grants(id) ON DELETE RESTRICT,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL CHECK(length(actor_access_subject) BETWEEN 1 AND 191 AND instr(actor_access_subject,char(0))=0),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER native_workforce_authority_grant_change_receipts_insert_guard BEFORE INSERT ON native_workforce_authority_grant_change_receipts
WHEN NOT EXISTS(SELECT 1 FROM native_workforce_authority_grant_changes change
  WHERE change.change_id=NEW.change_id AND change.grant_id=NEW.grant_id
    AND change.actor_staff_id=NEW.actor_staff_id AND change.actor_access_subject=NEW.actor_access_subject)
  OR NOT EXISTS(SELECT 1 FROM native_staff_admissions actor
    WHERE actor.staff_id=NEW.actor_staff_id AND actor.active=1 AND actor.bound_access_subject=NEW.actor_access_subject)
BEGIN SELECT RAISE(ABORT,'native workforce authority grant change receipt is invalid'); END;
CREATE TRIGGER native_workforce_authority_grant_change_receipts_no_update BEFORE UPDATE ON native_workforce_authority_grant_change_receipts
BEGIN SELECT RAISE(ABORT,'native workforce authority grant change receipt is immutable'); END;
CREATE TRIGGER native_workforce_authority_grant_change_receipts_no_delete BEFORE DELETE ON native_workforce_authority_grant_change_receipts
BEGIN SELECT RAISE(ABORT,'native workforce authority grant change receipt is durable'); END;
