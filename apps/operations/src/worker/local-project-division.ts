import { HTTPException } from "hono/http-exception";
import { isAdministrator, requirePermission } from "./acl";
import { projectAlphaReadVisibleSql } from "./project-alpha-read-visibility";
import { configuredLocalDivisionIdentity } from "./local-project-division-source";
import { d1TablesPresent } from "./schema-readiness";
import type { Env, StaffPrincipal } from "./types";

type Kind = "project" | "operation" | "task";
const identifier = (value: string): string => {
  if (!/^[a-z][a-z0-9_]*$/i.test(value)) throw new Error("Invalid division query alias");
  return value;
};
/** A present null/inactive work override never falls back to the project. */
export function localDivisionJoin(alias: string, kind: Kind, divisionAlias = "d", required = false): string {
  identifier(alias); identifier(divisionAlias);
  if (!["project","operation","task"].includes(kind)) throw new Error("Invalid local division resource kind");
  const own = `${alias}_local_division`, parent = `${alias}_project_division`;
  const head=`${alias}_division_source`;
  const ownJoin = `LEFT JOIN pa_local_division_source_heads ${head} ON ${head}.projection_source_id=${alias}.projection_source_id LEFT JOIN pa_local_division_mappings ${own} ON ${own}.resource_kind='${kind}'
    AND ${own}.resource_id=${alias}.id AND ${own}.projection_source_id=${alias}.projection_source_id`;
  if (kind === "project") return `${ownJoin} ${required ? "JOIN" : "LEFT JOIN"} divisions ${divisionAlias} ON ${divisionAlias}.id=${own}.division_id AND ${own}.identity_key=${head}.identity_key AND ${divisionAlias}.active=1`;
  return `${ownJoin} LEFT JOIN pa_local_division_mappings ${parent} ON ${parent}.resource_kind='project'
    AND ${parent}.resource_id=${alias}.project_id AND ${parent}.projection_source_id=${alias}.projection_source_id
    LEFT JOIN divisions ${divisionAlias} ON ${divisionAlias}.id=CASE WHEN ${own}.resource_id IS NOT NULL THEN CASE WHEN ${own}.identity_key=${head}.identity_key THEN ${own}.division_id END ELSE CASE WHEN ${parent}.identity_key=${head}.identity_key THEN ${parent}.division_id END END AND ${divisionAlias}.active=1`;
}

interface Mapping { division_id: string | null; version: number; identity_key:string|null }

interface Project { id: string; projection_source_id: string; identity_key:string }
const tables = ["pa_local_division_source_heads","pa_local_division_mappings","pa_local_division_changes","pa_local_division_mutation_guards"];
async function projectContext(env: Env, principal: StaffPrincipal, id: string): Promise<Project> {
  if (!await d1TablesPresent(env.OPS_DB,tables)) throw new HTTPException(503,{message:"Local project division setup is not available yet"});
  if (!await isAdministrator(env,principal)) throw new HTTPException(403,{message:"An administrator must review local project divisions"});
  const project=await env.OPS_DB.withSession("first-primary").prepare(`SELECT p.id,p.projection_source_id,h.identity_key FROM pa_projects p JOIN pa_local_division_source_heads h ON h.projection_source_id=p.projection_source_id
    WHERE p.id=? AND p.active=1 AND ${projectAlphaReadVisibleSql("p.projection_source_id")}`).bind(id).first<Project>();
  if (!project) throw new HTTPException(404,{message:"Project not found"});
  if (!project.identity_key || project.identity_key!==configuredLocalDivisionIdentity(env,project.projection_source_id)) throw new HTTPException(409,{message:"The Project Alpha source identity needs verification before reviewing local divisions"});
  return project;
}
async function mapping(env:Env,project:Project):Promise<Mapping> {
  return await env.OPS_DB.withSession("first-primary").prepare(`SELECT division_id,version,identity_key FROM pa_local_division_mappings
    WHERE resource_kind='project' AND resource_id=? AND projection_source_id=?`).bind(project.id,project.projection_source_id).first<Mapping>() ?? {division_id:null,version:0,identity_key:null};
}
export async function readLocalProjectDivision(env:Env,principal:StaffPrincipal,id:string) {
  const project=await projectContext(env,principal,id), current=await mapping(env,project);
  await requirePermission(env,principal,"operations.manage",{divisionId:current.division_id??undefined});
  const active=current.division_id===null?false:Boolean(await env.OPS_DB.withSession("first-primary").prepare("SELECT 1 active FROM divisions WHERE id=? AND active=1").bind(current.division_id).first());
  return {projectId:project.id,sourceId:project.projection_source_id,divisionId:current.division_id,version:current.version,
    status:current.identity_key!==project.identity_key && current.version>0?"identity_changed":current.division_id===null?"unassigned":active?"assigned":"inactive"};
}
export async function assignLocalProjectDivision(env:Env,principal:StaffPrincipal,id:string,input:unknown,operationId:string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) throw new HTTPException(400,{message:"A UUID Idempotency-Key is required"});
  if (!input || typeof input!=="object" || Array.isArray(input)) throw new HTTPException(400,{message:"Invalid division review"});
  const value=input as Record<string,unknown>;
  if (Object.keys(value).some(key=>!["divisionId","expectedVersion","reason"].includes(key))
    || !(value.divisionId===null || typeof value.divisionId==="string" && value.divisionId.length>0 && value.divisionId.length<=128)
    || !Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion)<0 || Number(value.expectedVersion)>=Number.MAX_SAFE_INTEGER
    || typeof value.reason!=="string" || value.reason.trim().length<5 || value.reason.length>500)
    throw new HTTPException(400,{message:"Choose a division or unassigned, its current version, and a review reason"});
  const divisionId=value.divisionId as string|null,expected=Number(value.expectedVersion),reason=value.reason.trim();
  const project=await projectContext(env,principal,id),current=await mapping(env,project);
  await requirePermission(env,principal,"operations.manage",{divisionId:current.division_id??undefined});
  await requirePermission(env,principal,"operations.manage",{divisionId:divisionId??undefined});
  const bytes=new TextEncoder().encode(JSON.stringify([principal.id,project.id,project.projection_source_id,project.identity_key,divisionId,expected,reason]));
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),x=>x.toString(16).padStart(2,"0")).join("");
  const db=env.OPS_DB.withSession("first-primary");
  const replay=await db.prepare("SELECT request_sha256,actor_id,version,division_id FROM pa_local_division_changes WHERE operation_id=?").bind(operationId).first<{request_sha256:string;actor_id:string;version:number;division_id:string|null}>();
  if(replay){if(replay.request_sha256!==hash||replay.actor_id!==principal.id)throw new HTTPException(409,{message:"That operation key belongs to another review"});return {projectId:id,divisionId:replay.division_id,version:replay.version,replayed:true};}
  if(current.version!==expected)throw new HTTPException(409,{message:"The local division changed; refresh before reviewing again"});
  const version=expected+1;
  try {
    await env.OPS_DB.batch([
      env.OPS_DB.prepare(`INSERT INTO pa_local_division_mutation_guards(operation_id,write_guard) VALUES(?,CASE WHEN
        EXISTS(SELECT 1 FROM pa_projects p WHERE p.id=? AND p.projection_source_id=? AND p.active=1 AND ${projectAlphaReadVisibleSql("p.projection_source_id")})
        AND EXISTS(SELECT 1 FROM pa_local_division_source_heads h WHERE h.projection_source_id=? AND h.identity_key=?)
        AND COALESCE((SELECT version FROM pa_local_division_mappings WHERE resource_kind='project' AND resource_id=? AND projection_source_id=?),0)=?
        AND (? IS NULL OR EXISTS(SELECT 1 FROM divisions WHERE id=? AND active=1))
        AND EXISTS(SELECT 1 FROM staff_users s JOIN staff_role_assignments a ON a.staff_id=s.id JOIN role_permissions rp ON rp.role_id=a.role_id
          WHERE s.id=? AND s.status='active' AND a.role_id IN('role-owner','role-admin') AND a.scope='global' AND rp.permission_key='operations.manage')
        AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides WHERE staff_id=? AND permission_key='operations.manage' AND effect='deny'
          AND (scope='global' OR (scope='division' AND division_id IN(?,?)))) THEN 1 ELSE 0 END)`)
        .bind(operationId,id,project.projection_source_id,project.projection_source_id,project.identity_key,id,project.projection_source_id,expected,divisionId,divisionId,principal.id,principal.id,current.division_id,divisionId),
      env.OPS_DB.prepare(`INSERT INTO pa_local_division_mappings(resource_kind,resource_id,projection_source_id,identity_key,division_id,version,assignment_kind,assigned_by,reason)
        VALUES('project',?,?,?,?,?, 'staff_reviewed',?,?) ON CONFLICT(resource_kind,resource_id,projection_source_id) DO UPDATE SET
        identity_key=excluded.identity_key,division_id=excluded.division_id,version=excluded.version,assignment_kind=excluded.assignment_kind,assigned_by=excluded.assigned_by,reason=excluded.reason,updated_at=datetime('now')`)
        .bind(id,project.projection_source_id,project.identity_key,divisionId,version,principal.id,reason),
      env.OPS_DB.prepare(`INSERT INTO pa_local_division_changes(operation_id,request_sha256,actor_id,resource_id,projection_source_id,identity_key,previous_division_id,division_id,version,reason) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .bind(operationId,hash,principal.id,id,project.projection_source_id,project.identity_key,current.division_id,divisionId,version,reason),
      env.OPS_DB.prepare("DELETE FROM pa_local_division_mutation_guards WHERE operation_id=?").bind(operationId),
    ]);
  } catch {throw new HTTPException(409,{message:"Project, permission, or division authority changed; review again"});}
  return {projectId:id,divisionId,version,replayed:false};
}
