PRAGMA foreign_keys = ON;

-- Preserve the authorization-generation fence acknowledged by Project Alpha.
-- Existing immutable receipts remain byte-for-byte legacy evidence (NULL in the
-- new columns). Every new receipt is required by the insert guards below to
-- carry the exact expected/result pair; neither value is inferred from a later
-- live read or from an irreversible response digest.
ALTER TABLE project_alpha_existing_directory_binding_acquisition_response_receipts
  ADD COLUMN expected_authorization_generation TEXT
    CHECK(expected_authorization_generation IS NULL OR (
      expected_authorization_generation GLOB '0' OR (
        expected_authorization_generation NOT GLOB '*[^0-9]*'
        AND substr(expected_authorization_generation,1,1) BETWEEN '1' AND '9'
        AND length(expected_authorization_generation) BETWEEN 1 AND 19
        AND (length(expected_authorization_generation)<19
          OR expected_authorization_generation<='9223372036854775807'))));
ALTER TABLE project_alpha_existing_directory_binding_acquisition_response_receipts
  ADD COLUMN result_authorization_generation TEXT
    CHECK(result_authorization_generation IS NULL OR (
      result_authorization_generation NOT GLOB '*[^0-9]*'
      AND substr(result_authorization_generation,1,1) BETWEEN '1' AND '9'
      AND length(result_authorization_generation) BETWEEN 1 AND 19
      AND (length(result_authorization_generation)<19
        OR result_authorization_generation<='9223372036854775807')));

CREATE TRIGGER project_alpha_existing_directory_binding_acquisition_response_generation_exact
BEFORE INSERT ON project_alpha_existing_directory_binding_acquisition_response_receipts
WHEN NEW.expected_authorization_generation IS NULL
  OR NEW.result_authorization_generation IS NULL
  OR CAST(NEW.result_authorization_generation AS INTEGER)
    <>CAST(NEW.expected_authorization_generation AS INTEGER)+1
BEGIN SELECT RAISE(ABORT,'acquisition response requires exact authorization generation advance'); END;

ALTER TABLE project_alpha_existing_directory_binding_activation_receipts
  ADD COLUMN expected_authorization_generation TEXT
    CHECK(expected_authorization_generation IS NULL OR (
      expected_authorization_generation GLOB '0' OR (
        expected_authorization_generation NOT GLOB '*[^0-9]*'
        AND substr(expected_authorization_generation,1,1) BETWEEN '1' AND '9'
        AND length(expected_authorization_generation) BETWEEN 1 AND 19
        AND (length(expected_authorization_generation)<19
          OR expected_authorization_generation<='9223372036854775807'))));
ALTER TABLE project_alpha_existing_directory_binding_activation_receipts
  ADD COLUMN result_authorization_generation TEXT
    CHECK(result_authorization_generation IS NULL OR (
      result_authorization_generation NOT GLOB '*[^0-9]*'
      AND substr(result_authorization_generation,1,1) BETWEEN '1' AND '9'
      AND length(result_authorization_generation) BETWEEN 1 AND 19
      AND (length(result_authorization_generation)<19
        OR result_authorization_generation<='9223372036854775807')));

CREATE TRIGGER project_alpha_existing_directory_binding_activation_generation_exact
BEFORE INSERT ON project_alpha_existing_directory_binding_activation_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM project_alpha_existing_directory_binding_review_evidence review
  JOIN project_alpha_existing_directory_binding_acquisition_commands command
    ON command.review_receipt_id=review.receipt_id
  JOIN project_alpha_existing_directory_binding_acquisition_response_receipts response
    ON response.command_id=command.command_id
  JOIN project_alpha_existing_directory_binding_acquired_mapping_receipts acquired
    ON acquired.command_id=command.command_id
  WHERE review.receipt_id=NEW.review_receipt_id
    AND acquired.receipt_id=NEW.acquired_receipt_id
    AND response.response_sha256=NEW.acquisition_evidence_sha256
    AND response.expected_authorization_generation=NEW.expected_authorization_generation
    AND response.result_authorization_generation=NEW.result_authorization_generation
    AND NEW.expected_authorization_generation IS NOT NULL
    AND NEW.result_authorization_generation IS NOT NULL
    AND CAST(NEW.result_authorization_generation AS INTEGER)
      =CAST(NEW.expected_authorization_generation AS INTEGER)+1
)
BEGIN SELECT RAISE(ABORT,'activation requires exact acquisition authorization generation evidence'); END;
