import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { Miniflare } from 'miniflare';
import { readdirSync,readFileSync } from 'node:fs';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { handleStaffPersonnelHttp as actualHandler,type StaffPersonnelDependencies } from '../src/worker/staff-personnel-http';
import { executeNativeStaffManagementCommand } from '../src/worker/native-staff-management-command';
let runtime:Miniflare,db:D1Database,bucket:R2Bucket;
const origin='https://ops.example.test',token='synthetic-personnel-scanner-token-only-123456789';
const admin='personnel-admin',survivor='personnel-survivor',target='personnel-target',other='personnel-other';
const actions=['staff.onboarding.create','staff.onboarding.approve','staff.admission.disable','staff.membership.manage','staff.directory_grant.manage','staff.admin_delegation.manage'];
const caps=['staff.documents.read','staff.documents.upload','staff.documents.manage','staff.profile.archive','staff.profile.restore'];
const pdf='%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF';
async function staff(id:string){await db.batch([
 db.prepare('INSERT INTO staff_users(id,email,display_name) VALUES(?,?,?)').bind(id,`${id}@example.test`,id),
 db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,'staff-beau-koltz')").bind(id,`${id}:subject`),
 db.prepare('INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)').bind(id,`${id}@example.test`,id)]);}
async function delegation(actor:string,cap:string,targetId:string|null=null,effect='allow'){
 await db.prepare('INSERT INTO native_staff_management_delegations(id,actor_staff_id,capability,effect,scope_kind,target_staff_id,granted_by) VALUES(?,?,?,?,?,?,?)')
 .bind(crypto.randomUUID(),actor,cap,effect,targetId?'exact_staff':'global',targetId,actor).run();}
async function controlPlane(actor:string){for(const cap of actions)await delegation(actor,cap);
 const directory=['directory.profile.view','directory.profile.edit','directory.identity.link','directory.enrollment.manage','directory.portal_access.manage'];
 for(const [domain,capability] of [...directory.map(cap=>['directory',cap]),...actions.map(cap=>['staff_admin',cap])]){
 const parent=await db.prepare("SELECT id FROM native_staff_management_delegations WHERE actor_staff_id=? AND capability=? AND effect='allow' AND scope_kind='global'").bind(actor,domain==='directory'?'staff.directory_grant.manage':'staff.admin_delegation.manage').first<string>('id');
 await db.prepare("INSERT INTO native_staff_delegation_ceilings(id,parent_delegation_id,authority_domain,capability,effect,grant_allow,grant_deny,operation_create,operation_revoke,scope_kind) VALUES(?,?,?,?,'allow',1,1,1,1,'global')").bind(crypto.randomUUID(),parent,domain,capability).run();}}
function deps(actor=admin,overrides:Partial<StaffPersonnelDependencies>={}):StaffPersonnelDependencies{return {configuration:{enabled:true,origin,issuer:'https://test.cloudflareaccess.com',staffAudience:'synthetic_personnel_audience',csrfSecret:'synthetic-personnel-csrf-secret-12345678'},database:db,bucket,scannerToken:token,
 authenticate:async()=>({identity:{kind:'native',staffId:actor,verifiedAccessSubject:`${actor}:subject`,email:`${actor}@example.test`,displayName:actor,profileVersion:1},admissionVersion:1,verifiedUntil:new Date(Date.now()+60000).toISOString()}),...overrides};}
function request(path:string,method='GET',body?:unknown,extra:Record<string,string>={}){return new Request(origin+'/api/staff-personnel/'+path,{method,headers:{'X-Personnel-Request':'1',Origin:origin,...(body&&typeof body!=='string'?{'Content-Type':'application/json'}:{}),...extra},...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});}
async function handleStaffPersonnelHttp(req:Request,d:StaffPersonnelDependencies){
 if(!['GET','HEAD'].includes(req.method)&&!new URL(req.url).pathname.includes('/scanner/')){
  const profile=/\/profiles\/([^/]+)/.exec(new URL(req.url).pathname)?.[1];
  const session=await actualHandler(request(`profiles/${profile}/session`),d);if(session.ok){const value=await session.json() as {csrfToken:string};req.headers.set('X-CSRF-Token',value.csrfToken);}}
 return actualHandler(req,d);}
async function upload(targetId=target,body=pdf,more:Record<string,string>={},d=deps()){
 return handleStaffPersonnelHttp(request(`profiles/${targetId}/documents`,'POST',body,{'Content-Type':'application/pdf','X-File-Name':'agreement.pdf','X-Document-Category':'agreement','Idempotency-Key':crypto.randomUUID(),...more}),d);}
async function scan(id:string,verdict='clean'){const row=await db.prepare('SELECT sha256,object_etag FROM staff_personnel_documents WHERE id=?').bind(id).first<{sha256:string;object_etag:string}>();
 return handleStaffPersonnelHttp(request(`scanner/${id}/receipt`,'POST',{sha256:row!.sha256,etag:row!.object_etag,verdict},{Authorization:`Bearer ${token}`}),deps());}
describe('private native personnel documents',()=>{
 beforeAll(async()=>{runtime=new Miniflare({modules:true,compatibilityDate:'2026-07-22',script:"export default {fetch(){return new Response('ok')}}",d1Databases:['OPS_DB'],r2Buckets:['PERSONNEL']});db=await runtime.getD1Database('OPS_DB') as D1Database;bucket=await runtime.getR2Bucket('PERSONNEL') as unknown as R2Bucket;
 const folder=new URL('../migrations/',import.meta.url);for(const name of readdirSync(folder).filter(name=>/^\d{4}_.+\.sql$/.test(name)&&(name.slice(0,4)<='0074'||name.startsWith('0123_')||name.startsWith('0225_'))).sort())await db.batch(splitD1MigrationStatements(readFileSync(new URL(name,folder),'utf8')).map(sql=>db.prepare(sql)));
 for(const id of [admin,survivor,target,other])await staff(id);await controlPlane(admin);await controlPlane(survivor);for(const cap of caps)await delegation(admin,cap,target);
 },120000);
 afterAll(async()=>runtime?.dispose());
 it('denies wrong roles and profiles before reading a body or touching storage',async()=>{
 const untouched={head:()=>{throw Error('storage must not be touched');}} as unknown as R2Bucket;
 expect((await upload(target,pdf,{},deps(other,{bucket:untouched}))).status).toBe(403);
 expect((await upload(other,pdf,{},deps(admin,{bucket:untouched}))).status).toBe(403);
 expect((await handleStaffPersonnelHttp(request(`profiles/${target}`),deps(target))).status).toBe(403);
 });
 it('validates body, paths, type and size and fails closed without scanner/storage',async()=>{
 expect((await upload(target,pdf,{'X-File-Name':'..%2Fsecret.pdf'})).status).toBe(400);
 expect((await upload(target,'not a pdf')).status).toBe(415);
 expect((await upload(target,pdf,{'Content-Length':String(25*1024*1024+1)})).status).toBe(413);
 expect((await upload(target,pdf,{},deps(admin,{bucket:undefined}))).status).toBe(503);
 expect((await upload(target,pdf,{},deps(admin,{scannerToken:undefined}))).status).toBe(503);
 });
 it('requires actor-bound CSRF and exact Origin, including an independent streamed byte cap',async()=>{
 const req=request(`profiles/${target}/documents`,'POST',pdf,{'Content-Type':'application/pdf','X-File-Name':'a.pdf','X-Document-Category':'agreement','Idempotency-Key':crypto.randomUUID()});
 expect((await actualHandler(req,deps())).status).toBe(403);
 const foreign=request(`profiles/${target}/archive`,'POST',{commandId:crypto.randomUUID(),expectedVersion:1,reason:'Synthetic reason'},{Origin:'https://evil.example.test'});
 expect((await handleStaffPersonnelHttp(foreign,deps())).status).toBe(403);
 const large=new ReadableStream<Uint8Array>({start(controller){for(let n=0;n<26;n++)controller.enqueue(new Uint8Array(1024*1024));controller.close();}});
 const session=await actualHandler(request(`profiles/${target}/session`),deps()),value=await session.json() as any;
 const streamed=new Request(origin+`/api/staff-personnel/profiles/${target}/documents`,{method:'POST',headers:{Origin:origin,'X-Personnel-Request':'1','X-CSRF-Token':value.csrfToken,'Content-Type':'application/pdf','X-File-Name':'a.pdf','X-Document-Category':'agreement','Idempotency-Key':crypto.randomUUID()},body:large,duplex:'half'} as RequestInit);
 expect((await actualHandler(streamed,deps())).status).toBe(413);
 });
 it('admits Office/text only into quarantine and rejects executable/macro extensions',async()=>{
 for(const [name,type,body] of [['contract.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document','PK\x03\x04synthetic-office-container'],['statement.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','PK\x03\x04synthetic-office-container'],['notes.txt','text/plain','Synthetic personnel note']] as const){
 const result=await upload(target,body,{'X-File-Name':name,'Content-Type':type});expect(result.status).toBe(201);expect((await result.json() as any).document.status).toBe('quarantined');}
 expect((await upload(target,'PK\x03\x04synthetic-office-container',{'X-File-Name':'contract.docm','Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'})).status).toBe(415);
 expect((await upload(target,'<html>bad</html>',{'X-File-Name':'page.html','Content-Type':'text/html'})).status).toBe(415);
 });
 it('quarantines uploads, replays exact bytes, rejects changed command payload and exposes no storage keys',async()=>{
 const cmd=crypto.randomUUID(),headers={'Idempotency-Key':cmd};const response=await upload(target,pdf,headers);expect(response.status).toBe(201);const value=await response.json() as any;expect(value.document.status).toBe('quarantined');expect(JSON.stringify(value)).not.toMatch(/object_key|sha256|personnel\//);
 expect((await upload(target,pdf,headers)).status).toBe(200);expect((await upload(target,pdf+'\n',headers)).status).toBe(409);
 expect((await handleStaffPersonnelHttp(request(`profiles/${target}/documents/${value.document.id}/content`),deps())).status).toBe(409);
 expect((await scan(value.document.id)).status).toBe(200);expect((await scan(value.document.id)).status).toBe(200);
 const content=await handleStaffPersonnelHttp(request(`profiles/${target}/documents/${value.document.id}/content`),deps());expect(content.status).toBe(200);expect(await content.text()).toBe(pdf);expect(content.headers.get('Cache-Control')).toBe('private, no-store');
 expect((await handleStaffPersonnelHttp(request(`profiles/${other}/documents/${value.document.id}/content`),deps())).status).toBe(403);
 await delegation(admin,'staff.documents.read',other);
 expect((await handleStaffPersonnelHttp(request(`profiles/${other}/documents/${value.document.id}/content`),deps())).status).toBe(404);
 expect((await handleStaffPersonnelHttp(request(`profiles/${target}/documents/${value.document.id}/content`,'HEAD'),deps())).status).toBe(200);
 });
 it('rejects forged or conflicting scan results and blocks rejected files',async()=>{
 const value=await (await upload()).json() as any;const id=value.document.id;
 expect((await handleStaffPersonnelHttp(request(`scanner/${id}/receipt`,'POST',{sha256:'0'.repeat(64),etag:'bad',verdict:'clean'},{Authorization:`Bearer ${token}`}),deps())).status).toBe(409);
 expect((await scan(id,'rejected')).status).toBe(200);expect((await scan(id)).status).toBe(409);
 expect((await handleStaffPersonnelHttp(request(`profiles/${target}/documents/${id}/content`),deps())).status).toBe(409);
 });
 it('trusted scanner can fetch the pinned quarantine object; accepted-byte mutation is detected',async()=>{
 const value=await (await upload()).json() as any,id=value.document.id;
 expect((await actualHandler(request(`scanner/${id}/content`),deps())).status).toBe(403);
 const content=await actualHandler(request(`scanner/${id}/content`,'GET',undefined,{Authorization:`Bearer ${token}`}),deps());expect(content.status).toBe(200);expect(content.headers.get('X-Document-ETag')).toBeTruthy();expect(await content.text()).toBe(pdf);
 expect((await scan(id)).status).toBe(200);
 const row=await db.prepare('SELECT object_key FROM staff_personnel_documents WHERE id=?').bind(id).first<{object_key:string}>();await bucket.put(row!.object_key,'tampered');
 expect((await actualHandler(request(`profiles/${target}/documents/${id}/content`),deps())).status).toBe(409);
 });
 it('holds and retention reviews are versioned, audited, idempotent and never purge',async()=>{
 const value=await (await upload()).json() as any,id=value.document.id,cmd=crypto.randomUUID();const body={commandId:cmd,expectedVersion:1,hold:true,reviewAfter:null,reviewNote:'Synthetic legal hold'};
 const path=`profiles/${target}/documents/${id}/retention`;expect((await handleStaffPersonnelHttp(request(path,'POST',body),deps())).status).toBe(200);expect((await handleStaffPersonnelHttp(request(path,'POST',body),deps())).status).toBe(200);
 expect((await handleStaffPersonnelHttp(request(path,'POST',{...body,commandId:crypto.randomUUID()}),deps())).status).toBe(409);
 expect(await db.prepare('SELECT hold,version FROM staff_personnel_retention WHERE document_id=?').bind(id).first()).toEqual({hold:1,version:2});
 expect((await handleStaffPersonnelHttp(request(`profiles/${target}/documents/${id}`,'DELETE'),deps())).status).toBe(405);
 await expect(db.prepare('DELETE FROM staff_personnel_documents WHERE id=?').bind(id).run()).rejects.toThrow(/retained/);
 await expect(db.prepare('DELETE FROM staff_personnel_events').run()).rejects.toThrow(/retained/);
 });
 it('an upload reserved before archive cannot commit after the profile is archived',async()=>{
 const race='personnel-race-target';await staff(race);for(const cap of caps)await delegation(admin,cap,race);
 const wrapped={head:bucket.head.bind(bucket),put:async(...args:Parameters<R2Bucket['put']>)=>{const object=await bucket.put(...args);
 const response=await handleStaffPersonnelHttp(request(`profiles/${race}/archive`,'POST',{commandId:crypto.randomUUID(),expectedVersion:1,reason:'Synthetic archive during object write'}),deps());expect(response.status).toBe(200);return object;}} as unknown as R2Bucket;
 expect((await upload(race,pdf,{},deps(admin,{bucket:wrapped}))).status).toBe(503);
 const row=await db.prepare('SELECT id,status FROM staff_personnel_documents WHERE staff_id=?').bind(race).first<{id:string;status:string}>();expect(row?.status).toBe('uploading');
 expect((await handleStaffPersonnelHttp(request(`profiles/${race}/documents/${row!.id}/content`),deps())).status).toBe(409);
 expect(await db.prepare("SELECT count(*) count FROM staff_personnel_events WHERE staff_id=? AND event_kind='uploaded'").bind(race).first('count')).toBe(0);
 });
 it('archives atomically with admission revocation and preserves private admin access; restore never regrants',async()=>{
 const body={commandId:crypto.randomUUID(),expectedVersion:1,reason:'Synthetic employment ended'};
 expect((await handleStaffPersonnelHttp(request(`profiles/${target}/archive`,'POST',body),deps())).status).toBe(200);
 expect(await db.prepare('SELECT active FROM native_staff_admissions WHERE staff_id=?').bind(target).first('active')).toBe(0);
 expect((await handleStaffPersonnelHttp(request(`profiles/${target}`),deps())).status).toBe(200);
 expect((await upload()).status).toBe(503);
 await expect(db.prepare('UPDATE native_staff_admissions SET active=1,version=version+1 WHERE staff_id=?').bind(target).run()).rejects.toThrow(/archived/);
 await delegation(admin,'staff.admission.enable',target);const admission=await db.prepare('SELECT version FROM native_staff_admissions WHERE staff_id=?').bind(target).first<number>('version');
 await expect(executeNativeStaffManagementCommand(db,{commandId:crypto.randomUUID(),contractVersion:1,capability:'staff.admission.enable',actor:{staffId:admin,verifiedAccessSubject:`${admin}:subject`},targetStaffId:target,expectedVersion:admission,reason:'Synthetic attempted reactivation'})).rejects.toThrow('native_staff_management_command_denied');
 expect((await handleStaffPersonnelHttp(request(`profiles/${target}/restore`,'POST',{...body,commandId:crypto.randomUUID(),expectedVersion:2}),deps())).status).toBe(200);
 expect(await db.prepare('SELECT active FROM native_staff_admissions WHERE staff_id=?').bind(target).first('active')).toBe(0);
 });
 it('current deny overrides allow and rollback preserves profile when final audit refuses',async()=>{
 const original=await db.prepare('SELECT version FROM staff_personnel_profiles WHERE staff_id=?').bind(target).first('version');
 await db.prepare('UPDATE native_staff_admissions SET active=1,version=version+1 WHERE staff_id=?').bind(target).run();
 await db.prepare(`CREATE TRIGGER synthetic_personnel_failure AFTER UPDATE ON native_staff_admissions WHEN NEW.staff_id='${target}' AND NEW.active=0 BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`).run();
 expect((await handleStaffPersonnelHttp(request(`profiles/${target}/archive`,'POST',{commandId:crypto.randomUUID(),expectedVersion:original,reason:'Synthetic rollback'}),deps())).status).toBe(503);
 expect(await db.prepare('SELECT archived_at FROM staff_personnel_profiles WHERE staff_id=?').bind(target).first('archived_at')).toBe(null);
 await delegation(admin,'staff.documents.read',target,'deny');expect((await handleStaffPersonnelHttp(request(`profiles/${target}`),deps())).status).toBe(403);
 });
 it('archive cannot remove the final complete native control-plane administrator',async()=>{
 await delegation(other,'staff.documents.read',survivor);await delegation(other,'staff.profile.archive',survivor);
 await db.prepare('UPDATE native_staff_admissions SET active=0,version=version+1 WHERE staff_id=?').bind(admin).run();
 try{expect((await handleStaffPersonnelHttp(request(`profiles/${survivor}/archive`,'POST',{commandId:crypto.randomUUID(),expectedVersion:1,reason:'Synthetic last-admin rejection'}),deps(other))).status).toBe(503);
 expect(await db.prepare('SELECT active FROM native_staff_admissions WHERE staff_id=?').bind(survivor).first('active')).toBe(1);
 expect(await db.prepare('SELECT archived_at FROM staff_personnel_profiles WHERE staff_id=?').bind(survivor).first('archived_at')).toBe(null);
 }finally{await db.prepare('UPDATE native_staff_admissions SET active=1,version=version+1 WHERE staff_id=?').bind(admin).run();}
 });
});
