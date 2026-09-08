/**
 * Exact native staff-publication proof for a secondary workspace.  The four
 * expressions are trusted SQL aliases from the fixed query templates below;
 * they are never derived from request input.  A legacy-account workspace is
 * not a native delegation, while primary Operations bindings are separately
 * fenced by the 0189 receipt.
 */
export function authenticatedDeliveryNativeStaffPublicationSql(
  workspaceAlias: string,
  sourceIdExpression: string,
  grantAlias: string,
  bindingAlias: string,
): string {
  return `(${workspaceAlias}.project_alpha_source_id='project-alpha:primary' OR ${workspaceAlias}.legacy_account_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM portal_native_staff_grants native_publication
      JOIN portal_native_staff_bindings native_binding ON native_binding.binding_id=native_publication.binding_id
        AND native_binding.source_id=native_publication.source_id
      WHERE native_publication.grant_id=${grantAlias}.id AND native_publication.binding_id=${bindingAlias}.id
        AND native_publication.source_id=${sourceIdExpression} AND native_binding.workspace_id=${workspaceAlias}.id
        AND native_binding.r2_prefix=${bindingAlias}.r2_prefix
        AND native_binding.project_public_id=${bindingAlias}.owner_public_id AND ${bindingAlias}.owner_scope_type='project'
        AND native_publication.state='active'))`;
}

/**
 * Current-access proof for an immutable authenticated-delivery change batch.
 * The sole bind parameter is the fixed batch id.  It deliberately returns only
 * the current recipient email and workspace display name; caller-specific
 * history queries add their own identity/session fence.
 */
export function authenticatedDeliveryChangeAuthoritySql(
  relationsEnabled = false,
  rootAccessPolicyEnabled = false,
  primaryStaffReceiptsReady = false,
): string {
  const rootAccess = rootAccessPolicyEnabled ? `AND NOT EXISTS(SELECT 1 FROM portal_v2_root_access_policies root_policy
        WHERE root_policy.projection_source_id=workspace.project_alpha_source_id
          AND root_policy.root_type=workspace.root_type
          AND root_policy.root_public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id)
          AND root_policy.state='revoked')` : "";
  const accessTerms = `(grant_record.access_terms_id IS NULL OR EXISTS(SELECT 1 FROM portal_project_access_terms terms
    LEFT JOIN portal_project_access_deadlines deadline ON deadline.access_terms_id=terms.id
    WHERE terms.id=grant_record.access_terms_id AND terms.workspace_id=grant_record.workspace_id
      AND EXISTS(SELECT 1 FROM lineage term_project WHERE term_project.entity_type='project'
        AND term_project.public_id=terms.project_public_id)
      AND ((terms.mode='until_revoked') OR (terms.mode='specific_date' AND datetime(terms.expires_at)>datetime('now'))
        OR (terms.mode='project_end' AND ((deadline.access_terms_id IS NOT NULL AND datetime(deadline.deadline_at)>datetime('now'))
          OR (deadline.access_terms_id IS NULL AND EXISTS(SELECT 1 FROM portal_project_access_current_lifecycle lifecycle
            WHERE lifecycle.workspace_id=terms.workspace_id AND lifecycle.source_id=terms.source_id
              AND lifecycle.project_public_id=terms.project_public_id AND lifecycle.lifecycle_status='active')))))))`;
  // A pre-0189 deployment cannot safely infer authority from an Operations
  // routing binding.  Callers that have proved the receipt schema present pass
  // true; all other callers fail those primary Operations bindings closed.
  const primaryStaffReceipt = primaryStaffReceiptsReady
    ? `(workspace.project_alpha_source_id<>'project-alpha:primary' OR binding.source_type<>'operations' OR EXISTS(
      SELECT 1 FROM portal_primary_staff_bindings receipt WHERE receipt.binding_id=binding.id
        AND receipt.workspace_id=binding.workspace_id AND receipt.r2_prefix=binding.r2_prefix AND receipt.state='active'))`
    : `(workspace.project_alpha_source_id<>'project-alpha:primary' OR binding.source_type<>'operations')`;
  const nativeStaffPublication = `(workspace.project_alpha_source_id='project-alpha:primary' OR workspace.legacy_account_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM authenticated_delivery_native_publications native_publication
      WHERE native_publication.binding_id=binding.id AND native_publication.workspace_id=workspace.id
        AND native_publication.r2_prefix=binding.r2_prefix AND native_publication.project_public_id=binding.owner_public_id
        AND binding.owner_scope_type='project'))`;
  return `WITH RECURSIVE authenticated_delivery_input_batch AS MATERIALIZED (
      SELECT * FROM portal_authenticated_delivery_change_batches WHERE id=?
    ), authenticated_delivery_native_publications(binding_id,workspace_id,r2_prefix,project_public_id) AS MATERIALIZED (
      SELECT native_binding.binding_id,native_binding.workspace_id,native_binding.r2_prefix,native_binding.project_public_id
      FROM authenticated_delivery_input_batch selected_batch
      JOIN portal_native_staff_grants native_publication ON native_publication.grant_id=selected_batch.grant_id
        AND native_publication.source_id=selected_batch.source_id AND native_publication.state='active'
      JOIN portal_native_staff_bindings native_binding ON native_binding.binding_id=native_publication.binding_id
        AND native_binding.source_id=native_publication.source_id
      WHERE native_publication.binding_id=selected_batch.folder_binding_id
    ), lineage(entity_type,public_id,parent_public_id,depth) AS (
      SELECT owner.entity_type,owner.public_id,owner.parent_public_id,0
      FROM portal_v2_directory_entities owner
      WHERE owner.workspace_id=batch.workspace_id AND owner.generation_id=checkpoint.active_generation_id
        AND owner.entity_type=batch.owner_scope_type AND owner.public_id=batch.owner_public_id
        AND owner.active=1 AND owner.source_version=binding.source_version
      UNION
      SELECT parent.entity_type,parent.public_id,parent.parent_public_id,lineage.depth+1 FROM lineage
      JOIN portal_v2_directory_entities parent ON parent.workspace_id=batch.workspace_id
        AND parent.generation_id=checkpoint.active_generation_id AND parent.public_id=lineage.parent_public_id AND parent.active=1
      WHERE lineage.parent_public_id IS NOT NULL AND lineage.depth<12
      ${relationsEnabled ? `UNION
      SELECT parent.entity_type,parent.public_id,parent.parent_public_id,lineage.depth+1 FROM lineage
      JOIN portal_v2_directory_relations relation ON relation.workspace_id=batch.workspace_id
        AND relation.generation_id=checkpoint.active_generation_id AND relation.to_type=lineage.entity_type
        AND relation.to_public_id=lineage.public_id AND relation.relation_type='contains' AND relation.active=1
      JOIN portal_v2_directory_entities parent ON parent.workspace_id=relation.workspace_id
        AND parent.generation_id=relation.generation_id AND parent.entity_type=relation.from_type
        AND parent.public_id=relation.from_public_id AND parent.active=1
      WHERE lineage.depth<12` : ""}
    ) SELECT identity.verified_email recipient_email,workspace.display_name workspace_name
    FROM authenticated_delivery_input_batch batch
    JOIN portal_authenticated_delivery_notification_policies policy ON policy.grant_id=batch.grant_id AND policy.identity_id=batch.identity_id
      AND policy.grant_version=batch.grant_version AND policy.logical_grant_id=batch.logical_grant_id
      AND policy.workspace_id=batch.workspace_id AND policy.source_id=batch.source_id
      AND policy.principal_public_id=batch.principal_public_id AND policy.principal_source_version=batch.principal_source_version
      AND policy.policy_version=batch.policy_version AND policy.access_notice_enabled=1 AND policy.change_mode<>'off'
    JOIN portal_v2_authenticated_delivery_grants grant_record ON grant_record.id=batch.grant_id
      AND grant_record.grant_version=batch.grant_version AND grant_record.logical_grant_id=batch.logical_grant_id
      AND grant_record.workspace_id=batch.workspace_id AND grant_record.folder_binding_id=batch.folder_binding_id
      AND grant_record.binding_source_version=batch.binding_source_version AND grant_record.audience_type='principal'
      AND grant_record.audience_public_id=batch.principal_public_id AND grant_record.audience_source_version=batch.principal_source_version
      AND grant_record.status='active' AND grant_record.revoked_at IS NULL
      AND (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>datetime('now'))
    JOIN portal_v2_authenticated_delivery_grant_recipients recipient ON recipient.grant_id=batch.grant_id
      AND recipient.workspace_id=batch.workspace_id AND recipient.identity_id=batch.identity_id
      AND recipient.principal_public_id=batch.principal_public_id AND recipient.principal_source_version=batch.principal_source_version
    JOIN portal_v2_workspaces workspace ON workspace.id=batch.workspace_id AND workspace.project_alpha_source_id=batch.source_id
      AND workspace.status='active'
    JOIN pa_portal_workspace_sources source ON source.workspace_id=workspace.id AND source.projection_source_id=batch.source_id
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
      AND generation.workspace_id=workspace.id AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_folder_bindings binding ON binding.id=batch.folder_binding_id AND binding.workspace_id=batch.workspace_id
      AND binding.source_version=batch.binding_source_version AND binding.owner_scope_type=batch.owner_scope_type
      AND binding.owner_public_id=batch.owner_public_id AND binding.r2_prefix=batch.r2_prefix
      AND binding.status='active' AND binding.revoked_at IS NULL
    JOIN pa_portal_principals principal ON principal.workspace_id=batch.workspace_id AND principal.public_id=batch.principal_public_id
      AND principal.identity_id=batch.identity_id AND principal.source_version=batch.principal_source_version AND principal.status='active'
    JOIN portal_v2_identities identity ON identity.id=batch.identity_id AND identity.status='active'
      AND identity.revoked_at IS NULL AND identity.verified_email IS NOT NULL
    JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=batch.workspace_id AND membership.identity_id=batch.identity_id
      AND membership.status='active' AND membership.revoked_at IS NULL
      AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
    WHERE ${accessTerms} AND ${primaryStaffReceipt} AND ${nativeStaffPublication}
      AND (batch.source_id='project-alpha:primary' OR EXISTS(SELECT 1 FROM pa_portal_source_authorities source_authority
        JOIN pa_portal_source_authority_revisions source_revision ON source_revision.source_id=source_authority.source_id
          AND source_revision.revision=source_authority.active_revision
        WHERE source_authority.source_id=batch.source_id AND source_authority.state='active'))
      ${rootAccess}
      AND (batch.added_count=0 OR policy.change_mode IN ('added','both'))
      AND (batch.removed_count=0 OR policy.change_mode IN ('removed','both'))
      AND batch.added_count+batch.removed_count>0
      AND EXISTS(SELECT 1 FROM lineage WHERE entity_type=batch.owner_scope_type AND public_id=batch.owner_public_id)
      AND EXISTS(SELECT 1 FROM portal_v2_entitlements allow_record WHERE allow_record.workspace_id=batch.workspace_id
        AND allow_record.identity_id=batch.identity_id AND allow_record.capability='delivery.view' AND allow_record.effect='allow'
        AND allow_record.status='active' AND allow_record.revoked_at IS NULL AND datetime(allow_record.valid_from)<=datetime('now')
        AND (allow_record.expires_at IS NULL OR datetime(allow_record.expires_at)>datetime('now'))
        AND (allow_record.access_terms_id IS NULL OR EXISTS(SELECT 1 FROM lineage allow_term_project
          JOIN portal_project_access_terms allow_terms ON allow_terms.id=allow_record.access_terms_id
            AND allow_terms.workspace_id=batch.workspace_id AND allow_terms.project_public_id=allow_term_project.public_id
          LEFT JOIN portal_project_access_deadlines allow_deadline ON allow_deadline.access_terms_id=allow_terms.id
          WHERE allow_term_project.entity_type='project' AND (allow_terms.mode='until_revoked'
            OR allow_terms.mode='specific_date' AND datetime(allow_terms.expires_at)>datetime('now')
            OR allow_terms.mode='project_end' AND (allow_deadline.access_terms_id IS NOT NULL
              AND datetime(allow_deadline.deadline_at)>datetime('now') OR allow_deadline.access_terms_id IS NULL
              AND EXISTS(SELECT 1 FROM portal_project_access_current_lifecycle allow_lifecycle
                WHERE allow_lifecycle.workspace_id=allow_terms.workspace_id AND allow_lifecycle.source_id=allow_terms.source_id
                  AND allow_lifecycle.project_public_id=allow_terms.project_public_id AND allow_lifecycle.lifecycle_status='active')))))
        AND (allow_record.scope_type='workspace' AND allow_record.scope_public_id=batch.workspace_id
          OR allow_record.scope_type='folder' AND allow_record.scope_public_id=batch.folder_binding_id
          OR EXISTS(SELECT 1 FROM lineage WHERE entity_type=allow_record.scope_type AND public_id=allow_record.scope_public_id)))
      AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements workspace_deny WHERE workspace_deny.workspace_id=batch.workspace_id
        AND workspace_deny.identity_id=batch.identity_id AND workspace_deny.capability='workspace.view'
        AND workspace_deny.effect='deny' AND workspace_deny.scope_type='workspace'
        AND workspace_deny.scope_public_id=batch.workspace_id AND workspace_deny.status='active'
        AND workspace_deny.revoked_at IS NULL AND datetime(workspace_deny.valid_from)<=datetime('now')
        AND (workspace_deny.expires_at IS NULL OR datetime(workspace_deny.expires_at)>datetime('now')))
      AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements deny_record WHERE deny_record.workspace_id=batch.workspace_id
        AND deny_record.identity_id=batch.identity_id AND deny_record.capability='delivery.view' AND deny_record.effect='deny'
        AND deny_record.status='active' AND deny_record.revoked_at IS NULL AND datetime(deny_record.valid_from)<=datetime('now')
        AND (deny_record.expires_at IS NULL OR datetime(deny_record.expires_at)>datetime('now'))
        AND (deny_record.scope_type='workspace' AND deny_record.scope_public_id=batch.workspace_id
          OR deny_record.scope_type='folder' AND deny_record.scope_public_id=batch.folder_binding_id
          OR EXISTS(SELECT 1 FROM lineage WHERE entity_type=deny_record.scope_type AND public_id=deny_record.scope_public_id)))
      AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_denials denial WHERE denial.identity_id=batch.identity_id
        AND denial.status='active' AND denial.revoked_at IS NULL AND datetime(denial.valid_from)<=datetime('now')
        AND (denial.expires_at IS NULL OR datetime(denial.expires_at)>datetime('now'))
        AND (denial.scope_type='global' OR denial.workspace_id=batch.workspace_id AND
          (denial.scope_type='workspace' AND denial.scope_public_id=batch.workspace_id
            OR denial.scope_type='folder' AND denial.scope_public_id=batch.folder_binding_id
            OR EXISTS(SELECT 1 FROM lineage WHERE entity_type=denial.scope_type AND public_id=denial.scope_public_id))))
      AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_blocks eligibility_block
        WHERE eligibility_block.status='active' AND datetime(eligibility_block.valid_from)<=datetime('now')
          AND (eligibility_block.expires_at IS NULL OR datetime(eligibility_block.expires_at)>datetime('now'))
          AND ((eligibility_block.match_type='issuer_subject' AND eligibility_block.issuer=identity.issuer
            AND eligibility_block.subject=identity.subject)
            OR (eligibility_block.match_type='email' AND eligibility_block.normalized_email=lower(trim(identity.verified_email)))) )
      AND NOT EXISTS(SELECT 1 FROM portal_authenticated_delivery_notification_policies other_policy
        JOIN portal_v2_authenticated_delivery_grants other_grant ON other_grant.id=other_policy.grant_id
          AND other_grant.grant_version=other_policy.grant_version AND other_grant.logical_grant_id=other_policy.logical_grant_id
          AND other_grant.workspace_id=other_policy.workspace_id AND other_grant.audience_type='principal'
          AND other_grant.audience_public_id=other_policy.principal_public_id
          AND other_grant.audience_source_version=other_policy.principal_source_version
          AND other_grant.status='active' AND other_grant.revoked_at IS NULL
          AND (other_grant.expires_at IS NULL OR datetime(other_grant.expires_at)>datetime('now'))
        JOIN portal_v2_authenticated_delivery_grant_recipients other_recipient ON other_recipient.grant_id=other_grant.id
          AND other_recipient.workspace_id=other_policy.workspace_id AND other_recipient.identity_id=other_policy.identity_id
          AND other_recipient.principal_public_id=other_policy.principal_public_id
          AND other_recipient.principal_source_version=other_policy.principal_source_version
        JOIN portal_v2_folder_bindings other_binding ON other_binding.id=other_grant.folder_binding_id
          AND other_binding.workspace_id=other_policy.workspace_id AND other_binding.source_version=other_grant.binding_source_version
          AND other_binding.status='active' AND other_binding.revoked_at IS NULL
        WHERE other_policy.workspace_id=batch.workspace_id AND other_policy.identity_id=batch.identity_id
          AND other_policy.access_notice_enabled=1 AND other_policy.grant_id<>batch.grant_id
          AND substr((SELECT r2_key FROM portal_authenticated_delivery_change_batch_items WHERE batch_id=batch.id LIMIT 1),1,length(other_binding.r2_prefix))=other_binding.r2_prefix
          AND length(other_binding.r2_prefix)>=length(batch.r2_prefix))
    LIMIT 1`;
}
