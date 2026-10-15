import type { NativeBillingSourceContext } from "../../../../packages/shared/src/operations-portal-native-billing-source-authority";
import { resolveTrustedNativeFinancialMapping,type NativeFinancialMappingEvidence } from "./project-alpha-financial-mapping";
import { resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";
import type { Env } from "./types";
export type NativeBillingSourceEnv = Pick<Env,"OPS_DB"|"PROJECT_ALPHA_API_V2_CONNECTIONS">;
export function nativeBillingSourceContextFromEvidence(e:NativeFinancialMappingEvidence):NativeBillingSourceContext{
  const r=e.row,m=e.mapping;
  return {sourceId:m.sourceId,sourceInstanceId:r.source_instance_id,applicationId:r.application_id,
    historyEpochId:r.history_epoch_id,origin:e.origin,kind:m.kind,externalId:m.externalId,publicId:m.publicId,
    mappingKind:r.mapping_kind,mappingProvenanceId:r.provenance_id,revision:m.revision,
    projectionSha256:m.projectionSha256,authorizationGeneration:m.authorizationGeneration,conflictRevision:r.conflict_frontier};
}
export async function resolveNativeBillingSourceContext(env: NativeBillingSourceEnv,
  entity: {entity_kind:"organization"|"client"|"project";native_entity_id:string}, sourceId:string):Promise<NativeBillingSourceContext|null>{
  try{
    const configured=resolveProjectAlphaApiV2Connection(env,sourceId), c=configured.connection;
    if(!configured.enabled||!c.expectedHistoryEpoch)return null;
    // Capture immutable conflict frontier BEFORE resolution. Any subsequently appended
    // conflict invalidates the reviewed transaction without discarding historical exemptions.
    const conflict=await env.OPS_DB.withSession("first-primary").prepare(`SELECT CAST(coalesce(max(conflict_id),0) AS TEXT) AS revision
      FROM project_alpha_api_v2_inventory_conflicts WHERE source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=?`)
      .bind(sourceId,c.expectedSourceInstanceId,c.expectedApplicationId,c.expectedHistoryEpoch).first<{revision:string}>();
    if(!conflict)return null;
    const mapping=await resolveTrustedNativeFinancialMapping(env,entity.entity_kind==="project"
      ? {kind:"project",externalProjectId:entity.native_entity_id,sourceId}
      : {kind:entity.entity_kind,recordId:entity.native_entity_id,sourceId});
    if(!mapping)return null;
    const provenance=entity.entity_kind==="project"
      ? await env.OPS_DB.withSession("first-primary").prepare(`SELECT establishment_kind AS mapping_kind,establishment_command_id AS provenance_id FROM project_alpha_project_mappings
        WHERE source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=?
          AND external_project_id=? AND project_alpha_public_id=?`)
        .bind(sourceId,c.expectedSourceInstanceId,c.expectedApplicationId,c.expectedHistoryEpoch,mapping.externalId,mapping.publicId)
        .first<{mapping_kind:string;provenance_id:string}>()
      : await env.OPS_DB.withSession("first-primary").prepare(`SELECT mapping_kind,provenance_id FROM project_alpha_active_directory_mappings
        WHERE source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=?
          AND record_id=? AND resource_type=? AND external_id=? AND project_alpha_public_id=?`)
        .bind(sourceId,c.expectedSourceInstanceId,c.expectedApplicationId,c.expectedHistoryEpoch,
          entity.native_entity_id,entity.entity_kind,mapping.externalId,mapping.publicId)
        .first<{mapping_kind:string;provenance_id:string}>();
    if(!provenance)return null;
    return {sourceId,sourceInstanceId:c.expectedSourceInstanceId,applicationId:c.expectedApplicationId,
      historyEpochId:c.expectedHistoryEpoch,origin:c.baseUrl,kind:mapping.kind,externalId:mapping.externalId,
      publicId:mapping.publicId,mappingKind:provenance.mapping_kind,mappingProvenanceId:provenance.provenance_id,
      revision:mapping.revision,projectionSha256:mapping.projectionSha256,
      authorizationGeneration:mapping.authorizationGeneration,conflictRevision:conflict.revision};
  }catch{return null;}
}
/** Revisions/projections/generation are review/read freshness, never enduring ownership. */
export function sameNativeBillingSourceIdentity(a:NativeBillingSourceContext,b:NativeBillingSourceContext):boolean {
  return a.sourceId===b.sourceId&&a.sourceInstanceId===b.sourceInstanceId&&a.applicationId===b.applicationId
    &&a.historyEpochId===b.historyEpochId&&a.origin===b.origin&&a.kind===b.kind&&a.externalId===b.externalId
    &&a.publicId===b.publicId&&a.mappingKind===b.mappingKind&&a.mappingProvenanceId===b.mappingProvenanceId;
}
