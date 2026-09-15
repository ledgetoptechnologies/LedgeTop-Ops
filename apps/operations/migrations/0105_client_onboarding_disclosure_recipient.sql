PRAGMA foreign_keys = ON;

-- A disclosure belongs to one verified recipient binding, not to every
-- identity currently linked to the same client. Existing 0104 rows remain
-- NULL and cannot authorize a read; they require an explicit new issuance.
ALTER TABLE client_onboarding_prefill_disclosures
  ADD COLUMN recipient_binding_id TEXT REFERENCES client_onboarding_recipient_identity_bindings(binding_id) ON DELETE RESTRICT;

CREATE TRIGGER client_onboarding_prefill_disclosures_recipient_guard
BEFORE INSERT ON client_onboarding_prefill_disclosures
WHEN NEW.recipient_binding_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM client_onboarding_recipient_identity_bindings binding
  WHERE binding.binding_id=NEW.recipient_binding_id
    AND binding.target_client_record_id=NEW.target_client_record_id
    AND binding.status='active'
    AND (binding.expires_at IS NULL OR binding.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)
BEGIN SELECT RAISE(ABORT,'client onboarding disclosure requires its exact active recipient'); END;
