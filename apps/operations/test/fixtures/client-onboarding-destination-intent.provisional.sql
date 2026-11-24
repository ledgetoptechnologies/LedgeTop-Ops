-- Provisional rehearsal. Allocate an Operations migration number before use.
ALTER TABLE client_onboarding_issuance_commands ADD COLUMN destination_intent_json TEXT;
ALTER TABLE client_onboarding_decisions ADD COLUMN destination_issuance_sha256 TEXT;

CREATE TRIGGER client_onboarding_destination_intent_exact
BEFORE INSERT ON client_onboarding_issuance_commands
WHEN NEW.destination_intent_json IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'invalid onboarding destination intent')
  WHERE json_valid(NEW.destination_intent_json) <> 1;
  SELECT RAISE(ABORT,'invalid onboarding destination count')
  WHERE json_type(NEW.destination_intent_json) <> 'array'
    OR json_array_length(NEW.destination_intent_json) NOT BETWEEN 1 AND 2
    OR NEW.scopes_json IS NULL
    OR json_array_length(NEW.scopes_json) <> json_array_length(NEW.destination_intent_json);
  SELECT RAISE(ABORT,'onboarding destination scope mismatch')
  WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.destination_intent_json) intent
    WHERE intent.type <> 'object'
      OR (SELECT count(*) FROM json_each(intent.value)) <> 3
      OR coalesce(json_extract(intent.value,'$.sourceId'),'') NOT IN ('project-alpha:primary','project-alpha:secondary')
      OR coalesce(json_type(intent.value,'$.businessAreaId'),'') <> 'text'
      OR coalesce(json_type(intent.value,'$.divisionId'),'') <> 'text'
      OR NOT EXISTS (
        SELECT 1 FROM json_each(NEW.scopes_json) scope
        WHERE json_extract(scope.value,'$.businessAreaId') = json_extract(intent.value,'$.businessAreaId')
          AND json_extract(scope.value,'$.divisionId') = json_extract(intent.value,'$.divisionId')
      )
  ) OR (SELECT count(DISTINCT json_extract(value,'$.sourceId')) FROM json_each(NEW.destination_intent_json))
    <> json_array_length(NEW.destination_intent_json)
    OR (SELECT count(DISTINCT json_extract(value,'$.divisionId')) FROM json_each(NEW.destination_intent_json))
    <> json_array_length(NEW.destination_intent_json);
END;

CREATE TRIGGER client_onboarding_destination_approval_exact
BEFORE INSERT ON client_onboarding_decisions
WHEN NEW.outcome = 'approved'
BEGIN
  SELECT RAISE(ABORT,'onboarding destination approval requires exact issuance')
  WHERE NEW.destination_issuance_sha256 IS NOT (
    SELECT request_sha256 FROM client_onboarding_issuance_commands
    WHERE invitation_id = NEW.invitation_id AND destination_intent_json IS NOT NULL
  );
END;
