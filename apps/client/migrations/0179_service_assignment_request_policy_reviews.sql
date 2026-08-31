PRAGMA foreign_keys = ON;

-- Receiving source-qualified assignments does not authorize using them to
-- filter Client Portal requests. Consumption is independently enabled by an
-- append-only review for that exact Project Alpha source. No rows are seeded,
-- so migration and deployment remain default-off.
CREATE TABLE pa_service_assignment_request_policy_reviews (
  source_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  review_id TEXT NOT NULL UNIQUE CHECK(length(review_id) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK(state IN ('enabled','suspended')),
  reviewed_by_type TEXT NOT NULL CHECK(reviewed_by_type IN ('staff','system')),
  reviewed_by_id TEXT NOT NULL CHECK(length(reviewed_by_id) BETWEEN 1 AND 256),
  review_reference TEXT NOT NULL CHECK(length(review_reference) BETWEEN 1 AND 256),
  rationale TEXT NOT NULL CHECK(length(trim(rationale)) BETWEEN 1 AND 1000),
  reviewed_at TEXT NOT NULL CHECK(datetime(reviewed_at) IS NOT NULL),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  PRIMARY KEY(source_id,revision),
  FOREIGN KEY(source_id) REFERENCES pa_service_assignment_receiver_grants(source_id) ON DELETE RESTRICT,
  CHECK(length(source_id) BETWEEN 15 AND 78
    AND substr(source_id,1,14)='project-alpha:' AND substr(source_id,15,1) GLOB '[a-z0-9]'
    AND substr(source_id,15) NOT GLOB '*[^a-z0-9_-]*' AND instr(source_id,char(0))=0)
);

CREATE INDEX idx_pa_service_assignment_request_policy_latest
  ON pa_service_assignment_request_policy_reviews(source_id,revision DESC,state);

CREATE TRIGGER pa_service_assignment_request_policy_review_sequence
BEFORE INSERT ON pa_service_assignment_request_policy_reviews
WHEN NEW.revision<>COALESCE((SELECT MAX(revision)+1
  FROM pa_service_assignment_request_policy_reviews WHERE source_id=NEW.source_id),1)
BEGIN SELECT RAISE(ABORT,'service-assignment-request-policy-review-conflict'); END;

CREATE TRIGGER pa_service_assignment_request_policy_enable_guard
BEFORE INSERT ON pa_service_assignment_request_policy_reviews
WHEN NEW.state='enabled' AND (
  NOT EXISTS(SELECT 1 FROM pa_service_assignment_receiver_grants receiver
    WHERE receiver.source_id=NEW.source_id
      AND receiver.capability='portal.service-assignments.publish'
      AND receiver.contract_version=1 AND receiver.state='active')
  OR NOT EXISTS(SELECT 1 FROM pa_service_assignment_receiver_workspaces enrollment
    WHERE enrollment.source_id=NEW.source_id AND enrollment.state='active')
  OR NOT EXISTS(SELECT 1 FROM pa_service_assignment_source_capabilities capability
    WHERE capability.source_id=NEW.source_id AND capability.contract_version=1
      AND capability.state='supported')
  OR (NEW.source_id<>'project-alpha:primary' AND NOT EXISTS(
    SELECT 1 FROM pa_portal_source_authorities authority
    JOIN pa_portal_source_authority_revisions authority_revision
      ON authority_revision.source_id=authority.source_id
      AND authority_revision.revision=authority.active_revision
    WHERE authority.source_id=NEW.source_id AND authority.state='active'))
)
BEGIN SELECT RAISE(ABORT,'service-assignment-request-policy-source-not-ready'); END;

CREATE TRIGGER pa_service_assignment_request_policy_review_no_update
BEFORE UPDATE ON pa_service_assignment_request_policy_reviews
BEGIN SELECT RAISE(ABORT,'service-assignment-request-policy-review-immutable'); END;

CREATE TRIGGER pa_service_assignment_request_policy_review_no_delete
BEFORE DELETE ON pa_service_assignment_request_policy_reviews
BEGIN SELECT RAISE(ABORT,'service-assignment-request-policy-review-immutable'); END;
