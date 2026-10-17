import type { ClientHubKind } from "./client-hub-directory";
import type { Env } from "./types";
import { aliasWorkspaceWitnessSql, resolveDirectoryPortalSource, type CorrespondenceEnv, type DirectoryPortalSource, type DirectoryTuple } from "./portal-directory-correspondence";
type WorkspaceEnv=Pick<Env,"DELIVERY_DB"> & Partial<Pick<Env,"OPS_DB"|"PROJECT_ALPHA_API_V2_CONNECTIONS">>;

export interface ClientHubWorkspaceLookup {
  key: string;
  source_id: string;
  kind: ClientHubKind;
  business_id: string | null;
  pa_public_id: string | null;
  workspace_id: string | null;
}
export interface ClientHubWorkspace {
  id: string;
  root_type: ClientHubKind;
  display_name: string;
  status: string;
  legacy_account_id: string | null;
  pa_organization_public_id: string | null;
  pa_client_public_id: string | null;
  project_alpha_source_id: string;
}
export interface ClientHubWorkspaceResolution {
  workspace: ClientHubWorkspace | null;
  status: "mapped" | "missing" | "pending" | "conflict";
}

// A legacy workspace's pa_* columns contain INTERNAL IDs. Only its explicit
// account bridge plus selected legacy generation prove that interpretation.
// Native generations instead use source-issued public IDs. Never mix them.
const businessCandidate = `wanted.business_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM portal_v2_directory_checkpoints checkpoint
  JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
    AND generation.workspace_id=checkpoint.workspace_id AND generation.source_sequence=checkpoint.source_sequence
    AND generation.status='active' AND generation.complete=1
  JOIN portal_v2_directory_entities entity ON entity.workspace_id=generation.workspace_id
    AND entity.generation_id=generation.id AND entity.entity_type=workspace.root_type
    AND entity.parent_public_id IS NULL AND entity.active=1
  WHERE checkpoint.workspace_id=workspace.id AND (
    (wanted.pa_public_id IS NOT NULL AND generation.source_generation<>'legacy-backfill'
      AND entity.public_id=wanted.pa_public_id AND entity.source_version<>'legacy-backfill'
      AND ((wanted.kind='organization' AND workspace.pa_organization_public_id=wanted.pa_public_id
          AND workspace.pa_client_public_id IS NULL)
        OR (wanted.kind='standalone_client' AND workspace.pa_client_public_id=wanted.pa_public_id
          AND workspace.pa_organization_public_id IS NULL)))
    OR (wanted.directory_source_id='project-alpha:primary' AND generation.source_generation='legacy-backfill' AND generation.source_sequence=0
      AND entity.source_version='legacy-backfill' AND entity.public_id=wanted.business_id
      AND EXISTS (SELECT 1 FROM client_accounts account WHERE account.id=workspace.legacy_account_id
        AND account.status='active' AND account.project_alpha_source_id='project-alpha:primary' AND (
          (wanted.kind='organization' AND account.project_alpha_organization_id=wanted.business_id
            AND workspace.pa_organization_public_id=wanted.business_id AND workspace.pa_client_public_id IS NULL)
          OR (wanted.kind='standalone_client' AND account.project_alpha_client_id=wanted.business_id
            AND account.project_alpha_organization_id IS NULL AND workspace.pa_client_public_id=wanted.business_id
            AND workspace.pa_organization_public_id IS NULL))))))`;

const potentialBusinessCandidate = `wanted.business_id IS NOT NULL AND (
  (wanted.pa_public_id IS NOT NULL AND (
    (wanted.kind='organization' AND workspace.pa_organization_public_id=wanted.pa_public_id)
    OR (wanted.kind='standalone_client' AND workspace.pa_client_public_id=wanted.pa_public_id)))
  OR (wanted.directory_source_id='project-alpha:primary' AND EXISTS (SELECT 1 FROM client_accounts account WHERE account.id=workspace.legacy_account_id
    AND account.status='active' AND account.project_alpha_source_id='project-alpha:primary' AND (
      (wanted.kind='organization' AND account.project_alpha_organization_id=wanted.business_id
        AND workspace.pa_organization_public_id=wanted.business_id AND workspace.pa_client_public_id IS NULL)
      OR (wanted.kind='standalone_client' AND account.project_alpha_client_id=wanted.business_id
        AND account.project_alpha_organization_id IS NULL AND workspace.pa_client_public_id=wanted.business_id
        AND workspace.pa_organization_public_id IS NULL)))))`;

// Secondary visibility requires both the immutable producer reservation and a
// currently active portal-purpose authority. This proves source availability,
// not membership or permission. Primary retains its legacy compatibility path.
const sourceAuthority = `(wanted.source_id='project-alpha:primary' OR (
  workspace.legacy_account_id IS NULL
  AND EXISTS (SELECT 1 FROM pa_portal_workspace_sources owner
    WHERE owner.workspace_id=workspace.id AND owner.projection_source_id=wanted.source_id)
  AND EXISTS (SELECT 1 FROM pa_portal_source_authorities authority
    JOIN pa_portal_source_authority_revisions revision ON revision.source_id=authority.source_id
      AND revision.revision=authority.active_revision
    WHERE authority.source_id=wanted.source_id AND authority.state='active')))`;

const selectedPortalGeneration = `EXISTS (SELECT 1 FROM portal_v2_directory_checkpoints checkpoint
  JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
    AND generation.workspace_id=checkpoint.workspace_id AND generation.source_sequence=checkpoint.source_sequence
    AND generation.status='active' AND generation.complete=1
  JOIN portal_v2_directory_entities entity ON entity.workspace_id=generation.workspace_id
    AND entity.generation_id=generation.id AND entity.entity_type=workspace.root_type
    AND entity.parent_public_id IS NULL AND entity.active=1
  WHERE checkpoint.workspace_id=workspace.id
    AND entity.public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id))`;

/** Resolve exact portal workspaces, not access grants. At most two candidates
 * per input leave D1; any ambiguity is reported instead of selecting a winner. */
export async function resolveClientHubWorkspaces(
  env: WorkspaceEnv,
  lookups: readonly ClientHubWorkspaceLookup[],
): Promise<Map<string, ClientHubWorkspaceResolution>> {
  const result = new Map<string, ClientHubWorkspaceResolution>();
  for (const lookup of lookups) {
    if (result.has(lookup.key)) throw new Error("Duplicate Client Hub workspace lookup key");
    result.set(lookup.key, { workspace: null, status: "missing" });
  }
  const sourceCache=new Map<string,Promise<DirectoryPortalSource|null>>();
  const checkedCache=new Map<string,Promise<DirectoryPortalSource|null>>();
  const cachedSource=(id:string)=>{
    let pending=sourceCache.get(id);
    if(!pending){pending=resolveDirectoryPortalSource(env as CorrespondenceEnv,id);sourceCache.set(id,pending);}
    return pending;
  };
  const checkedSource=(id:string,tuple:DirectoryTuple|undefined,revision:string)=>{
    const key=JSON.stringify([id,tuple,revision]);let pending=checkedCache.get(key);
    if(!pending){pending=resolveDirectoryPortalSource(env as CorrespondenceEnv,id,tuple,revision);checkedCache.set(key,pending);}
    return pending;
  };
  const resolved=new Map<string,{source:DirectoryPortalSource;tuple?:DirectoryTuple}>();
  for(const lookup of lookups){
    if(!env.OPS_DB)continue;
    const source=await cachedSource(lookup.source_id);
    if(!source)continue;
    if(source.correspondenceRevisionId){
      if(!lookup.pa_public_id)continue;
      const mappings=await env.OPS_DB.withSession('first-primary').prepare(`SELECT source_instance_id,application_id,history_epoch_id
        FROM project_alpha_active_directory_mappings WHERE source_id=? AND resource_type=? AND project_alpha_public_id=? LIMIT 2`)
        .bind(lookup.source_id,lookup.kind==='organization'?'organization':'client',lookup.pa_public_id)
        .all<{source_instance_id:string;application_id:string;history_epoch_id:string}>();
      if(mappings.results.length!==1)continue;
      const m=mappings.results[0]!,tuple={sourceInstanceId:m.source_instance_id,applicationId:m.application_id,historyEpochId:m.history_epoch_id};
      if(!await checkedSource(lookup.source_id,tuple,source.correspondenceRevisionId))continue;
      resolved.set(lookup.key,{source,tuple});
    }else resolved.set(lookup.key,{source});
  }
  const db = env.DELIVERY_DB.withSession("first-primary");
  // Seven bindings per lookup must remain below D1's 100-variable ceiling.
  for (let start = 0; start < lookups.length; start += 14) {
    const page = lookups.slice(start, start + 14).filter(row=>!env.OPS_DB||resolved.has(row.key));
    if(!page.length)continue;
    const aliasWitness=page.some(row=>resolved.get(row.key)?.source.correspondenceRevisionId)?aliasWorkspaceWitnessSql("workspace"):"0";
    const rows = await db.prepare(`WITH wanted(lookup_key,source_id,directory_source_id,kind,business_id,pa_public_id,workspace_id) AS (
      VALUES ${page.map(() => "(?,?,?,?,?,?,?)").join(",")}
    ), candidates AS (
      SELECT wanted.lookup_key,workspace.id,workspace.root_type,workspace.display_name,workspace.status,
        workspace.legacy_account_id,workspace.pa_organization_public_id,workspace.pa_client_public_id,
        workspace.project_alpha_source_id,
        CASE WHEN wanted.workspace_id IS NOT NULL THEN ${selectedPortalGeneration}
          ELSE (${businessCandidate}) END verified,
        ROW_NUMBER() OVER(PARTITION BY wanted.lookup_key ORDER BY workspace.id) candidate_number
      FROM wanted JOIN portal_v2_workspaces workspace ON workspace.root_type=wanted.kind AND workspace.status<>'closed'
        AND workspace.project_alpha_source_id=wanted.source_id AND ${sourceAuthority}
        AND (wanted.directory_source_id=wanted.source_id OR ${aliasWitness})
        AND (wanted.source_id<>'project-alpha:primary' OR workspace.legacy_account_id IS NULL OR EXISTS (SELECT 1 FROM client_accounts account
          WHERE account.id=workspace.legacy_account_id AND (account.project_alpha_source_id IS NULL OR account.project_alpha_source_id='project-alpha:primary')))
      WHERE (wanted.workspace_id IS NOT NULL AND workspace.id=wanted.workspace_id)
        OR (wanted.workspace_id IS NULL AND ${potentialBusinessCandidate})
    ) SELECT * FROM candidates WHERE candidate_number<=2 ORDER BY lookup_key,candidate_number`)
      .bind(...page.flatMap(row => [row.key, resolved.get(row.key)?.source.portalSourceId??row.source_id, row.source_id, row.kind, row.business_id, row.pa_public_id, row.workspace_id]))
      .all<ClientHubWorkspace & { lookup_key: string; candidate_number: number; verified: number }>();
    for (const row of rows.results) {
      if (row.candidate_number > 1) result.set(row.lookup_key, { workspace: null, status: "conflict" });
      else if (!row.verified) result.set(row.lookup_key, { workspace: null, status: "pending" });
      else {
        const { lookup_key, candidate_number: _candidateNumber, verified: _verified, ...workspace } = row;
        result.set(lookup_key, { workspace, status: "mapped" });
      }
    }
  }
  checkedCache.clear(); // Final reads are fresh after the Client query, shared only within this phase.
  for(const lookup of lookups){
    const bridge=resolved.get(lookup.key);
    if(bridge?.source.correspondenceRevisionId && !await checkedSource(lookup.source_id,bridge.tuple,bridge.source.correspondenceRevisionId))
      result.set(lookup.key,{workspace:null,status:'missing'});
  }
  return result;
}

export async function resolveClientHubWorkspace(
  env: WorkspaceEnv,
  lookup: ClientHubWorkspaceLookup,
): Promise<ClientHubWorkspaceResolution> {
  const result = await resolveClientHubWorkspaces(env, [lookup]);
  return result.get(lookup.key)!;
}
