// QA fixture for #698 (not for merge). Runs the contract in qa/sharing-698/contract.json
// against the real Ops and Client route code over the disposable, fully migrated seed
// (in-memory SQLite). Client principals are signed per run with an ephemeral RS256 key
// and verified by the existing Client Access verifier. Only the external Viewer service
// is a test double. Staff Access admission is the QA launcher's, so staff principals
// are injected after Access, exactly as the existing route tests do.
import {readFileSync} from 'node:fs';
import {Hono} from 'hono';
import {createLocalJWKSet} from 'jose';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {ViewerServiceError} from '@ltds/shared';
import type {Env,StaffPrincipal} from '../src/worker/types';
import type {Env as ClientEnv} from '../../client/src/worker/types';

const boundary=vi.hoisted(()=>({catalog:vi.fn(),createSession:vi.fn(),revoke:vi.fn()}));
vi.mock('../src/worker/viewer-integration',async original=>({
 ...await original<typeof import('../src/worker/viewer-integration')>(),viewerServiceClient:()=>({
  clientDeliveryCatalog:boundary.catalog,createSession:boundary.createSession,revokePublishedSessionSourceAuthorization:boundary.revoke})}));
import {registerDirectViewerClientRoutes} from '../src/worker/viewer-direct-client-routes';
import {issueDirectClientViewerSession,listDirectClientViewerItems} from '../src/worker/viewer-direct-client-session-issuer';
import {createClientPortalRouter} from '../../client/src/worker/client-portal/routes';
import {resolveCloudflareClientPrincipal} from '../../client/src/worker/client-portal/access-identity';
import {buildFixtureDatabases,checkProductPin} from '../../../qa/sharing-698/fixture-db.mjs';
import {createEphemeralAccessSigner,mintFixtureAssertions} from '../../../qa/sharing-698/ephemeral-access.mjs';

type Expect={status:number;len?:Record<string,number>;equals?:Record<string,unknown>;matches?:Record<string,string>;absent?:string[]};
type Case={id:string;area:string;actor:string|null;method:string;path:string;body?:unknown;idempotencyKey?:string;
 forgeSignature?:boolean;expect:Expect;save?:Record<string,string>};
const contract=JSON.parse(readFileSync(new URL('../../../qa/sharing-698/contract.json',import.meta.url),'utf8')) as {
 product:{pr:number;commit:string;tree:string};
 access:{clientIssuer:string;clientAudience:string;clients:Record<string,unknown>;staff:Record<string,{id:string;subject:string;email:string}>};
 viewer:{project:{id:string;displayName:string};task:{id:string;displayName:string;modelId:string;modelVersionId:string}};
 origins:{clientPortal:string;operations:string};projectGrant:unknown;cases:Case[]};

const randomSecret=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('');
const saved:Record<string,unknown>={};
let opsApp:Hono,clientApp:Hono,assertions:Record<string,string>,forged:Record<string,string>;

function at(value:unknown,path:string):unknown{
 return path.split('.').reduce<unknown>((current,key)=>current==null?undefined:(current as Record<string,unknown>)[key],value);
}
function substitute(value:unknown):unknown{
 if(value==='${projectGrant}')return contract.projectGrant;
 if(typeof value==='string')return value.replace(/\$\{(\w+)\}/g,(_,name:string)=>{
  if(!(name in saved))throw new Error(`contract variable ${name} was not saved by an earlier case`);return String(saved[name]);});
 if(Array.isArray(value))return value.map(substitute);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,substitute(item)]));
 return value;
}

beforeAll(async()=>{
 const {delivery,ops}=buildFixtureDatabases();
 const {viewer}=contract;
 boundary.catalog.mockImplementation(async(input:{projectId:string;taskId?:string})=>{
  if(input.projectId!==viewer.project.id||(input.taskId&&input.taskId!==viewer.task.id))throw new ViewerServiceError('Not published','not_found');
  return {schemaVersion:1,project:{id:viewer.project.id,displayName:viewer.project.displayName},nextCursor:null,
   tasks:[{id:viewer.task.id,displayName:viewer.task.displayName,modelId:viewer.task.modelId,modelVersionId:viewer.task.modelVersionId,
    modelTitle:viewer.task.displayName,publishedAt:'2026-11-01T00:00:00Z'}]};
 });
 boundary.createSession.mockImplementation(async()=>({grant:'qa698-viewer-session',grantExpiresAt:new Date(Date.now()+120_000).toISOString(),
  sessionTtlSeconds:1800,redeemUrl:'https://viewer.example.test/redeem',embedUrl:'https://viewer.example.test/session'}));
 boundary.revoke.mockImplementation(async(input:{sourceAuthorization:{type:string;id:string;version:number}})=>
  ({sourceAuthorization:input.sourceAuthorization,revokedGrants:1,revokedSessions:1}));

 const opsEnv={OPS_DB:ops.d1,DELIVERY_DB:delivery.d1,VIEWER_INTEGRATION_ENABLED:'true',CLIENT_VIEWER_SESSION_ISSUER_ENABLED:'true',
  APPLICATION_KEY:'qa698-portal-app',CLIENT_PORTAL_HIERARCHY_V2_ENABLED:'true',VIEWER_SERVICE_HMAC_SECRET:randomSecret()} as unknown as Env;
 const staffById=new Map(Object.values(contract.access.staff).map(staff=>[staff.id,staff]));
 opsApp=new Hono();
 opsApp.use('*',async(c,next)=>{
  const staff=staffById.get(c.req.header('x-qa698-staff')??'');
  if(!staff)return c.json({error:'Cloudflare Access authentication required'},401);
  c.set('principal' as never,{id:staff.id,email:staff.email,displayName:staff.id,accessSubject:staff.subject,projectAlphaUserId:null} satisfies StaffPrincipal as never);
  c.set('administrator' as never,false as never);await next();
 });
 registerDirectViewerClientRoutes(opsApp as never);
 opsApp.onError(error=>error instanceof Error&&'getResponse' in error?(error as unknown as {getResponse():Response}).getResponse():Response.json({error:'internal'},{status:500}));

 const signer=await createEphemeralAccessSigner();
 ({assertions}=await mintFixtureAssertions(signer));
 ({assertions:forged}=await mintFixtureAssertions(await createEphemeralAccessSigner()));
 const getKey=createLocalJWKSet(signer.jwks);
 const clientEnv={DELIVERY_DB:delivery.d1,CLIENT_PORTAL_ENABLED:'true',CLIENT_PORTAL_ORIGIN:contract.origins.clientPortal,
  CLIENT_PORTAL_HIERARCHY_V2_ENABLED:'true',CLIENT_ACCESS_TEAM_DOMAIN:contract.access.clientIssuer,CLIENT_ACCESS_AUD:contract.access.clientAudience,
  PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED:'false',PROJECT_ALPHA_PORTAL_APPLICATION_KEY:'qa698-portal-app',CLIENT_VIEWER_ENABLED:'true',
  DELIVERY_SESSION_SECRET:randomSecret(),VIEWER_SESSION_ISSUER:{
   listDirectClientViewerItems:(request:Parameters<typeof listDirectClientViewerItems>[1])=>listDirectClientViewerItems(opsEnv,request),
   issueDirectClientViewerSession:(request:Parameters<typeof issueDirectClientViewerSession>[1])=>issueDirectClientViewerSession(opsEnv,request)}} as unknown as ClientEnv;
 const router=createClientPortalRouter({resolvePrincipal:(request:Request,env:ClientEnv)=>resolveCloudflareClientPrincipal(request,env,getKey)});
 clientApp=new Hono();clientApp.route('/api/client',router);
 clientApp.onError(error=>error instanceof Error&&'getResponse' in error?(error as unknown as {getResponse():Response}).getResponse():Response.json({error:'internal'},{status:500}));
 (clientApp as unknown as {env:ClientEnv}).env=clientEnv;(opsApp as unknown as {env:Env}).env=opsEnv;
});
afterAll(()=>{vi.restoreAllMocks();});

async function send(testCase:Case):Promise<{status:number;json:unknown}>{
 const path=substitute(testCase.path) as string,client=path.startsWith('/api/client/');
 const headers:Record<string,string>={'Content-Type':'application/json'};
 if(testCase.idempotencyKey)headers['Idempotency-Key']=testCase.idempotencyKey;
 if(client){
  headers.Origin=contract.origins.clientPortal;
  if(testCase.actor)headers['Cf-Access-Jwt-Assertion']=(testCase.forgeSignature?forged:assertions)[testCase.actor]!;
 }else if(testCase.actor){headers['x-qa698-staff']=contract.access.staff[testCase.actor]!.id;}
 const body=testCase.body===undefined?undefined:JSON.stringify(substitute(testCase.body));
 const origin=client?contract.origins.clientPortal:contract.origins.operations;
 const request=new Request(`${origin}${path}`,{method:testCase.method,headers,...(body?{body}:{})});
 const app=client?clientApp:opsApp,env=(app as unknown as {env:unknown}).env;
 const response=await app.fetch(request,env as never);
 const text=await response.text();let json:unknown=null;try{json=JSON.parse(text);}catch{json=text;}
 return {status:response.status,json};
}

describe('QA fixture #698 contract (qa/sharing-698/contract.json)',()=>{
 it('pins the exact #698 product commit and tree (full ids; product files unchanged)',()=>{
  expect(contract.product).toEqual({pr:698,commit:'9931fc34eec0e69172dae907ee9be0848dbf9c53',tree:'bf8ccfe5c0f0c3586bb231e4127a2deceb0708d3'});
  expect(checkProductPin()).toEqual([]);
 });
 it('the contract and the seed agree on every principal and workspace',()=>{
  expect(contract.cases.length).toBeGreaterThan(30);
  expect(new Set(contract.cases.map(item=>item.id)).size).toBe(contract.cases.length);
 });
 for(const testCase of contract.cases){
  it(`${testCase.id} ${testCase.area}: ${testCase.method} ${testCase.path} as ${testCase.actor??'nobody'} -> ${testCase.expect.status}`,async()=>{
   const {status,json}=await send(testCase),expected=substitute(testCase.expect) as Expect;
   expect({id:testCase.id,status,json}).toMatchObject({id:testCase.id,status:expected.status});
   for(const [path,length] of Object.entries(expected.len??{}))expect(at(json,path),`${testCase.id} ${path}`).toHaveLength(length);
   for(const [path,value] of Object.entries(expected.equals??{}))expect(at(json,path),`${testCase.id} ${path}`).toEqual(value);
   for(const [path,pattern] of Object.entries(expected.matches??{}))expect(String(at(json,path)),`${testCase.id} ${path}`).toMatch(new RegExp(pattern));
   for(const path of expected.absent??[])expect(at(json,path),`${testCase.id} ${path}`).toBeUndefined();
   for(const [name,path] of Object.entries(testCase.save??{}))saved[name]=at(json,path);
  });
 }
});
