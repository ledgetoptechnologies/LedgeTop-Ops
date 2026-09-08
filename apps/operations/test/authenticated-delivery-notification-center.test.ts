import {readFileSync,readdirSync} from "node:fs";
import {Hono} from "hono";
import {Miniflare} from "miniflare";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {splitD1MigrationStatements} from "../../client/test/helpers/d1-migrations";
import {
  authenticatedDeliveryNotificationCenterReady,authenticatedDeliveryNotificationCandidates,
  readAuthenticatedDeliveryNotificationScope,readAuthenticatedDeliveryNotificationPolicy,updateAuthenticatedDeliveryNotificationPolicy,
  readAuthenticatedDeliveryNotification,controlAuthenticatedDeliveryNotification,
} from "../src/worker/authenticated-delivery-notification-center";
import {saveAuthenticatedDeliveryNotificationPolicy} from "../src/worker/authenticated-delivery-change-notifications";
import {listCombinedDeliveryNotifications,registerNotificationCenterRoutes} from "../src/worker/notification-center";
import {requiresAdministratorForMutation} from "../src/worker/r2-crud-validation";
import type {Env,StaffPrincipal} from "../src/worker/types";
import {reservePrimaryPortalSigningKeys} from "../../client/src/worker/project-alpha-portal-authority";

const staff:StaffPrincipal={id:"staff-notify",email:"staff-notify@example.test",displayName:"Notify Staff",accessSubject:"staff-subject",projectAlphaUserId:null};
let runtime:Miniflare,delivery:D1Database,ops:D1Database,env:Env;
const ids={workspace:"workspace-notify",organization:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",project:"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",generation:"generation-notify",
  snapshot:"snapshot-notify",binding:"binding-notify",identity:"identity-notify",principal:"principal-notify",grant:"grant-notify",logical:"logical-notify",batch:"batch-notify"};
const prefix="Jobs/Clients/Notify/Project/";

async function migrate(db:D1Database,directory:URL){
  for(const file of readdirSync(directory).filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort())
    await db.batch(splitD1MigrationStatements(readFileSync(new URL(file,directory),"utf8")).map(sql=>db.prepare(sql)));
}
async function permission(key:string,effect="allow",division:string|null=null){
  await ops.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
    VALUES(?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),staff.id,key,effect,division?"division":"global",division,division??"global",staff.id).run();
}

beforeAll(async()=>{
  runtime=new Miniflare({compatibilityDate:"2026-07-22",modules:true,script:"export default {fetch(){return new Response('ok')}}",
    d1Databases:["OPS_DB","DELIVERY_DB"]});
  ops=await runtime.getD1Database("OPS_DB") as D1Database;delivery=await runtime.getD1Database("DELIVERY_DB") as D1Database;
  await migrate(ops,new URL("../migrations/",import.meta.url));await migrate(delivery,new URL("../../client/migrations/",import.meta.url));
  await ops.batch([
    ops.prepare("INSERT INTO staff_users(id,email,display_name,access_subject) VALUES(?,?,?,?)").bind(staff.id,staff.email,staff.displayName,staff.accessSubject),
    ops.prepare("INSERT INTO divisions(id,name,code) VALUES('division-notify','Notify','notify')"),
    ops.prepare("INSERT INTO pa_organizations(id,name,payload_json,last_sync_id,projection_source_id) VALUES(?,'Organization',?,'sync','project-alpha:primary')").bind(ids.organization,JSON.stringify({public_id:ids.organization})),
    ops.prepare("INSERT INTO pa_clients(id,name,organization_id,payload_json,last_sync_id,projection_source_id) VALUES('client-notify','Client',?,'{}','sync','project-alpha:primary')").bind(ids.organization),
    ops.prepare("INSERT INTO pa_projects(id,client_id,organization_id,name,payload_json,last_sync_id,projection_source_id) VALUES(?,'client-notify',?,'Project',?,'sync','project-alpha:primary')").bind(ids.project,ids.organization,JSON.stringify({public_id:ids.project})),
    ops.prepare("INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by) VALUES(?,'division-notify',?,'manual',?)").bind(ids.project,prefix,staff.id),
  ]);
  for(const key of ["delivery.share.audit","delivery.share.create","delivery.share.revoke"])await permission(key);
  await delivery.batch([
    delivery.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES(?,'https://access.test','subject','client@example.test')").bind(ids.identity),
    delivery.prepare("INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id) VALUES(?,'organization',?,'Notify Workspace','active','project-alpha:primary')").bind(ids.workspace,ids.organization),
    delivery.prepare(`INSERT INTO pa_portal_projection_generations
      (id,workspace_id,source_generation,source_sequence,snapshot_hash,page_count,record_count,workspace_root_type,
       workspace_root_public_id,workspace_display_name,workspace_source_version,workspace_active,status,complete,projection_source_id)
      VALUES(?,?,?,1,?,1,2,'organization',?,'Notify Workspace','workspace-v1',1,'active',1,'project-alpha:primary')`)
      .bind(ids.snapshot,ids.workspace,ids.generation,"a".repeat(64),ids.organization),
    delivery.prepare("INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status) VALUES('membership-notify',?,?,'operations','active')").bind(ids.workspace,ids.identity),
    delivery.prepare("INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete) VALUES(?,?,?,1,'active',1)").bind(ids.generation,ids.workspace,ids.generation),
    delivery.prepare("INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,display_name,source_version) VALUES(?,?,'organization',?,'Organization','v1')").bind(ids.workspace,ids.generation,ids.organization),
    delivery.prepare("INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version) VALUES(?,?,'project',?,?,'Project','v1')").bind(ids.workspace,ids.generation,ids.project,ids.organization),
    delivery.prepare("INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)").bind(ids.workspace,ids.generation),
    delivery.prepare(`INSERT INTO pa_portal_projection_checkpoints(workspace_id,source_generation,source_sequence,snapshot_generation_id)
      VALUES(?,?,1,?)`).bind(ids.workspace,ids.generation,ids.snapshot),
    delivery.prepare("INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version) VALUES(?,?,'project',?,?,'operations','v1')").bind(ids.binding,ids.workspace,ids.project,prefix),
    delivery.prepare(`INSERT INTO portal_primary_staff_bindings
      (binding_id,workspace_id,source_id,root_type,root_public_id,owner_scope_type,owner_public_id,project_public_id,
       directory_generation_id,snapshot_generation_id,source_sequence,root_source_version,project_source_version,r2_prefix,
       ops_project_id,ops_context_version,created_by_staff_id,reason_code,state)
      VALUES(?,?,'project-alpha:primary','organization',?,'project',?,?,?, ?,1,'v1','v1',?,
       ?,?,?, 'migration_0189_legacy_compat','active')`)
      .bind(ids.binding,ids.workspace,ids.organization,ids.project,ids.project,ids.generation,ids.snapshot,prefix,ids.project,"0".repeat(64),staff.id),
    delivery.prepare("INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status) VALUES(?,?,?,'client@example.test','Client Person','pv1','active')").bind(ids.workspace,ids.principal,ids.identity),
    delivery.prepare("INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status) VALUES('entitlement-notify',?,?,'delivery.view','allow','project',?,'operations','active')").bind(ids.workspace,ids.identity,ids.project),
    delivery.prepare("INSERT INTO portal_v2_authenticated_delivery_grants(id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id) VALUES(?,?,1,?,?,'v1','principal',?,'pv1','test',?)").bind(ids.grant,ids.logical,ids.workspace,ids.binding,ids.principal,staff.id),
    delivery.prepare("INSERT INTO portal_v2_authenticated_delivery_grant_recipients(grant_id,workspace_id,principal_public_id,identity_id,principal_source_version) VALUES(?,?,?,?,'pv1')").bind(ids.grant,ids.workspace,ids.principal,ids.identity),
  ]);
  env={OPS_DB:ops,DELIVERY_DB:delivery,AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED:"true",AUTHENTICATED_DELIVERY_GRANTS_ENABLED:"true",
    CLIENT_PORTAL_HIERARCHY_V2_ENABLED:"true",CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED:"false",CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:"true",
    OPERATIONS_SESSION_SECRET:"authenticated-notification-center-secret",DELIVERY_BASE_URL:"https://client.example.test",
    PROJECT_ALPHA_PORTAL_HMAC_SECRET:"synthetic-notification-center-signing-key-at-least-32-bytes"} as Env;
  await reservePrimaryPortalSigningKeys(env);
},180_000);
afterAll(async()=>runtime?.dispose());

describe("authenticated delivery staff notification integration",{timeout:60_000},()=>{
  it("is default-off and derives the exact recipient for idempotent policy writes",async()=>{
    expect(await readAuthenticatedDeliveryNotificationPolicy({...env,AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED:"false"},staff,ids.grant))
      .toEqual({policy:null,available:false});
    const key="policy-staff-notify-0001";
    const first=await updateAuthenticatedDeliveryNotificationPolicy(env,staff,ids.grant,{accessNoticeEnabled:true,changeMode:"both",expectedVersion:null,idempotencyKey:key});
    expect(first).toEqual({policy:{accessNoticeEnabled:true,changeMode:"both",version:1},available:true});
    expect(await updateAuthenticatedDeliveryNotificationPolicy(env,staff,ids.grant,{accessNoticeEnabled:true,changeMode:"both",expectedVersion:null,idempotencyKey:key})).toEqual(first);
    await expect(updateAuthenticatedDeliveryNotificationPolicy(env,staff,ids.grant,{accessNoticeEnabled:false,changeMode:"off",expectedVersion:null,idempotencyKey:"policy-staff-notify-0002"}))
      .rejects.toMatchObject({status:409});
    expect(await delivery.prepare("SELECT identity_id FROM portal_authenticated_delivery_notification_policies WHERE grant_id=?").bind(ids.grant).first("identity_id")).toBe(ids.identity);
  });

  it("requires the full feature matrix and rejects contradictory policy state at every boundary",async()=>{
    for(const disabled of [
      {...env,AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED:"false"},
      {...env,AUTHENTICATED_DELIVERY_GRANTS_ENABLED:"false"},
      {...env,CLIENT_PORTAL_HIERARCHY_V2_ENABLED:"false"},
    ] as Env[]){
      expect(await authenticatedDeliveryNotificationCenterReady(disabled)).toBe(false);
      expect(await readAuthenticatedDeliveryNotificationPolicy(disabled,staff,ids.grant)).toEqual({policy:null,available:false});
    }
    await expect(updateAuthenticatedDeliveryNotificationPolicy(env,staff,ids.grant,{accessNoticeEnabled:true,changeMode:"off",expectedVersion:1,
      idempotencyKey:"policy-contradiction-01"})).rejects.toMatchObject({status:400});
    await expect(saveAuthenticatedDeliveryNotificationPolicy(env,staff.id,{grantId:ids.grant,identityId:ids.identity,expectedPolicyVersion:1,
      accessNoticeEnabled:true,changeMode:"off",idempotencyKey:"policy-contradiction-02"})).rejects.toThrow(/invalid/);
    await expect(delivery.prepare("UPDATE portal_authenticated_delivery_notification_policies SET access_notice_enabled=1,change_mode='off' WHERE grant_id=?")
      .bind(ids.grant).run()).rejects.toThrow(/contradictory/);
    const app=new Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>();
    app.use("/api/*",async(c,next)=>{c.set("principal",staff);c.set("administrator",false);await next();});registerNotificationCenterRoutes(app);
    const response=await app.request(`https://ops.test/api/delivery/authenticated-grants/${ids.grant}/notification-policy`,{
      method:"PUT",headers:{"Content-Type":"application/json","Idempotency-Key":"policy-contradiction-03"},
      body:JSON.stringify({accessNoticeEnabled:true,changeMode:"off",expectedVersion:1}),
    },env);
    expect(response.status).toBe(400);
    expect(await delivery.prepare("SELECT policy_version FROM portal_authenticated_delivery_notification_policies WHERE grant_id=?")
      .bind(ids.grant).first("policy_version")).toBe(1);
  });

  it("fails closed on exact division authority and unusable recipient, while allowing disable",async()=>{
    await permission("delivery.share.create","deny","division-notify");
    await expect(readAuthenticatedDeliveryNotificationPolicy(env,staff,ids.grant)).rejects.toMatchObject({status:404});
    await ops.prepare("DELETE FROM staff_permission_overrides WHERE effect='deny' AND division_id='division-notify'").run();
    await delivery.prepare("UPDATE portal_v2_identities SET status='suspended' WHERE id=?").bind(ids.identity).run();
    await expect(updateAuthenticatedDeliveryNotificationPolicy(env,staff,ids.grant,{accessNoticeEnabled:true,changeMode:"added",expectedVersion:1,idempotencyKey:"policy-staff-notify-0003"}))
      .rejects.toMatchObject({status:409});
    expect((await updateAuthenticatedDeliveryNotificationPolicy(env,staff,ids.grant,{accessNoticeEnabled:false,changeMode:"off",expectedVersion:1,idempotencyKey:"policy-staff-notify-0004"})).policy)
      .toEqual({accessNoticeEnabled:false,changeMode:"off",version:2});
    await delivery.prepare("UPDATE portal_v2_identities SET status='active' WHERE id=?").bind(ids.identity).run();
    await updateAuthenticatedDeliveryNotificationPolicy(env,staff,ids.grant,{accessNoticeEnabled:true,changeMode:"both",expectedVersion:2,idempotencyKey:"policy-staff-notify-0005"});
  });

  it("merges, deep-reads and controls the exact batch without exposing storage paths",async()=>{
    const key=`${prefix}photo.jpg`,secondKey=`${prefix}second.jpg`,secondBatch="batch-notify-processing";
    await delivery.batch([
      delivery.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,'etag',10,datetime('now'),'image/jpeg','image')").bind(key),
      delivery.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,'etag-2',10,datetime('now'),'image/jpeg','image')").bind(secondKey),
      delivery.prepare(`INSERT INTO portal_authenticated_delivery_change_batches(id,grant_id,grant_version,logical_grant_id,workspace_id,source_id,folder_binding_id,binding_source_version,owner_scope_type,owner_public_id,r2_prefix,identity_id,principal_public_id,principal_source_version,policy_version,added_count,status,revision,eligible_at)
        VALUES(?,?,1,?,?,'project-alpha:primary',?,'v1','project',?,?,?,?,'pv1',3,1,'pending',1,datetime('now','+5 minutes'))`).bind(ids.batch,ids.grant,ids.logical,ids.workspace,ids.binding,ids.project,prefix,ids.identity,ids.principal),
      delivery.prepare("INSERT INTO portal_authenticated_delivery_change_batch_items(batch_id,object_fingerprint,r2_key,baseline_present,current_present,current_object_version,event_token) VALUES(?,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',?,0,1,'etag','event')").bind(ids.batch,key),
      delivery.prepare(`INSERT INTO portal_authenticated_delivery_change_batches(id,grant_id,grant_version,logical_grant_id,workspace_id,source_id,folder_binding_id,binding_source_version,owner_scope_type,owner_public_id,r2_prefix,identity_id,principal_public_id,principal_source_version,policy_version,added_count,status,revision,eligible_at,sealed_at,published_recipient_email)
        VALUES(?,?,1,?,?,'project-alpha:primary',?,'v1','project',?,?,?,?,'pv1',3,1,'processing',9,datetime('now'),datetime('now'),'client@example.test')`).bind(secondBatch,ids.grant,ids.logical,ids.workspace,ids.binding,ids.project,prefix,ids.identity,ids.principal),
      delivery.prepare("INSERT INTO portal_authenticated_delivery_change_batch_items(batch_id,object_fingerprint,r2_key,baseline_present,current_present,current_object_version,event_token) VALUES(?,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',?,0,1,'etag-2','event-2')").bind(secondBatch,secondKey),
    ]);
    const candidates=await authenticatedDeliveryNotificationCandidates(env,"pending");
    const firstCandidate=candidates.find(row=>row.id===ids.batch)!,secondCandidate=candidates.find(row=>row.id===secondBatch)!;
    expect(firstCandidate.scopeKey).not.toBe(secondCandidate.scopeKey);
    expect((await readAuthenticatedDeliveryNotificationScope(env,firstCandidate))?.recipientEmail).toBe("client@example.test");
    expect((await readAuthenticatedDeliveryNotificationScope(env,secondCandidate))?.recipientEmail).toBe("client@example.test");
    const page=await listCombinedDeliveryNotifications(env,staff,{});
    expect(page.availability.authenticatedDeliveries).toBe(true);
    expect(page.items).toContainEqual(expect.objectContaining({kind:"authenticated_delivery",id:ids.batch,addedCount:1,canSendNow:true}));
    expect(JSON.stringify(page)).not.toContain(prefix);
    expect((await readAuthenticatedDeliveryNotification(env,ids.batch,staff)).item).toMatchObject({id:ids.batch,workspaceName:"Notify Workspace",recipientEmail:"client@example.test"});
    const send=await controlAuthenticatedDeliveryNotification(env,staff,ids.batch,"send-now",1,"control-staff-notify-01");
    expect(send).toMatchObject({revision:2,status:"pending",replayed:false});
    expect(await controlAuthenticatedDeliveryNotification(env,staff,ids.batch,"send-now",1,"control-staff-notify-01"))
      .toMatchObject({revision:2,status:"pending",replayed:true});
    const published=await readAuthenticatedDeliveryNotification(env,ids.batch,staff);
    expect(published.item).toMatchObject({canCancel:false,canSendNow:false,canSuppressEmail:true});
    expect(published.item.bellPublishedAt).toBeTruthy();
    await expect(controlAuthenticatedDeliveryNotification(env,staff,ids.batch,"cancel",published.item.revision,"control-staff-notify-02"))
      .rejects.toMatchObject({status:409});
    const suppression=await controlAuthenticatedDeliveryNotification(env,staff,ids.batch,"suppress-email",published.item.revision,"suppress-staff-notify-01");
    expect(suppression).toMatchObject({revision:published.item.revision+1,status:"suppressed",replayed:false});
    expect(await controlAuthenticatedDeliveryNotification(env,staff,ids.batch,"suppress-email",published.item.revision,"suppress-staff-notify-01"))
      .toMatchObject({revision:published.item.revision+1,status:"suppressed",replayed:true});
    const retained=await readAuthenticatedDeliveryNotification(env,ids.batch,staff);
    expect(retained.item).toMatchObject({bellPublishedAt:published.item.bellPublishedAt,canCancel:false,canSuppressEmail:false,errorCode:"email-suppressed"});
    expect(retained.item.emailSuppressedAt).toBeTruthy();
    expect(await delivery.prepare("SELECT count(*) count FROM authenticated_delivery_recipient_events WHERE batch_id=?").bind(ids.batch).first("count")).toBe(1);
  });

  it("CAS-disables enabled policies when recipient or staff authority changes after the write",async()=>{
    await expect(updateAuthenticatedDeliveryNotificationPolicy(env,staff,ids.grant,{accessNoticeEnabled:true,changeMode:"added",expectedVersion:3,
      idempotencyKey:"policy-race-recipient-01"},{beforeFinalAuthorization:async()=>{
        await delivery.prepare("UPDATE portal_v2_identities SET status='suspended' WHERE id=?").bind(ids.identity).run();
      }})).rejects.toMatchObject({status:409});
    expect(await delivery.prepare("SELECT access_notice_enabled,change_mode,policy_version FROM portal_authenticated_delivery_notification_policies WHERE grant_id=?")
      .bind(ids.grant).first()).toMatchObject({access_notice_enabled:0,change_mode:"off",policy_version:5});
    await delivery.prepare("UPDATE portal_v2_identities SET status='active' WHERE id=?").bind(ids.identity).run();
    await updateAuthenticatedDeliveryNotificationPolicy(env,staff,ids.grant,{accessNoticeEnabled:true,changeMode:"both",expectedVersion:5,
      idempotencyKey:"policy-race-staff-prime"});
    await expect(updateAuthenticatedDeliveryNotificationPolicy(env,staff,ids.grant,{accessNoticeEnabled:true,changeMode:"removed",expectedVersion:6,
      idempotencyKey:"policy-race-staff-001"},{beforeFinalAuthorization:async()=>permission("delivery.share.create","deny","division-notify")}))
      .rejects.toMatchObject({status:409});
    expect(await delivery.prepare("SELECT access_notice_enabled,change_mode,policy_version FROM portal_authenticated_delivery_notification_policies WHERE grant_id=?")
      .bind(ids.grant).first()).toMatchObject({access_notice_enabled:0,change_mode:"off",policy_version:8});
    expect(await delivery.prepare("SELECT count(*) count FROM portal_authenticated_delivery_notification_policy_audit WHERE grant_id=? AND policy_version IN (5,8) AND access_notice_enabled=0")
      .bind(ids.grant).first("count")).toBe(2);
    await ops.prepare("DELETE FROM staff_permission_overrides WHERE effect='deny' AND division_id='division-notify'").run();
  });

  it("registers only the reviewed delegated policy and typed action routes",async()=>{
    expect(requiresAdministratorForMutation("PUT",`/api/delivery/authenticated-grants/${ids.grant}/notification-policy`)).toBe(false);
    expect(requiresAdministratorForMutation("POST",`/api/notifications/deliveries/authenticated_delivery/${ids.batch}/cancel`)).toBe(false);
    expect(requiresAdministratorForMutation("POST",`/api/notifications/deliveries/authenticated_delivery/${ids.batch}/suppress-email`)).toBe(false);
    expect(requiresAdministratorForMutation("PUT",`/api/notifications/deliveries/authenticated_delivery/${ids.batch}/suppress-email`)).toBe(true);
    expect(requiresAdministratorForMutation("POST",`/api/notifications/deliveries/${ids.batch}/suppress-email`)).toBe(true);
    expect(requiresAdministratorForMutation("PUT",`/api/delivery/authenticated-grants/${ids.grant}/other`)).toBe(true);
    const app=new Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>();
    app.use("/api/*",async(c,next)=>{c.set("principal",staff);c.set("administrator",false);await next();});registerNotificationCenterRoutes(app);
    const response=await app.request(`https://ops.test/api/delivery/authenticated-grants/${ids.grant}/notification-policy`,{},env);
    expect(response.status).toBe(200);expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
