import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

export const projectAccessTermsInputSchema=z.object({
  kind:z.enum(['customer','collaborator']),mode:z.enum(['specific_date','project_end','until_revoked']),
  expiresAt:z.string().max(40).nullable(),
}).strict().superRefine((value,context)=>{
  if(value.kind==='customer'&&value.mode!=='until_revoked')context.addIssue({code:'custom',message:'Customer history has no completion cutoff'});
  if(value.mode==='specific_date'){
    if(!value.expiresAt||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.expiresAt)
      ||!Number.isFinite(Date.parse(value.expiresAt))||new Date(value.expiresAt).toISOString()!==value.expiresAt.replace(/Z$/,value.expiresAt.includes('.')?'Z':'.000Z'))
      context.addIssue({code:'custom',message:'An exact UTC expiry is required'});
  }else if(value.expiresAt!==null)context.addIssue({code:'custom',message:'Expiry belongs only to a specific date'});
});
export type ProjectAccessTermsInput=z.infer<typeof projectAccessTermsInputSchema>;
export interface ProjectAccessTermsView extends ProjectAccessTermsInput {
  id:string;effectiveExpiresAt:string|null;completionPending:boolean;expired:boolean;
}
export interface ProjectAccessTermsScope {sourceId:string;workspaceId:string;projectPublicId:string}
export interface ProjectAccessTermsActor {type:'staff'|'identity';id:string}
type Database=Pick<D1Database,'prepare'>;
const required=['portal_project_access_terms','portal_project_access_deadlines','portal_project_access_current_lifecycle','portal_workspace_invitation_policies',
  'portal_project_invitation_fences','portal_project_access_write_fences'];
export async function projectAccessTermsReady(db:Database):Promise<boolean>{
  const rows=(await db.prepare(`SELECT name FROM sqlite_master WHERE name IN (${required.map(()=>'?').join(',')})`).bind(...required).all<{name:string}>()).results;
  if(!rows.length){
    for(const table of ['portal_v2_entitlements','portal_v2_invitation_entitlements','portal_v2_authenticated_delivery_grants']){
      const columns=(await db.prepare(`PRAGMA table_info(${table})`).all<{name:string}>()).results;
      if(columns.some(column=>column.name==='access_terms_id'))throw new HTTPException(503,{message:'project_access_terms_unavailable'});
    }
    return false;
  }
  if(rows.length!==required.length)throw new HTTPException(503,{message:'project_access_terms_unavailable'});
  try{await db.prepare(`SELECT e.access_terms_id,i.access_terms_id,g.access_terms_id FROM portal_v2_entitlements e,
    portal_v2_invitation_entitlements i,portal_v2_authenticated_delivery_grants g LIMIT 0`).all();}
  catch{throw new HTTPException(503,{message:'project_access_terms_unavailable'});}
  return true;
}
export function parseProjectAccessTerms(value:unknown):ProjectAccessTermsInput{
  const result=projectAccessTermsInputSchema.safeParse(value);
  if(!result.success)throw new HTTPException(400,{message:'project_access_terms_invalid'});
  return {...result.data,expiresAt:result.data.expiresAt?new Date(result.data.expiresAt).toISOString():null};
}
/** Arguments are internal SQL expressions, never browser-provided SQL. */
export function signedProjectAccessLifecycleSql(input:{workspaceId:string;projectId:string}):string{
  return `SELECT * FROM portal_project_access_current_lifecycle WHERE workspace_id=${input.workspaceId} AND project_public_id=${input.projectId}`;
}
/** This is an additional condition on an already-authorized exact grant. It
 * cannot create entitlement, membership, ownership, or a recipient binding. */
export function projectAccessTermsSql(input:{termsId:string;workspaceId:string;projectId:string;legacyRetained:string;now?:string}):string{
  const now=input.now??"'now'";
  return `(CASE WHEN ${input.termsId} IS NULL THEN (${input.legacyRetained}) ELSE EXISTS(
    SELECT 1 FROM portal_project_access_terms access_policy_term
    JOIN portal_v2_workspaces access_policy_workspace ON access_policy_workspace.id=access_policy_term.workspace_id
      AND access_policy_workspace.project_alpha_source_id=access_policy_term.source_id
    JOIN pa_portal_workspace_sources access_policy_owner ON access_policy_owner.workspace_id=access_policy_term.workspace_id
      AND access_policy_owner.projection_source_id=access_policy_term.source_id
    LEFT JOIN portal_project_access_deadlines access_policy_deadline ON access_policy_deadline.access_terms_id=access_policy_term.id
    WHERE access_policy_term.id=${input.termsId} AND access_policy_term.workspace_id=${input.workspaceId}
      AND access_policy_term.project_public_id=${input.projectId} AND (
      access_policy_term.mode='until_revoked'
      OR (access_policy_term.mode='specific_date' AND datetime(access_policy_term.expires_at)>datetime(${now}))
      OR (access_policy_term.mode='project_end' AND (
        (access_policy_deadline.access_terms_id IS NOT NULL AND datetime(access_policy_deadline.deadline_at)>datetime(${now}))
        OR (access_policy_deadline.access_terms_id IS NULL AND EXISTS(SELECT 1 FROM portal_project_access_current_lifecycle access_policy_lifecycle
          WHERE access_policy_lifecycle.workspace_id=access_policy_term.workspace_id AND access_policy_lifecycle.source_id=access_policy_term.source_id
            AND access_policy_lifecycle.project_public_id=access_policy_term.project_public_id AND access_policy_lifecycle.lifecycle_status='active')))))) END)`;
}
export function projectAccessTermsExpirySql(termsId:string):string{
  return `(SELECT CASE WHEN access_expiry_term.mode='specific_date' THEN access_expiry_term.expires_at
    WHEN access_expiry_term.mode='project_end' THEN access_expiry_deadline.deadline_at ELSE NULL END
    FROM portal_project_access_terms access_expiry_term LEFT JOIN portal_project_access_deadlines access_expiry_deadline
    ON access_expiry_deadline.access_terms_id=access_expiry_term.id WHERE access_expiry_term.id=${termsId})`;
}
export async function readProjectAccessTerms(db:Database,id:string):Promise<ProjectAccessTermsView|null>{
  const row=await db.prepare(`SELECT t.id,t.kind,t.mode,t.expires_at,${projectAccessTermsExpirySql('t.id')} effective_expiry,
    ${projectAccessTermsSql({termsId:'t.id',workspaceId:'t.workspace_id',projectId:'t.project_public_id',legacyRetained:'0'})} current
    FROM portal_project_access_terms t WHERE t.id=?`).bind(id).first<{id:string;kind:ProjectAccessTermsInput['kind'];mode:ProjectAccessTermsInput['mode'];
      expires_at:string|null;effective_expiry:string|null;current:number}>();
  if(!row)return null;
  return {id:row.id,kind:row.kind,mode:row.mode,expiresAt:row.expires_at,effectiveExpiresAt:row.effective_expiry,
    completionPending:row.mode==='project_end'&&row.effective_expiry===null,expired:row.current!==1};
}
export async function prepareProjectAccessTerms(db:Database,scope:ProjectAccessTermsScope,value:unknown,actor:ProjectAccessTermsActor,id:string=crypto.randomUUID()){
  if(!await projectAccessTermsReady(db))throw new HTTPException(503,{message:'project_access_terms_unavailable'});
  const input=parseProjectAccessTerms(value);
  if(input.kind==='customer'&&actor.type!=='staff')throw new HTTPException(403,{message:'project_access_customer_staff_required'});
  if(input.expiresAt&&Date.parse(input.expiresAt)<=Date.now())throw new HTTPException(400,{message:'project_access_expiry_elapsed'});
  const workspace=await db.prepare(`SELECT w.project_alpha_source_id FROM portal_v2_workspaces w
    JOIN portal_v2_directory_checkpoints c ON c.workspace_id=w.id
    JOIN portal_v2_directory_generations g ON g.id=c.active_generation_id AND g.workspace_id=w.id AND g.status='active' AND g.complete=1
    JOIN portal_v2_directory_entities p ON p.workspace_id=w.id AND p.generation_id=g.id AND p.entity_type='project' AND p.active=1
    WHERE w.id=? AND w.project_alpha_source_id=? AND w.status='active' AND p.public_id=?`)
    .bind(scope.workspaceId,scope.sourceId,scope.projectPublicId).first();
  if(!workspace)throw new HTTPException(404,{message:'project_access_scope_unavailable'});
  let effectiveExpiresAt=input.expiresAt;
  if(input.mode==='project_end'){
    const lifecycle=await db.prepare(signedProjectAccessLifecycleSql({workspaceId:'?',projectId:'?'})).bind(scope.workspaceId,scope.projectPublicId)
      .first<{lifecycle_status:string;completed_at:string|null}>();
    if(!lifecycle)throw new HTTPException(409,{message:'project_access_completion_unavailable'});
    if(lifecycle.completed_at)effectiveExpiresAt=new Date(Date.parse(lifecycle.completed_at)+7*86400_000).toISOString();
    if(effectiveExpiresAt&&Date.parse(effectiveExpiresAt)<=Date.now())throw new HTTPException(409,{message:'project_access_expiry_elapsed'});
  }
  const view:ProjectAccessTermsView={id,...input,effectiveExpiresAt,completionPending:input.mode==='project_end'&&!effectiveExpiresAt,expired:false};
  const statement=db.prepare(`INSERT INTO portal_project_access_terms(id,workspace_id,source_id,project_public_id,kind,mode,expires_at,created_by_actor_type,created_by_actor_id)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(id,scope.workspaceId,scope.sourceId,scope.projectPublicId,input.kind,input.mode,input.expiresAt,actor.type,actor.id);
  return {id,input,view,statement};
}
export async function readWorkspaceInvitationPolicy(db:Database,workspaceId:string):Promise<{mode:'allowed'|'disabled'|'require_approval';version:number}>{
  const row=await db.prepare('SELECT policy,version FROM portal_workspace_invitation_policies WHERE workspace_id=?').bind(workspaceId)
    .first<{policy:'allowed'|'disabled'|'require_approval';version:number}>();
  return {mode:row?.policy??'allowed',version:row?.version??0};
}
