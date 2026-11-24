-- Unnumbered rehearsal. Apply after the destination intent fixture.
ALTER TABLE client_onboarding_issuance_commands ADD COLUMN target_intent_json TEXT;

CREATE TRIGGER client_onboarding_target_intent_exact BEFORE INSERT ON client_onboarding_issuance_commands
WHEN NEW.target_intent_json IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'invalid target intent')
  WHERE json_valid(NEW.target_intent_json)<>1;
  SELECT RAISE(ABORT,'invalid target intent')
  WHERE json_type(NEW.target_intent_json)<>'array' OR json_array_length(NEW.target_intent_json) NOT BETWEEN 1 AND 2
    OR NEW.destination_intent_json IS NULL;
  SELECT RAISE(ABORT,'invalid target intent')
  WHERE EXISTS (SELECT 1 FROM json_each(NEW.target_intent_json) target
    WHERE target.type<>'object' OR (SELECT count(*) FROM json_each(target.value))<>3
      OR coalesce(json_extract(target.value,'$.kind'),'') NOT IN ('client','organization')
      OR coalesce(json_type(target.value,'$.publicId'),'')<>'text'
      OR length(json_extract(target.value,'$.publicId'))<>32
      OR json_extract(target.value,'$.publicId') GLOB '*[^a-f0-9]*'
      OR NOT EXISTS (SELECT 1 FROM json_each(NEW.destination_intent_json) destination
        WHERE json_extract(destination.value,'$.sourceId')=json_extract(target.value,'$.sourceId'))
      OR (target.key=1 AND json_extract(target.value,'$.sourceId')<>'project-alpha:primary'))
    OR (SELECT count(DISTINCT json_extract(value,'$.sourceId')) FROM json_each(NEW.target_intent_json))<>json_array_length(NEW.target_intent_json);
END;

CREATE TABLE client_onboarding_target_proofs (
  invitation_id TEXT NOT NULL REFERENCES client_onboarding_issuance_commands(invitation_id),
  source_id TEXT NOT NULL CHECK(source_id IN ('project-alpha:primary','project-alpha:secondary')),
  issuance_sha256 TEXT NOT NULL CHECK(length(issuance_sha256)=64 AND issuance_sha256 NOT GLOB '*[^a-f0-9]*'),
  proof_json TEXT NOT NULL CHECK(length(proof_json) BETWEEN 2 AND 4096 AND json_valid(proof_json)),
  PRIMARY KEY(invitation_id,source_id)
);

CREATE TRIGGER client_onboarding_target_proof_insert_guard BEFORE INSERT ON client_onboarding_target_proofs
WHEN NOT EXISTS (SELECT 1 FROM client_onboarding_issuance_commands command
  JOIN json_each(command.target_intent_json) selected
  WHERE command.invitation_id=NEW.invitation_id AND command.request_sha256=NEW.issuance_sha256
    AND json_extract(selected.value,'$.sourceId')=NEW.source_id
    AND json_extract(NEW.proof_json,'$[1].sourceId')=NEW.source_id
    AND json_extract(selected.value,'$.kind')=json_extract(NEW.proof_json,'$[3].kind')
    AND json_extract(selected.value,'$.publicId')=json_extract(NEW.proof_json,'$[3].publicId'))
BEGIN SELECT RAISE(ABORT,'invalid target proof set'); END;

CREATE TRIGGER client_onboarding_target_proof_no_update BEFORE UPDATE ON client_onboarding_target_proofs
BEGIN SELECT RAISE(ABORT,'target proof is immutable'); END;
CREATE TRIGGER client_onboarding_target_proof_no_delete BEFORE DELETE ON client_onboarding_target_proofs
BEGIN SELECT RAISE(ABORT,'target proof is durable'); END;

CREATE TRIGGER client_onboarding_target_handoff_complete BEFORE INSERT ON client_onboarding_handoffs
WHEN EXISTS (SELECT 1 FROM client_onboarding_issuance_commands command
  WHERE command.invitation_id=NEW.invitation_id AND command.target_intent_json IS NOT NULL
    AND (command.request_sha256<>NEW.request_sha256 OR EXISTS (SELECT 1 FROM json_each(command.target_intent_json) target
      WHERE NOT EXISTS (SELECT 1 FROM client_onboarding_target_proofs proof WHERE proof.invitation_id=command.invitation_id
        AND proof.issuance_sha256=command.request_sha256 AND proof.source_id=json_extract(target.value,'$.sourceId')
        AND json_extract(proof.proof_json,'$[3].kind')=json_extract(target.value,'$.kind')
        AND json_extract(proof.proof_json,'$[3].publicId')=json_extract(target.value,'$.publicId')))
      OR EXISTS (SELECT 1 FROM client_onboarding_target_proofs proof WHERE proof.invitation_id=command.invitation_id
        AND NOT EXISTS (SELECT 1 FROM json_each(command.target_intent_json) target WHERE
          json_extract(target.value,'$.sourceId')=proof.source_id AND proof.issuance_sha256=command.request_sha256
          AND json_extract(proof.proof_json,'$[3].kind')=json_extract(target.value,'$.kind')
          AND json_extract(proof.proof_json,'$[3].publicId')=json_extract(target.value,'$.publicId')))))
BEGIN SELECT RAISE(ABORT,'incomplete target proof set'); END;

-- The existing approval writers create clients, so a marked invitation must
-- remain held until a dedicated existing-target approval protocol is reviewed.
CREATE TRIGGER client_onboarding_target_approval_held BEFORE INSERT ON client_onboarding_decisions
WHEN NEW.outcome='approved' AND EXISTS (SELECT 1 FROM client_onboarding_issuance_commands command
  WHERE command.invitation_id=NEW.invitation_id AND command.target_intent_json IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'target-aware approval unavailable'); END;
