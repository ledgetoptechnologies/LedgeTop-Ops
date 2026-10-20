import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createIndependentCorrespondenceFixture } from "./helpers/central-correspondence-independentreview-fixture";
import { registerVisibleTestSource } from "./helpers/project-alpha-connectors";
import { managePortalDirectoryCorrespondence, previewPortalDirectoryCorrespondence,
  resolveDirectoryPortalSource, discoverPortalDirectoryCorrespondence, type CorrespondenceEnv } from "../src/worker/portal-directory-correspondence";
import { synchronizePrimaryDeliveryAuthority } from "../src/worker/project-alpha-primary-delivery-authority";
import { reviewedOperationsMigrationNames } from "./helpers/reviewed-operations-migration-chain";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { registerPortalDirectoryCorrespondenceRoutes } from "../src/worker/portal-directory-correspondence-routes";
import type { Env } from "../src/worker/types";
import type { StaffPrincipal } from "../src/worker/types";

const logical="project-alpha:staging",primary="project-alpha:primary";
const tuple={sourceInstanceId:"11111111-1111-4111-8111-111111111111",applicationId:"22222222-2222-4222-8222-222222222222",historyEpochId:"33333333-3333-4333-8333-333333333333"};
const other="44444444-4444-4444-8444-444444444444";
const owner:StaffPrincipal={id:"independent-correspondence-owner",email:"independent-owner@example.test",displayName:"Independent Owner",accessSubject:"independent-access-subject",projectAlphaUserId:null};
let runtime:Miniflare,ops:D1Database,client:D1Database,env:CorrespondenceEnv;
const send=vi.fn<typeof fetch>(async(input,init)=>{
 expect(new URL(String(input)).pathname).toBe("/api/v2/capabilities");
 expect(init?.method??"GET").toBe("GET");
 return Response.json({apiVersion:"2",sourceInstanceId:tuple.sourceInstanceId,applicationId:tuple.applicationId,historyEpoch:tuple.historyEpochId,
  requestId:"55555555-5555-4555-8555-555555555555",grantedCapabilities:[{name:"api.capabilities.read"}],
  implementedEndpoints:[{method:"GET",path:"/api/v2/capabilities",requiredCapability:"api.capabilities.read"}]},{headers:{"Cache-Control":"no-store","X-Request-ID":"55555555-5555-4555-8555-555555555555"}});
});
async function approve(){const p=await previewPortalDirectoryCorrespondence(env,logical);expect(p.preview).not.toBeNull();
 const command={operationId:crypto.randomUUID(),action:"approve" as const,expectedVersion:p.current?.version??0,expectedProofSha256:p.preview!.proofSha256};
 const result=await managePortalDirectoryCorrespondence(env,owner,logical,command,send);if(!result.ok)throw Error("Independent approval failed");return{result,command};}
beforeAll(async()=>{
 const fixture=await createIndependentCorrespondenceFixture();
 ({runtime,ops,client,env}=fixture);
 expect(fixture.opsNames).toHaveLength(212);
 expect(fixture.clientNames.at(-1)).toBe("0234_pa_principal_reenrollment.sql");
},300_000);
afterAll(async()=>runtime?.dispose());

it("keeps same-ID installations and unknown aliases separate until explicit reviewed approval",async()=>{
 const migration=new URL("../migrations/0212_primary_portal_directory_correspondence.sql",import.meta.url);
 expect(createHash("sha256").update(readFileSync(migration,"utf8").replace(/\r\n/g,"\n")).digest("hex")).toBe("3ac44b2cda2182a1bff154da4e6909d7ace02ba7ac17f1cbc4fc734796935d6f");
 // Successor bytes/physical inventory are reviewed without rewriting the frozen bootstrap199 contract.
 const historical=reviewedOperationsMigrationNames(new URL("../migrations/",import.meta.url));
 expect(historical).toHaveLength(199);expect(historical).not.toContain("0212_primary_portal_directory_correspondence.sql");
 expect(await ops.prepare("SELECT count(*) n FROM portal_directory_correspondence_heads").first("n")).toBe(0);
 expect(await resolveDirectoryPortalSource(env,primary,tuple)).toEqual({directorySourceId:primary,portalSourceId:primary,correspondenceRevisionId:null,correspondenceVersion:null});
 expect(await resolveDirectoryPortalSource(env,logical,tuple)).toEqual({directorySourceId:logical,portalSourceId:logical,correspondenceRevisionId:null,correspondenceVersion:null});
 expect(await resolveDirectoryPortalSource(env,"project-alpha:unknown",tuple,other)).toBeNull();
 expect(await resolveDirectoryPortalSource(env,primary,tuple,other)).toBeNull();
 expect(await resolveDirectoryPortalSource(env,"not-a-source",tuple)).toBeNull();
 expect(send).not.toHaveBeenCalled();
});

it("requires reviewed exact API tuple and fails closed for config, authority, revision and actor drift",async()=>{
 const baseline=await Promise.all(["portal_v2_workspace_memberships","portal_v2_entitlements","portal_v2_authenticated_delivery_grants"].map(t=>client.prepare(`SELECT count(*) n FROM ${t}`).first<number>("n")));
 const preview=await previewPortalDirectoryCorrespondence(env,logical);expect(preview.preview).not.toBeNull();
 const wrongProducer:typeof fetch=async()=>Response.json({apiVersion:"2",sourceInstanceId:other,applicationId:tuple.applicationId,historyEpoch:tuple.historyEpochId,
  requestId:"55555555-5555-4555-8555-555555555555",grantedCapabilities:[{name:"api.capabilities.read"}],
  implementedEndpoints:[{method:"GET",path:"/api/v2/capabilities",requiredCapability:"api.capabilities.read"}]},{headers:{"Cache-Control":"no-store","X-Request-ID":"55555555-5555-4555-8555-555555555555"}});
 expect(await managePortalDirectoryCorrespondence(env,owner,logical,{operationId:crypto.randomUUID(),action:"approve",expectedVersion:0,expectedProofSha256:preview.preview!.proofSha256},wrongProducer)).toMatchObject({ok:false,code:"rejected"});
 expect(await ops.prepare("SELECT count(*) n FROM portal_directory_correspondence_receipts").first("n")).toBe(0);
 const {result,command}=await approve();expect(result.version).toBe(1);
 expect(await resolveDirectoryPortalSource(env,logical,tuple,result.revisionId)).toEqual({directorySourceId:logical,portalSourceId:primary,correspondenceRevisionId:result.revisionId,correspondenceVersion:1});
 expect(await managePortalDirectoryCorrespondence(env,owner,logical,command,send)).toMatchObject({ok:true,replayed:true,version:1});
 for(const key of ["sourceInstanceId","applicationId","historyEpochId"] as const)
  expect(await resolveDirectoryPortalSource(env,logical,{...tuple,[key]:other},result.revisionId),key).toBeNull();
 expect(await resolveDirectoryPortalSource(env,logical,tuple,other)).toBeNull();
 const base=JSON.parse(env.PROJECT_ALPHA_API_V2_CONNECTIONS!);
 for(const change of [{enabled:false},{baseUrl:"https://wrong-producer.example.test"},{sourceInstanceId:other},{applicationId:other},{historyEpoch:other}]){
  const c=structuredClone(base);Object.assign(c.instances[logical],change);
  expect(await resolveDirectoryPortalSource({...env,PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify(c)},logical,tuple,result.revisionId),JSON.stringify(change)).toBeNull();
 }
 for(const raw of ["{}","not-json",env.PROJECT_ALPHA_API_V2_CONNECTIONS!.replace('"version":1','"version":1,"version":1')])
  expect(await resolveDirectoryPortalSource({...env,PROJECT_ALPHA_API_V2_CONNECTIONS:raw},logical,tuple,result.revisionId)).toBeNull();
 const prior=await previewPortalDirectoryCorrespondence(env,logical);
 expect(await managePortalDirectoryCorrespondence(env,{...owner,accessSubject:"wrong"},logical,{operationId:crypto.randomUUID(),action:"approve",expectedVersion:1,expectedProofSha256:prior.preview!.proofSha256},send)).toMatchObject({ok:false,code:"rejected"});
 expect(await managePortalDirectoryCorrespondence(env,owner,logical,{operationId:crypto.randomUUID(),action:"approve",expectedVersion:0,expectedProofSha256:prior.preview!.proofSha256},send)).toMatchObject({ok:false,code:"rejected"});
 expect(await managePortalDirectoryCorrespondence(env,owner,logical,{operationId:crypto.randomUUID(),action:"approve",expectedVersion:1,expectedProofSha256:"0".repeat(64)},send)).toMatchObject({ok:false,code:"rejected"});
 expect(await Promise.all(["portal_v2_workspace_memberships","portal_v2_entitlements","portal_v2_authenticated_delivery_grants"].map(t=>client.prepare(`SELECT count(*) n FROM ${t}`).first<number>("n")))).toEqual(baseline);
 expect((await ops.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);expect((await client.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
},60_000);

it("requires unique nomination independent of entry order and excludes an active secondary producer",async()=>{
 const selected=await resolveDirectoryPortalSource(env,logical,tuple);expect(selected?.portalSourceId).toBe(primary);
 const base=JSON.parse(env.PROJECT_ALPHA_API_V2_CONNECTIONS!),candidate=structuredClone(base.instances[logical]);
 const ambiguous="project-alpha:ambiguous";
 const second={...candidate,sourceId:ambiguous,sourceInstanceId:other,applicationId:"66666666-6666-4666-8666-666666666666",historyEpoch:"77777777-7777-4777-8777-777777777777"};
 for(const instances of [{...base.instances,[ambiguous]:second},{[ambiguous]:second,...base.instances}]){
  const changed={...env,PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify({version:1,instances})};
  expect(await resolveDirectoryPortalSource(changed,logical,tuple,selected!.correspondenceRevisionId)).toBeNull();
  expect((await previewPortalDirectoryCorrespondence(changed,ambiguous)).preview).toBeNull();
 }
 const secondary="project-alpha:secondary";
 await registerVisibleTestSource(ops,secondary,"Independent secondary");
 await ops.prepare("UPDATE pa_connectors SET state='active',version=version+1 WHERE source_id=?").bind(secondary).run();
 const entry={...second,sourceId:secondary};
 for(const instances of [{...base.instances,[secondary]:entry},{[secondary]:entry,...base.instances}]){
  const changed={...env,PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify({version:1,instances})};
  expect(await resolveDirectoryPortalSource(changed,logical,tuple,selected!.correspondenceRevisionId)).toEqual(selected);
  expect((await previewPortalDirectoryCorrespondence(changed,secondary)).preview).toBeNull();
  expect(await resolveDirectoryPortalSource(changed,secondary,tuple,selected!.correspondenceRevisionId)).toBeNull();
 }
 expect(await ops.prepare("SELECT count(*) n FROM portal_directory_correspondence_heads").first("n")).toBe(1);
},60_000);

it("resumes the approved alias after authority-only changes and requires fresh review for a different key",async()=>{
 let selected=await resolveDirectoryPortalSource(env,logical,tuple);expect(selected?.portalSourceId).toBe(primary);
 const originalRevision=selected!.correspondenceRevisionId!;
 await client.prepare("UPDATE pa_primary_delivery_authority SET state='suspended',authority_version=authority_version+1 WHERE source_id=?").bind(primary).run();
 expect(await resolveDirectoryPortalSource(env,logical,tuple,originalRevision)).toBeNull();
 expect((await previewPortalDirectoryCorrespondence(env,logical)).status).toBe("suspended");
 await client.prepare("UPDATE pa_primary_delivery_authority SET state='active',authority_version=authority_version+1 WHERE source_id=?").bind(primary).run();
 expect(await resolveDirectoryPortalSource(env,logical,tuple,originalRevision)).toEqual(selected);
 await approve();
 const refreshed=await resolveDirectoryPortalSource(env,logical,tuple);expect(refreshed?.correspondenceRevisionId).not.toBe(originalRevision);
 const key="f".repeat(64);
 await ops.batch([
  ops.prepare("INSERT INTO pa_connector_signing_keys(fingerprint,source_id,algorithm) VALUES(?,?,'ed25519')").bind(key,primary),
  ops.prepare(`INSERT INTO pa_connector_revisions(source_id,revision,credential_ref,snapshot_base_path,access_issuer,access_audience,access_subject,current_key_id,current_key_fingerprint,created_by)
    SELECT source_id,revision+1,credential_ref,snapshot_base_path,access_issuer,access_audience,access_subject,'rotated-key',?,created_by FROM pa_connector_revisions WHERE source_id=? AND revision=1`).bind(key,primary),
  ops.prepare("UPDATE pa_connectors SET active_revision=active_revision+1,version=version+1 WHERE source_id=?").bind(primary),
 ]);
 expect(await resolveDirectoryPortalSource(env,logical,tuple,refreshed!.correspondenceRevisionId)).toBeNull();
 const c=await ops.prepare("SELECT active_revision,version FROM pa_connectors WHERE source_id=?").bind(primary).first<{active_revision:number;version:number}>();
 await synchronizePrimaryDeliveryAuthority(client,{kind:"primary_connector",sourceId:primary,mode:"registry",connectorRevision:c!.active_revision,connectorVersion:c!.version});
 expect(await resolveDirectoryPortalSource(env,logical,tuple,refreshed!.correspondenceRevisionId)).toBeNull();
 const {result}=await approve();expect(result.version).toBe(3);
 const status=await previewPortalDirectoryCorrespondence(env,logical);
 const revoke={operationId:crypto.randomUUID(),action:"revoke" as const,expectedVersion:3,expectedProofSha256:status.current!.revocationProofSha256};
 expect(await managePortalDirectoryCorrespondence(env,owner,logical,revoke,send)).toMatchObject({ok:true,version:4});
 expect(await resolveDirectoryPortalSource(env,logical,tuple,result.revisionId)).toBeNull();
 expect(await managePortalDirectoryCorrespondence(env,owner,logical,revoke,send)).toMatchObject({ok:true,replayed:true,version:4});
 expect(await ops.prepare("SELECT count(*) n FROM portal_directory_correspondence_revisions").first("n")).toBe(3);
 expect(await ops.prepare("SELECT count(*) n FROM portal_directory_correspondence_receipts").first("n")).toBe(4);
 await expect(ops.prepare("DELETE FROM portal_directory_correspondence_revisions WHERE id=?").bind(originalRevision).run()).rejects.toThrow("immutable");
 await expect(ops.prepare("UPDATE portal_directory_correspondence_heads SET version=version+1,state='active' WHERE directory_source_id=?").bind(logical).run()).rejects.toThrow("changed");
 expect(await client.prepare("SELECT count(*) n FROM portal_v2_workspace_memberships").first("n")).toBe(0);
 expect(await client.prepare("SELECT count(*) n FROM portal_v2_authenticated_delivery_grants").first("n")).toBe(0);
},60_000);

it("reports an actual committed local D1 batch with lost response as unknown503 and replays only the exact reviewed actor/request",async()=>{
 const preview=await previewPortalDirectoryCorrespondence(env,logical);expect(preview.preview).not.toBeNull();
 const command={operationId:crypto.randomUUID(),action:"approve" as const,expectedVersion:preview.current!.version,expectedProofSha256:preview.preview!.proofSha256};
 let attempted=0;
 const session=ops.withSession("first-primary");
 const wrappedSession=new Proxy(session,{get(target,key){
  if(key==="batch")return async(statements:D1PreparedStatement[])=>{attempted++;await target.batch(statements);throw Error("independent local committed response lost");};
  const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
 }});
 const wrappedDatabase=new Proxy(ops,{get(target,key){
  if(key==="withSession")return()=>wrappedSession;
  const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
 }});
 const interrupted={...env,OPS_DB:wrappedDatabase};
 const app=new Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>();
 // Route-unit authenticated actor injection; actual Access/JWT authentication is covered separately.
 app.use("*",async(c,next)=>{c.set("principal",owner);c.set("administrator",true);await next();});
 registerPortalDirectoryCorrespondenceRoutes(app);
 const originalFetch=globalThis.fetch;globalThis.fetch=send;
 let response:Response;
 try{response=await app.fetch(new Request(`https://ops.example.test/api/admin/integrations/project-alpha/connectors/${encodeURIComponent(logical)}/portal-correspondence`,{
  method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":command.operationId},body:JSON.stringify(command)}),interrupted as Env);}finally{globalThis.fetch=originalFetch;}
 expect(response!.status).toBe(503);
 expect(await response!.json()).toEqual({ok:false,code:"outcome_unknown",operationId:command.operationId});
 expect(attempted).toBe(1);
 const committed=await ops.prepare("SELECT resulting_version,revision_id FROM portal_directory_correspondence_receipts WHERE operation_id=?").bind(command.operationId).first<{resulting_version:number;revision_id:string}>();
 expect(committed).not.toBeNull();
 const replay=await managePortalDirectoryCorrespondence(interrupted,owner,logical,command,send);
 expect(replay).toMatchObject({ok:true,operationId:command.operationId,action:"approve",directorySourceId:logical,replayed:true,version:committed!.resulting_version,revisionId:committed!.revision_id});
 expect(attempted).toBe(1);
 for(const [actor,changed] of [[{...owner,accessSubject:"wrong-subject"},command],[owner,{...command,expectedVersion:command.expectedVersion+1}]] as const){
  const result=await managePortalDirectoryCorrespondence(interrupted,actor,logical,changed,send);
  expect(result).toEqual({ok:false,code:"rejected",operationId:command.operationId});
 }
 expect(attempted).toBe(1);
},60_000);

it("rejects separately recorded receipts after the approving actor loses current authority",async()=>{
 const current=await previewPortalDirectoryCorrespondence(env,logical);expect(current.current?.state).toBe("active");
 const actorFence=await ops.prepare(`SELECT admission.version admission_version,profile.version profile_version FROM native_staff_admissions admission
  JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id WHERE admission.staff_id=?`).bind(owner.id).first<{admission_version:number;profile_version:number}>();
 const operationId=crypto.randomUUID(),revisionId=current.current!.revisionId,version=current.current!.version;
 // A valid receipt written while authority is live must not become a future authorization token.
 await ops.prepare(`INSERT INTO portal_directory_correspondence_receipts(operation_id,directory_source_id,revision_id,action,expected_version,resulting_version,
  request_sha256,actor_staff_id,actor_access_subject,admission_version,profile_version) VALUES(?,?,?,'revoke',?,?,?, ?,?,?,?)`)
  .bind(operationId,logical,revisionId,version,version+1,"b".repeat(64),owner.id,owner.accessSubject,actorFence!.admission_version,actorFence!.profile_version).run();
 await ops.prepare("UPDATE native_staff_admissions SET active=0,version=version+1 WHERE staff_id=?").bind(owner.id).run();
 await expect(ops.prepare("UPDATE portal_directory_correspondence_heads SET state='revoked',version=version+1,operation_id=? WHERE directory_source_id=?")
  .bind(operationId,logical).run()).rejects.toThrow("actor_changed");
 expect(await ops.prepare("SELECT version FROM portal_directory_correspondence_heads WHERE directory_source_id=?").bind(logical).first("version")).toBe(version);
 expect(await ops.prepare("SELECT state FROM portal_directory_correspondence_heads WHERE directory_source_id=?").bind(logical).first("state")).toBe("active");
 expect(await ops.prepare("SELECT count(*) n FROM portal_directory_correspondence_receipts WHERE operation_id=?").bind(operationId).first("n")).toBe(1);
 expect((await ops.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
},60_000);

it("retains only the current nominee and active historical head for explicit revocation, with primary app authority enforced",async()=>{
 const selected=await resolveDirectoryPortalSource(env,logical,tuple);expect(selected?.portalSourceId).toBe(primary);
 await client.prepare("UPDATE pa_portal_primary_private_authority SET state='suspended',version=version+1 WHERE source_id=?").bind(primary).run();
 expect(await resolveDirectoryPortalSource(env,logical,tuple,selected!.correspondenceRevisionId)).toBeNull();
 await client.prepare("UPDATE pa_portal_primary_private_authority SET state='active',version=version+1 WHERE source_id=?").bind(primary).run();
 await expect(client.prepare("UPDATE pa_portal_primary_private_authority SET application_key='wrong-app',version=version+1 WHERE source_id=?").bind(primary).run()).rejects.toThrow("conflict");
 expect(await resolveDirectoryPortalSource(env,logical,tuple,selected!.correspondenceRevisionId)).toEqual(selected);
 // Fresh administrator authority is restored in this local fixture; old orphan receipts retain their stale versions.
 await ops.prepare("UPDATE native_staff_admissions SET active=1,version=version+1 WHERE staff_id=?").bind(owner.id).run();
 const base=JSON.parse(env.PROJECT_ALPHA_API_V2_CONNECTIONS!),old=base.instances[logical];
 const current="project-alpha:current",next="project-alpha:next";
 const cenv={...env,PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify({version:1,instances:{[current]:{...old,sourceId:current,sourceInstanceId:other,applicationId:"66666666-6666-4666-8666-666666666666",historyEpoch:"77777777-7777-4777-8777-777777777777"}}})};
 const discovered=await discoverPortalDirectoryCorrespondence(cenv);
 expect(discovered.candidates.map(c=>c.directorySourceId).sort()).toEqual([current,logical].sort());
 const preview=await previewPortalDirectoryCorrespondence(cenv,current);expect(preview.preview).not.toBeNull();
 const command={operationId:crypto.randomUUID(),action:"approve" as const,expectedVersion:0,expectedProofSha256:preview.preview!.proofSha256};
 const sendC=vi.fn<typeof fetch>(async()=>Response.json({apiVersion:"2",sourceInstanceId:preview.preview!.proof.sourceInstanceId,applicationId:preview.preview!.proof.applicationId,historyEpoch:preview.preview!.proof.historyEpochId,
  requestId:"55555555-5555-4555-8555-555555555555",grantedCapabilities:[{name:"api.capabilities.read"}],implementedEndpoints:[{method:"GET",path:"/api/v2/capabilities",requiredCapability:"api.capabilities.read"}]},
  {headers:{"Cache-Control":"no-store","X-Request-ID":"55555555-5555-4555-8555-555555555555"}}));
 expect(await managePortalDirectoryCorrespondence(cenv,owner,current,command,sendC)).toEqual({ok:false,code:"rejected",operationId:command.operationId});
 expect(sendC).not.toHaveBeenCalled();
 const historical=await previewPortalDirectoryCorrespondence(cenv,logical);
 expect(await managePortalDirectoryCorrespondence(cenv,owner,logical,{operationId:crypto.randomUUID(),action:"revoke",expectedVersion:historical.current!.version,expectedProofSha256:historical.current!.revocationProofSha256},sendC)).toMatchObject({ok:true});
 expect(await managePortalDirectoryCorrespondence(cenv,owner,current,command,sendC)).toMatchObject({ok:true,version:1});
 const nenv={...env,PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify({version:1,instances:{[next]:{...old,sourceId:next}}})};
 expect((await discoverPortalDirectoryCorrespondence(nenv)).candidates.map(c=>c.directorySourceId).sort()).toEqual([current,next].sort());
 const previous=await previewPortalDirectoryCorrespondence(nenv,current);
 expect(await managePortalDirectoryCorrespondence(nenv,owner,current,{operationId:crypto.randomUUID(),action:"revoke",expectedVersion:previous.current!.version,expectedProofSha256:previous.current!.revocationProofSha256},sendC)).toMatchObject({ok:true});
 expect((await discoverPortalDirectoryCorrespondence(nenv)).candidates.map(c=>c.directorySourceId)).toEqual([next]);
 expect(await ops.prepare("SELECT count(*) n FROM portal_directory_correspondence_heads WHERE state='revoked'").first("n")).toBe(2);
},60_000);
