import { afterAll,beforeAll,beforeEach,expect,it,vi } from 'vitest';
import { Hono } from 'hono';
import { Miniflare } from 'miniflare';
import type { Env,StaffPrincipal } from '../src/worker/types';
import { registerNativeDirectorySharedProfileRoutes } from '../src/worker/native-directory-shared-profile-routes';
const mocks=vi.hoisted(()=>({authenticate:vi.fn(),status:vi.fn(),recover:vi.fn()}));
vi.mock('../src/worker/native-staff-auth',()=>({authenticateNativeStaffWithAdmissionVersion:mocks.authenticate}));
vi.mock('../src/worker/shared-profile-authority-recovery',()=>({readSharedProfileAuthorityRecoveryStatus:mocks.status,recoverSharedProfileAuthority:mocks.recover}));
const operationId='11111111-1111-4111-8111-111111111111';
const principal={id:'owner',email:'owner@example.test',accessSubject:'access|owner'} as StaffPrincipal;
let runtime:Miniflare,db:D1Database;
beforeAll(async()=>{
 runtime=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:'export default {fetch(){return new Response("ok")}}',d1Databases:['OPS']});
 db=await runtime.getD1Database('OPS') as unknown as D1Database;
 await db.exec('CREATE TABLE native_directory_grants(staff_id TEXT,permission TEXT,effect TEXT,active INTEGER,scope_kind TEXT)');
});
afterAll(async()=>{await runtime.dispose();});
beforeEach(async()=>{
 vi.clearAllMocks();await db.exec("DELETE FROM native_directory_grants; INSERT INTO native_directory_grants VALUES('owner','directory.profile.edit','allow',1,'global'),('owner','directory.identity.link','allow',1,'global')");
 mocks.authenticate.mockResolvedValue({admissionVersion:1,identity:{staffId:principal.id,email:principal.email,verifiedAccessSubject:principal.accessSubject,profileVersion:1}});
 mocks.status.mockResolvedValue({available:true,pendingHeads:1,bulkPending:true,activeRecovery:null});
 mocks.recover.mockResolvedValue({ok:true,operationId,state:'completed',pendingHeads:0});
});
function request(method='GET',body?:unknown,header=operationId,administrator=true,enabled=true){
 const app=new Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>();
 app.use('*',async(c,next)=>{c.set('principal',principal);c.set('administrator',administrator);await next();});
 registerNativeDirectorySharedProfileRoutes(app);
 return app.request('/api/client-hub/shared-profiles/authority-recovery',{method,headers:{'Content-Type':'application/json','Idempotency-Key':header},...(body===undefined?{}:{body:JSON.stringify(body)})},{OPS_DB:db,NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED:enabled?'true':'false'} as Env);
}
it('returns owner recovery status without caching it',async()=>{
 const response=await request();expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store');
 expect(await response.json()).toMatchObject({pendingHeads:1,bulkPending:true});expect(mocks.status).toHaveBeenCalledWith(expect.anything(),principal);
});
it('requires current native identity and owner permissions before exposing recovery',async()=>{
 expect((await request('GET',undefined,operationId,false)).status).toBe(403);
 await db.prepare("INSERT INTO native_directory_grants VALUES('owner','directory.identity.link','deny',1,'global')").run();
 expect((await request()).status).toBe(403);expect(mocks.status).not.toHaveBeenCalled();
});
it('rejects a mismatched verified staff identity',async()=>{
 mocks.authenticate.mockResolvedValue({identity:{staffId:'other',email:principal.email,verifiedAccessSubject:principal.accessSubject}});
 expect((await request()).status).toBe(403);expect(mocks.status).not.toHaveBeenCalled();
});
it('requires the exact UUID and matching idempotency header without accepting extra instructions',async()=>{
 expect((await request('POST',{operationId},'different')).status).toBe(400);
 expect((await request('POST',{operationId,restoreAccess:true})).status).toBe(400);
 expect((await request('POST',{operationId:'invalid'})).status).toBe(400);expect(mocks.recover).not.toHaveBeenCalled();
});
it('passes only the reviewed recovery operation to the helper',async()=>{
 const response=await request('POST',{operationId});expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({ok:true,operationId,state:'completed'});
 expect(mocks.recover).toHaveBeenCalledWith(expect.anything(),principal,{operationId});
});
it.each([['denied',403],['invalid',400],['conflict',409],['unavailable',503]] as const)('returns the %s failure without a success acknowledgement',async(code,status)=>{
 mocks.recover.mockResolvedValue({ok:false,code});const response=await request('POST',{operationId});expect(response.status).toBe(status);expect(await response.json()).toEqual({ok:false,code});
});
it('keeps the recovery route unavailable when native profile writes are disabled',async()=>{
 expect((await request('POST',{operationId},operationId,true,false)).status).toBe(404);expect(mocks.recover).not.toHaveBeenCalled();
});
