import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { Hono } from "hono";
import { createCatalogSourceContext, PRIMARY_CATALOG_SOURCE } from "@ltds/shared";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { applyProjectAlphaDeliveryIntent, applyProjectAlphaDeliveryIntentRevoke, handleProjectAlphaDeliveryIntent } from "../src/worker/project-alpha-delivery-intents";
import type { Env } from "../src/worker/types";

const secondary = createCatalogSourceContext("project-alpha:secondary");
const secret = "source-runtime-secret-at-least-thirty-two-bytes";
const path = "/api/internal/project-alpha/delivery-intents";
const auth = (payload: { deliveryId: string }) => ({ deliveryId: payload.deliveryId, fingerprint: createHash("sha256").update(JSON.stringify(payload)).digest("hex") });

function interleaveBeforeBatch(database: D1Database, action: () => Promise<unknown>): D1Database {
  let invoked = false;
  let proxy: D1Database;
  proxy = new Proxy(database, { get(target, property) {
    if (property === "withSession") return () => proxy;
    if (property === "batch") return async (statements: D1PreparedStatement[]) => {
      if (!invoked) { invoked = true; await action(); }
      return target.batch(statements);
    };
    const value = target[property as keyof D1Database];
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return proxy;
}

describe("source-owned delivery intent runtime and transaction races", () => {
  let runtime: Miniflare;
  let database: D1Database;
  let env: Env;
  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-07-22", modules: true, script: "export default {fetch(){return new Response('ok')}}", d1Databases: { DELIVERY_DB: "intent-source-runtime" } });
    database = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const directory = new URL("../../client/migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(value => /^\d+.*\.sql$/.test(value)).sort()) {
      await database.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => database.prepare(sql)));
    }
    await database.prepare("CREATE TABLE project_alpha_delivery_intent_rate_limits(scope TEXT,window_start TEXT,request_count INTEGER,PRIMARY KEY(scope,window_start))").run();
    env = { DELIVERY_DB: database, OPS_DB: database, PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED: "true", PROJECT_ALPHA_PORTAL_APPLICATION_KEY: "project-alpha",
      PROJECT_ALPHA_PORTAL_HMAC_KEY_ID: "ops-v1", PROJECT_ALPHA_PORTAL_HMAC_SECRET: secret, CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      AUTHENTICATED_DELIVERY_GRANTS_ENABLED: "true", CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED: "true" } as Env;
  }, 120_000);
  afterAll(async () => { await runtime?.dispose(); });

  async function fixture(name: string, guestProjects = false) {
    const workspace = `${name}-workspace`, otherWorkspace = `${name}-workspace-b`, owner = `${name}-project`, principal = `${name}-principal`;
    for (const [local, source] of [[workspace, PRIMARY_CATALOG_SOURCE], [otherWorkspace, secondary]] as const) {
      const prefix = guestProjects ? `delivery/${name}/${local}/` : `delivery/${name}/folder/`;
      await database.batch([
        database.prepare("INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id) VALUES(?,?,?)").bind(local,source.sourceId,workspace),
        database.prepare("INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,project_alpha_source_id) VALUES(?,'organization',?,?,?)").bind(local,`${name}-organization`,name,source.sourceId),
        database.prepare("INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete) VALUES(?,?,?,1,'active',1)").bind(`${local}-generation`,local,"source-generation"),
        database.prepare("INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version) VALUES(?,?,'organization',?,NULL,'Organization','owner-v1')").bind(local,`${local}-generation`,`${name}-organization`),
        database.prepare("INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version) VALUES(?,?,'project',?,?,'Project','owner-v1')").bind(local,`${local}-generation`,owner,`${name}-organization`),
        database.prepare("INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)").bind(local,`${local}-generation`),
        database.prepare("INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version) VALUES(?,?,'project',?,?,'project_alpha','owner-v1')").bind(`${local}-binding`,local,owner,prefix),
        database.prepare("INSERT INTO pa_portal_principals(workspace_id,public_id,email_hint,display_name,source_version,status) VALUES(?,?,?,'Recipient','principal-v1','active')").bind(local,principal,`${name}@example.test`),
        ...(guestProjects ? [database.prepare("INSERT INTO projects(id,client_name,project_name,r2_prefix,project_alpha_project_id,project_alpha_source_id) VALUES(?,'Source fixture','Guest project',?,?,?)")
          .bind(`${local}-delivery-project`,prefix,owner,source.sourceId)] : []),
      ]);
    }
    const payload = { schemaVersion: 1, applicationKey: "project-alpha", deliveryId: `${name}-delivery`, occurredAt: "2026-08-26T12:00:00.000Z",
      scope: { type: "project", publicId: owner }, audience: { type: "principal", publicId: principal }, accessMode: "portal", expiresAt: null, label: null, notify: true };
    return { workspace, otherWorkspace, owner, principal, payload };
  }
  function create<T extends { deliveryId: string }>(payload: T, source = PRIMARY_CATALOG_SOURCE, environment = env) {
    return applyProjectAlphaDeliveryIntent(environment,payload,auth(payload),source);
  }
  function revokePayload(deliveryId: string, receiptId: string) { return { schemaVersion: 1, applicationKey: "project-alpha", deliveryId, occurredAt: "2026-08-26T12:00:00.000Z", receiptId, reasonCode: "project_alpha_delivery_revoked" }; }
  function revoke(payload: ReturnType<typeof revokePayload>, source = PRIMARY_CATALOG_SOURCE, environment = env) { return applyProjectAlphaDeliveryIntentRevoke(environment,payload,auth(payload),source); }

  it("accepts colliding producer delivery IDs independently and rejects cross-source original receipts", async () => {
    const f = await fixture("collision"), a = await create(f.payload), b = await create(f.payload,secondary);
    expect(a.receiptId).not.toBe(b.receiptId);
    expect(await create(f.payload)).toEqual(a); expect(await create(f.payload,secondary)).toEqual(b);
    const rows = (await database.prepare("SELECT receipt.project_alpha_source_id,grant_record.workspace_id FROM project_alpha_delivery_intent_receipts receipt JOIN project_alpha_delivery_portal_grants grant_record ON grant_record.id=receipt.resource_id WHERE receipt.delivery_id=? ORDER BY receipt.project_alpha_source_id").bind(f.payload.deliveryId).all()).results;
    expect(rows).toEqual([{project_alpha_source_id:PRIMARY_CATALOG_SOURCE.sourceId,workspace_id:f.workspace},{project_alpha_source_id:secondary.sourceId,workspace_id:f.otherWorkspace}]);
    await expect(revoke(revokePayload("cross-source-revoke",a.receiptId),secondary)).rejects.toMatchObject({status:404});
    const revokedA=await revoke(revokePayload("same-revoke-delivery",a.receiptId)),revokedB=await revoke(revokePayload("same-revoke-delivery",b.receiptId),secondary);
    expect(revokedA.receiptId).not.toBe(revokedB.receiptId);
    expect(await revoke(revokePayload("same-revoke-delivery",a.receiptId))).toEqual(revokedA);
  }, 60_000);

  it("creates distinct owned guest shares for equal producer delivery IDs and keeps retries and revocations source-bound", async () => {
    const f=await fixture("guest-collision",true);
    const guestEnv={...env,PROJECT_ALPHA_DELIVERY_GUEST_ENABLED:"true",DELIVERY_BASE_URL:"https://delivery.example.test",DELIVERY_TOKEN_SECRET:secret};
    const payload={...f.payload,accessMode:"guest"};
    const a=await create(payload,PRIMARY_CATALOG_SOURCE,guestEnv),b=await create(payload,secondary,guestEnv);
    expect(a.receiptId).not.toBe(b.receiptId);
    const state=async()=>(await database.prepare(`SELECT receipt.receipt_id,receipt.project_alpha_source_id,share.*,
      authority.workspace_id,authority.status authority_status
      FROM project_alpha_delivery_intent_receipts receipt JOIN shares share ON share.id=receipt.resource_id
      JOIN project_alpha_delivery_guest_authority authority ON authority.share_id=share.id
      WHERE receipt.delivery_id=? ORDER BY receipt.project_alpha_source_id`).bind(payload.deliveryId).all()).results;
    const before=await state();expect(before).toHaveLength(2);
    expect(before[0]).toMatchObject({receipt_id:a.receiptId,project_alpha_source_id:PRIMARY_CATALOG_SOURCE.sourceId,workspace_id:f.workspace,project_id:`${f.workspace}-delivery-project`,revoked_at:null});
    expect(before[1]).toMatchObject({receipt_id:b.receiptId,project_alpha_source_id:secondary.sourceId,workspace_id:f.otherWorkspace,project_id:`${f.otherWorkspace}-delivery-project`,revoked_at:null});
    expect(before[0]!.id).not.toBe(before[1]!.id);expect(before[0]!.r2_prefix).not.toBe(before[1]!.r2_prefix);
    expect(await create(payload,PRIMARY_CATALOG_SOURCE,guestEnv)).toEqual(a);
    expect(await create(payload,secondary,guestEnv)).toEqual(b);
    expect(await state()).toEqual(before);
    await expect(revoke(revokePayload("guest-cross-source-revoke",a.receiptId),secondary,guestEnv)).rejects.toMatchObject({status:404});
    expect(await state()).toEqual(before);
    const undoB=revokePayload("guest-shared-revoke",b.receiptId),revokedB=await revoke(undoB,secondary,guestEnv);
    expect(await revoke(undoB,secondary,guestEnv)).toEqual(revokedB);
    const afterB=await state();expect(afterB[0]).toEqual(before[0]);
    expect(afterB[1]).toMatchObject({authority_status:"revoked",revoked_reason:"project_alpha_delivery_revoked"});
    expect(afterB[1]!.revoked_at).not.toBeNull();
    const undoA=revokePayload("guest-shared-revoke",a.receiptId),revokedA=await revoke(undoA,PRIMARY_CATALOG_SOURCE,guestEnv);
    expect(revokedA.receiptId).not.toBe(revokedB.receiptId);
    expect(await revoke(undoA,PRIMARY_CATALOG_SOURCE,guestEnv)).toEqual(revokedA);
    for(const row of before){
      expect(await database.prepare("SELECT COUNT(*) count FROM delivery_notifications WHERE share_id=?").bind(row.id).first("count")).toBe(2);
      expect(await database.prepare("SELECT COUNT(*) count FROM project_alpha_delivery_intent_audit WHERE receipt_id=?").bind(row.receipt_id).first("count")).toBe(2);
    }
  },60_000);

  it("returns one secondary guest share and receipt when exact creation retries race", async () => {
    const f=await fixture("guest-retry-race",true);
    const guestEnv={...env,PROJECT_ALPHA_DELIVERY_GUEST_ENABLED:"true",DELIVERY_BASE_URL:"https://delivery.example.test",DELIVERY_TOKEN_SECRET:secret};
    const payload={...f.payload,accessMode:"guest"};let winner:{receiptId:string;status:"accepted"}|undefined;
    const raced=interleaveBeforeBatch(database,async()=>{winner=await create(payload,secondary,guestEnv);});
    expect(await create(payload,secondary,{...guestEnv,DELIVERY_DB:raced})).toEqual(winner);
    expect(await database.prepare("SELECT COUNT(*) count FROM project_alpha_delivery_intent_receipts WHERE delivery_id=?").bind(payload.deliveryId).first("count")).toBe(1);
    expect(await database.prepare("SELECT COUNT(*) count FROM shares WHERE project_id=?").bind(`${f.otherWorkspace}-delivery-project`).first("count")).toBe(1);
    expect(await database.prepare("SELECT COUNT(*) count FROM delivery_notifications WHERE share_id=(SELECT resource_id FROM project_alpha_delivery_intent_receipts WHERE receipt_id=?)").bind(winner!.receiptId).first("count")).toBe(1);
    expect(await create(payload,secondary,guestEnv)).toEqual(winner);
  },60_000);

  it.each(["binding", "generation", "principal", "owner_version", "email_block"])("rolls back receipt, grant, audit and notice when %s changes before commit", async change => {
    const f = await fixture(`race-${change}`);
    const raced = interleaveBeforeBatch(database, async () => {
      if (change === "binding") return database.prepare("UPDATE portal_v2_folder_bindings SET status='revoked',revoked_at=datetime('now') WHERE id=?").bind(`${f.workspace}-binding`).run();
      if (change === "generation") return database.prepare("UPDATE portal_v2_directory_generations SET status='superseded' WHERE id=?").bind(`${f.workspace}-generation`).run();
      if (change === "principal") return database.prepare("UPDATE pa_portal_principals SET status='suspended' WHERE workspace_id=?").bind(f.workspace).run();
      if (change === "owner_version") return database.prepare("UPDATE portal_v2_directory_entities SET source_version='owner-v2' WHERE workspace_id=? AND public_id=?").bind(f.workspace,f.owner).run();
      return database.prepare("INSERT INTO portal_v2_identity_eligibility_blocks(id,match_type,normalized_email,reason_code,created_by_actor_type,created_by_actor_id) VALUES(?,'email',?,'fixture','system','fixture')").bind(`block-${change}`,`race-${change}@example.test`).run();
    });
    await expect(create(f.payload,PRIMARY_CATALOG_SOURCE,{...env,DELIVERY_DB:raced})).rejects.toMatchObject({status:409});
    expect(await database.prepare("SELECT COUNT(*) count FROM project_alpha_delivery_intent_receipts WHERE delivery_id=?").bind(f.payload.deliveryId).first("count")).toBe(0);
    expect(await database.prepare("SELECT COUNT(*) count FROM project_alpha_delivery_portal_grants WHERE workspace_id=?").bind(f.workspace).first("count")).toBe(0);
    expect(await database.prepare("SELECT COUNT(*) count FROM project_alpha_delivery_intent_audit WHERE actor_id=?").bind(f.payload.deliveryId).first("count")).toBe(0);
  }, 60_000);

  it("does not reuse a grant revoked between selection and receipt insertion", async () => {
    const f=await fixture("reuse"),original=await create(f.payload),next={...f.payload,deliveryId:"reuse-next"};
    const raced=interleaveBeforeBatch(database,()=>revoke(revokePayload("reuse-revoke",original.receiptId)));
    await expect(create(next,PRIMARY_CATALOG_SOURCE,{...env,DELIVERY_DB:raced})).rejects.toMatchObject({status:409});
    expect(await database.prepare("SELECT COUNT(*) count FROM project_alpha_delivery_intent_receipts WHERE delivery_id='reuse-next'").first("count")).toBe(0);
    expect(await database.prepare("SELECT COUNT(*) count FROM project_alpha_delivery_portal_notification_outbox WHERE grant_id=(SELECT resource_id FROM project_alpha_delivery_intent_receipts WHERE receipt_id=?)").bind(original.receiptId).first("count")).toBe(2);
  }, 60_000);

  it("returns the winner for identical intent and revocation transactions racing before their first write", async () => {
    const f=await fixture("same-retry"); let winner:{receiptId:string;status:"accepted"}|undefined;
    const createRace=interleaveBeforeBatch(database,async()=>{winner=await create(f.payload);});
    expect(await create(f.payload,PRIMARY_CATALOG_SOURCE,{...env,DELIVERY_DB:createRace})).toEqual(winner);
    const undo=revokePayload("same-retry-revoke",winner!.receiptId);let revokeWinner:typeof winner;
    const revokeRace=interleaveBeforeBatch(database,async()=>{revokeWinner=await revoke(undo);});
    expect(await revoke(undo,PRIMARY_CATALOG_SOURCE,{...env,DELIVERY_DB:revokeRace})).toEqual(revokeWinner!);
    expect(await database.prepare("SELECT COUNT(*) count FROM project_alpha_delivery_intent_revocation_receipts WHERE delivery_id=?").bind(undo.deliveryId).first("count")).toBe(1);
    expect(await database.prepare("SELECT COUNT(*) count FROM project_alpha_delivery_portal_notification_outbox WHERE receipt_id=?").bind(winner!.receiptId).first("count")).toBe(2);
  }, 60_000);

  it("replays an accepted old request before expiry validation but never accepts the expired request as new", async () => {
    const f=await fixture("expired-replay"),payload={...f.payload,expiresAt:"2020-01-01T00:00:00.000Z"};
    await database.batch([
      database.prepare("INSERT INTO project_alpha_delivery_intent_receipts(receipt_id,project_alpha_source_id,delivery_id,request_fingerprint,access_mode,resource_id) VALUES('historical-expired',?,?,?,'portal','historical-resource')").bind(PRIMARY_CATALOG_SOURCE.sourceId,payload.deliveryId,auth(payload).fingerprint),
      database.prepare("INSERT INTO project_alpha_delivery_portal_grants(id,receipt_id,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,audience_source_version,expires_at,actor_id) VALUES('historical-resource','historical-expired',?,?,'owner-v1','principal',?,'principal-v1',?,?)").bind(f.workspace,`${f.workspace}-binding`,f.principal,payload.expiresAt,payload.deliveryId),
    ]);
    expect(await create(payload)).toEqual({receiptId:"historical-expired",status:"accepted"});
    await expect(create({...payload,deliveryId:"new-expired"})).rejects.toMatchObject({status:400});
    await expect(create({...payload,label:"changed"})).rejects.toMatchObject({status:409});
  }, 60_000);

  it("bounds unknown-length streamed bodies and ignores caller source headers after authenticating primary", async () => {
    const app=new Hono<{Bindings:Env}>();app.post(path,handleProjectAlphaDeliveryIntent);
    const oversized=await app.request(path,{method:"POST",body:new Uint8Array(16*1024+1)},env);expect(oversized.status).toBe(413);
    const f=await fixture("http-source"),body=JSON.stringify(f.payload),timestamp=new Date().toISOString();
    const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
    const signature=Buffer.from(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${timestamp}\nPOST\n${path}\nops-v1\n${f.payload.deliveryId}\n${body}`))).toString("hex");
    const response=await app.request(path,{method:"POST",headers:{"Content-Type":"application/json","X-Portal-Integration-Application-Key":"project-alpha","X-Portal-Integration-Timestamp":timestamp,"X-Portal-Integration-Body-SHA256":auth(f.payload).fingerprint,"X-Portal-Integration-Key-Id":"ops-v1","X-Portal-Integration-Delivery-Id":f.payload.deliveryId,"X-Portal-Integration-Signature":`sha256=${signature}`,"X-Portal-Integration-Source":secondary.sourceId},body},env);
    expect(response.status).toBe(202);
    expect(await database.prepare("SELECT project_alpha_source_id FROM project_alpha_delivery_intent_receipts WHERE delivery_id=?").bind(f.payload.deliveryId).first("project_alpha_source_id")).toBe(PRIMARY_CATALOG_SOURCE.sourceId);
  }, 60_000);
});
