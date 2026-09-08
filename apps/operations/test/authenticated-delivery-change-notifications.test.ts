import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { provisionPortalSourceAuthority, reservePrimaryPortalSigningKeys, setPortalSourceAuthorityState,
  type PortalAuthorityConnectorIdentity } from "../../client/src/worker/project-alpha-portal-authority";
import {
  AUTHENTICATED_DELIVERY_CHANGE_CANDIDATE_LIMIT,
  authenticatedDeliveryChangeCandidatesSql,
  authenticatedDeliveryChangeNotificationsReady,
  controlAuthenticatedDeliveryChangeBatch,
  dispatchAuthenticatedDeliveryChangeNotifications,
  recordAuthenticatedDeliveryObjectChange,
  saveAuthenticatedDeliveryNotificationPolicy,
  stageAuthenticatedDeliveryChangeForTarget,
  type AuthenticatedDeliveryChangeTarget,
} from "../src/worker/authenticated-delivery-change-notifications";
import {
  publishAuthenticatedDeliveryChangeBellBatch,
  publishAuthenticatedDeliveryChangeBells,
  suppressAuthenticatedDeliveryChangeEmail,
} from "../src/worker/authenticated-delivery-bell";
import type { Env } from "../src/worker/types";

describe("exact authenticated delivery change notifications — migrated real D1", {timeout: 240_000}, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;
  let counter = 0;
  let primaryReceiptsInstalled = false;

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
    for (const name of ["0170_authenticated_delivery_change_notifications.sql", "0189_primary_staff_folder_bindings.sql", "0204_delivery_change_receipts.sql", "0205_authenticated_delivery_change_sequence.sql", "0208_authenticated_delivery_change_batch_provider_identity.sql", "0209_authenticated_delivery_change_recipient_events.sql"])
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(`../../client/migrations/${name}`,import.meta.url),"utf8"))
        .map(sql => db.prepare(sql)));
    primaryReceiptsInstalled = true;
    expect(await db.prepare("SELECT * FROM portal_v2_authenticated_delivery_grants WHERE id=?").bind(before.grant).first()).toEqual(preserved.grant);
    expect(await db.prepare("SELECT * FROM portal_v2_authenticated_delivery_grant_recipients WHERE grant_id=?").bind(before.grant).first()).toEqual(preserved.recipient);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(await db.prepare("PRAGMA quick_check('portal_authenticated_delivery_change_batches')").first("quick_check")).toBe("ok");
    expect(await db.prepare("SELECT count(*) n FROM portal_authenticated_delivery_notification_policies").first("n")).toBe(0);
    await expect(db.prepare("UPDATE portal_v2_workspaces SET project_alpha_source_id='project-alpha:other' WHERE id=?")
      .bind(before.workspace).run()).rejects.toThrow();
    await expect(db.prepare("UPDATE portal_v2_authenticated_delivery_grants SET grant_version=2 WHERE id=?")
      .bind(before.grant).run()).rejects.toThrow();
    env = {DELIVERY_DB:db,AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED:"true",DELIVERY_BASE_URL:"https://client.example.test",
      PROJECT_ALPHA_PORTAL_HMAC_SECRET:"primary-portal-hmac-test-key-material-at-least-thirty-two-bytes",
      PROJECT_ALPHA_CONNECTOR_CREDENTIALS:JSON.stringify({version:1,sets:{bell_secondary:{portalCurrent:{keyId:"bell-secondary-current",
        value:"bell-secondary-portal-key-material-at-least-thirty-two-bytes"}}}})} as Env;
    await reservePrimaryPortalSigningKeys(env);
  },180_000);
  beforeEach(async () => {
    // Keep independent cases from dispatching an earlier fixture merely
    // because the complete migrated-D1 run takes longer than the quiet period.
    // Each dispatch case explicitly makes only its own batches eligible.
    await db.prepare("UPDATE portal_authenticated_delivery_change_batches SET eligible_at=datetime('now','+1 day') WHERE status='pending'").run();
  });
  afterAll(async () => runtime?.dispose());

  async function fixture(label: string, prefix?: string, bindingSourceType: "operations"|"legacy" = "operations") {
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
      db.prepare(`INSERT INTO pa_portal_projection_generations
        (id,workspace_id,source_generation,source_sequence,snapshot_hash,page_count,record_count,workspace_root_type,
          workspace_root_public_id,workspace_display_name,workspace_source_version,workspace_active,status,complete,projection_source_id)
        VALUES(?,?,?,1,?,1,2,'organization',?,?,'v1',1,'active',1,'project-alpha:primary')`)
        .bind(`snapshot-${suffix}`,workspace,generation,"a".repeat(64),organization,`Workspace ${suffix}`),
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
      db.prepare("INSERT INTO pa_portal_projection_checkpoints(workspace_id,source_generation,source_sequence,snapshot_generation_id) VALUES(?,?,1,?)")
        .bind(workspace,generation,`snapshot-${suffix}`),
      db.prepare("INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version) VALUES(?,?,'project',?,? ,?,'v1')")
        .bind(binding,workspace,project,r2Prefix,bindingSourceType),
      ...(primaryReceiptsInstalled&&bindingSourceType==="operations" ? [db.prepare(`INSERT INTO portal_primary_staff_bindings
        (binding_id,workspace_id,source_id,root_type,root_public_id,owner_scope_type,owner_public_id,project_public_id,
          directory_generation_id,snapshot_generation_id,source_sequence,root_source_version,project_source_version,r2_prefix,
          ops_project_id,ops_context_version,created_by_staff_id,reason_code,state)
        VALUES(?,?,'project-alpha:primary','organization',?,'project',?,?,?, ?,1,'v1','v1',?, ?,?,?, 'migration_0189_legacy_compat','active')`)
        .bind(binding,workspace,organization,project,project,generation,`snapshot-${suffix}`,r2Prefix,project,"0".repeat(64),"staff-a")] : []),
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

  async function secondaryFixture(label: string, nativeState: "pending"|"active" = "active") {
    counter++;
    const suffix=`${label}-${counter}`,sourceId=`project-alpha:bell${counter}`,workspace=`workspace-${suffix}`,
      identity=`identity-${suffix}`,principal=`principal-${suffix}`,organization=`organization-${suffix}`,
      project=`project-${suffix}`,generation=`generation-${suffix}`,binding=`binding-${suffix}`,
      grant=`grant-${suffix}`,logical=`logical-${suffix}`,prefix=`Jobs/Clients/${suffix}/`;
    const connector: PortalAuthorityConnectorIdentity={sourceId,producerBindingId:`binding-${suffix}`,
      snapshotOrigin:"https://secondary.example.test",snapshotBasePath:"/portal",applicationKey:`bell${counter}`,
      profile:"business_data",revision:1,version:1,state:"active"};
    // Source authorities reserve signing fingerprints globally. Give every
    // synthetic source its own configured test key, while retaining prior
    // entries so earlier source proofs remain resolvable in this shared D1.
    const credentialRef=`bell_secondary_${counter}`;
    const credentials=JSON.parse(env.PROJECT_ALPHA_CONNECTOR_CREDENTIALS ?? "{}") as {version?:number;sets?:Record<string,unknown>};
    credentials.version=1;credentials.sets ??={};
    credentials.sets[credentialRef]={portalCurrent:{keyId:`bell-secondary-current-${counter}`,
      value:`bell-secondary-${counter}-portal-key-material-at-least-thirty-two-bytes`}};
    env.PROJECT_ALPHA_CONNECTOR_CREDENTIALS=JSON.stringify(credentials);
    await provisionPortalSourceAuthority(env,connector,{credentialRef,accessIssuer:"https://secondary.example.test",
      accessAudience:"bell-secondary",accessSubject:"bell-secondary-subject"},null,"staff-a");
    await setPortalSourceAuthorityState(env,connector,1,"active","staff-a");
    await db.batch([
      db.prepare("INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id) VALUES(?,?,?)")
        .bind(workspace,sourceId,`source-${suffix}`),
      db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES(?,?,?,?)")
        .bind(identity,"https://access.example.test",`subject-${suffix}`,`${suffix}@example.test`),
      db.prepare("INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id) VALUES(?,'organization',?,?,'active',?)")
        .bind(workspace,organization,`Workspace ${suffix}`,sourceId),
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
        .bind(binding,workspace,project,prefix),
      db.prepare(`INSERT INTO portal_native_staff_bindings
        (binding_id,source_id,workspace_id,project_id,project_public_id,r2_prefix,division_id)
        VALUES(?,?,?,?,?,?,?)`).bind(binding,sourceId,workspace,`ops-project-${suffix}`,project,prefix,`division-${suffix}`),
      db.prepare("INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status) VALUES(?,?,?,?,?,'pv1','active')")
        .bind(workspace,principal,identity,`${suffix}@example.test`,`Person ${suffix}`),
      db.prepare("INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status) VALUES(?,?,?,'delivery.view','allow','project',?,'operations','active')")
        .bind(`entitlement-${suffix}`,workspace,identity,project),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants(id,logical_grant_id,grant_version,workspace_id,folder_binding_id,
        binding_source_version,audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id)
        VALUES(?,?,1,?,?,'v1','principal',?,'pv1','test','staff-a')`).bind(grant,logical,workspace,binding,principal),
      db.prepare("INSERT INTO portal_v2_authenticated_delivery_grant_recipients(grant_id,workspace_id,principal_public_id,identity_id,principal_source_version) VALUES(?,?,?,?, 'pv1')")
        .bind(grant,workspace,principal,identity),
      db.prepare(`INSERT INTO portal_native_staff_grants
        (grant_id,binding_id,source_id,authorization_id,actor_id,idempotency_key,fingerprint,state,publication_deadline)
        VALUES(?,?,?,?,?,?,?,'pending',datetime('now','+1 hour'))`)
        .bind(grant,binding,sourceId,`authorization-${suffix}`,"staff-a",`native-${suffix}-00000000`,"f".repeat(64)),
      ...(nativeState==="active"?[db.prepare("UPDATE portal_native_staff_grants SET state='active' WHERE grant_id=? AND state='pending'")
        .bind(grant)]:[]),
    ]);
    // Policy mutation is deliberately primary-only today. Seed the exact
    // existing opt-in snapshot so these tests isolate native receipt fencing.
    await db.prepare(`INSERT INTO portal_authenticated_delivery_notification_policies
      (grant_id,grant_version,logical_grant_id,workspace_id,source_id,identity_id,principal_public_id,principal_source_version,
        access_notice_enabled,change_mode,policy_version,updated_by_staff_id)
      VALUES(?,1,?,?,?,?,?,?,1,'both',1,'staff-a')`)
      .bind(grant,logical,workspace,sourceId,identity,principal,"pv1").run();
    return {suffix,workspace,identity,principal,organization,project,generation,binding,grant,logical,prefix,connector};
  }

  async function savedTarget(f: Awaited<ReturnType<typeof fixture>>, key: string, eventAt: string) {
    const rows = await db.prepare(authenticatedDeliveryChangeCandidatesSql())
      .bind(key,"added",eventAt,AUTHENTICATED_DELIVERY_CHANGE_CANDIDATE_LIMIT+1).all<AuthenticatedDeliveryChangeTarget>();
    expect(rows.results).toHaveLength(1);
    return rows.results[0]!;
  }

  async function addMatchingRecipient(f: Awaited<ReturnType<typeof fixture>>) {
    const suffix=`${f.suffix}-second`,identity=`identity-${suffix}`,principal=`principal-${suffix}`,
      grant=`grant-${suffix}`,logical=`logical-${suffix}`;
    await db.batch([
      db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES(?,?,?,?)")
        .bind(identity,"https://access.example.test",`subject-${suffix}`,`${suffix}@example.test`),
      db.prepare("INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status) VALUES(?,?,?,'operations','active')")
        .bind(`membership-${suffix}`,f.workspace,identity),
      db.prepare("INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status) VALUES(?,?,?,?,?,'pv1','active')")
        .bind(f.workspace,principal,identity,`${suffix}@example.test`,`Person ${suffix}`),
      db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,
        source_type,status) VALUES(?,?,?,'delivery.view','allow','project',?,'operations','active')`)
        .bind(`entitlement-${suffix}`,f.workspace,identity,f.project),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants(id,logical_grant_id,grant_version,workspace_id,folder_binding_id,
        binding_source_version,audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id)
        VALUES(?,?,1,?,?,'v1','principal',?,'pv1','test','staff-a')`).bind(grant,logical,f.workspace,f.binding,principal),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_recipients
        (grant_id,workspace_id,principal_public_id,identity_id,principal_source_version) VALUES(?,?,?,?, 'pv1')`)
        .bind(grant,f.workspace,principal,identity),
    ]);
    await saveAuthenticatedDeliveryNotificationPolicy(env,"staff-a",{grantId:grant,identityId:identity,
      expectedPolicyVersion:null,accessNoticeEnabled:true,changeMode:"added",idempotencyKey:`policy-${suffix}-00000000`});
    return {identity,grant};
  }

  async function batches(f: Awaited<ReturnType<typeof fixture>>) {
    return (await db.prepare(`SELECT * FROM portal_authenticated_delivery_change_batches WHERE workspace_id=? ORDER BY created_at,id`)
      .bind(f.workspace).all<Record<string,unknown>>()).results;
  }

  function envWithStagingBatchHook(hook: () => Promise<void>): Env {
    const sql = new WeakMap<object,string>();
    let fired = false;
    let proxy: D1Database;
    const wrap = (statement: D1PreparedStatement, text: string): D1PreparedStatement => {
      const wrapped = new Proxy(statement, { get(target, key) {
        if (key === "bind") return (...bindings: unknown[]) => wrap(target.bind(...bindings), text);
        const member = target[key as keyof D1PreparedStatement];
        return typeof member === "function" ? member.bind(target) : member;
      } });
      sql.set(wrapped, text);
      return wrapped;
    };
    proxy = new Proxy(db, { get(target, key) {
      if (key === "withSession") return () => proxy;
      if (key === "prepare") return (text: string) => wrap(target.prepare(text), text);
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        if (!fired && statements.some(statement => (sql.get(statement) ?? "").includes("portal_authenticated_delivery_change_batch_items"))) {
          fired = true;
          await hook();
        }
        return target.batch(statements);
      };
      const member = target[key as keyof D1Database];
      return typeof member === "function" ? member.bind(target) : member;
    } });
    return {...env,DELIVERY_DB:proxy} as Env;
  }

  function envWithDuplicateHighWaterHook(hook: () => Promise<void>): Env {
    const sql = new WeakMap<object,string>();
    let fired = false;
    let proxy: D1Database;
    const wrap = (statement: D1PreparedStatement, text: string): D1PreparedStatement => {
      const wrapped = new Proxy(statement, { get(target, key) {
        if (key === "bind") return (...bindings: unknown[]) => wrap(target.bind(...bindings), text);
        if (key === "run") return async () => {
          if (!fired && text.includes("SET observed_event_at=?")) { fired=true; await hook(); }
          return target.run();
        };
        const member = target[key as keyof D1PreparedStatement];
        return typeof member === "function" ? member.bind(target) : member;
      } });
      sql.set(wrapped, text);
      return wrapped;
    };
    proxy = new Proxy(db, { get(target, key) {
      if (key === "withSession") return () => proxy;
      if (key === "prepare") return (text: string) => wrap(target.prepare(text), text);
      const member = target[key as keyof D1Database];
      return typeof member === "function" ? member.bind(target) : member;
    } });
    return {...env,DELIVERY_DB:proxy} as Env;
  }

  function eventTimes() {
    const second=Math.floor((Date.now()+60_000)/1_000)*1_000;
    return [100,200,300].map(milliseconds=>new Date(second+milliseconds).toISOString()) as [string,string,string];
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

  it("fences a stale event behind a newer object-version winner before it can mutate the batch item", async () => {
    const f=await fixture("stale-fence");await optIn(f);
    const key=`${f.prefix}photo.jpg`,[old,,newer]=eventTimes();let hookFired=false;
    const raced=envWithStagingBatchHook(async()=>{
      hookFired=true;
      expect(await recordAuthenticatedDeliveryObjectChange(env,key,true,"v2",newer)).toBe(1);
    });
    expect(await recordAuthenticatedDeliveryObjectChange(raced,key,true,"v1",old)).toBe(0);
    expect(hookFired).toBe(true);
    const fingerprint=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(`authenticated-delivery-object:v1:${key}`));
    const hash=[...new Uint8Array(fingerprint)].map(value=>value.toString(16).padStart(2,"0")).join("");
    expect(await db.prepare(`SELECT current_object_version,observed_event_at FROM portal_authenticated_delivery_change_object_versions
      WHERE grant_id=? AND grant_version=1 AND identity_id=? AND object_fingerprint=?`).bind(f.grant,f.identity,hash).first())
      .toMatchObject({current_object_version:"v2",observed_event_at:newer});
    expect(await db.prepare(`SELECT current_object_version FROM portal_authenticated_delivery_change_batch_items WHERE object_fingerprint=?`)
      .bind(hash).first("current_object_version")).toBe("v2");
  });

  it("throws a retryable staging fence loss instead of mutating an already claimed publication", async () => {
    const f=await fixture("sealed-fence");await optIn(f);
    const [existingAt,eventAt]=eventTimes();
    expect(await add(f,"existing.jpg","existing-v1",existingAt)).toBe(1);
    const key=`${f.prefix}photo.jpg`;let hookFired=false;
    let before: {items:number;states:number;audit:number}|undefined;
    const raced=envWithStagingBatchHook(async()=>{
      hookFired=true;
      await db.prepare(`UPDATE portal_authenticated_delivery_change_batches SET status='processing',sealed_at=datetime('now'),revision=revision+1
        WHERE workspace_id=?`).bind(f.workspace).run();
      before={
        items:Number(await db.prepare(`SELECT count(*) count FROM portal_authenticated_delivery_change_batch_items item
          JOIN portal_authenticated_delivery_change_batches batch ON batch.id=item.batch_id WHERE batch.workspace_id=?`).bind(f.workspace).first("count")),
        states:Number(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_object_versions WHERE grant_id=?").bind(f.grant).first("count")),
        audit:Number(await db.prepare(`SELECT count(*) count FROM portal_authenticated_delivery_change_audit audit
          JOIN portal_authenticated_delivery_change_batches batch ON batch.id=audit.batch_id WHERE batch.workspace_id=?`).bind(f.workspace).first("count")),
      };
    });
    await expect(recordAuthenticatedDeliveryObjectChange(raced,key,true,"v1",eventAt))
      .rejects.toThrow("authenticated-delivery-notification-staging-fence-lost");
    expect(hookFired).toBe(true);
    expect(before).toEqual({items:1,states:1,audit:1});
    expect({
      items:Number(await db.prepare(`SELECT count(*) count FROM portal_authenticated_delivery_change_batch_items item
        JOIN portal_authenticated_delivery_change_batches batch ON batch.id=item.batch_id WHERE batch.workspace_id=?`).bind(f.workspace).first("count")),
      states:Number(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_object_versions WHERE grant_id=?").bind(f.grant).first("count")),
      audit:Number(await db.prepare(`SELECT count(*) count FROM portal_authenticated_delivery_change_audit audit
        JOIN portal_authenticated_delivery_change_batches batch ON batch.id=audit.batch_id WHERE batch.workspace_id=?`).bind(f.workspace).first("count")),
    }).toEqual(before);
    expect(await recordAuthenticatedDeliveryObjectChange(env,key,true,"v1",eventAt)).toBe(1);
    expect(await batches(f)).toHaveLength(2);
  });

  it("advances duplicate object-version high-water marks at millisecond precision", async () => {
    const f=await fixture("millisecond-high-water");await optIn(f);
    const [added,delayedRemoval,duplicate]=eventTimes();
    expect(await add(f,"photo.jpg","v1",added)).toBe(1);
    expect(await add(f,"photo.jpg","v1",duplicate)).toBe(0);
    expect(await remove(f,"photo.jpg","v1",delayedRemoval)).toBe(0);
    expect((await batches(f))[0]).toMatchObject({status:"pending",added_count:1,removed_count:0});
    expect(await db.prepare(`SELECT observed_event_at,current_present,current_object_version
      FROM portal_authenticated_delivery_change_object_versions WHERE grant_id=? AND identity_id=?`).bind(f.grant,f.identity).first())
      .toMatchObject({observed_event_at:duplicate,current_present:1,current_object_version:"v1"});
  });

  it("rejects a delayed event from before an enabled policy created in the same UTC second", async () => {
    const f=await fixture("same-second-prepolicy");
    const [eventAt,,policyAt]=eventTimes(),key=`${f.prefix}photo.jpg`;
    await db.prepare(`INSERT INTO portal_authenticated_delivery_notification_policies
      (grant_id,grant_version,logical_grant_id,workspace_id,source_id,identity_id,principal_public_id,principal_source_version,
        access_notice_enabled,change_mode,policy_version,updated_by_staff_id,created_at,updated_at)
      VALUES(?,1,?,?,'project-alpha:primary',?,?,'pv1',1,'added',1,'staff-a',?,?)`)
      .bind(f.grant,f.logical,f.workspace,f.identity,f.principal,policyAt,policyAt).run();
    expect(await recordAuthenticatedDeliveryObjectChange(env,key,true,"v1",eventAt)).toBe(0);
    expect(await batches(f)).toEqual([]);
  });

  it("does not backfill an event that predates a later policy opt-in", async () => {
    const f=await fixture("pre-opt-in");
    const [createdAt,eventAt,enabledAt]=eventTimes(),key=`${f.prefix}photo.jpg`;
    await db.prepare(`INSERT INTO portal_authenticated_delivery_notification_policies
      (grant_id,grant_version,logical_grant_id,workspace_id,source_id,identity_id,principal_public_id,principal_source_version,
        access_notice_enabled,change_mode,policy_version,updated_by_staff_id,created_at,updated_at)
      VALUES(?,1,?,?,'project-alpha:primary',?,?,'pv1',0,'off',1,'staff-a',?,?)`)
      .bind(f.grant,f.logical,f.workspace,f.identity,f.principal,createdAt,createdAt).run();
    await db.prepare(`UPDATE portal_authenticated_delivery_notification_policies
      SET access_notice_enabled=1,change_mode='added',policy_version=2,updated_at=? WHERE grant_id=? AND identity_id=?`)
      .bind(enabledAt,f.grant,f.identity).run();

    expect(await recordAuthenticatedDeliveryObjectChange(env,key,true,"v1",eventAt)).toBe(0);
    expect(await batches(f)).toEqual([]);
  });

  it("retries staging when the selected policy version changes at the final authority fence", async () => {
    const f=await fixture("policy-fence");const first=await optIn(f,"added");
    const [eventAt]=eventTimes(),key=`${f.prefix}photo.jpg`;let hookFired=false;
    const raced=envWithStagingBatchHook(async()=>{
      hookFired=true;
      await saveAuthenticatedDeliveryNotificationPolicy(env,"staff-a",{grantId:f.grant,identityId:f.identity,
        expectedPolicyVersion:first.policy_version,accessNoticeEnabled:true,changeMode:"added",
        idempotencyKey:`policy-fence-${f.suffix}-000000`});
    });
    await expect(recordAuthenticatedDeliveryObjectChange(raced,key,true,"v1",eventAt))
      .rejects.toThrow("authenticated-delivery-notification-staging-fence-lost");
    expect(hookFired).toBe(true);
    expect(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_object_versions WHERE grant_id=?").bind(f.grant).first("count")).toBe(0);
    expect(await batches(f)).toEqual([]);
    expect(await recordAuthenticatedDeliveryObjectChange(env,key,true,"v1",eventAt)).toBe(1);
    expect((await batches(f))[0]).toMatchObject({policy_version:2,added_count:1});
  });

  it("rejects a legacy binding whose owner or prefix changed after candidate selection", async () => {
    const f=await fixture("binding-snapshot",undefined,"legacy");await optIn(f,"added");
    const [eventAt]=eventTimes(),key=`${f.prefix}photo.jpg`,movedPrefix=`${f.prefix}moved/`;let hookFired=false;
    const raced=envWithStagingBatchHook(async()=>{
      hookFired=true;
      await db.prepare("UPDATE portal_v2_folder_bindings SET r2_prefix=? WHERE id=?").bind(movedPrefix,f.binding).run();
    });
    await expect(recordAuthenticatedDeliveryObjectChange(raced,key,true,"v1",eventAt))
      .rejects.toThrow("authenticated-delivery-notification-staging-fence-lost");
    expect(hookFired).toBe(true);
    expect(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_object_versions WHERE grant_id=?").bind(f.grant).first("count")).toBe(0);
    expect(await batches(f)).toEqual([]);
    expect(await recordAuthenticatedDeliveryObjectChange(env,key,true,"v1",eventAt)).toBe(0);
    await db.prepare("UPDATE portal_v2_folder_bindings SET r2_prefix=? WHERE id=?").bind(f.prefix,f.binding).run();
    expect(await recordAuthenticatedDeliveryObjectChange(env,key,true,"v1",eventAt)).toBe(1);
  });

  it("retries a 49-to-50 capacity fence loss and stages the replay in a successor", async () => {
    const f=await fixture("capacity-fence");await optIn(f,"added");
    for(let index=0;index<49;index++)expect(await add(f,`${index}.jpg`)).toBe(1);
    const [outerAt,innerAt]=eventTimes(),outerKey=`${f.prefix}outer.jpg`;let hookFired=false;
    const raced=envWithStagingBatchHook(async()=>{
      hookFired=true;
      expect(await add(f,"fiftieth.jpg","fiftieth-v1",innerAt)).toBe(1);
    });
    await expect(recordAuthenticatedDeliveryObjectChange(raced,outerKey,true,"outer-v1",outerAt))
      .rejects.toThrow("authenticated-delivery-notification-staging-fence-lost");
    expect(hookFired).toBe(true);
    expect(await recordAuthenticatedDeliveryObjectChange(env,outerKey,true,"outer-v1",outerAt)).toBe(1);
    const rows=await batches(f);
    expect(rows.map(row=>row.added_count)).toEqual([50,1]);
    expect(rows[0]).toMatchObject({sealed_at:expect.any(String)});
  },180_000);

  it("retries a duplicate high-water CAS loss when an intervening newer state makes the event a transition", async () => {
    const f=await fixture("duplicate-cas");await optIn(f);
    const [first,removed,readded]=eventTimes(),key=`${f.prefix}photo.jpg`;
    expect(await add(f,"photo.jpg","v1",first)).toBe(1);let hookFired=false;
    const raced=envWithDuplicateHighWaterHook(async()=>{
      hookFired=true;
      expect(await remove(f,"photo.jpg","v1",removed)).toBe(1);
    });
    await expect(recordAuthenticatedDeliveryObjectChange(raced,key,true,"v1",readded))
      .rejects.toThrow("authenticated-delivery-notification-staging-fence-lost");
    expect(hookFired).toBe(true);
    expect(await recordAuthenticatedDeliveryObjectChange(env,key,true,"v1",readded)).toBe(1);
  });

  it("does not create a second notification when a concurrent same-state observation already claimed the first batch", async () => {
    const f=await fixture("same-state-claim");await optIn(f);
    const [eventAt]=eventTimes(),key=`${f.prefix}photo.jpg`;let hookFired=false;
    const raced=envWithStagingBatchHook(async()=>{
      hookFired=true;
      expect(await recordAuthenticatedDeliveryObjectChange(env,key,true,"v1",eventAt)).toBe(1);
      await db.prepare(`UPDATE portal_authenticated_delivery_change_batches SET status='processing',sealed_at=datetime('now'),revision=revision+1
        WHERE workspace_id=?`).bind(f.workspace).run();
    });
    expect(await recordAuthenticatedDeliveryObjectChange(raced,key,true,"v1",eventAt)).toBe(0);
    expect(hookFired).toBe(true);
    expect(await batches(f)).toHaveLength(1);
    expect((await batches(f))[0]).toMatchObject({status:"processing",added_count:1});
  });

  it("stages only a saved recipient target when a later policy would otherwise fan out", async () => {
    const f=await fixture("target-no-fanout");await optIn(f,"added");
    const key=`${f.prefix}photo.jpg`,eventAt=new Date(Date.now()+60_000).toISOString(),target=await savedTarget(f,key,eventAt);
    const later=await addMatchingRecipient(f);
    const candidates=await db.prepare(authenticatedDeliveryChangeCandidatesSql())
      .bind(key,"added",eventAt,AUTHENTICATED_DELIVERY_CHANGE_CANDIDATE_LIMIT+1).all<AuthenticatedDeliveryChangeTarget>();
    expect(candidates.results.map(row=>row.identity_id).sort()).toEqual([f.identity,later.identity].sort());

    expect(await stageAuthenticatedDeliveryChangeForTarget(env,target,{key,present:true,objectVersion:"v1",eventAt})).toBe("staged");
    expect(await batches(f)).toMatchObject([{identity_id:f.identity,grant_id:f.grant,added_count:1}]);
    expect(await db.prepare("SELECT count(*) count FROM portal_authenticated_delivery_change_batches WHERE grant_id=?")
      .bind(later.grant).first("count")).toBe(0);
  });

  it("suppresses a saved target when its policy version is no longer current", async () => {
    const f=await fixture("target-policy-suppressed");const policy=await optIn(f,"added");
    const key=`${f.prefix}photo.jpg`,eventAt=new Date(Date.now()+60_000).toISOString(),target=await savedTarget(f,key,eventAt);
    await saveAuthenticatedDeliveryNotificationPolicy(env,"staff-a",{grantId:f.grant,identityId:f.identity,
      expectedPolicyVersion:policy.policy_version,accessNoticeEnabled:true,changeMode:"added",
      idempotencyKey:`target-policy-update-${f.suffix}-000000`});

    expect(await stageAuthenticatedDeliveryChangeForTarget(env,target,{key,present:true,objectVersion:"v1",eventAt})).toBe("suppressed");
    expect(await batches(f)).toEqual([]);
  });

  it("stages an unchanged saved target once and reports its replay as duplicate", async () => {
    const f=await fixture("target-once");await optIn(f,"added");
    const key=`${f.prefix}photo.jpg`,eventAt=new Date(Date.now()+60_000).toISOString(),target=await savedTarget(f,key,eventAt);
    const input={key,present:true,objectVersion:"v1",eventAt};
    expect(await stageAuthenticatedDeliveryChangeForTarget(env,target,input)).toBe("staged");
    expect(await stageAuthenticatedDeliveryChangeForTarget(env,target,input)).toBe("duplicate");
    expect(await batches(f)).toMatchObject([{identity_id:f.identity,grant_id:f.grant,added_count:1}]);
  });

  it("orders equal-timestamp durable receipts by accepted sequence", async () => {
    const f=await fixture("target-sequence-equal");await optIn(f,"both");
    const key=`${f.prefix}photo.jpg`,eventAt=new Date(Date.now()+60_000).toISOString(),target=await savedTarget(f,key,eventAt);
    expect(await stageAuthenticatedDeliveryChangeForTarget(env,target,{
      key,present:true,objectVersion:"content-v1",eventAt,acceptedSequence:1,providerObjectVersion:"r2-upload-v1",
    })).toBe("staged");
    expect(await stageAuthenticatedDeliveryChangeForTarget(env,target,{
      key,present:false,objectVersion:"content-v1",eventAt,acceptedSequence:2,providerObjectVersion:"r2-upload-v1",
    })).toBe("staged");
    expect(await db.prepare(`SELECT current_present,current_object_version,accepted_sequence,provider_object_version,observed_event_at
      FROM portal_authenticated_delivery_change_object_versions WHERE grant_id=? AND identity_id=?`).bind(f.grant,f.identity).first())
      .toMatchObject({current_present:0,current_object_version:"content-v1",accepted_sequence:2,provider_object_version:"r2-upload-v1",observed_event_at:eventAt});
  });

  it("accepts a newer durable sequence despite an older event timestamp, then rejects stale sequence replay", async () => {
    const f=await fixture("target-sequence-stale");await optIn(f,"both");
    const key=`${f.prefix}photo.jpg`,earlier=new Date(Date.now()+60_000).toISOString(),later=new Date(Date.now()+120_000).toISOString(),target=await savedTarget(f,key,later);
    expect(await stageAuthenticatedDeliveryChangeForTarget(env,target,{
      key,present:true,objectVersion:"content-v1",eventAt:later,acceptedSequence:1,providerObjectVersion:"r2-upload-v1",
    })).toBe("staged");
    expect(await stageAuthenticatedDeliveryChangeForTarget(env,target,{
      key,present:false,objectVersion:"content-v1",eventAt:earlier,acceptedSequence:2,providerObjectVersion:"r2-upload-v1",
    })).toBe("staged");
    expect(await stageAuthenticatedDeliveryChangeForTarget(env,target,{
      key,present:true,objectVersion:"content-v1",eventAt:new Date(Date.now()+180_000).toISOString(),acceptedSequence:1,providerObjectVersion:"r2-upload-v1",
    })).toBe("duplicate");
    expect(await db.prepare("SELECT current_present,accepted_sequence,provider_object_version FROM portal_authenticated_delivery_change_object_versions WHERE grant_id=? AND identity_id=?")
      .bind(f.grant,f.identity).first()).toMatchObject({current_present:0,accepted_sequence:2,provider_object_version:"r2-upload-v1"});
  });

  it("does not collapse same-ETag uploads with distinct provider versions, but deduplicates the newest receipt", async () => {
    const f=await fixture("target-provider-version");await optIn(f,"added");
    const key=`${f.prefix}photo.jpg`,eventAt=new Date(Date.now()+60_000).toISOString(),target=await savedTarget(f,key,eventAt);
    const first={key,present:true,objectVersion:"same-content-etag",eventAt,acceptedSequence:1,providerObjectVersion:"r2-upload-one"};
    const newest={...first,acceptedSequence:2,providerObjectVersion:"r2-upload-two"};
    expect(await stageAuthenticatedDeliveryChangeForTarget(env,target,first)).toBe("staged");
    expect(await stageAuthenticatedDeliveryChangeForTarget(env,target,newest)).toBe("staged");
    expect(await stageAuthenticatedDeliveryChangeForTarget(env,target,newest)).toBe("duplicate");
    expect(await db.prepare("SELECT current_object_version,accepted_sequence,provider_object_version FROM portal_authenticated_delivery_change_object_versions WHERE grant_id=? AND identity_id=?")
      .bind(f.grant,f.identity).first()).toMatchObject({current_object_version:"same-content-etag",accepted_sequence:2,provider_object_version:"r2-upload-two"});
  });

  it("advances same-provider sequence only as high-water until a remove/re-add is a new action", async () => {
    const f=await fixture("target-provider-readd");await optIn(f,"both");
    const key=`${f.prefix}photo.jpg`,eventAt=new Date(Date.now()+60_000).toISOString(),target=await savedTarget(f,key,eventAt);
    expect(await stageAuthenticatedDeliveryChangeForTarget(env,target,{
      key,present:true,objectVersion:"same-content-etag",eventAt,acceptedSequence:1,providerObjectVersion:"r2-upload-one",
    })).toBe("staged");
    expect(await stageAuthenticatedDeliveryChangeForTarget(env,target,{
      key,present:true,objectVersion:"same-content-etag",eventAt,acceptedSequence:2,providerObjectVersion:"r2-upload-one",
    })).toBe("duplicate");
    expect(await stageAuthenticatedDeliveryChangeForTarget(env,target,{
      key,present:false,objectVersion:"same-content-etag",eventAt,acceptedSequence:3,providerObjectVersion:"r2-upload-one",
    })).toBe("staged");
    expect(await stageAuthenticatedDeliveryChangeForTarget(env,target,{
      key,present:true,objectVersion:"same-content-etag",eventAt,acceptedSequence:4,providerObjectVersion:"r2-upload-two",
    })).toBe("staged");
    expect(await db.prepare("SELECT current_present,accepted_sequence,provider_object_version FROM portal_authenticated_delivery_change_object_versions WHERE grant_id=? AND identity_id=?")
      .bind(f.grant,f.identity).first()).toMatchObject({current_present:1,accepted_sequence:4,provider_object_version:"r2-upload-two"});
  });

  it("rejects partial durable pairs, same-sequence conflicts, and legacy overwrite of a sequenced object", async () => {
    const f=await fixture("sequence-invariants");await optIn(f,"both");
    const key=`${f.prefix}photo.jpg`,eventAt=new Date(Date.now()+60_000).toISOString(),target=await savedTarget(f,key,eventAt);
    const input={key,present:true,objectVersion:"content",eventAt,acceptedSequence:1,providerObjectVersion:"upload-one"};
    expect(await stageAuthenticatedDeliveryChangeForTarget(env,target,input)).toBe("staged");
    await expect(stageAuthenticatedDeliveryChangeForTarget(env,target,{...input,present:false})).rejects.toThrow("sequence-conflict");
    expect(await recordAuthenticatedDeliveryObjectChange(env,key,false,"other-content",new Date(Date.now()+120_000).toISOString())).toBe(0);
    await expect(db.prepare(`UPDATE portal_authenticated_delivery_change_object_versions
      SET accepted_sequence=2,provider_object_version=NULL WHERE grant_id=? AND identity_id=?`)
      .bind(f.grant,f.identity).run()).rejects.toThrow();
    await expect(db.prepare(`INSERT INTO portal_authenticated_delivery_change_object_versions
      (grant_id,grant_version,identity_id,object_fingerprint,r2_key,current_present,current_object_version,observed_event_at,accepted_sequence,provider_object_version)
      SELECT grant_id,grant_version,identity_id,?,r2_key||'.partial',current_present,current_object_version,observed_event_at,NULL,'unpaired'
      FROM portal_authenticated_delivery_change_object_versions WHERE grant_id=? AND identity_id=?`)
      .bind("a".repeat(64),f.grant,f.identity).run()).rejects.toThrow("must be paired");
    expect(await db.prepare(`SELECT accepted_sequence,provider_object_version,current_present,current_object_version
      FROM portal_authenticated_delivery_change_object_versions WHERE grant_id=? AND identity_id=?`)
      .bind(f.grant,f.identity).first()).toMatchObject({accepted_sequence:1,provider_object_version:"upload-one",current_present:1,current_object_version:"content"});
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
      db.prepare("INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version) VALUES(?,?,'project',?,?,'legacy','v1')")
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
      const f=await fixture(`failure-${failure}`,undefined,failure==="binding"||failure==="binding-version"?"legacy":"operations");const policy=await optIn(f);await add(f,"photo.jpg");
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

  it("publishes one immutable exact-recipient bell before SMTP and never backfills finished batches", async () => {
    const f=await fixture("bell");await optIn(f);await add(f,"photo.jpg");
    const batch=(await batches(f))[0] as {id:string;revision:number};
    await db.prepare("UPDATE portal_authenticated_delivery_change_batches SET eligible_at=datetime('now','-1 second') WHERE id=?").bind(batch.id).run();
    expect(await publishAuthenticatedDeliveryChangeBells(env)).toBe(1);
    const event=await db.prepare(`SELECT id,batch_id,workspace_id,identity_id,folder_binding_id,added_count,removed_count
      FROM authenticated_delivery_recipient_events WHERE batch_id=?`).bind(batch.id).first<Record<string,unknown>>();
    expect(event).toMatchObject({batch_id:batch.id,workspace_id:f.workspace,identity_id:f.identity,folder_binding_id:f.binding,added_count:1,removed_count:0});
    expect((await db.prepare("SELECT bell_published_at,sealed_at FROM portal_authenticated_delivery_change_batches WHERE id=?").bind(batch.id).first())
      ).toMatchObject({bell_published_at:expect.any(String),sealed_at:expect.any(String)});
    expect(await publishAuthenticatedDeliveryChangeBells(env)).toBe(0);
    await expect(db.prepare("UPDATE authenticated_delivery_recipient_events SET added_count=2 WHERE batch_id=?").bind(batch.id).run()).rejects.toThrow();
    await expect(db.prepare(`INSERT OR REPLACE INTO authenticated_delivery_recipient_events
      SELECT id,batch_id,grant_id,grant_version,logical_grant_id,source_id,workspace_id,folder_binding_id,binding_source_version,
        owner_scope_type,owner_public_id,r2_prefix,identity_id,principal_public_id,principal_source_version,policy_version,added_count,removed_count,created_at
      FROM authenticated_delivery_recipient_events WHERE id=?`).bind(event!.id).run()).rejects.toThrow();
    await expect(db.prepare(`INSERT OR REPLACE INTO authenticated_delivery_recipient_events
      SELECT 'replacement-event',batch_id,grant_id,grant_version,logical_grant_id,source_id,workspace_id,folder_binding_id,binding_source_version,
        owner_scope_type,owner_public_id,r2_prefix,identity_id,principal_public_id,principal_source_version,policy_version,added_count,removed_count,created_at
      FROM authenticated_delivery_recipient_events WHERE id=?`).bind(event!.id).run()).rejects.toThrow();
    await expect(db.prepare("INSERT INTO authenticated_delivery_recipient_event_state(event_id,recipient_identity_id) VALUES(?,?)")
      .bind((await db.prepare("SELECT id FROM authenticated_delivery_recipient_events WHERE batch_id=?").bind(batch.id).first("id")),"other-identity").run()).rejects.toThrow();
  });

  it("rolls back the bell seal when the immutable event insert aborts, then publishes exactly once on retry", async () => {
    const f=await fixture("bell-event-atomicity");await optIn(f);await add(f,"photo.jpg");
    const batch=(await batches(f))[0] as {id:string;revision:number};
    await db.prepare("UPDATE portal_authenticated_delivery_change_batches SET eligible_at=datetime('now','-1 second') WHERE id=?").bind(batch.id).run();
    const trigger="test_bell_event_insert_abort";
    // The fixture controls the generated batch id; quote it anyway so this
    // temporary test-only DDL cannot broaden the abort condition.
    const quotedBatchId=batch.id.replaceAll("'","''");
    await db.prepare(`CREATE TRIGGER ${trigger} BEFORE INSERT ON authenticated_delivery_recipient_events
      WHEN NEW.batch_id='${quotedBatchId}' BEGIN SELECT RAISE(ABORT,'test bell event insert unavailable'); END`).run();
    try {
      await expect(publishAuthenticatedDeliveryChangeBellBatch(env,batch)).rejects.toThrow("test bell event insert unavailable");
      expect(await db.prepare("SELECT bell_published_at,revision FROM portal_authenticated_delivery_change_batches WHERE id=?")
        .bind(batch.id).first()).toEqual({bell_published_at:null,revision:batch.revision});
      expect(await db.prepare("SELECT count(*) n FROM authenticated_delivery_recipient_events WHERE batch_id=?").bind(batch.id).first("n")).toBe(0);
    } finally {
      await db.prepare(`DROP TRIGGER ${trigger}`).run();
    }

    expect(await publishAuthenticatedDeliveryChangeBellBatch(env,batch)).toEqual({disposition:"published",revision:batch.revision+1});
    expect(await db.prepare("SELECT count(*) n FROM authenticated_delivery_recipient_events WHERE batch_id=?").bind(batch.id).first("n")).toBe(1);
  });

  it("requires an exact active native staff publication for secondary staged changes", async () => {
    const active=await secondaryFixture("native-publication-active");
    expect(await add(active,"photo.jpg")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM portal_authenticated_delivery_change_batches WHERE grant_id=?")
      .bind(active.grant).first("n")).toBe(1);

    const pending=await secondaryFixture("native-publication-pending","pending");
    const pendingRows=await db.prepare(authenticatedDeliveryChangeCandidatesSql())
      .bind(`${pending.prefix}photo.jpg`,"added",new Date().toISOString(),AUTHENTICATED_DELIVERY_CHANGE_CANDIDATE_LIMIT+1)
      .all<AuthenticatedDeliveryChangeTarget>();
    expect(pendingRows.results).toEqual([]);

    for (const state of ["suspended","revoked"] as const) {
      const f=await secondaryFixture(`native-publication-${state}`);
      const eventAt=new Date().toISOString(),key=`${f.prefix}photo.jpg`,target=await savedTarget(f,key,eventAt);
      await db.prepare("UPDATE portal_native_staff_grants SET state=? WHERE grant_id=? AND state='active'").bind(state,f.grant).run();
      expect(await stageAuthenticatedDeliveryChangeForTarget(env,target,{key,present:true,objectVersion:"etag-photo",eventAt})).toBe("suppressed");
      expect(await db.prepare("SELECT count(*) n FROM portal_authenticated_delivery_change_batches WHERE grant_id=?").bind(f.grant).first("n")).toBe(0);
    }

    // A publication for another valid secondary source/binding cannot repair a
    // suspended target: the fence must correlate all grant, source and binding coordinates.
    const targetFixture=await secondaryFixture("native-publication-source-mismatch");
    const decoy=await secondaryFixture("native-publication-decoy");
    const eventAt=new Date().toISOString(),key=`${targetFixture.prefix}photo.jpg`,target=await savedTarget(targetFixture,key,eventAt);
    await db.prepare("UPDATE portal_native_staff_grants SET state='suspended' WHERE grant_id=? AND state='active'")
      .bind(targetFixture.grant).run();
    expect(await db.prepare("SELECT state FROM portal_native_staff_grants WHERE grant_id=?").bind(decoy.grant).first("state")).toBe("active");
    expect(await stageAuthenticatedDeliveryChangeForTarget(env,target,{key,present:true,objectVersion:"etag-photo",eventAt})).toBe("suppressed");
    expect(await db.prepare("SELECT count(*) n FROM portal_authenticated_delivery_change_batches WHERE grant_id=?")
      .bind(targetFixture.grant).first("n")).toBe(0);
  });

  it("defers unavailable source bells without suppressing them or starving later ready batches", async () => {
    const ready=await fixture("bell-fair-ready");await optIn(ready);await add(ready,"photo.jpg");
    const readyBatch=(await batches(ready))[0] as {id:string};
    const blocked:Array<{id:string;grant:string;connector:PortalAuthorityConnectorIdentity}>=[];
    for(let index=0;index<20;index++) {
      const f=await secondaryFixture(`bell-fair-blocked-${index}`);expect(await add(f,"photo.jpg")).toBe(1);
      const batch=(await db.prepare("SELECT id FROM portal_authenticated_delivery_change_batches WHERE grant_id=?").bind(f.grant).first<{id:string}>())!;
      blocked.push({id:batch.id,grant:f.grant,connector:f.connector});
    }
    await db.batch([
      db.prepare("UPDATE portal_authenticated_delivery_change_batches SET eligible_at=datetime('now','-3 seconds') WHERE id IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify(blocked.map(batch=>batch.id))),
      db.prepare("UPDATE portal_authenticated_delivery_change_batches SET eligible_at=datetime('now','-2 seconds') WHERE id=?").bind(readyBatch.id),
    ]);
    for (const batch of blocked) await setPortalSourceAuthorityState(env,batch.connector,2,"suspended","staff-a");
    expect(await publishAuthenticatedDeliveryChangeBells(env)).toBe(0);
    const firstPass=await db.prepare(`SELECT status,bell_published_at,bell_retry_after FROM portal_authenticated_delivery_change_batches
      WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(blocked.map(batch=>batch.id))).all<{status:string;bell_published_at:string|null;bell_retry_after:string|null}>();
    expect(firstPass.results).toHaveLength(20);
    expect(firstPass.results).toEqual(expect.arrayContaining(Array.from({length:20},()=>({status:"pending",bell_published_at:null,bell_retry_after:expect.any(String)}))));
    expect(await db.prepare("SELECT count(*) n FROM authenticated_delivery_recipient_events WHERE batch_id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(blocked.map(batch=>batch.id))).first("n")).toBe(0);

    expect(await publishAuthenticatedDeliveryChangeBells(env)).toBe(1);
    expect(await db.prepare("SELECT bell_published_at FROM portal_authenticated_delivery_change_batches WHERE id=?").bind(readyBatch.id).first("bell_published_at"))
      .toEqual(expect.any(String));
    expect(await db.prepare("SELECT count(*) n FROM authenticated_delivery_recipient_events WHERE batch_id=?").bind(readyBatch.id).first("n")).toBe(1);

    const olderReady=await fixture("bell-fair-expired-retry");await optIn(olderReady);await add(olderReady,"photo.jpg");
    const olderReadyBatch=(await batches(olderReady))[0] as {id:string};
    await db.batch([
      db.prepare("UPDATE portal_authenticated_delivery_change_batches SET bell_retry_after=datetime('now','-1 second') WHERE id IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify(blocked.map(batch=>batch.id))),
      db.prepare("UPDATE portal_authenticated_delivery_change_batches SET eligible_at=datetime('now','-2 minutes') WHERE id=?").bind(olderReadyBatch.id),
    ]);
    expect(await publishAuthenticatedDeliveryChangeBells(env)).toBe(1);
    expect(await db.prepare("SELECT bell_published_at FROM portal_authenticated_delivery_change_batches WHERE id=?").bind(olderReadyBatch.id).first("bell_published_at"))
      .toEqual(expect.any(String));
    expect(await db.prepare("SELECT count(*) n FROM authenticated_delivery_recipient_events WHERE batch_id=?").bind(olderReadyBatch.id).first("n")).toBe(1);
  });

  it("suppresses publication on a final authority loss and keeps post-publication email suppression separate", async () => {
    const denied=await fixture("bell-denied");await optIn(denied);await add(denied,"photo.jpg");
    const deniedBatch=(await batches(denied))[0] as {id:string;revision:number};
    await db.prepare("UPDATE portal_authenticated_delivery_change_batches SET eligible_at=datetime('now','-1 second') WHERE id=?").bind(deniedBatch.id).run();
    const result=await publishAuthenticatedDeliveryChangeBellBatch(env,deniedBatch,{beforeBellCommit:async()=>{
      await db.prepare("UPDATE portal_v2_workspace_memberships SET status='revoked',revoked_at=datetime('now') WHERE identity_id=?").bind(denied.identity).run();
    }});
    expect(result.disposition).toBe("suppressed");
    expect(await db.prepare("SELECT count(*) n FROM authenticated_delivery_recipient_events WHERE batch_id=?").bind(deniedBatch.id).first("n")).toBe(0);

    const secondary=await secondaryFixture("bell-secondary-revoked");
    await add(secondary,"photo.jpg");
    const secondaryBatch=(await db.prepare("SELECT id,revision FROM portal_authenticated_delivery_change_batches WHERE grant_id=?")
      .bind(secondary.grant).first<{id:string;revision:number}>())!;
    await db.prepare("UPDATE portal_authenticated_delivery_change_batches SET eligible_at=datetime('now','-1 second') WHERE id=?").bind(secondaryBatch.id).run();
    const secondaryResult=await publishAuthenticatedDeliveryChangeBellBatch(env,secondaryBatch,{beforeBellCommit:async()=>{
      await setPortalSourceAuthorityState(env,secondary.connector,2,"suspended","staff-a");
    }});
    expect(secondaryResult.disposition).toBe("suppressed");
    expect(await db.prepare("SELECT count(*) n FROM authenticated_delivery_recipient_events WHERE batch_id=?").bind(secondaryBatch.id).first("n")).toBe(0);

    const postPublication=await fixture("bell-post-publication-source-loss");await optIn(postPublication);await add(postPublication,"photo.jpg");
    const postPublicationBatch=(await batches(postPublication))[0] as {id:string;revision:number};
    await db.prepare("UPDATE portal_authenticated_delivery_change_batches SET eligible_at=datetime('now','-1 second') WHERE id=?").bind(postPublicationBatch.id).run();
    expect(await publishAuthenticatedDeliveryChangeBellBatch(env,postPublicationBatch)).toMatchObject({disposition:"published"});
    const blockedSend=vi.fn();
    const unreservedPrimary={...env,PROJECT_ALPHA_PORTAL_HMAC_SECRET:"unreserved-primary-portal-key-material-at-least-thirty-two-bytes"} as Env;
    expect(await dispatchAuthenticatedDeliveryChangeNotifications(unreservedPrimary,{send:blockedSend})).toBe(1);
    expect(blockedSend).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT count(*) n FROM authenticated_delivery_recipient_events WHERE batch_id=?").bind(postPublicationBatch.id).first("n")).toBe(1);
    expect(await db.prepare("SELECT status FROM portal_authenticated_delivery_change_batches WHERE id=?").bind(postPublicationBatch.id).first("status")).toBe("suppressed");

    const f=await fixture("bell-email-only");await optIn(f);await add(f,"photo.jpg");
    const batch=(await batches(f))[0] as {id:string;revision:number};
    await db.prepare("UPDATE portal_authenticated_delivery_change_batches SET eligible_at=datetime('now','-1 second') WHERE id=?").bind(batch.id).run();
    const published=await publishAuthenticatedDeliveryChangeBellBatch(env,batch);
    expect(published).toMatchObject({disposition:"published",revision:batch.revision+1});
    await db.prepare("UPDATE portal_authenticated_delivery_change_batches SET status='processing' WHERE id=?").bind(batch.id).run();
    await expect(suppressAuthenticatedDeliveryChangeEmail(env,"staff-a",{batchId:batch.id,expectedRevision:published.revision!,idempotencyKey:`bell-processing-${f.suffix}-000`}))
      .rejects.toThrow("suppression-conflict");
    expect(await db.prepare("SELECT count(*) n FROM authenticated_delivery_recipient_events WHERE batch_id=?").bind(batch.id).first("n")).toBe(1);
    await db.prepare("UPDATE portal_authenticated_delivery_change_batches SET status='pending' WHERE id=?").bind(batch.id).run();
    const control=await suppressAuthenticatedDeliveryChangeEmail(env,"staff-a",{batchId:batch.id,expectedRevision:published.revision!,idempotencyKey:`bell-email-${f.suffix}-00000`});
    expect(control).toEqual({revision:published.revision!+1,replayed:false});
    await expect(db.prepare(`INSERT OR REPLACE INTO authenticated_delivery_recipient_event_email_controls
      SELECT actor_staff_id,idempotency_key,request_fingerprint,batch_id,expected_revision,result_revision,created_at
      FROM authenticated_delivery_recipient_event_email_controls WHERE actor_staff_id='staff-a' AND batch_id=?`).bind(batch.id).run()).rejects.toThrow();
    await expect(controlAuthenticatedDeliveryChangeBatch(env,"staff-a",{batchId:batch.id,action:"cancel",expectedRevision:control.revision,idempotencyKey:`bell-cancel-${f.suffix}-00000`}))
      .rejects.toThrow("control-conflict");
    const send=vi.fn();expect(await dispatchAuthenticatedDeliveryChangeNotifications(env,{send})).toBe(0);expect(send).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT count(*) n FROM authenticated_delivery_recipient_events WHERE batch_id=?").bind(batch.id).first("n")).toBe(1);
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
