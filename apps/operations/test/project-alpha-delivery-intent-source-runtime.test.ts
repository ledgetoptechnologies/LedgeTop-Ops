import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { Hono } from "hono";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { createCatalogSourceContext, PRIMARY_CATALOG_SOURCE } from "@ltds/shared";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { applyProjectAlphaDeliveryIntent, applyProjectAlphaDeliveryIntentRevoke, handleProjectAlphaDeliveryIntent,
  handleRegisteredProjectAlphaDeliveryIntent, handleRegisteredProjectAlphaDeliveryIntentRevoke,
  handleRegisteredProjectAlphaDeliveryPreflight, verifyRegisteredDeliveryAccess } from "../src/worker/project-alpha-delivery-intents";
import { primaryDeliveryAuthorityProof, stagePrimaryDeliveryAuthority } from "../src/worker/project-alpha-primary-delivery-authority";
import type { Env } from "../src/worker/types";

const secondary = createCatalogSourceContext("project-alpha:secondary");
const secret = "source-runtime-secret-at-least-thirty-two-bytes";
const path = "/api/internal/project-alpha/delivery-intents";
const auth = (payload: { deliveryId: string }) => ({ deliveryId: payload.deliveryId, fingerprint: createHash("sha256").update(JSON.stringify(payload)).digest("hex") });
const primaryProof = primaryDeliveryAuthorityProof({ mode: "legacy_primary", sourceId: PRIMARY_CATALOG_SOURCE.sourceId,
  revision: 0, version: 0, profile: "primary_legacy" });

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
function interleaveAfterBatch(database:D1Database,action:()=>Promise<unknown>):D1Database{
  let invoked=false;let proxy:D1Database;
  proxy=new Proxy(database,{get(target,property){
    if(property==="withSession")return()=>proxy;
    if(property==="batch")return async(statements:D1PreparedStatement[])=>{
      const result=await target.batch(statements);
      if(!invoked){invoked=true;await action();}
      return result;
    };
    const value=target[property as keyof D1Database];
    return typeof value==="function"?value.bind(target):value;
  }});
  return proxy;
}
function interleaveBeforeBatchNumber(database:D1Database,targetBatch:number,action:()=>Promise<unknown>):D1Database{
  let batches=0;let proxy:D1Database;
  proxy=new Proxy(database,{get(target,property){
    if(property==="withSession")return()=>proxy;
    if(property==="batch")return async(statements:D1PreparedStatement[])=>{
      batches+=1;if(batches===targetBatch)await action();return target.batch(statements);
    };
    const value=target[property as keyof D1Database];
    return typeof value==="function"?value.bind(target):value;
  }});return proxy;
}

describe("source-owned delivery intent runtime and transaction races", () => {
  let runtime: Miniflare;
  let database: D1Database;
  let env: Env;
  let accessPrivateKey: CryptoKey;
  let accessJwks: JWTVerifyGetKey;
  let accessPublicJwk:Awaited<ReturnType<typeof exportJWK>>;
  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-07-22", modules: true, script: "export default {fetch(){return new Response('ok')}}", d1Databases: { DELIVERY_DB: "intent-source-runtime" } });
    database = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const directory = new URL("../../client/migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(value => /^\d+.*\.sql$/.test(value)).sort()) {
      await database.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => database.prepare(sql)));
    }
    for(const name of ["0031_project_alpha_delivery_intent_rate_limits.sql","0035_project_alpha_connectors.sql",
      "0049_project_alpha_delivery_source_rate_limits.sql","0050_project_alpha_draft_quote_credentials.sql"]){
      await database.batch(splitD1MigrationStatements(readFileSync(new URL(`../migrations/${name}`,import.meta.url),"utf8")).map(sql=>database.prepare(sql)));
    }
    env = { DELIVERY_DB: database, OPS_DB: database, PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED: "true", PROJECT_ALPHA_PORTAL_APPLICATION_KEY: "project-alpha",
      PROJECT_ALPHA_PORTAL_HMAC_KEY_ID: "ops-v1", PROJECT_ALPHA_PORTAL_HMAC_SECRET: secret, CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      AUTHENTICATED_DELIVERY_GRANTS_ENABLED: "true", CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED: "true",
      CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true", CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED: "true" } as Env;
    const accessKeys=await generateKeyPair("RS256",{extractable:true});
    accessPublicJwk=await exportJWK(accessKeys.publicKey);
    accessPublicJwk.alg="RS256";accessPublicJwk.kid="registered-delivery-access";accessPublicJwk.use="sig";
    accessPrivateKey=accessKeys.privateKey;
    accessJwks=createLocalJWKSet({keys:[accessPublicJwk]});
  }, 120_000);
  afterAll(async () => { await runtime?.dispose(); });

  async function fixture(name: string, guestProjects = false) {
    const workspace = `${name}-workspace`, otherWorkspace = `${name}-workspace-b`, owner = `${name}-project`, principal = `${name}-principal`;
    if(!await database.prepare("SELECT 1 ok FROM pa_portal_source_authorities WHERE source_id=?").bind(secondary.sourceId).first("ok")){
      await database.batch([
        database.prepare(`INSERT INTO pa_portal_source_authorities(source_id,producer_binding_id,snapshot_origin,snapshot_base_path,
          application_key,state,active_revision,version,connector_revision,connector_version)
          VALUES(?,'secondary-delivery','https://secondary.example.test','/','project-alpha','active',1,1,1,1)`).bind(secondary.sourceId),
        database.prepare(`INSERT INTO pa_portal_source_authority_revisions(source_id,revision,credential_ref,access_issuer,
          access_audience,access_subject,current_key_id,current_key_fingerprint,previous_key_id,previous_key_fingerprint,created_by)
          VALUES(?,1,'secondary','https://secondary-access.example.test','secondary-audience','secondary-producer',
            'secondary.current:key',?,'secondary.previous:key',?,'fixture')`).bind(secondary.sourceId,
              createHash("sha256").update("secondary-current-delivery-secret-at-least-thirty-two-bytes").digest("hex"),
              createHash("sha256").update("secondary-previous-delivery-secret-at-least-thirty-two-bytes").digest("hex")),
      ]);
    }
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
  async function proof(source=PRIMARY_CATALOG_SOURCE){
    if(source.sourceId===PRIMARY_CATALOG_SOURCE.sourceId)return primaryProof;
    const row=await database.prepare(`SELECT active_revision revision,version,connector_revision connectorRevision,
      connector_version connectorVersion FROM pa_portal_source_authorities WHERE source_id=?`).bind(source.sourceId)
      .first<{revision:number;version:number;connectorRevision:number;connectorVersion:number}>();
    if(!row)throw new Error("missing fixture delivery authority");
    return{sourceId:source.sourceId,...row};
  }
  async function create<T extends { deliveryId: string }>(payload: T, source = PRIMARY_CATALOG_SOURCE, environment = env) {
    return applyProjectAlphaDeliveryIntent(environment,payload,auth(payload),source,
      environment.PROJECT_ALPHA_PORTAL_APPLICATION_KEY,await proof(source));
  }
  function revokePayload(deliveryId: string, receiptId: string) { return { schemaVersion: 1, applicationKey: "project-alpha", deliveryId, occurredAt: "2026-08-26T12:00:00.000Z", receiptId, reasonCode: "project_alpha_delivery_revoked" }; }
  async function revoke(payload: ReturnType<typeof revokePayload>, source = PRIMARY_CATALOG_SOURCE, environment = env) {
    return applyProjectAlphaDeliveryIntentRevoke(environment,payload,auth(payload),source,
      environment.PROJECT_ALPHA_PORTAL_APPLICATION_KEY,await proof(source));
  }
  const accessIssuer="https://secondary-access.example.test";
  const accessAudience="secondary-audience";
  const accessSubject="secondary-producer";
  function accessPayload(overrides:Partial<JWTPayload>={}):JWTPayload{return{
    iss:accessIssuer,aud:accessAudience,type:"app",common_name:accessSubject,sub:"",exp:Math.floor(Date.now()/1000)+300,...overrides,
  };}
  async function accessToken(payload:JWTPayload=accessPayload(),key=accessPrivateKey,kid="registered-delivery-access"):Promise<string>{
    return new SignJWT(payload).setProtectedHeader({alg:"RS256",kid,typ:"JWT"}).sign(key);
  }
  const accessAuthority={accessIssuer,accessAudience,accessSubject} as Parameters<typeof verifyRegisteredDeliveryAccess>[1];
  const futurePrimaryProof=primaryDeliveryAuthorityProof({mode:"registry",sourceId:PRIMARY_CATALOG_SOURCE.sourceId,
    revision:99,version:99,profile:"primary_legacy"});
  async function primaryTransitionRace<T>(run:(raced:D1Database)=>Promise<T>){
    const raced=interleaveBeforeBatchNumber(database,2,()=>stagePrimaryDeliveryAuthority(database,futurePrimaryProof,"suspended"));
    try{return await run(raced);}finally{await stagePrimaryDeliveryAuthority(database,primaryProof,"active");}
  }

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
    const guestEnv={...env,PROJECT_ALPHA_DELIVERY_GUEST_ENABLED:"true",DELIVERY_BASE_URL:"https://client.example.test",PUBLIC_SHARE_ORIGIN:"https://delivery.example.test",DELIVERY_TOKEN_SECRET:secret};
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

  it("rejects primary portal provision and revoke when authority changes at the final Delivery commit",async()=>{
    const f=await fixture("primary-portal-fence"),provision={...f.payload,deliveryId:"primary-portal-fence-provision"};
    await expect(primaryTransitionRace(raced=>create(provision,PRIMARY_CATALOG_SOURCE,{...env,DELIVERY_DB:raced})))
      .rejects.toMatchObject({status:409});
    expect(await database.prepare("SELECT count(*) count FROM project_alpha_delivery_intent_receipts WHERE delivery_id=?")
      .bind(provision.deliveryId).first("count")).toBe(0);

    const accepted=await create({...f.payload,deliveryId:"primary-portal-fence-original"});
    const undo=revokePayload("primary-portal-fence-revoke",accepted.receiptId);
    await expect(primaryTransitionRace(raced=>revoke(undo,PRIMARY_CATALOG_SOURCE,{...env,DELIVERY_DB:raced})))
      .rejects.toMatchObject({status:409});
    expect(await database.prepare("SELECT count(*) count FROM project_alpha_delivery_intent_revocation_receipts WHERE delivery_id=?")
      .bind(undo.deliveryId).first("count")).toBe(0);
    expect(await database.prepare("SELECT status FROM project_alpha_delivery_portal_grants WHERE receipt_id=?")
      .bind(accepted.receiptId).first("status")).toBe("active");
  },60_000);

  it("rejects primary guest create, compatible reuse and revoke when authority changes at commit",async()=>{
    const f=await fixture("primary-guest-fence",true),guestEnv={...env,PROJECT_ALPHA_DELIVERY_GUEST_ENABLED:"true",
      DELIVERY_BASE_URL:"https://client.example.test",PUBLIC_SHARE_ORIGIN:"https://delivery.example.test",DELIVERY_TOKEN_SECRET:secret};
    const first={...f.payload,deliveryId:"primary-guest-fence-new",accessMode:"guest"};
    await expect(primaryTransitionRace(raced=>create(first,PRIMARY_CATALOG_SOURCE,{...guestEnv,DELIVERY_DB:raced})))
      .rejects.toMatchObject({status:409});
    expect(await database.prepare("SELECT count(*) count FROM project_alpha_delivery_intent_receipts WHERE delivery_id=?")
      .bind(first.deliveryId).first("count")).toBe(0);

    const original=await create({...first,deliveryId:"primary-guest-fence-original"},PRIMARY_CATALOG_SOURCE,guestEnv);
    const reuse={...first,deliveryId:"primary-guest-fence-reuse"};
    await expect(primaryTransitionRace(raced=>create(reuse,PRIMARY_CATALOG_SOURCE,{...guestEnv,DELIVERY_DB:raced})))
      .rejects.toMatchObject({status:409});
    expect(await database.prepare("SELECT count(*) count FROM project_alpha_delivery_intent_receipts WHERE delivery_id=?")
      .bind(reuse.deliveryId).first("count")).toBe(0);

    const undo=revokePayload("primary-guest-fence-revoke",original.receiptId);
    await expect(primaryTransitionRace(raced=>revoke(undo,PRIMARY_CATALOG_SOURCE,{...guestEnv,DELIVERY_DB:raced})))
      .rejects.toMatchObject({status:409});
    expect(await database.prepare("SELECT count(*) count FROM project_alpha_delivery_intent_revocation_receipts WHERE delivery_id=?")
      .bind(undo.deliveryId).first("count")).toBe(0);
    expect(await database.prepare("SELECT revoked_at FROM shares WHERE id=(SELECT resource_id FROM project_alpha_delivery_intent_receipts WHERE receipt_id=?)")
      .bind(original.receiptId).first("revoked_at")).toBeNull();
  },60_000);

  it("returns one secondary guest share and receipt when exact creation retries race", async () => {
    const f=await fixture("guest-retry-race",true);
    const guestEnv={...env,PROJECT_ALPHA_DELIVERY_GUEST_ENABLED:"true",DELIVERY_BASE_URL:"https://client.example.test",PUBLIC_SHARE_ORIGIN:"https://delivery.example.test",DELIVERY_TOKEN_SECRET:secret};
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
    const raced = interleaveBeforeBatchNumber(database,2,async () => {
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
    const raced=interleaveBeforeBatchNumber(database,2,()=>revoke(revokePayload("reuse-revoke",original.receiptId)));
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

  it("accepts only the exact service-token identity at the registered delivery access boundary",async()=>{
    await expect(verifyRegisteredDeliveryAccess(new Request("https://ops.example.test/registered",{headers:{
      "Cf-Access-Jwt-Assertion":await accessToken(),
    }}),accessAuthority,accessJwks)).resolves.toBeUndefined();
  });

  it("reuses one remote JWKS resolver per issuer and refreshes it after key rotation",async()=>{
    const issuer="https://registered-cache.example.test";
    const rotated=await generateKeyPair("RS256",{extractable:true});
    const rotatedJwk=await exportJWK(rotated.publicKey);
    rotatedJwk.alg="RS256";rotatedJwk.kid="registered-delivery-rotated";rotatedJwk.use="sig";
    let published=[accessPublicJwk];
    const fetchJwks=vi.fn(async()=>new Response(JSON.stringify({keys:published}),{
      status:200,headers:{"Content-Type":"application/json"},
    }));
    vi.stubGlobal("fetch",fetchJwks);
    vi.useFakeTimers({toFake:["Date"]});
    try{
      const authority={...accessAuthority,accessIssuer:issuer};
      const request=(assertion:string)=>new Request("https://ops.example.test/registered",{headers:{"Cf-Access-Jwt-Assertion":assertion}});
      const first=await accessToken(accessPayload({iss:issuer}));
      await expect(verifyRegisteredDeliveryAccess(request(first),authority)).resolves.toBeUndefined();
      await expect(verifyRegisteredDeliveryAccess(request(first),authority)).resolves.toBeUndefined();
      expect(fetchJwks).toHaveBeenCalledTimes(1);

      published=[rotatedJwk];
      vi.setSystemTime(new Date(Date.now()+31_000));
      const next=await accessToken(accessPayload({iss:issuer}),rotated.privateKey,"registered-delivery-rotated");
      await expect(verifyRegisteredDeliveryAccess(request(next),authority)).resolves.toBeUndefined();
      expect(fetchJwks).toHaveBeenCalledTimes(2);
    }finally{
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("bounds the remote JWKS resolver cache to 32 validated issuers",async()=>{
    const fetchJwks=vi.fn(async()=>new Response(JSON.stringify({keys:[accessPublicJwk]}),{
      status:200,headers:{"Content-Type":"application/json"},
    }));
    vi.stubGlobal("fetch",fetchJwks);
    try{
      for(let index=0;index<33;index++){
        const issuer=`https://registered-cache-${index}.example.test`;
        const assertion=await accessToken(accessPayload({iss:issuer}));
        await verifyRegisteredDeliveryAccess(new Request("https://ops.example.test/registered",{headers:{
          "Cf-Access-Jwt-Assertion":assertion,
        }}),{...accessAuthority,accessIssuer:issuer});
      }
      const firstIssuer="https://registered-cache-0.example.test";
      const firstAssertion=await accessToken(accessPayload({iss:firstIssuer}));
      await verifyRegisteredDeliveryAccess(new Request("https://ops.example.test/registered",{headers:{
        "Cf-Access-Jwt-Assertion":firstAssertion,
      }}),{...accessAuthority,accessIssuer:firstIssuer});
      expect(fetchJwks).toHaveBeenCalledTimes(34);
    }finally{vi.unstubAllGlobals();}
  });

  it.each([
    ["issuer",{iss:"https://other-access.example.test"}],
    ["audience",{aud:"other-audience"}],
    ["common_name",{common_name:"other-producer"}],
    ["type",{type:"user"}],
    ["subject",{sub:"human-subject"}],
  ] as const)("rejects a registered delivery assertion with the wrong %s",async(_label,overrides)=>{
    const request=new Request("https://ops.example.test/registered",{headers:{"Cf-Access-Jwt-Assertion":await accessToken(accessPayload(overrides))}});
    await expect(verifyRegisteredDeliveryAccess(request,accessAuthority,accessJwks)).rejects.toMatchObject({status:401});
  });

  it("rejects a non-RS256 assertion and a missing registered delivery assertion",async()=>{
    const wrongAlgorithm=await new SignJWT(accessPayload()).setProtectedHeader({alg:"HS256",kid:"registered-delivery-access"})
      .sign(new TextEncoder().encode("not-an-rsa-signing-key"));
    await expect(verifyRegisteredDeliveryAccess(new Request("https://ops.example.test/registered",{headers:{
      "Cf-Access-Jwt-Assertion":wrongAlgorithm,
    }}),accessAuthority,accessJwks)).rejects.toMatchObject({status:401});
    await expect(verifyRegisteredDeliveryAccess(new Request("https://ops.example.test/registered"),accessAuthority,accessJwks))
      .rejects.toMatchObject({status:401});
  });

  it("rejects expired and untrusted RS256 registered delivery assertions",async()=>{
    const expired=await accessToken(accessPayload({exp:Math.floor(Date.now()/1000)-1}));
    await expect(verifyRegisteredDeliveryAccess(new Request("https://ops.example.test/registered",{headers:{
      "Cf-Access-Jwt-Assertion":expired,
    }}),accessAuthority,accessJwks)).rejects.toMatchObject({status:401});
    const untrusted=await generateKeyPair("RS256");
    const unknown=await accessToken(accessPayload(),untrusted.privateKey);
    await expect(verifyRegisteredDeliveryAccess(new Request("https://ops.example.test/registered",{headers:{
      "Cf-Access-Jwt-Assertion":unknown,
    }}),accessAuthority,accessJwks)).rejects.toMatchObject({status:401});
  });

  it("conceals a malformed registered source as not found instead of surfacing a runtime error",async()=>{
    const app=new Hono<{Bindings:Env}>();
    app.post("/api/internal/project-alpha/sources/:sourceId/delivery-intents",c=>
      handleRegisteredProjectAlphaDeliveryIntent(c,c.req.param("sourceId")));
    const response=await app.request("/api/internal/project-alpha/sources/not-a-source/delivery-intents",{
      method:"POST",body:"{}",headers:{"Content-Type":"application/json"},
    },env);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it("authenticates registered-source preflight, intent and revoke with current and previous source-owned keys", async () => {
    const current={keyId:"secondary.current:key",value:"secondary-current-delivery-secret-at-least-thirty-two-bytes"};
    const previous={keyId:"secondary.previous:key",value:"secondary-previous-delivery-secret-at-least-thirty-two-bytes"};
    const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
    await database.prepare(`UPDATE pa_portal_source_authorities SET state='active',version=version+1,updated_at=datetime('now') WHERE source_id=?`)
      .bind(secondary.sourceId).run();
    const registeredEnv={...env,PROJECT_ALPHA_CONNECTOR_CREDENTIALS:JSON.stringify({version:1,sets:{secondary:{portalCurrent:current,portalPrevious:previous}}})};
    const assertion=await accessToken();
    const verifyAccess=(request:Request,authority:Parameters<typeof verifyRegisteredDeliveryAccess>[1])=>
      verifyRegisteredDeliveryAccess(request,authority,accessJwks);
    const base=`/api/internal/project-alpha/sources/${encodeURIComponent(secondary.sourceId)}/delivery-intents`;
    const app=new Hono<{Bindings:Env}>();
    app.post("/api/internal/project-alpha/sources/:sourceId/delivery-intents/preflight",c=>handleRegisteredProjectAlphaDeliveryPreflight(c,c.req.param("sourceId"),verifyAccess));
    app.post("/api/internal/project-alpha/sources/:sourceId/delivery-intents",c=>handleRegisteredProjectAlphaDeliveryIntent(c,c.req.param("sourceId"),verifyAccess));
    app.post("/api/internal/project-alpha/sources/:sourceId/delivery-intents/revoke",c=>handleRegisteredProjectAlphaDeliveryIntentRevoke(c,c.req.param("sourceId"),verifyAccess));
    async function send(target:string,payload:Record<string,unknown>,key=current,canonicalTarget=target){
      const raw=JSON.stringify(payload),timestamp=new Date().toISOString(),bodyDigest=digest(raw);
      const imported=await crypto.subtle.importKey("raw",new TextEncoder().encode(key.value),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
      const signature=Buffer.from(await crypto.subtle.sign("HMAC",imported,new TextEncoder().encode(`${timestamp}\nPOST\n${canonicalTarget}\n${key.keyId}\n${payload.deliveryId}\n${raw}`))).toString("hex");
      return app.request(target,{method:"POST",body:raw,headers:{"Content-Type":"application/json","Cf-Access-Jwt-Assertion":assertion,
        "X-Portal-Integration-Application-Key":"project-alpha","X-Portal-Integration-Timestamp":timestamp,
        "X-Portal-Integration-Body-SHA256":bodyDigest,"X-Portal-Integration-Key-Id":key.keyId,
        "X-Portal-Integration-Delivery-Id":String(payload.deliveryId),"X-Portal-Integration-Signature":`sha256=${signature}`}},registeredEnv);
    }
    const f=await fixture("registered-http");
    const preflight={schemaVersion:1,applicationKey:"project-alpha",deliveryId:"registered-preflight",occurredAt:new Date().toISOString()};
    expect((await send(`${base}/preflight`,preflight)).status).toBe(200);
    const accepted=await send(base,{...f.payload,deliveryId:"registered-current"});expect(accepted.status).toBe(202);
    const currentReceipt=(await accepted.json() as {receiptId:string}).receiptId;
    expect((await send(base,{...f.payload,deliveryId:"registered-previous"},previous)).status).toBe(202);
    expect((await send(`${base}/revoke`,revokePayload("registered-revoke",currentReceipt))).status).toBe(202);
    const tamperedPath=`/api/internal/project-alpha/sources/${encodeURIComponent("project-alpha:other")}/delivery-intents`;
    expect((await send(base,{...f.payload,deliveryId:"registered-path-tamper"},current,tamperedPath)).status).toBe(401);
    const rows=(await database.prepare("SELECT project_alpha_source_id,delivery_id FROM project_alpha_delivery_intent_receipts WHERE delivery_id LIKE 'registered-%' ORDER BY delivery_id").all()).results;
    expect(rows).toEqual([{project_alpha_source_id:secondary.sourceId,delivery_id:"registered-current"},{project_alpha_source_id:secondary.sourceId,delivery_id:"registered-previous"}]);

    // Access-authenticated but invalid HMAC attempts use a separate coarse
    // budget and never consume the accepted-intent quota.
    await database.prepare(`UPDATE project_alpha_delivery_intent_source_rate_limits SET request_count=299
      WHERE source_id=? AND scope='attempt_intent' AND window_start=strftime('%Y-%m-%dT%H:%M:00Z','now')`).bind(secondary.sourceId).run();
    const invalidKey={keyId:current.keyId,value:"incorrect-but-long-enough-signing-secret-value"};
    expect((await send(base,{...f.payload,deliveryId:"registered-invalid-hmac"},invalidKey)).status).toBe(401);
    expect(await database.prepare(`SELECT request_count FROM project_alpha_delivery_intent_source_rate_limits
      WHERE source_id=? AND scope='attempt_intent' AND window_start=strftime('%Y-%m-%dT%H:%M:00Z','now')`).bind(secondary.sourceId).first("request_count")).toBe(300);
    // Accepted requests can straddle a UTC minute boundary on a contended CI
    // runner. Sum the accepted-intent windows instead of assuming the query
    // executes in the same minute as every accepted request.
    expect(await database.prepare(`SELECT COALESCE(SUM(request_count),0) AS request_count
      FROM project_alpha_delivery_intent_source_rate_limits
      WHERE source_id=? AND scope='intent'`).bind(secondary.sourceId).first("request_count")).toBe(3);
    expect((await send(base,{...f.payload,deliveryId:"registered-attempt-limit"},invalidKey)).status).toBe(429);

    expect((await app.request("/api/internal/project-alpha/sources/project-alpha%3Amissing/delivery-intents",{method:"POST",body:"{}"},registeredEnv)).status).toBe(404);
    await database.prepare("UPDATE pa_portal_source_authorities SET state='suspended',version=version+1 WHERE source_id=?").bind(secondary.sourceId).run();
    expect((await app.request(base,{method:"POST",body:"{}"},registeredEnv)).status).toBe(404);
  },60_000);

  it("rolls back registered-source delivery when its authority changes at the write boundary",async()=>{
    const f=await fixture("registered-authority-race"),payload={...f.payload,deliveryId:"registered-authority-race"};
    const raced=interleaveBeforeBatch(database,()=>database.prepare(`UPDATE pa_portal_source_authorities
      SET state='suspended',version=version+1,updated_at=datetime('now') WHERE source_id=?`).bind(secondary.sourceId).run());
    await expect(applyProjectAlphaDeliveryIntent({...env,DELIVERY_DB:raced},payload,auth(payload),secondary,"project-alpha",
      {sourceId:secondary.sourceId,revision:1,version:1,connectorRevision:1,connectorVersion:1})).rejects.toMatchObject({status:409});
    expect(await database.prepare("SELECT count(*) count FROM project_alpha_delivery_intent_receipts WHERE delivery_id=?")
      .bind(payload.deliveryId).first("count")).toBe(0);
  },60_000);

  it("returns the committed receipt when source authority changes immediately after the transaction",async()=>{
    await database.prepare(`UPDATE pa_portal_source_authorities SET state='active',version=version+1,updated_at=datetime('now')
      WHERE source_id=?`).bind(secondary.sourceId).run();
    const version=await database.prepare("SELECT version FROM pa_portal_source_authorities WHERE source_id=?")
      .bind(secondary.sourceId).first<number>("version");
    const f=await fixture("registered-after-commit"),payload={...f.payload,deliveryId:"registered-after-commit"};
    const raced=interleaveAfterBatch(database,()=>database.prepare(`UPDATE pa_portal_source_authorities
      SET state='suspended',version=version+1,updated_at=datetime('now') WHERE source_id=?`).bind(secondary.sourceId).run());
    const accepted=await applyProjectAlphaDeliveryIntent({...env,DELIVERY_DB:raced},payload,auth(payload),secondary,"project-alpha",
      {sourceId:secondary.sourceId,revision:1,version:version!,connectorRevision:1,connectorVersion:1});
    expect(accepted.status).toBe("accepted");
    expect(await database.prepare("SELECT receipt_id FROM project_alpha_delivery_intent_receipts WHERE delivery_id=?")
      .bind(payload.deliveryId).first("receipt_id")).toBe(accepted.receiptId);
  },60_000);
});
