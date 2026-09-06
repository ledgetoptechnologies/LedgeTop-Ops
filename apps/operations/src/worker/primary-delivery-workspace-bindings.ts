import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requirePermission } from "./acl";
import { normalizePrefix, resolveDivisionAssociation } from "./delivery";
import { projectAlphaReadVisibleSql } from "./project-alpha-read-visibility";
import type { Env, StaffPrincipal } from "./types";
import { requireAuthenticatedDeliveryCreation } from "./authenticated-delivery-creation-gate";
import { requireProjectAccessAuthorityMutations } from "./project-access-mutation-gate";

const PRIMARY = "project-alpha:primary" as const;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const REASON = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

export const primaryWorkspaceBindingInputSchema = z.object({
  folderRef: z.string().regex(/^[A-Za-z0-9_-]{2,1400}$/),
  workspaceId: z.string().regex(OPAQUE),
  reasonCode: z.string().regex(REASON),
  expectedContextVersion: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const primaryWorkspaceBindingRevokeSchema = z.object({
  folderRef: z.string().regex(/^[A-Za-z0-9_-]{2,1400}$/),
  expectedVersion: z.number().int().positive(),
  reasonCode: z.string().regex(REASON),
}).strict();

export type PrimaryWorkspaceBindingInput = z.infer<typeof primaryWorkspaceBindingInputSchema>;
type RootType = "organization" | "standalone_client";
interface OpsFolderProof {
  folderPrefix:string;ownerScopeType:"organization"|"client"|"project";ownerPublicId:string;ownerName:string;
  projectId:string|null;projectPublicId:string|null;projectName:string|null;divisionId:string;
  rootType:RootType;rootPublicId:string;rootName:string;projectUpdatedAt:string;projectSyncId:string;
  folderConfirmedAt:string;folderConfirmedBy:string;rootEvidence:Array<{projectId:string;projectPublicId:string;updatedAt:string;syncId:string;prefix:string}>;
}
interface ProjectionProof {
  workspaceId:string;workspaceLabel:string;rootType:RootType;rootPublicId:string;
  directoryGenerationId:string;snapshotGenerationId:string;sourceSequence:number;
  rootSourceVersion:string;ownerSourceVersion:string;projectSourceVersion:string|null;ownerName:string;projectName:string|null;
}
export interface PrimaryWorkspaceBindingTarget {
  workspaceId:string;workspaceLabel:string;rootType:RootType;rootPublicId:string;rootLabel:string;
  ownerScopeType:"organization"|"client"|"project";ownerPublicId:string;ownerName:string;
  projectPublicId:string|null;projectName:string|null;sourceId:typeof PRIMARY;contextVersion:string;
}
export interface PrimaryWorkspaceBindingView extends PrimaryWorkspaceBindingTarget {
  bindingId:string;folderPrefix:string;version:number;state:"active"|"suspended"|"revoked";
  createdAt:string;updatedAt:string;
}
export interface PrimaryWorkspaceFolderReassignment {
  opsProjectId:string;
  previousPrefix:string|null;
  nextPrefix:string;
  previousDivisionId:string|null;
  nextDivisionId:string;
}
export interface ProjectFolderAssociationCas {
  projectId:string;
  previous:{divisionId:string;r2Prefix:string}|null;
  next:{divisionId:string;r2Prefix:string};
  confirmedBy:string;
}

function db(env:Env):D1Database {
  const value=env.DELIVERY_DB as D1Database&{withSession?:(consistency:"first-primary")=>D1Database};
  return value.withSession?.("first-primary")??value;
}
const fail=(status:400|403|404|409|503,message:string):never=>{throw new HTTPException(status,{message});};
async function digest(value:unknown):Promise<string>{
  const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value))));
  return [...bytes].map(byte=>byte.toString(16).padStart(2,"0")).join("");
}
async function tables(database:D1Database,names:string[]):Promise<boolean>{
  return await database.prepare(`SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN(SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(names)).first<number>("n")===names.length;
}
export async function primaryWorkspaceBindingsReady(env:Env):Promise<boolean>{
  return env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED==="true"&&env.AUTHENTICATED_DELIVERY_GRANTS_ENABLED==="true"&&await tables(db(env),[
    "portal_primary_staff_bindings","portal_primary_staff_binding_mutations","portal_primary_staff_binding_audit",
    "portal_primary_staff_binding_write_fences","pa_portal_projection_checkpoints","pa_portal_workspace_sources",
  ]);
}
async function ready(env:Env):Promise<void>{if(!await primaryWorkspaceBindingsReady(env))fail(503,"Client Workspace folder linking is awaiting a database update");}
function ancestors(prefix:string):string[]{const parts=prefix.slice(0,-1).split("/");return parts.map((_,index)=>parts.slice(0,index+1).join("/")+"/");}

/** Suspend every Operations-owned authenticated folder route whose ownership
 * proof can change when a project-folder association moves. Delivery D1 is
 * fenced first so a failure in the later OPS_DB write leaves old client reads
 * denied. Public-share rows are intentionally outside this transaction. */
export async function suspendPrimaryWorkspaceBindingsForFolderReassignment(
  env:Env,principal:StaffPrincipal,input:PrimaryWorkspaceFolderReassignment,
):Promise<{bindingIds:string[]}> {
  await ready(env);const database=db(env);
  if(!await tables(database,["portal_v2_folder_bindings","portal_v2_workspaces","audit_log"]))
    fail(503,"Client Workspace folder reassignment is awaiting a database update");
  const affected=[input.previousPrefix,input.nextPrefix].filter((value):value is string=>!!value).map(normalizePrefix);
  const rows=await database.prepare(`SELECT binding.id binding_id,receipt.version receipt_version
    FROM portal_v2_folder_bindings binding
    JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id
      AND workspace.project_alpha_source_id='project-alpha:primary' AND workspace.status='active'
    JOIN portal_primary_staff_bindings receipt ON receipt.binding_id=binding.id
      AND receipt.workspace_id=binding.workspace_id AND receipt.source_id='project-alpha:primary' AND receipt.state='active'
    WHERE binding.source_type='operations' AND binding.status='active' AND binding.revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM json_each(?) affected
        WHERE substr(rtrim(binding.r2_prefix,'/')||'/',1,length(affected.value))=affected.value
           OR substr(affected.value,1,length(rtrim(binding.r2_prefix,'/')||'/'))=rtrim(binding.r2_prefix,'/')||'/')
    ORDER BY binding.id LIMIT 26`).bind(JSON.stringify([...new Set(affected)])).all<{binding_id:string;receipt_version:number}>();
  if(rows.results.length>25)fail(409,"Too many Client Workspace links overlap this folder reassignment; unlink them before moving the project folder");
  if(!rows.results.length)return {bindingIds:[]};
  const details=JSON.stringify({reasonCode:"operations_folder_reassigned",opsProjectId:input.opsProjectId,
    previousPrefix:input.previousPrefix?normalizePrefix(input.previousPrefix):null,nextPrefix:normalizePrefix(input.nextPrefix),
    previousDivisionId:input.previousDivisionId,nextDivisionId:input.nextDivisionId});
  const statements:D1PreparedStatement[]=[];
  for(const row of rows.results){
    const next=Number(row.receipt_version)+1;
    statements.push(
      database.prepare(`UPDATE portal_primary_staff_bindings SET state='suspended',version=?,updated_at=datetime('now')
        WHERE binding_id=? AND state='active' AND version=?`).bind(next,row.binding_id,row.receipt_version),
      database.prepare(`INSERT INTO portal_primary_staff_binding_audit(id,binding_id,binding_version,action,actor_staff_id,details_json)
        VALUES(?,?,?,'binding.suspended',?,?)`).bind(crypto.randomUUID(),row.binding_id,next,principal.id,details),
    );
    statements.push(
      database.prepare(`UPDATE portal_v2_folder_bindings SET status='suspended',updated_at=datetime('now')
        WHERE id=? AND status='active' AND revoked_at IS NULL`).bind(row.binding_id),
      database.prepare(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json)
        VALUES('staff',?,'client.workspace.binding.suspended_for_folder_reassignment','folder_binding',?,?)`)
        .bind(principal.id,row.binding_id,details),
    );
  }
  await database.batch(statements);
  return {bindingIds:rows.results.map(row=>row.binding_id)};
}

/** Compare-and-swap the Operations ownership coordinate captured before the
 * Delivery deny phase. A delayed no-op request cannot overwrite a newer move. */
export async function compareAndSwapProjectFolderAssociation(env:Env,input:ProjectFolderAssociationCas):Promise<void>{
  const database=env.OPS_DB.withSession("first-primary");
  const changed=input.previous
    ? await database.prepare(`UPDATE project_folders SET division_id=?,r2_prefix=?,match_method='manual',confirmed_by=?,confirmed_at=datetime('now')
        WHERE project_id=? AND division_id=? AND r2_prefix=?`)
      .bind(input.next.divisionId,normalizePrefix(input.next.r2Prefix),input.confirmedBy,input.projectId,
        input.previous.divisionId,input.previous.r2Prefix).run()
    : await database.prepare(`INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by)
        SELECT ?,?,?, 'manual',? WHERE NOT EXISTS(SELECT 1 FROM project_folders WHERE project_id=?)`)
      .bind(input.projectId,input.next.divisionId,normalizePrefix(input.next.r2Prefix),input.confirmedBy,input.projectId).run();
  if(Number(changed.meta.changes)!==1)fail(409,"Project folder association changed; refresh and try again");
}

async function opsFolderProof(env:Env,principal:StaffPrincipal|null,folderKey:string):Promise<OpsFolderProof>{
  const prefix=normalizePrefix(folderKey),rows=await env.OPS_DB.withSession("first-primary").prepare(`WITH matching AS(
      SELECT folder.*,length(rtrim(folder.r2_prefix,'/')||'/') prefix_length
      FROM project_folders folder WHERE rtrim(folder.r2_prefix,'/')||'/' IN(SELECT value FROM json_each(?))
    )
    SELECT matching.r2_prefix,matching.division_id,matching.confirmed_at,matching.confirmed_by,
      project.id project_id,project.name project_name,project.updated_at project_updated_at,project.last_sync_id,
      project_map.external_id project_public_id,division.active division_active,
      CASE WHEN organization.id IS NOT NULL THEN 'organization' ELSE 'standalone_client' END root_type,
      COALESCE(organization_map.external_id,client_map.external_id) root_public_id,
      COALESCE(organization.name,client.name) root_name,${projectAlphaReadVisibleSql("project.projection_source_id")} source_visible
    FROM matching
    JOIN divisions division ON division.id=matching.division_id
    JOIN pa_projects project ON project.id=matching.project_id AND project.active=1 AND project.projection_source_id='project-alpha:primary'
    JOIN pa_projection_record_ids project_map ON project_map.projection_source_id=project.projection_source_id
      AND project_map.record_kind='project' AND project_map.local_id=project.id
    LEFT JOIN pa_clients client ON client.id=project.client_id AND client.projection_source_id=project.projection_source_id AND client.active=1
    LEFT JOIN pa_organizations organization ON organization.id=COALESCE(project.organization_id,client.organization_id)
      AND organization.projection_source_id=project.projection_source_id AND organization.active=1
    LEFT JOIN pa_projection_record_ids organization_map ON organization_map.projection_source_id=project.projection_source_id
      AND organization_map.record_kind='organization' AND organization_map.local_id=organization.id
    LEFT JOIN pa_projection_record_ids client_map ON client_map.projection_source_id=project.projection_source_id
      AND client_map.record_kind='client' AND client_map.local_id=client.id
    WHERE matching.prefix_length=(SELECT max(prefix_length) FROM matching)
      AND ((organization.id IS NOT NULL AND organization_map.external_id IS NOT NULL)
        OR (organization.id IS NULL AND client.id IS NOT NULL AND client.organization_id IS NULL AND client_map.external_id IS NOT NULL))
    LIMIT 2`).bind(JSON.stringify(ancestors(prefix))).all<{
      r2_prefix:string;division_id:string;confirmed_at:string;confirmed_by:string;project_id:string;project_name:string;
      project_updated_at:string;last_sync_id:string;project_public_id:string;division_active:number;root_type:RootType;
      root_public_id:string;root_name:string;source_visible:number;
    }>();
  if(rows.results.length===1){
    const row=rows.results[0]!;
    if(row.division_active!==1||row.source_visible!==1)fail(404,"This folder is not linked to one active primary Project Alpha project");
    const candidates=[{division_id:row.division_id,r2_prefix:row.r2_prefix}],divisionId=resolveDivisionAssociation(prefix,candidates);
    if(!divisionId||divisionId!==row.division_id)fail(409,"Folder ownership is ambiguous");
    const exactDivisionId=divisionId as string;if(principal)await requirePermission(env,principal,"delivery.share.create",{divisionId:exactDivisionId},true);
    return {folderPrefix:prefix,ownerScopeType:"project",ownerPublicId:row.project_public_id,ownerName:row.project_name,
      projectId:row.project_id,projectPublicId:row.project_public_id,projectName:row.project_name,divisionId:exactDivisionId,
      rootType:row.root_type,rootPublicId:row.root_public_id,rootName:row.root_name,
      projectUpdatedAt:row.project_updated_at,projectSyncId:row.last_sync_id,folderConfirmedAt:row.confirmed_at,folderConfirmedBy:row.confirmed_by,
      rootEvidence:[{projectId:row.project_id,projectPublicId:row.project_public_id,updatedAt:row.project_updated_at,syncId:row.last_sync_id,prefix:normalizePrefix(row.r2_prefix)}]};
  }
  if(rows.results.length>1)fail(409,"Folder ownership is ambiguous");
  // A client/organization root is proven only by explicit project-folder rows
  // below this exact prefix. We never infer ownership from folder names. Every
  // descendant association must resolve to the same primary root and division.
  const descendants=await env.OPS_DB.withSession("first-primary").prepare(`SELECT folder.r2_prefix,folder.division_id,folder.confirmed_at,folder.confirmed_by,
      project.id project_id,project.updated_at,project.last_sync_id,project_map.external_id project_public_id,
      CASE WHEN organization.id IS NOT NULL THEN 'organization' ELSE 'standalone_client' END root_type,
      COALESCE(organization_map.external_id,client_map.external_id) root_public_id,COALESCE(organization.name,client.name) root_name,
      division.active division_active,${projectAlphaReadVisibleSql("project.projection_source_id")} source_visible
    FROM project_folders folder JOIN divisions division ON division.id=folder.division_id
    JOIN pa_projects project ON project.id=folder.project_id AND project.active=1 AND project.projection_source_id='project-alpha:primary'
    JOIN pa_projection_record_ids project_map ON project_map.projection_source_id=project.projection_source_id AND project_map.record_kind='project' AND project_map.local_id=project.id
    LEFT JOIN pa_clients client ON client.id=project.client_id AND client.projection_source_id=project.projection_source_id AND client.active=1
    LEFT JOIN pa_organizations organization ON organization.id=COALESCE(project.organization_id,client.organization_id)
      AND organization.projection_source_id=project.projection_source_id AND organization.active=1
    LEFT JOIN pa_projection_record_ids organization_map ON organization_map.projection_source_id=project.projection_source_id AND organization_map.record_kind='organization' AND organization_map.local_id=organization.id
    LEFT JOIN pa_projection_record_ids client_map ON client_map.projection_source_id=project.projection_source_id AND client_map.record_kind='client' AND client_map.local_id=client.id
    WHERE substr(rtrim(folder.r2_prefix,'/')||'/',1,length(?))=?
      AND ((organization.id IS NOT NULL AND organization_map.external_id IS NOT NULL)
        OR (organization.id IS NULL AND client.id IS NOT NULL AND client.organization_id IS NULL AND client_map.external_id IS NOT NULL))
    ORDER BY folder.r2_prefix LIMIT 51`).bind(prefix,prefix).all<{
      r2_prefix:string;division_id:string;confirmed_at:string;confirmed_by:string;project_id:string;updated_at:string;last_sync_id:string;
      project_public_id:string;root_type:RootType;root_public_id:string;root_name:string;division_active:number;source_visible:number;
    }>();
  if(!descendants.results.length)fail(404,"This folder has no explicit primary Project Alpha ownership mapping");
  if(descendants.results.length>50)fail(409,"This folder contains too many project mappings to establish one client root safely");
  const roots=new Set(descendants.results.map(row=>`${row.root_type}:${row.root_public_id}`)),divisions=new Set(descendants.results.map(row=>row.division_id));
  if(roots.size!==1||divisions.size!==1||descendants.results.some(row=>row.division_active!==1||row.source_visible!==1))fail(409,"This folder spans more than one client root or division");
  const first=descendants.results[0]!,divisionId=first.division_id;if(principal)await requirePermission(env,principal,"delivery.share.create",{divisionId},true);
  return {folderPrefix:prefix,ownerScopeType:first.root_type==="organization"?"organization":"client",ownerPublicId:first.root_public_id,ownerName:first.root_name,
    projectId:null,projectPublicId:null,projectName:null,divisionId,rootType:first.root_type,rootPublicId:first.root_public_id,rootName:first.root_name,
    projectUpdatedAt:"root",projectSyncId:"root",folderConfirmedAt:first.confirmed_at,folderConfirmedBy:first.confirmed_by,
    rootEvidence:descendants.results.map(row=>({projectId:row.project_id,projectPublicId:row.project_public_id,updatedAt:row.updated_at,
      syncId:row.last_sync_id,prefix:normalizePrefix(row.r2_prefix)}))};
}

async function projectionProof(env:Env,owner:OpsFolderProof,workspaceId:string):Promise<ProjectionProof>{
  if(!OPAQUE.test(workspaceId))fail(404,"Projected Client Workspace not found");
  const rows=await db(env).prepare(`SELECT workspace.id workspace_id,workspace.display_name workspace_label,
      workspace.root_type,COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) root_public_id,
      directory_generation.id directory_generation_id,projection_generation.id snapshot_generation_id,
      projection_checkpoint.source_sequence,root_entity.source_version root_source_version,
      owner_entity.source_version owner_source_version,project_entity.source_version project_source_version,
      owner_entity.display_name owner_name,project_entity.display_name project_name
    FROM portal_v2_workspaces workspace
    JOIN pa_portal_workspace_sources source ON source.workspace_id=workspace.id
      AND source.projection_source_id=workspace.project_alpha_source_id
    JOIN portal_v2_directory_checkpoints directory_checkpoint ON directory_checkpoint.workspace_id=workspace.id
    JOIN portal_v2_directory_generations directory_generation
      ON directory_generation.id=directory_checkpoint.active_generation_id AND directory_generation.workspace_id=workspace.id
      AND directory_generation.status='active' AND directory_generation.complete=1
    JOIN pa_portal_projection_checkpoints projection_checkpoint ON projection_checkpoint.workspace_id=workspace.id
      AND projection_checkpoint.source_sequence=directory_checkpoint.source_sequence
    JOIN pa_portal_projection_generations projection_generation
      ON projection_generation.id=projection_checkpoint.snapshot_generation_id AND projection_generation.workspace_id=workspace.id
      AND projection_generation.projection_source_id=workspace.project_alpha_source_id
      AND projection_generation.status='active' AND projection_generation.complete=1
    JOIN portal_v2_directory_entities root_entity
      ON root_entity.workspace_id=workspace.id AND root_entity.generation_id=directory_generation.id
      AND root_entity.entity_type=workspace.root_type
      AND root_entity.public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) AND root_entity.active=1
    JOIN portal_v2_directory_entities owner_entity
      ON owner_entity.workspace_id=workspace.id AND owner_entity.generation_id=directory_generation.id
      AND owner_entity.entity_type=? AND owner_entity.public_id=? AND owner_entity.active=1
    LEFT JOIN portal_v2_directory_entities project_entity
      ON project_entity.workspace_id=workspace.id AND project_entity.generation_id=directory_generation.id
      AND project_entity.entity_type='project' AND project_entity.public_id=? AND project_entity.active=1
    WHERE workspace.id=? AND workspace.project_alpha_source_id='project-alpha:primary'
      AND workspace.legacy_account_id IS NULL AND workspace.status='active'
      AND workspace.root_type=? AND COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id)=?
    LIMIT 2`).bind(owner.ownerScopeType,owner.ownerPublicId,owner.projectPublicId,workspaceId,owner.rootType,owner.rootPublicId).all<{
      workspace_id:string;workspace_label:string;root_type:RootType;root_public_id:string;directory_generation_id:string;
      snapshot_generation_id:string;source_sequence:number;root_source_version:string;owner_source_version:string;
      project_source_version:string|null;owner_name:string;project_name:string|null;
    }>();
  if(rows.results.length!==1)fail(404,"Projected Client Workspace not found");
  const row=rows.results[0]!;
  // Parent bytes are projection-owned. Follow the active entity chain and
  // require the selected project to terminate at this exact workspace root.
  const lineage=owner.ownerScopeType!=="project"?1:await db(env).prepare(`WITH RECURSIVE lineage(entity_type,public_id,parent_public_id,depth,path) AS(
      SELECT entity_type,public_id,parent_public_id,0,'|'||entity_type||':'||public_id||'|'
      FROM portal_v2_directory_entities WHERE workspace_id=? AND generation_id=?
        AND entity_type='project' AND public_id=? AND active=1
      UNION ALL
      SELECT parent.entity_type,parent.public_id,parent.parent_public_id,lineage.depth+1,
        lineage.path||parent.entity_type||':'||parent.public_id||'|'
      FROM lineage JOIN portal_v2_directory_entities parent ON parent.workspace_id=? AND parent.generation_id=?
        AND parent.public_id=lineage.parent_public_id AND parent.active=1
      WHERE lineage.depth<64 AND instr(lineage.path,'|'||parent.entity_type||':'||parent.public_id||'|')=0
    ) SELECT count(*) n FROM lineage WHERE entity_type=? AND public_id=?`)
    .bind(workspaceId,row.directory_generation_id,owner.projectPublicId!,workspaceId,row.directory_generation_id,owner.rootType,owner.rootPublicId)
    .first<number>("n");
  if(lineage!==1)fail(404,"The projected project is not inside the selected workspace root");
  return {workspaceId:row.workspace_id,workspaceLabel:row.workspace_label,rootType:row.root_type,rootPublicId:row.root_public_id,
    directoryGenerationId:row.directory_generation_id,snapshotGenerationId:row.snapshot_generation_id,sourceSequence:row.source_sequence,
    rootSourceVersion:row.root_source_version,ownerSourceVersion:row.owner_source_version,projectSourceVersion:row.project_source_version,
    ownerName:row.owner_name,projectName:row.project_name};
}
async function contextVersion(owner:OpsFolderProof,projection:ProjectionProof):Promise<string>{return digest({sourceId:PRIMARY,owner,projection});}
function target(owner:OpsFolderProof,projection:ProjectionProof,version:string):PrimaryWorkspaceBindingTarget{return {
  workspaceId:projection.workspaceId,workspaceLabel:projection.workspaceLabel,rootType:projection.rootType,rootPublicId:projection.rootPublicId,
  rootLabel:owner.rootName,ownerScopeType:owner.ownerScopeType,ownerPublicId:owner.ownerPublicId,ownerName:projection.ownerName,
  projectPublicId:owner.projectPublicId,projectName:projection.projectName,sourceId:PRIMARY,contextVersion:version,
};}

export async function searchPrimaryWorkspaceBindingTargets(env:Env,principal:StaffPrincipal,folderKey:string,q:string):Promise<{targets:PrimaryWorkspaceBindingTarget[]}> {
  await ready(env);if(q.length>200)fail(400,"Workspace search is invalid");
  const owner=await opsFolderProof(env,principal,folderKey);
  const rows=await db(env).prepare(`SELECT workspace.id FROM portal_v2_workspaces workspace
    JOIN pa_portal_workspace_sources source ON source.workspace_id=workspace.id AND source.projection_source_id='project-alpha:primary'
    WHERE workspace.project_alpha_source_id='project-alpha:primary' AND workspace.legacy_account_id IS NULL
      AND workspace.status='active' AND workspace.root_type=?
      AND COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id)=? LIMIT 2`)
    .bind(owner.rootType,owner.rootPublicId).all<{id:string}>();
  if(rows.results.length>1)fail(409,"More than one projected workspace owns this Project Alpha root");
  if(!rows.results.length)return {targets:[]};
  const projection=await projectionProof(env,owner,rows.results[0]!.id),needle=q.trim().toLocaleLowerCase();
  if(needle&&![projection.workspaceLabel,owner.rootName,projection.projectName].some(value=>value?.toLocaleLowerCase().includes(needle)===true))return {targets:[]};
  return {targets:[target(owner,projection,await contextVersion(owner,projection))]};
}

function bindingView(row:{binding_id:string;workspace_id:string;display_name:string;root_type:RootType;root_public_id:string;
  owner_scope_type:"organization"|"client"|"project";owner_public_id:string;owner_name:string;
  project_public_id:string|null;project_name:string|null;r2_prefix:string;version:number;state:PrimaryWorkspaceBindingView["state"];
  created_at:string;updated_at:string;ops_context_version:string}):PrimaryWorkspaceBindingView{return {
  bindingId:row.binding_id,workspaceId:row.workspace_id,workspaceLabel:row.display_name,rootType:row.root_type,
  rootPublicId:row.root_public_id,rootLabel:row.display_name,ownerScopeType:row.owner_scope_type,ownerPublicId:row.owner_public_id,
  ownerName:row.owner_name,projectPublicId:row.project_public_id,projectName:row.project_name,
  sourceId:PRIMARY,contextVersion:row.ops_context_version,folderPrefix:row.r2_prefix,version:row.version,state:row.state,
  createdAt:row.created_at,updatedAt:row.updated_at,
};}
async function readBinding(env:Env,bindingId:string):Promise<PrimaryWorkspaceBindingView|null>{
  const row=await db(env).prepare(`SELECT receipt.binding_id,receipt.workspace_id,workspace.display_name,receipt.root_type,
      receipt.root_public_id,receipt.owner_scope_type,receipt.owner_public_id,owner.display_name owner_name,
      receipt.project_public_id,project.display_name project_name,receipt.r2_prefix,receipt.version,
      receipt.state,receipt.created_at,receipt.updated_at,receipt.ops_context_version
    FROM portal_primary_staff_bindings receipt JOIN portal_v2_workspaces workspace ON workspace.id=receipt.workspace_id
    LEFT JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=receipt.workspace_id
    LEFT JOIN portal_v2_directory_entities owner ON owner.workspace_id=receipt.workspace_id
      AND owner.generation_id=checkpoint.active_generation_id AND owner.entity_type=receipt.owner_scope_type AND owner.public_id=receipt.owner_public_id
    LEFT JOIN portal_v2_directory_entities project ON project.workspace_id=receipt.workspace_id
      AND project.generation_id=checkpoint.active_generation_id AND project.entity_type='project' AND project.public_id=receipt.project_public_id
    WHERE receipt.binding_id=?`).bind(bindingId).first<any>();
  return row?bindingView(row):null;
}

/** Fail closed before any primary Operations-source grant context is used.
 * The signed Delivery projection and the independent Operations ownership
 * proof are re-read. A changed proof suspends the receipt and folder route so
 * a later grant insert cannot race against stale authority. */
export async function requireActivePrimaryWorkspaceBindingReceipt(env:Env,bindingId:string,folderKey:string):Promise<void>{
  await ready(env);
  const receipt=await db(env).prepare(`SELECT receipt.*,binding.source_version,binding.status binding_status,binding.revoked_at
    FROM portal_primary_staff_bindings receipt JOIN portal_v2_folder_bindings binding ON binding.id=receipt.binding_id
    JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id
      AND workspace.project_alpha_source_id='project-alpha:primary' AND workspace.status='active'
    WHERE receipt.binding_id=? AND receipt.source_id='project-alpha:primary'`).bind(bindingId).first<any>();
  if(!receipt)fail(409,"This legacy primary folder binding has no migration 0189 authority receipt. Relink the folder before managing Client Workspace access");
  if(receipt.state!=="active"||receipt.binding_status!=="active"||receipt.revoked_at!==null)
    fail(409,"The primary Client Workspace folder link is not active");
  let currentOwner:OpsFolderProof|null=null,currentProjection:ProjectionProof|null=null,currentVersion="";
  try{
    currentOwner=await opsFolderProof(env,null,folderKey);
    currentProjection=await projectionProof(env,currentOwner,receipt.workspace_id);
    currentVersion=await contextVersion(currentOwner,currentProjection);
  }catch{currentOwner=null;currentProjection=null;}
  const structural=!!currentOwner&&!!currentProjection
    &&currentOwner.folderPrefix===normalizePrefix(receipt.r2_prefix)
    &&currentOwner.ownerScopeType===receipt.owner_scope_type&&currentOwner.ownerPublicId===receipt.owner_public_id
    &&currentOwner.rootType===receipt.root_type&&currentOwner.rootPublicId===receipt.root_public_id
    &&currentOwner.projectPublicId===receipt.project_public_id
    &&currentProjection.workspaceId===receipt.workspace_id
    &&currentProjection.directoryGenerationId===receipt.directory_generation_id
    &&currentProjection.snapshotGenerationId===receipt.snapshot_generation_id
    &&currentProjection.sourceSequence===receipt.source_sequence
    &&currentProjection.rootSourceVersion===receipt.root_source_version
    &&currentProjection.projectSourceVersion===receipt.project_source_version;
  const compatible=receipt.reason_code==="migration_0189_legacy_compat"?structural:structural&&currentVersion===receipt.ops_context_version;
  if(compatible)return;
  const next=Number(receipt.version)+1;
  try{await db(env).batch([
    db(env).prepare(`UPDATE portal_primary_staff_bindings SET state='suspended',version=?,updated_at=datetime('now')
      WHERE binding_id=? AND state='active' AND version=?`).bind(next,bindingId,receipt.version),
    db(env).prepare(`UPDATE portal_v2_folder_bindings SET status='suspended',updated_at=datetime('now')
      WHERE id=? AND status='active' AND revoked_at IS NULL`).bind(bindingId),
    db(env).prepare(`INSERT INTO portal_primary_staff_binding_audit(id,binding_id,binding_version,action,actor_staff_id,details_json)
      VALUES(?,?,?,'binding.suspended','system:context-revalidation',?)`).bind(crypto.randomUUID(),bindingId,next,
        JSON.stringify({reasonCode:"authority_context_changed"})),
  ]);}catch{/* A concurrent request may already have suspended this receipt. */}
  fail(409,"The primary folder or signed Project Alpha context changed. The Client Workspace link was suspended; review and relink it before managing access");
}
function key(value:string):string{if(!IDEMPOTENCY.test(value))fail(400,"Idempotency-Key is invalid");return value;}
async function replay(env:Env,principal:StaffPrincipal,idempotencyKey:string,action:string,fingerprint:string){
  const row=await db(env).prepare(`SELECT action,request_fingerprint,binding_id FROM portal_primary_staff_binding_mutations
    WHERE actor_staff_id=? AND idempotency_key=?`).bind(principal.id,idempotencyKey).first<{action:string;request_fingerprint:string;binding_id:string}>();
  if(!row)return null;if(row.action!==action||row.request_fingerprint!==fingerprint)fail(409,"Idempotency-Key was already used for a different folder link");
  const binding=await readBinding(env,row.binding_id);if(!binding)fail(409,"The previous folder link outcome cannot be verified");return {binding,replayed:true};
}

export async function createPrimaryWorkspaceBinding(env:Env,principal:StaffPrincipal,folderKey:string,inputValue:unknown,idempotencyValue:string){
  await ready(env);requireProjectAccessAuthorityMutations(env);requireAuthenticatedDeliveryCreation(env);
  const parsed=primaryWorkspaceBindingInputSchema.safeParse(inputValue);
  const input:PrimaryWorkspaceBindingInput=parsed.success?parsed.data:fail(400,"Workspace folder link is invalid");
  const idempotencyKey=key(idempotencyValue),owner=await opsFolderProof(env,principal,folderKey);
  const projection=await projectionProof(env,owner,input.workspaceId),currentContext=await contextVersion(owner,projection);
  if(currentContext!==input.expectedContextVersion)fail(409,"Workspace or folder context changed; review the link again");
  const fingerprint=await digest({action:"binding.create",folderPrefix:owner.folderPrefix,workspaceId:input.workspaceId,reasonCode:input.reasonCode,expectedContextVersion:input.expectedContextVersion});
  const previous=await replay(env,principal,idempotencyKey,"binding.create",fingerprint);if(previous)return previous;
  const existing=await db(env).prepare(`SELECT binding.id FROM portal_v2_folder_bindings binding
    JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id
    WHERE binding.r2_prefix IN (?,?) AND binding.status='active' AND binding.revoked_at IS NULL
      AND workspace.project_alpha_source_id='project-alpha:primary' LIMIT 2`)
    .bind(owner.folderPrefix,owner.folderPrefix.slice(0,-1)).all<{id:string}>();
  if(existing.results.length)fail(409,"This folder is already linked to a Client Workspace");
  // The client authorizer joins the binding owner to the active signed
  // directory entity by this version. The receipt/context hash carries the
  // broader generation proof; source_version must remain the owner's signed
  // entity version rather than an unrelated digest.
  const bindingId=crypto.randomUUID(),auditId=crypto.randomUUID(),sourceVersion=projection.ownerSourceVersion;
  await db(env).batch([
    db(env).prepare(`INSERT INTO portal_v2_folder_bindings
      (id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version)
      VALUES(?,?,?,?,?,'operations',?)`).bind(bindingId,projection.workspaceId,owner.ownerScopeType,owner.ownerPublicId,owner.folderPrefix,sourceVersion),
    db(env).prepare(`INSERT INTO portal_primary_staff_bindings
      (binding_id,workspace_id,source_id,root_type,root_public_id,owner_scope_type,owner_public_id,project_public_id,directory_generation_id,
       snapshot_generation_id,source_sequence,root_source_version,project_source_version,r2_prefix,ops_project_id,
       ops_context_version,created_by_staff_id,reason_code,state)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(bindingId,projection.workspaceId,PRIMARY,owner.rootType,owner.rootPublicId,owner.ownerScopeType,owner.ownerPublicId,owner.projectPublicId,projection.directoryGenerationId,
        projection.snapshotGenerationId,projection.sourceSequence,projection.rootSourceVersion,projection.projectSourceVersion,
        owner.folderPrefix,owner.projectId,currentContext,principal.id,input.reasonCode,"active"),
    db(env).prepare(`INSERT INTO portal_primary_staff_binding_mutations
      (actor_staff_id,idempotency_key,action,request_fingerprint,binding_id,binding_version)
      VALUES(?,?,'binding.create',?,?,1)`).bind(principal.id,idempotencyKey,fingerprint,bindingId),
    db(env).prepare(`INSERT INTO portal_primary_staff_binding_audit
      (id,binding_id,binding_version,action,actor_staff_id,details_json)
      VALUES(?,?,1,'binding.created',?,?)`).bind(auditId,bindingId,principal.id,JSON.stringify({reasonCode:input.reasonCode,
        sourceId:PRIMARY,workspaceId:projection.workspaceId,rootType:owner.rootType,rootPublicId:owner.rootPublicId,
        projectPublicId:owner.projectPublicId,directoryGenerationId:projection.directoryGenerationId,
        snapshotGenerationId:projection.snapshotGenerationId,sourceSequence:projection.sourceSequence})),
    db(env).prepare(`INSERT INTO portal_primary_staff_binding_write_fences(id,write_guard) SELECT ?,CASE WHEN
      EXISTS(SELECT 1 FROM portal_primary_staff_bindings receipt JOIN portal_v2_folder_bindings binding ON binding.id=receipt.binding_id
        WHERE receipt.binding_id=? AND receipt.state='active' AND receipt.version=1 AND binding.status='active') THEN 1 ELSE 0 END`)
      .bind(crypto.randomUUID(),bindingId),
  ]);
  // D1 bindings cannot transact with OPS_DB. Re-read the complete Operations
  // proof after publication and fail closed by suspending this exact receipt.
  let stable=false;try{
    const afterOwner=await opsFolderProof(env,principal,folderKey),afterProjection=await projectionProof(env,afterOwner,input.workspaceId);
    stable=await contextVersion(afterOwner,afterProjection)===currentContext;
  }catch{stable=false;}
  if(!stable){
    await db(env).batch([
      db(env).prepare(`UPDATE portal_primary_staff_bindings SET state='suspended',version=2,updated_at=datetime('now') WHERE binding_id=? AND state='active' AND version=1`).bind(bindingId),
      db(env).prepare(`UPDATE portal_v2_folder_bindings SET status='suspended',updated_at=datetime('now') WHERE id=? AND status='active'`).bind(bindingId),
      db(env).prepare(`INSERT INTO portal_primary_staff_binding_audit(id,binding_id,binding_version,action,actor_staff_id,details_json)
        VALUES(?,?,2,'binding.suspended',?,?)`).bind(crypto.randomUUID(),bindingId,principal.id,JSON.stringify({reasonCode:"cross_database_context_changed"})),
    ]);
    fail(409,"Workspace or folder context changed while linking; the link was suspended and grants were not created");
  }
  const binding=await readBinding(env,bindingId);if(!binding)fail(409,"The folder link outcome could not be verified");return {binding,replayed:false};
}

export async function revokePrimaryWorkspaceBinding(env:Env,principal:StaffPrincipal,bindingId:string,folderKey:string,inputValue:unknown,idempotencyValue:string){
  await ready(env);requireProjectAccessAuthorityMutations(env);if(!OPAQUE.test(bindingId))fail(404,"Workspace folder link not found");
  const parsed=primaryWorkspaceBindingRevokeSchema.safeParse(inputValue);
  const input:z.infer<typeof primaryWorkspaceBindingRevokeSchema>=parsed.success?parsed.data:fail(400,"Workspace folder unlink is invalid");
  const idempotencyKey=key(idempotencyValue),owner=await opsFolderProof(env,principal,folderKey);
  await requirePermission(env,principal,"delivery.share.revoke",{divisionId:owner.divisionId},true);
  const fingerprint=await digest({action:"binding.revoke",bindingId,folderPrefix:owner.folderPrefix,expectedVersion:input.expectedVersion,reasonCode:input.reasonCode});
  const previous=await replay(env,principal,idempotencyKey,"binding.revoke",fingerprint);if(previous)return previous;
  const current=await db(env).prepare(`SELECT receipt.*,binding.owner_public_id,binding.r2_prefix,binding.status binding_status
    FROM portal_primary_staff_bindings receipt JOIN portal_v2_folder_bindings binding ON binding.id=receipt.binding_id
    WHERE receipt.binding_id=?`).bind(bindingId).first<any>();
  if(!current||current.state!=="active"||current.binding_status!=="active"||current.version!==input.expectedVersion
    ||current.owner_scope_type!==owner.ownerScopeType||current.owner_public_id!==owner.ownerPublicId
    ||normalizePrefix(current.r2_prefix)!==owner.folderPrefix)fail(409,"Workspace folder link changed; refresh before unlinking");
  const active=await db(env).prepare(`SELECT count(*) n FROM portal_v2_authenticated_delivery_grants
    WHERE folder_binding_id=? AND status='active' AND revoked_at IS NULL AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))`)
    .bind(bindingId).first<number>("n");
  if(active)fail(409,"Revoke active Client Workspace grants before unlinking this folder");
  const next=input.expectedVersion+1;
  await db(env).batch([
    db(env).prepare(`UPDATE portal_primary_staff_bindings SET state='revoked',version=?,updated_at=datetime('now')
      WHERE binding_id=? AND state='active' AND version=?`).bind(next,bindingId,input.expectedVersion),
    db(env).prepare(`UPDATE portal_v2_folder_bindings SET status='revoked',revoked_at=datetime('now'),updated_at=datetime('now')
      WHERE id=? AND status='active' AND revoked_at IS NULL`).bind(bindingId),
    db(env).prepare(`INSERT INTO portal_primary_staff_binding_mutations
      (actor_staff_id,idempotency_key,action,request_fingerprint,binding_id,binding_version)
      VALUES(?,?,'binding.revoke',?,?,?)`).bind(principal.id,idempotencyKey,fingerprint,bindingId,next),
    db(env).prepare(`INSERT INTO portal_primary_staff_binding_audit
      (id,binding_id,binding_version,action,actor_staff_id,details_json)
      VALUES(?,?,?,'binding.revoked',?,?)`).bind(crypto.randomUUID(),bindingId,next,principal.id,JSON.stringify({reasonCode:input.reasonCode})),
    db(env).prepare(`INSERT INTO portal_primary_staff_binding_write_fences(id,write_guard) SELECT ?,CASE WHEN
      EXISTS(SELECT 1 FROM portal_primary_staff_bindings receipt JOIN portal_v2_folder_bindings binding ON binding.id=receipt.binding_id
        WHERE receipt.binding_id=? AND receipt.state='revoked' AND receipt.version=? AND binding.status='revoked' AND binding.revoked_at IS NOT NULL)
      THEN 1 ELSE 0 END`).bind(crypto.randomUUID(),bindingId,next),
  ]);
  const binding=await readBinding(env,bindingId);if(!binding)fail(409,"The unlink outcome could not be verified");return {binding,replayed:false};
}
