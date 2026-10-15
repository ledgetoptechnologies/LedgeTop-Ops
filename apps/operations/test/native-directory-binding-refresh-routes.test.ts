import { beforeEach,describe,expect,it,vi } from 'vitest';
import { Hono } from 'hono';
import type { Env,StaffPrincipal } from '../src/worker/types';
import { registerNativeDirectoryBindingRefreshRoutes } from '../src/worker/native-directory-binding-refresh-routes';
const mocks=vi.hoisted(()=>({auth:vi.fn(),review:vi.fn(),execute:vi.fn(),recoveryReview:vi.fn(),recoveryExecute:vi.fn(),audit:vi.fn()}));
vi.mock('../src/worker/native-staff-auth',()=>({authenticateNativeStaffWithAdmissionVersion:mocks.auth}));
vi.mock('../src/worker/request-security',()=>({auditStatement:mocks.audit}));
vi.mock('../src/worker/native-directory-binding-refresh',async importOriginal=>{
  const original=await importOriginal<typeof import('../src/worker/native-directory-binding-refresh')>();
  return{...original,reviewDirectoryBindingRefresh:mocks.review,executeDirectoryBindingRefresh:mocks.execute,
    reviewDirectoryBindingRefreshRecovery:mocks.recoveryReview,executeDirectoryBindingRefreshSuccessor:mocks.recoveryExecute};
});
const id='12345678-1234-4123-8123-123456789012';
const principal={id:'staff-beau-koltz',email:'owner@example.test',accessSubject:'native:test'} as StaffPrincipal;
const actor={identity:{kind:'native',staffId:principal.id,email:principal.email,verifiedAccessSubject:principal.accessSubject,profileVersion:1},admissionVersion:1,verifiedUntil:'2099-01-01T00:00:00.000Z'};
function app(){const app=new Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>();
  app.use('*',async(c,next)=>{c.set('principal',principal);c.set('administrator',true);await next();});registerNativeDirectoryBindingRefreshRoutes(app);return app;}
function request(action:string,body:unknown,overrides:Partial<Env>={},headers:Record<string,string>={}){
  return app().request(`/api/client-hub/directory/binding-revisions/${action}`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)},
    {ENVIRONMENT:'staging',NATIVE_DIRECTORY_BINDING_REFRESH_ENABLED:'true',NATIVE_DIRECTORY_BINDING_REFRESH_RECOVERY_ENABLED:'true',OPS_DB:{batch:vi.fn().mockResolvedValue([])},...overrides} as Env);}
beforeEach(()=>{vi.clearAllMocks();mocks.auth.mockResolvedValue(actor);mocks.audit.mockResolvedValue({});
  mocks.review.mockResolvedValue({commandId:id,recordId:'record',sourceId:'project-alpha:primary',localVersion:3,priorRevision:'3',liveRevision:'4'});
  mocks.execute.mockResolvedValue({commandId:id,status:'acknowledged',revision:'4',inventoryRefreshRequired:true});
  mocks.recoveryReview.mockResolvedValue({commandId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',supersededCommandId:id,capturedAttempts:2,recordId:'record',sourceId:'project-alpha:primary',localVersion:3,priorRevision:'3',liveRevision:'4'});
  mocks.recoveryExecute.mockResolvedValue({commandId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',status:'acknowledged',revision:'4',inventoryRefreshRequired:true});});
describe('explicit Directory binding revision refresh HTTP boundary',()=>{
  it.each([{NATIVE_DIRECTORY_BINDING_REFRESH_ENABLED:undefined}, {NATIVE_DIRECTORY_BINDING_REFRESH_ENABLED:'false'}, {ENVIRONMENT:'production'}])('is absent without local/staging activation %j',async settings=>{
    const response=await request('review',{recordId:'record',sourceId:'project-alpha:primary'},settings);
    expect(response.status).toBe(404);expect(mocks.auth).not.toHaveBeenCalled();expect(mocks.review).not.toHaveBeenCalled();
  });
  it('reviews only server-derived identity; sends no execute',async()=>{
    const response=await request('review',{recordId:'record',sourceId:'project-alpha:primary'});
    expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store');expect(mocks.review).toHaveBeenCalledWith(expect.anything(),actor,'record','project-alpha:primary');expect(mocks.execute).not.toHaveBeenCalled();
  });
  it.each(['expectedLiveRevision','actorId','apiKey','expectedAuthorizationGeneration','projectionSha256'])('rejects caller authority %s',async key=>{
    expect((await request('review',{recordId:'record',sourceId:'project-alpha:primary',[key]:'forged'})).status).toBe(400);expect(mocks.auth).not.toHaveBeenCalled();
  });
  it.each([{commandId:id,confirm:false},{commandId:id},{commandId:'bad',confirm:true},{commandId:id,confirm:true,externalId:'forged'}])('requires exact frozen execute confirmation %j',async body=>{
    expect((await request('execute',body)).status).toBe(400);expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('executes only commandId, audits sanitized result and requests normal inventory refresh',async()=>{
    const response=await request('execute',{commandId:id,confirm:true});expect(response.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledWith(expect.anything(),actor,id);expect(await response.json()).toMatchObject({commandId:id,revision:'4',inventoryRefreshRequired:true});expect(mocks.audit).toHaveBeenCalled();
  });
  it('rejects mismatching native and Operations actor before review',async()=>{
    mocks.auth.mockResolvedValue({...actor,identity:{...actor.identity,staffId:'foreign'}});
    expect((await request('review',{recordId:'record',sourceId:'project-alpha:primary'})).status).toBe(409);expect(mocks.review).not.toHaveBeenCalled();
  });
  it('denies missing current native authentication before review or execute',async()=>{
    mocks.auth.mockRejectedValue(new Error('missing admission'));
    expect((await request('execute',{commandId:id,confirm:true})).status).toBe(409);expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('does not expose transport errors or secrets',async()=>{
    mocks.execute.mockRejectedValue(new Error('private bearer value'));
    const response=await request('execute',{commandId:id,confirm:true});expect(response.status).toBe(503);expect(await response.text()).not.toContain('private bearer');
  });
  it('keeps recovery absent unless its separate local/staging gate is enabled',async()=>{
    const response=await request('recovery-review',{commandId:id,confirm:true},{NATIVE_DIRECTORY_BINDING_REFRESH_RECOVERY_ENABLED:undefined});
    expect(response.status).toBe(404);expect(mocks.recoveryReview).not.toHaveBeenCalled();
  });
  it('reviews a terminal conflict and executes only its successor with distinct audits',async()=>{
    const reviewed=await request('recovery-review',{commandId:id,confirm:true});expect(reviewed.status).toBe(200);
    expect(mocks.recoveryReview).toHaveBeenCalledWith(expect.anything(),actor,id);
    expect(mocks.audit).toHaveBeenLastCalledWith(expect.anything(),expect.anything(),principal,
      'directory.binding_revision_refresh.terminal_conflict_successor_reviewed','native_directory_binding_refresh','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',null,expect.anything());
    const executed=await request('recovery-execute',{commandId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',confirm:true});expect(executed.status).toBe(200);
    expect(mocks.recoveryExecute).toHaveBeenCalledWith(expect.anything(),actor,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(mocks.audit).toHaveBeenLastCalledWith(expect.anything(),expect.anything(),principal,
      'directory.binding_revision_refresh.successor_execution_result','native_directory_binding_refresh','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',null,expect.anything());
  });
});
