import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
import { Miniflare } from "miniflare";
import type { Env } from "../src/worker/types";
import type { SharedProfilePortalGrant } from "../src/worker/shared-profile-portal-authority";
const read=vi.hoisted(()=>vi.fn());
vi.mock("../src/worker/project-alpha-directory-read-api-v2",async original=>({...await original<typeof import("../src/worker/project-alpha-directory-read-api-v2")>(),
 readConfiguredProjectAlphaDirectoryClientPortalIdentity:read}));
import { onboardingPortalGrantIdentityCurrent } from "../src/worker/client-onboarding-portal-activation";
let mf:Miniflare,db:D1Database;
const grant={id:"grant",record_id:"record",principal_public_id:"principal",source_instance_id:"source",application_id:"application",history_epoch_id:"epoch",target_public_id:"b".repeat(32),source_id:"project-alpha:primary"} as SharedProfilePortalGrant;
const observation={status:"observed",observation:{sourceInstanceId:"source",applicationId:"application",historyEpoch:"epoch",
 clientPortalIdentity:{state:"eligible",principalPublicId:"principal",associationVersion:"a".repeat(64)}}};
beforeAll(async()=>{mf=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:'export default {fetch(){return new Response("ok")}}',d1Databases:["DB"]});db=await mf.getD1Database("DB");
 await db.exec("CREATE TABLE client_onboarding_portal_activation_proofs(grant_id TEXT PRIMARY KEY,source_id TEXT,record_id TEXT,principal_public_id TEXT,association_version TEXT,binding_observation_json TEXT)");
 await db.prepare("INSERT INTO client_onboarding_portal_activation_proofs VALUES('grant','project-alpha:primary','record','principal',?,?)")
 .bind("a".repeat(64),JSON.stringify({sourceId:"project-alpha:primary",binding:{externalId:"bound-record",publicId:"b".repeat(32)}})).run();
});afterAll(async()=>mf?.dispose());beforeEach(()=>read.mockReset().mockResolvedValue(structuredClone(observation)));
describe("automatic own-profile grants remain tied to PA managed identity",()=>{
 it("accepts only the exact current own-client association and never matches email",async()=>{
  expect(await onboardingPortalGrantIdentityCurrent({OPS_DB:db} as Env,grant)).toBe(true);
  expect(read.mock.calls[0]?.[0].OPS_DB).toBe(db);
  expect(read.mock.calls[0]?.slice(1)).toEqual(["project-alpha:primary","bound-record","b".repeat(32)]);
 });
 it.each([
  {status:"disabled"},
  {status:"uncertain",reason:"transport"},
  {...observation,observation:{...observation.observation,sourceInstanceId:"other"}},
  {...observation,observation:{...observation.observation,applicationId:"other"}},
  {...observation,observation:{...observation.observation,historyEpoch:"other"}},
  {...observation,observation:{...observation.observation,clientPortalIdentity:{state:"revoked",principalPublicId:null,associationVersion:null}}},
  {...observation,observation:{...observation.observation,clientPortalIdentity:{...observation.observation.clientPortalIdentity,principalPublicId:"other"}}},
  {...observation,observation:{...observation.observation,clientPortalIdentity:{...observation.observation.clientPortalIdentity,associationVersion:"c".repeat(64)}}},
 ])("fails closed after authority changes %j",async result=>{
  read.mockResolvedValue(result);expect(await onboardingPortalGrantIdentityCurrent({OPS_DB:db} as Env,grant)).toBe(false);
 });
 it("does not retroactively apply automatic policy to manually reviewed grants",async()=>{
  expect(await onboardingPortalGrantIdentityCurrent({OPS_DB:db} as Env,{...grant,id:"manual-grant"})).toBe(true);
  expect(read).not.toHaveBeenCalled();
 });
 it("rejects a marker that refers to another local client or principal",async()=>{
  expect(await onboardingPortalGrantIdentityCurrent({OPS_DB:db} as Env,{...grant,record_id:"other"})).toBe(false);
  expect(await onboardingPortalGrantIdentityCurrent({OPS_DB:db} as Env,{...grant,principal_public_id:"other"})).toBe(false);
  expect(read).not.toHaveBeenCalled();
 });
});
