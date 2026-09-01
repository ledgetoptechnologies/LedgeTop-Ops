-- Draft quote commands are an independent outbound authority. Pin the two
-- deploy-managed credentials to the connector revision without storing them.
ALTER TABLE pa_connector_revisions ADD COLUMN draft_quote_api_key_fingerprint TEXT
  CHECK(draft_quote_api_key_fingerprint IS NULL OR
    (length(draft_quote_api_key_fingerprint)=64 AND draft_quote_api_key_fingerprint NOT GLOB '*[^a-f0-9]*'));
ALTER TABLE pa_connector_revisions ADD COLUMN draft_quote_hmac_fingerprint TEXT
  CHECK(draft_quote_hmac_fingerprint IS NULL OR
    (length(draft_quote_hmac_fingerprint)=64 AND draft_quote_hmac_fingerprint NOT GLOB '*[^a-f0-9]*'));

-- Reservations outlive rotation, suspension, and retirement. The ownership
-- fingerprint deliberately has no purpose domain so the same underlying
-- secret cannot cross from API-key to HMAC use under another source.
CREATE TABLE pa_connector_draft_quote_credentials (
  ownership_fingerprint TEXT PRIMARY KEY NOT NULL CHECK(length(ownership_fingerprint)=64
    AND ownership_fingerprint NOT GLOB '*[^a-f0-9]*'),
  purpose_fingerprint TEXT NOT NULL UNIQUE CHECK(length(purpose_fingerprint)=64
    AND purpose_fingerprint NOT GLOB '*[^a-f0-9]*'),
  source_id TEXT NOT NULL CHECK(substr(source_id,1,14)='project-alpha:'),
  purpose TEXT NOT NULL CHECK(purpose IN ('api_key','hmac')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(purpose_fingerprint,source_id,purpose)
);

CREATE TRIGGER pa_connector_revision_draft_quote_pair
BEFORE INSERT ON pa_connector_revisions
WHEN (NEW.draft_quote_api_key_fingerprint IS NULL)<>(NEW.draft_quote_hmac_fingerprint IS NULL)
  OR (NEW.draft_quote_api_key_fingerprint IS NOT NULL
    AND NEW.draft_quote_api_key_fingerprint=NEW.draft_quote_hmac_fingerprint)
  OR (NEW.draft_quote_api_key_fingerprint IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM pa_connector_draft_quote_credentials credential
    WHERE credential.purpose_fingerprint=NEW.draft_quote_api_key_fingerprint
      AND credential.source_id=NEW.source_id AND credential.purpose='api_key'))
  OR (NEW.draft_quote_hmac_fingerprint IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM pa_connector_draft_quote_credentials credential
    WHERE credential.purpose_fingerprint=NEW.draft_quote_hmac_fingerprint
      AND credential.source_id=NEW.source_id AND credential.purpose='hmac'))
BEGIN SELECT RAISE(ABORT,'connector draft quote credential enrollment is invalid'); END;

CREATE TRIGGER pa_connector_draft_quote_credential_insert
BEFORE INSERT ON pa_connector_draft_quote_credentials
WHEN EXISTS(SELECT 1 FROM pa_connector_draft_quote_credentials credential
  WHERE credential.ownership_fingerprint=NEW.ownership_fingerprint
    OR credential.purpose_fingerprint=NEW.purpose_fingerprint)
BEGIN SELECT RAISE(ABORT,'connector draft quote credential already reserved'); END;
CREATE TRIGGER pa_connector_draft_quote_credential_no_update
BEFORE UPDATE ON pa_connector_draft_quote_credentials
BEGIN SELECT RAISE(ABORT,'connector draft quote credential ownership is immutable'); END;
CREATE TRIGGER pa_connector_draft_quote_credential_no_delete
BEFORE DELETE ON pa_connector_draft_quote_credentials
BEGIN SELECT RAISE(ABORT,'connector draft quote credential ownership is persistent'); END;
