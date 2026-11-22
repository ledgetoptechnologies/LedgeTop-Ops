// QA fixture for #698 (not for merge). Runs the contract in qa/sharing-698/contract.json
// through the real Ops worker (`worker.fetch`: host admission, staff Access verification,
// the administrator mutation gate, CSRF, then the route) and the real Client worker
// (`worker.fetch`: portal origin, client Access verification, then the route), over the
// disposable, fully migrated seed (in-memory SQLite).
//
// Nothing in the authorization path is injected. The only stand-ins are what a Worker
// runtime or the QA launcher would supply:
//  - the Access certificate endpoints (<issuer>/cdn-cgi/access/certs) answer with the
//    public JWKS of this run's in-process ephemeral signer (global fetch is stubbed for
//    exactly those two URLs; any other network request fails the test);
//  - the Client->Ops VIEWER_SESSION_ISSUER service binding is the real ViewerSessionIssuer
//    entrypoint class, called in-process instead of over Workers RPC;
//  - the Viewer service calls (catalog, session, source-authorization revocation) are answered by
//    the Viewer's own repository code over the seeded schema-83 Viewer database
//    (qa/sharing-698/seed-viewer.sql via viewer-readback.mjs); only HTTP and service auth are skipped.
import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {ViewerServiceError} from '@ltds/shared';
import type {Env} from '../src/worker/types';
import type {Env as ClientEnv} from '../../client/src/worker/types';

const boundary=vi.hoisted(()=>({catalog:vi.fn(),createSession:vi.fn(),revoke:vi.fn()}));
vi.mock('cloudflare:workers',()=>({WorkflowEntrypoint:class{},DurableObject:class{},
 WorkerEntrypoint:class{ctx:unknown;env:unknown;constructor(ctx:unknown,env:unknown){this.ctx=ctx;this.env=env;}}}));
vi.mock('../src/worker/viewer-integration',async original=>({
 ...await original<typeof import('../src/worker/viewer-integration')>(),viewerServiceClient:()=>({
  clientDeliveryCatalog:boundary.catalog,createSession:boundary.createSession,revokePublishedSessionSourceAuthorization:boundary.revoke})}));
import opsWorker from '../src/worker/index';
import {ViewerSessionIssuer} from '../src/worker/viewer-session-issuer-entrypoint';
import clientWorker from '../../client/src/worker/index';
import {buildFixtureDatabases,checkEntityConsistency,checkProductPin} from '../../../qa/sharing-698/fixture-db.mjs';
import {createEphemeralAccessSigner,mintFixtureAssertions} from '../../../qa/sharing-698/ephemeral-access.mjs';
import {buildViewerDatabase,runViewerReadback,viewerServiceFromSeed} from '../../../qa/sharing-698/viewer-readback.mjs';

type Expect={status:number;len?:Record<string,number>;equals?:Record<string,unknown>;matches?:Record<string,string>;absent?:string[]};
type Case={id:string;area:string;actor:string|null;method:string;path:string;body?:unknown;idempotencyKey?:string;
 csrf?:boolean;forgeSignature?:boolean;expect:Expect;save?:Record<string,string>};
const contract=JSON.parse(readFileSync(new URL('../../../qa/sharing-698/contract.json',import.meta.url),'utf8')) as {
 product:{pr:number;commit:string;tree:string};
 access:{clientIssuer:string;clientAudience:string;staffIssuer:string;staffAudience:string;
  clients:Record<string,{subject:string;email:string}>;staff:Record<string,{id:string;subject:string;email:string}>};
 viewer:{project:{id:string;displayName:string};task:{id:string;displayName:string;modelId:string;modelVersionId:string}};
 origins:{clientPortal:string;clientPublic:string;operations:string};projectGrant:unknown;cases:Case[]};

const randomSecret=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('');
const execution={waitUntil(){},passThroughOnException(){}} as unknown as ExecutionContext;
const saved:Record<string,unknown>={};
let opsEnv:Env,clientEnv:ClientEnv,assertions:Record<string,string>,forged:Record<string,string>;
const csrfTokens=new Map<string,string>();

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
 const {access,origins}=contract;
 const viewerService=viewerServiceFromSeed(buildViewerDatabase());
 const viewerCall=<T,>(call:()=>T):Promise<T>=>{try{return Promise.resolve(call());}catch(error){
  const code=(error as {viewerCode?:string}).viewerCode;if(!code)throw error;
  return Promise.reject(new ViewerServiceError((error as Error).message,code as never,code==='not_found'?404:409));}};
 boundary.catalog.mockImplementation((input:Parameters<typeof viewerService.clientDeliveryCatalog>[0])=>viewerCall(()=>viewerService.clientDeliveryCatalog(input)));
 boundary.createSession.mockImplementation((input:Parameters<typeof viewerService.createSession>[0])=>viewerCall(()=>viewerService.createSession(input)));
 boundary.revoke.mockImplementation((input:Parameters<typeof viewerService.revokePublishedSessionSourceAuthorization>[0])=>viewerCall(()=>viewerService.revokePublishedSessionSourceAuthorization(input)));

 const signer=await createEphemeralAccessSigner();
 ({assertions}=await mintFixtureAssertions(signer));
 ({assertions:forged}=await mintFixtureAssertions(await createEphemeralAccessSigner()));
 const certificateUrls=new Set([`${access.staffIssuer}/cdn-cgi/access/certs`,`${access.clientIssuer}/cdn-cgi/access/certs`]);
 vi.stubGlobal('fetch',async(input:RequestInfo|URL)=>{
  const url=input instanceof Request?input.url:String(input);
  if(certificateUrls.has(url))return Response.json(signer.jwks);
  throw new Error(`unexpected network request in the #698 contract: ${url}`);
 });

 const opsHost=new URL(origins.operations).host;
 opsEnv={OPS_DB:ops.d1,DELIVERY_DB:delivery.d1,ENVIRONMENT:'staging',EXPECTED_HOST:opsHost,PUBLIC_BASE_URL:origins.operations,
  TEAM_DOMAIN:access.staffIssuer,OPERATIONS_AUD:access.staffAudience,OPERATIONS_SESSION_SECRET:randomSecret(),AUDIT_IP_SECRET:randomSecret(),
  VIEWER_INTEGRATION_ENABLED:'true',CLIENT_VIEWER_SESSION_ISSUER_ENABLED:'true',APPLICATION_KEY:'qa698-portal-app',
  CLIENT_PORTAL_HIERARCHY_V2_ENABLED:'true',VIEWER_SERVICE_HMAC_SECRET:randomSecret(),DISPLAY_TIMEZONE:'America/Chicago'} as unknown as Env;
 const issuer=new ViewerSessionIssuer(execution as never,opsEnv as never);
 clientEnv={DELIVERY_DB:delivery.d1,ENVIRONMENT:'staging',PUBLIC_BASE_URL:origins.clientPublic,EXPECTED_HOST:new URL(origins.clientPublic).host,CLIENT_PORTAL_ENABLED:'true',CLIENT_PORTAL_ORIGIN:origins.clientPortal,
  CLIENT_PORTAL_HIERARCHY_V2_ENABLED:'true',CLIENT_ACCESS_TEAM_DOMAIN:access.clientIssuer,CLIENT_ACCESS_AUD:access.clientAudience,
  PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED:'false',PROJECT_ALPHA_PORTAL_APPLICATION_KEY:'qa698-portal-app',CLIENT_VIEWER_ENABLED:'true',
  DELIVERY_SESSION_SECRET:randomSecret(),VIEWER_SESSION_ISSUER:issuer} as unknown as ClientEnv;
});
afterAll(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

async function call(url:string,init:RequestInit):Promise<{status:number;json:unknown}>{
 const client=url.startsWith(contract.origins.clientPortal);
 const response=client?await clientWorker.fetch(new Request(url,init),clientEnv as never,execution)
  :await opsWorker.fetch(new Request(url,init),opsEnv,execution);
 const text=await response.text();let json:unknown=null;try{json=JSON.parse(text);}catch{json=text;}
 return {status:response.status,json};
}
async function csrfFor(actor:string):Promise<string>{
 const cached=csrfTokens.get(actor);if(cached)return cached;
 // The browser's own path: GET /api/session through the same staff middleware returns the CSRF token.
 const session=await call(`${contract.origins.operations}/api/session`,{headers:{'Cf-Access-Jwt-Assertion':assertions[actor]!}});
 const token=at(session.json,'csrfToken');
 if(session.status!==200||typeof token!=='string')throw new Error(`no CSRF token for ${actor}: ${session.status} ${JSON.stringify(session.json)}`);
 csrfTokens.set(actor,token);return token;
}
async function send(testCase:Case):Promise<{status:number;json:unknown}>{
 const path=substitute(testCase.path) as string,client=path.startsWith('/api/client/');
 const origin=client?contract.origins.clientPortal:contract.origins.operations;
 const headers:Record<string,string>={'Content-Type':'application/json'};
 if(testCase.idempotencyKey)headers['Idempotency-Key']=testCase.idempotencyKey;
 if(testCase.actor)headers['Cf-Access-Jwt-Assertion']=(testCase.forgeSignature?forged:assertions)[testCase.actor]!;
 if(client||testCase.method!=='GET')headers.Origin=origin;
 if(!client&&testCase.csrf&&testCase.actor)headers['X-CSRF-Token']=await csrfFor(testCase.actor);
 const body=testCase.body===undefined?undefined:JSON.stringify(substitute(testCase.body));
 return call(`${origin}${path}`,{method:testCase.method,headers,...(body?{body}:{})});
}

describe('QA fixture #698 contract (qa/sharing-698/contract.json)',()=>{
 it('pins the exact #698 product commit and tree (full ids; product files unchanged)',()=>{
  expect(contract.product).toEqual({pr:698,commit:'9931fc34eec0e69172dae907ee9be0848dbf9c53',tree:'bf8ccfe5c0f0c3586bb231e4127a2deceb0708d3'});
  expect(checkProductPin()).toEqual([]);
 });
 it('uses one registered UUID per entity everywhere (seed, contract, README, signer inputs)',()=>{
  expect(checkEntityConsistency()).toEqual([]);
 });
 it('the Viewer side reads back from the schema-83 seed (catalog, publication, session authority)',()=>{
  expect(runViewerReadback().failures).toEqual([]);
 });
 it('the contract case ids are unique',()=>{
  expect(contract.cases.length).toBeGreaterThan(40);
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
