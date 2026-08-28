import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import {
  authenticatedDeliveryChangeNotificationsReady,
  controlAuthenticatedDeliveryChangeBatch,
  dispatchAuthenticatedDeliveryChangeNotifications,
  recordAuthenticatedDeliveryObjectChange,
  saveAuthenticatedDeliveryNotificationPolicy,
} from "../src/worker/authenticated-delivery-change-notifications";
import type { Env } from "../src/worker/types";

describe("exact authenticated delivery change notifications — migrated real D1", {timeout: 240_000}, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;
  let counter = 0;

  beforeAll(async () => {
    runtime = new Miniflare({compatibilityDate:"2026-07-22",modules:true,
      script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DELIVERY_DB:"exact-delivery-change"}});
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const directory = new URL("../../client/migrations/",import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name) && Number(name.slice(0,4)) <= 169).sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name,directory),"utf8")).map(sql => db.prepare(sql)));
    const before = await fixture("upgrade");
    const preserved = {
      grant: await db.prepare("SELECT * FROM portal_v2_authenticated_delivery_grants WHERE id=?").bind(before.grant).first(),
      recipient: await db.prepare("SELECT * FROM portal_v2_authenticated_delivery_grant_recipients WHERE grant_id=?").bind(before.grant).first(),
    };
    await db.batch(splitD1MigrationStatements(readFileSync(new URL("../../client/migrations/0170_authenticated_delivery_change_notifications.sql",import.meta.url),"utf8"))
      .map(sql => db.prepare(sql)));
    expect(await db.prepare("SELECT * FROM portal_v2_authenticated_delivery_grants WHERE id=?").bind(before.grant).first()).toEqual(preserved.grant);
    expect(await db.prepare("SELECT * FROM portal_v2_authenticated_delivery_grant_recipients WHERE grant_id=?").bind(before.grant).first()).toEqual(preserved.recipient);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(await db.prepare("PRAGMA quick_check('portal_authenticated_delivery_change_batches')").first("quick_check")).toBe("ok");
    expect(await db.prepare("SELECT count(*) n FROM portal_authenticated_delivery_notification_policies").first("n")).toBe(0);
    await expect(db.prepare("UPDATE portal_v2_workspaces SET project_alpha_source_id='project-alpha:other' WHERE id=?")
      .bind(before.workspace).run()).rejects.toThrow();
    await expect(db.prepare("UPDATE portal_v2_authenticated_delivery_grants SET grant_version=2 WHERE id=?")
      .bind(before.grant).run()).rejects.toThrow();
    env = {DELIVERY_DB:db,AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED:"true",DELIVERY_BASE_URL:"https://client.example.test"} as Env;
  },180_000);
  afterAll(async () => runtime?.dispose());

  async function fixture(label: string, prefix?: string) {
    counter++;
    const suffix=`${label}-${counter}`,workspace=`workspace-${suffix}`,identity=`identity-${suffix}`,
      principal=`principal-${suffix}`,organization=`organization-${suffix}`,project=`project-${suffix}`,
      generation=`generation-${suffix}`,binding=`binding-${suffix}`,grant=`grant-${suffix}`,
      logical=`logical-${suffix}`,r2Prefix=prefix ?? `Jobs/Clients/${suffix}/`;
    await db.batch([
      db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES(?,?,?,?)")
        .bind(identity,"https://access.example.test",`subject-${suffix}`,`${suffix}@example.test`),
      db.prepare("INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id) VALUES(?,'organization',?,?,'active','project-alpha:primary')")
        .bind(workspace,organization,`Workspace ${suffix}`),
      db.prepare("INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status) VALUES(?,?,?,'operations','active')")
        .bind(`membership-${suffix}`,workspace,identity),
      db.prepare("INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete) VALUES(?,?,?,1,'active',1)")
        .bind(generation,workspace,generation),
      db.prepare("INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,display_name,source_version) VALUES(?,?,'organization',?,?,'v1')")
        .bind(workspace,generation,organization,`Organization ${suffix}`),
      db.prepare("INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version) VALUES(?,?,'project',?,?,?,'v1')")
        .bind(workspace,generation,project,organization,`Project ${suffix}`),
      db.prepare("INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)")
        .bind(workspace,generation),
      db.prepare("INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version) VALUES(?,?,'project',?,?,'operations','v1')")
        .bind(binding,workspace,project,r2Prefix),
      db.prepare("INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status) VALUES(?,?,?,?,?,'pv1','active')")
        .bind(workspace,principal,identity,`${suffix}@example.test`,`Person ${suffix}`),
      db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,
        source_type,status) VALUES(?,?,?,'delivery.view','allow','project',?,'operations','active')`)
        .bind(`entitlement-${suffix}`,workspace,identity,project),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants(id,logical_grant_id,grant_version,workspace_id,folder_binding_id,
        binding_source_version,audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id)
        VALUES(?,?,1,?,?,'v1','principal',?,'pv1','test','staff-a')`).bind(grant,logical,workspace,binding,principal),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_recipients
        (grant_id,workspace_id,principal_public_id,identity_id,principal_source_version) VALUES(?,?,?,?, 'pv1')`)
        .bind(grant,workspace,principal,identity),
    ]);
    return {suffix,workspace,identity,principal,organization,project,generation,binding,grant,logical,prefix:r2Prefix};
  }

  async function optIn(f: Awaited<ReturnType<typeof fixture>>, mode: "added"|"removed"|"both" = "both") {
    return saveAuthenticatedDeliveryNotificationPolicy(env,"staff-a",{grantId:f.grant,identityId:f.identity,
      expectedPolicyVersion:null,accessNoticeEnabled:true,changeMode:mode,idempotencyKey:`policy-${f.suffix}-00000000`});
  }

  async function add(f: Awaited<ReturnType<typeof fixture>>, name: string, version=`etag-${name}`, at=new Date().toISOString()) {
    const key=`${f.prefix}${name}`;
    await db.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind)
      VALUES(?,?,10,?,'image/jpeg','image') ON CONFLICT(r2_key) DO UPDATE SET etag=excluded.etag,uploaded_at=excluded.uploaded_at`)
      .bind(key,version,at).run();
    return recordAuthenticatedDeliveryObjectChange(env,key,true,version,at);
  }

  async function remove(f: Awaited<ReturnType<typeof fixture>>, name: string, version=`etag-${name}`, at=new Date().toISOString()) {
    const key=`${f.prefix}${name}`;
    await db.prepare("DELETE FROM file_index WHERE r2_key=?").bind(key).run();
    return recordAuthenticatedDeliveryObjectChange(env,key,false,version,at);
  }

  async function batches(f: Awaited<ReturnType<typeof fixture>>) {
    return (await db.prepare(`SELECT * FROM portal_authenticated_delivery_change_batches WHERE workspace_id=? ORDER BY created_at,id`)
      .bind(f.workspace).all<Record<string,unknown>>()).results;
  }

  it("is migration-default-off, actor-idempotent and rejects conflicting policy replay", async () => {
    const f=await fixture("policy");
    expect(await authenticatedDeliveryChangeNotificationsReady(env)).toBe(true);
    expect(await add(f,"before.jpg")).toBe(0);
    const key=`policy-${f.suffix}-00000000`;
    const first=await saveAuthenticatedDeliveryNotificationPolicy(env,"staff-a",{grantId:f.grant,identityId:f.identity,
      expectedPolicyVersion:null,accessNoticeEnabled:true,changeMode:"added",idempotencyKey:key});
    expect(first).toMatchObject({policy_version:1,access_notice_enabled:1,change_mode:"added"});
    expect(await saveAuthenticatedDeliveryNotificationPolicy(env,"staff-a",{grantId:f.grant,identityId:f.identity,
      expectedPolicyVersion:null,accessNoticeEnabled:true,changeMode:"added",idempotencyKey:key})).toEqual(first);
    await expect(saveAuthenticatedDeliveryNotificationPolicy(env,"staff-a",{grantId:f.grant,identityId:f.identity,
      expectedPolicyVersion:1,accessNoticeEnabled:false,changeMode:"off",idempotencyKey:key})).rejects.toThrow("idempotency-conflict");
    expect(await db.prepare("SELECT count(*) n FROM portal_authenticated_delivery_notification_policy_audit WHERE grant_id=?").bind(f.grant).first("n")).toBe(1);
  });

  it("batches forty together and rolls item 51 into a successor without resetting duplicates", async () => {
    const forty=await fixture("forty");await optIn(forty,"added");
    for(let index=0;index<40;index++)expect(await add(forty,`${index}.jpg`)).toBe(1);
    expect(await batches(forty)).toMatchObject([{status:"pending",added_count:40,removed_count:0}]);
    const before=await batches(forty);expect(await add(forty,"0.jpg")).toBe(0);expect(await batches(forty)).toEqual(before);

    const fiftyOne=await fixture("fifty-one");await optIn(fiftyOne,"added");
    for(let index=0;index<51;index++)await add(fiftyOne,`${index}.jpg`);
    const rows=await batches(fiftyOne);
    expect(rows).toHaveLength(2);
    expect(rows.map(row=>row.added_count)).toEqual([50,1]);
    expect(rows[0]).toMatchObject({sealed_at:expect.any(String)});
  },180_000);

  it("deduplicates object versions, accepts replacements, rejects delayed events, and cancels add-delete windows", async () => {
    const f=await fixture("versions");await optIn(f);
    const now=new Date().toISOString(),old=new Date(Date.now()-60_000).toISOString();
    expect(await add(f,"photo.jpg","v1",now)).toBe(1);
    expect(await add(f,"photo.jpg","v1",now)).toBe(0);
    expect(await add(f,"photo.jpg","v2",now)).toBe(1);
    expect(await add(f,"photo.jpg","v1",old)).toBe(0);
    expect(await remove(f,"photo.jpg","v2",new Date(Date.now()+1_000).toISOString())).toBe(1);
    expect(await batches(f)).toMatchObject([{status:"cancelled",added_count:0,removed_count:0}]);
  });

  it("routes changes after a policy mutation into the current policy-version batch", async () => {
    const f=await fixture("policy-batch");const first=await optIn(f,"both");
    await add(f,"before.jpg","before-v1");
    await saveAuthenticatedDeliveryNotificationPolicy(env,"staff-a",{grantId:f.grant,identityId:f.identity,
      expectedPolicyVersion:first.policy_version,accessNoticeEnabled:true,changeMode:"both",
      idempotencyKey:`policy-update-${f.suffix}-000000`});
    expect(await saveAuthenticatedDeliveryNotificationPolicy(env,"staff-a",{grantId:f.grant,identityId:f.identity,
      expectedPolicyVersion:null,accessNoticeEnabled:true,changeMode:"both",
      idempotencyKey:`policy-${f.suffix}-00000000`})).toMatchObject({policy_version:1,change_mode:"both"});
    await add(f,"after.jpg","after-v1");
    expect((await batches(f)).map(batch=>batch.policy_version)).toEqual([1,2]);
  });

  it("rejects pre-policy delayed events and equal-prefix ambiguity; selects a unique longest prefix", async () => {
    const f=await fixture("delayed");const before=new Date(Date.now()-3_600_000).toISOString();await optIn(f);
    await db.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,10,?,'image/jpeg','image')`)
      .bind(`${f.prefix}old.jpg`,`old`,before).run();
    expect(await recordAuthenticatedDeliveryObjectChange(env,`${f.prefix}old.jpg`,true,"old",before)).toBe(0);

    const ambiguous=await fixture("ambiguous");await optIn(ambiguous);
    const grant2=`${ambiguous.grant}-two`;
    await db.batch([
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants(id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,
        audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id)
        VALUES(?,?,1,?,?,'v1','principal',?,'pv1','test','staff-a')`).bind(grant2,`${ambiguous.logical}-two`,ambiguous.workspace,ambiguous.binding,ambiguous.principal),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_recipients(grant_id,workspace_id,principal_public_id,identity_id,principal_source_version)
        VALUES(?,?,?,?,'pv1')`).bind(grant2,ambiguous.workspace,ambiguous.principal,ambiguous.identity),
    ]);
    await saveAuthenticatedDeliveryNotificationPolicy(env,"staff-a",{grantId:grant2,identityId:ambiguous.identity,
      expectedPolicyVersion:null,accessNoticeEnabled:true,changeMode:"both",idempotencyKey:`policy-${grant2}-00000000`});
    expect(await add(ambiguous,"ambiguous.jpg")).toBe(0);

    const nested=await fixture("nested");await optIn(nested);
    const nestedBinding=`${nested.binding}-child`,nestedGrant=`${nested.grant}-child`,nestedPrefix=`${nested.prefix}Final/`;
    await db.batch([
      db.prepare("INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version) VALUES(?,?,'project',?,?,'operations','v1')")
        .bind(nestedBinding,nested.workspace,nested.project,nestedPrefix),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants(id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,
        audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id)
        VALUES(?,?,1,?,?,'v1','principal',?,'pv1','test','staff-a')`).bind(nestedGrant,`${nested.logical}-child`,nested.workspace,nestedBinding,nested.principal),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_recipients(grant_id,workspace_id,principal_public_id,identity_id,principal_source_version)
        VALUES(?,?,?,?,'pv1')`).bind(nestedGrant,nested.workspace,nested.principal,nested.identity),
    ]);
    await saveAuthenticatedDeliveryNotificationPolicy(env,"staff-a",{grantId:nestedGrant,identityId:nested.identity,
      expectedPolicyVersion:null,accessNoticeEnabled:true,changeMode:"both",idempotencyKey:`policy-${nestedGrant}-00000000`});
    await db.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?, 'nested-etag',10,datetime('now'),'image/jpeg','image')`).bind(`${nestedPrefix}photo.jpg`).run();
    expect(await recordAuthenticatedDeliveryObjectChange(env,`${nestedPrefix}photo.jpg`,true,"nested-etag",new Date().toISOString())).toBe(1);
    expect((await batches(nested))[0]).toMatchObject({grant_id:nestedGrant,r2_prefix:nestedPrefix});
  });

  it("dispatches once with stable Message-ID and suppresses revoked, denied, expired, rebound, policy-off and missing objects", async () => {
    const deliver=await fixture("deliver");await optIn(deliver);await add(deliver,"photo.jpg");
    await db.prepare("UPDATE portal_v2_workspaces SET display_name='<Unsafe & Workspace>' WHERE id=?").bind(deliver.workspace).run();
    await db.prepare("UPDATE portal_authenticated_delivery_change_batches SET eligible_at=datetime('now','-1 second') WHERE workspace_id=?").bind(deliver.workspace).run();
    const send=vi.fn().mockResolvedValue(undefined);
    expect(await dispatchAuthenticatedDeliveryChangeNotifications(env,{send})).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]).toMatchObject({to:`${deliver.suffix}@example.test`,messageIdKey:expect.stringContaining("authenticated-delivery-change:")});
    expect(send.mock.calls[0]![1].html).toContain("&lt;Unsafe &amp; Workspace&gt;");
    expect(send.mock.calls[0]![1].html).not.toContain("<Unsafe");
    expect((await db.prepare(`SELECT action FROM portal_authenticated_delivery_change_audit
      WHERE batch_id=? ORDER BY created_at,id`).bind((await batches(deliver))[0]!.id).all<{action:string}>()).results.map(row=>row.action))
      .toEqual(expect.arrayContaining(["batch.staged","batch.claimed","batch.sent"]));
    expect(await dispatchAuthenticatedDeliveryChangeNotifications(env,{send})).toBe(0);

    for(const failure of ["revoked","denied","expired","binding","binding-version","generation","owner","principal","identity","policy","missing"] as const){
      const f=await fixture(`failure-${failure}`);const policy=await optIn(f);await add(f,"photo.jpg");
      await db.prepare("UPDATE portal_authenticated_delivery_change_batches SET eligible_at=datetime('now','-1 second') WHERE workspace_id=?").bind(f.workspace).run();
      if(failure==="revoked")await db.prepare("UPDATE portal_v2_authenticated_delivery_grants SET status='revoked',revoked_at=datetime('now'),revoked_by_staff_id='staff-a',revoke_reason_code='test' WHERE id=?").bind(f.grant).run();
      if(failure==="denied")await db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
        VALUES(?,?,?,'delivery.view','deny','workspace',?,'operations','active')`).bind(`deny-${f.suffix}`,f.workspace,f.identity,f.workspace).run();
      if(failure==="expired")await db.prepare("UPDATE portal_v2_workspace_memberships SET expires_at=datetime('now','-1 second') WHERE identity_id=?").bind(f.identity).run();
      if(failure==="binding")await db.prepare("UPDATE portal_v2_folder_bindings SET status='suspended' WHERE id=?").bind(f.binding).run();
      if(failure==="binding-version")await db.prepare("UPDATE portal_v2_folder_bindings SET source_version='v2' WHERE id=?").bind(f.binding).run();
      if(failure==="generation")await db.prepare("UPDATE portal_v2_directory_generations SET status='superseded' WHERE id=?").bind(f.generation).run();
      if(failure==="owner")await db.prepare("UPDATE portal_v2_directory_entities SET active=0 WHERE workspace_id=? AND generation_id=? AND public_id=?")
        .bind(f.workspace,f.generation,f.project).run();
      if(failure==="principal")await db.prepare("UPDATE pa_portal_principals SET status='suspended' WHERE workspace_id=? AND public_id=?")
        .bind(f.workspace,f.principal).run();
      if(failure==="identity")await db.prepare("UPDATE portal_v2_identities SET status='suspended' WHERE id=?").bind(f.identity).run();
      if(failure==="policy")await saveAuthenticatedDeliveryNotificationPolicy(env,"staff-a",{grantId:f.grant,identityId:f.identity,
        expectedPolicyVersion:policy.policy_version,accessNoticeEnabled:false,changeMode:"off",idempotencyKey:`disable-${f.suffix}-0000000`});
      if(failure==="missing")await db.prepare("DELETE FROM file_index WHERE r2_key=?").bind(`${f.prefix}photo.jpg`).run();
      const calls=send.mock.calls.length;await dispatchAuthenticatedDeliveryChangeNotifications(env,{send});expect(send.mock.calls).toHaveLength(calls);
      expect((await batches(f))[0]).toMatchObject({status:"suppressed"});
    }
  },120_000);

  it("rechecks authority at the final boundary and preserves lease retry identity", async () => {
    const race=await fixture("race");await optIn(race);await add(race,"photo.jpg");
    await db.prepare("UPDATE portal_authenticated_delivery_change_batches SET eligible_at=datetime('now','-1 second') WHERE workspace_id=?").bind(race.workspace).run();
    const send=vi.fn();
    await dispatchAuthenticatedDeliveryChangeNotifications(env,{send,beforeFinalAuthorization:async()=>{
      await db.prepare("UPDATE portal_v2_workspace_memberships SET status='revoked',revoked_at=datetime('now') WHERE identity_id=?").bind(race.identity).run();
    }});
    expect(send).not.toHaveBeenCalled();expect((await batches(race))[0]).toMatchObject({status:"suppressed"});

    const retry=await fixture("retry");await optIn(retry);await add(retry,"photo.jpg");
    await db.prepare("UPDATE portal_authenticated_delivery_change_batches SET eligible_at=datetime('now','-1 second') WHERE workspace_id=?").bind(retry.workspace).run();
    const uncertain=vi.fn().mockRejectedValueOnce(new Error("provider uncertain")).mockResolvedValue(undefined);
    await dispatchAuthenticatedDeliveryChangeNotifications(env,{send:uncertain});
    const first=(await batches(retry))[0]!;expect(first).toMatchObject({status:"pending",attempt_count:1,dispatch_fingerprint:expect.any(String)});
    await db.prepare("UPDATE portal_authenticated_delivery_change_batches SET eligible_at=datetime('now','-1 second') WHERE id=?").bind(first.id).run();
    await dispatchAuthenticatedDeliveryChangeNotifications(env,{send:uncertain});
    expect(uncertain).toHaveBeenCalledTimes(2);
    expect(uncertain.mock.calls[0]![1].messageIdKey).toBe(uncertain.mock.calls[1]![1].messageIdKey);

    const exhausted=await fixture("exhausted");await optIn(exhausted);await add(exhausted,"photo.jpg");
    await db.prepare("UPDATE portal_authenticated_delivery_change_batches SET attempt_count=3,eligible_at=datetime('now','-1 second') WHERE workspace_id=?")
      .bind(exhausted.workspace).run();
    await dispatchAuthenticatedDeliveryChangeNotifications(env,{send:vi.fn()});
    const exhaustedBatch=(await batches(exhausted))[0]!;
    expect(exhaustedBatch).toMatchObject({status:"failed",last_error:"attempts-exhausted"});
    expect(await db.prepare(`SELECT count(*) n FROM portal_authenticated_delivery_change_audit
      WHERE batch_id=? AND action='batch.failed' AND reason_code='attempts-exhausted'`).bind(exhaustedBatch.id).first("n")).toBe(1);
  });

  it("serializes send-now and cancel with actor-scoped replay", async () => {
    const f=await fixture("control");await optIn(f);await add(f,"photo.jpg");
    const batch=(await batches(f))[0] as any,key=`control-${f.suffix}-000000`;
    const cancelled=await controlAuthenticatedDeliveryChangeBatch(env,"staff-a",{batchId:batch.id,action:"cancel",expectedRevision:batch.revision,idempotencyKey:key});
    expect(cancelled).toEqual({status:"cancelled",revision:batch.revision+1});
    expect(await controlAuthenticatedDeliveryChangeBatch(env,"staff-a",{batchId:batch.id,action:"cancel",expectedRevision:batch.revision,idempotencyKey:key})).toEqual(cancelled);
    expect(await db.prepare(`SELECT count(*) n FROM portal_authenticated_delivery_change_audit
      WHERE batch_id=? AND action='batch.cancelled'`).bind(batch.id).first("n")).toBe(1);
    await expect(controlAuthenticatedDeliveryChangeBatch(env,"staff-b",{batchId:batch.id,action:"send-now",expectedRevision:batch.revision,idempotencyKey:`other-${f.suffix}-00000000`})).rejects.toThrow("control-conflict");
  });

  it("suppresses expired entitlement terms and relation-scoped entitlement or identity denials", async () => {
    const term=await fixture("term");await optIn(term);await add(term,"photo.jpg");
    const termId=`terms-${term.suffix}`;
    await db.batch([
      db.prepare("UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE identity_id=?").bind(term.identity),
      db.prepare(`INSERT INTO portal_project_access_terms
        (id,workspace_id,source_id,project_public_id,kind,mode,expires_at,created_by_actor_type,created_by_actor_id)
        VALUES(?,?,'project-alpha:primary',?,'collaborator','specific_date',?,'staff','staff-a')`)
        .bind(termId,term.workspace,term.project,new Date(Date.now()+1_100).toISOString()),
      db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,
        source_type,status,access_terms_id,entitlement_version) VALUES(?,?,?,'delivery.view','allow','project',?,'operations','active',?,2)`)
        .bind(`term-entitlement-${term.suffix}`,term.workspace,term.identity,term.project,termId),
      db.prepare("UPDATE portal_authenticated_delivery_change_batches SET eligible_at=datetime('now','-1 second') WHERE workspace_id=?").bind(term.workspace),
    ]);
    await new Promise(resolve=>setTimeout(resolve,1_300));
    const send=vi.fn();await dispatchAuthenticatedDeliveryChangeNotifications(env,{send});
    expect(send).not.toHaveBeenCalled();expect((await batches(term))[0]).toMatchObject({status:"suppressed"});

    for(const denialKind of ["entitlement","identity"] as const){
      const f=await fixture(`relation-${denialKind}`);await optIn(f);await add(f,"photo.jpg");
      const department=`department-${f.suffix}`;
      await db.batch([
        db.prepare("INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version) VALUES(?,?,'department',?,?,?,'v1')")
          .bind(f.workspace,f.generation,department,f.organization,department),
        db.prepare(`INSERT INTO portal_v2_directory_relations(workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version)
          VALUES(?,?,?,'contains','department',?,'project',?,'v1')`).bind(f.workspace,f.generation,`relation-${f.suffix}`,department,f.project),
        db.prepare("UPDATE portal_authenticated_delivery_change_batches SET eligible_at=datetime('now','-1 second') WHERE workspace_id=?").bind(f.workspace),
      ]);
      if(denialKind==="entitlement")await db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
        VALUES(?,?,?,'delivery.view','deny','department',?,'operations','active')`).bind(`relation-deny-${f.suffix}`,f.workspace,f.identity,department).run();
      else await db.prepare(`INSERT INTO portal_v2_identity_denials(id,identity_id,workspace_id,scope_type,scope_public_id,reason_code,created_by_actor_type,created_by_actor_id)
        VALUES(?,?,?,'department',?,'test','staff','staff-a')`).bind(`identity-deny-${f.suffix}`,f.identity,f.workspace,department).run();
      const prior=env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED;env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED="true";
      const calls=send.mock.calls.length;await dispatchAuthenticatedDeliveryChangeNotifications(env,{send});
      env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED=prior;
      expect(send.mock.calls).toHaveLength(calls);expect((await batches(f))[0]).toMatchObject({status:"suppressed"});
    }
  });

  it("does not alter legacy subscriptions or Project Alpha delivery-intent rows", async () => {
    const beforeLegacy=await db.prepare("SELECT count(*) n FROM client_folder_notification_preferences").first("n");
    const beforeIntent=await db.prepare("SELECT count(*) n FROM project_alpha_delivery_intent_receipts").first("n");
    const f=await fixture("compatibility");await optIn(f);await add(f,"photo.jpg");
    expect(await db.prepare("SELECT count(*) n FROM client_folder_notification_preferences").first("n")).toBe(beforeLegacy);
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_delivery_intent_receipts").first("n")).toBe(beforeIntent);
  });

  it("keeps staging out of browser and individual upload routes", () => {
    const directory=new URL("../src/worker/",import.meta.url);
    const owners=readdirSync(directory).filter(name=>name.endsWith(".ts") &&
      readFileSync(new URL(name,directory),"utf8").includes("recordAuthenticatedDeliveryObjectChange("));
    expect(owners.sort()).toEqual(["authenticated-delivery-change-notifications.ts","file-events.ts"]);
    const consumer=readFileSync(new URL("../src/worker/file-events.ts",import.meta.url),"utf8");
    expect(consumer.match(/recordAuthenticatedDeliveryObjectChange\(/g)).toHaveLength(3);
  });
});
