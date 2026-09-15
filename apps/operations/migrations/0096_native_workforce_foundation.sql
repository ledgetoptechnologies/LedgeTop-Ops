PRAGMA foreign_keys = ON;

-- This is an Operations-local, inactive ledger foundation.  It creates no
-- authority, route, PA command, financial calculation, or project/job mapping.
-- A project/job context is descriptive until a later native authority contract
-- resolves and authorizes it.
CREATE TABLE native_workforce_time_entries (
  entry_id TEXT NOT NULL PRIMARY KEY CHECK(length(entry_id) BETWEEN 1 AND 191 AND instr(entry_id,char(0))=0),
  beneficiary_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  recorded_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  recorded_by_access_subject TEXT NOT NULL CHECK(length(recorded_by_access_subject) BETWEEN 1 AND 191 AND instr(recorded_by_access_subject,char(0))=0),
  current_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(current_revision)='integer' AND current_revision>=0 AND current_revision<9007199254740991),
  workflow_status TEXT NOT NULL DEFAULT 'draft' CHECK(workflow_status IN ('draft','submitted','reviewed','returned')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((current_revision=0 AND workflow_status='draft') OR current_revision>0)
);

CREATE TABLE native_workforce_time_revisions (
  entry_id TEXT NOT NULL REFERENCES native_workforce_time_entries(entry_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740990),
  work_date TEXT NOT NULL CHECK(length(work_date)=10 AND date(work_date)=work_date),
  duration_minutes INTEGER NOT NULL CHECK(typeof(duration_minutes)='integer' AND duration_minutes BETWEEN 1 AND 1440),
  context_kind TEXT NOT NULL CHECK(context_kind IN ('internal','project','job')),
  context_id TEXT CHECK(context_id IS NULL OR (length(context_id) BETWEEN 1 AND 191 AND context_id=trim(context_id) AND instr(context_id,char(0))=0)),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description)<=4000 AND instr(description,char(0))=0),
  change_reason TEXT NOT NULL CHECK(length(change_reason) BETWEEN 1 AND 500 AND change_reason=trim(change_reason) AND instr(change_reason,char(0))=0),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(entry_id,revision),
  CHECK((context_kind='internal' AND context_id IS NULL) OR (context_kind IN ('project','job') AND context_id IS NOT NULL))
);

CREATE TABLE native_workforce_time_submissions (
  entry_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  submitted_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  submitted_by_access_subject TEXT NOT NULL CHECK(length(submitted_by_access_subject) BETWEEN 1 AND 191 AND instr(submitted_by_access_subject,char(0))=0),
  attested_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(entry_id,revision),
  FOREIGN KEY(entry_id,revision) REFERENCES native_workforce_time_revisions(entry_id,revision) ON DELETE RESTRICT
);

CREATE TABLE native_workforce_time_reviews (
  review_id TEXT NOT NULL PRIMARY KEY CHECK(length(review_id) BETWEEN 1 AND 191 AND instr(review_id,char(0))=0),
  entry_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  reviewer_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  reviewer_access_subject TEXT NOT NULL CHECK(length(reviewer_access_subject) BETWEEN 1 AND 191 AND instr(reviewer_access_subject,char(0))=0),
  decision TEXT NOT NULL CHECK(decision IN ('approved','returned')),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500 AND reason=trim(reason) AND instr(reason,char(0))=0),
  reviewed_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(entry_id,revision) REFERENCES native_workforce_time_submissions(entry_id,revision) ON DELETE RESTRICT,
  UNIQUE(entry_id,revision)
);

CREATE TABLE native_workforce_bonus_adjustments (
  adjustment_id TEXT NOT NULL PRIMARY KEY CHECK(length(adjustment_id) BETWEEN 1 AND 191 AND instr(adjustment_id,char(0))=0),
  beneficiary_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  recorded_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  recorded_by_access_subject TEXT NOT NULL CHECK(length(recorded_by_access_subject) BETWEEN 1 AND 191 AND instr(recorded_by_access_subject,char(0))=0),
  current_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(current_revision)='integer' AND current_revision>=0 AND current_revision<9007199254740991),
  workflow_status TEXT NOT NULL DEFAULT 'draft' CHECK(workflow_status IN ('draft','submitted','reviewed','returned')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((current_revision=0 AND workflow_status='draft') OR current_revision>0)
);

CREATE TABLE native_workforce_bonus_revisions (
  adjustment_id TEXT NOT NULL REFERENCES native_workforce_bonus_adjustments(adjustment_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740990),
  amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor)='integer' AND amount_minor BETWEEN 1 AND 9007199254740991),
  currency TEXT NOT NULL CHECK(length(currency)=3 AND currency=upper(currency) AND currency NOT GLOB '*[^A-Z]*'),
  context_kind TEXT NOT NULL CHECK(context_kind IN ('internal','project','job')),
  context_id TEXT CHECK(context_id IS NULL OR (length(context_id) BETWEEN 1 AND 191 AND context_id=trim(context_id) AND instr(context_id,char(0))=0)),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500 AND reason=trim(reason) AND instr(reason,char(0))=0),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(adjustment_id,revision),
  CHECK((context_kind='internal' AND context_id IS NULL) OR (context_kind IN ('project','job') AND context_id IS NOT NULL))
);

CREATE TABLE native_workforce_bonus_submissions (
  adjustment_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  submitted_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  submitted_by_access_subject TEXT NOT NULL CHECK(length(submitted_by_access_subject) BETWEEN 1 AND 191 AND instr(submitted_by_access_subject,char(0))=0),
  attested_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(adjustment_id,revision),
  FOREIGN KEY(adjustment_id,revision) REFERENCES native_workforce_bonus_revisions(adjustment_id,revision) ON DELETE RESTRICT
);

CREATE TABLE native_workforce_bonus_reviews (
  review_id TEXT NOT NULL PRIMARY KEY CHECK(length(review_id) BETWEEN 1 AND 191 AND instr(review_id,char(0))=0),
  adjustment_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  reviewer_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  reviewer_access_subject TEXT NOT NULL CHECK(length(reviewer_access_subject) BETWEEN 1 AND 191 AND instr(reviewer_access_subject,char(0))=0),
  decision TEXT NOT NULL CHECK(decision IN ('approved','returned')),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500 AND reason=trim(reason) AND instr(reason,char(0))=0),
  reviewed_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(adjustment_id,revision) REFERENCES native_workforce_bonus_submissions(adjustment_id,revision) ON DELETE RESTRICT,
  UNIQUE(adjustment_id,revision)
);

-- This is intentionally not an execution receipt. No route can insert it and
-- no transaction currently links one of these rows to a mutation fence.
CREATE TABLE native_workforce_commands (
  command_id TEXT NOT NULL PRIMARY KEY CHECK(length(command_id) BETWEEN 1 AND 191 AND instr(command_id,char(0))=0),
  command_kind TEXT NOT NULL CHECK(command_kind IN ('time.record','time.submit','time.review','bonus.record','bonus.submit','bonus.review')),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL CHECK(length(actor_access_subject) BETWEEN 1 AND 191 AND instr(actor_access_subject,char(0))=0),
  resource_kind TEXT NOT NULL CHECK(resource_kind IN ('time_entry','bonus_adjustment')),
  resource_id TEXT NOT NULL CHECK(length(resource_id) BETWEEN 1 AND 191 AND instr(resource_id,char(0))=0),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((command_kind GLOB 'time.*' AND resource_kind='time_entry') OR (command_kind GLOB 'bonus.*' AND resource_kind='bonus_adjustment'))
);

CREATE TRIGGER native_workforce_time_entry_insert_guard BEFORE INSERT ON native_workforce_time_entries
WHEN NOT EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=NEW.beneficiary_staff_id AND active=1)
  OR NOT EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=NEW.recorded_by_staff_id AND active=1 AND bound_access_subject=NEW.recorded_by_access_subject)
BEGIN SELECT RAISE(ABORT,'native workforce time identity is inactive'); END;
CREATE TRIGGER native_workforce_time_entry_update_guard BEFORE UPDATE ON native_workforce_time_entries
WHEN NEW.entry_id IS NOT OLD.entry_id OR NEW.beneficiary_staff_id IS NOT OLD.beneficiary_staff_id
  OR NEW.recorded_by_staff_id IS NOT OLD.recorded_by_staff_id OR NEW.recorded_by_access_subject IS NOT OLD.recorded_by_access_subject
  OR NEW.created_at IS NOT OLD.created_at OR NOT (
    (NEW.current_revision=OLD.current_revision+1 AND NEW.workflow_status='draft'
      AND EXISTS(SELECT 1 FROM native_workforce_time_revisions WHERE entry_id=OLD.entry_id AND revision=NEW.current_revision))
    OR (NEW.current_revision=OLD.current_revision AND OLD.workflow_status='draft' AND NEW.workflow_status='submitted'
      AND EXISTS(SELECT 1 FROM native_workforce_time_submissions WHERE entry_id=OLD.entry_id AND revision=NEW.current_revision))
    OR (NEW.current_revision=OLD.current_revision AND OLD.workflow_status='submitted'
      AND NEW.workflow_status IN ('reviewed','returned') AND EXISTS(SELECT 1 FROM native_workforce_time_reviews
        WHERE entry_id=OLD.entry_id AND revision=NEW.current_revision
          AND ((decision='approved' AND NEW.workflow_status='reviewed') OR (decision='returned' AND NEW.workflow_status='returned'))))
  )
BEGIN SELECT RAISE(ABORT,'native workforce time entry is revisioned'); END;
CREATE TRIGGER native_workforce_time_entry_no_delete BEFORE DELETE ON native_workforce_time_entries
BEGIN SELECT RAISE(ABORT,'native workforce time entry is durable'); END;
CREATE TRIGGER native_workforce_time_revision_insert_guard BEFORE INSERT ON native_workforce_time_revisions
WHEN NOT EXISTS(SELECT 1 FROM native_workforce_time_entries WHERE entry_id=NEW.entry_id AND current_revision=NEW.revision-1)
BEGIN SELECT RAISE(ABORT,'native workforce time revision is not next'); END;
CREATE TRIGGER native_workforce_time_revision_no_update BEFORE UPDATE ON native_workforce_time_revisions
BEGIN SELECT RAISE(ABORT,'native workforce time revision is immutable'); END;
CREATE TRIGGER native_workforce_time_revision_no_delete BEFORE DELETE ON native_workforce_time_revisions
BEGIN SELECT RAISE(ABORT,'native workforce time revision is durable'); END;
CREATE TRIGGER native_workforce_time_revision_advance AFTER INSERT ON native_workforce_time_revisions
BEGIN UPDATE native_workforce_time_entries SET current_revision=NEW.revision,workflow_status='draft' WHERE entry_id=NEW.entry_id; END;
CREATE TRIGGER native_workforce_time_submission_insert_guard BEFORE INSERT ON native_workforce_time_submissions
WHEN NOT EXISTS(SELECT 1 FROM native_workforce_time_entries WHERE entry_id=NEW.entry_id AND current_revision=NEW.revision AND workflow_status='draft' AND beneficiary_staff_id=NEW.submitted_by_staff_id)
  OR NOT EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=NEW.submitted_by_staff_id AND active=1 AND bound_access_subject=NEW.submitted_by_access_subject)
BEGIN SELECT RAISE(ABORT,'native workforce time submission is invalid'); END;
CREATE TRIGGER native_workforce_time_submission_no_update BEFORE UPDATE ON native_workforce_time_submissions
BEGIN SELECT RAISE(ABORT,'native workforce time submission is immutable'); END;
CREATE TRIGGER native_workforce_time_submission_no_delete BEFORE DELETE ON native_workforce_time_submissions
BEGIN SELECT RAISE(ABORT,'native workforce time submission is durable'); END;
CREATE TRIGGER native_workforce_time_submission_advance AFTER INSERT ON native_workforce_time_submissions
BEGIN UPDATE native_workforce_time_entries SET workflow_status='submitted' WHERE entry_id=NEW.entry_id AND current_revision=NEW.revision; END;
CREATE TRIGGER native_workforce_time_review_insert_guard BEFORE INSERT ON native_workforce_time_reviews
WHEN NOT EXISTS(SELECT 1 FROM native_workforce_time_entries WHERE entry_id=NEW.entry_id AND current_revision=NEW.revision AND workflow_status='submitted' AND NEW.reviewer_staff_id<>beneficiary_staff_id)
  OR NOT EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=NEW.reviewer_staff_id AND active=1 AND bound_access_subject=NEW.reviewer_access_subject)
BEGIN SELECT RAISE(ABORT,'native workforce time review is not independent'); END;
CREATE TRIGGER native_workforce_time_review_no_update BEFORE UPDATE ON native_workforce_time_reviews
BEGIN SELECT RAISE(ABORT,'native workforce time review is immutable'); END;
CREATE TRIGGER native_workforce_time_review_no_delete BEFORE DELETE ON native_workforce_time_reviews
BEGIN SELECT RAISE(ABORT,'native workforce time review is durable'); END;
CREATE TRIGGER native_workforce_time_review_approve AFTER INSERT ON native_workforce_time_reviews
WHEN NEW.decision='approved'
BEGIN UPDATE native_workforce_time_entries SET workflow_status='reviewed' WHERE entry_id=NEW.entry_id AND current_revision=NEW.revision; END;
CREATE TRIGGER native_workforce_time_review_return AFTER INSERT ON native_workforce_time_reviews
WHEN NEW.decision='returned'
BEGIN UPDATE native_workforce_time_entries SET workflow_status='returned' WHERE entry_id=NEW.entry_id AND current_revision=NEW.revision; END;

CREATE TRIGGER native_workforce_bonus_adjustment_insert_guard BEFORE INSERT ON native_workforce_bonus_adjustments
WHEN NOT EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=NEW.beneficiary_staff_id AND active=1)
  OR NOT EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=NEW.recorded_by_staff_id AND active=1 AND bound_access_subject=NEW.recorded_by_access_subject)
BEGIN SELECT RAISE(ABORT,'native workforce bonus identity is inactive'); END;
CREATE TRIGGER native_workforce_bonus_adjustment_update_guard BEFORE UPDATE ON native_workforce_bonus_adjustments
WHEN NEW.adjustment_id IS NOT OLD.adjustment_id OR NEW.beneficiary_staff_id IS NOT OLD.beneficiary_staff_id
  OR NEW.recorded_by_staff_id IS NOT OLD.recorded_by_staff_id OR NEW.recorded_by_access_subject IS NOT OLD.recorded_by_access_subject
  OR NEW.created_at IS NOT OLD.created_at OR NOT (
    (NEW.current_revision=OLD.current_revision+1 AND NEW.workflow_status='draft'
      AND EXISTS(SELECT 1 FROM native_workforce_bonus_revisions WHERE adjustment_id=OLD.adjustment_id AND revision=NEW.current_revision))
    OR (NEW.current_revision=OLD.current_revision AND OLD.workflow_status='draft' AND NEW.workflow_status='submitted'
      AND EXISTS(SELECT 1 FROM native_workforce_bonus_submissions WHERE adjustment_id=OLD.adjustment_id AND revision=NEW.current_revision))
    OR (NEW.current_revision=OLD.current_revision AND OLD.workflow_status='submitted'
      AND NEW.workflow_status IN ('reviewed','returned') AND EXISTS(SELECT 1 FROM native_workforce_bonus_reviews
        WHERE adjustment_id=OLD.adjustment_id AND revision=NEW.current_revision
          AND ((decision='approved' AND NEW.workflow_status='reviewed') OR (decision='returned' AND NEW.workflow_status='returned'))))
  )
BEGIN SELECT RAISE(ABORT,'native workforce bonus adjustment is revisioned'); END;
CREATE TRIGGER native_workforce_bonus_adjustment_no_delete BEFORE DELETE ON native_workforce_bonus_adjustments
BEGIN SELECT RAISE(ABORT,'native workforce bonus adjustment is durable'); END;
CREATE TRIGGER native_workforce_bonus_revision_insert_guard BEFORE INSERT ON native_workforce_bonus_revisions
WHEN NOT EXISTS(SELECT 1 FROM native_workforce_bonus_adjustments WHERE adjustment_id=NEW.adjustment_id AND current_revision=NEW.revision-1)
BEGIN SELECT RAISE(ABORT,'native workforce bonus revision is not next'); END;
CREATE TRIGGER native_workforce_bonus_revision_no_update BEFORE UPDATE ON native_workforce_bonus_revisions
BEGIN SELECT RAISE(ABORT,'native workforce bonus revision is immutable'); END;
CREATE TRIGGER native_workforce_bonus_revision_no_delete BEFORE DELETE ON native_workforce_bonus_revisions
BEGIN SELECT RAISE(ABORT,'native workforce bonus revision is durable'); END;
CREATE TRIGGER native_workforce_bonus_revision_advance AFTER INSERT ON native_workforce_bonus_revisions
BEGIN UPDATE native_workforce_bonus_adjustments SET current_revision=NEW.revision,workflow_status='draft' WHERE adjustment_id=NEW.adjustment_id; END;
CREATE TRIGGER native_workforce_bonus_submission_insert_guard BEFORE INSERT ON native_workforce_bonus_submissions
WHEN NOT EXISTS(SELECT 1 FROM native_workforce_bonus_adjustments WHERE adjustment_id=NEW.adjustment_id AND current_revision=NEW.revision AND workflow_status='draft'
  AND (beneficiary_staff_id=NEW.submitted_by_staff_id OR recorded_by_staff_id=NEW.submitted_by_staff_id))
  OR NOT EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=NEW.submitted_by_staff_id AND active=1 AND bound_access_subject=NEW.submitted_by_access_subject)
BEGIN SELECT RAISE(ABORT,'native workforce bonus submission is invalid'); END;
CREATE TRIGGER native_workforce_bonus_submission_no_update BEFORE UPDATE ON native_workforce_bonus_submissions
BEGIN SELECT RAISE(ABORT,'native workforce bonus submission is immutable'); END;
CREATE TRIGGER native_workforce_bonus_submission_no_delete BEFORE DELETE ON native_workforce_bonus_submissions
BEGIN SELECT RAISE(ABORT,'native workforce bonus submission is durable'); END;
CREATE TRIGGER native_workforce_bonus_submission_advance AFTER INSERT ON native_workforce_bonus_submissions
BEGIN UPDATE native_workforce_bonus_adjustments SET workflow_status='submitted' WHERE adjustment_id=NEW.adjustment_id AND current_revision=NEW.revision; END;
CREATE TRIGGER native_workforce_bonus_review_insert_guard BEFORE INSERT ON native_workforce_bonus_reviews
WHEN NOT EXISTS(SELECT 1 FROM native_workforce_bonus_adjustments WHERE adjustment_id=NEW.adjustment_id AND current_revision=NEW.revision AND workflow_status='submitted' AND NEW.reviewer_staff_id<>beneficiary_staff_id)
  OR NOT EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=NEW.reviewer_staff_id AND active=1 AND bound_access_subject=NEW.reviewer_access_subject)
BEGIN SELECT RAISE(ABORT,'native workforce bonus review is not independent'); END;
CREATE TRIGGER native_workforce_bonus_review_no_update BEFORE UPDATE ON native_workforce_bonus_reviews
BEGIN SELECT RAISE(ABORT,'native workforce bonus review is immutable'); END;
CREATE TRIGGER native_workforce_bonus_review_no_delete BEFORE DELETE ON native_workforce_bonus_reviews
BEGIN SELECT RAISE(ABORT,'native workforce bonus review is durable'); END;
CREATE TRIGGER native_workforce_bonus_review_approve AFTER INSERT ON native_workforce_bonus_reviews
WHEN NEW.decision='approved'
BEGIN UPDATE native_workforce_bonus_adjustments SET workflow_status='reviewed' WHERE adjustment_id=NEW.adjustment_id AND current_revision=NEW.revision; END;
CREATE TRIGGER native_workforce_bonus_review_return AFTER INSERT ON native_workforce_bonus_reviews
WHEN NEW.decision='returned'
BEGIN UPDATE native_workforce_bonus_adjustments SET workflow_status='returned' WHERE adjustment_id=NEW.adjustment_id AND current_revision=NEW.revision; END;

CREATE TRIGGER native_workforce_commands_insert_guard BEFORE INSERT ON native_workforce_commands
WHEN NOT EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=NEW.actor_staff_id AND active=1 AND bound_access_subject=NEW.actor_access_subject)
  OR (NEW.resource_kind='time_entry' AND NOT EXISTS(SELECT 1 FROM native_workforce_time_entries WHERE entry_id=NEW.resource_id))
  OR (NEW.resource_kind='bonus_adjustment' AND NOT EXISTS(SELECT 1 FROM native_workforce_bonus_adjustments WHERE adjustment_id=NEW.resource_id))
BEGIN SELECT RAISE(ABORT,'native workforce command is invalid'); END;
CREATE TRIGGER native_workforce_commands_no_update BEFORE UPDATE ON native_workforce_commands
BEGIN SELECT RAISE(ABORT,'native workforce command is immutable'); END;
CREATE TRIGGER native_workforce_commands_no_delete BEFORE DELETE ON native_workforce_commands
BEGIN SELECT RAISE(ABORT,'native workforce command is durable'); END;
