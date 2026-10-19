PRAGMA foreign_keys=ON;
-- Only newly reviewed approvals opt into automatic own-client profile setup.
-- Existing decisions, delivery grants and public links are not backfilled.
CREATE TABLE client_onboarding_portal_activation_intents (
 decision_id TEXT PRIMARY KEY REFERENCES client_onboarding_decisions(decision_id),
 client_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id),
 policy TEXT NOT NULL CHECK(policy='own_client_profile_v1'),
 destinations_json TEXT NOT NULL CHECK(json_valid(destinations_json) AND json_type(destinations_json)='array'),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','active','blocked')),
 reason TEXT NOT NULL DEFAULT 'awaiting_pa' CHECK(reason IN('awaiting_pa','awaiting_portal','authority_changed','identity_changed','enrollment_required','active','activation_failed')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER client_onboarding_portal_activation_stage AFTER INSERT ON client_onboarding_decisions
WHEN NEW.outcome='approved'
BEGIN
 INSERT INTO client_onboarding_portal_activation_intents(decision_id,client_record_id,policy,destinations_json)
 SELECT NEW.decision_id,NEW.client_record_id,'own_client_profile_v1',fence.client_destinations_json
 FROM client_onboarding_decision_fences fence WHERE fence.decision_id=NEW.decision_id;
END;
CREATE TRIGGER client_onboarding_portal_activation_identity BEFORE UPDATE ON client_onboarding_portal_activation_intents
WHEN NEW.decision_id IS NOT OLD.decision_id OR NEW.client_record_id IS NOT OLD.client_record_id OR NEW.policy IS NOT OLD.policy
 OR NEW.destinations_json IS NOT OLD.destinations_json OR NEW.created_at IS NOT OLD.created_at OR NEW.version<>OLD.version+1 OR OLD.state<>'pending'
BEGIN SELECT RAISE(ABORT,'onboarding_activation_identity_changed'); END;
CREATE TRIGGER client_onboarding_portal_activation_no_delete BEFORE DELETE ON client_onboarding_portal_activation_intents
BEGIN SELECT RAISE(ABORT,'onboarding_activation_is_durable'); END;
CREATE TABLE client_onboarding_portal_activation_proofs (
 -- Reserved before issuing the template, so a crash can never leave an unmarked automatic grant.
 grant_id TEXT PRIMARY KEY,
 decision_id TEXT NOT NULL REFERENCES client_onboarding_portal_activation_intents(decision_id),
 source_id TEXT NOT NULL,record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id),
 principal_public_id TEXT NOT NULL,association_version TEXT NOT NULL CHECK(length(association_version)=64),
 binding_observation_json TEXT NOT NULL CHECK(json_valid(binding_observation_json)),
 observed_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(decision_id,source_id)
);
CREATE TRIGGER client_onboarding_portal_activation_proof_insert BEFORE INSERT ON client_onboarding_portal_activation_proofs
WHEN NOT EXISTS(SELECT 1 FROM client_onboarding_portal_activation_intents intent
 WHERE intent.decision_id=NEW.decision_id AND intent.state='pending' AND intent.client_record_id=NEW.record_id
 AND EXISTS(SELECT 1 FROM json_each(intent.destinations_json) destination WHERE json_extract(destination.value,'$.sourceId')=NEW.source_id)
 AND json_extract(NEW.binding_observation_json,'$.sourceId')=NEW.source_id
 AND json_extract(NEW.binding_observation_json,'$.clientPortalIdentity.state')='eligible'
 AND json_extract(NEW.binding_observation_json,'$.clientPortalIdentity.principalPublicId')=NEW.principal_public_id
 AND json_extract(NEW.binding_observation_json,'$.clientPortalIdentity.associationVersion')=NEW.association_version)
BEGIN SELECT RAISE(ABORT,'onboarding_activation_proof_outside_approval'); END;
CREATE TRIGGER client_onboarding_portal_activation_proof_no_update BEFORE UPDATE ON client_onboarding_portal_activation_proofs
BEGIN SELECT RAISE(ABORT,'onboarding_activation_proof_is_immutable'); END;
CREATE TRIGGER client_onboarding_portal_activation_proof_no_delete BEFORE DELETE ON client_onboarding_portal_activation_proofs
BEGIN SELECT RAISE(ABORT,'onboarding_activation_proof_is_immutable'); END;
CREATE TABLE client_onboarding_portal_activation_scan (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),after_decision_id TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1
);
INSERT INTO client_onboarding_portal_activation_scan(singleton) VALUES(1);
