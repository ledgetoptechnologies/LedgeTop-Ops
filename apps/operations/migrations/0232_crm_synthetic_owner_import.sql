PRAGMA foreign_keys = ON;

-- Local synthetic-only CRM import/read pilot. It does not map contacts to
-- Operations or Project Alpha clients, create principals/grants, or dispatch
-- outreach. Runtime routes remain disabled unless explicitly enabled outside
-- production.
INSERT OR IGNORE INTO permissions(key,description)
VALUES('crm.import.manage','Import and read synthetic CRM records');
INSERT OR IGNORE INTO role_permissions(role_id,permission_key)
VALUES('role-owner','crm.import.manage');

CREATE TABLE crm_import_batches (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  source_system TEXT NOT NULL CHECK(source_system='hermes-crm-fixture'),
  source_schema_version TEXT NOT NULL CHECK(source_schema_version='hermes-crm.v1'),
  dataset_kind TEXT NOT NULL CHECK(dataset_kind='synthetic'),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 128),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  contacts_inserted INTEGER NOT NULL CHECK(contacts_inserted BETWEEN 0 AND 100),
  contact_logs_inserted INTEGER NOT NULL CHECK(contact_logs_inserted BETWEEN 0 AND 100),
  followups_inserted INTEGER NOT NULL CHECK(followups_inserted BETWEEN 0 AND 100),
  interactions_inserted INTEGER NOT NULL CHECK(interactions_inserted BETWEEN 0 AND 100),
  status_history_inserted INTEGER NOT NULL CHECK(status_history_inserted BETWEEN 0 AND 100),
  state TEXT NOT NULL CHECK(state IN('committing','committed')),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB))<=2000),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(actor_id,idempotency_key),
  FOREIGN KEY(actor_id) REFERENCES staff_users(id)
);

-- Source IDs are table-local. Keeping source_table in the key prevents a
-- contact-log ID from colliding with a contact ID (or a follow-up ID).
CREATE TABLE crm_contacts (
  source_system TEXT NOT NULL CHECK(source_system='hermes-crm-fixture'),
  source_table TEXT NOT NULL CHECK(source_table='contacts'),
  source_record_id INTEGER NOT NULL CHECK(source_record_id>0),
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  import_batch_id TEXT NOT NULL,
  company_name TEXT NOT NULL,
  location TEXT,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  has_website INTEGER CHECK(has_website IN(-1,0,1)),
  website_opportunity INTEGER CHECK(website_opportunity IN(0,1)),
  status TEXT,
  contact_type TEXT,
  sport TEXT,
  priority TEXT,
  contact_method TEXT,
  notes TEXT,
  outreach_paused INTEGER CHECK(outreach_paused IN(0,1)),
  skip_auto_research INTEGER CHECK(skip_auto_research IN(0,1)),
  manual_contact_date TEXT,
  manual_contact_notes TEXT,
  legacy_cache_evidence_json TEXT CHECK(legacy_cache_evidence_json IS NULL OR (json_valid(legacy_cache_evidence_json) AND length(CAST(legacy_cache_evidence_json AS BLOB))<=32768)),
  created_at TEXT,
  updated_at TEXT,
  imported_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(source_system,source_table,source_record_id),
  FOREIGN KEY(import_batch_id) REFERENCES crm_import_batches(id)
);
CREATE INDEX crm_contacts_import_order ON crm_contacts(source_record_id);

CREATE TABLE crm_contact_logs (
  source_system TEXT NOT NULL CHECK(source_system='hermes-crm-fixture'),
  source_table TEXT NOT NULL CHECK(source_table='contact_log'),
  source_record_id INTEGER NOT NULL CHECK(source_record_id>0),
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  import_batch_id TEXT NOT NULL,
  contact_source_system TEXT,
  contact_source_table TEXT,
  contact_id INTEGER,
  log_date TEXT NOT NULL CHECK(length(log_date)=10 AND log_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  log_type TEXT NOT NULL,
  direction TEXT,
  subject TEXT,
  notes TEXT,
  source TEXT,
  account TEXT,
  external_message_id TEXT,
  external_draft_id TEXT,
  external_thread_id TEXT,
  channel TEXT,
  outcome TEXT,
  occurred_at TEXT,
  matched_email TEXT,
  participant_role TEXT,
  idempotency_key TEXT,
  effects_mode TEXT,
  created_at TEXT,
  imported_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(source_system,source_table,source_record_id),
  CHECK(log_type IS NOT NULL),
  CHECK((contact_id IS NULL AND contact_source_system IS NULL AND contact_source_table IS NULL)
     OR (contact_id IS NOT NULL AND contact_source_system='hermes-crm-fixture' AND contact_source_table='contacts')),
  FOREIGN KEY(import_batch_id) REFERENCES crm_import_batches(id),
  FOREIGN KEY(contact_source_system,contact_source_table,contact_id)
    REFERENCES crm_contacts(source_system,source_table,source_record_id)
);
CREATE INDEX crm_contact_logs_contact_order ON crm_contact_logs(contact_id,log_date,source_record_id);
CREATE UNIQUE INDEX crm_contact_logs_gmail_message_identity
ON crm_contact_logs(account,external_message_id,log_type,contact_id)
WHERE source='gmail' AND account IS NOT NULL AND external_message_id IS NOT NULL;
CREATE UNIQUE INDEX crm_contact_logs_gmail_draft_identity
ON crm_contact_logs(account,external_draft_id,log_type,contact_id)
WHERE source='gmail' AND account IS NOT NULL AND external_draft_id IS NOT NULL;
CREATE UNIQUE INDEX crm_contact_logs_manual_idempotency
ON crm_contact_logs(contact_id,idempotency_key)
WHERE source='manual' AND idempotency_key IS NOT NULL;

CREATE TABLE crm_followups (
  source_system TEXT NOT NULL CHECK(source_system='hermes-crm-fixture'),
  source_table TEXT NOT NULL CHECK(source_table='followups'),
  source_record_id INTEGER NOT NULL CHECK(source_record_id>0),
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  import_batch_id TEXT NOT NULL,
  contact_source_system TEXT,
  contact_source_table TEXT,
  contact_id INTEGER,
  follow_up_date TEXT CHECK(follow_up_date IS NULL OR length(follow_up_date) BETWEEN 10 AND 80),
  method TEXT,
  notes TEXT,
  completed INTEGER CHECK(completed IN(0,1)),
  source TEXT,
  action_kind TEXT,
  responsibility TEXT,
  origin_source_system TEXT,
  origin_source_table TEXT,
  origin_event_id INTEGER,
  completed_at TEXT,
  completion_reason TEXT,
  created_at TEXT,
  updated_at TEXT,
  imported_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(source_system,source_table,source_record_id),
  CHECK((contact_id IS NULL AND contact_source_system IS NULL AND contact_source_table IS NULL)
     OR (contact_id IS NOT NULL AND contact_source_system='hermes-crm-fixture' AND contact_source_table='contacts')),
  CHECK((origin_event_id IS NULL AND origin_source_system IS NULL AND origin_source_table IS NULL)
     OR (origin_event_id IS NOT NULL AND origin_source_system='hermes-crm-fixture' AND origin_source_table='contact_log')),
  FOREIGN KEY(import_batch_id) REFERENCES crm_import_batches(id),
  FOREIGN KEY(contact_source_system,contact_source_table,contact_id)
    REFERENCES crm_contacts(source_system,source_table,source_record_id),
  FOREIGN KEY(origin_source_system,origin_source_table,origin_event_id)
    REFERENCES crm_contact_logs(source_system,source_table,source_record_id)
);
CREATE INDEX crm_followups_contact_order ON crm_followups(contact_id,follow_up_date,source_record_id);
CREATE UNIQUE INDEX crm_followups_event_action_identity ON crm_followups(origin_event_id,action_kind)
WHERE origin_event_id IS NOT NULL;

-- These legacy collections are preserved under their own table-qualified IDs.
-- They are not translated into contact_log events or replayed as behavior.
CREATE TABLE crm_interactions (
  source_system TEXT NOT NULL CHECK(source_system='hermes-crm-fixture'),
  source_table TEXT NOT NULL CHECK(source_table='interactions'),
  source_record_id INTEGER NOT NULL CHECK(source_record_id>0),
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  import_batch_id TEXT NOT NULL,
  contact_source_system TEXT,
  contact_source_table TEXT,
  contact_id INTEGER,
  interaction_date TEXT CHECK(interaction_date IS NULL OR length(interaction_date) BETWEEN 10 AND 80),
  type TEXT,
  notes TEXT,
  imported_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(source_system,source_table,source_record_id),
  CHECK((contact_id IS NULL AND contact_source_system IS NULL AND contact_source_table IS NULL)
     OR (contact_id IS NOT NULL AND contact_source_system='hermes-crm-fixture' AND contact_source_table='contacts')),
  FOREIGN KEY(import_batch_id) REFERENCES crm_import_batches(id),
  FOREIGN KEY(contact_source_system,contact_source_table,contact_id)
    REFERENCES crm_contacts(source_system,source_table,source_record_id)
);
CREATE INDEX crm_interactions_contact_order ON crm_interactions(contact_id,interaction_date,source_record_id);

CREATE TABLE crm_status_history (
  source_system TEXT NOT NULL CHECK(source_system='hermes-crm-fixture'),
  source_table TEXT NOT NULL CHECK(source_table='status_history'),
  source_record_id INTEGER NOT NULL CHECK(source_record_id>0),
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  import_batch_id TEXT NOT NULL,
  contact_source_system TEXT,
  contact_source_table TEXT,
  contact_id INTEGER,
  old_status TEXT,
  new_status TEXT NOT NULL,
  changed_at TEXT,
  changed_by TEXT,
  notes TEXT,
  imported_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(source_system,source_table,source_record_id),
  CHECK(new_status IS NOT NULL),
  CHECK((contact_id IS NULL AND contact_source_system IS NULL AND contact_source_table IS NULL)
     OR (contact_id IS NOT NULL AND contact_source_system='hermes-crm-fixture' AND contact_source_table='contacts')),
  FOREIGN KEY(import_batch_id) REFERENCES crm_import_batches(id),
  FOREIGN KEY(contact_source_system,contact_source_table,contact_id)
    REFERENCES crm_contacts(source_system,source_table,source_record_id)
);
CREATE INDEX crm_status_history_contact_order ON crm_status_history(contact_id,source_record_id);

-- A batch starts only for an active global Owner with the explicit permission
-- and no applicable deny. Admin overrides cannot substitute for the Owner role.
CREATE TRIGGER crm_import_batches_owner_guard BEFORE INSERT ON crm_import_batches
WHEN NOT EXISTS(
  SELECT 1 FROM staff_users actor
  JOIN staff_role_assignments owner_role ON owner_role.staff_id=actor.id
    AND owner_role.role_id='role-owner' AND owner_role.scope='global'
  JOIN role_permissions permission ON permission.role_id=owner_role.role_id
    AND permission.permission_key='crm.import.manage'
  WHERE actor.id=NEW.actor_id AND actor.status='active'
    AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides deny
      WHERE deny.staff_id=actor.id AND deny.permission_key='crm.import.manage' AND deny.effect='deny')
)
BEGIN SELECT RAISE(ABORT,'crm_import_owner_required'); END;

CREATE TRIGGER crm_import_batches_commit_guard BEFORE UPDATE ON crm_import_batches
WHEN OLD.state<>'committing' OR NEW.state<>'committed'
  OR NEW.id IS NOT OLD.id OR NEW.actor_id IS NOT OLD.actor_id
  OR NEW.source_system IS NOT OLD.source_system OR NEW.source_schema_version IS NOT OLD.source_schema_version
  OR NEW.dataset_kind IS NOT OLD.dataset_kind OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.contacts_inserted IS NOT OLD.contacts_inserted
  OR NEW.contact_logs_inserted IS NOT OLD.contact_logs_inserted OR NEW.followups_inserted IS NOT OLD.followups_inserted
  OR NEW.interactions_inserted IS NOT OLD.interactions_inserted OR NEW.status_history_inserted IS NOT OLD.status_history_inserted
  OR NEW.receipt_json IS NOT OLD.receipt_json OR NEW.created_at IS NOT OLD.created_at
  OR NEW.actor_id NOT IN(SELECT actor.id FROM staff_users actor JOIN staff_role_assignments owner_role
    ON owner_role.staff_id=actor.id AND owner_role.role_id='role-owner' AND owner_role.scope='global'
    JOIN role_permissions permission ON permission.role_id=owner_role.role_id
      AND permission.permission_key='crm.import.manage'
    WHERE actor.status='active' AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides deny
      WHERE deny.staff_id=actor.id AND deny.permission_key='crm.import.manage' AND deny.effect='deny'))
  OR (SELECT COUNT(*) FROM crm_contacts WHERE import_batch_id=OLD.id)<>OLD.contacts_inserted
  OR (SELECT COUNT(*) FROM crm_contact_logs WHERE import_batch_id=OLD.id)<>OLD.contact_logs_inserted
  OR (SELECT COUNT(*) FROM crm_followups WHERE import_batch_id=OLD.id)<>OLD.followups_inserted
  OR (SELECT COUNT(*) FROM crm_interactions WHERE import_batch_id=OLD.id)<>OLD.interactions_inserted
  OR (SELECT COUNT(*) FROM crm_status_history WHERE import_batch_id=OLD.id)<>OLD.status_history_inserted
BEGIN SELECT RAISE(ABORT,'crm_import_batch_commit_invalid'); END;

CREATE TRIGGER crm_import_batches_no_delete BEFORE DELETE ON crm_import_batches
BEGIN SELECT RAISE(ABORT,'crm_import_batches_retained'); END;
CREATE TRIGGER crm_import_contacts_write_guard BEFORE INSERT ON crm_contacts
WHEN NOT EXISTS(SELECT 1 FROM crm_import_batches batch JOIN staff_users actor ON actor.id=batch.actor_id
  JOIN staff_role_assignments owner_role ON owner_role.staff_id=actor.id AND owner_role.role_id='role-owner' AND owner_role.scope='global'
  JOIN role_permissions permission ON permission.role_id=owner_role.role_id AND permission.permission_key='crm.import.manage'
  WHERE batch.id=NEW.import_batch_id AND batch.state='committing' AND actor.status='active'
    AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides deny WHERE deny.staff_id=actor.id AND deny.permission_key='crm.import.manage' AND deny.effect='deny'))
BEGIN SELECT RAISE(ABORT,'crm_import_owner_required'); END;
CREATE TRIGGER crm_import_contact_logs_write_guard BEFORE INSERT ON crm_contact_logs
WHEN NOT EXISTS(SELECT 1 FROM crm_import_batches batch JOIN staff_users actor ON actor.id=batch.actor_id
  JOIN staff_role_assignments owner_role ON owner_role.staff_id=actor.id AND owner_role.role_id='role-owner' AND owner_role.scope='global'
  JOIN role_permissions permission ON permission.role_id=owner_role.role_id AND permission.permission_key='crm.import.manage'
  WHERE batch.id=NEW.import_batch_id AND batch.state='committing' AND actor.status='active'
    AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides deny WHERE deny.staff_id=actor.id AND deny.permission_key='crm.import.manage' AND deny.effect='deny'))
BEGIN SELECT RAISE(ABORT,'crm_import_owner_required'); END;
CREATE TRIGGER crm_import_followups_write_guard BEFORE INSERT ON crm_followups
WHEN NOT EXISTS(SELECT 1 FROM crm_import_batches batch JOIN staff_users actor ON actor.id=batch.actor_id
  JOIN staff_role_assignments owner_role ON owner_role.staff_id=actor.id AND owner_role.role_id='role-owner' AND owner_role.scope='global'
  JOIN role_permissions permission ON permission.role_id=owner_role.role_id AND permission.permission_key='crm.import.manage'
  WHERE batch.id=NEW.import_batch_id AND batch.state='committing' AND actor.status='active'
    AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides deny WHERE deny.staff_id=actor.id AND deny.permission_key='crm.import.manage' AND deny.effect='deny'))
BEGIN SELECT RAISE(ABORT,'crm_import_owner_required'); END;
CREATE TRIGGER crm_followups_origin_contact_guard BEFORE INSERT ON crm_followups
WHEN NEW.origin_event_id IS NOT NULL AND NEW.contact_id IS NOT NULL AND EXISTS(
  SELECT 1 FROM crm_contact_logs origin WHERE origin.source_system=NEW.origin_source_system
    AND origin.source_table=NEW.origin_source_table AND origin.source_record_id=NEW.origin_event_id
    AND origin.contact_id IS NOT NULL AND origin.contact_id<>NEW.contact_id)
BEGIN SELECT RAISE(ABORT,'crm_origin_contact_mismatch'); END;
CREATE TRIGGER crm_import_interactions_write_guard BEFORE INSERT ON crm_interactions
WHEN NOT EXISTS(SELECT 1 FROM crm_import_batches batch JOIN staff_users actor ON actor.id=batch.actor_id
  JOIN staff_role_assignments owner_role ON owner_role.staff_id=actor.id AND owner_role.role_id='role-owner' AND owner_role.scope='global'
  JOIN role_permissions permission ON permission.role_id=owner_role.role_id AND permission.permission_key='crm.import.manage'
  WHERE batch.id=NEW.import_batch_id AND batch.state='committing' AND actor.status='active'
    AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides deny WHERE deny.staff_id=actor.id AND deny.permission_key='crm.import.manage' AND deny.effect='deny'))
BEGIN SELECT RAISE(ABORT,'crm_import_owner_required'); END;
CREATE TRIGGER crm_import_status_history_write_guard BEFORE INSERT ON crm_status_history
WHEN NOT EXISTS(SELECT 1 FROM crm_import_batches batch JOIN staff_users actor ON actor.id=batch.actor_id
  JOIN staff_role_assignments owner_role ON owner_role.staff_id=actor.id AND owner_role.role_id='role-owner' AND owner_role.scope='global'
  JOIN role_permissions permission ON permission.role_id=owner_role.role_id AND permission.permission_key='crm.import.manage'
  WHERE batch.id=NEW.import_batch_id AND batch.state='committing' AND actor.status='active'
    AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides deny WHERE deny.staff_id=actor.id AND deny.permission_key='crm.import.manage' AND deny.effect='deny'))
BEGIN SELECT RAISE(ABORT,'crm_import_owner_required'); END;

CREATE TRIGGER crm_import_contacts_immutable_update BEFORE UPDATE ON crm_contacts
BEGIN SELECT RAISE(ABORT,'crm_import_contacts_immutable'); END;
CREATE TRIGGER crm_import_contacts_immutable_delete BEFORE DELETE ON crm_contacts
BEGIN SELECT RAISE(ABORT,'crm_import_contacts_retained'); END;
CREATE TRIGGER crm_import_contact_logs_immutable_update BEFORE UPDATE ON crm_contact_logs
BEGIN SELECT RAISE(ABORT,'crm_import_contact_logs_immutable'); END;
CREATE TRIGGER crm_import_contact_logs_immutable_delete BEFORE DELETE ON crm_contact_logs
BEGIN SELECT RAISE(ABORT,'crm_import_contact_logs_retained'); END;
CREATE TRIGGER crm_import_followups_immutable_update BEFORE UPDATE ON crm_followups
BEGIN SELECT RAISE(ABORT,'crm_import_followups_immutable'); END;
CREATE TRIGGER crm_import_followups_immutable_delete BEFORE DELETE ON crm_followups
BEGIN SELECT RAISE(ABORT,'crm_import_followups_retained'); END;
CREATE TRIGGER crm_import_interactions_immutable_update BEFORE UPDATE ON crm_interactions
BEGIN SELECT RAISE(ABORT,'crm_import_interactions_immutable'); END;
CREATE TRIGGER crm_import_interactions_immutable_delete BEFORE DELETE ON crm_interactions
BEGIN SELECT RAISE(ABORT,'crm_import_interactions_retained'); END;
CREATE TRIGGER crm_import_status_history_immutable_update BEFORE UPDATE ON crm_status_history
BEGIN SELECT RAISE(ABORT,'crm_import_status_history_immutable'); END;
CREATE TRIGGER crm_import_status_history_immutable_delete BEFORE DELETE ON crm_status_history
BEGIN SELECT RAISE(ABORT,'crm_import_status_history_retained'); END;
