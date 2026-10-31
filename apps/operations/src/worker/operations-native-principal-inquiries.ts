import type { Env } from "./types";

export type OpsPrincipalInquiryProof=Readonly<{
 targetId:string;targetRevision:number;clientAuthorityId:string;workspaceId:string;targetClientRecordId:string;recipientBindingId:string;
 issuer:string;subject:string;baseOperationId:string;ownershipEpoch:number;grantRevision:number;capabilityOperationId:string;capabilityRevision:number;
 publicationOperationId:string;publicationRevision:number;publicationSourceSequence:number;publicationSnapshotId:string;publicationSnapshotSha256:string;expiresAt:string;
}>;
export type OpsInquiryInput=Readonly<{kind:"website"|"drone"|"other";title:string;details:string;location:string|null;idempotencyKey:string}>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH=/^[0-9a-f]{64}$/u;
const iso=(v:unknown):v is string=>typeof v==="string"&&v.length===24&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const exact=(v:unknown,keys:readonly string[]):Record<string,unknown>|null=>{try{
 if(!v||typeof v!=="object"||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype)return null;
 const d=Object.getOwnPropertyDescriptors(v),names=Reflect.ownKeys(d);
 if(names.length!==keys.length||names.some(k=>typeof k!=="string"||!keys.includes(k)||!("value"in d[k]!)))return null;
 return Object.fromEntries(keys.map(k=>[k,d[k]!.value]));}catch{return null;}};
function validProof(p:OpsPrincipalInquiryProof):boolean{return UUID.test(p.targetId)&&Number.isSafeInteger(p.targetRevision)&&p.targetRevision>0&&UUID.test(p.clientAuthorityId)
 &&typeof p.workspaceId==="string"&&p.workspaceId.length>0&&p.workspaceId.length<=200&&typeof p.targetClientRecordId==="string"&&p.targetClientRecordId.length>0&&p.targetClientRecordId.length<=191
 &&UUID.test(p.recipientBindingId)&&typeof p.issuer==="string"&&p.issuer.length>0&&p.issuer.length<=512&&typeof p.subject==="string"&&p.subject.length>0&&p.subject.length<=512
 &&UUID.test(p.baseOperationId)&&Number.isSafeInteger(p.ownershipEpoch)&&p.ownershipEpoch>0&&Number.isSafeInteger(p.grantRevision)&&p.grantRevision>0
 &&UUID.test(p.capabilityOperationId)&&p.capabilityRevision===1&&UUID.test(p.publicationOperationId)&&Number.isSafeInteger(p.publicationRevision)&&p.publicationRevision>0
 &&Number.isSafeInteger(p.publicationSourceSequence)&&p.publicationSourceSequence>0&&UUID.test(p.publicationSnapshotId)&&HASH.test(p.publicationSnapshotSha256)&&iso(p.expiresAt);}
const proofKeys=["targetId","targetRevision","clientAuthorityId","workspaceId","targetClientRecordId","recipientBindingId","issuer","subject","baseOperationId",
 "ownershipEpoch","grantRevision","capabilityOperationId","capabilityRevision","publicationOperationId","publicationRevision","publicationSourceSequence","publicationSnapshotId","publicationSnapshotSha256","expiresAt"] as const;
function canonicalProofs(value:unknown):readonly OpsPrincipalInquiryProof[]|null{
 if(!Array.isArray(value)||value.length<1||value.length>20)return null;
 const proofs:OpsPrincipalInquiryProof[]=[];
 for(const raw of value){const item=exact(raw,proofKeys);if(!item)return null;const proof=item as unknown as OpsPrincipalInquiryProof;if(!validProof(proof))return null;proofs.push(proof);}
 proofs.sort((a,b)=>a.targetId.localeCompare(b.targetId)||a.recipientBindingId.localeCompare(b.recipientBindingId));
 if(new Set(proofs.map(p=>p.targetId+"\0"+p.recipientBindingId)).size!==proofs.length
  ||proofs.some(p=>p.issuer!==proofs[0]!.issuer||p.subject!==proofs[0]!.subject))return null;
 return Object.freeze(proofs);
}
function parseRequest(raw:string,kind:"list"|"submit"):{proofs:readonly OpsPrincipalInquiryProof[];input?:OpsInquiryInput}|null{
 try{if(raw.length>65536)return null;const root=exact(JSON.parse(raw),kind==="list"?["protocolVersion","proofs"]:["protocolVersion","proofs","input"]);
  if(!root||root.protocolVersion!==1)return null;const proofs=canonicalProofs(root.proofs);if(!proofs)return null;
  if(kind==="list")return{proofs};const input=exact(root.input,["kind","title","details","location","idempotencyKey"]);
  if(!input||!(input.kind==="website"||input.kind==="drone"||input.kind==="other")||typeof input.title!=="string"||!input.title||input.title.trim()!==input.title||input.title.length>160
   ||typeof input.details!=="string"||!input.details||input.details.trim()!==input.details||input.details.length>4000||!(input.location===null||typeof input.location==="string"&&input.location.length<=300)
   ||typeof input.idempotencyKey!=="string"||!/^[A-Za-z0-9._:-]{16,128}$/u.test(input.idempotencyKey))return null;
  return{proofs,input:input as OpsInquiryInput};}catch{return null;}
}
/** One proof at a time keeps SQLite's expression tree bounded. The write uses
 * a transaction-local reservation set to require every proof in one batch. */
const witnessOneSql=()=>`EXISTS(
 SELECT 1 FROM operations_portal_native_inquiry_capability_heads ch
 JOIN operations_portal_native_inquiry_capability_commands cap ON cap.operation_id=ch.latest_operation_id
  AND cap.intent_id=ch.intent_id AND cap.action='grant' AND cap.resulting_revision=ch.revision
 JOIN operations_portal_native_inquiry_capability_receipts cr ON cr.operation_id=cap.operation_id
  AND cr.request_fingerprint=cap.request_fingerprint AND cr.state='prepared'
 JOIN operations_portal_native_inquiry_capability_closures cc ON cc.operation_id=cap.operation_id
  AND cc.request_fingerprint=cap.request_fingerprint AND cc.client_receipt_fingerprint=cr.request_fingerprint
  AND cc.resulting_state='active' AND length(cc.operations_receipt_fingerprint)=64
 JOIN operations_portal_native_recipient_authority_heads bh ON bh.recipient_binding_id=cap.recipient_binding_id
  AND bh.target_id=cap.target_id AND bh.latest_operation_id=cap.base_operation_id
  AND bh.ownership_epoch=cap.base_ownership_epoch AND bh.grant_revision=cap.base_grant_revision AND bh.state='active'
 JOIN operations_portal_native_authority_receipts br ON br.operation_id=bh.latest_operation_id
  AND br.ownership_epoch=bh.ownership_epoch AND br.grant_revision=bh.grant_revision AND br.state='active'
 JOIN operations_portal_native_authority_commands bc ON bc.operation_id=br.operation_id
  AND bc.request_fingerprint=br.request_fingerprint AND bc.action='recipient.grant'
  AND bc.permissions_json='["operations.service_home.read"]'
 JOIN operations_portal_native_workspace_authority_heads wh ON wh.target_id=bh.target_id
  AND wh.ownership_epoch=bh.ownership_epoch AND wh.state='active'
 JOIN operations_portal_workspace_publication_heads ph ON ph.target_id=wh.target_id
  AND ph.target_revision=cap.target_revision AND ph.client_authority_id=cap.client_authority_id
  AND ph.workspace_id=cap.workspace_id AND ph.latest_operation_id=cap.publication_operation_id
  AND ph.revision=cap.publication_revision AND ph.source_sequence=cap.publication_source_sequence
  AND ph.snapshot_id=cap.publication_snapshot_id AND ph.snapshot_sha256=cap.publication_snapshot_sha256
 JOIN operations_portal_workspace_publication_snapshots ps ON ps.snapshot_id=ph.snapshot_id
  AND ps.operation_id=ph.latest_operation_id AND ps.snapshot_sha256=ph.snapshot_sha256
 JOIN json_each(ps.snapshot_json,'$.directoryRecords') member
 WHERE ch.target_id=? AND ch.recipient_binding_id=? AND ch.state='active'
  AND cap.permission='operations.request.create' AND cap.target_id=? AND cap.target_revision=?
  AND cap.client_authority_id=? AND cap.workspace_id=? AND cap.target_client_record_id=? AND cap.recipient_binding_id=?
  AND cap.issuer=? AND cap.subject=? AND cap.base_operation_id=? AND cap.base_ownership_epoch=? AND cap.base_grant_revision=?
  AND cap.operation_id=? AND cap.resulting_revision=? AND cap.publication_operation_id=? AND cap.publication_revision=?
  AND cap.publication_source_sequence=? AND cap.publication_snapshot_id=? AND cap.publication_snapshot_sha256=?
  AND cap.expires_at=? AND cap.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND (bh.expires_at IS NULL OR datetime(cap.expires_at)<=datetime(bh.expires_at))
  AND bc.target_id=cap.target_id AND bc.recipient_binding_id=cap.recipient_binding_id
  AND bc.enrollment_intent_id=ch.intent_id AND bc.target_client_record_id=cap.target_client_record_id
  AND bc.issuer=cap.issuer AND bc.subject=cap.subject
  AND json_extract(member.value,'$.recordId')=cap.target_client_record_id AND json_extract(member.value,'$.kind')='client'
  AND ((wh.root_kind='organization' AND json_extract(member.value,'$.parentRecordId')=wh.root_record_id)
   OR (wh.root_kind='standalone_client' AND json_extract(member.value,'$.parentRecordId') IS NULL
    AND json_extract(member.value,'$.recordId')=wh.root_record_id)))`;
const setJson=(proofs:readonly OpsPrincipalInquiryProof[])=>JSON.stringify(proofs);
const pins=(p:OpsPrincipalInquiryProof):unknown[]=>[p.targetId,p.recipientBindingId,p.targetId,p.targetRevision,p.clientAuthorityId,p.workspaceId,
 p.targetClientRecordId,p.recipientBindingId,p.issuer,p.subject,p.baseOperationId,p.ownershipEpoch,p.grantRevision,p.capabilityOperationId,
 p.capabilityRevision,p.publicationOperationId,p.publicationRevision,p.publicationSourceSequence,p.publicationSnapshotId,p.publicationSnapshotSha256,p.expiresAt];
const db=(env:Env)=>env.OPS_DB.withSession("first-primary");
async function current(env:Env,proofs:readonly OpsPrincipalInquiryProof[]):Promise<boolean>{
 if(proofs.some(p=>Date.parse(p.expiresAt)<=Date.now()))return false;
 for(const proof of proofs)if(await db(env).prepare("SELECT "+witnessOneSql()+" ok").bind(...pins(proof)).first<number>("ok")!==1)return false;
 return true;
}
const receipt=(r:any)=>({id:r.inquiry_id,kind:r.kind,title:r.title,details:r.details,location:r.location,status:r.status,
 createdAt:new Date(/(?:Z|[+-]\d\d:\d\d)$/i.test(r.created_at)?r.created_at:r.created_at.replace(" ","T")+"Z").toISOString()});
async function digest(v:string):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v)))].map(x=>x.toString(16).padStart(2,"0")).join("");}
async function storedSetCurrent(env:Env,issuer:string,subject:string,json:string,sha256:string,
 supplied:readonly OpsPrincipalInquiryProof[]):Promise<boolean>{
 if(await digest(json)!==sha256)return false;let value:unknown;try{value=JSON.parse(json);}catch{return false;}
 const proofs=canonicalProofs(value);return !!proofs&&proofs[0]!.issuer===issuer&&proofs[0]!.subject===subject&&setJson(proofs)===json
  &&proofs.every(stored=>supplied.some(active=>active.targetId===stored.targetId&&active.recipientBindingId===stored.recipientBindingId))
  &&await current(env,proofs);
}
export async function listOpsPrincipalInquiries(env:Env,raw:string):Promise<string>{
 if(env.CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED!=="true")return JSON.stringify({ok:false,code:"unavailable"});
 const x=parseRequest(raw,"list");if(!x||!await current(env,x.proofs))return JSON.stringify({ok:false,code:"unavailable"});
 const issuer=x.proofs[0]!.issuer,subject=x.proofs[0]!.subject;
 const result=await db(env).prepare("SELECT * FROM operations_native_principal_inquiries WHERE issuer=? AND subject=? ORDER BY created_at DESC,inquiry_id DESC LIMIT 50").bind(issuer,subject).all<any>();
 if(!await current(env,x.proofs))return JSON.stringify({ok:false,code:"unavailable"});
 const rows=[];for(const row of result.results)if(await storedSetCurrent(env,issuer,subject,row.authority_set_json,row.authority_set_sha256,x.proofs))rows.push(receipt(row));
 return JSON.stringify({ok:true,inquiries:rows});
}
export async function submitOpsPrincipalInquiry(env:Env,raw:string):Promise<string>{
 if(env.CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED!=="true")return JSON.stringify({ok:false,code:"unavailable"});
 const x=parseRequest(raw,"submit");if(!x?.input||!await current(env,x.proofs))return JSON.stringify({ok:false,code:"unavailable"});
 const proofs=x.proofs,i=x.input,issuer=proofs[0]!.issuer,subject=proofs[0]!.subject,json=setJson(proofs),setHash=await digest(json),fp=await digest(JSON.stringify(i)),d=db(env);
 const prior=await d.prepare("SELECT * FROM operations_native_principal_inquiries WHERE issuer=? AND subject=? AND idempotency_key=?").bind(issuer,subject,i.idempotencyKey).first<any>();
 if(prior){if(!await current(env,proofs)||!await storedSetCurrent(env,issuer,subject,prior.authority_set_json,prior.authority_set_sha256,proofs))return JSON.stringify({ok:false,code:"unavailable"});
  return JSON.stringify(prior.request_fingerprint===fp?{ok:true,replayed:true,inquiry:receipt(prior)}:{ok:false,code:"conflict"});}
 const id=crypto.randomUUID(),outbox=crypto.randomUUID(),guardId=crypto.randomUUID(),guard=witnessOneSql();
 try{await d.batch([
  d.prepare("DELETE FROM operations_native_principal_inquiry_authority_guard WHERE guard_id=?").bind(guardId),
  ...proofs.map(p=>d.prepare("INSERT INTO operations_native_principal_inquiry_authority_guard(guard_id,target_id,recipient_binding_id) SELECT ?,?,? WHERE "+guard)
    .bind(guardId,p.targetId,p.recipientBindingId,...pins(p))),
  d.prepare(`INSERT INTO operations_native_principal_inquiries(inquiry_id,issuer,subject,authority_set_json,authority_set_sha256,idempotency_key,request_fingerprint,kind,title,details,location)
   SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM operations_native_principal_inquiry_authority_guard WHERE guard_id=?)=?
   ON CONFLICT(issuer,subject,idempotency_key) DO NOTHING`)
   .bind(id,issuer,subject,json,setHash,i.idempotencyKey,fp,i.kind,i.title,i.details,i.location,guardId,proofs.length),
  d.prepare(`INSERT INTO operations_native_principal_inquiry_outbox(outbox_id,inquiry_id,event_type,dedupe_key,payload_json)
   SELECT ?,inquiry_id,'inquiry_submitted',?,json_object('kind',kind,'title',title) FROM operations_native_principal_inquiries WHERE inquiry_id=? AND issuer=? AND subject=? ON CONFLICT(dedupe_key) DO NOTHING`)
   .bind(outbox,id+":submitted",id,issuer,subject),
  d.prepare(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json)
   SELECT 'client',authority_set_sha256,'client.ops_principal_inquiry.submitted','operations_native_principal_inquiry',?,json_object('kind',?)
   FROM operations_native_principal_inquiries WHERE inquiry_id=? AND issuer=? AND subject=?`)
   .bind(id,i.kind,id,issuer,subject),
  d.prepare("DELETE FROM operations_native_principal_inquiry_authority_guard WHERE guard_id=?").bind(guardId),
 ]);}catch{/* Resolve exact idempotency below. */}
 const row=await d.prepare("SELECT * FROM operations_native_principal_inquiries WHERE issuer=? AND subject=? AND idempotency_key=?").bind(issuer,subject,i.idempotencyKey).first<any>();
 if(!await current(env,proofs))return JSON.stringify({ok:false,code:"unavailable"});if(!row)return JSON.stringify({ok:false,code:"unavailable"});
 if(!await storedSetCurrent(env,issuer,subject,row.authority_set_json,row.authority_set_sha256,proofs))return JSON.stringify({ok:false,code:"unavailable"});
 return JSON.stringify(row.request_fingerprint===fp?{ok:true,replayed:row.inquiry_id!==id,inquiry:receipt(row)}:{ok:false,code:"conflict"});
}
