-- Retain revoked principals/eligibility history and the original unique links.
-- Only a current explicit PA eligibility witness can advance a PA membership.
CREATE TABLE portal_pa_membership_reenrollment_receipts (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL,
 identity_id TEXT NOT NULL,
 principal_public_id TEXT NOT NULL,
 old_source_version TEXT,
 new_source_version TEXT NOT NULL,
 generation_id TEXT NOT NULL,
 source_sequence INTEGER NOT NULL,
 authority_revision INTEGER NOT NULL,
 authority_version INTEGER NOT NULL,
 connector_revision INTEGER NOT NULL,
 connector_version INTEGER NOT NULL,
 consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN(0,1)),
 created_at TEXT NOT NULL DEFAULT(datetime('now')),
 FOREIGN KEY(workspace_id,principal_public_id) REFERENCES pa_portal_principals(workspace_id,public_id),
 FOREIGN KEY(workspace_id,identity_id) REFERENCES portal_v2_workspace_memberships(workspace_id,identity_id)
);
CREATE TRIGGER portal_pa_membership_reenrollment_receipt_guard BEFORE INSERT ON portal_pa_membership_reenrollment_receipts
WHEN NEW.consumed<>0 OR datetime(NEW.created_at) IS NULL OR datetime(NEW.created_at)>datetime('now') OR datetime(NEW.created_at)<datetime('now','-60 seconds') OR NOT EXISTS (
 SELECT 1 FROM portal_v2_workspaces w
 JOIN portal_v2_workspace_memberships m ON m.workspace_id=w.id AND m.identity_id=NEW.identity_id
 JOIN portal_v2_identities person ON person.id=m.identity_id AND person.status='active' AND person.revoked_at IS NULL
 JOIN pa_portal_principals p ON p.workspace_id=w.id AND p.public_id=NEW.principal_public_id AND p.status='active'
 JOIN portal_v2_identity_eligibility_bindings e ON e.workspace_id=p.workspace_id AND e.principal_public_id=p.public_id
   AND e.identity_id=person.id AND e.principal_source_version=p.source_version
   AND lower(e.verified_email)=lower(p.email_hint) AND lower(person.verified_email)=lower(e.verified_email)
 JOIN portal_v2_directory_checkpoints c ON c.workspace_id=w.id
 JOIN portal_v2_directory_generations g ON g.workspace_id=w.id AND g.id=c.active_generation_id AND g.status='active' AND g.complete=1
 JOIN portal_v2_directory_entities root ON root.workspace_id=w.id AND root.generation_id=g.id AND root.active=1
   AND root.entity_type=w.root_type AND root.public_id=COALESCE(w.pa_organization_public_id,w.pa_client_public_id)
 JOIN pa_portal_workspace_sources map ON map.workspace_id=w.id AND map.projection_source_id=w.project_alpha_source_id
 JOIN pa_portal_source_authorities authority ON authority.source_id=w.project_alpha_source_id AND authority.state='active'
 JOIN pa_portal_source_authority_revisions revision ON revision.source_id=authority.source_id AND revision.revision=authority.active_revision
 WHERE w.id=NEW.workspace_id AND w.status='active' AND w.legacy_account_id IS NULL
   AND w.project_alpha_source_id<>'project-alpha:primary' AND m.source_type='project_alpha'
   AND m.source_version IS NEW.old_source_version AND p.source_version=NEW.new_source_version
   AND c.active_generation_id=NEW.generation_id AND c.source_sequence=NEW.source_sequence
   AND authority.active_revision=NEW.authority_revision AND authority.version=NEW.authority_version
   AND authority.connector_revision=NEW.connector_revision AND authority.connector_version=NEW.connector_version
   AND (p.identity_id IS NULL OR p.identity_id=person.id)
   AND NOT EXISTS(SELECT 1 FROM pa_portal_principals other WHERE other.workspace_id=w.id AND other.status='active'
     AND lower(other.email_hint)=lower(p.email_hint) AND other.public_id<>p.public_id)
   AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_bindings other
     JOIN portal_v2_identities other_person ON other_person.id=other.identity_id AND other_person.status='active' AND other_person.revoked_at IS NULL
     WHERE other.workspace_id=w.id AND other.principal_public_id=p.public_id AND other.principal_source_version=p.source_version
       AND other.identity_id<>person.id)
   AND NOT EXISTS(SELECT 1 FROM portal_client_authority_workspace_claims claim WHERE claim.workspace_id=w.id AND claim.state='active')
   AND NOT EXISTS(SELECT 1 FROM portal_v2_root_access_policies policy WHERE policy.projection_source_id=w.project_alpha_source_id
     AND policy.root_type=w.root_type AND policy.root_public_id=root.public_id AND policy.state='revoked')
   AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_blocks b WHERE b.status='active'
     AND datetime(b.valid_from)<=datetime('now') AND (b.expires_at IS NULL OR datetime(b.expires_at)>datetime('now'))
     AND ((b.match_type='issuer_subject' AND b.issuer=person.issuer AND b.subject=person.subject)
       OR (b.match_type='email' AND b.normalized_email=lower(person.verified_email))))
   AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_denials d WHERE d.identity_id=person.id AND d.status='active' AND d.revoked_at IS NULL
     AND datetime(d.valid_from)<=datetime('now') AND (d.expires_at IS NULL OR datetime(d.expires_at)>datetime('now'))
     AND (d.scope_type='global' OR d.workspace_id=w.id))
)
BEGIN SELECT RAISE(ABORT,'PA membership reenrollment witness is not current'); END;

DROP TRIGGER portal_secondary_membership_authority_update;
CREATE TRIGGER portal_secondary_membership_authority_update
BEFORE UPDATE OF id,workspace_id,identity_id,source_type,source_version ON portal_v2_workspace_memberships
WHEN EXISTS(SELECT 1 FROM portal_v2_workspaces w WHERE w.id=OLD.workspace_id AND w.project_alpha_source_id<>'project-alpha:primary')
 AND OLD.source_type IN ('project_alpha','client_invitation')
 AND (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.identity_id IS NOT OLD.identity_id
   OR NEW.source_type IS NOT OLD.source_type OR NEW.source_version IS NOT OLD.source_version)
 AND NOT (OLD.source_type='project_alpha' AND NEW.source_type='project_alpha' AND NEW.id=OLD.id
   AND NEW.workspace_id=OLD.workspace_id AND NEW.identity_id=OLD.identity_id AND NEW.status='active' AND NEW.revoked_at IS NULL
   AND EXISTS(SELECT 1 FROM portal_pa_membership_reenrollment_receipts r
     JOIN portal_v2_workspaces w ON w.id=r.workspace_id AND w.status='active'
     JOIN portal_v2_directory_checkpoints c ON c.workspace_id=w.id AND c.active_generation_id=r.generation_id AND c.source_sequence=r.source_sequence
     JOIN portal_v2_directory_generations g ON g.id=c.active_generation_id AND g.workspace_id=w.id AND g.status='active' AND g.complete=1
     JOIN portal_v2_directory_entities root ON root.workspace_id=w.id AND root.generation_id=g.id AND root.active=1
       AND root.entity_type=w.root_type AND root.public_id=COALESCE(w.pa_organization_public_id,w.pa_client_public_id)
     JOIN pa_portal_source_authorities a ON a.source_id=w.project_alpha_source_id AND a.state='active'
       AND a.active_revision=r.authority_revision AND a.version=r.authority_version
       AND a.connector_revision=r.connector_revision AND a.connector_version=r.connector_version
     JOIN pa_portal_source_authority_revisions ar ON ar.source_id=a.source_id AND ar.revision=a.active_revision
     JOIN pa_portal_principals p ON p.workspace_id=w.id AND p.public_id=r.principal_public_id AND p.status='active' AND p.source_version=r.new_source_version
     JOIN portal_v2_identity_eligibility_bindings e ON e.workspace_id=w.id AND e.principal_public_id=p.public_id AND e.identity_id=r.identity_id
       AND e.principal_source_version=p.source_version AND lower(e.verified_email)=lower(p.email_hint)
     JOIN portal_v2_identities person ON person.id=e.identity_id AND person.status='active' AND person.revoked_at IS NULL AND lower(person.verified_email)=lower(e.verified_email)
     WHERE r.workspace_id=OLD.workspace_id AND r.identity_id=OLD.identity_id AND r.old_source_version IS OLD.source_version
       AND r.new_source_version=NEW.source_version AND r.consumed=0 AND datetime(r.created_at)>=datetime('now','-60 seconds') AND datetime(r.created_at)<=datetime('now')
       AND (p.identity_id IS NULL OR p.identity_id=person.id)
       AND NOT EXISTS(SELECT 1 FROM pa_portal_principals other WHERE other.workspace_id=w.id AND other.status='active'
         AND lower(other.email_hint)=lower(p.email_hint) AND other.public_id<>p.public_id)
       AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_bindings other
         JOIN portal_v2_identities other_person ON other_person.id=other.identity_id AND other_person.status='active' AND other_person.revoked_at IS NULL
         WHERE other.workspace_id=w.id AND other.principal_public_id=p.public_id AND other.principal_source_version=p.source_version AND other.identity_id<>person.id)
       AND NOT EXISTS(SELECT 1 FROM portal_client_authority_workspace_claims claim WHERE claim.workspace_id=w.id AND claim.state='active')
       AND NOT EXISTS(SELECT 1 FROM portal_v2_root_access_policies policy WHERE policy.projection_source_id=w.project_alpha_source_id
         AND policy.root_type=w.root_type AND policy.root_public_id=COALESCE(w.pa_organization_public_id,w.pa_client_public_id) AND policy.state='revoked')
       AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_blocks b WHERE b.status='active'
         AND datetime(b.valid_from)<=datetime('now') AND (b.expires_at IS NULL OR datetime(b.expires_at)>datetime('now'))
         AND ((b.match_type='issuer_subject' AND b.issuer=person.issuer AND b.subject=person.subject)
           OR (b.match_type='email' AND b.normalized_email=lower(person.verified_email))))
       AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_denials d WHERE d.identity_id=person.id AND d.status='active' AND d.revoked_at IS NULL
         AND datetime(d.valid_from)<=datetime('now') AND (d.expires_at IS NULL OR datetime(d.expires_at)>datetime('now'))
         AND (d.scope_type='global' OR d.workspace_id=w.id))))
BEGIN SELECT RAISE(ABORT,'secondary membership authority is immutable'); END;
CREATE TRIGGER portal_pa_membership_reenrollment_consume AFTER UPDATE OF source_version ON portal_v2_workspace_memberships
WHEN NEW.source_type='project_alpha' AND NEW.source_version IS NOT OLD.source_version
BEGIN
 UPDATE portal_pa_membership_reenrollment_receipts SET consumed=1
 WHERE workspace_id=NEW.workspace_id AND identity_id=NEW.identity_id AND old_source_version IS OLD.source_version
   AND new_source_version=NEW.source_version AND consumed=0;
END;
CREATE TRIGGER portal_pa_membership_reenrollment_immutable BEFORE UPDATE ON portal_pa_membership_reenrollment_receipts
WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.identity_id IS NOT OLD.identity_id
 OR NEW.principal_public_id IS NOT OLD.principal_public_id OR NEW.old_source_version IS NOT OLD.old_source_version
 OR NEW.new_source_version IS NOT OLD.new_source_version OR NEW.generation_id IS NOT OLD.generation_id
 OR NEW.source_sequence IS NOT OLD.source_sequence OR NEW.created_at IS NOT OLD.created_at
 OR NEW.authority_revision IS NOT OLD.authority_revision OR NEW.authority_version IS NOT OLD.authority_version
 OR NEW.connector_revision IS NOT OLD.connector_revision OR NEW.connector_version IS NOT OLD.connector_version
 OR OLD.consumed<>0 OR NEW.consumed<>1
BEGIN SELECT RAISE(ABORT,'PA reenrollment receipt is immutable'); END;
CREATE TRIGGER portal_pa_membership_reenrollment_no_delete BEFORE DELETE ON portal_pa_membership_reenrollment_receipts
BEGIN SELECT RAISE(ABORT,'PA reenrollment receipt is retained'); END;

-- Keep existing invitation authority guards, resolving only the exact current PA identity.
DROP TRIGGER portal_secondary_invitation_authority_insert;
CREATE TRIGGER portal_secondary_invitation_authority_insert BEFORE INSERT ON portal_secondary_workspace_invitation_authority
WHEN EXISTS(SELECT 1 FROM portal_secondary_workspace_invitation_authority WHERE invitation_id=NEW.invitation_id)
 OR NOT EXISTS(SELECT 1 FROM portal_v2_workspaces w
   JOIN pa_portal_workspace_sources owner ON owner.workspace_id=w.id AND owner.projection_source_id=w.project_alpha_source_id
   JOIN pa_portal_source_authorities authority ON authority.source_id=owner.projection_source_id AND authority.state='active'
     AND authority.active_revision=NEW.authority_revision AND authority.version=NEW.authority_version
     AND authority.connector_revision=NEW.connector_revision AND authority.connector_version=NEW.connector_version
   JOIN pa_portal_source_authority_revisions revision ON revision.source_id=authority.source_id AND revision.revision=authority.active_revision
   JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=w.id AND checkpoint.active_generation_id=NEW.generation_id
     AND checkpoint.source_sequence=NEW.source_sequence
   JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id AND generation.workspace_id=w.id
     AND generation.status='active' AND generation.complete=1 AND generation.source_sequence=checkpoint.source_sequence
   JOIN portal_v2_directory_entities root ON root.workspace_id=w.id AND root.generation_id=generation.id AND root.active=1
     AND root.entity_type=w.root_type AND root.public_id=COALESCE(w.pa_organization_public_id,w.pa_client_public_id)
   JOIN portal_v2_identities identity ON identity.id=NEW.inviter_identity_id AND identity.issuer=NEW.inviter_issuer
     AND identity.subject=NEW.inviter_subject AND lower(identity.verified_email)=lower(NEW.inviter_email)
     AND identity.status='active' AND identity.revoked_at IS NULL
   JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=w.id AND membership.identity_id=identity.id
     AND membership.source_type='project_alpha' AND membership.status='active' AND membership.revoked_at IS NULL
     AND membership.expires_at IS NULL
   JOIN pa_portal_principals principal ON principal.workspace_id=w.id AND COALESCE(principal.identity_id,(SELECT MIN(eligible.identity_id)
       FROM portal_v2_identity_eligibility_bindings eligible
       JOIN portal_v2_identities person ON person.id=eligible.identity_id AND person.status='active' AND person.revoked_at IS NULL
         AND lower(person.verified_email)=lower(eligible.verified_email)
       WHERE eligible.workspace_id=principal.workspace_id AND eligible.principal_public_id=principal.public_id
         AND eligible.principal_source_version=principal.source_version
         AND lower(eligible.verified_email)=lower(principal.email_hint) HAVING COUNT(*)=1))=identity.id
     AND principal.status='active' AND principal.source_version=membership.source_version
     AND lower(principal.email_hint)=lower(identity.verified_email)
   WHERE w.id=NEW.workspace_id AND w.project_alpha_source_id=NEW.source_id AND w.legacy_account_id IS NULL AND w.status='active')
BEGIN SELECT RAISE(ABORT,'secondary invitation authority is stale or unavailable'); END;

-- Keep existing invitation authority guards, resolving only the exact current PA identity.
DROP TRIGGER portal_secondary_invitation_accept;
CREATE TRIGGER portal_secondary_invitation_accept BEFORE UPDATE OF status ON portal_v2_invitations
WHEN NEW.status='accepted' AND OLD.status<>'accepted'
 AND EXISTS(SELECT 1 FROM portal_secondary_workspace_invitation_authority binding WHERE binding.invitation_id=NEW.id)
 AND NOT EXISTS(SELECT 1 FROM portal_secondary_workspace_invitation_authority binding
   JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id AND workspace.id=NEW.workspace_id
     AND workspace.project_alpha_source_id=binding.source_id AND workspace.legacy_account_id IS NULL AND workspace.status='active'
   JOIN pa_portal_source_authorities authority ON authority.source_id=binding.source_id AND authority.state='active'
     AND authority.active_revision=binding.authority_revision AND authority.version=binding.authority_version
     AND authority.connector_revision=binding.connector_revision AND authority.connector_version=binding.connector_version
   JOIN pa_portal_source_authority_revisions revision ON revision.source_id=authority.source_id AND revision.revision=authority.active_revision
   JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
     AND checkpoint.active_generation_id=binding.generation_id AND checkpoint.source_sequence=binding.source_sequence
   JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id AND generation.workspace_id=workspace.id
     AND generation.status='active' AND generation.complete=1 AND generation.source_sequence=checkpoint.source_sequence
   JOIN portal_v2_identities inviter ON inviter.id=binding.inviter_identity_id AND inviter.issuer=binding.inviter_issuer
     AND inviter.subject=binding.inviter_subject AND lower(inviter.verified_email)=lower(binding.inviter_email)
     AND inviter.status='active' AND inviter.revoked_at IS NULL
   JOIN pa_portal_principals inviter_principal ON inviter_principal.workspace_id=workspace.id
     AND COALESCE(inviter_principal.identity_id,(SELECT MIN(eligible.identity_id)
       FROM portal_v2_identity_eligibility_bindings eligible
       JOIN portal_v2_identities person ON person.id=eligible.identity_id AND person.status='active' AND person.revoked_at IS NULL
         AND lower(person.verified_email)=lower(eligible.verified_email)
       WHERE eligible.workspace_id=inviter_principal.workspace_id AND eligible.principal_public_id=inviter_principal.public_id
         AND eligible.principal_source_version=inviter_principal.source_version
         AND lower(eligible.verified_email)=lower(inviter_principal.email_hint) HAVING COUNT(*)=1))=inviter.id AND inviter_principal.status='active'
     AND lower(inviter_principal.email_hint)=lower(inviter.verified_email)
   JOIN portal_v2_workspace_memberships inviter_membership ON inviter_membership.workspace_id=workspace.id
     AND inviter_membership.identity_id=inviter.id AND inviter_membership.source_type='project_alpha'
     AND inviter_membership.source_version=inviter_principal.source_version AND inviter_membership.status='active'
     AND inviter_membership.revoked_at IS NULL AND inviter_membership.expires_at IS NULL
   JOIN portal_v2_directory_entities inviter_root ON inviter_root.workspace_id=workspace.id
     AND inviter_root.generation_id=generation.id AND inviter_root.entity_type=workspace.root_type
     AND inviter_root.public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) AND inviter_root.active=1
   WHERE binding.invitation_id=NEW.id
     AND binding.grant_manifest_json=COALESCE((SELECT json_group_array(json_object(
       'capability',manifest.capability,'scope_type',manifest.scope_type,'scope_public_id',manifest.scope_public_id,
       'access_terms_id',manifest.access_terms_id)) FROM (SELECT capability,scope_type,scope_public_id,access_terms_id
         FROM portal_v2_invitation_entitlements WHERE invitation_id=NEW.id
         ORDER BY capability,scope_type,scope_public_id) manifest),'[]')
     AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_denials denial
       WHERE denial.identity_id=inviter.id AND denial.status='active' AND denial.revoked_at IS NULL
         AND datetime(denial.valid_from)<=datetime('now')
         AND (denial.expires_at IS NULL OR datetime(denial.expires_at)>datetime('now'))
         AND (denial.scope_type='global' OR denial.workspace_id=workspace.id))
     AND NOT EXISTS(WITH RECURSIVE required(capability,scope_type,scope_public_id) AS (
         SELECT capability,scope_type,scope_public_id FROM portal_v2_invitation_entitlements WHERE invitation_id=NEW.id
         UNION SELECT 'member.manage','workspace',workspace.id
         UNION SELECT 'member.manage',scope_type,scope_public_id FROM portal_v2_invitation_entitlements
           WHERE invitation_id=NEW.id AND scope_type<>'workspace'
       ), lineage(capability,target_type,target_public_id,entity_type,public_id,depth) AS (
         SELECT required.capability,required.scope_type,required.scope_public_id,target.entity_type,target.public_id,0
         FROM required JOIN portal_v2_directory_entities target ON target.workspace_id=workspace.id
           AND target.generation_id=generation.id AND target.entity_type=required.scope_type
           AND target.public_id=required.scope_public_id AND target.active=1
         WHERE required.scope_type<>'workspace'
         UNION
         SELECT lineage.capability,lineage.target_type,lineage.target_public_id,relation.from_type,relation.from_public_id,lineage.depth+1
         FROM lineage JOIN portal_v2_directory_relations relation ON relation.workspace_id=workspace.id
           AND relation.generation_id=generation.id AND relation.active=1
           AND relation.to_type=lineage.entity_type AND relation.to_public_id=lineage.public_id
         JOIN portal_v2_directory_entities parent ON parent.workspace_id=relation.workspace_id
           AND parent.generation_id=relation.generation_id AND parent.entity_type=relation.from_type
           AND parent.public_id=relation.from_public_id AND parent.active=1
         WHERE lineage.depth<12
       ), target_stats(capability,target_type,target_public_id,scope_count,max_depth,reaches_root) AS (
         SELECT capability,target_type,target_public_id,COUNT(*),MAX(depth),
           MAX(CASE WHEN entity_type=workspace.root_type
             AND public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) THEN 1 ELSE 0 END)
         FROM lineage GROUP BY capability,target_type,target_public_id
       )
       SELECT 1 FROM required LEFT JOIN target_stats stats ON stats.capability=required.capability
         AND stats.target_type=required.scope_type AND stats.target_public_id=required.scope_public_id
       WHERE (required.scope_type='workspace' AND (required.scope_public_id<>workspace.id
           OR NOT EXISTS(SELECT 1 FROM portal_v2_entitlements allow_record
             WHERE allow_record.workspace_id=workspace.id AND allow_record.identity_id=inviter.id
               AND allow_record.capability=required.capability AND allow_record.effect='allow'
                AND allow_record.scope_type='workspace' AND allow_record.scope_public_id=workspace.id
                AND allow_record.source_type='project_alpha' AND allow_record.source_version=inviter_membership.source_version
                AND allow_record.status='active' AND allow_record.revoked_at IS NULL
                AND datetime(allow_record.valid_from)<=datetime('now') AND allow_record.expires_at IS NULL)
           OR EXISTS(SELECT 1 FROM portal_v2_entitlements deny_record
             WHERE deny_record.workspace_id=workspace.id AND deny_record.identity_id=inviter.id
               AND deny_record.capability=required.capability AND deny_record.effect='deny'
               AND deny_record.scope_type='workspace' AND deny_record.scope_public_id=workspace.id
               AND deny_record.status='active' AND deny_record.revoked_at IS NULL
               AND datetime(deny_record.valid_from)<=datetime('now')
               AND (deny_record.expires_at IS NULL OR datetime(deny_record.expires_at)>datetime('now')))))
         OR (required.scope_type<>'workspace' AND (stats.scope_count IS NULL OR stats.scope_count>64 OR stats.max_depth>=12 OR stats.reaches_root<>1
           OR EXISTS(SELECT 1 FROM lineage project_scope
             LEFT JOIN portal_v2_project_lifecycle lifecycle ON lifecycle.workspace_id=workspace.id
               AND lifecycle.generation_id=generation.id AND lifecycle.project_public_id=project_scope.public_id
               AND (lifecycle.lifecycle_status='active' OR (lifecycle.lifecycle_status='completed' AND datetime(lifecycle.completed_at) IS NOT NULL))
             WHERE project_scope.capability=required.capability AND project_scope.target_type=required.scope_type
               AND project_scope.target_public_id=required.scope_public_id AND project_scope.entity_type='project'
               AND lifecycle.project_public_id IS NULL)
           OR (SELECT COUNT(*) FROM portal_v2_entitlements counted WHERE counted.workspace_id=workspace.id
               AND counted.identity_id=inviter.id AND counted.capability=required.capability
               AND counted.status='active' AND counted.revoked_at IS NULL AND datetime(counted.valid_from)<=datetime('now')
               AND (counted.expires_at IS NULL OR datetime(counted.expires_at)>datetime('now'))) > 200
           OR NOT EXISTS(SELECT 1 FROM portal_v2_entitlements allow_record
             WHERE allow_record.workspace_id=workspace.id AND allow_record.identity_id=inviter.id
                AND allow_record.capability=required.capability AND allow_record.effect='allow'
                AND allow_record.status='active' AND allow_record.revoked_at IS NULL
                AND datetime(allow_record.valid_from)<=datetime('now')
                AND (allow_record.expires_at IS NULL OR datetime(allow_record.expires_at)>datetime('now'))
                AND ((allow_record.scope_type='workspace' AND allow_record.scope_public_id=workspace.id)
                  OR EXISTS(SELECT 1 FROM lineage allow_scope WHERE allow_scope.capability=required.capability
                    AND allow_scope.target_type=required.scope_type AND allow_scope.target_public_id=required.scope_public_id
                    AND allow_scope.entity_type=allow_record.scope_type AND allow_scope.public_id=allow_record.scope_public_id)))
           OR EXISTS(SELECT 1 FROM portal_v2_entitlements deny_record
             WHERE deny_record.workspace_id=workspace.id AND deny_record.identity_id=inviter.id
               AND deny_record.capability=required.capability AND deny_record.effect='deny'
               AND deny_record.status='active' AND deny_record.revoked_at IS NULL
               AND datetime(deny_record.valid_from)<=datetime('now')
               AND (deny_record.expires_at IS NULL OR datetime(deny_record.expires_at)>datetime('now'))
               AND ((deny_record.scope_type='workspace' AND deny_record.scope_public_id=workspace.id)
                 OR EXISTS(SELECT 1 FROM lineage deny_scope WHERE deny_scope.capability=required.capability
                   AND deny_scope.target_type=required.scope_type AND deny_scope.target_public_id=required.scope_public_id
                   AND deny_scope.entity_type=deny_record.scope_type AND deny_scope.public_id=deny_record.scope_public_id)))))))
BEGIN SELECT RAISE(ABORT,'secondary invitation authority changed'); END;
