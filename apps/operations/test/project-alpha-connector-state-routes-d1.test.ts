import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { HTTPException } from "hono/http-exception";
import { applyCanonicalChain } from "./helpers/verified-recipient-canonical-lineage";
const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: mocks.authenticate }));
import worker, { projectAlphaProjectionApiRequest } from "../src/worker/index";
import * as connectors from "../src/worker/project-alpha-connectors";
import * as portal from "../../client/src/worker/project-alpha-portal-authority";
import { configureConnectorPortal, changeConnectorPortal, getConnectorPortalStatus } from "../src/worker/project-alpha-portal-coordination";
import { csrfToken } from "../src/worker/request-security";
import type { Env, StaffPrincipal } from "../src/worker/types";

const ROOT="/api/admin/integrations/project-alpha/connectors",PRIMARY="project-alpha:primary",SECONDARY="project-alpha:secondary";
const actor:StaffPrincipal={id:"connector-state-owner",email:"connector-state@example.test",displayName:"Connector State Owner",accessSubject:"connector-state-human",projectAlphaUserId:null};
const context={waitUntil(){},passThroughOnException(){}} as unknown as ExecutionContext;
const key=(n:number)=>btoa(String.fromCharCode(...new Uint8Array(32).fill(n))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
const credential=(n:number)=>({snapshotApiKey:`private-snapshot-${n}`,eventCurrent:{keyId:`event-${n}`,algorithm:"ed25519",value:key(n)},portalCurrent:{keyId:`portal-${n}`,value:`private-portal-${n}-at-least-thirty-two-characters`}});
let runtime:Miniflare,db:D1Database,delivery:D1Database,env:Env,manifest:string;
async function current(source:string){return(await connectors.listProjectAlphaConnectors(env)).find(c=>c.sourceId===source)!;}
const path=(source:string)=>`${ROOT}/${encodeURIComponent(source)}/state`;
async function send(url:string,method="GET",body?:unknown,headers:Record<string,string>={}){
 const defaults:Record<string,string>=method==="GET"?{}:{Origin:"https://ops.example","Content-Type":"application/json","X-CSRF-Token":await csrfToken(env,actor)};
 return worker.fetch(new Request(`https://ops.example${url}`,{method,headers:{...defaults,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,context);
}
async function state(source:string,state:"active"|"suspended",version?:number){return send(path(source),"POST",{expectedVersion:version??(await current(source)).version,state});}
async function counts(){return Promise.all(["pa_connectors","pa_connector_revisions","pa_connector_audit","pa_connector_portal_coordination_audit"].map(t=>db.prepare(`SELECT count(*) n FROM ${t}`).first("n")));}

describe("bounded business connection control on actual pre215 Ops212 + paired Client schema",{concurrent:false,timeout:90_000},()=>{
 beforeAll(async()=>{
  runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {}",d1Databases:["OPS_DB","DELIVERY_DB"]});
  db=await runtime.getD1Database("OPS_DB")as D1Database;delivery=await runtime.getD1Database("DELIVERY_DB")as D1Database;
  await applyCanonicalChain(db,"operations","0212_primary_portal_directory_correspondence.sql");
  await applyCanonicalChain(delivery,"client","0234_pa_principal_reenrollment.sql");
  await db.batch([
   db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,'active')").bind(actor.id,actor.email,actor.displayName,actor.accessSubject),
   db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(actor.id,actor.accessSubject,actor.id),
   db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(actor.id,actor.email,actor.displayName),
   db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key,created_by) VALUES('connector-state-owner-role',?,'role-owner','global','global',?)").bind(actor.id,actor.id),
   db.prepare("INSERT INTO divisions(id,name,code,active) VALUES('connector-state-local','Local Division','connector-state-local',1)"),
  ]);
  const credentials={primary:credential(1),secondary:credential(2)};
  const sources=[];
  for(const[id,ref,n]of[[PRIMARY,"primary",1],[SECONDARY,"secondary",2]]as const){
   const prefix=new TextEncoder().encode("ed25519\0"),bytes=new Uint8Array(prefix.length+32);bytes.set(prefix);bytes.fill(n,prefix.length);
   const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))).map(v=>v.toString(16).padStart(2,"0")).join("");
   sources.push({sourceId:id,producerBindingId:`producer-${ref}`,snapshotOrigin:`https://${ref}.example.test`,applicationKey:"ltds_ops",profile:id===PRIMARY?"primary_legacy":"business_data",displayName:ref,enabled:true,readVisible:true,
    revision:{credentialRef:ref,snapshotBasePath:"/",accessIssuer:"https://access.example.test",accessAudience:`aud-${ref}`,accessSubject:`service-${ref}`,eventCurrent:{keyId:`event-${n}`,algorithm:"ed25519",fingerprint}}});
  }
  manifest=JSON.stringify({version:1,sources});
  env={OPS_DB:db,DELIVERY_DB:delivery,ENVIRONMENT:"development",EXPECTED_HOST:"ops.example",INCOMING_EXPECTED_HOST:"incoming.example",PUBLIC_BASE_URL:"https://ops.example",
   OPERATIONS_SESSION_SECRET:"private-session-secret-at-least-thirty-two-characters",AUDIT_IP_SECRET:"private-audit-at-least-thirty-two-characters",APPLICATION_KEY:"ltds_ops",
   PROJECT_ALPHA_BASE_URL:"https://primary.example.test",PROJECT_ALPHA_API_KEY:credentials.primary.snapshotApiKey,PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY:key(1),PROJECT_ALPHA_PORTAL_HMAC_SECRET:"private-primary-portal-at-least-thirty-two-characters",
   PROJECT_ALPHA_CONNECTOR_SOURCES:manifest,PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED:"true",PROJECT_ALPHA_CONNECTOR_CREDENTIALS:JSON.stringify({version:1,sets:credentials}),
   PROJECT_ALPHA_CONNECTOR_SNAPSHOT_CREDENTIALS:JSON.stringify({version:1,sets:{primary:{snapshotApiKey:credentials.primary.snapshotApiKey},secondary:{snapshotApiKey:credentials.secondary.snapshotApiKey}}}),
   PROJECT_ALPHA_CONNECTOR_EVENT_CREDENTIALS:JSON.stringify({version:1,sets:{primary:{eventCurrent:credentials.primary.eventCurrent},secondary:{eventCurrent:credentials.secondary.eventCurrent}}})}as unknown as Env;
  await connectors.ensureDeploymentConfiguredProjectAlphaConnectors(env);
  const staged=await configureConnectorPortal(env,SECONDARY,(await current(SECONDARY)).version,null,actor.id);
  await changeConnectorPortal(env,SECONDARY,(await current(SECONDARY)).version,staged.version,"active",actor.id);
  // Existing portal provisioning is complete. Normal deployed business
  // administration must now work with split credentials only.
  env.PROJECT_ALPHA_CONNECTOR_CREDENTIALS=undefined;
 },180_000);
 beforeEach(()=>{vi.restoreAllMocks();mocks.authenticate.mockReset().mockResolvedValue(actor);});
 afterAll(async()=>{vi.restoreAllMocks();await runtime?.dispose();});

 it("keeps the exemption exact to supported method/path families",()=>{
  expect(projectAlphaProjectionApiRequest(path(SECONDARY),"GET")).toBe(false);expect(projectAlphaProjectionApiRequest(path(SECONDARY),"POST")).toBe(false);
  expect(projectAlphaProjectionApiRequest(`${ROOT}/recover-portal-update`,"POST")).toBe(false);
  for(const[url,method]of[[path(SECONDARY),"PATCH"],[path(SECONDARY),"DELETE"],[`${ROOT}/recover-portal-update`,"GET"],[`${path(SECONDARY)}/extra`,"POST"],[ROOT,"GET"],[`${ROOT}/${encodeURIComponent(SECONDARY)}/portal`,"POST"]])expect(projectAlphaProjectionApiRequest(url!,method)).toBe(true);
 });
 it("preserves normal worker authentication, administrator/global-deny and Origin/CSRF guards",async()=>{
  const before=await counts();mocks.authenticate.mockRejectedValueOnce(new HTTPException(401));expect((await send(path(SECONDARY))).status).toBe(401);
  await db.prepare("DELETE FROM staff_role_assignments WHERE id='connector-state-owner-role'").run();expect((await send(path(SECONDARY))).status).toBe(403);
  await db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key,created_by) VALUES('connector-state-owner-role',?,'role-owner','global','global',?)").bind(actor.id,actor.id).run();
  await db.prepare("INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by) VALUES('connector-state-deny',?,'integrations.manage','deny','global','global',?)").bind(actor.id,actor.id).run();
  expect((await send(path(SECONDARY))).status).toBe(403);expect((await state(SECONDARY,"suspended")).status).toBe(403);
  await db.prepare("DELETE FROM staff_permission_overrides WHERE id='connector-state-deny'").run();
  expect((await send(path(SECONDARY),"POST",{expectedVersion:2,state:"suspended"},{Origin:"https://wrong.example"})).status).toBe(403);
  expect((await send(path(SECONDARY),"POST",{expectedVersion:2,state:"suspended"},{"X-CSRF-Token":"wrong"})).status).toBe(403);expect(await counts()).toEqual(before);
 });
 it("accepts only bounded strict state/version JSON and never browser authority, registration or retirement",async()=>{
  const before=await counts();
  for(const value of[{expectedVersion:0,state:"active"},{expectedVersion:1.5,state:"active"},{expectedVersion:1,state:"retired"},{expectedVersion:1,state:"pending"},
   {expectedVersion:1,state:"active",actorId:"spoof"},{expectedVersion:1,state:"active",readVisible:false},{expectedVersion:1,state:"active",displayName:"new"},{expectedVersion:1,state:"active",credentialRef:"new"}])expect((await send(path(SECONDARY),"POST",value)).status).toBe(400);
  expect((await send(path(SECONDARY),"POST",{padding:"x".repeat(17000)})).status).toBe(413);
  expect((await send(path(SECONDARY),"POST",{}, {"Content-Type":"text/plain"})).status).toBe(415);expect(await counts()).toEqual(before);
 });
 it("requires a real nonempty manifest and registered membership without registering or reconciling",async()=>{
  const before=await counts();
  expect((await send(path("project-alpha:foreign"))).status).toBe(404);expect((await send(path("project-alpha:foreign"),"POST",{expectedVersion:1,state:"active"})).status).toBe(404);
  try{env.PROJECT_ALPHA_CONNECTOR_SOURCES=undefined;env.PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED="false";expect((await send(path(PRIMARY))).status).toBe(404);expect((await state(PRIMARY,"suspended")).status).toBe(404);}
  finally{env.PROJECT_ALPHA_CONNECTOR_SOURCES=manifest;env.PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED="true";}
  expect(await counts()).toEqual(before);
 });
 it("does not activate a manifest-disabled source",async()=>{
  const before=await counts(),disabled=JSON.parse(manifest);disabled.sources[1].enabled=false;
  try{env.PROJECT_ALPHA_CONNECTOR_SOURCES=JSON.stringify(disabled);expect((await state(SECONDARY,"active")).status).toBe(409);expect((await send(path(SECONDARY))).status).toBe(200);}
  finally{env.PROJECT_ALPHA_CONNECTOR_SOURCES=manifest;}expect(await counts()).toEqual(before);
 });
 it("rejects stale CAS before opening a durable coordination attempt",async()=>{
  const before=await counts();expect((await state(SECONDARY,"suspended",(await current(SECONDARY)).version-1)).status).toBe(409);expect(await counts()).toEqual(before);expect((await getConnectorPortalStatus(env)).recovery).toBeNull();
 });
 it("does not resume an old producer under changed manifest identity or revision, but observation remains read-only",async()=>{
  expect((await state(SECONDARY,"suspended")).status).toBe(200);
  const before=await counts();
  for(const change of[(value:any)=>{value.producerBindingId="different-producer";},(value:any)=>{value.snapshotOrigin="https://different.example.test";},
   (value:any)=>{value.revision.credentialRef="different-reference";},(value:any)=>{value.revision.eventCurrent.fingerprint="f".repeat(64);}]){
   const changed=JSON.parse(manifest);change(changed.sources[1]);
   try{env.PROJECT_ALPHA_CONNECTOR_SOURCES=JSON.stringify(changed);expect((await state(SECONDARY,"active")).status).toBe(409);expect((await send(path(SECONDARY))).status).toBe(200);}
   finally{env.PROJECT_ALPHA_CONNECTOR_SOURCES=manifest;}
   expect(await counts()).toEqual(before);expect((await getConnectorPortalStatus(env)).recovery).toBeNull();
  }
  expect((await current(SECONDARY)).state).toBe("suspended");expect((await state(SECONDARY,"active")).status).toBe(200);
  expect((await portal.getPortalSourceAuthority(delivery,SECONDARY))?.state).toBe("suspended");
 });
 it("pauses secondary then primary on actual212, fences stale division DML, observes state without ensure, then resumes without reviving portal",async()=>{
  expect(await db.prepare("SELECT name FROM sqlite_master WHERE name='pa_local_division_mappings'").first()).toBeNull();
  const old=[await connectors.resolveProjectAlphaConnector(env,PRIMARY,"events"),await connectors.resolveProjectAlphaConnector(env,SECONDARY,"events")];
  // Positive control: these are usable real registry proofs before suspension.
  for(const proof of old)await db.batch([connectors.connectorFenceStatement(db,proof.proof),db.prepare("UPDATE divisions SET active=1 WHERE id='connector-state-local'")]);
  const ensure=vi.spyOn(connectors,"ensureDeploymentConfiguredProjectAlphaConnectors");
  expect((await state(SECONDARY,"suspended")).status).toBe(200);expect((await state(PRIMARY,"suspended")).status).toBe(200);expect(ensure).not.toHaveBeenCalled();
  for(const id of[PRIMARY,SECONDARY]){const r=await send(path(id));expect(r.status).toBe(200);expect(r.headers.get("Cache-Control")).toBe("no-store");expect(await r.json()).toMatchObject({connector:{sourceId:id,state:"suspended"},coordination:{available:true,recovery:null}});}
  expect(ensure).not.toHaveBeenCalled();
  await expect(connectors.ensureDeploymentConfiguredProjectAlphaConnectors(env)).rejects.toMatchObject({code:"changed"});
  expect((await current(PRIMARY)).state).toBe("suspended");expect((await current(SECONDARY)).state).toBe("suspended");
  for(const stale of old)await expect(db.batch([connectors.connectorFenceStatement(db,stale.proof),db.prepare("UPDATE divisions SET active=0 WHERE id='connector-state-local'")])).rejects.toThrow(/pa_connector_active_revision_guard/);
  expect(await db.prepare("SELECT active FROM divisions WHERE id='connector-state-local'").first("active")).toBe(1);
  expect((await state(PRIMARY,"active")).status).toBe(200);expect((await state(SECONDARY,"active")).status).toBe(200);
  expect((await portal.getPortalSourceAuthority(delivery,SECONDARY))?.state).toBe("suspended");await connectors.ensureDeploymentConfiguredProjectAlphaConnectors(env);
  for(const id of[PRIMARY,SECONDARY])expect((await current(id)).state).toBe("active");
 });
 it("keeps normal integration requests on autoensure while unknown sources/encoded paths/methods cannot create connections",async()=>{
  const before=await counts(),ensure=vi.spyOn(connectors,"ensureDeploymentConfiguredProjectAlphaConnectors");
  await send(ROOT);expect(ensure).toHaveBeenCalled();ensure.mockClear();
  expect((await send(path("project-alpha:secondary/extra"))).status).toBe(404);expect(ensure).not.toHaveBeenCalled();
  expect((await send(path(SECONDARY),"PATCH",{expectedVersion:1,state:"active"})).status).toBe(404);expect(ensure).toHaveBeenCalled();
  mocks.authenticate.mockRejectedValueOnce(new HTTPException(401));expect((await send(path("project-alpha:unknown"))).status).toBe(401);expect(await counts()).toEqual(before);
 });
 it("shows unfinished durable portal coordination after a barrier failure and uses the existing recovery POST without autoensure",async()=>{
  const original=await current(SECONDARY);const failure=vi.spyOn(portal,"setPortalSourceAuthorityState").mockRejectedValueOnce(new portal.PortalSourceAuthorityError("unavailable"));
  expect((await state(SECONDARY,"suspended")).status).toBe(503);expect(failure).toHaveBeenCalled();failure.mockRestore();
  expect((await current(SECONDARY)).version).toBe(original.version);
  const observed=await send(path(SECONDARY));const value=await observed.json()as {coordination:{recovery:{version:number;sourceId:string}}};expect(observed.status).toBe(200);expect(value.coordination.recovery.sourceId).toBe(SECONDARY);
  expect(JSON.stringify(value)).not.toMatch(/private-|credentialRef|current_key|"token"|accessSubject/);
  expect((await state(SECONDARY,"suspended")).status).toBe(409);
  const ensure=vi.spyOn(connectors,"ensureDeploymentConfiguredProjectAlphaConnectors");
  expect((await send(`${ROOT}/recover-portal-update`,"POST",{expectedVersion:value.coordination.recovery.version})).status).toBe(200);expect(ensure).not.toHaveBeenCalled();
  expect((await getConnectorPortalStatus(env)).recovery).toBeNull();
  const audit=await db.prepare("SELECT DISTINCT actor_id FROM pa_connector_portal_coordination_audit").all<{actor_id:string}>();expect(audit.results.every(row=>row.actor_id===actor.id)).toBe(true);
 });
 it("keeps a durable hold when deployed split credentials are unavailable and resumes only after explicit recovery",async()=>{
  expect(env.PROJECT_ALPHA_CONNECTOR_CREDENTIALS).toBeUndefined();expect((await state(SECONDARY,"suspended")).status).toBe(200);
  const version=(await current(SECONDARY)).version,split=env.PROJECT_ALPHA_CONNECTOR_SNAPSHOT_CREDENTIALS;
  try{env.PROJECT_ALPHA_CONNECTOR_SNAPSHOT_CREDENTIALS=undefined;expect((await state(SECONDARY,"active")).status).toBe(503);}
  finally{env.PROJECT_ALPHA_CONNECTOR_SNAPSHOT_CREDENTIALS=split;}
  expect(await current(SECONDARY)).toMatchObject({version,state:"suspended"});
  const held=await getConnectorPortalStatus(env);expect(held.recovery).not.toBeNull();
  expect((await send(`${ROOT}/recover-portal-update`,"POST",{expectedVersion:held.recovery!.version})).status).toBe(200);
  expect((await state(SECONDARY,"active")).status).toBe(200);expect((await portal.getPortalSourceAuthority(delivery,SECONDARY))?.state).toBe("suspended");
 });
});
