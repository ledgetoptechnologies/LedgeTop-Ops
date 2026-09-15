PRAGMA foreign_keys = ON;

-- Two bounded keyset checkpoints only. Candidate discovery is not mail authority;
-- the existing fanout/claim/attempt writes recheck current eligibility.
CREATE TABLE client_onboarding_notification_scan_checkpoints (
  phase TEXT NOT NULL PRIMARY KEY CHECK(phase IN ('fanout','delivery')),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  last_submission_id TEXT NOT NULL DEFAULT '' CHECK(last_submission_id='' OR (
    length(last_submission_id)=36 AND length(replace(last_submission_id,'-',''))=32
    AND last_submission_id=lower(last_submission_id) AND last_submission_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(last_submission_id,9,1)='-' AND substr(last_submission_id,14,1)='-'
    AND substr(last_submission_id,15,1)='4' AND substr(last_submission_id,19,1)='-'
    AND substr(last_submission_id,20,1) IN ('8','9','a','b') AND substr(last_submission_id,24,1)='-')),
  last_staff_id TEXT NOT NULL DEFAULT '' CHECK(last_staff_id='' OR (
    length(last_staff_id) BETWEEN 1 AND 191
    AND substr(last_staff_id,1,1) GLOB '[A-Za-z0-9]'
    AND last_staff_id NOT GLOB '*[^A-Za-z0-9:._-]*')),
  CHECK((phase='fanout' AND last_staff_id='') OR
    (phase='delivery' AND ((last_submission_id='')=(last_staff_id=''))))
);
INSERT INTO client_onboarding_notification_scan_checkpoints
  (phase,revision,last_submission_id,last_staff_id)
VALUES ('fanout',1,'',''),('delivery',1,'','');
CREATE TRIGGER client_onboarding_notification_scan_checkpoint_guard
BEFORE UPDATE ON client_onboarding_notification_scan_checkpoints
WHEN NEW.phase IS NOT OLD.phase OR NEW.revision<>OLD.revision+1
BEGIN SELECT RAISE(ABORT,'notification scan checkpoint is versioned'); END;
CREATE TRIGGER client_onboarding_notification_scan_checkpoint_no_delete
BEFORE DELETE ON client_onboarding_notification_scan_checkpoints
BEGIN SELECT RAISE(ABORT,'notification scan checkpoint is durable'); END;
