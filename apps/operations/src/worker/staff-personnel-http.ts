import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { authenticateNativeStaffWithAdmissionVersion, type AuthenticatedNativeStaffWithAdmissionVersion,
  type NativeStaffAccessConfiguration } from './native-staff-auth';
import { readBoundedJson } from './bounded-json';
import { HTTPException } from 'hono/http-exception';

export const STAFF_PERSONNEL_BASE='/api/staff-personnel';
const MAX_BYTES=25*1024*1024;
const ID=/^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CATEGORIES=['agreement','tax','onboarding','other'];
const CAPS=['staff.documents.read','staff.documents.upload','staff.documents.manage','staff.profile.archive','staff.profile.restore'] as const;
type Capability=typeof CAPS[number];
type Actor={staffId:string;subject:string;until:number};
type Row={id:string;staff_id:string;actor_staff_id:string;command_id:string;request_sha256:string;filename:string;category:string;content_type:string;size_bytes:number;sha256:string;object_key:string;object_etag:string|null;object_version:string|null;status:string;created_at:string};
type Config=NativeStaffAccessConfiguration & {origin:string;csrfSecret:string};
export type StaffPersonnelDependencies={configuration:Config;database:D1Database;bucket?:R2Bucket;scannerToken?:string;
  /** Trusted test seam. Production dispatch does not supply this. */
  authenticate?:typeof authenticateNativeStaffWithAdmissionVersion};
class Failure extends Error {constructor(readonly status:number,readonly code:string){super(code);}}
function fail(status:number,code:string):never{throw new Failure(status,code);}
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'};
const json=(status:number,value:unknown)=>new Response(JSON.stringify(value),{status,headers:{...headers,'Content-Type':'application/json'}});
function validId(value:string){if(!ID.test(value))fail(400,'invalid_request');return value;}
function unexpired(actor:Actor){if(!Number.isFinite(actor.until)||actor.until<=Date.now())fail(403,'personnel_denied');}
async function hash(value:BufferSource|string){return Buffer.from(await crypto.subtle.digest('SHA-256',typeof value==='string'?new TextEncoder().encode(value):value)).toString('hex');}
function exact(value:unknown,keys:string[]):asserts value is Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))fail(400,'invalid_request');}
function command(value:unknown){if(typeof value!=='string'||!UUID.test(value))fail(400,'invalid_request');return value;}
function version(value:unknown){if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>=Number.MAX_SAFE_INTEGER)fail(400,'invalid_request');return value;}
function note(value:unknown){if(typeof value!=='string'||value!==value.trim()||!value.length||value.length>500||/\p{C}/u.test(value))fail(400,'invalid_request');return value;}
async function authority(db:D1DatabaseSession,actor:Actor,target:string,cap:Capability){unexpired(actor);
  const found=await db.prepare(`SELECT 1 ok FROM staff_personnel_authority_candidates
    WHERE actor_staff_id=? AND bound_access_subject=? AND target_staff_id=? AND capability=?`)
    .bind(actor.staffId,actor.subject,target,cap).first();unexpired(actor);if(!found)fail(403,'personnel_denied');}
function event(db:D1DatabaseSession,actor:Actor,target:string,cap:Capability,kind:string,cmd:string,fingerprint:string,document:string|null=null,expectedVersion:number|null=null,details:Record<string,unknown>={}){
  unexpired(actor);return db.prepare(`INSERT INTO staff_personnel_events(id,actor_staff_id,actor_access_subject,staff_id,document_id,capability,command_id,request_sha256,event_kind,expected_version,details_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),actor.staffId,actor.subject,target,document,cap,cmd,fingerprint,kind,expectedVersion,JSON.stringify(details));}
async function replay(db:D1DatabaseSession,actor:Actor,target:string,cap:Capability,cmd:string,fingerprint:string){
  await authority(db,actor,target,cap);const previous=await db.prepare('SELECT staff_id,capability,request_sha256 FROM staff_personnel_events WHERE actor_staff_id=? AND command_id=?').bind(actor.staffId,cmd).first<{staff_id:string;capability:string;request_sha256:string}>();
  if(previous&&(previous.staff_id!==target||previous.capability!==cap||previous.request_sha256!==fingerprint))fail(409,'command_conflict');return Boolean(previous);}
function dto(row:Row){return {id:row.id,staffId:row.staff_id,filename:row.filename,category:row.category,contentType:row.content_type,size:row.size_bytes,status:row.status,createdAt:row.created_at};}
async function readRow(db:D1DatabaseSession,target:string,id:string){if(!UUID.test(id))fail(404,'not_found');return await db.prepare('SELECT * FROM staff_personnel_documents WHERE id=? AND staff_id=?').bind(id,target).first<Row>()??fail(404,'not_found');}
async function bytes(request:Request){if(!request.body)fail(400,'empty_document');const length=request.headers.get('Content-Length');if(length&&(!/^\d+$/.test(length)||Number(length)>MAX_BYTES))fail(413,'document_too_large');
  const reader=request.body.getReader(),parts:Uint8Array[]=[];let total=0;
  try{while(true){const next=await reader.read();if(next.done)break;total+=next.value.byteLength;if(total>MAX_BYTES){await reader.cancel();fail(413,'document_too_large');}parts.push(next.value);}}finally{reader.releaseLock();}
  if(!total)fail(400,'empty_document');const result=new Uint8Array(total);let offset=0;for(const part of parts){result.set(part,offset);offset+=part.byteLength;}parts.length=0;return result;}
function filename(request:Request){let value:string;try{const raw=request.headers.get('X-File-Name')??'';value=decodeURIComponent(raw);if(encodeURIComponent(value)!==raw)throw Error();}catch{return fail(400,'invalid_filename');}
  if(value!==value.normalize('NFC')||value!==value.trim()||value.length<1||value.length>160||/[\\/]/.test(value)||/\p{C}/u.test(value)||value==='.'||value==='..')fail(400,'invalid_filename');return value;}
function typeMatches(data:Uint8Array,name:string,type:string){const start=Buffer.from(data.subarray(0,16));
  const pdf=type==='application/pdf'&&/\.pdf$/i.test(name)&&start.subarray(0,5).toString()==='%PDF-'&&data.length>20&&Buffer.from(data.subarray(-1024)).includes(Buffer.from('%%EOF'));
  const png=type==='image/png'&&/\.png$/i.test(name)&&data.length>32&&start.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg=type==='image/jpeg'&&/\.jpe?g$/i.test(name)&&data.length>20&&data[0]===255&&data[1]===216&&data[data.length-2]===255&&data[data.length-1]===217;
  // ZIP magic is an admission check only. The trusted scanner must validate the
  // Office package and reject macros/embedded active content before accepting it.
  const office=start.subarray(0,4).equals(Buffer.from([80,75,3,4]))&&((type==='application/vnd.openxmlformats-officedocument.wordprocessingml.document'&&/\.docx$/i.test(name))||(type==='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'&&/\.xlsx$/i.test(name)));
  let text=false;if(type==='text/plain'&&/\.txt$/i.test(name)){try{text=!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{/* invalid UTF-8 */}}
  if(!pdf&&!png&&!jpeg&&!office&&!text)fail(415,'unsupported_document');}
async function csrf(config:Config,auth:AuthenticatedNativeStaffWithAdmissionVersion,bucket:number){
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(config.csrfSecret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(JSON.stringify(['staff-personnel-csrf-v1',config.origin,config.issuer,config.staffAudience,auth.identity.staffId,auth.identity.verifiedAccessSubject,auth.admissionVersion,bucket])))).toString('hex');}
function objectMatches(object:R2Object,row:Row){return object.size===row.size_bytes&&object.customMetadata?.sha256===row.sha256&&object.customMetadata?.documentId===row.id&&(!row.object_etag||object.etag===row.object_etag)&&(!row.object_version||object.version===row.object_version);}
async function matchingObject(bucket:R2Bucket,row:Row){const object=await bucket.head(row.object_key);if(!object||!objectMatches(object,row))fail(409,'document_integrity_conflict');return object;}
async function matchingBody(bucket:R2Bucket,row:Row){const object=await bucket.get(row.object_key,{onlyIf:{etagMatches:row.object_etag!}});if(!object||!('body' in object))fail(409,'document_integrity_conflict');if(!objectMatches(object,row)){await object.body.cancel();fail(409,'document_integrity_conflict');}return object;}

async function scanner(request:Request,deps:StaffPersonnelDependencies,path:string){const token=deps.scannerToken;
  if(!token||token.length<32||token.length>512||!deps.bucket)fail(503,'personnel_scanner_unavailable');
  const supplied=request.headers.get('Authorization')??'',expected=`Bearer ${token}`;
  if(Buffer.byteLength(supplied)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))fail(403,'personnel_denied');
  const db=deps.database.withSession('first-primary');
  if(path===`${STAFF_PERSONNEL_BASE}/scanner/claim`&&request.method==='POST'){
    const input=await readBoundedJson(request,4096);exact(input,['workerId']);if(typeof input.workerId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(input.workerId))fail(400,'invalid_request');
    const leaseToken=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'),leaseHash=await hash(leaseToken);
    await db.prepare("UPDATE staff_personnel_scan_jobs SET state='manual_review',lease_until=NULL,last_error='attempts_exhausted' WHERE document_id IN (SELECT document_id FROM staff_personnel_scan_jobs WHERE attempts>=8 AND (state='pending' OR (state='leased' AND lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))) LIMIT 100)").run();
    const claimed=await db.prepare(`UPDATE staff_personnel_scan_jobs SET state='leased',attempts=attempts+1,
      lease_sha256=?,lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes'),worker_id=?,last_error=NULL
      WHERE document_id=(SELECT job.document_id FROM staff_personnel_scan_jobs job JOIN staff_personnel_documents d ON d.id=job.document_id
      WHERE d.status='quarantined' AND job.attempts<8 AND ((job.state='pending' AND job.retry_after<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) OR (job.state='leased' AND job.lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')))
      AND NOT EXISTS(SELECT 1 FROM staff_personnel_scan_jobs busy WHERE busy.state='leased' AND busy.worker_id=? AND busy.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ORDER BY job.created_at,job.document_id LIMIT 1) RETURNING document_id,attempts,lease_until`).bind(leaseHash,input.workerId,input.workerId).first<{document_id:string;attempts:number;lease_until:string}>();
    if(!claimed)return json(200,{job:null});const row=await db.prepare('SELECT * FROM staff_personnel_documents WHERE id=?').bind(claimed.document_id).first<Row>();if(!row)fail(409,'scan_job_conflict');
    return json(200,{job:{documentId:row.id,leaseToken,leaseUntil:claimed.lease_until,attempt:claimed.attempts,filename:row.filename,contentType:row.content_type,size:row.size_bytes,sha256:row.sha256,etag:row.object_etag,objectVersion:row.object_version,
      contentPath:`${STAFF_PERSONNEL_BASE}/scanner/${row.id}/content`,receiptPath:`${STAFF_PERSONNEL_BASE}/scanner/${row.id}/receipt`,retryPath:`${STAFF_PERSONNEL_BASE}/scanner/${row.id}/retry`,policyVersion:'personnel-v1'}});}
  const match=/^\/api\/staff-personnel\/scanner\/([0-9a-f-]+)\/(content|receipt|retry)$/.exec(path);if(!match||!UUID.test(match[1]??''))fail(404,'not_found');
  const row=await db.prepare('SELECT * FROM staff_personnel_documents WHERE id=?').bind(match[1]).first<Row>();
  if(!row||!['quarantined','accepted','rejected'].includes(row.status))fail(404,'not_found');
  const leaseToken=request.headers.get('X-Scan-Lease')??'';if(!/^[a-f0-9]{64}$/.test(leaseToken))fail(403,'scan_lease_required');const leaseHash=await hash(leaseToken);
  const job=await db.prepare('SELECT state,lease_sha256,lease_until,attempts FROM staff_personnel_scan_jobs WHERE document_id=?').bind(row.id).first<{state:string;lease_sha256:string|null;lease_until:string|null;attempts:number}>();
  if(!job||job.lease_sha256!==leaseHash)fail(409,'scan_lease_conflict');
  async function leased(){const found=await db.prepare("SELECT 1 ok FROM staff_personnel_scan_jobs WHERE document_id=? AND state='leased' AND lease_sha256=? AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')").bind(row!.id,leaseHash).first();if(!found)fail(409,'scan_lease_expired');}
  if(match[2]==='retry'&&request.method==='POST'){
    const input=await readBoundedJson(request,4096);exact(input,['code']);if(!['definitions_stale','scan_unavailable','download_failed','object_mismatch','validation_unavailable'].includes(String(input.code)))fail(400,'invalid_request');
    await leased();const changed=await db.prepare(`UPDATE staff_personnel_scan_jobs SET state=?,lease_until=NULL,lease_sha256=NULL,worker_id=NULL,last_error=?,retry_after=strftime('%Y-%m-%dT%H:%M:%fZ','now',?)
      WHERE document_id=? AND state='leased' AND lease_sha256=? AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .bind(job.attempts>=8?'manual_review':'pending',input.code,`+${Math.min(3600,30*2**job.attempts)} seconds`,row.id,leaseHash).run();if(changed.meta.changes!==1)fail(409,'scan_lease_expired');return json(200,{status:job.attempts>=8?'manual_review':'retry_pending'});}
  if(match[2]==='content'&&request.method==='GET'){
    if(row.status!=='quarantined')fail(409,'scan_already_completed');await leased();await matchingObject(deps.bucket,row);
    const object=await matchingBody(deps.bucket,row);
    try{await leased();}catch(error){await object.body.cancel();throw error;}return new Response(object.body,{headers:{...headers,'Content-Type':'application/octet-stream','Content-Length':String(row.size_bytes),'X-Document-SHA256':row.sha256,'X-Document-ETag':row.object_etag!,'X-Document-Version':row.object_version!,'X-Document-Content-Type':row.content_type,'X-Document-Filename':encodeURIComponent(row.filename)}});}
  if(match[2]!=='receipt'||request.method!=='POST')fail(405,'method_not_allowed');
  const input=await readBoundedJson(request,4096);exact(input,['sha256','etag','objectVersion','verdict','engineVersion','definitionsVersion','policyVersion']);
  if(input.policyVersion!=='personnel-v1'||typeof input.engineVersion!=='string'||typeof input.definitionsVersion!=='string'||![input.engineVersion,input.definitionsVersion].every(v=>/^[A-Za-z0-9._:+ -]{1,120}$/.test(v)))fail(400,'invalid_scan_provenance');
  if(input.sha256!==row.sha256||input.etag!==row.object_etag||input.objectVersion!==row.object_version||!['clean','rejected'].includes(String(input.verdict)))fail(409,'scan_receipt_mismatch');
  await matchingObject(deps.bucket,row);const status=input.verdict==='clean'?'accepted':'rejected';
  if(row.status===status&&job.state==='completed'){const prior=await db.prepare("SELECT request_sha256 FROM staff_personnel_events WHERE document_id=? AND capability='scanner' AND command_id=?").bind(row.id,leaseHash).first<{request_sha256:string}>();if(prior?.request_sha256!==await hash(JSON.stringify(input)))fail(409,'scan_receipt_conflict');return json(200,{status,replayed:true});}if(row.status!=='quarantined')fail(409,'scan_receipt_conflict');await leased();
  await db.batch([db.prepare("UPDATE staff_personnel_documents SET status=?,scanned_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='quarantined'").bind(status,row.id),
    db.prepare(`INSERT INTO staff_personnel_events(id,staff_id,document_id,capability,command_id,request_sha256,event_kind,details_json) VALUES(?,?,?,'scanner',?,?,?,?)`)
    .bind(crypto.randomUUID(),row.staff_id,row.id,leaseHash,await hash(JSON.stringify(input)),`scan_${status}`,JSON.stringify({engineVersion:input.engineVersion,definitionsVersion:input.definitionsVersion,policyVersion:input.policyVersion}))]);
  return json(200,{status,replayed:false});}

/** Dedicated private personnel boundary. Never pass DATA_BUCKET as bucket. */
export async function handleStaffPersonnelHttp(request:Request,deps:StaffPersonnelDependencies):Promise<Response>{try{
  const config={...deps.configuration};const url=new URL(request.url);
  if(!config.enabled)fail(404,'not_found');if(config.csrfSecret.length<32||config.csrfSecret.length>512)fail(503,'personnel_unavailable');
  if(new URL(config.origin).origin!==config.origin||new URL(config.origin).protocol!=='https:'||url.origin!==config.origin||url.search)fail(403,'personnel_denied');
  if(url.pathname.startsWith(`${STAFF_PERSONNEL_BASE}/scanner/`))return await scanner(request,deps,url.pathname);
  if(request.headers.get('X-Personnel-Request')!=='1'||(request.method!=='GET'&&request.method!=='HEAD'&&request.headers.get('Origin')!==config.origin))fail(403,'personnel_denied');
  const auth:AuthenticatedNativeStaffWithAdmissionVersion=await (deps.authenticate??authenticateNativeStaffWithAdmissionVersion)(request,deps.database,config);
  const actor:Actor={staffId:auth.identity.staffId,subject:auth.identity.verifiedAccessSubject,until:Date.parse(auth.verifiedUntil)};unexpired(actor);
  const match=/^\/api\/staff-personnel\/profiles\/([^/]+)(?:\/(documents|archive|restore|session)(?:\/([0-9a-f-]+)(?:\/(content|retention))?)?)?$/.exec(url.pathname);
  if(!match)fail(404,'not_found');const target=validId(match[1]!),section=match[2],document=match[3],action=match[4],db=deps.database.withSession('first-primary');
  const cap:Capability=section==='archive'?'staff.profile.archive':section==='restore'?'staff.profile.restore':action==='retention'?'staff.documents.manage':section==='documents'&&request.method==='POST'&&!document?'staff.documents.upload':'staff.documents.read';
  await authority(db,actor,target,cap);
  const timeBucket=Math.floor(Date.now()/600000);
  if(request.method==='GET'&&section==='session'&&!document){const rows=await db.prepare('SELECT capability FROM staff_personnel_authority_candidates WHERE actor_staff_id=? AND bound_access_subject=? AND target_staff_id=?').bind(actor.staffId,actor.subject,target).all<{capability:string}>();await authority(db,actor,target,'staff.documents.read');return json(200,{csrfToken:await csrf(config,auth,timeBucket),verifiedUntil:auth.verifiedUntil,capabilities:rows.results.map(row=>row.capability)});}
  if(request.method!=='GET'&&request.method!=='HEAD'){
    const supplied=request.headers.get('X-CSRF-Token')??'';if(!/^[a-f0-9]{64}$/.test(supplied))fail(403,'personnel_denied');
    const current=await csrf(config,auth,timeBucket),prior=await csrf(config,auth,timeBucket-1);
    if(!timingSafeEqual(Buffer.from(supplied,'hex'),Buffer.from(current,'hex'))&&!timingSafeEqual(Buffer.from(supplied,'hex'),Buffer.from(prior,'hex')))fail(403,'personnel_denied');}
  if(request.method==='DELETE')fail(405,'personnel_records_are_retained');
  if(request.method==='GET'&&!document&&(!section||section==='documents')){const profile=await db.prepare('SELECT archived_at,version FROM staff_personnel_profiles WHERE staff_id=?').bind(target).first();
    const rows=await db.prepare('SELECT d.*,r.hold,r.review_after,r.review_note,r.version retention_version,j.state scan_state,j.attempts scan_attempts,j.retry_after scan_retry_after,j.last_error scan_error FROM staff_personnel_documents d JOIN staff_personnel_retention r ON r.document_id=d.id LEFT JOIN staff_personnel_scan_jobs j ON j.document_id=d.id WHERE d.staff_id=? ORDER BY d.created_at DESC,d.id LIMIT 100').bind(target).all<Row&{hold:number;review_after:string|null;review_note:string;retention_version:number;scan_state:string|null;scan_attempts:number|null;scan_retry_after:string|null;scan_error:string|null}>();
    await authority(db,actor,target,'staff.documents.read');return json(200,{profile,documents:rows.results.map(row=>({...dto(row),retention:{hold:row.hold===1,reviewAfter:row.review_after,reviewNote:row.review_note,version:row.retention_version},scan:row.scan_state?{state:row.scan_state,attempts:row.scan_attempts,retryAfter:row.scan_retry_after,errorCode:row.scan_error}:null}))});}
  if(section==='documents'&&!document&&request.method==='POST'){
    if(!deps.bucket||!deps.scannerToken||deps.scannerToken.length<32)fail(503,'personnel_storage_unavailable');
    const cmd=command(request.headers.get('Idempotency-Key')),name=filename(request),category=request.headers.get('X-Document-Category')??'',type=request.headers.get('Content-Type')??'';
    if(!CATEGORIES.includes(category))fail(400,'invalid_category');const data=await bytes(request);unexpired(actor);typeMatches(data,name,type);const sha=await hash(data),fingerprint=await hash(JSON.stringify([target,name,category,type,data.length,sha]));
    await authority(db,actor,target,cap);let row=await db.prepare('SELECT * FROM staff_personnel_documents WHERE actor_staff_id=? AND command_id=?').bind(actor.staffId,cmd).first<Row>();
    if(row&&row.request_sha256!==fingerprint)fail(409,'command_conflict');
    if(!row){const id=crypto.randomUUID();await db.prepare('INSERT INTO staff_personnel_documents(id,staff_id,actor_staff_id,actor_access_subject,command_id,request_sha256,filename,category,content_type,size_bytes,sha256,object_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id,target,actor.staffId,actor.subject,cmd,fingerprint,name,category,type,data.length,sha,`personnel/${id}/content`).run();row=await readRow(db,target,id);}
    if(row.status!=='uploading'){await authority(db,actor,target,cap);return json(200,{document:dto(row),replayed:true});}
    let object=await deps.bucket.head(row.object_key);
    if(!object){await authority(db,actor,target,cap);object=await deps.bucket.put(row.object_key,data,{onlyIf:{etagDoesNotMatch:'*'},customMetadata:{sha256:sha,documentId:row.id},httpMetadata:{contentType:'application/octet-stream'}});}
    if(!object)fail(409,'upload_in_progress');await matchingObject(deps.bucket,{...row,object_etag:object.etag,object_version:object.version});await authority(db,actor,target,cap);
    await db.batch([db.prepare("UPDATE staff_personnel_documents SET status='quarantined',object_etag=?,object_version=? WHERE id=? AND status='uploading'").bind(object.etag,object.version,row.id),event(db,actor,target,cap,'uploaded',cmd,fingerprint,row.id)]);
    return json(201,{document:dto(await readRow(db,target,row.id)),replayed:false});}
  if(section==='documents'&&document&&action==='content'&&(request.method==='GET'||request.method==='HEAD')){
    if(!deps.bucket)fail(503,'personnel_storage_unavailable');const row=await readRow(db,target,document);if(row.status!=='accepted')fail(409,'document_not_accepted');
    await matchingObject(deps.bucket,row);await authority(db,actor,target,cap);
    await event(db,actor,target,cap,'downloaded',crypto.randomUUID(),await hash(JSON.stringify([row.id,request.method])),row.id).run();
    const object=request.method==='HEAD'?null:await matchingBody(deps.bucket,row);
    try{await authority(db,actor,target,cap);}catch(error){if(object)await object.body.cancel();throw error;}
    return new Response(object&&'body'in object?(object as R2ObjectBody).body:null,{headers:{...headers,'Content-Type':row.content_type,'Content-Length':String(row.size_bytes),'Content-Disposition':`attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(row.filename).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())}`}});}
  if(section==='documents'&&document&&action==='retention'&&request.method==='POST'){
    const row=await readRow(db,target,document),input=await readBoundedJson(request,4096);exact(input,['commandId','expectedVersion','hold','reviewAfter','reviewNote']);
    const cmd=command(input.commandId),v=version(input.expectedVersion),reviewNote=note(input.reviewNote);if(typeof input.hold!=='boolean'||(input.reviewAfter!==null&&(typeof input.reviewAfter!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(input.reviewAfter)||!Number.isFinite(Date.parse(input.reviewAfter))||new Date(input.reviewAfter).toISOString().slice(0,10)!==input.reviewAfter)))fail(400,'invalid_request');
    const fingerprint=await hash(JSON.stringify([target,row.id,v,input.hold,input.reviewAfter,reviewNote]));if(await replay(db,actor,target,cap,cmd,fingerprint))return json(200,{replayed:true});
    const current=await db.prepare('SELECT version FROM staff_personnel_retention WHERE document_id=?').bind(row.id).first<{version:number}>();if(current?.version!==v)fail(409,'version_conflict');
    await event(db,actor,target,cap,'retention_updated',cmd,fingerprint,row.id,v,{hold:input.hold,reviewAfter:input.reviewAfter,reviewNote}).run();
    return json(200,{version:v+1,replayed:false});}
  if((section==='archive'||section==='restore')&&!document&&request.method==='POST'){
    const input=await readBoundedJson(request,4096);exact(input,['commandId','expectedVersion','reason']);const cmd=command(input.commandId),v=version(input.expectedVersion),reason=note(input.reason),fingerprint=await hash(JSON.stringify([target,section,v,reason]));
    if(target===actor.staffId)fail(403,'personnel_self_archive_denied');if(await replay(db,actor,target,cap,cmd,fingerprint))return json(200,{replayed:true});
    const current=await db.prepare('SELECT archived_at,version FROM staff_personnel_profiles WHERE staff_id=?').bind(target).first<{archived_at:string|null;version:number}>();if(current?.version!==v||(section==='archive'?current.archived_at!==null:current.archived_at===null))fail(409,'version_conflict');
    await event(db,actor,target,cap,section==='archive'?'profile_archived':'profile_restored',cmd,fingerprint,null,v,{reason}).run();
    return json(200,{version:v+1,archived:section==='archive',admissionRestored:false,replayed:false});}
  fail(405,'method_not_allowed');
}catch(error){if(error instanceof Failure)return json(error.status,{error:error.code});if(error instanceof HTTPException)return json(error.status,{error:'invalid_request'});return json(503,{error:'personnel_unavailable'});}}
