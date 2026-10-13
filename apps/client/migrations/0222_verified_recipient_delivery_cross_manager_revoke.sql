PRAGMA foreign_keys = ON;

-- A revoke is delivered only through the authenticated private Ops binding.
-- Ops has already durably authorized the command actor. Preserve the active
-- grant owner's proof on the head and record the distinct revoker on the
-- immutable operation audit without weakening creation or renewal fences.

-- Refuse to migrate a database whose existing head cannot be traced to one
-- exact revision-1 canonical upsert audit. Never invent creation provenance.
CREATE TABLE portal_verified_recipient_delivery_0222_assert (
  ok INTEGER NOT NULL CHECK(ok=1)
);
INSERT INTO portal_verified_recipient_delivery_0222_assert(ok)
SELECT CASE WHEN EXISTS(
  SELECT 1 FROM portal_verified_recipient_delivery_authority_heads head
  WHERE (SELECT count(*) FROM portal_verified_recipient_delivery_authority_audit audit
    WHERE audit.authority_id=head.authority_id AND audit.action='upsert'
      AND audit.expected_revision=0 AND audit.resulting_revision=1 AND audit.resulting_state='active'
      AND json_extract(audit.request_json,'$.protocol')='verified-recipient-delivery-authority'
      AND json_extract(audit.request_json,'$.protocolVersion')=1
      AND json_extract(audit.request_json,'$.operationId')=audit.operation_id
      AND json_extract(audit.request_json,'$.authority.authorityId')=head.authority_id
      AND json_extract(audit.request_json,'$.authority.expectedRevision')=0
      AND json_extract(audit.request_json,'$.authority.resultingRevision')=1
      AND EXISTS(SELECT 1 FROM portal_verified_recipient_delivery_authority_receipts receipt
        WHERE receipt.operation_id=audit.operation_id
          AND receipt.request_fingerprint=audit.request_fingerprint
          AND receipt.request_json=audit.request_json
          AND receipt.authority_id=audit.authority_id
          AND receipt.client_record_id=audit.client_record_id
          AND receipt.action=audit.action
          AND receipt.expected_revision=audit.expected_revision
          AND receipt.resulting_revision=audit.resulting_revision
          AND receipt.resulting_state=audit.resulting_state))<>1
) THEN 0 ELSE 1 END;
INSERT INTO portal_verified_recipient_delivery_0222_assert(ok)
SELECT CASE WHEN EXISTS(
  SELECT 1 FROM portal_verified_recipient_delivery_authority_heads head
  WHERE NOT EXISTS(SELECT 1 FROM portal_verified_recipient_delivery_authority_audit audit
    WHERE audit.authority_id=head.authority_id AND audit.action='upsert'
      AND audit.expected_revision=0 AND audit.resulting_revision=1
      AND json_extract(audit.request_json,'$.selection.workspaceId')=head.workspace_id
      AND json_extract(audit.request_json,'$.selection.clientAuthorityId')=head.client_authority_id
      AND json_extract(audit.request_json,'$.selection.selectionId')=head.selection_id
      AND json_extract(audit.request_json,'$.selection.clientRecordId')=head.client_record_id
      AND json_extract(audit.request_json,'$.recipient.recipientBindingId')=head.recipient_binding_id
      AND json_extract(audit.request_json,'$.recipient.enrollmentIntentId')=head.enrollment_intent_id
      AND json_extract(audit.request_json,'$.recipient.enrollmentRevision')=head.enrollment_revision
      AND json_extract(audit.request_json,'$.recipient.issuer')=head.issuer
      AND json_extract(audit.request_json,'$.recipient.subject')=head.subject)
) THEN 0 ELSE 1 END;
INSERT INTO portal_verified_recipient_delivery_0222_assert(ok)
SELECT CASE WHEN EXISTS(
  SELECT 1 FROM portal_verified_recipient_delivery_authority_heads head
  WHERE NOT EXISTS(SELECT 1 FROM portal_verified_recipient_delivery_authority_audit audit
    WHERE audit.authority_id=head.authority_id AND audit.action='upsert'
      AND audit.expected_revision=0 AND audit.resulting_revision=1
      AND json_extract(audit.request_json,'$.resource.folderBindingId')=head.folder_binding_id
      AND json_extract(audit.request_json,'$.resource.sourceId')=head.source_id
      AND json_extract(audit.request_json,'$.resource.projectPublicId')=head.project_public_id
      AND json_type(audit.request_json,'$.ownerProof.staffId')='text'
      AND json_type(audit.request_json,'$.ownerProof.verifiedAccessSubject')='text'
      AND json_type(audit.request_json,'$.ownerProof.admissionVersion')='integer'
      AND json_type(audit.request_json,'$.ownerProof.profileVersion')='integer'
      AND json_type(audit.request_json,'$.ownerProof.grantGeneration')='integer'
      AND json_type(audit.request_json,'$.ownerProof.verifiedUntil')='text')
) THEN 0 ELSE 1 END;
DROP TABLE portal_verified_recipient_delivery_0222_assert;

DROP TRIGGER verified_recipient_delivery_head_update_guard;
DROP TRIGGER verified_recipient_delivery_head_renewal_current_proof_guard;
DROP TRIGGER verified_recipient_delivery_audit_guard;
DROP TRIGGER verified_recipient_delivery_audit_no_update;

ALTER TABLE portal_verified_recipient_delivery_authority_heads ADD COLUMN created_operation_id TEXT
  CHECK(created_operation_id IS NULL OR length(created_operation_id)=36);
ALTER TABLE portal_verified_recipient_delivery_authority_heads ADD COLUMN created_request_fingerprint TEXT
  CHECK(created_request_fingerprint IS NULL OR (length(created_request_fingerprint)=64
    AND created_request_fingerprint NOT GLOB '*[^a-f0-9]*'));
ALTER TABLE portal_verified_recipient_delivery_authority_heads ADD COLUMN created_by_staff_id TEXT
  CHECK(created_by_staff_id IS NULL OR length(trim(created_by_staff_id)) BETWEEN 1 AND 200);
ALTER TABLE portal_verified_recipient_delivery_authority_heads ADD COLUMN created_by_access_subject TEXT
  CHECK(created_by_access_subject IS NULL OR length(trim(created_by_access_subject)) BETWEEN 1 AND 512);
ALTER TABLE portal_verified_recipient_delivery_authority_heads ADD COLUMN created_by_admission_version INTEGER
  CHECK(created_by_admission_version IS NULL OR created_by_admission_version>=1);
ALTER TABLE portal_verified_recipient_delivery_authority_heads ADD COLUMN created_by_profile_version INTEGER
  CHECK(created_by_profile_version IS NULL OR created_by_profile_version>=1);
ALTER TABLE portal_verified_recipient_delivery_authority_heads ADD COLUMN created_by_grant_generation INTEGER
  CHECK(created_by_grant_generation IS NULL OR created_by_grant_generation>=1);
ALTER TABLE portal_verified_recipient_delivery_authority_heads ADD COLUMN created_by_verified_until TEXT
  CHECK(created_by_verified_until IS NULL OR datetime(created_by_verified_until) IS NOT NULL);

ALTER TABLE portal_verified_recipient_delivery_authority_audit ADD COLUMN actor_staff_id TEXT
  CHECK(actor_staff_id IS NULL OR length(trim(actor_staff_id)) BETWEEN 1 AND 200);
ALTER TABLE portal_verified_recipient_delivery_authority_audit ADD COLUMN actor_access_subject TEXT
  CHECK(actor_access_subject IS NULL OR length(trim(actor_access_subject)) BETWEEN 1 AND 512);
ALTER TABLE portal_verified_recipient_delivery_authority_audit ADD COLUMN actor_admission_version INTEGER
  CHECK(actor_admission_version IS NULL OR actor_admission_version>=1);
ALTER TABLE portal_verified_recipient_delivery_authority_audit ADD COLUMN actor_profile_version INTEGER
  CHECK(actor_profile_version IS NULL OR actor_profile_version>=1);
ALTER TABLE portal_verified_recipient_delivery_authority_audit ADD COLUMN actor_grant_generation INTEGER
  CHECK(actor_grant_generation IS NULL OR actor_grant_generation>=1);
ALTER TABLE portal_verified_recipient_delivery_authority_audit ADD COLUMN actor_verified_until TEXT
  CHECK(actor_verified_until IS NULL OR datetime(actor_verified_until) IS NOT NULL);

UPDATE portal_verified_recipient_delivery_authority_heads AS head SET
  created_operation_id=(SELECT audit.operation_id FROM portal_verified_recipient_delivery_authority_audit audit
    WHERE audit.authority_id=head.authority_id AND audit.action='upsert' AND audit.expected_revision=0 AND audit.resulting_revision=1),
  created_request_fingerprint=(SELECT audit.request_fingerprint FROM portal_verified_recipient_delivery_authority_audit audit
    WHERE audit.authority_id=head.authority_id AND audit.action='upsert' AND audit.expected_revision=0 AND audit.resulting_revision=1),
  created_by_staff_id=(SELECT json_extract(audit.request_json,'$.ownerProof.staffId')
    FROM portal_verified_recipient_delivery_authority_audit audit WHERE audit.authority_id=head.authority_id
      AND audit.action='upsert' AND audit.expected_revision=0 AND audit.resulting_revision=1),
  created_by_access_subject=(SELECT json_extract(audit.request_json,'$.ownerProof.verifiedAccessSubject')
    FROM portal_verified_recipient_delivery_authority_audit audit WHERE audit.authority_id=head.authority_id
      AND audit.action='upsert' AND audit.expected_revision=0 AND audit.resulting_revision=1),
  created_by_admission_version=(SELECT json_extract(audit.request_json,'$.ownerProof.admissionVersion')
    FROM portal_verified_recipient_delivery_authority_audit audit WHERE audit.authority_id=head.authority_id
      AND audit.action='upsert' AND audit.expected_revision=0 AND audit.resulting_revision=1),
  created_by_profile_version=(SELECT json_extract(audit.request_json,'$.ownerProof.profileVersion')
    FROM portal_verified_recipient_delivery_authority_audit audit WHERE audit.authority_id=head.authority_id
      AND audit.action='upsert' AND audit.expected_revision=0 AND audit.resulting_revision=1),
  created_by_grant_generation=(SELECT json_extract(audit.request_json,'$.ownerProof.grantGeneration')
    FROM portal_verified_recipient_delivery_authority_audit audit WHERE audit.authority_id=head.authority_id
      AND audit.action='upsert' AND audit.expected_revision=0 AND audit.resulting_revision=1),
  created_by_verified_until=(SELECT json_extract(audit.request_json,'$.ownerProof.verifiedUntil')
    FROM portal_verified_recipient_delivery_authority_audit audit WHERE audit.authority_id=head.authority_id
      AND audit.action='upsert' AND audit.expected_revision=0 AND audit.resulting_revision=1);

UPDATE portal_verified_recipient_delivery_authority_audit SET
  actor_staff_id=json_extract(request_json,'$.ownerProof.staffId'),
  actor_access_subject=json_extract(request_json,'$.ownerProof.verifiedAccessSubject'),
  actor_admission_version=json_extract(request_json,'$.ownerProof.admissionVersion'),
  actor_profile_version=json_extract(request_json,'$.ownerProof.profileVersion'),
  actor_grant_generation=json_extract(request_json,'$.ownerProof.grantGeneration'),
  actor_verified_until=json_extract(request_json,'$.ownerProof.verifiedUntil');

CREATE TABLE portal_verified_recipient_delivery_0222_assert (
  ok INTEGER NOT NULL CHECK(ok=1)
);
INSERT INTO portal_verified_recipient_delivery_0222_assert(ok)
SELECT CASE WHEN EXISTS(
  SELECT 1 FROM portal_verified_recipient_delivery_authority_heads head
  WHERE head.created_operation_id IS NULL OR head.created_request_fingerprint IS NULL
    OR head.created_by_staff_id IS NULL OR head.created_by_access_subject IS NULL
    OR head.created_by_admission_version IS NULL OR head.created_by_profile_version IS NULL
    OR head.created_by_grant_generation IS NULL OR head.created_by_verified_until IS NULL
    OR NOT EXISTS(SELECT 1 FROM portal_verified_recipient_delivery_authority_audit audit
      WHERE audit.operation_id=head.created_operation_id AND audit.authority_id=head.authority_id
        AND audit.request_fingerprint=head.created_request_fingerprint AND audit.action='upsert'
        AND audit.expected_revision=0 AND audit.resulting_revision=1
        AND json_extract(audit.request_json,'$.ownerProof.staffId')=head.created_by_staff_id
        AND json_extract(audit.request_json,'$.ownerProof.verifiedAccessSubject')=head.created_by_access_subject
        AND json_extract(audit.request_json,'$.ownerProof.admissionVersion')=head.created_by_admission_version
        AND json_extract(audit.request_json,'$.ownerProof.profileVersion')=head.created_by_profile_version
        AND json_extract(audit.request_json,'$.ownerProof.grantGeneration')=head.created_by_grant_generation
        AND json_extract(audit.request_json,'$.ownerProof.verifiedUntil')=head.created_by_verified_until)
) OR EXISTS(
  SELECT 1 FROM portal_verified_recipient_delivery_authority_audit audit
  WHERE audit.actor_staff_id IS NULL OR audit.actor_access_subject IS NULL
    OR audit.actor_admission_version IS NULL OR audit.actor_profile_version IS NULL
    OR audit.actor_grant_generation IS NULL OR audit.actor_verified_until IS NULL
    OR json_extract(audit.request_json,'$.ownerProof.staffId')<>audit.actor_staff_id
    OR json_extract(audit.request_json,'$.ownerProof.verifiedAccessSubject')<>audit.actor_access_subject
    OR json_extract(audit.request_json,'$.ownerProof.admissionVersion')<>audit.actor_admission_version
    OR json_extract(audit.request_json,'$.ownerProof.profileVersion')<>audit.actor_profile_version
    OR json_extract(audit.request_json,'$.ownerProof.grantGeneration')<>audit.actor_grant_generation
    OR json_extract(audit.request_json,'$.ownerProof.verifiedUntil')<>audit.actor_verified_until
) THEN 0 ELSE 1 END;
DROP TABLE portal_verified_recipient_delivery_0222_assert;

-- This is the exact 0221 renewal fence. It is disabled only for the metadata
-- backfill above so a legitimately stale active head can still be annotated;
-- subsequent active renewals remain subject to the original current proof.
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

CREATE TRIGGER verified_recipient_delivery_head_creation_provenance_guard
BEFORE INSERT ON portal_verified_recipient_delivery_authority_heads
WHEN NEW.created_operation_id IS NULL OR NEW.created_operation_id<>NEW.last_operation_id
  OR NEW.created_request_fingerprint IS NULL
  OR NEW.created_by_staff_id IS NOT NEW.owner_staff_id
  OR NEW.created_by_access_subject IS NOT NEW.owner_access_subject
  OR NEW.created_by_admission_version IS NOT NEW.owner_admission_version
  OR NEW.created_by_profile_version IS NOT NEW.owner_profile_version
  OR NEW.created_by_grant_generation IS NOT NEW.owner_grant_generation
  OR NEW.created_by_verified_until IS NOT NEW.owner_verified_until
BEGIN SELECT RAISE(ABORT,'verified-recipient-creation-provenance-required'); END;

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

CREATE TRIGGER verified_recipient_delivery_head_creation_provenance_update_guard
BEFORE UPDATE ON portal_verified_recipient_delivery_authority_heads
WHEN NEW.created_operation_id IS NOT OLD.created_operation_id
  OR NEW.created_request_fingerprint IS NOT OLD.created_request_fingerprint
  OR NEW.created_by_staff_id IS NOT OLD.created_by_staff_id
  OR NEW.created_by_access_subject IS NOT OLD.created_by_access_subject
  OR NEW.created_by_admission_version IS NOT OLD.created_by_admission_version
  OR NEW.created_by_profile_version IS NOT OLD.created_by_profile_version
  OR NEW.created_by_grant_generation IS NOT OLD.created_by_grant_generation
  OR NEW.created_by_verified_until IS NOT OLD.created_by_verified_until
BEGIN SELECT RAISE(ABORT,'verified-recipient-creation-provenance-is-immutable'); END;

CREATE TRIGGER verified_recipient_delivery_head_revoke_exact_guard
BEFORE UPDATE ON portal_verified_recipient_delivery_authority_heads
WHEN OLD.state='active' AND NEW.state='revoked' AND (
  NEW.home_ownership_epoch IS NOT OLD.home_ownership_epoch
  OR NEW.home_grant_revision IS NOT OLD.home_grant_revision
  OR NEW.home_grant_operation_id IS NOT OLD.home_grant_operation_id
  OR NEW.folder_binding_source_version IS NOT OLD.folder_binding_source_version
  OR NEW.project_source_version IS NOT OLD.project_source_version
  OR NEW.current_generation_id IS NOT OLD.current_generation_id
  OR NEW.access_terms_id IS NOT OLD.access_terms_id
  OR NEW.access_terms_kind IS NOT OLD.access_terms_kind
  OR NEW.access_terms_mode IS NOT OLD.access_terms_mode
  OR NEW.reviewed_expires_at IS NOT OLD.reviewed_expires_at
  OR NEW.effective_expires_at IS NOT OLD.effective_expires_at
  OR NEW.expires_at IS NOT OLD.expires_at OR NEW.reason_code IS NOT OLD.reason_code
  OR NEW.owner_staff_id IS NOT OLD.owner_staff_id
  OR NEW.owner_access_subject IS NOT OLD.owner_access_subject
  OR NEW.owner_admission_version IS NOT OLD.owner_admission_version
  OR NEW.owner_profile_version IS NOT OLD.owner_profile_version
  OR NEW.owner_grant_generation IS NOT OLD.owner_grant_generation
  OR NEW.owner_verified_until IS NOT OLD.owner_verified_until)
BEGIN SELECT RAISE(ABORT,'verified-recipient-revoke-must-preserve-grant-proof'); END;

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
    AND ((NEW.action='upsert' AND NEW.resulting_state='active')
      OR (NEW.action='revoke' AND NEW.resulting_state='revoked')))
BEGIN SELECT RAISE(ABORT,'verified-recipient-audit-requires-exact-post-cas-head'); END;

CREATE TRIGGER verified_recipient_delivery_audit_actor_shape_guard
BEFORE INSERT ON portal_verified_recipient_delivery_authority_audit
WHEN NEW.actor_staff_id IS NULL OR NEW.actor_access_subject IS NULL
  OR NEW.actor_admission_version IS NULL OR NEW.actor_profile_version IS NULL
  OR NEW.actor_grant_generation IS NULL OR NEW.actor_verified_until IS NULL
  OR json_type(NEW.request_json,'$.ownerProof.staffId') IS NOT 'text'
  OR json_type(NEW.request_json,'$.ownerProof.verifiedAccessSubject') IS NOT 'text'
  OR json_type(NEW.request_json,'$.ownerProof.admissionVersion') IS NOT 'integer'
  OR json_type(NEW.request_json,'$.ownerProof.profileVersion') IS NOT 'integer'
  OR json_type(NEW.request_json,'$.ownerProof.grantGeneration') IS NOT 'integer'
  OR json_type(NEW.request_json,'$.ownerProof.verifiedUntil') IS NOT 'text'
BEGIN SELECT RAISE(ABORT,'verified-recipient-audit-requires-shaped-command-actor'); END;

CREATE TRIGGER verified_recipient_delivery_audit_actor_guard
BEFORE INSERT ON portal_verified_recipient_delivery_authority_audit
WHEN json_extract(NEW.request_json,'$.ownerProof.staffId') IS NOT NEW.actor_staff_id
  OR json_extract(NEW.request_json,'$.ownerProof.verifiedAccessSubject') IS NOT NEW.actor_access_subject
  OR json_extract(NEW.request_json,'$.ownerProof.admissionVersion') IS NOT NEW.actor_admission_version
  OR json_extract(NEW.request_json,'$.ownerProof.profileVersion') IS NOT NEW.actor_profile_version
  OR json_extract(NEW.request_json,'$.ownerProof.grantGeneration') IS NOT NEW.actor_grant_generation
  OR json_extract(NEW.request_json,'$.ownerProof.verifiedUntil') IS NOT NEW.actor_verified_until
  OR NOT EXISTS(SELECT 1 FROM portal_verified_recipient_delivery_authority_heads head
    WHERE head.authority_id=NEW.authority_id AND head.last_operation_id=NEW.operation_id
      AND ((NEW.action='revoke' AND NEW.resulting_state='revoked')
        OR (NEW.action='upsert' AND NEW.resulting_state='active'
          AND NEW.actor_staff_id=head.owner_staff_id
          AND NEW.actor_access_subject=head.owner_access_subject
          AND NEW.actor_admission_version=head.owner_admission_version
          AND NEW.actor_profile_version=head.owner_profile_version
          AND NEW.actor_grant_generation=head.owner_grant_generation
          AND NEW.actor_verified_until=head.owner_verified_until))
      AND (NEW.expected_revision<>0 OR (
        head.created_operation_id=NEW.operation_id
        AND head.created_request_fingerprint=NEW.request_fingerprint
        AND head.created_by_staff_id=NEW.actor_staff_id
        AND head.created_by_access_subject=NEW.actor_access_subject
        AND head.created_by_admission_version=NEW.actor_admission_version
        AND head.created_by_profile_version=NEW.actor_profile_version
        AND head.created_by_grant_generation=NEW.actor_grant_generation
        AND head.created_by_verified_until=NEW.actor_verified_until)))
BEGIN SELECT RAISE(ABORT,'verified-recipient-audit-requires-exact-command-actor'); END;

CREATE TRIGGER verified_recipient_delivery_audit_no_update
BEFORE UPDATE ON portal_verified_recipient_delivery_authority_audit
BEGIN SELECT RAISE(ABORT,'verified-recipient-authority-audit-is-immutable'); END;
