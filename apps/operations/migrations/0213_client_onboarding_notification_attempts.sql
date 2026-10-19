-- Bounded transport attempts. Existing recipient identity and lease guards stay
-- authoritative; no historical event is backfilled and no mail is sent here.
ALTER TABLE client_onboarding_review_notification_recipients
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK(typeof(attempt_count)='integer' AND attempt_count BETWEEN 0 AND 3);
CREATE TRIGGER client_onboarding_notification_attempt_guard
BEFORE UPDATE ON client_onboarding_review_notification_recipients
WHEN NEW.attempt_count < OLD.attempt_count OR NEW.attempt_count > OLD.attempt_count + 1
  OR (NEW.attempt_count <> OLD.attempt_count AND
    (OLD.state <> 'leased' OR NEW.state <> 'leased' OR OLD.attempted_at IS NOT NULL OR NEW.attempted_at IS NULL))
BEGIN SELECT RAISE(ABORT,'notification attempts require a leased dispatch'); END;
