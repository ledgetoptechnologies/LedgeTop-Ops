import { HTTPException } from "hono/http-exception";
import type { ClientHubCollectionContext } from "./client-hub-collections";
import { clientHubBusinessProjectOwnership } from "./client-hub-business-projects";
import { prepareProject, type PreparedProject } from "./project-operational-memory";
import { projectAlphaReadVisibleSql } from "./project-alpha-read-visibility";
import {
  createClientInternalNoteSchema, deleteClientInternalNoteSchema, updateClientInternalNoteSchema,
  type ClientInternalNote, type ClientInternalNoteMutationResult,
} from "./client-internal-notes";
import type { Env, StaffPrincipal } from "./types";

// Project ownership is re-proved through the guarded operational project
// reader, which intentionally needs the full Worker environment (including the
// source registry bindings), not merely the two databases used by this service.
type Environment = Env;
type Database = Pick<D1Database, "prepare" | "batch">;
type Operation = "create" | "update" | "delete";
type Scope = [string, "organization" | "standalone_client", string, string];
type NoteRow = { id:string; version:number; title:string; body:string; created_by:string; updated_by:string; created_at:string; updated_at:string };
type RevisionRow = { note_id:string; version:number; action:"created"|"updated"|"deleted"; actor_id:string; created_at:string };
type Receipt = { operation_kind:Operation; request_fingerprint:string; source_id:string; root_kind:"organization"|"standalone_client"; root_id:string; project_id:string; note_id:string; result_version:number; result_json:string };

export interface ProjectInternalNotesWorkspace {
  canonicalRoot: ClientHubCollectionContext["canonicalRoot"]; contextVersion:string; projectId:string;
  notes:ClientInternalNote[]; capabilities:{canManageNotes:boolean};
}

const database = (env:Environment):Database => env.OPS_DB.withSession("first-primary");
const changed = ():never => { throw new HTTPException(409,{message:"Project notes or workspace authority changed. Refresh before continuing."}); };
const noteId = (value:string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const normalize = (value:string) => value.normalize("NFC").trim();
const scopeOf = (context:ClientHubCollectionContext,projectId:string):Scope => [context.root.source_id,context.root.kind,context.root.public_id,projectId];
const fingerprint = async(value:unknown) => [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value))))].map(byte=>byte.toString(16).padStart(2,"0")).join("");
function permissionSql(key:"team.view"|"projects.view"|"client.notes.manage"):string { return `((EXISTS(SELECT 1 FROM staff_role_assignments assignment JOIN role_permissions permission ON permission.role_id=assignment.role_id WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND permission.permission_key='${key}') OR EXISTS(SELECT 1 FROM local_staff_role_assignments assignment JOIN role_permissions permission ON permission.role_id=assignment.role_id WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND permission.permission_key='${key}') OR EXISTS(SELECT 1 FROM staff_permission_overrides permission WHERE permission.staff_id=actor.id AND permission.permission_key='${key}' AND permission.scope='global' AND permission.effect='allow')) AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides permission WHERE permission.staff_id=actor.id AND permission.permission_key='${key}' AND permission.scope='global' AND permission.effect='deny'))`; }
async function allowed(db:Database,principal:StaffPrincipal,key:"team.view"|"client.notes.manage"):Promise<boolean>{return (await db.prepare(`SELECT ${permissionSql(key)} permitted FROM staff_users actor WHERE actor.id=? AND actor.status='active'`).bind(principal.id).first<number>("permitted"))===1;}
async function proof(env:Environment,principal:StaffPrincipal,context:ClientHubCollectionContext,projectId:string,expected?:string):Promise<PreparedProject>{
  return prepareProject(env,principal,context,projectId,undefined,expected);
}
function same(first:PreparedProject,current:PreparedProject):boolean{
  return first.policy.proof===current.policy.proof&&first.sourceProof===current.sourceProof
    &&JSON.stringify(first.project)===JSON.stringify(current.project)&&JSON.stringify(first.root)===JSON.stringify(current.root);
}
async function prepare(env:Environment,principal:StaffPrincipal,context:ClientHubCollectionContext,projectId:string,manage=false,expected?:string):Promise<PreparedProject>{
  if(expected!==undefined&&expected!==context.contextVersion)return changed();
  const db=database(env),[view,write,first]=await Promise.all([allowed(db,principal,"team.view"),manage?allowed(db,principal,"client.notes.manage"):Promise.resolve(true),proof(env,principal,context,projectId,expected)]);
  if(!view)throw new HTTPException(403,{message:"Global team.view permission required"});
  if(!write)throw new HTTPException(403,{message:"Missing global permission: client.notes.manage"});
  const [currentView,currentWrite,current]=await Promise.all([allowed(db,principal,"team.view"),manage?allowed(db,principal,"client.notes.manage"):Promise.resolve(true),proof(env,principal,context,projectId,expected)]);
  if(!currentView||!currentWrite||!same(first,current))return changed(); return first;
}
function map(row:NoteRow,revisions:RevisionRow[]):ClientInternalNote{return{id:row.id,version:row.version,title:row.title,body:row.body,createdBy:row.created_by,updatedBy:row.updated_by,createdAt:row.created_at,updatedAt:row.updated_at,revisions:revisions.filter(item=>item.note_id===row.id).map(item=>({version:item.version,action:item.action,actorId:item.actor_id,createdAt:item.created_at}))};}
async function rows(db:Database,scope:Scope):Promise<{notes:NoteRow[];revisions:RevisionRow[]}>{
  const notes=(await db.prepare("SELECT id,version,title,body,created_by,updated_by,created_at,updated_at FROM project_internal_notes WHERE source_id=? AND root_kind=? AND root_id=? AND project_id=? AND deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT 100").bind(...scope).all<NoteRow>()).results;
  if(!notes.length)return{notes,revisions:[]}; const revisions=(await db.prepare(`SELECT note_id,version,action,actor_id,created_at FROM (SELECT note_id,version,action,actor_id,created_at,row_number() OVER(PARTITION BY note_id ORDER BY version DESC) rank FROM project_internal_note_revisions WHERE source_id=? AND root_kind=? AND root_id=? AND project_id=? AND note_id IN (${notes.map(()=>"?").join(",")})) WHERE rank<=20 ORDER BY note_id,version DESC`).bind(...scope,...notes.map(note=>note.id)).all<RevisionRow>()).results; return{notes,revisions};
}
export async function readProjectInternalNotes(env:Environment,principal:StaffPrincipal,context:ClientHubCollectionContext,projectId:string):Promise<ProjectInternalNotesWorkspace>{
  const first=await prepare(env,principal,context,projectId),db=database(env),initial=await rows(db,scopeOf(context,projectId)),second=await prepare(env,principal,context,projectId),current=await rows(db,scopeOf(context,projectId));
  if(!same(first,second)||JSON.stringify(initial)!==JSON.stringify(current))return changed(); return{canonicalRoot:context.canonicalRoot,contextVersion:context.contextVersion,projectId,notes:current.notes.map(note=>map(note,current.revisions)),capabilities:{canManageNotes:await allowed(db,principal,"client.notes.manage")}};
}
async function saved(db:Database,actor:string,key:string):Promise<Receipt|null>{return db.prepare("SELECT operation_kind,request_fingerprint,source_id,root_kind,root_id,project_id,note_id,result_version,result_json FROM project_internal_note_mutations WHERE actor_id=? AND idempotency_key=?").bind(actor,key).first<Receipt>();}
function replay(receipt:Receipt,operation:Operation,hash:string,scope:Scope):ClientInternalNoteMutationResult{
  if(receipt.operation_kind!==operation||receipt.request_fingerprint!==hash||JSON.stringify([receipt.source_id,receipt.root_kind,receipt.root_id,receipt.project_id])!==JSON.stringify(scope))throw new HTTPException(409,{message:"This operation key was already used for a different project note change"});
  try{const result=JSON.parse(receipt.result_json) as ClientInternalNoteMutationResult;if(result.noteId!==receipt.note_id||result.version!==receipt.result_version)throw new Error();return{...result,replayed:true};}catch{throw new HTTPException(503,{message:"Saved project note operation requires administrative review"});}
}
function key(value:string):string{if(!/^[A-Za-z0-9_-]{16,128}$/.test(value))throw new HTTPException(400,{message:"A valid Idempotency-Key header is required"});return value;}
function guardedFence(db:Database,prepared:PreparedProject,principal:StaffPrincipal,operation:Operation,id:string,version:number,idempotency:string):D1PreparedStatement{
  const {context,project,root,policy}=prepared,owner=clientHubBusinessProjectOwnership(context),rootTable=context.root.kind==="organization"?"pa_organizations":"pa_clients";
  const rootExtra=context.root.kind==="organization"?"":"AND current_root.organization_id IS NULL";
  const noteState=operation==="create"
    ? "NOT EXISTS(SELECT 1 FROM project_internal_notes current WHERE current.id=?)"
    : `EXISTS(SELECT 1 FROM project_internal_notes current WHERE current.id=? AND current.source_id=? AND current.root_kind=? AND current.root_id=? AND current.project_id=? AND current.version=? AND current.deleted_at IS NULL)`;
  const guard=`EXISTS(SELECT 1 FROM staff_users actor WHERE actor.id=? AND actor.status='active' AND ${permissionSql("team.view")} AND ${permissionSql("projects.view")} AND ${permissionSql("client.notes.manage")})
    AND EXISTS(SELECT 1 FROM pa_projects p LEFT JOIN pa_clients owner ON owner.id=p.client_id AND owner.projection_source_id=p.projection_source_id AND owner.active=1
      WHERE p.id=? AND p.active=1 AND (${owner.sql}) AND (${policy.filter.sql}) AND p.projection_source_id=?
        AND p.client_id IS ? AND p.organization_id IS ? AND p.status IS ? AND p.last_sync_id=?)
    AND EXISTS(SELECT 1 FROM ${rootTable} current_root WHERE current_root.id=? AND current_root.projection_source_id=? AND current_root.active=1
      ${rootExtra} AND current_root.last_sync_id=? AND ${projectAlphaReadVisibleSql("current_root.projection_source_id")}) AND ${noteState}`;
  const values:unknown[]=[principal.id,project.id,...owner.values,...policy.filter.values,project.projection_source_id,project.client_id,project.organization_id,project.status,project.last_sync_id,
    context.root.public_id,context.root.source_id,root.last_sync_id];
  if(operation==="create")values.push(id);else values.push(id,context.root.source_id,context.root.kind,context.root.public_id,project.id,version);
  return db.prepare(`INSERT INTO project_internal_note_write_fences
    (actor_id,idempotency_key,source_id,root_kind,root_id,project_id,note_id,operation_kind,project_client_id,project_organization_id,project_status,project_last_sync_id,root_last_sync_id,expected_version,note_writes,revision_writes,mutation_writes,write_guard)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,1,CASE WHEN ${guard} THEN 1 ELSE 0 END)`)
    .bind(principal.id,idempotency,project.projection_source_id,context.root.kind,context.root.public_id,project.id,id,operation,project.client_id,project.organization_id,project.status,project.last_sync_id,root.last_sync_id,version,...values);
}
async function mutate(env:Environment,principal:StaffPrincipal,context:ClientHubCollectionContext,projectId:string,operation:Operation,id:string,version:number,title:string,body:string,idempotency:string,expected:string):Promise<ClientInternalNoteMutationResult>{
  const requestKey=key(idempotency),scope=scopeOf(context,projectId),canonical={operation,scope,note:operation==="create"?null:id,version,title:operation==="delete"?null:title,body:operation==="delete"?null:body,expected},hash=await fingerprint(canonical),db=database(env),prior=await saved(db,principal.id,requestKey);
  if(prior){await prepare(env,principal,context,projectId,true,expected);return replay(prior,operation,hash,scope);} const prepared=await prepare(env,principal,context,projectId,true,expected);
  if(operation==="delete"){const current=await db.prepare("SELECT title,body FROM project_internal_notes WHERE id=? AND source_id=? AND root_kind=? AND root_id=? AND project_id=? AND version=? AND deleted_at IS NULL").bind(id,...scope,version).first<{title:string;body:string}>();if(!current)return changed();title=current.title;body=current.body;}
  const next=operation==="create"?1:version+1, result={noteId:id,version:next,deleted:operation==="delete",replayed:false},permitted=`EXISTS(SELECT 1 FROM staff_users actor WHERE actor.id=? AND actor.status='active' AND ${permissionSql("team.view")} AND ${permissionSql("client.notes.manage")})`,now="strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  const statements:D1PreparedStatement[]=[guardedFence(db,prepared,principal,operation,id,version,requestKey)];
  if(operation==="create")statements.push(db.prepare(`INSERT INTO project_internal_notes(id,source_id,root_kind,root_id,project_id,version,title,body,created_by,updated_by) SELECT ?,?,?,?,?,1,?,?,?,? WHERE ${permitted}`).bind(id,...scope,title,body,principal.id,principal.id,principal.id));
  else statements.push(db.prepare(`UPDATE project_internal_notes SET version=version+1,title=?,body=?,updated_by=?,updated_at=${now}${operation==="delete"?`,deleted_at=${now}`:""} WHERE id=? AND source_id=? AND root_kind=? AND root_id=? AND project_id=? AND version=? AND deleted_at IS NULL AND ${permitted}`).bind(title,body,principal.id,id,...scope,version,principal.id));
  const action=operation==="create"?"created":operation==="update"?"updated":"deleted";
  statements.push(db.prepare("INSERT INTO project_internal_note_revisions(id,note_id,source_id,root_kind,root_id,project_id,version,action,title,body,actor_id) SELECT ?,id,source_id,root_kind,root_id,project_id,version,?,?,?,? FROM project_internal_notes WHERE id=? AND source_id=? AND root_kind=? AND root_id=? AND project_id=? AND version=? AND " +(operation==="delete"?"deleted_at IS NOT NULL":"deleted_at IS NULL")).bind(crypto.randomUUID(),action,title,body,principal.id,id,...scope,next));
  statements.push(db.prepare("INSERT INTO project_internal_note_mutations(actor_id,idempotency_key,operation_kind,request_fingerprint,source_id,root_kind,root_id,project_id,note_id,result_version,result_json) SELECT ?,?,?,?,?,?,?,?,?,?,? FROM project_internal_note_revisions WHERE note_id=? AND version=? AND action=?").bind(principal.id,requestKey,operation,hash,...scope,id,next,JSON.stringify(result),id,next,action));
  try{await db.batch(statements);}catch(error){const winner=await saved(db,principal.id,requestKey);if(winner){await prepare(env,principal,context,projectId,true,expected);return replay(winner,operation,hash,scope);}if(error instanceof Error&&/project note|current context|project_internal_note_current_context|CHECK constraint failed|FOREIGN KEY|constraint/i.test(error.message))return changed();if(operation!=="create")return changed();throw error;}
  const committed=await saved(db,principal.id,requestKey);if(!committed)return changed();await prepare(env,principal,context,projectId,true,expected);return{...replay(committed,operation,hash,scope),replayed:false};
}
function input<T>(schema:{safeParse(value:unknown):{success:boolean;data?:T}},raw:unknown,message:string):T{const parsed=schema.safeParse(raw);if(!parsed.success)throw new HTTPException(400,{message});return parsed.data!;}
export async function createProjectInternalNote(env:Environment,principal:StaffPrincipal,context:ClientHubCollectionContext,projectId:string,raw:unknown,idempotency:string){const value=input(createClientInternalNoteSchema,raw,"Project note is invalid"),title=normalize(value.title);if(!title)throw new HTTPException(400,{message:"Project note title is required"});return mutate(env,principal,context,projectId,"create",crypto.randomUUID(),0,title,normalize(value.body),idempotency,value.expectedContextVersion);}
export async function updateProjectInternalNote(env:Environment,principal:StaffPrincipal,context:ClientHubCollectionContext,projectId:string,id:string,raw:unknown,idempotency:string){if(!noteId(id))throw new HTTPException(400,{message:"Project note identifier is invalid"});const value=input(updateClientInternalNoteSchema,raw,"Project note update is invalid"),title=normalize(value.title);if(!title)throw new HTTPException(400,{message:"Project note title is required"});return mutate(env,principal,context,projectId,"update",id,value.expectedVersion,title,normalize(value.body),idempotency,value.expectedContextVersion);}
export async function deleteProjectInternalNote(env:Environment,principal:StaffPrincipal,context:ClientHubCollectionContext,projectId:string,id:string,raw:unknown,idempotency:string){if(!noteId(id))throw new HTTPException(400,{message:"Project note identifier is invalid"});const value=input(deleteClientInternalNoteSchema,raw,"Project note deletion is invalid");return mutate(env,principal,context,projectId,"delete",id,value.expectedVersion,"","",idempotency,value.expectedContextVersion);}
