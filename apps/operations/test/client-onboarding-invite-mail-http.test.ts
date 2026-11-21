import { beforeEach, describe, expect, it, vi } from "vitest";
const calls=vi.hoisted(()=>({auth:vi.fn(),scope:vi.fn(),issue:vi.fn(),rate:vi.fn(),schema:vi.fn()}));
vi.mock("../src/worker/native-staff-auth",()=>({authenticateNativeStaffWithAdmissionVersion:calls.auth}));
vi.mock("../src/worker/client-onboarding-scope-choices",()=>({readClientOnboardingScopeChoices:calls.scope}));
vi.mock("../src/worker/native-staff-onboarding-rate-limit",()=>({consumeNativeStaffOnboardingRateLimit:calls.rate}));
vi.mock("../src/worker/client-onboarding-handoff",async original=>({
 ...await original<typeof import("../src/worker/client-onboarding-handoff")>(),
 issueClientOnboardingWithHandoff:vi.fn(),issueClientOnboardingMailWithHandoff:calls.issue,
 revealClientOnboardingSecret:vi.fn(),
}));
vi.mock("../src/worker/client-onboarding-target-schema",()=>({mailIssuanceSchemaFence:calls.schema}));
import {handleClientOnboardingStaffHttp,type ClientOnboardingStaffHttpDependencies} from "../src/worker/client-onboarding-staff-http";
const origin="https://ops.ledgetopdroneservices.com";
const actor={identity:{kind:"native" as const,staffId:"staff:test",verifiedAccessSubject:"access|staff:test",
 email:"staff@example.test",displayName:"Staff",profileVersion:1},admissionVersion:1,verifiedUntil:"2099-01-01T00:00:00.000Z"};
const binding={sourceId:"project-alpha:secondary",businessAreaId:"area:tech",divisionId:"division:tech"};
const keys={activeEncryptionKeyId:"enc",activeFingerprintKeyId:"mac",encryptionKeys:{enc:"b".repeat(64)},fingerprintKeys:{mac:"c".repeat(64)}};
const dependencies={environment:"production",expectedHost:"ops.ledgetopdroneservices.com",database:{withSession:(mode:string)=>{expect(mode).toBe("first-primary");return {};}} as D1Database,
 configuration:{enabled:true,issuer:"https://synthetic-team.cloudflareaccess.com",staffAudience:"synthetic-staff-audience",
  origin,csrfSecret:"synthetic-client-onboarding-secret-at-least-32-bytes"},
 handoffKeyringJson:JSON.stringify({activeKeyId:"handoff",keys:{handoff:"a".repeat(64)}}),
 inviteDestinationBindingsJson:JSON.stringify([binding]),inviteMailIssuanceEnabled:"true",inviteMailKeysJson:JSON.stringify(keys),
} satisfies ClientOnboardingStaffHttpDependencies;
const body={commandId:"11111111-1111-4111-8111-111111111111",expiresAt:"2099-01-01T00:00:00.000Z",
 destinationSourceIds:[binding.sourceId],recipient:"client@example.test",recipientConfirmed:true};
const request=(path:string,method:string,csrf?:string,input?:unknown)=>new Request(`${origin}${path}`,{method,
 headers:{Origin:origin,"Sec-Fetch-Site":"same-origin","X-Native-Staff-Request":"1","Content-Type":"application/json",
  ...(csrf?{"X-CSRF-Token":csrf}:{})},...(input===undefined?{}:{body:JSON.stringify(input)})});
async function csrf(){const reply=await handleClientOnboardingStaffHttp(request("/api/client-onboarding/staff/session","GET"),dependencies);
 expect(reply.status).toBe(200);return (await reply.json() as {csrfToken:string}).csrfToken;}
const path="/api/client-onboarding/staff/create-email";
beforeEach(()=>{vi.clearAllMocks();calls.auth.mockResolvedValue(actor);calls.rate.mockResolvedValue(true);calls.schema.mockResolvedValue({});
 calls.scope.mockResolvedValue({scopes:[{businessAreaId:binding.businessAreaId,name:"Tech",allowAreaWide:false,
  divisions:[{divisionId:binding.divisionId,name:"Tech"}]}]});
 calls.issue.mockResolvedValue({invitationId:"22222222-2222-4222-8222-222222222222",expiresAt:body.expiresAt,
  requestSha256:"a".repeat(64),state:"pending",mailStatus:"queued"});});
describe("default-off onboarding mail issuance HTTP",()=>{
 it("offers email only with the explicit flag, authorized destination, keys and reviewed schema",async()=>{
  const token=await csrf();
  const scopePath="/api/client-onboarding/staff/scope-choices";
  const read=async (deps:ClientOnboardingStaffHttpDependencies)=>{
   const reply=await handleClientOnboardingStaffHttp(request(scopePath,"POST",token,{}),deps);
   expect(reply.status).toBe(200);
   return reply.json();
  };
  expect(await read(dependencies)).toMatchObject({destinationSourceIds:[binding.sourceId],inviteMailIssuanceAvailable:true});
  expect(await read({...dependencies,inviteMailIssuanceEnabled:undefined})).not.toHaveProperty("inviteMailIssuanceAvailable");
  expect(await read({...dependencies,inviteMailIssuanceEnabled:"TRUE"})).not.toHaveProperty("inviteMailIssuanceAvailable");
  expect(await read({...dependencies,inviteDestinationBindingsJson:undefined})).not.toHaveProperty("inviteMailIssuanceAvailable");
  expect(calls.schema).toHaveBeenCalledOnce();
  for (const overrides of [{inviteMailKeysJson:undefined}, {inviteMailKeysJson:"{}"},
    {inviteMailKeysJson:" ".repeat(4097)}, {handoffKeyringJson:undefined},
    {inviteMailKeysJson:JSON.stringify({...keys,encryptionKeys:{...keys.encryptionKeys,retired:"a".repeat(64)}})}]) {
   const offer=await read({...dependencies,...overrides});
   expect(offer).toMatchObject({destinationSourceIds:[binding.sourceId]});
   expect(offer).not.toHaveProperty("inviteMailIssuanceAvailable");
  }
  expect(calls.schema).toHaveBeenCalledOnce();
  calls.schema.mockRejectedValueOnce(Error("fixture_missing_or_changed_schema"));
  const unavailable=await read(dependencies);
  expect(unavailable).toMatchObject({destinationSourceIds:[binding.sourceId]});
  expect(unavailable).not.toHaveProperty("inviteMailIssuanceAvailable");
  calls.scope.mockResolvedValueOnce({scopes:[]});
  expect(await read(dependencies)).not.toHaveProperty("inviteMailIssuanceAvailable");
  expect(calls.issue).not.toHaveBeenCalled();
 });
 it("requires authentication and CSRF, and derives only the current authorized destination",async()=>{
  const token=await csrf();
  expect((await handleClientOnboardingStaffHttp(request(path,"POST",undefined,body),dependencies)).status).toBe(403);
  const result=await handleClientOnboardingStaffHttp(request(path,"POST",token,body),dependencies);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({invitationId:"22222222-2222-4222-8222-222222222222",expiresAt:body.expiresAt,
   requestSha256:"a".repeat(64),state:"pending",mailStatus:"queued"});
  expect(calls.rate).toHaveBeenCalledOnce();expect(calls.issue).toHaveBeenCalledOnce();
  const input=calls.issue.mock.calls[0]![1];
  expect(input.request).toEqual({commandId:body.commandId,expiresAt:body.expiresAt,targetClientRecordId:null,
   scopes:[{businessAreaId:binding.businessAreaId,divisionId:binding.divisionId}],destinationIntent:[binding]});
  expect(calls.issue.mock.calls[0]![3]).toBe(body.recipient);
 });
 it("rejects missing confirmation, unmapped destination, quota and revoked staff",async()=>{
  const token=await csrf();
  expect((await handleClientOnboardingStaffHttp(request(path,"POST",token,{...body,recipientConfirmed:false}),dependencies)).status).toBe(400);
  expect((await handleClientOnboardingStaffHttp(request(path,"POST",token,{...body,recipient:"invalid@example"}),dependencies)).status).toBe(400);
  expect((await handleClientOnboardingStaffHttp(request(path,"POST",token,{...body,destinationSourceIds:["project-alpha:primary"]}),dependencies)).status).toBe(403);
  calls.rate.mockResolvedValueOnce(false);
  expect((await handleClientOnboardingStaffHttp(request(path,"POST",token,body),dependencies)).status).toBe(429);
  calls.auth.mockRejectedValueOnce(Error("denied"));
  expect((await handleClientOnboardingStaffHttp(request(path,"POST",token,body),dependencies)).status).toBe(403);
  expect(calls.issue).not.toHaveBeenCalled();
 });
});
