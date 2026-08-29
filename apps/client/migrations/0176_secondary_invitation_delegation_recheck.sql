-- Pending secondary invitations remain valid only while the exact issuing
-- delegation remains current. Persist the canonical grant set separately from
-- its opaque context hash so direct SQL cannot rewrite the grant being accepted.
DROP TRIGGER IF EXISTS portal_secondary_invitation_authority_update;
ALTER TABLE portal_secondary_workspace_invitation_authority ADD COLUMN grant_manifest_json TEXT;
UPDATE portal_secondary_workspace_invitation_authority AS binding SET grant_manifest_json=COALESCE((
  SELECT json_group_array(json_object('capability',manifest.capability,'scope_type',manifest.scope_type,
    'scope_public_id',manifest.scope_public_id,'access_terms_id',manifest.access_terms_id))
  FROM (SELECT capability,scope_type,scope_public_id,access_terms_id
    FROM portal_v2_invitation_entitlements WHERE invitation_id=binding.invitation_id
    ORDER BY capability,scope_type,scope_public_id) manifest
),'[]');
-- During a migration-first rolling deploy, the previous worker does not know
-- about the manifest column. It may leave the column NULL while creating the
-- invitation and grants; the outbox insert below seals that exact set once,
-- inside the same D1 batch. Every other authority mutation remains forbidden.
CREATE TRIGGER portal_secondary_invitation_authority_update BEFORE UPDATE ON portal_secondary_workspace_invitation_authority
WHEN NOT (OLD.grant_manifest_json IS NULL AND NEW.grant_manifest_json IS NOT NULL
 AND NEW.invitation_id IS OLD.invitation_id AND NEW.workspace_id IS OLD.workspace_id
 AND NEW.source_id IS OLD.source_id AND NEW.inviter_identity_id IS OLD.inviter_identity_id
 AND NEW.inviter_issuer IS OLD.inviter_issuer AND NEW.inviter_subject IS OLD.inviter_subject
 AND NEW.inviter_email IS OLD.inviter_email AND NEW.authority_revision IS OLD.authority_revision
 AND NEW.authority_version IS OLD.authority_version AND NEW.connector_revision IS OLD.connector_revision
 AND NEW.connector_version IS OLD.connector_version AND NEW.generation_id IS OLD.generation_id
 AND NEW.source_sequence IS OLD.source_sequence AND NEW.context_hash IS OLD.context_hash
 AND json_valid(NEW.grant_manifest_json) AND json_type(NEW.grant_manifest_json)='array'
 AND json_array_length(NEW.grant_manifest_json) BETWEEN 1 AND 4
 AND EXISTS(SELECT 1 FROM portal_v2_invitation_email_outbox outbox WHERE outbox.invitation_id=OLD.invitation_id)
 AND NEW.grant_manifest_json=COALESCE((SELECT json_group_array(json_object(
   'capability',manifest.capability,'scope_type',manifest.scope_type,'scope_public_id',manifest.scope_public_id,
   'access_terms_id',manifest.access_terms_id)) FROM (SELECT capability,scope_type,scope_public_id,access_terms_id
     FROM portal_v2_invitation_entitlements WHERE invitation_id=OLD.invitation_id
     ORDER BY capability,scope_type,scope_public_id) manifest),'[]'))
BEGIN SELECT RAISE(ABORT,'secondary invitation authority is immutable'); END;

CREATE TRIGGER portal_secondary_invitation_manifest_insert BEFORE INSERT ON portal_secondary_workspace_invitation_authority
WHEN NEW.grant_manifest_json IS NOT NULL AND (NOT json_valid(NEW.grant_manifest_json)
 OR json_type(NEW.grant_manifest_json)<>'array' OR json_array_length(NEW.grant_manifest_json) NOT BETWEEN 1 AND 4
 OR NOT EXISTS(SELECT 1 FROM json_each(NEW.grant_manifest_json) grant_record
   WHERE json_extract(grant_record.value,'$.capability')='workspace.view'
     AND json_extract(grant_record.value,'$.scope_type')='workspace'
     AND json_extract(grant_record.value,'$.scope_public_id')=NEW.workspace_id)
 OR EXISTS(SELECT 1 FROM json_each(NEW.grant_manifest_json) grant_record WHERE
   json_extract(grant_record.value,'$.capability') NOT IN ('workspace.view','directory.read','delivery.view','request.create')
   OR json_extract(grant_record.value,'$.scope_type') NOT IN ('workspace','organization','department','client','project','folder')
   OR length(json_extract(grant_record.value,'$.scope_public_id')) NOT BETWEEN 1 AND 128))
BEGIN SELECT RAISE(ABORT,'secondary invitation grant manifest is invalid'); END;

CREATE TRIGGER portal_secondary_invitation_grant_insert BEFORE INSERT ON portal_v2_invitation_entitlements
WHEN EXISTS(SELECT 1 FROM portal_secondary_workspace_invitation_authority binding
  WHERE binding.invitation_id=NEW.invitation_id AND binding.grant_manifest_json IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM portal_secondary_workspace_invitation_authority binding,json_each(binding.grant_manifest_json) expected
   WHERE binding.invitation_id=NEW.invitation_id
     AND json_extract(expected.value,'$.capability')=NEW.capability
     AND json_extract(expected.value,'$.scope_type')=NEW.scope_type
     AND json_extract(expected.value,'$.scope_public_id')=NEW.scope_public_id
     AND json_extract(expected.value,'$.access_terms_id') IS NEW.access_terms_id)
BEGIN SELECT RAISE(ABORT,'secondary invitation grant differs from authority manifest'); END;
CREATE TRIGGER portal_secondary_invitation_grant_update BEFORE UPDATE ON portal_v2_invitation_entitlements
WHEN EXISTS(SELECT 1 FROM portal_secondary_workspace_invitation_authority binding WHERE binding.invitation_id=OLD.invitation_id)
BEGIN SELECT RAISE(ABORT,'secondary invitation grant is immutable'); END;

CREATE TRIGGER portal_secondary_invitation_manifest_finalize AFTER INSERT ON portal_v2_invitation_email_outbox
WHEN EXISTS(SELECT 1 FROM portal_secondary_workspace_invitation_authority binding
  WHERE binding.invitation_id=NEW.invitation_id AND binding.grant_manifest_json IS NULL)
BEGIN
 UPDATE portal_secondary_workspace_invitation_authority SET grant_manifest_json=COALESCE((
   SELECT json_group_array(json_object('capability',manifest.capability,'scope_type',manifest.scope_type,
     'scope_public_id',manifest.scope_public_id,'access_terms_id',manifest.access_terms_id))
   FROM (SELECT capability,scope_type,scope_public_id,access_terms_id
     FROM portal_v2_invitation_entitlements WHERE invitation_id=NEW.invitation_id
     ORDER BY capability,scope_type,scope_public_id) manifest
 ),'[]') WHERE invitation_id=NEW.invitation_id AND grant_manifest_json IS NULL;
END;
CREATE TRIGGER portal_secondary_invitation_grant_delete BEFORE DELETE ON portal_v2_invitation_entitlements
WHEN EXISTS(SELECT 1 FROM portal_secondary_workspace_invitation_authority binding WHERE binding.invitation_id=OLD.invitation_id)
BEGIN SELECT RAISE(ABORT,'secondary invitation grant is immutable'); END;

DROP TRIGGER IF EXISTS portal_secondary_invitation_accept;
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
     AND inviter_principal.identity_id=inviter.id AND inviter_principal.status='active'
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

-- Keep the issuer's live delegation ceiling at least as long as every grant
-- being accepted. This is a separate trigger so SQLite does not exceed its
-- expression-depth limit when compiling the hierarchy authority trigger.
CREATE TRIGGER portal_secondary_invitation_accept_terms BEFORE UPDATE OF status ON portal_v2_invitations
WHEN NEW.status='accepted' AND OLD.status<>'accepted'
 AND EXISTS(SELECT 1 FROM portal_secondary_workspace_invitation_authority binding WHERE binding.invitation_id=NEW.id)
 AND EXISTS(WITH RECURSIVE requested(capability,scope_type,scope_public_id,terms_mode,terms_project_id,terms_expiry) AS (
   SELECT grant_record.capability,grant_record.scope_type,grant_record.scope_public_id,requested_terms.mode,
     requested_terms.project_public_id,CASE WHEN requested_terms.mode='specific_date' THEN requested_terms.expires_at
       WHEN requested_terms.mode='project_end' THEN requested_deadline.deadline_at ELSE NULL END
   FROM portal_v2_invitation_entitlements grant_record
   LEFT JOIN portal_project_access_terms requested_terms ON requested_terms.id=grant_record.access_terms_id
   LEFT JOIN portal_project_access_deadlines requested_deadline ON requested_deadline.access_terms_id=requested_terms.id
   WHERE grant_record.invitation_id=NEW.id
   UNION SELECT 'member.manage','workspace',binding.workspace_id,requested_terms.mode,requested_terms.project_public_id,
     CASE WHEN requested_terms.mode='specific_date' THEN requested_terms.expires_at
       WHEN requested_terms.mode='project_end' THEN requested_deadline.deadline_at ELSE NULL END
   FROM portal_secondary_workspace_invitation_authority binding
   JOIN portal_v2_invitation_entitlements grant_record ON grant_record.invitation_id=binding.invitation_id
   LEFT JOIN portal_project_access_terms requested_terms ON requested_terms.id=grant_record.access_terms_id
   LEFT JOIN portal_project_access_deadlines requested_deadline ON requested_deadline.access_terms_id=requested_terms.id
   WHERE binding.invitation_id=NEW.id
   UNION SELECT 'member.manage',grant_record.scope_type,grant_record.scope_public_id,requested_terms.mode,
     requested_terms.project_public_id,CASE WHEN requested_terms.mode='specific_date' THEN requested_terms.expires_at
       WHEN requested_terms.mode='project_end' THEN requested_deadline.deadline_at ELSE NULL END
   FROM portal_v2_invitation_entitlements grant_record
   LEFT JOIN portal_project_access_terms requested_terms ON requested_terms.id=grant_record.access_terms_id
   LEFT JOIN portal_project_access_deadlines requested_deadline ON requested_deadline.access_terms_id=requested_terms.id
   WHERE grant_record.invitation_id=NEW.id AND grant_record.scope_type<>'workspace'
 ), issuer(workspace_id,identity_id,generation_id) AS (
   SELECT binding.workspace_id,binding.inviter_identity_id,binding.generation_id
   FROM portal_secondary_workspace_invitation_authority binding WHERE binding.invitation_id=NEW.id
 ), lineage(target_type,target_public_id,entity_type,public_id,depth) AS (
   SELECT requested.scope_type,requested.scope_public_id,target.entity_type,target.public_id,0
   FROM requested JOIN issuer
   JOIN portal_v2_directory_entities target ON target.workspace_id=issuer.workspace_id
     AND target.generation_id=issuer.generation_id AND target.entity_type=requested.scope_type
     AND target.public_id=requested.scope_public_id AND target.active=1
   WHERE requested.scope_type<>'workspace'
   UNION
   SELECT lineage.target_type,lineage.target_public_id,relation.from_type,relation.from_public_id,lineage.depth+1
   FROM lineage JOIN issuer
   JOIN portal_v2_directory_relations relation ON relation.workspace_id=issuer.workspace_id
     AND relation.generation_id=issuer.generation_id AND relation.active=1
     AND relation.to_type=lineage.entity_type AND relation.to_public_id=lineage.public_id
   JOIN portal_v2_directory_entities parent ON parent.workspace_id=relation.workspace_id
     AND parent.generation_id=relation.generation_id AND parent.entity_type=relation.from_type
     AND parent.public_id=relation.from_public_id AND parent.active=1
   WHERE lineage.depth<12
 )
 SELECT 1 FROM requested JOIN issuer WHERE NOT EXISTS(SELECT 1 FROM portal_v2_entitlements allow_record
   WHERE allow_record.workspace_id=issuer.workspace_id AND allow_record.identity_id=issuer.identity_id
     AND allow_record.capability=requested.capability AND allow_record.effect='allow'
     AND allow_record.status='active' AND allow_record.revoked_at IS NULL
     AND datetime(allow_record.valid_from)<=datetime('now')
     AND (allow_record.expires_at IS NULL OR (requested.terms_expiry IS NOT NULL
       AND datetime(allow_record.expires_at)>=datetime(requested.terms_expiry)))
     AND ((requested.scope_type='workspace' AND allow_record.scope_type='workspace'
         AND allow_record.scope_public_id=issuer.workspace_id)
       OR (requested.scope_type<>'workspace' AND ((allow_record.scope_type='workspace'
         AND allow_record.scope_public_id=issuer.workspace_id) OR EXISTS(SELECT 1 FROM lineage allow_scope
           WHERE allow_scope.target_type=requested.scope_type AND allow_scope.target_public_id=requested.scope_public_id
             AND allow_scope.entity_type=allow_record.scope_type AND allow_scope.public_id=allow_record.scope_public_id))))
     AND (allow_record.access_terms_id IS NULL OR EXISTS(SELECT 1 FROM portal_project_access_terms allow_terms
       LEFT JOIN portal_project_access_deadlines allow_deadline ON allow_deadline.access_terms_id=allow_terms.id
       WHERE allow_terms.id=allow_record.access_terms_id AND allow_terms.workspace_id=issuer.workspace_id
         AND allow_terms.source_id=(SELECT project_alpha_source_id FROM portal_v2_workspaces
           WHERE id=issuer.workspace_id AND status='active')
         AND ((requested.scope_type='workspace' AND requested.capability='workspace.view')
           OR (requested.scope_type<>'workspace' AND EXISTS(SELECT 1 FROM lineage allow_term_project
             WHERE allow_term_project.target_type=requested.scope_type
               AND allow_term_project.target_public_id=requested.scope_public_id
               AND allow_term_project.entity_type='project' AND allow_term_project.public_id=allow_terms.project_public_id)))
         AND (allow_terms.mode='until_revoked'
           OR (requested.terms_expiry IS NOT NULL AND (
             (allow_terms.mode='specific_date' AND datetime(allow_terms.expires_at)>=datetime(requested.terms_expiry))
             OR (allow_terms.mode='project_end' AND datetime(allow_deadline.deadline_at)>=datetime(requested.terms_expiry))))
           OR (requested.terms_mode='project_end' AND requested.terms_expiry IS NULL
             AND allow_terms.mode='project_end' AND allow_terms.project_public_id=requested.terms_project_id
             AND allow_deadline.access_terms_id IS NULL
             AND EXISTS(SELECT 1 FROM portal_project_access_current_lifecycle allow_lifecycle
               WHERE allow_lifecycle.workspace_id=allow_terms.workspace_id AND allow_lifecycle.source_id=allow_terms.source_id
                 AND allow_lifecycle.project_public_id=allow_terms.project_public_id
                  AND allow_lifecycle.lifecycle_status='active')))))))
BEGIN SELECT RAISE(ABORT,'secondary invitation delegation ceiling changed'); END;
