import { projectedPrincipalIdentitySql } from '../../../../../packages/shared/src/projected-principal-identity';
export { projectedPrincipalIdentitySql } from '../../../../../packages/shared/src/projected-principal-identity';

/** Ordinary pre-0234 projection remains supported; replacement binding requires the complete receipt contract. */
export async function projectedReenrollmentSchemaReady(db:Pick<D1Database,'prepare'>):Promise<boolean>{
  return (await db.prepare(`SELECT COUNT(*) count FROM sqlite_master WHERE
    (type='table' AND name='portal_pa_membership_reenrollment_receipts') OR
    (type='trigger' AND name IN ('portal_pa_membership_reenrollment_receipt_guard','portal_pa_membership_reenrollment_consume',
      'portal_pa_membership_reenrollment_immutable','portal_pa_membership_reenrollment_no_delete')) OR
    (type='trigger' AND name='portal_secondary_membership_authority_update' AND instr(sql,'portal_pa_membership_reenrollment_receipts')>0)`)
    .first<number>('count'))===6;
}

export function noHistoricalProjectedIdentitySql(alias:string,issuer='?',subject='?'):string{
  if(!/^[a-z_]+$/i.test(alias))throw new Error('Invalid principal alias');
  return `NOT EXISTS(SELECT 1 FROM pa_portal_principals occupied
    JOIN portal_v2_identities previous_person ON previous_person.id=occupied.identity_id
    WHERE occupied.workspace_id=${alias}.workspace_id AND occupied.public_id<>${alias}.public_id
      AND previous_person.issuer=${issuer} AND previous_person.subject=${subject})`;
}

export function noOtherProjectedIdentitySql(alias:string,issuer='?',subject='?'):string {
  if (!/^[a-z_]+$/i.test(alias)) throw new Error('Invalid principal alias');
  return `NOT EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_bindings witness
    JOIN portal_v2_identities previous_person ON previous_person.id=witness.identity_id
      AND previous_person.status='active' AND previous_person.revoked_at IS NULL
      AND lower(previous_person.verified_email)=lower(witness.verified_email)
    WHERE witness.workspace_id=${alias}.workspace_id AND witness.principal_public_id=${alias}.public_id
      AND witness.principal_source_version=${alias}.source_version AND lower(witness.verified_email)=lower(${alias}.email_hint)
      AND (previous_person.issuer<>${issuer} OR previous_person.subject<>${subject}))`;
}

/** Projection may update signed metadata while denied identities stay suspended. */
export function projectedPrincipalActivationSql(principal:string,person:string):string {
  if (![principal,person].every(a=>/^[a-z_]+$/i.test(a))) throw new Error('Invalid principal alias');
  return `EXISTS(SELECT 1 FROM portal_v2_workspaces current_workspace
    JOIN portal_v2_directory_checkpoints cp ON cp.workspace_id=current_workspace.id
    JOIN portal_v2_directory_generations gen ON gen.workspace_id=current_workspace.id AND gen.id=cp.active_generation_id AND gen.status='active' AND gen.complete=1
    JOIN portal_v2_directory_entities root ON root.workspace_id=current_workspace.id AND root.generation_id=gen.id AND root.active=1
      AND root.entity_type=current_workspace.root_type AND root.public_id=COALESCE(current_workspace.pa_organization_public_id,current_workspace.pa_client_public_id)
    JOIN portal_v2_identity_eligibility_bindings eligible ON eligible.workspace_id=current_workspace.id
      AND eligible.principal_public_id=${principal}.public_id AND eligible.identity_id=${person}.id
      AND eligible.principal_source_version=${principal}.source_version AND lower(eligible.verified_email)=lower(${principal}.email_hint)
    WHERE current_workspace.id=${principal}.workspace_id AND current_workspace.status='active'
      AND lower(${person}.verified_email)=lower(eligible.verified_email)
      AND NOT EXISTS(SELECT 1 FROM pa_portal_principals other WHERE other.workspace_id=current_workspace.id AND other.status='active' AND lower(other.email_hint)=lower(${principal}.email_hint) AND other.public_id<>${principal}.public_id)
      AND NOT EXISTS(SELECT 1 FROM portal_client_authority_workspace_claims claim WHERE claim.workspace_id=current_workspace.id AND claim.state='active')
      AND NOT EXISTS(SELECT 1 FROM portal_v2_root_access_policies policy WHERE policy.projection_source_id=current_workspace.project_alpha_source_id AND policy.root_type=current_workspace.root_type AND policy.root_public_id=root.public_id AND policy.state='revoked')
      AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_blocks block WHERE block.status='active' AND datetime(block.valid_from)<=datetime('now') AND (block.expires_at IS NULL OR datetime(block.expires_at)>datetime('now')) AND ((block.match_type='issuer_subject' AND block.issuer=${person}.issuer AND block.subject=${person}.subject) OR (block.match_type='email' AND block.normalized_email=lower(${person}.verified_email))))
      AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_denials denial WHERE denial.identity_id=${person}.id AND denial.status='active' AND denial.revoked_at IS NULL AND datetime(denial.valid_from)<=datetime('now') AND (denial.expires_at IS NULL OR datetime(denial.expires_at)>datetime('now')) AND (denial.scope_type='global' OR denial.workspace_id=current_workspace.id)))`;
}

/** Called inside the same source-fenced batch, after eligibility and before
 * membership replacement. The trigger consumes this exact witness once. */
export function projectedMembershipReenrollmentReceipt(db: Pick<D1Database,'prepare'>, workspaceId: string): D1PreparedStatement {
  return db.prepare(`INSERT INTO portal_pa_membership_reenrollment_receipts
    (id,workspace_id,identity_id,principal_public_id,old_source_version,new_source_version,generation_id,source_sequence,
      authority_revision,authority_version,connector_revision,connector_version)
    SELECT ?||json_array(p.workspace_id,p.public_id,person.id),p.workspace_id,person.id,p.public_id,m.source_version,p.source_version,c.active_generation_id,c.source_sequence,
      authority.active_revision,authority.version,authority.connector_revision,authority.connector_version
    FROM pa_portal_principals p JOIN portal_v2_identities person ON person.id=${projectedPrincipalIdentitySql('p')}
    JOIN portal_v2_workspace_memberships m ON m.workspace_id=p.workspace_id AND m.identity_id=person.id
    JOIN portal_v2_workspaces w ON w.id=p.workspace_id
    JOIN portal_v2_directory_checkpoints c ON c.workspace_id=p.workspace_id
    JOIN pa_portal_source_authorities authority ON authority.source_id=w.project_alpha_source_id AND authority.state='active'
    WHERE p.workspace_id=? AND p.status='active' AND person.status='active' AND person.revoked_at IS NULL
      AND lower(person.verified_email)=lower(p.email_hint) AND m.source_type='project_alpha'
      AND m.source_version IS NOT p.source_version AND w.project_alpha_source_id<>'project-alpha:primary'
      AND ${projectedPrincipalActivationSql('p','person')}`)
    .bind(crypto.randomUUID(),workspaceId);
}
