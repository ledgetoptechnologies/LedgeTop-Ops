/** A revoked principal keeps its historical identity. A replacement uses the
 * exact, current eligibility witness instead of stealing that unique link. */
export function projectedPrincipalIdentitySql(alias: string): string {
  if (!/^[a-z_]+$/i.test(alias)) throw new Error('Invalid principal alias');
  return `COALESCE(${alias}.identity_id,(SELECT MIN(eligible.identity_id)
    FROM portal_v2_identity_eligibility_bindings eligible
    JOIN portal_v2_identities person ON person.id=eligible.identity_id
      AND person.status='active' AND person.revoked_at IS NULL
      AND lower(person.verified_email)=lower(eligible.verified_email)
    WHERE eligible.workspace_id=${alias}.workspace_id AND eligible.principal_public_id=${alias}.public_id
      AND eligible.principal_source_version=${alias}.source_version
      AND lower(eligible.verified_email)=lower(${alias}.email_hint) HAVING COUNT(*)=1))`;
}

