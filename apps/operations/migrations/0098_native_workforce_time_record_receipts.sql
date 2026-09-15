PRAGMA foreign_keys = ON;

-- A time.record receipt is deliberately separate from the generic command
-- identity row.  It binds a successful command to the immutable ledger head,
-- making a duplicate command ID a replay only when its exact request matches.
CREATE TABLE native_workforce_time_record_receipts (
  command_id TEXT NOT NULL PRIMARY KEY REFERENCES native_workforce_commands(command_id) ON DELETE RESTRICT,
  entry_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=1),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL CHECK(length(actor_access_subject) BETWEEN 1 AND 191 AND instr(actor_access_subject,char(0))=0),
  beneficiary_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(entry_id,revision) REFERENCES native_workforce_time_revisions(entry_id,revision) ON DELETE RESTRICT
);
CREATE TRIGGER native_workforce_time_record_receipt_insert_guard BEFORE INSERT ON native_workforce_time_record_receipts
WHEN NOT EXISTS(SELECT 1 FROM native_workforce_commands command
  WHERE command.command_id=NEW.command_id AND command.command_kind='time.record'
    AND command.resource_kind='time_entry' AND command.resource_id=NEW.entry_id
    AND command.request_sha256=NEW.request_sha256 AND command.actor_staff_id=NEW.actor_staff_id
    AND command.actor_access_subject=NEW.actor_access_subject)
  OR NOT EXISTS(SELECT 1 FROM native_workforce_time_entries entry
    WHERE entry.entry_id=NEW.entry_id AND entry.current_revision=NEW.revision
      AND entry.beneficiary_staff_id=NEW.beneficiary_staff_id
      AND entry.recorded_by_staff_id=NEW.actor_staff_id
      AND entry.recorded_by_access_subject=NEW.actor_access_subject)
BEGIN SELECT RAISE(ABORT,'native workforce time record receipt is invalid'); END;
CREATE TRIGGER native_workforce_time_record_receipt_no_update BEFORE UPDATE ON native_workforce_time_record_receipts
BEGIN SELECT RAISE(ABORT,'native workforce time record receipt is immutable'); END;
CREATE TRIGGER native_workforce_time_record_receipt_no_delete BEFORE DELETE ON native_workforce_time_record_receipts
BEGIN SELECT RAISE(ABORT,'native workforce time record receipt is durable'); END;
