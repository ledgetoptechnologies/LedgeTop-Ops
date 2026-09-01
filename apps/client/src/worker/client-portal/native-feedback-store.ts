import { z } from 'zod';
import { canTransitionClientFeedback,type ClientFeedbackStatus } from '@ltds/shared';
import { feedbackFingerprint,FeedbackStoreError,type FeedbackWriteGuard } from './feedback-store';

const sourceId=z.string().regex(/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/),opaque=z.string().min(1).max(512);
const proofRow=z.object({entityType:opaque,publicId:opaque,parentPublicId:opaque.nullable(),sourceVersion:opaque,depth:z.number().int().nonnegative()}).strict();
const grant=z.object({source:z.enum(['staff','project_alpha_delivery']),id:opaque,version:z.number().int().nonnegative(),
  bindingId:opaque,bindingVersion:opaque,bindingProof:z.string().length(64),prefix:z.string().min(1).max(1024),
  ownerType:z.enum(['organization','department','client','project']),ownerPublicId:opaque,
  audienceType:z.enum(['organization','department','client','project','principal']),audiencePublicId:opaque,audienceSourceVersion:opaque,
  accessTermsId:opaque.nullable()}).strict();
export const nativeFeedbackTargetSchema=z.object({version:z.literal(1),sourceId,workspaceId:opaque,
  rootType:z.enum(['organization','standalone_client']),rootPublicId:opaque,kind:z.enum(['project','folder','file']),
  projectPublicId:opaque.nullable(),targetType:z.enum(['project','folder']),targetPublicId:opaque,label:z.string().min(1).max(160),projectName:z.string().max(160).nullable(),
  relativePath:z.string().max(2048).nullable(),storageKey:z.string().max(4096).nullable(),
  file:z.object({etag:z.string().max(256),size:z.number().int().nonnegative(),uploadedAt:opaque}).strict().nullable(),
  grant:grant.nullable(),scopeProof:z.array(proofRow).min(1).max(64),
}).strict().superRefine((target,ctx)=>{
  if(target.kind==='project'&&(target.projectPublicId===null||target.targetType!=='project'||target.grant||target.relativePath||target.storageKey||target.file))ctx.addIssue({code:'custom',message:'invalid project target'});
  if(target.kind==='folder'&&(!target.grant||target.targetType!=='folder'||target.relativePath===null||target.storageKey||target.file))ctx.addIssue({code:'custom',message:'invalid folder target'});
  if(target.kind==='file'&&(!target.grant||target.targetType!=='folder'||!target.storageKey||!target.file))ctx.addIssue({code:'custom',message:'invalid file target'});
});
export type NativeFeedbackTarget=z.infer<typeof nativeFeedbackTargetSchema>;
export interface NativeFeedbackContext {sourceId:string;workspaceId:string;identityId:string;issuer:string;subject:string}
export interface NativeFeedbackAuthorization {context:NativeFeedbackContext;target:NativeFeedbackTarget;guard:FeedbackWriteGuard;available:boolean}
export interface NativeFeedbackRecord {id:string;context:NativeFeedbackContext;target:NativeFeedbackTarget;targetFingerprint:string;requestFingerprint:string;
  message:string;status:ClientFeedbackStatus;revision:number;completionNote:string|null;completedAt:string|null;createdAt:string;updatedAt:string}
type Database=Pick<D1Database,'prepare'|'batch'>;
interface Row {id:string;source_id:string;workspace_id:string;creator_identity_id:string;principal_issuer:string;principal_subject:string;
  owner_scope_type:'organization'|'department'|'client'|'project';owner_public_id:string;
  target_json:string;target_fingerprint:string;request_fingerprint:string;message:string;status:ClientFeedbackStatus;revision:number;
  completion_note:string|null;completed_at:string|null;created_at:string;updated_at:string}
interface Receipt {feedback_id:string;fingerprint:string;result_revision:number;result_status:'in_progress'|'done'}

function context(value:NativeFeedbackContext):NativeFeedbackContext{return z.object({sourceId,workspaceId:opaque,identityId:opaque,
  issuer:z.string().min(1).max(512),subject:z.string().min(1).max(512)}).strict().parse(value);}
function record(row:Row):NativeFeedbackRecord{const target=nativeFeedbackTargetSchema.parse(JSON.parse(row.target_json));
  const owner=target.kind==='project'?{type:'project',id:target.projectPublicId!}:{type:target.grant!.ownerType,id:target.grant!.ownerPublicId};
  if(row.owner_scope_type!==owner.type||row.owner_public_id!==owner.id)throw new FeedbackStoreError('changed');
  return {id:row.id,context:context({sourceId:row.source_id,workspaceId:row.workspace_id,
  identityId:row.creator_identity_id,issuer:row.principal_issuer,subject:row.principal_subject}),target,
  targetFingerprint:row.target_fingerprint,requestFingerprint:row.request_fingerprint,message:row.message,status:row.status,revision:row.revision,
  completionNote:row.completion_note,completedAt:row.completed_at,createdAt:row.created_at,updatedAt:row.updated_at};}
export async function nativeFeedbackSchemaAvailable(env:{DELIVERY_DB:D1Database}):Promise<boolean>{
  const count=await env.DELIVERY_DB.prepare(`SELECT count(*) count FROM sqlite_master WHERE type='table' AND name IN
    ('portal_native_feedback','portal_native_feedback_events','portal_native_feedback_mutations')`).first<number>('count');return count===3;
}
export async function readNativeFeedbackRecord(db:Pick<D1Database,'prepare'>,id:string):Promise<NativeFeedbackRecord|null>{
  const row=await db.prepare('SELECT * FROM portal_native_feedback WHERE id=?').bind(id).first<Row>();return row?record(row):null;
}
const validKey=(key:string)=>/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key);
async function current(db:Pick<D1Database,'prepare'>,guard:FeedbackWriteGuard){if(!guard.sql.trim()||guard.sql.length>100_000||guard.bindings.length>75)throw new FeedbackStoreError('invalid');
  if(!await db.prepare(`SELECT 1 ok WHERE ${guard.sql}`).bind(...guard.bindings).first('ok'))throw new FeedbackStoreError('changed');}
async function prior(db:Pick<D1Database,'prepare'>,ctx:NativeFeedbackContext,key:string){const row=await db.prepare(`SELECT * FROM portal_native_feedback
  WHERE source_id=? AND workspace_id=? AND principal_issuer=? AND principal_subject=? AND mutation_key=?`)
  .bind(ctx.sourceId,ctx.workspaceId,ctx.issuer,ctx.subject,key).first<Row>();return row?record(row):null;}
export async function createNativeFeedbackRecord(db:Database,authorization:NativeFeedbackAuthorization,message:string,key:string){
  const ctx=context(authorization.context),target=nativeFeedbackTargetSchema.parse(authorization.target);
  const owner=target.kind==='project'?{type:'project' as const,id:target.projectPublicId!}:{type:target.grant!.ownerType,id:target.grant!.ownerPublicId};
  if(!validKey(key)||message!==message.trim()||message.length<1||message.length>5000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message))throw new FeedbackStoreError('invalid');
  const targetFingerprint=await feedbackFingerprint([ctx.sourceId,ctx.workspaceId,target.kind,target.projectPublicId,target.targetType,target.targetPublicId,
    target.relativePath,target.storageKey,target.file?.etag??null,target.grant?.bindingProof??null]);
  const requestFingerprint=await feedbackFingerprint([targetFingerprint,message]),existing=await prior(db,ctx,key);await current(db,authorization.guard);
  if(existing){if(existing.requestFingerprint!==requestFingerprint)throw new FeedbackStoreError('idempotency_conflict');return {record:existing,replayed:true};}
  const id=`native_${crypto.randomUUID()}`;
  try{const result=await db.batch([
    db.prepare(`INSERT INTO portal_native_feedback(id,source_id,workspace_id,creator_identity_id,principal_issuer,principal_subject,target_kind,
      owner_scope_type,owner_public_id,project_public_id,target_json,target_fingerprint,message,mutation_key,request_fingerprint)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${authorization.guard.sql}`)
      .bind(id,ctx.sourceId,ctx.workspaceId,ctx.identityId,ctx.issuer,ctx.subject,target.kind,owner.type,owner.id,target.projectPublicId,JSON.stringify(target),targetFingerprint,message,key,requestFingerprint,...authorization.guard.bindings),
    db.prepare(`INSERT INTO portal_native_feedback_events(id,feedback_id,revision,actor_type,actor_id,status)
      SELECT ?,?,1,'client',?,'new' WHERE changes()=1`).bind(crypto.randomUUID(),id,ctx.identityId),
    db.prepare(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json)
      SELECT 'client',?,'client.feedback.created','portal_native_feedback',?,? WHERE changes()=1`)
      .bind(ctx.identityId,id,JSON.stringify({sourceId:ctx.sourceId,workspaceId:ctx.workspaceId,targetKind:target.kind,revision:1})),
  ]);if(Number(result[0]?.meta.changes)!==1)throw new FeedbackStoreError('changed');}
  catch(error){const raced=await prior(db,ctx,key);if(!raced)throw error;await current(db,authorization.guard);
    if(raced.requestFingerprint!==requestFingerprint)throw new FeedbackStoreError('idempotency_conflict');return {record:raced,replayed:true};}
  const saved=await readNativeFeedbackRecord(db,id);if(!saved)throw new FeedbackStoreError('changed');return {record:saved,replayed:false};
}
export async function transitionNativeFeedbackRecord(db:Database,feedback:NativeFeedbackRecord,actorId:string,
  input:{expectedRevision:number;status:'in_progress'|'done';note:string|null},key:string,guard:FeedbackWriteGuard){
  if(!validKey(key)||!actorId||actorId.length>128||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||input.expectedRevision>2
    ||!['in_progress','done'].includes(input.status)||(input.note!==null&&(input.status!=='done'||input.note!==input.note.trim()||input.note.length<1||input.note.length>2000)))throw new FeedbackStoreError('invalid');
  const fingerprint=await feedbackFingerprint([actorId,feedback.id,input.expectedRevision,input.status,input.note]);
  const receipt=()=>db.prepare(`SELECT feedback_id,fingerprint,result_revision,result_status FROM portal_native_feedback_mutations
    WHERE actor_staff_id=? AND mutation_key=?`).bind(actorId,key).first<Receipt>();
  const replay=async(saved:Receipt)=>{await current(db,guard);if(saved.fingerprint!==fingerprint||saved.feedback_id!==feedback.id)throw new FeedbackStoreError('idempotency_conflict');
    const value=await readNativeFeedbackRecord(db,feedback.id);if(!value)throw new FeedbackStoreError('changed');return {record:value,appliedRevision:saved.result_revision,replayed:true};};
  const existing=await receipt();if(existing)return replay(existing);
  if(feedback.revision!==input.expectedRevision||!canTransitionClientFeedback(feedback.status,input.status))throw new FeedbackStoreError('changed');await current(db,guard);
  const next=input.expectedRevision+1;
  try{const result=await db.batch([
    db.prepare(`UPDATE portal_native_feedback SET status=?,revision=revision+1,completion_note=?,
      completed_at=CASE WHEN ?='done' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
      completed_by_staff_id=CASE WHEN ?='done' THEN ? ELSE NULL END,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND revision=? AND status=? AND target_fingerprint=? AND (${guard.sql})`)
      .bind(input.status,input.note,input.status,input.status,actorId,feedback.id,input.expectedRevision,feedback.status,feedback.targetFingerprint,...guard.bindings),
    db.prepare(`INSERT INTO portal_native_feedback_mutations(actor_staff_id,mutation_key,fingerprint,feedback_id,result_revision,result_status)
      SELECT ?,?,?,?,?,? WHERE changes()=1`).bind(actorId,key,fingerprint,feedback.id,next,input.status),
    db.prepare(`INSERT INTO portal_native_feedback_events(id,feedback_id,revision,actor_type,actor_id,status,note)
      SELECT ?,?,?,'staff',?,?,? WHERE changes()=1`).bind(crypto.randomUUID(),feedback.id,next,actorId,input.status,input.note),
    db.prepare(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json)
      SELECT 'staff',?,'client.feedback.status_changed','portal_native_feedback',?,? WHERE changes()=1`)
      .bind(actorId,feedback.id,JSON.stringify({sourceId:feedback.context.sourceId,workspaceId:feedback.context.workspaceId,revision:next,status:input.status})),
  ]);if(Number(result[0]?.meta.changes)!==1)throw new FeedbackStoreError('changed');}
  catch(error){const raced=await receipt();if(raced)return replay(raced);throw error;}
  const saved=await readNativeFeedbackRecord(db,feedback.id);if(!saved)throw new FeedbackStoreError('changed');return {record:saved,appliedRevision:next,replayed:false};
}
