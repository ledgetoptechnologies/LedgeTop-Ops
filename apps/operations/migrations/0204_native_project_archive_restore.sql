-- Separate native lifecycle ledger. Historical command enums and receipts remain unchanged.
PRAGMA foreign_keys=ON;
CREATE TABLE native_project_lifecycle_commands (
 command_id TEXT PRIMARY KEY REFERENCES native_project_command_proofs(command_id) ON DELETE RESTRICT,
 external_project_id TEXT NOT NULL REFERENCES operations_shared_projects(external_project_id) ON DELETE RESTRICT,
 action TEXT NOT NULL CHECK(action IN ('archive','restore')),
 source_id TEXT NOT NULL,source_instance_id TEXT NOT NULL,application_id TEXT NOT NULL,history_epoch_id TEXT NOT NULL,
 destination_origin TEXT NOT NULL,project_alpha_public_id TEXT NOT NULL CHECK(length(project_alpha_public_id)=32),
 context_json TEXT NOT NULL CHECK(json_valid(context_json)),context_sha256 TEXT NOT NULL CHECK(length(context_sha256)=64),
 body TEXT NOT NULL CHECK(json_valid(body) AND json_type(body)='object' AND json_type(body,'$.commandId')='text' AND json_extract(body,'$.commandId')=command_id),
 request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
 expected_local_version INTEGER NOT NULL CHECK(expected_local_version>=1),expected_projection_sha256 TEXT NOT NULL CHECK(length(expected_projection_sha256)=64),
 expected_pa_revision TEXT NOT NULL,prior_head_json TEXT NOT NULL CHECK(json_valid(prior_head_json)),
 state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','sending','uncertain','acknowledged','settled','activating','activated','rejected','inbound_review')),
 transmission_count INTEGER NOT NULL DEFAULT 0 CHECK(transmission_count>=0),lease_token TEXT,lease_expires_at INTEGER,active_authorization_id TEXT,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),expires_at TEXT NOT NULL,
 CHECK(expires_at>created_at),CHECK((state IN ('sending','activating'))=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX native_project_lifecycle_one_unresolved ON native_project_lifecycle_commands(external_project_id) WHERE state NOT IN ('activated','rejected','inbound_review');
CREATE TABLE native_project_lifecycle_authorizations (
 authorization_id TEXT PRIMARY KEY,command_id TEXT NOT NULL REFERENCES native_project_lifecycle_commands(command_id) ON DELETE RESTRICT,
 proof_command_id TEXT NOT NULL REFERENCES native_project_command_proofs(command_id) ON DELETE RESTRICT,
 purpose TEXT NOT NULL CHECK(purpose IN ('send','reconcile','refresh','refresh_reconcile','activate','abandon','abandon_refresh','inbound_review')),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(command_id,authorization_id)
);
CREATE TABLE native_project_lifecycle_events (
 event_id TEXT PRIMARY KEY,command_id TEXT NOT NULL REFERENCES native_project_lifecycle_commands(command_id) ON DELETE RESTRICT,
 phase TEXT NOT NULL,request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),safe_code TEXT,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE native_project_lifecycle_receipts (
 command_id TEXT PRIMARY KEY REFERENCES native_project_lifecycle_commands(command_id) ON DELETE RESTRICT,
 response_json TEXT NOT NULL CHECK(json_valid(response_json)),response_sha256 TEXT NOT NULL CHECK(length(response_sha256)=64),
 project_alpha_revision TEXT NOT NULL,request_id TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE native_project_lifecycle_refreshes (
 command_id TEXT PRIMARY KEY REFERENCES native_project_command_proofs(command_id) ON DELETE RESTRICT,
 parent_command_id TEXT NOT NULL REFERENCES native_project_lifecycle_commands(command_id) ON DELETE RESTRICT,
 body TEXT NOT NULL CHECK(json_valid(body)),request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
 expected_revision TEXT NOT NULL,expected_projection_sha256 TEXT NOT NULL CHECK(length(expected_projection_sha256)=64),
 state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','sending','uncertain','acknowledged','rejected')),
 transmission_count INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_expires_at INTEGER,active_authorization_id TEXT,
 expires_at TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 CHECK(expires_at>created_at),CHECK((state='sending')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE TABLE native_project_lifecycle_refresh_receipts (
 command_id TEXT PRIMARY KEY REFERENCES native_project_lifecycle_refreshes(command_id) ON DELETE RESTRICT,
 response_json TEXT NOT NULL CHECK(json_valid(response_json)),response_sha256 TEXT NOT NULL CHECK(length(response_sha256)=64),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- A durable final-edge marker means the underlying POST may have begun.
-- Claims without such a marker are known unsent and may be explicitly released.
CREATE TABLE native_project_lifecycle_post_attempts (
 lease_token TEXT PRIMARY KEY,parent_command_id TEXT NOT NULL REFERENCES native_project_lifecycle_commands(command_id) ON DELETE RESTRICT,
 refresh_command_id TEXT REFERENCES native_project_lifecycle_refreshes(command_id) ON DELETE RESTRICT,
 request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE native_project_lifecycle_settlements (
 settlement_id TEXT PRIMARY KEY,command_id TEXT NOT NULL UNIQUE REFERENCES native_project_lifecycle_receipts(command_id) ON DELETE RESTRICT,
 refresh_command_id TEXT NOT NULL REFERENCES native_project_lifecycle_refresh_receipts(command_id) ON DELETE RESTRICT,
 proof_command_id TEXT NOT NULL REFERENCES native_project_command_proofs(command_id) ON DELETE RESTRICT,
 read_json TEXT NOT NULL CHECK(json_valid(read_json)),read_sha256 TEXT NOT NULL CHECK(length(read_sha256)=64),
 binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),binding_sha256 TEXT NOT NULL CHECK(length(binding_sha256)=64),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE native_project_lifecycle_activation_fences (
 command_id TEXT PRIMARY KEY REFERENCES native_project_lifecycle_commands(command_id) ON DELETE RESTRICT,
 settlement_id TEXT NOT NULL UNIQUE REFERENCES native_project_lifecycle_settlements(settlement_id) ON DELETE RESTRICT,
 proof_command_id TEXT NOT NULL REFERENCES native_project_command_proofs(command_id) ON DELETE RESTRICT,
 expires_at TEXT NOT NULL
);
CREATE TABLE native_project_lifecycle_activations (
 command_id TEXT PRIMARY KEY REFERENCES native_project_lifecycle_commands(command_id) ON DELETE RESTRICT,
 settlement_id TEXT NOT NULL UNIQUE REFERENCES native_project_lifecycle_settlements(settlement_id) ON DELETE RESTRICT,
 resulting_local_version INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE operations_shared_project_revisions ADD COLUMN lifecycle_settlement_id TEXT REFERENCES native_project_lifecycle_settlements(settlement_id) ON DELETE RESTRICT;
-- A known applied action may be superseded by an authentic newer PA edit.
-- Handoff never activates it locally or authorizes another remote write.
CREATE TABLE native_project_lifecycle_inbound_handoffs (
 command_id TEXT PRIMARY KEY REFERENCES native_project_lifecycle_receipts(command_id) ON DELETE RESTRICT,
 authorization_id TEXT NOT NULL REFERENCES native_project_lifecycle_authorizations(authorization_id) ON DELETE RESTRICT,
 read_json TEXT NOT NULL CHECK(json_valid(read_json)),read_sha256 TEXT NOT NULL CHECK(length(read_sha256)=64),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE VIEW native_project_lifecycle_pending_handoffs AS
SELECT c.command_id,c.external_project_id FROM native_project_lifecycle_commands c
JOIN native_project_lifecycle_inbound_handoffs handoff ON handoff.command_id=c.command_id
WHERE c.state='inbound_review' AND NOT EXISTS(
 SELECT 1 FROM project_alpha_project_inbound_resolution_receipts receipt
 JOIN project_alpha_project_inbound_proposals proposal ON proposal.proposal_id=receipt.proposal_id
 JOIN project_alpha_project_inbound_resolution_authorizations reviewed ON reviewed.resolution_id=receipt.resolution_id AND reviewed.proposal_id=proposal.proposal_id
 JOIN operations_shared_project_revisions history ON history.external_project_id=c.external_project_id AND history.version=receipt.resulting_local_version AND history.inbound_resolution_id=receipt.resolution_id
 JOIN operations_shared_projects head ON head.external_project_id=c.external_project_id
 WHERE receipt.decision='accept_project_alpha' AND reviewed.decision='accept_project_alpha'
 AND proposal.external_project_id=c.external_project_id AND proposal.source_id=c.source_id AND proposal.source_instance_id=c.source_instance_id
 AND proposal.application_id=c.application_id AND proposal.history_epoch_id=c.history_epoch_id AND proposal.project_alpha_public_id=c.project_alpha_public_id
 AND proposal.expected_local_version=c.expected_local_version AND proposal.expected_local_projection_sha256=c.expected_projection_sha256
 AND receipt.prior_local_version=c.expected_local_version AND receipt.resulting_local_version=c.expected_local_version+1
 AND history.read_json=reviewed.final_remote_snapshot_json AND head.current_version>=receipt.resulting_local_version
 AND (length(reviewed.final_remote_revision)>length(json_extract(handoff.read_json,'$.resource.revision')) OR (length(reviewed.final_remote_revision)=length(json_extract(handoff.read_json,'$.resource.revision')) AND reviewed.final_remote_revision>=json_extract(handoff.read_json,'$.resource.revision')))
);
CREATE TRIGGER native_project_lifecycle_handoff_guard BEFORE INSERT ON native_project_lifecycle_inbound_handoffs
WHEN NOT EXISTS(
 SELECT 1 FROM native_project_lifecycle_commands c
 JOIN native_project_lifecycle_receipts receipt ON receipt.command_id=c.command_id
 JOIN native_project_lifecycle_live_authorizations a ON a.authorization_id=NEW.authorization_id AND a.command_id=c.command_id AND a.purpose='inbound_review'
 JOIN operations_shared_projects head ON head.external_project_id=c.external_project_id
 WHERE c.command_id=NEW.command_id AND c.state='acknowledged'
 AND head.current_version=c.expected_local_version AND head.canonical_projection_sha256=c.expected_projection_sha256
 AND json_extract(receipt.response_json,'$.accepted')=1
 AND json_extract(NEW.read_json,'$.accepted')=1 AND json_extract(NEW.read_json,'$.apiVersion')='2'
 AND json_extract(NEW.read_json,'$.sourceInstanceId')=c.source_instance_id AND json_extract(NEW.read_json,'$.applicationId')=c.application_id
 AND json_extract(NEW.read_json,'$.historyEpoch')=c.history_epoch_id AND json_extract(NEW.read_json,'$.resource.type')='project'
 AND json_extract(NEW.read_json,'$.resource.id')=c.project_alpha_public_id
 AND (length(json_extract(NEW.read_json,'$.resource.revision'))>length(receipt.project_alpha_revision) OR (length(json_extract(NEW.read_json,'$.resource.revision'))=length(receipt.project_alpha_revision) AND json_extract(NEW.read_json,'$.resource.revision')>receipt.project_alpha_revision))
 AND NOT EXISTS(SELECT 1 FROM native_project_lifecycle_refreshes child WHERE child.parent_command_id=c.command_id AND child.state NOT IN ('acknowledged','rejected'))
 AND NOT EXISTS(SELECT 1 FROM native_project_lifecycle_activations activated WHERE activated.command_id=c.command_id)
)
BEGIN SELECT RAISE(ABORT,'inbound handoff requires known acceptance and authentic newer evidence'); END;
CREATE TRIGGER native_project_lifecycle_handoffs_no_update BEFORE UPDATE ON native_project_lifecycle_inbound_handoffs BEGIN SELECT RAISE(ABORT,'inbound handoff is immutable'); END;
CREATE TRIGGER native_project_lifecycle_handoffs_no_delete BEFORE DELETE ON native_project_lifecycle_inbound_handoffs BEGIN SELECT RAISE(ABORT,'inbound handoff is durable'); END;
CREATE TRIGGER native_project_lifecycle_handoff_canonical_guard BEFORE UPDATE ON operations_shared_projects
WHEN EXISTS(SELECT 1 FROM native_project_lifecycle_pending_handoffs pending WHERE pending.external_project_id=OLD.external_project_id)
 AND NOT EXISTS(
 SELECT 1 FROM native_project_lifecycle_pending_handoffs pending
 JOIN native_project_lifecycle_commands c ON c.command_id=pending.command_id
 JOIN native_project_lifecycle_inbound_handoffs handoff ON handoff.command_id=c.command_id
 JOIN project_alpha_project_inbound_proposals proposal ON proposal.external_project_id=c.external_project_id
 JOIN project_alpha_project_inbound_resolution_authorizations reviewed ON reviewed.proposal_id=proposal.proposal_id
 WHERE pending.external_project_id=OLD.external_project_id AND reviewed.decision='accept_project_alpha'
 AND proposal.source_id=c.source_id AND proposal.source_instance_id=c.source_instance_id AND proposal.application_id=c.application_id
 AND proposal.history_epoch_id=c.history_epoch_id AND proposal.project_alpha_public_id=c.project_alpha_public_id
 AND proposal.expected_local_version=c.expected_local_version AND OLD.current_version=c.expected_local_version AND NEW.current_version=c.expected_local_version+1
 AND proposal.expected_local_projection_sha256=c.expected_projection_sha256 AND OLD.canonical_projection_sha256=c.expected_projection_sha256
 AND NEW.pa_revision=reviewed.final_remote_revision AND NEW.canonical_projection_sha256=reviewed.final_remote_projection_sha256
 AND (length(reviewed.final_remote_revision)>length(json_extract(handoff.read_json,'$.resource.revision')) OR (length(reviewed.final_remote_revision)=length(json_extract(handoff.read_json,'$.resource.revision')) AND reviewed.final_remote_revision>=json_extract(handoff.read_json,'$.resource.revision')))
)
BEGIN SELECT RAISE(ABORT,'handed-off lifecycle requires exact reviewed inbound advancement'); END;
CREATE TRIGGER native_project_lifecycle_insert_guard AFTER INSERT ON native_project_lifecycle_commands
WHEN NOT EXISTS (
 SELECT 1 FROM native_project_live_command_proofs p
 JOIN staff_users staff ON staff.id=p.actor_staff_id AND staff.status='active' AND staff.email=p.actor_email AND staff.access_subject=p.actor_access_subject
 JOIN operations_shared_projects head ON head.external_project_id=p.external_project_id
 JOIN project_alpha_project_destinations destination ON destination.external_project_id=head.external_project_id AND destination.source_id=NEW.source_id AND destination.application_id=NEW.application_id AND destination.expected_source_instance_id=NEW.source_instance_id AND rtrim(destination.destination_base_url,'/')=NEW.destination_origin
 JOIN project_alpha_project_mappings m ON m.external_project_id=head.external_project_id
 WHERE p.command_id=NEW.command_id AND p.external_project_id=NEW.external_project_id AND p.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND head.current_version=NEW.expected_local_version AND head.canonical_projection_sha256=NEW.expected_projection_sha256
 AND head.pa_revision=NEW.expected_pa_revision AND head.archived=(NEW.action='restore')
 AND json_extract(NEW.context_json,'$.sourceId')=NEW.source_id
 AND ((json_extract(NEW.context_json,'$.rootKind')='organization' AND json_extract(NEW.context_json,'$.rootPublicId')=head.organization_record_id) OR (json_extract(NEW.context_json,'$.rootKind')='standalone_client' AND json_extract(NEW.context_json,'$.rootPublicId')=head.client_record_id AND head.organization_record_id IS NULL AND EXISTS(SELECT 1 FROM operations_directory_client_organizations relationship WHERE relationship.client_record_id=head.client_record_id AND relationship.organization_record_id IS NULL)))
 AND (SELECT count(*) FROM json_each(NEW.context_json))=4
 AND head.source_id=NEW.source_id AND head.source_instance_id=NEW.source_instance_id AND head.application_id=NEW.application_id
 AND head.history_epoch_id=NEW.history_epoch_id AND head.project_alpha_public_id=NEW.project_alpha_public_id
 AND m.source_id=NEW.source_id AND m.source_instance_id=NEW.source_instance_id AND m.application_id=NEW.application_id
 AND m.history_epoch_id=NEW.history_epoch_id AND m.project_alpha_public_id=NEW.project_alpha_public_id
 AND json(head.scopes_json)=json(p.scopes_json)
) OR EXISTS(SELECT 1 FROM project_alpha_project_outbox WHERE external_project_id=NEW.external_project_id AND state IN ('pending','leased','terminal'))
 OR EXISTS(SELECT 1 FROM client_hub_native_project_preparations WHERE external_project_id=NEW.external_project_id AND transmission_started_at IS NULL AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 OR EXISTS(SELECT 1 FROM project_alpha_project_inbound_proposals proposal WHERE proposal.external_project_id=NEW.external_project_id
 AND NOT EXISTS(SELECT 1 FROM project_alpha_project_inbound_resolution_receipts done WHERE done.proposal_id=proposal.proposal_id)
 AND (proposal.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') OR EXISTS(SELECT 1 FROM project_alpha_project_inbound_resolution_authorizations a WHERE a.proposal_id=proposal.proposal_id AND a.decision='accept_project_alpha')))
 OR EXISTS(SELECT 1 FROM native_project_lifecycle_pending_handoffs WHERE external_project_id=NEW.external_project_id)
 OR EXISTS(SELECT 1 FROM project_alpha_project_outbox WHERE command_id=NEW.command_id)
 OR NEW.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR json_extract(NEW.body,'$.expectedRevision')<>NEW.expected_pa_revision
 OR (SELECT count(*) FROM json_each(NEW.body))<>2
BEGIN SELECT RAISE(ABORT,'native lifecycle requires exact current project authority'); END;
CREATE TRIGGER project_outbox_lifecycle_exclusion BEFORE INSERT ON project_alpha_project_outbox
WHEN EXISTS(SELECT 1 FROM native_project_lifecycle_commands WHERE external_project_id=NEW.external_project_id AND (state NOT IN ('activated','rejected','inbound_review') OR command_id IN (SELECT command_id FROM native_project_lifecycle_pending_handoffs)))
 OR EXISTS(SELECT 1 FROM native_project_lifecycle_commands WHERE command_id=NEW.command_id)
 OR EXISTS(SELECT 1 FROM native_project_lifecycle_refreshes WHERE command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'native lifecycle owns project reservation'); END;
CREATE TRIGGER project_preparation_lifecycle_exclusion BEFORE INSERT ON client_hub_native_project_preparations
WHEN EXISTS(SELECT 1 FROM native_project_lifecycle_commands WHERE external_project_id=NEW.external_project_id AND (state NOT IN ('activated','rejected','inbound_review') OR command_id IN (SELECT command_id FROM native_project_lifecycle_pending_handoffs)))
BEGIN SELECT RAISE(ABORT,'native lifecycle owns project preparation'); END;
CREATE TRIGGER native_project_lifecycle_immutable BEFORE UPDATE ON native_project_lifecycle_commands WHEN NEW.command_id IS NOT OLD.command_id OR NEW.external_project_id IS NOT OLD.external_project_id OR NEW.action IS NOT OLD.action OR NEW.source_id IS NOT OLD.source_id OR NEW.source_instance_id IS NOT OLD.source_instance_id OR NEW.application_id IS NOT OLD.application_id OR NEW.history_epoch_id IS NOT OLD.history_epoch_id OR NEW.destination_origin IS NOT OLD.destination_origin OR NEW.project_alpha_public_id IS NOT OLD.project_alpha_public_id OR NEW.context_json IS NOT OLD.context_json OR NEW.context_sha256 IS NOT OLD.context_sha256 OR NEW.body IS NOT OLD.body OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.expected_local_version IS NOT OLD.expected_local_version OR NEW.expected_projection_sha256 IS NOT OLD.expected_projection_sha256 OR NEW.expected_pa_revision IS NOT OLD.expected_pa_revision OR NEW.prior_head_json IS NOT OLD.prior_head_json OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT,'native lifecycle command is immutable'); END;
CREATE TRIGGER native_project_lifecycle_authorizations_no_update BEFORE UPDATE ON native_project_lifecycle_authorizations BEGIN SELECT RAISE(ABORT,'native lifecycle evidence is durable'); END;
CREATE TRIGGER native_project_lifecycle_authorizations_no_delete BEFORE DELETE ON native_project_lifecycle_authorizations BEGIN SELECT RAISE(ABORT,'native lifecycle evidence is durable'); END;
CREATE TRIGGER native_project_lifecycle_events_no_update BEFORE UPDATE ON native_project_lifecycle_events BEGIN SELECT RAISE(ABORT,'native lifecycle evidence is durable'); END;
CREATE TRIGGER native_project_lifecycle_events_no_delete BEFORE DELETE ON native_project_lifecycle_events BEGIN SELECT RAISE(ABORT,'native lifecycle evidence is durable'); END;
CREATE TRIGGER native_project_lifecycle_receipts_no_update BEFORE UPDATE ON native_project_lifecycle_receipts BEGIN SELECT RAISE(ABORT,'native lifecycle evidence is durable'); END;
CREATE TRIGGER native_project_lifecycle_receipts_no_delete BEFORE DELETE ON native_project_lifecycle_receipts BEGIN SELECT RAISE(ABORT,'native lifecycle evidence is durable'); END;
CREATE TRIGGER native_project_lifecycle_refresh_receipts_no_update BEFORE UPDATE ON native_project_lifecycle_refresh_receipts BEGIN SELECT RAISE(ABORT,'native lifecycle evidence is durable'); END;
CREATE TRIGGER native_project_lifecycle_refresh_receipts_no_delete BEFORE DELETE ON native_project_lifecycle_refresh_receipts BEGIN SELECT RAISE(ABORT,'native lifecycle evidence is durable'); END;
CREATE TRIGGER native_project_lifecycle_settlements_no_update BEFORE UPDATE ON native_project_lifecycle_settlements BEGIN SELECT RAISE(ABORT,'native lifecycle evidence is durable'); END;
CREATE TRIGGER native_project_lifecycle_settlements_no_delete BEFORE DELETE ON native_project_lifecycle_settlements BEGIN SELECT RAISE(ABORT,'native lifecycle evidence is durable'); END;
CREATE TRIGGER native_project_lifecycle_activation_fences_no_update BEFORE UPDATE ON native_project_lifecycle_activation_fences BEGIN SELECT RAISE(ABORT,'native lifecycle evidence is durable'); END;
CREATE TRIGGER native_project_lifecycle_activation_fences_no_delete BEFORE DELETE ON native_project_lifecycle_activation_fences BEGIN SELECT RAISE(ABORT,'native lifecycle evidence is durable'); END;
CREATE TRIGGER native_project_lifecycle_activations_no_update BEFORE UPDATE ON native_project_lifecycle_activations BEGIN SELECT RAISE(ABORT,'native lifecycle evidence is durable'); END;
CREATE TRIGGER native_project_lifecycle_activations_no_delete BEFORE DELETE ON native_project_lifecycle_activations BEGIN SELECT RAISE(ABORT,'native lifecycle evidence is durable'); END;
CREATE TRIGGER native_project_lifecycle_commands_no_delete BEFORE DELETE ON native_project_lifecycle_commands BEGIN SELECT RAISE(ABORT,'native lifecycle reservation is durable'); END;
CREATE TRIGGER native_project_lifecycle_refreshes_no_delete BEFORE DELETE ON native_project_lifecycle_refreshes BEGIN SELECT RAISE(ABORT,'native lifecycle reservation is durable'); END;

CREATE VIEW native_project_lifecycle_live_authorizations AS
SELECT authorization.*,proof.actor_staff_id,proof.actor_access_subject,proof.actor_email,proof.grant_generation,proof.verified_until,proof.scopes_json
FROM native_project_lifecycle_authorizations authorization
JOIN native_project_lifecycle_commands command ON command.command_id=authorization.command_id
JOIN native_project_live_command_proofs proof ON proof.command_id=authorization.proof_command_id AND proof.external_project_id=command.external_project_id
JOIN staff_users staff ON staff.id=proof.actor_staff_id AND staff.status='active' AND staff.email=proof.actor_email AND staff.access_subject=proof.actor_access_subject
JOIN native_project_command_proofs original ON original.command_id=command.command_id AND original.actor_staff_id=proof.actor_staff_id AND original.actor_access_subject=proof.actor_access_subject
WHERE proof.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND json(proof.scopes_json)=json(original.scopes_json);
CREATE TRIGGER native_project_lifecycle_authorization_guard AFTER INSERT ON native_project_lifecycle_authorizations
WHEN NOT EXISTS(SELECT 1 FROM native_project_lifecycle_live_authorizations WHERE authorization_id=NEW.authorization_id)
 OR NEW.purpose='send' AND NOT EXISTS(SELECT 1 FROM native_project_live_command_proofs p WHERE p.command_id=NEW.command_id AND p.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'lifecycle authorization is not current'); END;
CREATE TRIGGER native_project_lifecycle_transition BEFORE UPDATE ON native_project_lifecycle_commands
WHEN NOT (
 OLD.state='prepared' AND NEW.state IN ('sending','rejected') OR OLD.state IN ('sending','uncertain') AND NEW.state='sending'
 OR OLD.state='sending' AND NEW.state IN ('prepared','uncertain','acknowledged')
 OR OLD.state='acknowledged' AND NEW.state IN ('settled','inbound_review') OR OLD.state='settled' AND NEW.state='activating'
 OR OLD.state='activating' AND NEW.state='activated'
) OR (NEW.state='sending' AND (OLD.state='prepared' AND NOT EXISTS(SELECT 1 FROM native_project_live_command_proofs p WHERE p.command_id=OLD.command_id AND p.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) OR NEW.lease_expires_at<=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) OR OLD.state='prepared' AND OLD.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') OR OLD.state='sending' AND OLD.lease_expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) OR NEW.transmission_count<>OLD.transmission_count+1 OR NEW.active_authorization_id IS OLD.active_authorization_id
 OR NOT EXISTS(SELECT 1 FROM native_project_lifecycle_live_authorizations a WHERE a.authorization_id=NEW.active_authorization_id AND a.command_id=NEW.command_id AND a.purpose=CASE WHEN OLD.state='prepared' THEN 'send' ELSE 'reconcile' END)))
 OR (NEW.state<>'sending' AND NEW.transmission_count<>OLD.transmission_count)
 OR (NEW.state='acknowledged' AND NOT EXISTS(SELECT 1 FROM native_project_lifecycle_receipts WHERE command_id=NEW.command_id))
 OR (NEW.state='settled' AND NOT EXISTS(SELECT 1 FROM native_project_lifecycle_settlements WHERE command_id=NEW.command_id))
 OR (NEW.state='inbound_review' AND NOT EXISTS(SELECT 1 FROM native_project_lifecycle_inbound_handoffs WHERE command_id=NEW.command_id))
 OR (NEW.state='activated' AND NOT EXISTS(SELECT 1 FROM native_project_lifecycle_activations WHERE command_id=NEW.command_id))
BEGIN SELECT RAISE(ABORT,'lifecycle transition requires exact durable evidence'); END;
CREATE TRIGGER native_project_lifecycle_receipt_guard BEFORE INSERT ON native_project_lifecycle_receipts
WHEN NOT EXISTS(
 SELECT 1 FROM native_project_lifecycle_commands c JOIN native_project_lifecycle_live_authorizations a ON a.authorization_id=c.active_authorization_id
 WHERE c.command_id=NEW.command_id AND c.state='sending'
 AND json_extract(NEW.response_json,'$.accepted') IS 1 AND json_extract(NEW.response_json,'$.apiVersion')='2'
 AND json_extract(NEW.response_json,'$.sourceInstanceId')=c.source_instance_id AND json_extract(NEW.response_json,'$.applicationId')=c.application_id
 AND json_extract(NEW.response_json,'$.historyEpoch')=c.history_epoch_id AND json_extract(NEW.response_json,'$.resource.id')=c.project_alpha_public_id
 AND json_extract(NEW.response_json,'$.resource.revision')=NEW.project_alpha_revision AND json_extract(NEW.response_json,'$.requestId')=NEW.request_id
 AND json_extract(NEW.response_json,'$.result.archived')=(c.action='archive')
 AND (length(NEW.project_alpha_revision)>length(c.expected_pa_revision) OR length(NEW.project_alpha_revision)=length(c.expected_pa_revision) AND NEW.project_alpha_revision>c.expected_pa_revision)
)
BEGIN SELECT RAISE(ABORT,'lifecycle receipt is not exact'); END;
CREATE TRIGGER native_project_lifecycle_refresh_insert BEFORE INSERT ON native_project_lifecycle_refreshes
WHEN NOT EXISTS(
 SELECT 1 FROM native_project_lifecycle_commands c JOIN native_project_lifecycle_receipts r ON r.command_id=c.command_id
 JOIN native_project_live_command_proofs p ON p.command_id=NEW.command_id AND p.external_project_id=c.external_project_id
 JOIN native_project_command_proofs original ON original.command_id=c.command_id AND original.actor_staff_id=p.actor_staff_id AND original.actor_access_subject=p.actor_access_subject AND json(original.scopes_json)=json(p.scopes_json)
 WHERE c.command_id=NEW.parent_command_id AND c.state='acknowledged' AND p.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND json_extract(NEW.body,'$.commandId')=NEW.command_id AND json_extract(NEW.body,'$.externalId')=c.external_project_id
 AND json_extract(NEW.body,'$.expectedPublicId')=c.project_alpha_public_id
 AND json_extract(NEW.body,'$.expectedRevision')=r.project_alpha_revision AND NEW.expected_revision=r.project_alpha_revision
 AND json_extract(NEW.body,'$.expectedProjectionSha256')=NEW.expected_projection_sha256
 AND (SELECT count(*) FROM json_each(NEW.body))=7
)
 OR EXISTS(SELECT 1 FROM project_alpha_project_outbox WHERE command_id=NEW.command_id)
 OR EXISTS(SELECT 1 FROM native_project_lifecycle_commands WHERE command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'refresh requires exact acknowledged lifecycle parent'); END;
CREATE TRIGGER native_project_lifecycle_refresh_transition BEFORE UPDATE ON native_project_lifecycle_refreshes
WHEN NEW.command_id IS NOT OLD.command_id OR NEW.parent_command_id IS NOT OLD.parent_command_id OR NEW.body IS NOT OLD.body
 OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.expected_revision IS NOT OLD.expected_revision
 OR NEW.expected_projection_sha256 IS NOT OLD.expected_projection_sha256 OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at
 OR NOT (OLD.state='prepared' AND NEW.state IN ('sending','rejected') OR OLD.state IN ('sending','uncertain') AND NEW.state='sending'
 OR OLD.state='sending' AND NEW.state IN ('prepared','uncertain','acknowledged'))
 OR (NEW.state='sending' AND (OLD.state='prepared' AND NOT EXISTS(SELECT 1 FROM native_project_live_command_proofs p WHERE p.command_id=OLD.command_id AND p.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) OR NEW.lease_expires_at<=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) OR OLD.state='prepared' AND OLD.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') OR OLD.state='sending' AND OLD.lease_expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) OR NEW.transmission_count<>OLD.transmission_count+1 OR NEW.active_authorization_id IS OLD.active_authorization_id
 OR NOT EXISTS(SELECT 1 FROM native_project_lifecycle_live_authorizations a WHERE a.authorization_id=NEW.active_authorization_id AND a.command_id=NEW.parent_command_id AND a.purpose=CASE WHEN OLD.state='prepared' THEN 'refresh' ELSE 'refresh_reconcile' END)))
 OR (NEW.state<>'sending' AND NEW.transmission_count<>OLD.transmission_count)
 OR (NEW.state='acknowledged' AND NOT EXISTS(SELECT 1 FROM native_project_lifecycle_refresh_receipts WHERE command_id=NEW.command_id))
BEGIN SELECT RAISE(ABORT,'refresh identity and transition are guarded'); END;
CREATE TRIGGER native_project_lifecycle_refresh_receipt_guard BEFORE INSERT ON native_project_lifecycle_refresh_receipts
WHEN NOT EXISTS(
 SELECT 1 FROM native_project_lifecycle_refreshes child JOIN native_project_lifecycle_commands c ON c.command_id=child.parent_command_id
 JOIN native_project_lifecycle_live_authorizations a ON a.authorization_id=child.active_authorization_id AND a.command_id=c.command_id
 WHERE child.command_id=NEW.command_id AND child.state='sending' AND c.state='acknowledged'
 AND json_extract(NEW.response_json,'$.sourceInstanceId')=c.source_instance_id AND json_extract(NEW.response_json,'$.applicationId')=c.application_id
 AND json_extract(NEW.response_json,'$.historyEpoch')=c.history_epoch_id
 AND json_extract(NEW.response_json,'$.result.resource.publicId')=c.project_alpha_public_id
 AND json_extract(NEW.response_json,'$.result.resource.revision')=child.expected_revision
 AND json_extract(NEW.response_json,'$.result.resource.projectionSha256')=child.expected_projection_sha256
)
BEGIN SELECT RAISE(ABORT,'refresh receipt is not exact'); END;
CREATE TRIGGER native_project_lifecycle_settlement_guard BEFORE INSERT ON native_project_lifecycle_settlements
WHEN NOT EXISTS(
 SELECT 1 FROM native_project_lifecycle_commands c JOIN native_project_lifecycle_receipts r ON r.command_id=c.command_id
 JOIN native_project_lifecycle_refreshes child ON child.parent_command_id=c.command_id AND child.command_id=NEW.refresh_command_id
 JOIN native_project_lifecycle_refresh_receipts cr ON cr.command_id=child.command_id
 JOIN native_project_live_command_proofs proof ON proof.command_id=NEW.proof_command_id AND proof.external_project_id=c.external_project_id
 JOIN native_project_command_proofs original ON original.command_id=c.command_id AND original.actor_staff_id=proof.actor_staff_id AND original.actor_access_subject=proof.actor_access_subject AND json(original.scopes_json)=json(proof.scopes_json)
 JOIN staff_users staff ON staff.id=proof.actor_staff_id AND staff.status='active' AND staff.email=proof.actor_email AND staff.access_subject=proof.actor_access_subject
 JOIN operations_shared_projects head ON head.external_project_id=c.external_project_id
 WHERE c.command_id=NEW.command_id AND c.state='acknowledged' AND child.state='acknowledged'
 AND proof.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND head.current_version=c.expected_local_version AND head.canonical_projection_sha256=c.expected_projection_sha256
 AND json_extract(NEW.read_json,'$.accepted') IS 1
 AND json_extract(NEW.read_json,'$.sourceInstanceId')=c.source_instance_id AND json_extract(NEW.read_json,'$.applicationId')=c.application_id AND json_extract(NEW.read_json,'$.historyEpoch')=c.history_epoch_id
 AND json_extract(NEW.read_json,'$.resource.id')=c.project_alpha_public_id AND json_extract(NEW.read_json,'$.resource.revision')=r.project_alpha_revision
 AND json_extract(NEW.read_json,'$.resource.projectionSha256')=child.expected_projection_sha256 AND json_extract(NEW.read_json,'$.data.archived')=(c.action='archive')
 AND json_extract(NEW.binding_json,'$.binding.publicId')=c.project_alpha_public_id AND json_extract(NEW.binding_json,'$.binding.externalId')=c.external_project_id
 AND json_extract(NEW.binding_json,'$.sourceInstanceId')=c.source_instance_id AND json_extract(NEW.binding_json,'$.applicationId')=c.application_id AND json_extract(NEW.binding_json,'$.historyEpoch')=c.history_epoch_id
 AND json_extract(NEW.binding_json,'$.resource.revision')=r.project_alpha_revision AND json_extract(NEW.binding_json,'$.resource.projectionSha256')=child.expected_projection_sha256
 AND json_extract(NEW.binding_json,'$.resource.archived')=(c.action='archive')
 AND json_extract(NEW.read_json,'$.data.name') IS head.name AND json_extract(NEW.read_json,'$.data.description') IS head.description
 AND json_extract(NEW.read_json,'$.data.status') IS head.lifecycle AND json_extract(NEW.read_json,'$.data.completedAt') IS head.completed_at
 AND json_extract(NEW.read_json,'$.data.estimatedStart') IS head.planned_start AND json_extract(NEW.read_json,'$.data.estimatedEnd') IS head.planned_end
 AND ((head.organization_record_id IS NULL AND json_type(NEW.read_json,'$.data.organizationPublicId')='null') OR EXISTS(SELECT 1 FROM project_alpha_active_directory_mappings d WHERE d.record_id=head.organization_record_id AND d.resource_type='organization' AND d.source_id=c.source_id AND d.source_instance_id=c.source_instance_id AND d.application_id=c.application_id AND d.history_epoch_id=c.history_epoch_id AND d.project_alpha_public_id=json_extract(NEW.read_json,'$.data.organizationPublicId')))
 AND ((head.client_record_id IS NULL AND json_type(NEW.read_json,'$.data.clientPublicId')='null') OR EXISTS(SELECT 1 FROM project_alpha_active_directory_mappings d WHERE d.record_id=head.client_record_id AND d.resource_type='client' AND d.source_id=c.source_id AND d.source_instance_id=c.source_instance_id AND d.application_id=c.application_id AND d.history_epoch_id=c.history_epoch_id AND d.project_alpha_public_id=json_extract(NEW.read_json,'$.data.clientPublicId')))
 AND (head.organization_record_id IS NULL OR head.client_record_id IS NULL OR EXISTS(SELECT 1 FROM operations_directory_client_organizations relation WHERE relation.client_record_id=head.client_record_id AND relation.organization_record_id=head.organization_record_id))
)
BEGIN SELECT RAISE(ABORT,'lifecycle settlement requires matching refreshed canonical reads'); END;
CREATE TRIGGER native_project_lifecycle_fence_guard BEFORE INSERT ON native_project_lifecycle_activation_fences
WHEN NOT EXISTS(
 SELECT 1 FROM native_project_lifecycle_commands c JOIN native_project_lifecycle_settlements s ON s.command_id=c.command_id AND s.settlement_id=NEW.settlement_id
 JOIN native_project_live_command_proofs p ON p.command_id=NEW.proof_command_id AND p.external_project_id=c.external_project_id
 JOIN native_project_command_proofs original ON original.command_id=c.command_id AND original.actor_staff_id=p.actor_staff_id AND original.actor_access_subject=p.actor_access_subject AND json(original.scopes_json)=json(p.scopes_json)
 JOIN staff_users staff ON staff.id=p.actor_staff_id AND staff.status='active' AND staff.email=p.actor_email AND staff.access_subject=p.actor_access_subject
 JOIN operations_shared_projects h ON h.external_project_id=c.external_project_id
 WHERE c.command_id=NEW.command_id AND c.state='activating' AND p.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND h.current_version=c.expected_local_version AND h.canonical_projection_sha256=c.expected_projection_sha256
 AND json(h.scopes_json)=json(p.scopes_json) AND NEW.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND NEW.expires_at<=p.verified_until
)
BEGIN SELECT RAISE(ABORT,'lifecycle activation fence lacks current authority'); END;

DROP TRIGGER operations_shared_projects_no_update;
CREATE TRIGGER operations_shared_projects_no_update BEFORE UPDATE ON operations_shared_projects
WHEN NOT EXISTS (
 SELECT 1 FROM project_alpha_project_v2_update_activation_fences fence
 WHERE fence.external_project_id=OLD.external_project_id AND fence.prior_version=OLD.current_version
  AND fence.prior_projection_sha256=OLD.canonical_projection_sha256 AND fence.resulting_version=NEW.current_version
  AND NEW.external_project_id IS OLD.external_project_id AND NEW.created_at IS OLD.created_at
  AND NEW.source_id=fence.source_id AND NEW.source_instance_id=fence.source_instance_id
  AND NEW.application_id=fence.application_id AND NEW.history_epoch_id=fence.history_epoch_id
  AND NEW.project_alpha_public_id=fence.project_alpha_public_id AND NEW.pa_revision=fence.project_alpha_revision
  AND NEW.canonical_projection_sha256=fence.projection_sha256 AND NEW.name=fence.name
  AND NEW.description IS fence.description AND NEW.lifecycle=fence.lifecycle
  AND NEW.planned_start IS fence.planned_start AND NEW.planned_end IS fence.planned_end
  AND NEW.organization_record_id IS fence.organization_record_id AND NEW.client_record_id IS fence.client_record_id
  AND json(NEW.scopes_json)=json(fence.scopes_json) AND NEW.completed_at IS fence.completed_at
  AND NEW.archived=fence.archived AND NEW.archived_at IS fence.archived_at AND NEW.overdue_warning=fence.overdue_warning
  AND fence.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
) AND NOT EXISTS (
 SELECT 1 FROM project_alpha_project_inbound_resolution_authorizations authorization
 JOIN project_alpha_project_inbound_proposals proposal ON proposal.proposal_id=authorization.proposal_id
 WHERE authorization.decision='accept_project_alpha' AND proposal.external_project_id=OLD.external_project_id
  AND OLD.current_version=proposal.expected_local_version AND OLD.canonical_projection_sha256=proposal.expected_local_projection_sha256
  AND NEW.external_project_id IS OLD.external_project_id AND NEW.created_at IS OLD.created_at
  AND NEW.source_id IS OLD.source_id AND NEW.source_instance_id IS OLD.source_instance_id
  AND NEW.application_id IS OLD.application_id AND NEW.history_epoch_id IS OLD.history_epoch_id
  AND NEW.project_alpha_public_id IS OLD.project_alpha_public_id AND NEW.current_version=OLD.current_version+1
  AND NEW.pa_revision=authorization.final_remote_revision AND NEW.canonical_projection_sha256=authorization.final_remote_projection_sha256
  AND NEW.name=json_extract(authorization.final_remote_snapshot_json,'$.data.name')
  AND NEW.description IS json_extract(authorization.final_remote_snapshot_json,'$.data.description')
  AND NEW.lifecycle=json_extract(authorization.final_remote_snapshot_json,'$.data.status')
  AND NEW.archived=(json_extract(authorization.final_remote_snapshot_json,'$.data.archived') IS 1)
  AND NEW.overdue_warning=(json_extract(authorization.final_remote_snapshot_json,'$.data.overdueWarning') IS 1)
  AND NEW.completed_at IS json_extract(authorization.final_remote_snapshot_json,'$.data.completedAt')
  AND NEW.archived_at IS json_extract(authorization.final_remote_snapshot_json,'$.data.archivedAt')
  AND NEW.planned_start IS json_extract(authorization.final_remote_snapshot_json,'$.data.estimatedStart')
  AND NEW.planned_end IS json_extract(authorization.final_remote_snapshot_json,'$.data.estimatedEnd')
  AND NEW.organization_record_id IS authorization.target_organization_record_id
  AND NEW.client_record_id IS authorization.target_client_record_id
  AND json(NEW.scopes_json)=json(authorization.normalized_scopes_json))
 AND NOT EXISTS(SELECT 1 FROM native_project_lifecycle_activation_fences f
 JOIN native_project_lifecycle_commands c ON c.command_id=f.command_id
 JOIN native_project_lifecycle_settlements settlement ON settlement.settlement_id=f.settlement_id AND settlement.command_id=c.command_id
 JOIN native_project_live_command_proofs proof ON proof.command_id=f.proof_command_id AND proof.external_project_id=c.external_project_id
 JOIN staff_users staff ON staff.id=proof.actor_staff_id AND staff.status='active' AND staff.email=proof.actor_email AND staff.access_subject=proof.actor_access_subject
 WHERE c.external_project_id=OLD.external_project_id AND c.state='activating' AND f.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND proof.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND OLD.current_version=c.expected_local_version AND OLD.canonical_projection_sha256=c.expected_projection_sha256
 AND NEW.current_version=OLD.current_version+1 AND NEW.external_project_id IS OLD.external_project_id AND NEW.created_at IS OLD.created_at
 AND NEW.source_id IS OLD.source_id AND NEW.source_instance_id IS OLD.source_instance_id AND NEW.application_id IS OLD.application_id AND NEW.history_epoch_id IS OLD.history_epoch_id
 AND NEW.project_alpha_public_id IS OLD.project_alpha_public_id AND NEW.organization_record_id IS OLD.organization_record_id AND NEW.client_record_id IS OLD.client_record_id
 AND NEW.name IS OLD.name AND NEW.description IS OLD.description AND NEW.lifecycle IS OLD.lifecycle AND NEW.completed_at IS OLD.completed_at
 AND NEW.planned_start IS OLD.planned_start AND NEW.planned_end IS OLD.planned_end AND json_type(settlement.read_json,'$.data.overdueWarning') IN ('true','false') AND NEW.overdue_warning=(json_extract(settlement.read_json,'$.data.overdueWarning') IS 1)
 AND json(NEW.scopes_json)=json(OLD.scopes_json) AND json(proof.scopes_json)=json(OLD.scopes_json)
 AND NEW.pa_revision=json_extract(settlement.read_json,'$.resource.revision') AND NEW.canonical_projection_sha256=json_extract(settlement.read_json,'$.resource.projectionSha256')
 AND NEW.archived=(c.action='archive') AND NEW.archived=json_extract(settlement.read_json,'$.data.archived') AND NEW.archived_at IS json_extract(settlement.read_json,'$.data.archivedAt'))
BEGIN SELECT RAISE(ABORT,'shared project update requires a versioned writer'); END;
CREATE TRIGGER operations_shared_projects_lifecycle_fence BEFORE UPDATE ON operations_shared_projects
WHEN EXISTS(SELECT 1 FROM native_project_lifecycle_commands c WHERE c.external_project_id=OLD.external_project_id AND c.state NOT IN ('activated','rejected','inbound_review'))
 AND NOT EXISTS(SELECT 1 FROM native_project_lifecycle_activation_fences f
 JOIN native_project_lifecycle_commands c ON c.command_id=f.command_id
 JOIN native_project_lifecycle_settlements settlement ON settlement.settlement_id=f.settlement_id AND settlement.command_id=c.command_id
 JOIN native_project_live_command_proofs proof ON proof.command_id=f.proof_command_id AND proof.external_project_id=c.external_project_id
 JOIN staff_users staff ON staff.id=proof.actor_staff_id AND staff.status='active' AND staff.email=proof.actor_email AND staff.access_subject=proof.actor_access_subject
 WHERE c.external_project_id=OLD.external_project_id AND c.state='activating' AND f.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND proof.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND OLD.current_version=c.expected_local_version AND OLD.canonical_projection_sha256=c.expected_projection_sha256
 AND NEW.current_version=OLD.current_version+1 AND NEW.external_project_id IS OLD.external_project_id AND NEW.created_at IS OLD.created_at
 AND NEW.source_id IS OLD.source_id AND NEW.source_instance_id IS OLD.source_instance_id AND NEW.application_id IS OLD.application_id AND NEW.history_epoch_id IS OLD.history_epoch_id
 AND NEW.project_alpha_public_id IS OLD.project_alpha_public_id AND NEW.organization_record_id IS OLD.organization_record_id AND NEW.client_record_id IS OLD.client_record_id
 AND NEW.name IS OLD.name AND NEW.description IS OLD.description AND NEW.lifecycle IS OLD.lifecycle AND NEW.completed_at IS OLD.completed_at
 AND NEW.planned_start IS OLD.planned_start AND NEW.planned_end IS OLD.planned_end AND json_type(settlement.read_json,'$.data.overdueWarning') IN ('true','false') AND NEW.overdue_warning=(json_extract(settlement.read_json,'$.data.overdueWarning') IS 1)
 AND json(NEW.scopes_json)=json(OLD.scopes_json) AND json(proof.scopes_json)=json(OLD.scopes_json)
 AND NEW.pa_revision=json_extract(settlement.read_json,'$.resource.revision') AND NEW.canonical_projection_sha256=json_extract(settlement.read_json,'$.resource.projectionSha256')
 AND NEW.archived=(c.action='archive') AND NEW.archived=json_extract(settlement.read_json,'$.data.archived') AND NEW.archived_at IS json_extract(settlement.read_json,'$.data.archivedAt'))
BEGIN SELECT RAISE(ABORT,'lifecycle reservation excludes other canonical writers'); END;

DROP TRIGGER operations_shared_project_revisions_bound_guard;
CREATE TRIGGER operations_shared_project_revisions_bound_guard BEFORE INSERT ON operations_shared_project_revisions
WHEN NEW.refresh_command_id IS NOT NULL AND NEW.v2_settlement_id IS NULL AND NOT EXISTS (
  SELECT 1 FROM operations_shared_projects project
  JOIN project_alpha_project_refresh refresh ON refresh.external_project_id=project.external_project_id
    AND refresh.establishment_command_id=NEW.refresh_command_id
  JOIN native_project_live_command_proofs proof ON proof.command_id=NEW.refresh_command_id
    AND proof.external_project_id=project.external_project_id
  WHERE project.external_project_id=NEW.external_project_id AND NEW.version=1
    AND project.current_version=1 AND project.pa_revision=NEW.pa_revision
    AND json_type(NEW.read_json,'$.resource.revision')='text'
    AND json_extract(NEW.read_json,'$.resource.revision')=NEW.pa_revision
    AND json_extract(NEW.read_json,'$.resource.id')=project.project_alpha_public_id
    AND json_extract(NEW.read_json,'$.data.publicId')=project.project_alpha_public_id
    AND json_extract(NEW.read_json,'$.sourceInstanceId')=project.source_instance_id
    AND json_extract(NEW.read_json,'$.applicationId')=project.application_id
    AND json_extract(NEW.read_json,'$.historyEpoch')=project.history_epoch_id
    AND json_extract(NEW.read_json,'$.data.name')=project.name
    AND json_extract(NEW.read_json,'$.data.lifecycle')=project.lifecycle
    AND json_extract(NEW.read_json,'$.data.plannedStart') IS project.planned_start
    AND json_extract(NEW.read_json,'$.data.plannedEnd') IS project.planned_end
    AND (project.organization_record_id IS NULL
      AND json_extract(NEW.read_json,'$.data.customer.organizationPublicId') IS NULL
      OR EXISTS (SELECT 1 FROM project_alpha_active_directory_mappings customer
        WHERE customer.source_id=project.source_id AND customer.source_instance_id=project.source_instance_id
          AND customer.application_id=project.application_id AND customer.history_epoch_id=project.history_epoch_id
          AND customer.resource_type='organization' AND customer.record_id=project.organization_record_id
          AND customer.project_alpha_public_id=json_extract(NEW.read_json,'$.data.customer.organizationPublicId')))
    AND (project.client_record_id IS NULL
      AND json_extract(NEW.read_json,'$.data.customer.primaryClientPublicId') IS NULL
      OR EXISTS (SELECT 1 FROM project_alpha_active_directory_mappings customer
        WHERE customer.source_id=project.source_id AND customer.source_instance_id=project.source_instance_id
          AND customer.application_id=project.application_id AND customer.history_epoch_id=project.history_epoch_id
          AND customer.resource_type='client' AND customer.record_id=project.client_record_id
          AND customer.project_alpha_public_id=json_extract(NEW.read_json,'$.data.customer.primaryClientPublicId')))
) AND NEW.lifecycle_settlement_id IS NULL
BEGIN SELECT RAISE(ABORT,'bound shared project revision is not authorized'); END;
CREATE TRIGGER operations_shared_project_revisions_lifecycle_guard BEFORE INSERT ON operations_shared_project_revisions
WHEN NEW.lifecycle_settlement_id IS NOT NULL AND (
 NEW.v2_settlement_id IS NOT NULL OR NEW.inbound_resolution_id IS NOT NULL OR NEW.refresh_command_id IS NOT NULL OR NEW.pa_revision IS NOT NULL
 OR NOT EXISTS(
 SELECT 1 FROM native_project_lifecycle_settlements s JOIN native_project_lifecycle_commands c ON c.command_id=s.command_id
 JOIN native_project_lifecycle_activation_fences f ON f.command_id=c.command_id AND f.settlement_id=s.settlement_id
 JOIN native_project_live_command_proofs p ON p.command_id=f.proof_command_id AND p.external_project_id=c.external_project_id
 JOIN operations_shared_projects h ON h.external_project_id=c.external_project_id
 WHERE s.settlement_id=NEW.lifecycle_settlement_id AND c.state='activating' AND NEW.external_project_id=c.external_project_id
 AND NEW.version=c.expected_local_version+1 AND h.current_version=NEW.version AND h.canonical_projection_sha256=json_extract(s.read_json,'$.resource.projectionSha256')
 AND json(NEW.read_json)=json(s.read_json) AND f.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND p.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'lifecycle history lacks exact live settlement'); END;
CREATE TRIGGER native_project_lifecycle_activation_guard BEFORE INSERT ON native_project_lifecycle_activations
WHEN NOT EXISTS(
 SELECT 1 FROM native_project_lifecycle_commands c JOIN native_project_lifecycle_settlements s ON s.command_id=c.command_id AND s.settlement_id=NEW.settlement_id
 JOIN operations_shared_projects h ON h.external_project_id=c.external_project_id
 JOIN operations_shared_project_revisions r ON r.external_project_id=h.external_project_id AND r.version=h.current_version AND r.lifecycle_settlement_id=s.settlement_id
 WHERE c.command_id=NEW.command_id AND c.state='activating' AND NEW.resulting_local_version=c.expected_local_version+1 AND h.current_version=NEW.resulting_local_version
 AND h.canonical_projection_sha256=json_extract(s.read_json,'$.resource.projectionSha256'))
BEGIN SELECT RAISE(ABORT,'lifecycle activation requires exact head and history'); END;

CREATE UNIQUE INDEX native_project_lifecycle_refresh_one_unresolved ON native_project_lifecycle_refreshes(parent_command_id) WHERE state<>'rejected';
CREATE TRIGGER native_project_lifecycle_abandon_guard BEFORE UPDATE ON native_project_lifecycle_commands
WHEN NEW.state='rejected' AND OLD.state='prepared' AND (EXISTS(SELECT 1 FROM native_project_lifecycle_post_attempts attempt WHERE attempt.parent_command_id=OLD.command_id AND attempt.refresh_command_id IS NULL)
 OR EXISTS(SELECT 1 FROM native_project_lifecycle_receipts WHERE command_id=OLD.command_id)
 OR EXISTS(SELECT 1 FROM native_project_lifecycle_refreshes WHERE parent_command_id=OLD.command_id)
 OR NOT EXISTS(SELECT 1 FROM native_project_lifecycle_live_authorizations a WHERE a.authorization_id=NEW.active_authorization_id AND a.command_id=OLD.command_id AND a.purpose='abandon'))
BEGIN SELECT RAISE(ABORT,'only an explicitly reviewed never-transmitted preparation may be abandoned'); END;
CREATE TRIGGER native_project_lifecycle_refresh_abandon_guard BEFORE UPDATE ON native_project_lifecycle_refreshes
WHEN NEW.state='rejected' AND OLD.state='prepared' AND (EXISTS(SELECT 1 FROM native_project_lifecycle_post_attempts attempt WHERE attempt.refresh_command_id=OLD.command_id)
 OR EXISTS(SELECT 1 FROM native_project_lifecycle_refresh_receipts WHERE command_id=OLD.command_id)
 OR NOT EXISTS(SELECT 1 FROM native_project_lifecycle_live_authorizations a WHERE a.authorization_id=NEW.active_authorization_id AND a.command_id=OLD.parent_command_id AND a.purpose='abandon_refresh'))
BEGIN SELECT RAISE(ABORT,'only an explicitly reviewed never-transmitted refresh may be abandoned'); END;

CREATE TRIGGER project_inbound_proposal_lifecycle_exclusion BEFORE INSERT ON project_alpha_project_inbound_proposals
WHEN EXISTS(SELECT 1 FROM native_project_lifecycle_commands WHERE external_project_id=NEW.external_project_id AND state NOT IN ('activated','rejected','inbound_review'))
BEGIN SELECT RAISE(ABORT,'native lifecycle owns project review reservation'); END;
CREATE TRIGGER project_inbound_authorization_lifecycle_exclusion BEFORE INSERT ON project_alpha_project_inbound_resolution_authorizations
WHEN EXISTS(SELECT 1 FROM project_alpha_project_inbound_proposals proposal JOIN native_project_lifecycle_commands c ON c.external_project_id=proposal.external_project_id WHERE proposal.proposal_id=NEW.proposal_id AND c.state NOT IN ('activated','rejected','inbound_review'))
BEGIN SELECT RAISE(ABORT,'native lifecycle owns project resolution reservation'); END;

CREATE TRIGGER native_project_lifecycle_post_attempt_guard BEFORE INSERT ON native_project_lifecycle_post_attempts
WHEN NOT EXISTS(SELECT 1 FROM native_project_lifecycle_commands c JOIN operations_shared_projects h ON h.external_project_id=c.external_project_id
 JOIN project_alpha_active_directory_mappings m ON m.source_id=c.source_id AND m.source_instance_id=c.source_instance_id AND m.application_id=c.application_id AND m.history_epoch_id=c.history_epoch_id
 WHERE c.command_id=NEW.parent_command_id AND h.current_version=c.expected_local_version AND h.canonical_projection_sha256=c.expected_projection_sha256
 AND h.source_id=c.source_id AND h.source_instance_id=c.source_instance_id AND h.application_id=c.application_id AND h.history_epoch_id=c.history_epoch_id AND h.project_alpha_public_id=c.project_alpha_public_id
 AND m.record_id=json_extract(c.context_json,'$.rootPublicId') AND ((json_extract(c.context_json,'$.rootKind')='organization' AND m.resource_type='organization' AND m.record_id=h.organization_record_id)
 OR (json_extract(c.context_json,'$.rootKind')='standalone_client' AND m.resource_type='client' AND m.record_id=h.client_record_id AND h.organization_record_id IS NULL
 AND EXISTS(SELECT 1 FROM operations_directory_client_organizations relationship WHERE relationship.client_record_id=h.client_record_id AND relationship.organization_record_id IS NULL))))
 OR NEW.refresh_command_id IS NULL AND NOT EXISTS(
 SELECT 1 FROM native_project_lifecycle_commands c JOIN native_project_lifecycle_live_authorizations a ON a.authorization_id=c.active_authorization_id
 WHERE a.command_id=c.command_id AND c.command_id=NEW.parent_command_id AND c.state='sending' AND c.lease_token=NEW.lease_token AND c.request_sha256=NEW.request_sha256
 AND c.lease_expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
) OR NEW.refresh_command_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM native_project_lifecycle_refreshes child JOIN native_project_lifecycle_live_authorizations a ON a.authorization_id=child.active_authorization_id
 WHERE a.command_id=child.parent_command_id AND child.command_id=NEW.refresh_command_id AND child.parent_command_id=NEW.parent_command_id AND child.state='sending'
 AND child.lease_token=NEW.lease_token AND child.request_sha256=NEW.request_sha256
 AND child.lease_expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
)
BEGIN SELECT RAISE(ABORT,'network edge requires the exact current authorized lease'); END;
CREATE TRIGGER native_project_lifecycle_post_attempts_no_update BEFORE UPDATE ON native_project_lifecycle_post_attempts BEGIN SELECT RAISE(ABORT,'POST attempts are durable'); END;
CREATE TRIGGER native_project_lifecycle_post_attempts_no_delete BEFORE DELETE ON native_project_lifecycle_post_attempts BEGIN SELECT RAISE(ABORT,'POST attempts are durable'); END;
CREATE TRIGGER native_project_lifecycle_unsent_guard BEFORE UPDATE ON native_project_lifecycle_commands
WHEN OLD.state='sending' AND NEW.state='prepared' AND EXISTS(SELECT 1 FROM native_project_lifecycle_post_attempts a WHERE a.parent_command_id=OLD.command_id AND a.refresh_command_id IS NULL)
BEGIN SELECT RAISE(ABORT,'a possibly transmitted lifecycle cannot be released as unsent'); END;
CREATE TRIGGER native_project_lifecycle_refresh_unsent_guard BEFORE UPDATE ON native_project_lifecycle_refreshes
WHEN OLD.state='sending' AND NEW.state='prepared' AND EXISTS(SELECT 1 FROM native_project_lifecycle_post_attempts a WHERE a.refresh_command_id=OLD.command_id)
BEGIN SELECT RAISE(ABORT,'a possibly transmitted refresh cannot be released as unsent'); END;

-- Fresh PA reads retain independent raw hashes; only their per-request ID may differ.
DROP TRIGGER project_alpha_project_inbound_resolution_authorizations_proposal_exact;
CREATE TRIGGER project_alpha_project_inbound_resolution_authorizations_proposal_exact
BEFORE INSERT ON project_alpha_project_inbound_resolution_authorizations
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_inbound_proposals proposal
  WHERE proposal.proposal_id=NEW.proposal_id AND proposal.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND proposal.reviewer_staff_id=NEW.reviewer_staff_id
    AND proposal.reviewer_access_subject=NEW.reviewer_access_subject
    AND proposal.reviewer_admission_version=NEW.reviewer_admission_version
    AND proposal.reviewer_profile_version=NEW.reviewer_profile_version
    AND proposal.project_grant_generation=NEW.project_grant_generation
    AND json(proposal.normalized_scopes_json)=json(NEW.normalized_scopes_json)
    AND NEW.final_remote_revision=proposal.observed_remote_revision
    AND NEW.final_remote_projection_sha256=proposal.observed_remote_projection_sha256
    AND NEW.final_authorization_generation=proposal.observed_authorization_generation
    AND json_remove(NEW.final_remote_snapshot_json,'$.requestId')=json_remove(proposal.remote_snapshot_json,'$.requestId')
    AND NEW.target_organization_record_id IS proposal.target_organization_record_id
    AND NEW.target_client_record_id IS proposal.target_client_record_id
)
BEGIN SELECT RAISE(ABORT,'project inbound resolution evidence is stale'); END;
