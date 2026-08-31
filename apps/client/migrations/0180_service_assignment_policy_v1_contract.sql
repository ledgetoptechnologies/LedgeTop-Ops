PRAGMA foreign_keys = ON;

-- Contract step, applied only after v2-aware code is deployed and every old
-- writer is drained. Historical v1 evidence stays readable and rows carrying
-- it may still receive unrelated updates. New, replaced, or restored v1 proof
-- values are rejected; clearing a historical proof remains possible.
CREATE TRIGGER client_service_request_drafts_legacy_policy_insert_guard
BEFORE INSERT ON client_service_request_drafts
WHEN NEW.service_assignment_policy_json IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'legacy-service-assignment-policy-proof-disabled');
END;

CREATE TRIGGER client_service_request_drafts_legacy_policy_update_guard
BEFORE UPDATE ON client_service_request_drafts
WHEN NEW.service_assignment_policy_json IS NOT NULL
  AND NEW.service_assignment_policy_json IS NOT OLD.service_assignment_policy_json
BEGIN
  SELECT RAISE(ABORT,'legacy-service-assignment-policy-proof-disabled');
END;

CREATE TRIGGER client_service_requests_legacy_policy_insert_guard
BEFORE INSERT ON client_service_requests
WHEN NEW.service_assignment_policy_json IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'legacy-service-assignment-policy-proof-disabled');
END;

CREATE TRIGGER client_service_requests_legacy_policy_update_guard
BEFORE UPDATE ON client_service_requests
WHEN NEW.service_assignment_policy_json IS NOT NULL
  AND NEW.service_assignment_policy_json IS NOT OLD.service_assignment_policy_json
BEGIN
  SELECT RAISE(ABORT,'legacy-service-assignment-policy-proof-disabled');
END;
