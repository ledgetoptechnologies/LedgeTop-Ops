PRAGMA foreign_keys = ON;

-- Default-off, parallel Client control-plane authority for the verified
-- recipient resource protocol. This is intentionally not a PA principal,
-- identity, membership, entitlement, or authenticated-delivery grant.
CREATE TABLE portal_verified_recipient_delivery_authority_heads (
  authority_id TEXT PRIMARY KEY CHECK(
    length(authority_id)=36 AND authority_id=lower(authority_id)
    AND substr(authority_id,9,1)='-' AND substr(authority_id,14,1)='-'
    AND substr(authority_id,19,1)='-' AND substr(authority_id,24,1)='-'
    AND replace(authority_id,'-','') NOT GLOB '*[^0-9a-f]*'
  ),
  workspace_id TEXT NOT NULL,
  client_authority_id TEXT NOT NULL,
  selection_id TEXT NOT NULL,
  client_record_id TEXT NOT NULL CHECK(length(trim(client_record_id)) BETWEEN 1 AND 200),
  recipient_binding_id TEXT NOT NULL,
  enrollment_intent_id TEXT NOT NULL,
  enrollment_revision INTEGER NOT NULL CHECK(enrollment_revision>=1),
  issuer TEXT NOT NULL CHECK(length(trim(issuer)) BETWEEN 1 AND 512),
  subject TEXT NOT NULL CHECK(length(trim(subject)) BETWEEN 1 AND 512),
  home_ownership_epoch INTEGER NOT NULL CHECK(home_ownership_epoch>=1),
  home_grant_revision INTEGER NOT NULL CHECK(home_grant_revision>=1),
  home_grant_operation_id TEXT NOT NULL,
  folder_binding_id TEXT NOT NULL,
  folder_binding_source_version TEXT NOT NULL CHECK(length(trim(folder_binding_source_version)) BETWEEN 1 AND 128),
  source_id TEXT NOT NULL CHECK(length(trim(source_id)) BETWEEN 1 AND 128),
  project_public_id TEXT NOT NULL CHECK(length(trim(project_public_id)) BETWEEN 1 AND 200),
  project_source_version TEXT NOT NULL CHECK(length(trim(project_source_version)) BETWEEN 1 AND 128),
  current_generation_id TEXT NOT NULL CHECK(length(trim(current_generation_id)) BETWEEN 1 AND 200),
  access_terms_id TEXT NOT NULL,
  access_terms_kind TEXT NOT NULL CHECK(access_terms_kind IN ('customer','collaborator')),
  access_terms_mode TEXT NOT NULL CHECK(access_terms_mode IN ('specific_date','project_end','until_revoked')),
  reviewed_expires_at TEXT,
  effective_expires_at TEXT,
  expires_at TEXT,
  reason_code TEXT NOT NULL CHECK(length(trim(reason_code)) BETWEEN 1 AND 80 AND reason_code NOT GLOB '*[^A-Za-z0-9_. -]*'),
  owner_staff_id TEXT NOT NULL CHECK(length(trim(owner_staff_id)) BETWEEN 1 AND 200),
  owner_access_subject TEXT NOT NULL CHECK(length(trim(owner_access_subject)) BETWEEN 1 AND 512),
  owner_admission_version INTEGER NOT NULL CHECK(owner_admission_version>=1),
  owner_profile_version INTEGER NOT NULL CHECK(owner_profile_version>=1),
  owner_grant_generation INTEGER NOT NULL CHECK(owner_grant_generation>=1),
  owner_verified_until TEXT NOT NULL CHECK(datetime(owner_verified_until) IS NOT NULL),
  authority_revision INTEGER NOT NULL CHECK(authority_revision>=1),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  last_operation_id TEXT NOT NULL UNIQUE,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(access_terms_kind<>'customer' OR access_terms_mode='until_revoked'),
  CHECK((access_terms_mode='specific_date' AND reviewed_expires_at IS NOT NULL AND effective_expires_at=reviewed_expires_at AND expires_at=effective_expires_at)
    OR (access_terms_mode='project_end' AND reviewed_expires_at IS NULL AND expires_at=effective_expires_at)
    OR (access_terms_mode='until_revoked' AND reviewed_expires_at IS NULL AND effective_expires_at IS NULL AND expires_at IS NULL)),
  CHECK((state='active' AND revoked_at IS NULL) OR (state='revoked' AND revoked_at IS NOT NULL)),
  FOREIGN KEY(workspace_id) REFERENCES portal_v2_workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY(folder_binding_id,workspace_id) REFERENCES portal_v2_folder_bindings(id,workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY(selection_id) REFERENCES portal_client_authority_workspace_binding_receipts(operation_id) ON DELETE RESTRICT
);

CREATE INDEX idx_verified_recipient_delivery_authority_active
  ON portal_verified_recipient_delivery_authority_heads(workspace_id,state,issuer,subject);
CREATE UNIQUE INDEX idx_verified_recipient_delivery_authority_active_target
  ON portal_verified_recipient_delivery_authority_heads(recipient_binding_id,folder_binding_id)
  WHERE state='active';

CREATE TABLE portal_verified_recipient_delivery_authority_audit (
  operation_id TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^a-f0-9]*'),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  authority_id TEXT NOT NULL,
  client_record_id TEXT NOT NULL CHECK(length(trim(client_record_id)) BETWEEN 1 AND 200),
  action TEXT NOT NULL CHECK(action IN ('upsert','revoke')),
  expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
  resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1),
  resulting_state TEXT NOT NULL CHECK(resulting_state IN ('active','revoked')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(authority_id) REFERENCES portal_verified_recipient_delivery_authority_heads(authority_id) ON DELETE RESTRICT
);

CREATE TABLE portal_verified_recipient_delivery_authority_receipts (
  operation_id TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^a-f0-9]*'),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  authority_id TEXT NOT NULL,
  client_record_id TEXT NOT NULL CHECK(length(trim(client_record_id)) BETWEEN 1 AND 200),
  action TEXT NOT NULL CHECK(action IN ('upsert','revoke')),
  expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
  resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1),
  resulting_state TEXT NOT NULL CHECK(resulting_state IN ('active','revoked')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(operation_id) REFERENCES portal_verified_recipient_delivery_authority_audit(operation_id) ON DELETE RESTRICT,
  FOREIGN KEY(authority_id) REFERENCES portal_verified_recipient_delivery_authority_heads(authority_id) ON DELETE RESTRICT
);

-- Operation IDs share one namespace with the existing Client authority and
-- workspace-binding ledgers in this database. Both directions are fenced.
CREATE TRIGGER verified_recipient_delivery_audit_operation_namespace_guard
BEFORE INSERT ON portal_verified_recipient_delivery_authority_audit
WHEN EXISTS(SELECT 1 FROM portal_operations_authority_v2_audit WHERE operation_id=NEW.operation_id)
  OR EXISTS(SELECT 1 FROM portal_operations_authority_v2_receipts WHERE operation_id=NEW.operation_id)
  OR EXISTS(SELECT 1 FROM portal_client_authority_workspace_binding_audit WHERE operation_id=NEW.operation_id)
  OR EXISTS(SELECT 1 FROM portal_client_authority_workspace_binding_receipts WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'verified-recipient-operation-id-collision'); END;

CREATE TRIGGER verified_recipient_delivery_receipt_operation_namespace_guard
BEFORE INSERT ON portal_verified_recipient_delivery_authority_receipts
WHEN EXISTS(SELECT 1 FROM portal_operations_authority_v2_audit WHERE operation_id=NEW.operation_id)
  OR EXISTS(SELECT 1 FROM portal_operations_authority_v2_receipts WHERE operation_id=NEW.operation_id)
  OR EXISTS(SELECT 1 FROM portal_client_authority_workspace_binding_audit WHERE operation_id=NEW.operation_id)
  OR EXISTS(SELECT 1 FROM portal_client_authority_workspace_binding_receipts WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'verified-recipient-operation-id-collision'); END;

CREATE TRIGGER portal_operations_authority_v2_audit_verified_recipient_namespace_guard
BEFORE INSERT ON portal_operations_authority_v2_audit
WHEN EXISTS(SELECT 1 FROM portal_verified_recipient_delivery_authority_audit WHERE operation_id=NEW.operation_id)
  OR EXISTS(SELECT 1 FROM portal_verified_recipient_delivery_authority_receipts WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'verified-recipient-operation-id-collision'); END;

CREATE TRIGGER portal_operations_authority_v2_receipt_verified_recipient_namespace_guard
BEFORE INSERT ON portal_operations_authority_v2_receipts
WHEN EXISTS(SELECT 1 FROM portal_verified_recipient_delivery_authority_audit WHERE operation_id=NEW.operation_id)
  OR EXISTS(SELECT 1 FROM portal_verified_recipient_delivery_authority_receipts WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'verified-recipient-operation-id-collision'); END;

CREATE TRIGGER portal_client_authority_binding_audit_verified_recipient_namespace_guard
BEFORE INSERT ON portal_client_authority_workspace_binding_audit
WHEN EXISTS(SELECT 1 FROM portal_verified_recipient_delivery_authority_audit WHERE operation_id=NEW.operation_id)
  OR EXISTS(SELECT 1 FROM portal_verified_recipient_delivery_authority_receipts WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'verified-recipient-operation-id-collision'); END;

CREATE TRIGGER portal_client_authority_binding_receipt_verified_recipient_namespace_guard
BEFORE INSERT ON portal_client_authority_workspace_binding_receipts
WHEN EXISTS(SELECT 1 FROM portal_verified_recipient_delivery_authority_audit WHERE operation_id=NEW.operation_id)
  OR EXISTS(SELECT 1 FROM portal_verified_recipient_delivery_authority_receipts WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'verified-recipient-operation-id-collision'); END;

CREATE TRIGGER verified_recipient_delivery_head_insert_guard
BEFORE INSERT ON portal_verified_recipient_delivery_authority_heads
WHEN NEW.authority_revision<>1 OR NEW.state<>'active'
  OR NOT EXISTS(SELECT 1 FROM portal_client_authority_workspace_binding_receipts receipt
    JOIN portal_client_authority_workspace_bindings binding ON binding.operation_id=receipt.operation_id
    JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id AND workspace.status='active'
    WHERE receipt.operation_id=NEW.selection_id AND receipt.client_authority_id=NEW.client_authority_id
      AND receipt.workspace_id=NEW.workspace_id AND binding.state='inactive' AND binding.revision=1)
BEGIN SELECT RAISE(ABORT,'verified-recipient-authority-requires-binding-receipt'); END;

-- The application preflight is advisory only. This fence repeats the complete
-- current publication proof in the same write transaction, so a source,
-- generation, terms, home-grant, or publication change between preflight and
-- INSERT or active renewal fails closed instead of recording stale authority.
CREATE TRIGGER verified_recipient_delivery_head_current_proof_guard
BEFORE INSERT ON portal_verified_recipient_delivery_authority_heads
WHEN NOT EXISTS(
  SELECT 1
  FROM portal_operations_workspace_authority_heads workspace_head
  JOIN portal_client_authority_workspace_binding_receipts binding_receipt
    ON binding_receipt.operation_id=workspace_head.binding_operation_id
  JOIN portal_client_authority_workspace_bindings binding
    ON binding.operation_id=binding_receipt.operation_id
  JOIN portal_v2_workspaces workspace
    ON workspace.id=workspace_head.workspace_id AND workspace.status='active'
  JOIN portal_operations_principal_grant_heads grant_head
    ON grant_head.workspace_id=workspace_head.workspace_id
    AND grant_head.client_authority_id=workspace_head.client_authority_id
    AND grant_head.issuer=NEW.issuer AND grant_head.subject=NEW.subject
  JOIN portal_operations_authority_v2_receipts home_receipt
    ON home_receipt.operation_id=grant_head.last_operation_id
    AND home_receipt.operation_id=NEW.home_grant_operation_id
    AND home_receipt.client_authority_id=grant_head.client_authority_id
    AND home_receipt.workspace_id=grant_head.workspace_id
    AND home_receipt.issuer=grant_head.issuer AND home_receipt.subject=grant_head.subject
    AND home_receipt.ownership_epoch=grant_head.ownership_epoch
    AND home_receipt.grant_revision=grant_head.grant_revision
    AND home_receipt.resulting_state='active' AND home_receipt.protocol_version=3
    AND home_receipt.permissions_json='["operations.service_home.read"]'
  JOIN portal_v2_folder_bindings folder
    ON folder.id=NEW.folder_binding_id AND folder.workspace_id=workspace.id
    AND folder.source_version=NEW.folder_binding_source_version
    AND folder.status='active' AND folder.revoked_at IS NULL
    AND folder.owner_scope_type='project' AND folder.owner_public_id=NEW.project_public_id
  JOIN portal_v2_directory_checkpoints checkpoint
    ON checkpoint.workspace_id=workspace.id AND checkpoint.active_generation_id=NEW.current_generation_id
  JOIN portal_v2_directory_generations generation
    ON generation.id=checkpoint.active_generation_id AND generation.workspace_id=workspace.id
    AND generation.status='active' AND generation.complete=1
  JOIN portal_v2_directory_entities project
    ON project.workspace_id=workspace.id AND project.generation_id=generation.id
    AND project.entity_type='project' AND project.public_id=NEW.project_public_id
    AND project.source_version=NEW.project_source_version AND project.active=1
  LEFT JOIN portal_project_access_deadlines deadline
    ON deadline.access_terms_id=NEW.access_terms_id
  JOIN portal_project_access_terms terms
    ON terms.id=NEW.access_terms_id AND terms.workspace_id=workspace.id
    AND terms.source_id=workspace.project_alpha_source_id
    AND terms.project_public_id=project.public_id
    AND terms.kind=NEW.access_terms_kind AND terms.mode=NEW.access_terms_mode
    AND terms.expires_at IS NEW.reviewed_expires_at
    AND (CASE WHEN terms.mode='project_end' THEN deadline.deadline_at ELSE terms.expires_at END) IS NEW.effective_expires_at
  WHERE workspace_head.workspace_id=NEW.workspace_id
    AND workspace_head.client_authority_id=NEW.client_authority_id
    AND workspace_head.binding_operation_id=NEW.selection_id
    AND binding_receipt.operation_id=NEW.selection_id
    AND workspace_head.ownership_epoch=NEW.home_ownership_epoch
    AND workspace_head.state='active'
    AND binding_receipt.client_authority_id=NEW.client_authority_id
    AND binding_receipt.workspace_id=NEW.workspace_id
    AND binding.state='inactive' AND binding.revision=1
    AND grant_head.ownership_epoch=NEW.home_ownership_epoch
    AND grant_head.grant_revision=NEW.home_grant_revision
    AND grant_head.last_operation_id=NEW.home_grant_operation_id
    AND grant_head.state='active'
    AND workspace.project_alpha_source_id=NEW.source_id
    AND datetime(NEW.owner_verified_until)>datetime('now')
    AND NOT EXISTS(SELECT 1 FROM portal_v2_root_access_policies root_policy
      WHERE root_policy.projection_source_id=workspace.project_alpha_source_id
        AND root_policy.root_type=workspace.root_type
        AND root_policy.root_public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id)
        AND root_policy.state='revoked')
    AND (
      EXISTS(SELECT 1 FROM portal_primary_staff_bindings primary_binding
        WHERE primary_binding.binding_id=folder.id AND primary_binding.workspace_id=workspace.id
          AND primary_binding.source_id=NEW.source_id AND primary_binding.owner_scope_type='project'
          AND primary_binding.project_public_id=project.public_id
          AND primary_binding.directory_generation_id=generation.id
          AND primary_binding.project_source_version=project.source_version
          AND primary_binding.state='active')
      OR EXISTS(SELECT 1 FROM portal_native_staff_bindings native_binding
        JOIN pa_portal_source_authorities source_authority
          ON source_authority.source_id=native_binding.source_id AND source_authority.state='active'
        JOIN pa_portal_source_authority_revisions source_revision
          ON source_revision.source_id=source_authority.source_id
          AND source_revision.revision=source_authority.active_revision
        JOIN portal_native_staff_grants native_grant
          ON native_grant.binding_id=native_binding.binding_id AND native_grant.source_id=native_binding.source_id
          AND native_grant.state='active'
        JOIN portal_native_staff_grant_events publication
          ON publication.grant_id=native_grant.grant_id AND publication.authorization_id=native_grant.authorization_id
          AND publication.action='published'
        JOIN portal_v2_authenticated_delivery_grants published_grant
          ON published_grant.id=native_grant.grant_id AND published_grant.workspace_id=native_binding.workspace_id
          AND published_grant.folder_binding_id=folder.id AND published_grant.binding_source_version=folder.source_version
          AND published_grant.status='active' AND published_grant.revoked_at IS NULL
        WHERE native_binding.binding_id=folder.id AND native_binding.workspace_id=workspace.id
          AND native_binding.source_id=NEW.source_id AND native_binding.project_public_id=project.public_id))
    AND (terms.mode='until_revoked'
      OR (terms.mode='specific_date' AND datetime(terms.expires_at)>datetime('now'))
      OR (terms.mode='project_end' AND ((deadline.deadline_at IS NOT NULL AND datetime(deadline.deadline_at)>datetime('now'))
        OR (deadline.deadline_at IS NULL AND EXISTS(SELECT 1 FROM portal_project_access_current_lifecycle lifecycle
          WHERE lifecycle.workspace_id=terms.workspace_id AND lifecycle.source_id=terms.source_id
            AND lifecycle.project_public_id=terms.project_public_id AND lifecycle.lifecycle_status='active')))))
)
BEGIN SELECT RAISE(ABORT,'verified-recipient-current-proof-required'); END;

-- Renewals re-pin mutable current proof, so repeat the same insertion fence in
-- the transaction containing the CAS update. Revocation remains deny-first and
-- is deliberately excluded from this availability proof.
CREATE TRIGGER verified_recipient_delivery_head_renewal_current_proof_guard
BEFORE UPDATE ON portal_verified_recipient_delivery_authority_heads
WHEN NEW.state='active' AND NOT EXISTS(
  SELECT 1
  FROM portal_operations_workspace_authority_heads workspace_head
  JOIN portal_client_authority_workspace_binding_receipts binding_receipt ON binding_receipt.operation_id=workspace_head.binding_operation_id
  JOIN portal_client_authority_workspace_bindings binding ON binding.operation_id=binding_receipt.operation_id
  JOIN portal_v2_workspaces workspace ON workspace.id=workspace_head.workspace_id AND workspace.status='active'
  JOIN portal_operations_principal_grant_heads grant_head ON grant_head.workspace_id=workspace_head.workspace_id
    AND grant_head.client_authority_id=workspace_head.client_authority_id AND grant_head.issuer=NEW.issuer AND grant_head.subject=NEW.subject
  JOIN portal_operations_authority_v2_receipts home_receipt ON home_receipt.operation_id=grant_head.last_operation_id
    AND home_receipt.operation_id=NEW.home_grant_operation_id AND home_receipt.client_authority_id=grant_head.client_authority_id
    AND home_receipt.workspace_id=grant_head.workspace_id AND home_receipt.issuer=grant_head.issuer AND home_receipt.subject=grant_head.subject
    AND home_receipt.ownership_epoch=grant_head.ownership_epoch AND home_receipt.grant_revision=grant_head.grant_revision
    AND home_receipt.resulting_state='active' AND home_receipt.protocol_version=3
    AND home_receipt.permissions_json='["operations.service_home.read"]'
  JOIN portal_v2_folder_bindings folder ON folder.id=NEW.folder_binding_id AND folder.workspace_id=workspace.id
    AND folder.source_version=NEW.folder_binding_source_version AND folder.status='active' AND folder.revoked_at IS NULL
    AND folder.owner_scope_type='project' AND folder.owner_public_id=NEW.project_public_id
  JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id AND checkpoint.active_generation_id=NEW.current_generation_id
  JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id AND generation.workspace_id=workspace.id
    AND generation.status='active' AND generation.complete=1
  JOIN portal_v2_directory_entities project ON project.workspace_id=workspace.id AND project.generation_id=generation.id
    AND project.entity_type='project' AND project.public_id=NEW.project_public_id AND project.source_version=NEW.project_source_version AND project.active=1
  LEFT JOIN portal_project_access_deadlines deadline ON deadline.access_terms_id=NEW.access_terms_id
  JOIN portal_project_access_terms terms ON terms.id=NEW.access_terms_id AND terms.workspace_id=workspace.id
    AND terms.source_id=workspace.project_alpha_source_id AND terms.project_public_id=project.public_id
    AND terms.kind=NEW.access_terms_kind AND terms.mode=NEW.access_terms_mode AND terms.expires_at IS NEW.reviewed_expires_at
    AND (CASE WHEN terms.mode='project_end' THEN deadline.deadline_at ELSE terms.expires_at END) IS NEW.effective_expires_at
  WHERE workspace_head.workspace_id=NEW.workspace_id AND workspace_head.client_authority_id=NEW.client_authority_id
    AND workspace_head.binding_operation_id=NEW.selection_id AND binding_receipt.operation_id=NEW.selection_id
    AND workspace_head.ownership_epoch=NEW.home_ownership_epoch AND workspace_head.state='active'
    AND binding_receipt.client_authority_id=NEW.client_authority_id AND binding_receipt.workspace_id=NEW.workspace_id
    AND binding.state='inactive' AND binding.revision=1
    AND grant_head.ownership_epoch=NEW.home_ownership_epoch AND grant_head.grant_revision=NEW.home_grant_revision
    AND grant_head.last_operation_id=NEW.home_grant_operation_id AND grant_head.state='active'
    AND workspace.project_alpha_source_id=NEW.source_id AND datetime(NEW.owner_verified_until)>datetime('now')
    AND NOT EXISTS(SELECT 1 FROM portal_v2_root_access_policies root_policy
      WHERE root_policy.projection_source_id=workspace.project_alpha_source_id AND root_policy.root_type=workspace.root_type
        AND root_policy.root_public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) AND root_policy.state='revoked')
    AND (EXISTS(SELECT 1 FROM portal_primary_staff_bindings primary_binding
      WHERE primary_binding.binding_id=folder.id AND primary_binding.workspace_id=workspace.id AND primary_binding.source_id=NEW.source_id
        AND primary_binding.owner_scope_type='project' AND primary_binding.project_public_id=project.public_id
        AND primary_binding.directory_generation_id=generation.id AND primary_binding.project_source_version=project.source_version
        AND primary_binding.state='active')
      OR EXISTS(SELECT 1 FROM portal_native_staff_bindings native_binding
        JOIN pa_portal_source_authorities source_authority ON source_authority.source_id=native_binding.source_id AND source_authority.state='active'
        JOIN pa_portal_source_authority_revisions source_revision ON source_revision.source_id=source_authority.source_id AND source_revision.revision=source_authority.active_revision
        JOIN portal_native_staff_grants native_grant ON native_grant.binding_id=native_binding.binding_id AND native_grant.source_id=native_binding.source_id AND native_grant.state='active'
        JOIN portal_native_staff_grant_events publication ON publication.grant_id=native_grant.grant_id AND publication.authorization_id=native_grant.authorization_id AND publication.action='published'
        JOIN portal_v2_authenticated_delivery_grants published_grant ON published_grant.id=native_grant.grant_id
          AND published_grant.workspace_id=native_binding.workspace_id AND published_grant.folder_binding_id=folder.id
          AND published_grant.binding_source_version=folder.source_version AND published_grant.status='active' AND published_grant.revoked_at IS NULL
        WHERE native_binding.binding_id=folder.id AND native_binding.workspace_id=workspace.id
          AND native_binding.source_id=NEW.source_id AND native_binding.project_public_id=project.public_id))
    AND (terms.mode='until_revoked' OR (terms.mode='specific_date' AND datetime(terms.expires_at)>datetime('now'))
      OR (terms.mode='project_end' AND ((deadline.deadline_at IS NOT NULL AND datetime(deadline.deadline_at)>datetime('now'))
        OR (deadline.deadline_at IS NULL AND EXISTS(SELECT 1 FROM portal_project_access_current_lifecycle lifecycle
          WHERE lifecycle.workspace_id=terms.workspace_id AND lifecycle.source_id=terms.source_id
            AND lifecycle.project_public_id=terms.project_public_id AND lifecycle.lifecycle_status='active')))))
)
BEGIN SELECT RAISE(ABORT,'verified-recipient-current-proof-required'); END;

CREATE TRIGGER verified_recipient_delivery_head_update_guard
BEFORE UPDATE ON portal_verified_recipient_delivery_authority_heads
WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.client_authority_id IS NOT OLD.client_authority_id OR NEW.selection_id IS NOT OLD.selection_id
  OR NEW.client_record_id IS NOT OLD.client_record_id
  OR NEW.recipient_binding_id IS NOT OLD.recipient_binding_id OR NEW.enrollment_intent_id IS NOT OLD.enrollment_intent_id
  OR NEW.enrollment_revision<>OLD.enrollment_revision OR NEW.issuer IS NOT OLD.issuer OR NEW.subject IS NOT OLD.subject
  OR NEW.folder_binding_id IS NOT OLD.folder_binding_id OR NEW.source_id IS NOT OLD.source_id
  OR NEW.project_public_id IS NOT OLD.project_public_id
  OR NEW.created_at IS NOT OLD.created_at OR NEW.authority_revision<>OLD.authority_revision+1
  OR NEW.last_operation_id IS OLD.last_operation_id OR OLD.state='revoked'
  OR (OLD.state='active' AND NEW.state NOT IN ('active','revoked'))
  OR (OLD.state='active' AND NEW.state='active' AND NEW.revoked_at IS NOT NULL)
  OR (OLD.state='active' AND NEW.state='revoked' AND NEW.revoked_at IS NULL)
BEGIN SELECT RAISE(ABORT,'verified-recipient-authority-cas-denied'); END;

CREATE TRIGGER verified_recipient_delivery_head_no_delete
BEFORE DELETE ON portal_verified_recipient_delivery_authority_heads
BEGIN SELECT RAISE(ABORT,'verified-recipient-authority-is-durable'); END;

CREATE TRIGGER verified_recipient_delivery_audit_guard
BEFORE INSERT ON portal_verified_recipient_delivery_authority_audit
WHEN NOT EXISTS(SELECT 1 FROM portal_verified_recipient_delivery_authority_heads head
  WHERE head.authority_id=NEW.authority_id AND head.last_operation_id=NEW.operation_id
    AND head.authority_revision=NEW.resulting_revision
    AND head.state=NEW.resulting_state
    AND NEW.client_record_id=head.client_record_id
    AND json_extract(NEW.request_json,'$.protocol')='verified-recipient-delivery-authority'
    AND json_extract(NEW.request_json,'$.protocolVersion')=1
    AND json_extract(NEW.request_json,'$.operationId')=NEW.operation_id
    AND json_extract(NEW.request_json,'$.action')=NEW.action
    AND json_extract(NEW.request_json,'$.authority.authorityId')=head.authority_id
    AND json_extract(NEW.request_json,'$.authority.expectedRevision')=NEW.expected_revision
    AND json_extract(NEW.request_json,'$.authority.resultingRevision')=NEW.resulting_revision
    AND json_extract(NEW.request_json,'$.selection.workspaceId')=head.workspace_id
    AND json_extract(NEW.request_json,'$.selection.clientAuthorityId')=head.client_authority_id
    AND json_extract(NEW.request_json,'$.selection.selectionId')=head.selection_id
    AND json_extract(NEW.request_json,'$.selection.clientRecordId')=head.client_record_id
    AND json_extract(NEW.request_json,'$.recipient.recipientBindingId')=head.recipient_binding_id
    AND json_extract(NEW.request_json,'$.recipient.enrollmentIntentId')=head.enrollment_intent_id
    AND json_extract(NEW.request_json,'$.recipient.enrollmentRevision')=head.enrollment_revision
    AND json_extract(NEW.request_json,'$.recipient.issuer')=head.issuer
    AND json_extract(NEW.request_json,'$.recipient.subject')=head.subject
    AND json_extract(NEW.request_json,'$.homeAuthority.ownershipEpoch')=head.home_ownership_epoch
    AND json_extract(NEW.request_json,'$.homeAuthority.grantRevision')=head.home_grant_revision
    AND json_extract(NEW.request_json,'$.homeAuthority.grantOperationId')=head.home_grant_operation_id
    AND json_extract(NEW.request_json,'$.resource.folderBindingId')=head.folder_binding_id
    AND json_extract(NEW.request_json,'$.resource.folderBindingSourceVersion')=head.folder_binding_source_version
    AND json_extract(NEW.request_json,'$.resource.sourceId')=head.source_id
    AND json_extract(NEW.request_json,'$.resource.projectPublicId')=head.project_public_id
    AND json_extract(NEW.request_json,'$.resource.projectSourceVersion')=head.project_source_version
    AND json_extract(NEW.request_json,'$.resource.currentGenerationId')=head.current_generation_id
    AND json_extract(NEW.request_json,'$.terms.accessTerms.id')=head.access_terms_id
    AND json_extract(NEW.request_json,'$.terms.accessTerms.kind')=head.access_terms_kind
    AND json_extract(NEW.request_json,'$.terms.accessTerms.mode')=head.access_terms_mode
    AND json_extract(NEW.request_json,'$.terms.accessTerms.reviewedExpiresAt') IS head.reviewed_expires_at
    AND json_extract(NEW.request_json,'$.terms.accessTerms.effectiveExpiresAt') IS head.effective_expires_at
    AND json_extract(NEW.request_json,'$.terms.expiresAt') IS head.expires_at
    AND json_extract(NEW.request_json,'$.terms.reasonCode')=head.reason_code
    AND json_extract(NEW.request_json,'$.ownerProof.staffId')=head.owner_staff_id
    AND json_extract(NEW.request_json,'$.ownerProof.verifiedAccessSubject')=head.owner_access_subject
    AND json_extract(NEW.request_json,'$.ownerProof.admissionVersion')=head.owner_admission_version
    AND json_extract(NEW.request_json,'$.ownerProof.profileVersion')=head.owner_profile_version
    AND json_extract(NEW.request_json,'$.ownerProof.grantGeneration')=head.owner_grant_generation
    AND json_extract(NEW.request_json,'$.ownerProof.verifiedUntil')=head.owner_verified_until
    AND ((NEW.action='upsert' AND NEW.resulting_state='active') OR (NEW.action='revoke' AND NEW.resulting_state='revoked')))
BEGIN SELECT RAISE(ABORT,'verified-recipient-audit-requires-exact-post-cas-head'); END;

CREATE TRIGGER verified_recipient_delivery_audit_no_update
BEFORE UPDATE ON portal_verified_recipient_delivery_authority_audit
BEGIN SELECT RAISE(ABORT,'verified-recipient-authority-audit-is-immutable'); END;
CREATE TRIGGER verified_recipient_delivery_audit_no_delete
BEFORE DELETE ON portal_verified_recipient_delivery_authority_audit
BEGIN SELECT RAISE(ABORT,'verified-recipient-authority-audit-is-immutable'); END;

CREATE TRIGGER verified_recipient_delivery_receipt_guard
BEFORE INSERT ON portal_verified_recipient_delivery_authority_receipts
WHEN NOT EXISTS(SELECT 1 FROM portal_verified_recipient_delivery_authority_audit audit
  WHERE audit.operation_id=NEW.operation_id AND audit.request_fingerprint=NEW.request_fingerprint
    AND audit.request_json=NEW.request_json AND audit.authority_id=NEW.authority_id
    AND audit.client_record_id=NEW.client_record_id
    AND audit.action=NEW.action AND audit.expected_revision=NEW.expected_revision
    AND audit.resulting_revision=NEW.resulting_revision AND audit.resulting_state=NEW.resulting_state)
BEGIN SELECT RAISE(ABORT,'verified-recipient-receipt-requires-exact-immutable-audit'); END;

CREATE TRIGGER verified_recipient_delivery_receipt_no_update
BEFORE UPDATE ON portal_verified_recipient_delivery_authority_receipts
BEGIN SELECT RAISE(ABORT,'verified-recipient-authority-receipt-is-immutable'); END;
CREATE TRIGGER verified_recipient_delivery_receipt_no_delete
BEFORE DELETE ON portal_verified_recipient_delivery_authority_receipts
BEGIN SELECT RAISE(ABORT,'verified-recipient-authority-receipt-is-immutable'); END;
