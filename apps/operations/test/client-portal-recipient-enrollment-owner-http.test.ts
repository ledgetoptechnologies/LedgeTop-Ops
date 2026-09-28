import {beforeEach,describe,expect,it,vi} from "vitest";
const calls=vi.hoisted(()=>({auth:vi.fn(),issue:vi.fn(),list:vi.fn(),read:vi.fn(),confirm:vi.fn(),revoke:vi.fn(),reconcile:vi.fn(),dispatch:vi.fn()}));
vi.mock("../src/worker/native-staff-auth",()=>({authenticateNativeStaffWithAdmissionVersion:calls.auth}));
vi.mock("../src/worker/client-portal-recipient-enrollment-ledger",()=>({issueRecipientEnrollmentIntent:calls.issue,
  listRecipientEnrollmentIntentsForOwner:calls.list,readRecipientEnrollmentIntentForOwner:calls.read,
  confirmRecipientEnrollmentIntent:calls.confirm,revokeRecipientEnrollmentBinding:calls.revoke,
  reconcileRecipientEnrollmentRevocation:calls.reconcile}));
vi.mock("../src/worker/client-portal-authority-v2-outbox",()=>({dispatchNextClientPortalAuthorityV2:calls.dispatch}));
import {handleRecipientEnrollmentOwnerHttp,type RecipientEnrollmentOwnerHttpDependencies} from
  "../src/worker/client-portal-recipient-enrollment-owner-http";
const origin="https://ops-staging.example.test",op="11111111-1111-4111-8111-111111111111",intent="22222222-2222-4222-8222-222222222222";
const actor={identity:{kind:"native",staffId:"owner",verifiedAccessSubject:"access|owner",email:"o@example.test",displayName:"Owner",profileVersion:2},
  admissionVersion:3,verifiedUntil:new Date(Date.now()+3_600_000).toISOString()};
const review={intentId:intent,revision:2,state:"pending",target:{clientRecordId:"client:one",selectionId:op},
  principal:{issuer:"https://client.cloudflareaccess.com",subject:"access|client"},expiresAt:new Date(Date.now()+1_800_000).toISOString()};
function deps(enabled=true):RecipientEnrollmentOwnerHttpDependencies{return{environment:"staging",expectedHost:"ops-staging.example.test",
  configuration:{enabled,issuer:"https://team.cloudflareaccess.com",staffAudience:"a".repeat(16),origin,recipientOrigin:"https://client-staging.example.test",csrfSecret:"s".repeat(32)},
  database:{} as D1Database,dispatch:{CLIENT_PORTAL_AUTHORITY_V2_OUTBOX_ENABLED:"true",CLIENT_PORTAL_AUTHORITY_V2:{
    applyAuthority:vi.fn(),getAuthorityStatus:vi.fn(),applyAuthorityV3:vi.fn(),getAuthorityV3Status:vi.fn()}} as never}}
const headers={Origin:origin,"Sec-Fetch-Site":"same-origin","Content-Type":"application/json"};
async function session(d=deps()){const response=await handleRecipientEnrollmentOwnerHttp(new Request(`${origin}/api/native-client-portal/recipient-enrollment/session`,
  {headers:{Origin:origin,"Sec-Fetch-Site":"same-origin","X-Native-Staff-Request":"1"}}),d);expect(response.status).toBe(200);
  return(await response.json() as {csrfToken:string}).csrfToken}

describe("recipient enrollment owner HTTP",()=>{beforeEach(()=>{vi.clearAllMocks();calls.auth.mockResolvedValue(actor);calls.list.mockResolvedValue([review]);
  calls.read.mockResolvedValue(review);calls.issue.mockResolvedValue({...review,state:"issued",revision:1,principal:null,opaqueToken:"f".repeat(64),replayed:false});
  calls.confirm.mockResolvedValue({review:{...review,state:"active",revision:3},operationId:op,replayed:false});
  calls.revoke.mockResolvedValue({review:{...review,state:"revoking",revision:4},operationId:op,replayed:false});
  calls.reconcile.mockResolvedValue({review:{...review,state:"revoked",revision:5},replayed:false});calls.dispatch.mockResolvedValue({status:"acknowledged",operationId:op})});
  it("is absent unless the dedicated staging gate is enabled",async()=>{expect((await handleRecipientEnrollmentOwnerHttp(
    new Request(`${origin}/api/native-client-portal/recipient-enrollment/session`),deps(false))).status).toBe(404);expect(calls.auth).not.toHaveBeenCalled()});
  it("pins the recipient link to a separate deployment-owned HTTPS staging origin",async()=>{
    const input=new Request(`${origin}/api/native-client-portal/recipient-enrollment/session`,
      {headers:{"Sec-Fetch-Site":"same-origin","X-Native-Staff-Request":"1"}});
    const result=await handleRecipientEnrollmentOwnerHttp(input,deps());
    expect((await result.json() as {recipientOrigin:string}).recipientOrigin).toBe("https://client-staging.example.test");
    for(const recipientOrigin of [origin,"https://client.example.test","http://client-staging.example.test"]){
      const initial=deps(),d={...initial,configuration:{...initial.configuration,recipientOrigin}};
      expect((await handleRecipientEnrollmentOwnerHttp(input,d)).status).toBe(503);
    }
  });
  it("lists and reads only through current owner-authorized ledger methods",async()=>{expect((await handleRecipientEnrollmentOwnerHttp(
    new Request(`${origin}/api/native-client-portal/recipient-enrollment/intents`,{headers:{"Sec-Fetch-Site":"same-origin"}}),deps())).status).toBe(200);
    expect(calls.list).toHaveBeenCalledWith(expect.anything(),actor);expect((await handleRecipientEnrollmentOwnerHttp(new Request(
      `${origin}/api/native-client-portal/recipient-enrollment/intents/${intent}`,{headers:{"Sec-Fetch-Site":"same-origin"}}),deps())).status).toBe(200);
    expect(calls.read).toHaveBeenCalledWith(expect.anything(),intent,actor)});
  it("issues an exact target and reveals the one-time token only from the core result",async()=>{const d=deps(),csrfToken=await session(d),response=await handleRecipientEnrollmentOwnerHttp(
    new Request(`${origin}/api/native-client-portal/recipient-enrollment/intents`,{method:"POST",headers:{...headers,"X-CSRF-Token":csrfToken},
      body:JSON.stringify({operationId:op,selectionId:op,clientRecordId:"client:one",expiresAt:review.expiresAt})}),d);
    expect(response.status).toBe(201);expect(calls.issue).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({operationId:op,
      target:{selectionId:op,clientRecordId:"client:one"},owner:actor}))});
  it.each(["confirm","revoke"] as const)("%s dispatches only its exact durable operation",async action=>{const d=deps(),csrfToken=await session(d),response=
    await handleRecipientEnrollmentOwnerHttp(new Request(`${origin}/api/native-client-portal/recipient-enrollment/intents/${intent}/${action}`,
      {method:"POST",headers:{...headers,"X-CSRF-Token":csrfToken},body:JSON.stringify({operationId:op,expectedRevision:2})}),d);
    expect(response.status).toBe(200);expect(calls.dispatch).toHaveBeenCalledWith(d.dispatch,op)});
  it("reconciles only by POST and never dispatches or mutates on reads",async()=>{const d=deps(),csrfToken=await session(d),response=await handleRecipientEnrollmentOwnerHttp(
    new Request(`${origin}/api/native-client-portal/recipient-enrollment/intents/${intent}/reconcile`,{method:"POST",headers:{...headers,"X-CSRF-Token":csrfToken},
      body:JSON.stringify({operationId:op,expectedRevision:4})}),d);expect(response.status).toBe(200);expect(calls.reconcile).toHaveBeenCalled();expect(calls.dispatch).not.toHaveBeenCalled();
    expect((await handleRecipientEnrollmentOwnerHttp(new Request(`${origin}/api/native-client-portal/recipient-enrollment/intents/${intent}/reconcile`,
      {headers:{"Sec-Fetch-Site":"same-origin"}}),d)).status).toBe(404)});
  it("rejects browser identity and extra fields before ledger mutation",async()=>{const d=deps(),csrfToken=await session(d),response=await handleRecipientEnrollmentOwnerHttp(
    new Request(`${origin}/api/native-client-portal/recipient-enrollment/intents`,{method:"POST",headers:{...headers,"X-CSRF-Token":csrfToken},
      body:JSON.stringify({operationId:op,selectionId:op,clientRecordId:"client:one",expiresAt:review.expiresAt,subject:"forged"})}),d);
    expect(response.status).toBe(400);expect(calls.issue).not.toHaveBeenCalled()});
});
