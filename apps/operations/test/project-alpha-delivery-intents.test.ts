import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Miniflare } from "miniflare";
import {
  handleProjectAlphaDeliveryIntent,
  handleProjectAlphaDeliveryIntentRevoke,
  handleProjectAlphaDeliveryPreflight,
  pruneProjectAlphaDeliveryIntentRateLimits,
  projectAlphaDeliveryMachineHostRequest,
  projectAlphaDeliveryMachineRequest,
} from "../src/worker/project-alpha-delivery-intents";
import { processDeliveryNotifications } from "../src/worker/notifications";
import type { Env } from "../src/worker/types";

async function signedPreflight(secret:string,overrides:Record<string,string>={}){
  const path="/api/internal/project-alpha/delivery-intents/preflight",timestamp=new Date().toISOString();
  const value={schemaVersion:1,applicationKey:"project-alpha",deliveryId:"11111111-1111-4111-8111-111111111111",occurredAt:timestamp};
  const body=JSON.stringify(value),bytes=new TextEncoder().encode(body);
  const digest=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(v=>v.toString(16).padStart(2,"0")).join("");
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const signature=[...new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${timestamp}\nPOST\n${path}\nops-v1\n${value.deliveryId}\n${body}`)))].map(v=>v.toString(16).padStart(2,"0")).join("");
  return new Request(`https://incoming.example.test${path}`,{method:"POST",headers:{"Content-Type":"application/json",
    "X-Portal-Integration-Application-Key":"project-alpha","X-Portal-Integration-Timestamp":timestamp,
    "X-Portal-Integration-Body-SHA256":digest,"X-Portal-Integration-Key-Id":"ops-v1",
    "X-Portal-Integration-Delivery-Id":value.deliveryId,"X-Portal-Integration-Signature":`sha256=${signature}`,...overrides},body});
}
async function signedRequest(path:string,value:Record<string,unknown>,secret:string){
  const timestamp=new Date().toISOString(),body=JSON.stringify(value),bytes=new TextEncoder().encode(body);
  const digest=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(v=>v.toString(16).padStart(2,"0")).join("");
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const canonical=`${timestamp}\nPOST\n${path}\nops-v1\n${value.deliveryId}\n${body}`;
  const signature=[...new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(canonical)))].map(v=>v.toString(16).padStart(2,"0")).join("");
  return new Request(`https://incoming.example.test${path}`,{method:"POST",headers:{"Content-Type":"application/json",
    "X-Portal-Integration-Application-Key":"project-alpha","X-Portal-Integration-Timestamp":timestamp,
    "X-Portal-Integration-Body-SHA256":digest,"X-Portal-Integration-Key-Id":"ops-v1",
    "X-Portal-Integration-Delivery-Id":String(value.deliveryId),"X-Portal-Integration-Signature":`sha256=${signature}`},body});
}
async function applyMigration(db:D1Database,url:URL){const sql=readFileSync(url,"utf8").replace(/\r\n/g,"\n")
  .replace(/^\s*--.*$/gm,"").replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/gim,"");
  for(const statement of sql.split(/;\s*(?:\n|$)/).map(value=>value.trim()).filter(Boolean))await db.prepare(statement).run();}
async function applyRateMigrations(db:D1Database){
  await applyMigration(db,new URL("../migrations/0031_project_alpha_delivery_intent_rate_limits.sql",import.meta.url));
  await applyMigration(db,new URL("../migrations/0049_project_alpha_delivery_source_rate_limits.sql",import.meta.url));
}
async function runSqlStatements(db:D1Database,sql:string):Promise<void>{
  for(const statement of sql.split(";").map(value=>value.trim()).filter(Boolean))await db.prepare(statement).run();
}

async function prepareGuestDeliveryDatabase(db:D1Database):Promise<void>{
  await runSqlStatements(db,`
    CREATE TABLE projects(
      id TEXT PRIMARY KEY,division_id TEXT,client_name TEXT NOT NULL,project_name TEXT NOT NULL,
      r2_prefix TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT(datetime('now')),
      project_alpha_source_id TEXT
    );
    CREATE TABLE shares(
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,public_id TEXT UNIQUE,label TEXT,
      password_hash TEXT,password_salt TEXT,password_iterations INTEGER,password_algorithm TEXT,expires_at TEXT,
      revoked_at TEXT,revoked_reason TEXT,created_by_type TEXT NOT NULL,created_by_id TEXT NOT NULL,
      idempotency_key TEXT,share_version INTEGER NOT NULL DEFAULT 1,secret_ciphertext TEXT,secret_iv TEXT,
      r2_prefix TEXT,r2_object_key TEXT,division_id TEXT,recipient_email TEXT,image_location_map_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT(datetime('now')),FOREIGN KEY(project_id) REFERENCES projects(id)
    );
    CREATE UNIQUE INDEX idx_shares_one_active_prefix ON shares(r2_prefix) WHERE revoked_at IS NULL AND r2_prefix IS NOT NULL AND r2_object_key IS NULL;
    CREATE UNIQUE INDEX idx_shares_one_active_object ON shares(r2_object_key) WHERE revoked_at IS NULL AND r2_object_key IS NOT NULL;
    CREATE UNIQUE INDEX idx_shares_idempotency ON shares(created_by_type,created_by_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE TABLE audit_log(
      id INTEGER PRIMARY KEY AUTOINCREMENT,actor_type TEXT NOT NULL,actor_id TEXT,action TEXT NOT NULL,
      entity_type TEXT,entity_id TEXT,details_json TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now'))
    );
    CREATE TABLE delivery_notifications(
      id TEXT PRIMARY KEY,dedupe_key TEXT NOT NULL UNIQUE,share_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('share_created','share_updated','share_revoked','first_access','expiring_72h')),
      recipient_email TEXT NOT NULL,payload_json TEXT NOT NULL,
      share_version INTEGER,recipient_authority_kind TEXT,recipient_principal_public_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT NOT NULL DEFAULT(datetime('now')),lease_until TEXT,
      sent_at TEXT,last_error TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')),
      updated_at TEXT NOT NULL DEFAULT(datetime('now')),FOREIGN KEY(share_id) REFERENCES shares(id)
    );
    CREATE TABLE delivery_share_audience_snapshots(
      share_id TEXT NOT NULL,share_version INTEGER NOT NULL,workspace_id TEXT NOT NULL,folder_binding_id TEXT NOT NULL,
      owner_scope_type TEXT NOT NULL,owner_public_id TEXT NOT NULL,directory_generation_id TEXT NOT NULL,
      audience_type TEXT NOT NULL,audience_public_id TEXT NOT NULL,audience_display_name TEXT NOT NULL,
      selected_by_staff_id TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')),
      PRIMARY KEY(share_id,share_version),FOREIGN KEY(share_id) REFERENCES shares(id)
    );
    CREATE TABLE delivery_share_recipient_members(
      share_id TEXT NOT NULL,share_version INTEGER NOT NULL,recipient_principal_public_id TEXT NOT NULL,
      recipient_display_name TEXT NOT NULL,recipient_normalized_email TEXT NOT NULL,
      PRIMARY KEY(share_id,share_version,recipient_principal_public_id),
      FOREIGN KEY(share_id,share_version) REFERENCES delivery_share_audience_snapshots(share_id,share_version)
    );
    CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,status TEXT NOT NULL,project_alpha_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    CREATE TABLE portal_v2_folder_bindings(
      id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,owner_scope_type TEXT NOT NULL,owner_public_id TEXT NOT NULL,
      r2_prefix TEXT NOT NULL,source_version TEXT NOT NULL,status TEXT NOT NULL,revoked_at TEXT,
      UNIQUE(id,workspace_id)
    );
    CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT PRIMARY KEY,active_generation_id TEXT NOT NULL);
    CREATE TABLE portal_v2_directory_generations(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,status TEXT NOT NULL,complete INTEGER NOT NULL);
    CREATE TABLE portal_v2_directory_entities(
      workspace_id TEXT NOT NULL,generation_id TEXT NOT NULL,entity_type TEXT NOT NULL,public_id TEXT NOT NULL,
      parent_public_id TEXT,display_name TEXT NOT NULL,source_version TEXT NOT NULL,active INTEGER NOT NULL
    );
    CREATE TABLE pa_portal_principals(
      workspace_id TEXT NOT NULL,public_id TEXT NOT NULL,identity_id TEXT,email_hint TEXT,display_name TEXT NOT NULL,
      source_version TEXT NOT NULL,status TEXT NOT NULL
    );
    CREATE TABLE portal_v2_identities(
      id TEXT PRIMARY KEY,issuer TEXT NOT NULL,subject TEXT NOT NULL,verified_email TEXT NOT NULL,status TEXT NOT NULL,revoked_at TEXT
    );
    CREATE TABLE portal_v2_identity_eligibility_bindings(
      identity_id TEXT,workspace_id TEXT,principal_public_id TEXT,principal_source_version TEXT,verified_email TEXT
    );
    CREATE TABLE portal_v2_workspace_memberships(
      workspace_id TEXT,identity_id TEXT,status TEXT,revoked_at TEXT,expires_at TEXT
    );
    CREATE TABLE portal_v2_identity_eligibility_blocks(
      id TEXT PRIMARY KEY,match_type TEXT,issuer TEXT,subject TEXT,normalized_email TEXT,status TEXT,valid_from TEXT,expires_at TEXT
    );
    CREATE TABLE portal_v2_identity_denials(
      identity_id TEXT,status TEXT,revoked_at TEXT,valid_from TEXT,expires_at TEXT,scope_type TEXT,workspace_id TEXT,scope_public_id TEXT
    );
    CREATE TABLE project_alpha_delivery_intent_receipts(
      receipt_id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL,request_fingerprint TEXT NOT NULL,
      access_mode TEXT NOT NULL,resource_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'accepted',created_at TEXT NOT NULL DEFAULT(datetime('now')),
      project_alpha_source_id TEXT NOT NULL,write_guard INTEGER NOT NULL DEFAULT 1 CHECK(write_guard=1),
      UNIQUE(project_alpha_source_id,delivery_id)
    );
    CREATE TABLE project_alpha_delivery_portal_grants(
      id TEXT PRIMARY KEY,receipt_id TEXT NOT NULL UNIQUE,workspace_id TEXT NOT NULL,folder_binding_id TEXT NOT NULL,
      binding_source_version TEXT NOT NULL,audience_type TEXT NOT NULL,audience_public_id TEXT NOT NULL,
      audience_source_version TEXT NOT NULL,grant_version INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'active',
      expires_at TEXT,label TEXT,actor_kind TEXT NOT NULL DEFAULT 'project_alpha_delivery',actor_id TEXT NOT NULL,
      revoked_at TEXT,revoke_reason_code TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now'))
    );
    CREATE TABLE project_alpha_delivery_intent_audit(
      id TEXT PRIMARY KEY,receipt_id TEXT NOT NULL,action TEXT NOT NULL,actor_kind TEXT NOT NULL DEFAULT 'project_alpha_delivery',
      actor_id TEXT NOT NULL,details_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT(datetime('now'))
    );
    CREATE TABLE project_alpha_delivery_intent_revocation_receipts(
      receipt_id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL,original_receipt_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')),
      project_alpha_source_id TEXT NOT NULL,write_guard INTEGER NOT NULL DEFAULT 1 CHECK(write_guard=1),
      UNIQUE(project_alpha_source_id,delivery_id)
    );
    CREATE TABLE project_alpha_delivery_portal_notification_outbox(
      id TEXT PRIMARY KEY,receipt_id TEXT NOT NULL,grant_id TEXT NOT NULL,principal_public_id TEXT NOT NULL,
      principal_source_version TEXT NOT NULL,event_type TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT NOT NULL DEFAULT(datetime('now')),
      lease_expires_at TEXT,last_error TEXT,delivered_at TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')),
      updated_at TEXT NOT NULL DEFAULT(datetime('now'))
    );
    CREATE TABLE project_alpha_delivery_guest_authority(
      share_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,folder_binding_id TEXT NOT NULL,binding_source_version TEXT NOT NULL,
      directory_generation_id TEXT NOT NULL,principal_public_id TEXT NOT NULL,principal_source_version TEXT NOT NULL,label TEXT,
      status TEXT NOT NULL DEFAULT 'active',revoked_at TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now'))
    );
  `);
  await runSqlStatements(db,`
    INSERT INTO projects(id,division_id,client_name,project_name,r2_prefix) VALUES('project-row','division-one','Client One','Project One','jobs/client-one/project-one/');
    INSERT INTO portal_v2_workspaces(id,status) VALUES('workspace-one','active');
    INSERT INTO portal_v2_folder_bindings VALUES('binding-one','workspace-one','project','project-one','jobs/client-one/project-one/','binding-v1','active',NULL);
    INSERT INTO portal_v2_directory_checkpoints VALUES('workspace-one','generation-one');
    INSERT INTO portal_v2_directory_generations VALUES('generation-one','workspace-one','active',1);
    INSERT INTO portal_v2_directory_entities VALUES('workspace-one','generation-one','project','project-one',NULL,'Project One','binding-v1',1);
    INSERT INTO pa_portal_principals VALUES('workspace-one','principal-one',NULL,'Client@Example.test','Client One','principal-v1','active');
  `);
}

async function createGuestHarness(suffix:string){
  const mf=new Miniflare({compatibilityDate:"2026-08-06",modules:true,script:"export default {fetch(){return new Response('ok')}}",
    d1Databases:{OPS_DB:`pa-guest-ops-${suffix}`,DELIVERY_DB:`pa-guest-delivery-${suffix}`}});
  const ops=await mf.getD1Database("OPS_DB") as unknown as D1Database;
  const delivery=await mf.getD1Database("DELIVERY_DB") as unknown as D1Database;
  await applyRateMigrations(ops);
  await prepareGuestDeliveryDatabase(delivery);
  const secret="0123456789abcdef0123456789abcdef";
  const env={OPS_DB:ops,DELIVERY_DB:delivery,PROJECT_ALPHA_PORTAL_APPLICATION_KEY:"project-alpha",PROJECT_ALPHA_PORTAL_HMAC_KEY_ID:"ops-v1",
    PROJECT_ALPHA_PORTAL_HMAC_SECRET:secret,PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED:"true",PROJECT_ALPHA_DELIVERY_GUEST_ENABLED:"true",
    CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED:"true",CLIENT_PORTAL_HIERARCHY_V2_ENABLED:"true",
    CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:"true",CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED:"true",
    AUTHENTICATED_DELIVERY_GRANTS_ENABLED:"true",DELIVERY_BASE_URL:"https://client.example.test",PUBLIC_SHARE_ORIGIN:"https://delivery.example.test",
    DELIVERY_TOKEN_SECRET:"test-delivery-token-secret-that-is-long-enough",NOTIFICATION_FROM:"notifications@example.test"} as unknown as Env;
  const app=new Hono<{Bindings:Env}>();
  app.post("/api/internal/project-alpha/delivery-intents",handleProjectAlphaDeliveryIntent);
  app.post("/api/internal/project-alpha/delivery-intents/revoke",handleProjectAlphaDeliveryIntentRevoke);
  return{mf,delivery,env,app,secret};
}

function beforeNextDeliveryBatch(database:D1Database,interleave:()=>Promise<void>):D1Database{
  let pending=true;
  return new Proxy(database,{get(target,key){
    if(key==="batch")return async (statements:D1PreparedStatement[])=>{
      if(pending){pending=false;await interleave();}
      return target.batch(statements);
    };
    const value=Reflect.get(target,key,target);
    return typeof value==="function"?value.bind(target):value;
  }});
}

function guestIntent(deliveryId:string){return{
  schemaVersion:1,applicationKey:"project-alpha",deliveryId,occurredAt:new Date().toISOString(),
  scope:{type:"project",publicId:"project-one"},audience:{type:"principal",publicId:"principal-one"},
  accessMode:"guest",expiresAt:new Date(Date.now()+30*86400000).toISOString(),label:null,notify:true,
};}

describe("Project Alpha delivery-intent boundary", () => {
  it("collapses concurrent guest creation and revocation retries to one receipt each",async()=>{
    const {mf,delivery,env,app,secret}=await createGuestHarness("concurrent-replay");
    try{
      const path="/api/internal/project-alpha/delivery-intents",intent=guestIntent("guest-raced");
      const requests=await Promise.all([signedRequest(path,intent,secret),signedRequest(path,intent,secret)]);
      const responses=await Promise.all(requests.map(request=>app.fetch(request,env)));
      const bodies=await Promise.all(responses.map(response=>response.text()));
      expect(responses.map(response=>response.status),JSON.stringify(bodies)).toEqual([202,202]);
      expect(JSON.parse(bodies[0]!)).toEqual(JSON.parse(bodies[1]!));
      const original=(JSON.parse(bodies[0]!) as {receiptId:string}).receiptId;
      expect(await delivery.prepare("SELECT count(*) n FROM shares").first("n")).toBe(1);
      expect(await delivery.prepare("SELECT count(*) n FROM delivery_notifications").first("n")).toBe(1);
      const revoke={schemaVersion:1,applicationKey:"project-alpha",deliveryId:"guest-raced-revoke",
        occurredAt:new Date().toISOString(),receiptId:original,reasonCode:"project_alpha_delivery_revoked"};
      const revokeRequests=await Promise.all([signedRequest(`${path}/revoke`,revoke,secret),signedRequest(`${path}/revoke`,revoke,secret)]);
      const revoked=await Promise.all(revokeRequests.map(request=>app.fetch(request,env)));
      const revokedBodies=await Promise.all(revoked.map(response=>response.text()));
      expect(revoked.map(response=>response.status),JSON.stringify(revokedBodies)).toEqual([202,202]);
      expect(JSON.parse(revokedBodies[0]!)).toEqual(JSON.parse(revokedBodies[1]!));
      expect(await delivery.prepare("SELECT count(*) n FROM project_alpha_delivery_intent_revocation_receipts").first("n")).toBe(1);
      expect(await delivery.prepare("SELECT count(*) n FROM delivery_notifications WHERE kind='share_revoked'").first("n")).toBe(1);
    }finally{await mf.dispose();}
  },20_000);

  it("rolls back guest receipt, share and notifications when eligibility changes before commit",async()=>{
    const {mf,delivery,env,app,secret}=await createGuestHarness("guest-eligibility-race");
    try{
      env.DELIVERY_DB=beforeNextDeliveryBatch(delivery,async()=>{
        await delivery.prepare(`INSERT INTO portal_v2_identity_eligibility_blocks
          (id,match_type,normalized_email,status,valid_from) VALUES('raced-block','email','client@example.test','active',datetime('now','-1 hour'))`).run();
      });
      const response=await app.fetch(await signedRequest("/api/internal/project-alpha/delivery-intents",guestIntent("guest-blocked-at-commit"),secret),env);
      expect(response.status,await response.text()).toBe(409);
      for(const table of ["project_alpha_delivery_intent_receipts","shares","delivery_notifications","project_alpha_delivery_intent_audit"])
        expect(await delivery.prepare(`SELECT count(*) n FROM ${table}`).first("n"),table).toBe(0);
    }finally{await mf.dispose();}
  },20_000);

  it.each(["label","r2_prefix"] as const)("rejects a guest reuse whose %s changes after read without accepting or notifying",async(field)=>{
    const {mf,delivery,env,app,secret}=await createGuestHarness(`guest-reuse-race-${field}`);
    try{
      const path="/api/internal/project-alpha/delivery-intents",intent=guestIntent("guest-reuse-original");
      expect((await app.fetch(await signedRequest(path,intent,secret),env)).status).toBe(202);
      env.DELIVERY_DB=beforeNextDeliveryBatch(delivery,async()=>{
        await delivery.prepare(`UPDATE shares SET ${field}=?`).bind(field==="label"?"Changed by staff":"jobs/other-client/").run();
      });
      const response=await app.fetch(await signedRequest(path,{...intent,deliveryId:"guest-reuse-raced"},secret),env);
      expect(response.status,await response.text()).toBe(409);
      expect(await delivery.prepare("SELECT count(*) n FROM project_alpha_delivery_intent_receipts").first("n")).toBe(1);
      expect(await delivery.prepare("SELECT count(*) n FROM delivery_notifications").first("n")).toBe(1);
      expect(await delivery.prepare(`SELECT ${field} FROM shares`).first(field)).toBe(field==="label"?"Changed by staff":"jobs/other-client/");
    }finally{await mf.dispose();}
  },20_000);

  it("does not expire or replace a staff-owned link",async()=>{
    const {mf,delivery,env,app,secret}=await createGuestHarness("staff-expired-link");
    try{
      await delivery.prepare(`INSERT INTO shares(id,project_id,token_hash,created_by_type,created_by_id,r2_prefix,expires_at)
        VALUES('staff-expired','project-row','staff-token','staff','staff-one','jobs/client-one/project-one/',datetime('now','-1 day'))`).run();
      const before=await delivery.prepare("SELECT * FROM shares").all();
      const response=await app.fetch(await signedRequest("/api/internal/project-alpha/delivery-intents",guestIntent("guest-collides-staff"),secret),env);
      expect(response.status,await response.text()).toBe(409);
      expect((await delivery.prepare("SELECT * FROM shares").all()).results).toEqual(before.results);
      expect(await delivery.prepare("SELECT count(*) n FROM project_alpha_delivery_intent_receipts").first("n")).toBe(0);
      expect(await delivery.prepare("SELECT count(*) n FROM delivery_notifications").first("n")).toBe(0);
    }finally{await mf.dispose();}
  },20_000);

  it("never adopts a secondary source project merely because its folder matches",async()=>{
    const {mf,delivery,env,app,secret}=await createGuestHarness("secondary-project");
    try{
      await delivery.prepare("UPDATE projects SET project_alpha_source_id='project-alpha:secondary'").run();
      const response=await app.fetch(await signedRequest("/api/internal/project-alpha/delivery-intents",guestIntent("guest-wrong-project-source"),secret),env);
      expect(response.status,await response.text()).toBe(409);
      expect(await delivery.prepare("SELECT count(*) n FROM shares").first("n")).toBe(0);
      expect(await delivery.prepare("SELECT count(*) n FROM project_alpha_delivery_intent_receipts").first("n")).toBe(0);
    }finally{await mf.dispose();}
  },20_000);
  it("admits only the three exact signed POST paths", () => {
    expect(projectAlphaDeliveryMachineRequest("POST", "/api/internal/project-alpha/delivery-intents")).toBe(true);
    expect(projectAlphaDeliveryMachineRequest("POST", "/api/internal/project-alpha/delivery-intents/preflight")).toBe(true);
    expect(projectAlphaDeliveryMachineRequest("POST", "/api/internal/project-alpha/delivery-intents/revoke")).toBe(true);
    expect(projectAlphaDeliveryMachineRequest("GET", "/api/internal/project-alpha/delivery-intents")).toBe(false);
    expect(projectAlphaDeliveryMachineRequest("POST", "/api/internal/project-alpha/delivery-intents/extra")).toBe(false);
  });

  it("accepts machine requests only on the incoming host", () => {
    const now=Date.parse("2026-09-04T12:00:00.000Z");
    const env = { INCOMING_EXPECTED_HOST: "incoming.example.test", PROJECT_ALPHA_DELIVERY_DIRECT_COMPAT_ENABLED:"true",
      PROJECT_ALPHA_DELIVERY_DIRECT_COMPAT_UNTIL:"2026-09-11T12:00:00.000Z" };
    expect(projectAlphaDeliveryMachineHostRequest(
      "https://incoming.example.test/api/internal/project-alpha/delivery-intents", "POST", env,now,
    )).toBe(true);
    expect(projectAlphaDeliveryMachineHostRequest(
      "https://ops.example.test/api/internal/project-alpha/delivery-intents", "POST", env,now,
    )).toBe(false);
    expect(projectAlphaDeliveryMachineHostRequest(
      "https://incoming.example.test/api/internal/project-alpha/delivery-intents", "POST",
      { INCOMING_EXPECTED_HOST:"incoming.example.test" },now,
    )).toBe(false);
    expect(projectAlphaDeliveryMachineHostRequest(
      "https://incoming.example.test/api/internal/project-alpha/delivery-intents", "POST",
      {...env,PROJECT_ALPHA_DELIVERY_DIRECT_COMPAT_UNTIL:"2026-10-01T12:00:00.000Z"},now,
    )).toBe(false);
    expect(projectAlphaDeliveryMachineHostRequest(
      "https://incoming.example.test/api/internal/project-alpha/delivery-intents", "POST",env,
      Date.parse("2026-09-11T12:00:00.001Z"),
    )).toBe(false);
  });

  it("pins dedicated receipts, principal-only grants, lifecycle uniqueness and drained portal notifications", () => {
    const sql = readFileSync(new URL("../../client/migrations/0147_project_alpha_delivery_intents.sql", import.meta.url), "utf8");
    expect(sql).toContain("audience_type TEXT NOT NULL CHECK (audience_type='principal')");
    expect(sql).toContain("project_alpha_delivery_intent_revocation_receipts");
    expect(sql).toContain("project_alpha_delivery_portal_notification_outbox");
    expect(sql).not.toContain("project_alpha_delivery_guest_notification_outbox");
    expect(sql).toContain("folder_binding_id,binding_source_version,audience_public_id,audience_source_version");
  });

  it("applies and replays the dedicated bounded rate migration", () => {
    const db = new DatabaseSync(":memory:");
    const sql = readFileSync(new URL("../migrations/0031_project_alpha_delivery_intent_rate_limits.sql", import.meta.url), "utf8");
    db.exec(sql); db.exec(sql);
    db.prepare("INSERT INTO project_alpha_delivery_intent_rate_limits(scope,window_start,request_count) VALUES(?,?,?)")
      .run("preflight", "2026-08-18 14:00:00", 1);
    expect(db.prepare("SELECT request_count FROM project_alpha_delivery_intent_rate_limits").get())
      .toEqual({ request_count: 1 });
    expect(() => db.prepare("INSERT INTO project_alpha_delivery_intent_rate_limits(scope,window_start,request_count) VALUES('other','2026-08-18',1)").run()).toThrow();
    db.close();
  });

  it("adds registered-source quotas without rewriting the legacy limiter",()=>{
    const db=new DatabaseSync(":memory:");
    db.exec(readFileSync(new URL("../migrations/0031_project_alpha_delivery_intent_rate_limits.sql",import.meta.url),"utf8"));
    db.prepare("INSERT INTO project_alpha_delivery_intent_rate_limits(scope,window_start,request_count) VALUES(?,?,?)")
      .run("intent","2026-08-31T12:00:00Z",7);
    db.exec(readFileSync(new URL("../migrations/0049_project_alpha_delivery_source_rate_limits.sql",import.meta.url),"utf8"));
    expect(db.prepare("SELECT scope,window_start,request_count FROM project_alpha_delivery_intent_rate_limits").all())
      .toEqual([{scope:"intent",window_start:"2026-08-31T12:00:00Z",request_count:7}]);
    db.prepare("INSERT INTO project_alpha_delivery_intent_rate_limits(scope,window_start,request_count) VALUES(?,?,?)")
      .run("preflight","2026-08-31T12:01:00Z",1);
    db.prepare("INSERT INTO project_alpha_delivery_intent_source_rate_limits(source_id,scope,window_start,request_count) VALUES(?,?,?,?)")
      .run("project-alpha:secondary","intent","2026-08-31T12:00:00Z",1);
    expect(db.prepare("SELECT source_id FROM project_alpha_delivery_intent_source_rate_limits").all())
      .toEqual([{source_id:"project-alpha:secondary"}]);
    expect(()=>db.prepare("INSERT INTO project_alpha_delivery_intent_source_rate_limits(source_id,scope,window_start,request_count) VALUES('other','intent','later',1)").run()).toThrow();
    expect(()=>db.prepare("INSERT INTO project_alpha_delivery_intent_source_rate_limits(source_id,scope,window_start,request_count) VALUES('project-alpha:secondary','other','later',1)").run()).toThrow();
    db.close();
  });

  it("prunes only expired Project Alpha delivery rate windows", async () => {
    const mf=new Miniflare({compatibilityDate:"2026-08-06",modules:true,
      script:"export default {fetch(){return new Response('ok')}}",d1Databases:{OPS_DB:"pa-rate-prune"}});
    try{
      const ops=await mf.getD1Database("OPS_DB") as unknown as D1Database;
      await applyRateMigrations(ops);
      await ops.prepare("INSERT INTO project_alpha_delivery_intent_rate_limits VALUES('intent',datetime('now','-20 minutes'),2)").run();
      await ops.prepare("INSERT INTO project_alpha_delivery_intent_rate_limits VALUES('preflight',strftime('%Y-%m-%dT%H:%M:00Z','now'),1)").run();
      await ops.prepare("INSERT INTO project_alpha_delivery_intent_source_rate_limits VALUES('project-alpha:secondary','intent',datetime('now','-20 minutes'),2)").run();
      await ops.prepare("INSERT INTO project_alpha_delivery_intent_source_rate_limits VALUES('project-alpha:secondary','preflight',strftime('%Y-%m-%dT%H:%M:00Z','now'),1)").run();
      expect(await pruneProjectAlphaDeliveryIntentRateLimits({OPS_DB:ops})).toBe(2);
      expect(await ops.prepare("SELECT scope FROM project_alpha_delivery_intent_rate_limits").first<string>("scope")).toBe("preflight");
      expect(await ops.prepare("SELECT scope FROM project_alpha_delivery_intent_source_rate_limits").first<string>("scope")).toBe("preflight");
    }finally{await mf.dispose();}
  });

  it("pins the canonical cross-repository wire fixture byte-for-byte",()=>{
    const bytes=readFileSync(new URL("../../../packages/shared/fixtures/project-alpha-delivery-intent-v1.json",import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("f16d540bcfbcf4c77c356fc37e2c046a23a473ebec701d526e3b8d45f38c90e8");
    const fixture=JSON.parse(bytes.toString("utf8"));
    expect(fixture.applicationKey).toBe("project-alpha");expect(fixture.keyId).toBe("ops-v1");
    for(const item of Object.values(fixture.cases) as Array<any>){
      expect(createHash("sha256").update(item.body).digest("hex")).toBe(item.bodySha256);
      expect(item.canonical).toContain(`\n${item.path}\n`);
      expect(item.signature).toMatch(/^sha256=[a-f0-9]{64}$/);
    }
    expect(JSON.parse(fixture.acceptedResponse)).toEqual({receiptId:"receipt_01",status:"accepted"});
  });

  it("authenticates preflight while the mutation flag is off and performs no Delivery-D1 access", async()=>{
    const mf=new Miniflare({compatibilityDate:"2026-08-06",modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:{OPS_DB:"pa-preflight"}});
    try{
      const ops=await mf.getD1Database("OPS_DB") as unknown as D1Database;
      await applyMigration(ops,new URL("../migrations/0031_project_alpha_delivery_intent_rate_limits.sql",import.meta.url));
      const delivery={prepare(){throw new Error("preflight touched Delivery D1")}} as unknown as D1Database;
      const env={OPS_DB:ops,DELIVERY_DB:delivery,PROJECT_ALPHA_PORTAL_APPLICATION_KEY:"project-alpha",
        PROJECT_ALPHA_PORTAL_HMAC_KEY_ID:"ops-v1",PROJECT_ALPHA_PORTAL_HMAC_SECRET:"0123456789abcdef0123456789abcdef",
        PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED:"false",PROJECT_ALPHA_DELIVERY_GUEST_ENABLED:"true",
        CLIENT_PORTAL_HIERARCHY_V2_ENABLED:"true",AUTHENTICATED_DELIVERY_GRANTS_ENABLED:"true"} as unknown as Env;
      const app=new Hono<{Bindings:Env}>();app.post("/api/internal/project-alpha/delivery-intents/preflight",handleProjectAlphaDeliveryPreflight);
      const response=await app.fetch(await signedPreflight(env.PROJECT_ALPHA_PORTAL_HMAC_SECRET!),env);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({status:"ready",schemaVersion:1,integrationEnabled:false,portalSupported:true,guestSupported:true,revocationSupported:true});
    }finally{await mf.dispose();}
  });

  it("rejects a tampered preflight signature",async()=>{
    const mf=new Miniflare({compatibilityDate:"2026-08-06",modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:{OPS_DB:"pa-auth"}});
    try{const ops=await mf.getD1Database("OPS_DB") as unknown as D1Database;await applyRateMigrations(ops);
      const env={OPS_DB:ops,PROJECT_ALPHA_PORTAL_APPLICATION_KEY:"project-alpha",PROJECT_ALPHA_PORTAL_HMAC_KEY_ID:"ops-v1",PROJECT_ALPHA_PORTAL_HMAC_SECRET:"0123456789abcdef0123456789abcdef"} as unknown as Env;
      const app=new Hono<{Bindings:Env}>();app.post("/api/internal/project-alpha/delivery-intents/preflight",handleProjectAlphaDeliveryPreflight);
      expect((await app.fetch(await signedPreflight(env.PROJECT_ALPHA_PORTAL_HMAC_SECRET!,{"X-Portal-Integration-Signature":`sha256=${"0".repeat(64)}`}),env)).status).toBe(401);
    }finally{await mf.dispose();}
  });

  it("creates, replays, conflicts, and revokes a real principal-only portal grant",async()=>{
    const mf=new Miniflare({compatibilityDate:"2026-08-06",modules:true,script:"export default {fetch(){return new Response('ok')}}",
      d1Databases:{OPS_DB:"pa-portal-ops",DELIVERY_DB:"pa-portal-delivery"}});
    try{
      const ops=await mf.getD1Database("OPS_DB") as unknown as D1Database;
      const delivery=await mf.getD1Database("DELIVERY_DB") as unknown as D1Database;
      await applyRateMigrations(ops);
      await runSqlStatements(delivery,`
        CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,status TEXT,project_alpha_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
        CREATE TABLE portal_v2_folder_bindings(id TEXT PRIMARY KEY,workspace_id TEXT,owner_scope_type TEXT,owner_public_id TEXT,r2_prefix TEXT,source_version TEXT,status TEXT,revoked_at TEXT);
        CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT PRIMARY KEY,active_generation_id TEXT);
        CREATE TABLE portal_v2_directory_generations(id TEXT PRIMARY KEY,workspace_id TEXT,status TEXT,complete INTEGER);
        CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,parent_public_id TEXT,display_name TEXT,source_version TEXT,active INTEGER);
        CREATE TABLE pa_portal_principals(workspace_id TEXT,public_id TEXT,identity_id TEXT,email_hint TEXT,display_name TEXT,source_version TEXT,status TEXT);
        CREATE TABLE portal_v2_identities(id TEXT,issuer TEXT,subject TEXT,verified_email TEXT,status TEXT,revoked_at TEXT);
        CREATE TABLE portal_v2_identity_eligibility_bindings(identity_id TEXT,workspace_id TEXT,principal_public_id TEXT,principal_source_version TEXT,verified_email TEXT);
        CREATE TABLE portal_v2_workspace_memberships(workspace_id TEXT,identity_id TEXT,status TEXT,revoked_at TEXT,expires_at TEXT);
        CREATE TABLE portal_v2_identity_eligibility_blocks(id TEXT,match_type TEXT,issuer TEXT,subject TEXT,normalized_email TEXT,status TEXT,valid_from TEXT,expires_at TEXT);
        CREATE TABLE portal_v2_identity_denials(identity_id TEXT,status TEXT,revoked_at TEXT,valid_from TEXT,expires_at TEXT,scope_type TEXT,workspace_id TEXT,scope_public_id TEXT);
        CREATE TABLE project_alpha_delivery_intent_receipts(receipt_id TEXT PRIMARY KEY,delivery_id TEXT,request_fingerprint TEXT,access_mode TEXT,resource_id TEXT,status TEXT DEFAULT 'accepted',created_at TEXT DEFAULT(datetime('now')),project_alpha_source_id TEXT NOT NULL,write_guard INTEGER NOT NULL DEFAULT 1 CHECK(write_guard=1),UNIQUE(project_alpha_source_id,delivery_id));
        CREATE TABLE project_alpha_delivery_portal_grants(id TEXT PRIMARY KEY,receipt_id TEXT,workspace_id TEXT,folder_binding_id TEXT,binding_source_version TEXT,audience_type TEXT,audience_public_id TEXT,audience_source_version TEXT,grant_version INTEGER DEFAULT 1,status TEXT DEFAULT 'active',expires_at TEXT,label TEXT,actor_kind TEXT DEFAULT 'project_alpha_delivery',actor_id TEXT,revoked_at TEXT,revoke_reason_code TEXT,created_at TEXT DEFAULT(datetime('now')));
        CREATE TABLE project_alpha_delivery_intent_audit(id TEXT PRIMARY KEY,receipt_id TEXT,action TEXT,actor_kind TEXT DEFAULT 'project_alpha_delivery',actor_id TEXT,details_json TEXT,created_at TEXT DEFAULT(datetime('now')));
        CREATE TABLE project_alpha_delivery_portal_notification_outbox(id TEXT PRIMARY KEY,receipt_id TEXT,grant_id TEXT,principal_public_id TEXT,principal_source_version TEXT,event_type TEXT,status TEXT DEFAULT 'pending',attempt_count INTEGER DEFAULT 0,next_attempt_at TEXT DEFAULT(datetime('now')),lease_expires_at TEXT,last_error TEXT,delivered_at TEXT,created_at TEXT DEFAULT(datetime('now')),updated_at TEXT DEFAULT(datetime('now')));
        CREATE TABLE project_alpha_delivery_intent_revocation_receipts(receipt_id TEXT PRIMARY KEY,delivery_id TEXT,original_receipt_id TEXT,request_fingerprint TEXT,created_at TEXT DEFAULT(datetime('now')),project_alpha_source_id TEXT NOT NULL,write_guard INTEGER NOT NULL DEFAULT 1 CHECK(write_guard=1),UNIQUE(project_alpha_source_id,delivery_id));
        INSERT INTO portal_v2_workspaces(id,status) VALUES('workspace-one','active');
        INSERT INTO portal_v2_folder_bindings VALUES('binding-one','workspace-one','project','project-one','client/project/','binding-v1','active',NULL);
        INSERT INTO portal_v2_directory_checkpoints VALUES('workspace-one','generation-one');
        INSERT INTO portal_v2_directory_generations VALUES('generation-one','workspace-one','active',1);
        INSERT INTO portal_v2_directory_entities VALUES('workspace-one','generation-one','project','project-one',NULL,'Project One','binding-v1',1);
        INSERT INTO pa_portal_principals VALUES('workspace-one','principal-one',NULL,'Client@Example.test','Client','principal-v1','active');`);
      const secret="0123456789abcdef0123456789abcdef";
      const env={OPS_DB:ops,DELIVERY_DB:delivery,PROJECT_ALPHA_PORTAL_APPLICATION_KEY:"project-alpha",PROJECT_ALPHA_PORTAL_HMAC_KEY_ID:"ops-v1",
        PROJECT_ALPHA_PORTAL_HMAC_SECRET:secret,PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED:"true",PROJECT_ALPHA_DELIVERY_GUEST_ENABLED:"false",
        CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED:"true",CLIENT_PORTAL_HIERARCHY_V2_ENABLED:"true",
        CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:"true",CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED:"true",
        AUTHENTICATED_DELIVERY_GRANTS_ENABLED:"true",DELIVERY_BASE_URL:"https://client.example.test",PUBLIC_SHARE_ORIGIN:"https://delivery.example.test"} as unknown as Env;
      const app=new Hono<{Bindings:Env}>();
      app.post("/api/internal/project-alpha/delivery-intents",handleProjectAlphaDeliveryIntent);
      app.post("/api/internal/project-alpha/delivery-intents/revoke",handleProjectAlphaDeliveryIntentRevoke);
      const base={schemaVersion:1,applicationKey:"project-alpha",deliveryId:"portal-delivery-one",occurredAt:"2026-08-18T14:00:00.000Z",
        scope:{type:"project",publicId:"project-one"},audience:{type:"principal",publicId:"principal-one"},accessMode:"portal",expiresAt:null,label:null,notify:true};
      const created=await app.fetch(await signedRequest("/api/internal/project-alpha/delivery-intents",base,secret),env);
      const createdText=await created.text();expect(created.status,createdText).toBe(202);const receipt=(JSON.parse(createdText) as {receiptId:string}).receiptId;
      const replay=await app.fetch(await signedRequest("/api/internal/project-alpha/delivery-intents",base,secret),env);
      expect(replay.status).toBe(202);expect((await replay.json() as {receiptId:string}).receiptId).toBe(receipt);
      expect(await delivery.prepare("SELECT COUNT(*) count FROM project_alpha_delivery_portal_grants").first<number>("count")).toBe(1);
      expect(await delivery.prepare("SELECT COUNT(*) count FROM project_alpha_delivery_portal_notification_outbox").first<number>("count")).toBe(1);
      const changed={...base,label:"changed"};
      expect((await app.fetch(await signedRequest("/api/internal/project-alpha/delivery-intents",changed,secret),env)).status).toBe(409);
      const revoke={schemaVersion:1,applicationKey:"project-alpha",deliveryId:"portal-revoke-one",occurredAt:"2026-08-18T14:00:00.000Z",receiptId:receipt,reasonCode:"project_alpha_delivery_revoked"};
      expect((await app.fetch(await signedRequest("/api/internal/project-alpha/delivery-intents/revoke",revoke,secret),env)).status).toBe(202);
      expect((await app.fetch(await signedRequest("/api/internal/project-alpha/delivery-intents/revoke",{...revoke,deliveryId:"portal-revoke-two"},secret),env)).status).toBe(409);
    }finally{await mf.dispose();}
  });

  it.each(["portal", "guest"] as const)("keeps %s intents on primary native authority despite colliding secondary IDs and paths", async accessMode => {
    const { mf, delivery, env, app, secret } = await createGuestHarness(`source-${accessMode}`);
    try {
      await runSqlStatements(delivery, `
        INSERT INTO portal_v2_workspaces(id,status,project_alpha_source_id)
          VALUES('secondary-workspace','active','project-alpha:secondary');
        INSERT INTO portal_v2_folder_bindings
          VALUES('secondary-binding','secondary-workspace','project','project-one','jobs/client-one/project-one/','binding-v1','active',NULL);
        INSERT INTO portal_v2_directory_checkpoints VALUES('secondary-workspace','secondary-generation');
        INSERT INTO portal_v2_directory_generations VALUES('secondary-generation','secondary-workspace','active',1);
        INSERT INTO portal_v2_directory_entities
          VALUES('secondary-workspace','secondary-generation','project','project-one',NULL,'Other project','binding-v1',1);
        INSERT INTO pa_portal_principals
          VALUES('secondary-workspace','principal-one',NULL,'other-source@example.test','Other person','principal-v1','active');
      `);
      const path = "/api/internal/project-alpha/delivery-intents";
      const intent = { schemaVersion: 1, applicationKey: "project-alpha", deliveryId: crypto.randomUUID(),
        occurredAt: new Date().toISOString(), scope: { type: "project", publicId: "project-one" },
        audience: { type: "principal", publicId: "principal-one" }, accessMode,
        expiresAt: accessMode === "guest" ? new Date(Date.now() + 86400000).toISOString() : null,
        label: null, notify: true };
      const accepted = await app.fetch(await signedRequest(path, intent, secret), env);
      expect(accepted.status).toBe(202);
      const authorityTable = accessMode === "guest" ? "project_alpha_delivery_guest_authority" : "project_alpha_delivery_portal_grants";
      expect((await delivery.prepare(`SELECT workspace_id,folder_binding_id FROM ${authorityTable}`).all()).results)
        .toEqual([{ workspace_id: "workspace-one", folder_binding_id: "binding-one" }]);
      const before = await delivery.prepare("SELECT count(*) count FROM project_alpha_delivery_intent_receipts").first("count");
      await delivery.prepare("UPDATE portal_v2_folder_bindings SET status='suspended' WHERE id='binding-one'").run();
      const denied = await app.fetch(await signedRequest(path, { ...intent, deliveryId: crypto.randomUUID() }, secret), env);
      expect(denied.status).toBe(409);
      expect(await delivery.prepare("SELECT count(*) count FROM project_alpha_delivery_intent_receipts").first("count")).toBe(before);
      expect(await delivery.prepare(`SELECT count(*) count FROM ${authorityTable} WHERE workspace_id='secondary-workspace'`).first("count")).toBe(0);
    } finally { await mf.dispose(); }
  });

  it("creates, replays, conflicts, and revokes a real guest share with pinned authority",async()=>{
    const {mf,delivery,env,app,secret}=await createGuestHarness("lifecycle");
    try{
      const occurredAt=new Date().toISOString(),expiresAt=new Date(Date.now()+30*24*60*60*1000).toISOString();
      const base={schemaVersion:1,applicationKey:"project-alpha",deliveryId:"guest-delivery-one",occurredAt,
        scope:{type:"project",publicId:"project-one"},audience:{type:"principal",publicId:"principal-one"},
        accessMode:"guest",expiresAt,label:"Johnson Road",notify:true};
      const created=await app.fetch(await signedRequest("/api/internal/project-alpha/delivery-intents",base,secret),env);
      const createdText=await created.text();
      expect(created.status,createdText).toBe(202);
      const receiptId=(JSON.parse(createdText) as {receiptId:string}).receiptId;

      const replay=await app.fetch(await signedRequest("/api/internal/project-alpha/delivery-intents",base,secret),env);
      expect(replay.status).toBe(202);
      expect((await replay.json() as {receiptId:string}).receiptId).toBe(receiptId);
      expect((await app.fetch(await signedRequest("/api/internal/project-alpha/delivery-intents",{...base,label:"Changed"},secret),env)).status).toBe(409);

      const receipt=await delivery.prepare(`SELECT access_mode,resource_id FROM project_alpha_delivery_intent_receipts WHERE receipt_id=?`)
        .bind(receiptId).first<{access_mode:string;resource_id:string}>();
      expect(receipt?.access_mode).toBe("guest");
      const share=await delivery.prepare(`SELECT created_by_type,label,expires_at,revoked_at FROM shares WHERE id=?`)
        .bind(receipt!.resource_id).first<{created_by_type:string;label:string;expires_at:string;revoked_at:string|null}>();
      expect(share).toEqual({created_by_type:"integration",label:"Johnson Road",expires_at:expiresAt,revoked_at:null});
      expect(await delivery.prepare(`SELECT workspace_id,folder_binding_id,binding_source_version,directory_generation_id,
        principal_public_id,principal_source_version,label,status FROM project_alpha_delivery_guest_authority WHERE share_id=?`)
        .bind(receipt!.resource_id).first()).toEqual({workspace_id:"workspace-one",folder_binding_id:"binding-one",
          binding_source_version:"binding-v1",directory_generation_id:"generation-one",principal_public_id:"principal-one",
          principal_source_version:"principal-v1",label:"Johnson Road",status:"active"});
      expect(await delivery.prepare("SELECT COUNT(*) count FROM delivery_notifications WHERE kind='share_created'").first<number>("count")).toBe(1);

      const revoke={schemaVersion:1,applicationKey:"project-alpha",deliveryId:"guest-revoke-one",occurredAt,
        receiptId,reasonCode:"project_alpha_delivery_revoked"};
      const revoked=await app.fetch(await signedRequest("/api/internal/project-alpha/delivery-intents/revoke",revoke,secret),env);
      const revokedText=await revoked.text();
      expect(revoked.status,revokedText).toBe(202);
      const revokeReceiptId=(JSON.parse(revokedText) as {receiptId:string}).receiptId;
      const revokeReplay=await app.fetch(await signedRequest("/api/internal/project-alpha/delivery-intents/revoke",revoke,secret),env);
      expect(revokeReplay.status).toBe(202);
      expect((await revokeReplay.json() as {receiptId:string}).receiptId).toBe(revokeReceiptId);
      const secondKey={...revoke,deliveryId:"guest-revoke-two"};
      expect((await app.fetch(await signedRequest("/api/internal/project-alpha/delivery-intents/revoke",secondKey,secret),env)).status).toBe(409);
      expect(await delivery.prepare("SELECT revoked_reason FROM shares WHERE id=?").bind(receipt!.resource_id).first("revoked_reason"))
        .toBe("project_alpha_delivery_revoked");
      expect(await delivery.prepare("SELECT status FROM project_alpha_delivery_guest_authority WHERE share_id=?").bind(receipt!.resource_id).first("status"))
        .toBe("revoked");
      expect(await delivery.prepare("SELECT COUNT(*) count FROM project_alpha_delivery_intent_revocation_receipts").first<number>("count")).toBe(1);
    }finally{await mf.dispose();}
  },15_000);

  it("suppresses a queued guest bearer link when the share is revoked before notification drain",async()=>{
    const {mf,delivery,env,app,secret}=await createGuestHarness("revoke-notification");
    try{
      const occurredAt=new Date().toISOString(),expiresAt=new Date(Date.now()+30*24*60*60*1000).toISOString();
      const intent={schemaVersion:1,applicationKey:"project-alpha",deliveryId:"guest-notify-one",occurredAt,
        scope:{type:"project",publicId:"project-one"},audience:{type:"principal",publicId:"principal-one"},
        accessMode:"guest",expiresAt,label:null,notify:true};
      const created=await app.fetch(await signedRequest("/api/internal/project-alpha/delivery-intents",intent,secret),env);
      expect(created.status).toBe(202);
      const receiptId=(await created.json() as {receiptId:string}).receiptId;
      const revoke={schemaVersion:1,applicationKey:"project-alpha",deliveryId:"guest-notify-revoke",occurredAt,
        receiptId,reasonCode:"project_alpha_delivery_revoked"};
      expect((await app.fetch(await signedRequest("/api/internal/project-alpha/delivery-intents/revoke",revoke,secret),env)).status).toBe(202);

      const sent:Array<Record<string,unknown>>=[];
      env.NOTIFICATION_EMAIL={send:async (message:unknown)=>{sent.push(message as Record<string,unknown>);}} as unknown as SendEmail;
      expect(await processDeliveryNotifications(env)).toBe(2);
      expect(sent).toHaveLength(1);
      expect(JSON.stringify(sent[0])).toContain("Delivery access revoked");
      expect(JSON.stringify(sent[0])).not.toContain("/s/");
      expect(await delivery.prepare("SELECT status FROM delivery_notifications WHERE kind='share_created'").first("status")).toBe("failed");
      expect(await delivery.prepare("SELECT status FROM delivery_notifications WHERE kind='share_revoked'").first("status")).toBe("sent");
    }finally{await mf.dispose();}
  },15_000);

  it("suppresses a queued guest bearer link after the authoritative directory generation rolls over",async()=>{
    const {mf,delivery,env,app,secret}=await createGuestHarness("source-rollover");
    try{
      const occurredAt=new Date().toISOString(),expiresAt=new Date(Date.now()+30*24*60*60*1000).toISOString();
      const intent={schemaVersion:1,applicationKey:"project-alpha",deliveryId:"guest-source-one",occurredAt,
        scope:{type:"project",publicId:"project-one"},audience:{type:"principal",publicId:"principal-one"},
        accessMode:"guest",expiresAt,label:null,notify:true};
      expect((await app.fetch(await signedRequest("/api/internal/project-alpha/delivery-intents",intent,secret),env)).status).toBe(202);
      await delivery.exec(`
        INSERT INTO portal_v2_directory_generations VALUES('generation-two','workspace-one','active',1);
        INSERT INTO portal_v2_directory_entities VALUES('workspace-one','generation-two','project','project-one',NULL,'Project One','binding-v2',1);
        UPDATE portal_v2_directory_checkpoints SET active_generation_id='generation-two' WHERE workspace_id='workspace-one';
      `);
      const sent:Array<Record<string,unknown>>=[];
      env.NOTIFICATION_EMAIL={send:async (message:unknown)=>{sent.push(message as Record<string,unknown>);}} as unknown as SendEmail;
      expect(await processDeliveryNotifications(env)).toBe(1);
      expect(sent).toHaveLength(0);
      expect(await delivery.prepare("SELECT status FROM delivery_notifications WHERE kind='share_created'").first("status")).toBe("failed");
    }finally{await mf.dispose();}
  },15_000);

  it("suppresses a queued guest bearer link when the recipient is blacklisted before drain",async()=>{
    const {mf,delivery,env,app,secret}=await createGuestHarness("recipient-blacklist");
    try{
      const occurredAt=new Date().toISOString(),expiresAt=new Date(Date.now()+30*24*60*60*1000).toISOString();
      const intent={schemaVersion:1,applicationKey:"project-alpha",deliveryId:"guest-blacklist-one",occurredAt,
        scope:{type:"project",publicId:"project-one"},audience:{type:"principal",publicId:"principal-one"},
        accessMode:"guest",expiresAt,label:null,notify:true};
      expect((await app.fetch(await signedRequest("/api/internal/project-alpha/delivery-intents",intent,secret),env)).status).toBe(202);
      await delivery.prepare(`INSERT INTO portal_v2_identity_eligibility_blocks
        (id,match_type,normalized_email,status,valid_from) VALUES('block-one','email','client@example.test','active',datetime('now','-1 hour'))`).run();
      const sent:Array<Record<string,unknown>>=[];
      env.NOTIFICATION_EMAIL={send:async (message:unknown)=>{sent.push(message as Record<string,unknown>);}} as unknown as SendEmail;
      expect(await processDeliveryNotifications(env)).toBe(1);
      expect(sent).toHaveLength(0);
      expect(await delivery.prepare("SELECT status FROM delivery_notifications WHERE kind='share_created'").first("status")).toBe("failed");
    }finally{await mf.dispose();}
  },15_000);
});
