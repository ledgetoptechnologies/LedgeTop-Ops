import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createClientPortalRouter } from "../src/worker/client-portal/routes";
import { d1ClientPortalRepository } from "../src/worker/client-portal/repository";
import type { ClientPortalSession, VerifiedClientPrincipal } from "../src/worker/client-portal/types";
import { mutateNativeDeliveryNotification } from "../src/worker/client-portal/notification-history";
import { reservePrimaryPortalSigningKeys } from "../src/worker/project-alpha-portal-authority";
import type { Env } from "../src/worker/types";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const origin = "https://client.example.test";
const owner: VerifiedClientPrincipal = { issuer: "https://issuer.test", subject: "native-owner", email: "owner@example.test" };
const other: VerifiedClientPrincipal = { issuer: "https://issuer.test", subject: "native-other", email: "other@example.test" };
const secondOwner: VerifiedClientPrincipal = { issuer: "https://issuer.test", subject: "native-owner-two", email: "owner-two@example.test" };

describe("native PA draft notification history — migrated D1", { timeout: 240_000 }, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;
  let serial = 0;

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: { DELIVERY_DB: "native-pa-draft-history" } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"));
      if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
    }
    const bindings = {
      DELIVERY_DB: db,
      CLIENT_PORTAL_ENABLED: "true",
      CLIENT_PORTAL_ORIGIN: origin,
      CLIENT_PORTAL_REQUEST_V2_ENABLED: "true",
      CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true",
      CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED: "true",
      DELIVERY_SESSION_SECRET: "native-pa-draft-history-session-secret-0001",
      PROJECT_ALPHA_PORTAL_HMAC_SECRET: "native-pa-draft-primary-signing-secret-0001",
      ENVIRONMENT: "development",
    } satisfies Partial<Env>;
    // This read-only router test provides only bindings reached by its D1 paths.
    env = bindings as Env;
    await reservePrimaryPortalSigningKeys(env);
  }, 180_000);

  afterAll(async () => runtime?.dispose());

  async function seed(label: string, principal: VerifiedClientPrincipal, sourceId?: string) {
    serial += 1;
    const suffix = `${label}-${serial}`, source = sourceId ?? `project-alpha:history_${serial}`, account = `account-${suffix}`,
      storage = `storage-${suffix}`, workspace = `workspace-${suffix}`, identity = `identity-${suffix}`,
      request = `request-${suffix}`, root = `org-${suffix}`, notification = `notice-${suffix}`;
    await db.batch([
      db.prepare(`INSERT INTO client_accounts(id,display_name,status,project_alpha_organization_id,project_alpha_source_id)
        VALUES(?,?,'active',?,?)`).bind(account, `Account ${suffix}`, root, source),
      db.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES(?,?,?,?,?)")
        .bind(storage, account, principal.issuer, principal.subject, principal.email),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES(?,?, 'manager')").bind(account, storage),
      ...(source==='project-alpha:primary'?[]:[db.prepare(`INSERT INTO pa_portal_source_authorities
        (source_id,producer_binding_id,snapshot_origin,snapshot_base_path,application_key,state,active_revision,version,connector_revision,connector_version)
        VALUES(?,?,'https://native.example.test','/api/portal','native_history','pending',1,1,1,1)`).bind(source, `binding-${suffix}`),
      db.prepare(`INSERT INTO pa_portal_source_authority_revisions
        (source_id,revision,credential_ref,access_issuer,access_audience,access_subject,current_key_id,current_key_fingerprint,created_by)
        VALUES(?,1,'history-credential','https://native.example.test','operations','history-subject','history-key',?,'test')`).bind(source, "a".repeat(64)),
      db.prepare("UPDATE pa_portal_source_authorities SET state='active',version=2 WHERE source_id=?").bind(source)]),
      db.prepare("INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id) VALUES(?,?,?)")
        .bind(workspace, source, `source-workspace-${suffix}`),
      db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id)
        VALUES(?,'organization',?,'Native workspace','active',?)`).bind(workspace, root, source),
      db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES(?,?,?,?, 'active')")
        .bind(identity, principal.issuer, principal.subject, principal.email),
      db.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status,source_version)
        VALUES(?,?,?,'project_alpha','active','member-v1')`).bind(`membership-${suffix}`, workspace, identity),
      db.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status)
        VALUES(?,?,?,?,'Native owner','member-v1','active')`).bind(workspace, `principal-${suffix}`, identity, principal.email),
      db.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete,activated_at)
        VALUES(?,?,?,1,'active',1,datetime('now'))`).bind(`generation-${suffix}`, workspace, `generation-${suffix}`),
      db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,display_name,source_version,active)
        VALUES(?,?,'organization',?,'Native organization','v1',1)`).bind(workspace, `generation-${suffix}`, root),
      db.prepare("INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version) VALUES(?,?,3)")
        .bind(`generation-${suffix}`, workspace),
      db.prepare("INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)")
        .bind(workspace, `generation-${suffix}`),
      ...[["workspace.view", "workspace", workspace], ["request.create", "organization", root]].map(([capability, scopeType, scopePublicId]) => db.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
        VALUES(?,?,?,?,'allow',?,?,'project_alpha','active')`)
        .bind(`${capability}-${suffix}`, workspace, identity, capability, scopeType, scopePublicId)),
      db.prepare(`INSERT INTO portal_native_request_storage_bindings(workspace_id,source_id,account_id,storage_identity_id,state)
        VALUES(?,?,?,?, 'active')`).bind(workspace, source, account, storage),
      db.prepare(`INSERT INTO client_service_requests
        (id,account_id,created_by_identity_id,request_type,title,details,status,idempotency_key,request_fingerprint,catalog_source_id,portal_workspace_id,portal_identity_id,portal_project_public_id)
        VALUES(?,?,?,'service','Native PA draft','Native history request','accepted_pending_pa_linkage',?,?,?, ?,?,NULL)`)
        .bind(request, account, storage, `request-key-${suffix}`, "b".repeat(43), source, workspace, identity),
      db.prepare(`INSERT INTO client_portal_notifications
        (id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body,action_path)
        VALUES(?,?,?,'pa_draft_quote_created','service_request',?,?,'A draft quote is ready','Review the non-financial draft status.','/portal/requests')`)
        .bind(notification, account, storage, request, `service-request:${notification}`),
    ]);
    return { identity, workspace, request, notification, source, root, principalId:`principal-${suffix}`,
      generation:`generation-${suffix}`, requestEntitlement: `request.create-${suffix}` };
  }

  const history = (principal: VerifiedClientPrincipal, workspace: string) => new Hono().route("/api/client", createClientPortalRouter({
    resolvePrincipal: async () => principal,
    repository: d1ClientPortalRepository,
  })).request(`${origin}/api/client/notification-history`, { headers: { "X-LTDS-Workspace-Id": workspace } }, env);
  const mutate = (principal: VerifiedClientPrincipal, workspace: string, notification: string, action: "read" | "dismiss", bindings = env) => new Hono().route("/api/client", createClientPortalRouter({
    resolvePrincipal: async () => principal,
    repository: d1ClientPortalRepository,
  })).request(`${origin}/api/client/notifications/${notification}`, {
    method: "PATCH",
    headers: { Origin: origin, "Content-Type": "application/json", "X-LTDS-Workspace-Id": workspace },
    body: JSON.stringify({ action }),
  }, bindings);

  it("shows the PA draft notice only to its current native owner and removes it as authority changes", async () => {
    const mine = await seed("owner", owner);
    const theirs = await seed("other", other);
    const dismissible = await seed("owner-dismiss", secondOwner);

    const visible = await history(owner, mine.workspace);
    expect(visible.status).toBe(200);
    const visiblePage = await visible.json() as { coverage: { requests: string }; items: Array<{ id: string; kind: string }> };
    expect(visiblePage.coverage.requests).toBe("included");
    expect(visiblePage.items).toEqual([expect.objectContaining({ id: mine.notification, kind: "request" })]);

    expect((await history(owner, theirs.workspace)).status).toBe(403);
    expect((await history(other, mine.workspace)).status).toBe(403);
    const isolated = await history(other, theirs.workspace);
    expect(isolated.status).toBe(200);
    expect((await isolated.json() as { items: Array<{ id: string }> }).items.map(item => item.id)).toEqual([theirs.notification]);

    expect((await mutate(secondOwner, dismissible.workspace, dismissible.notification, "read")).status).toBe(200);
    const readHistory = await history(secondOwner, dismissible.workspace);
    expect(readHistory.status).toBe(200);
    expect((await readHistory.json() as { items: Array<{ id: string; readAt: string | null }> }).items)
      .toEqual([expect.objectContaining({ id: dismissible.notification, readAt: expect.any(String) })]);
    expect((await mutate(other, theirs.workspace, dismissible.notification, "dismiss")).status).toBe(404);
    expect(await db.prepare("SELECT dismissed_at FROM client_portal_notifications WHERE id=?").bind(dismissible.notification).first("dismissed_at")).toBeNull();
    expect((await mutate(secondOwner, dismissible.workspace, dismissible.notification, "dismiss")).status).toBe(200);
    expect(await db.prepare("SELECT dismissed_at FROM client_portal_notifications WHERE id=?").bind(dismissible.notification).first("dismissed_at")).toEqual(expect.any(String));
    const dismissedHistory = await history(secondOwner, dismissible.workspace);
    expect(dismissedHistory.status).toBe(200);
    expect(await dismissedHistory.json() as { items: Array<{ id: string }> }).toMatchObject({ items: [] });

    await db.prepare("UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE id=?")
      .bind(mine.requestEntitlement).run();
    const entitlementRevoked = await history(owner, mine.workspace);
    expect(entitlementRevoked.status).toBe(200);
    expect((await entitlementRevoked.json() as { items: Array<{ id: string }> }).items.map(item => item.id)).not.toContain(mine.notification);

    await db.prepare("UPDATE portal_v2_workspace_memberships SET status='revoked',revoked_at=datetime('now') WHERE workspace_id=? AND identity_id=?")
      .bind(mine.workspace, mine.identity).run();
    expect((await history(owner, mine.workspace)).status).toBe(403);
    expect((await history(other, theirs.workspace)).status).toBe(200);
  });

  it("pauses a mounted native inbox mutation without weakening foreign-workspace denial", async () => {
    const maintenanceOwner = { ...owner, subject: "native-maintenance-owner", email: "maintenance-owner@example.test" };
    const mine = await seed("maintenance", maintenanceOwner);
    const maintenanceEnv = { ...env, CLIENT_PORTAL_NOTIFICATION_MIGRATION_MAINTENANCE: "true" };
    const paused = await mutate(maintenanceOwner, mine.workspace, mine.notification, "read", maintenanceEnv);
    expect(paused.status).toBe(503);
    expect(paused.headers.get("Retry-After")).toBe("900");
    expect(await db.prepare("SELECT read_at FROM client_portal_notifications WHERE id=?").bind(mine.notification).first("read_at")).toBeNull();
    expect((await mutate(other, mine.workspace, mine.notification, "read", maintenanceEnv)).status).toBe(403);
  });

  async function seedDelivery(label:string,eligibilityOnly=false,sourceId?:string,projectOwned=false,withTerms=false) {
    const nativeOwner={...owner,subject:`delivery-${label}-${serial}`,email:`delivery-${label}-${serial}@example.test`};
    const mine=await seed(label,nativeOwner,sourceId),binding=`binding-${mine.workspace}`,principalId=mine.principalId,
      receipt=`receipt-native-delivery-${serial}`,grant=`grant-native-delivery-${serial}`,event=`event-native-delivery-${serial}`;
    const entitlement=`delivery-native-${serial}`,terms=`terms-${event}`;
    const project=`project-${serial}`,ownerScope=projectOwned?'project':'organization',ownerPublicId=projectOwned?project:mine.root;
    if(projectOwned)await db.batch([
      db.prepare("INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active) VALUES(?,?,'project',?,?,'Project','v1',1)").bind(mine.workspace,mine.generation,project,mine.root),
      db.prepare("INSERT INTO portal_v2_directory_relations(workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version) VALUES(?,?,?,'contains','organization',?,'project',?,'v1')").bind(mine.workspace,mine.generation,`edge-${serial}`,mine.root,project),
      db.prepare("INSERT INTO portal_v2_project_lifecycle(workspace_id,generation_id,project_public_id,lifecycle_status,source_version) VALUES(?,?,?,'active','v1')").bind(mine.workspace,mine.generation,project),
      db.prepare("INSERT INTO pa_portal_projection_receipts(projection_source_id,delivery_id,workspace_id,delivery_kind,payload_hash,source_sequence,status) VALUES(?,?,?,'snapshot_activate',?,1,'completed')").bind(mine.source,`projection-${serial}`,mine.workspace,'a'.repeat(64)),
      ...(withTerms?[db.prepare("INSERT INTO portal_project_access_terms(id,workspace_id,source_id,project_public_id,kind,mode,created_by_actor_type,created_by_actor_id) VALUES(?,?,?,?,'collaborator','project_end','staff','test')")
        .bind(terms,mine.workspace,mine.source,project)]:[]),
    ]);
    await db.batch([
      db.prepare(`INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version,status)
        VALUES(?,?,?,?,'clients/native-delivery/','project_alpha','v1','active')`).bind(binding,mine.workspace,ownerScope,ownerPublicId),
      db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status,access_terms_id)
        VALUES(?,?,?,'delivery.view','allow',?,?,'project_alpha','active',?)`).bind(entitlement,mine.workspace,mine.identity,
          withTerms?'project':'folder',withTerms?project:binding,withTerms?terms:null),
      db.prepare(`INSERT INTO project_alpha_delivery_intent_receipts(receipt_id,delivery_id,request_fingerprint,access_mode,resource_id,status,project_alpha_source_id)
        VALUES(?,?,?,'portal',?,'accepted',?)`).bind(receipt,`delivery-native-${serial}`,"c".repeat(64),grant,mine.source),
      db.prepare(`INSERT INTO project_alpha_delivery_portal_grants(id,receipt_id,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,audience_source_version,grant_version,status,actor_id)
        VALUES(?,?,?,?,?,'principal',?,?,1,'active','project-alpha')`).bind(grant,receipt,mine.workspace,binding,'v1',principalId,'member-v1'),
      db.prepare(`INSERT INTO native_delivery_recipient_events(id,source_id,workspace_id,receipt_id,grant_id,grant_version,folder_binding_id,binding_source_version,owner_scope_type,owner_public_id,r2_prefix,principal_public_id,principal_source_version,event_type)
        VALUES(?,?,?,?,?,1,?,?,?,?,'clients/native-delivery/',?,'member-v1','grant_accepted')`).bind(event,mine.source,mine.workspace,receipt,grant,binding,'v1',ownerScope,ownerPublicId,principalId),
    ]);
    if(eligibilityOnly)await db.batch([
      db.prepare("UPDATE pa_portal_principals SET identity_id=NULL WHERE workspace_id=? AND public_id=?").bind(mine.workspace,principalId),
      db.prepare(`INSERT INTO portal_v2_identity_eligibility_bindings(workspace_id,principal_public_id,identity_id,principal_source_version,verified_email)
        VALUES(?,?,?,'member-v1',?)`).bind(mine.workspace,principalId,mine.identity,nativeOwner.email),
    ]);
    const session:ClientPortalSession={accountId:'',identityId:'',workspaceId:mine.workspace,nativeSourceId:mine.source,
      nativePortalIdentityId:mine.identity,displayName:'test',role:'member',canViewBilling:false};
    return {...mine,nativeOwner,session,binding,principalId,receipt,grant,event,entitlement,project,terms};
  }
  type DeliveryFixture=Awaited<ReturnType<typeof seedDelivery>>;
  const mutateDelivery=(mine:DeliveryFixture,action:'read'|'dismiss',principal=mine.nativeOwner,bindings=env)=>new Hono().route('/api/client',
    createClientPortalRouter({resolvePrincipal:async()=>principal,repository:d1ClientPortalRepository}))
    .request(`${origin}/api/client/v2/workspaces/${mine.workspace}/native-delivery-notifications/${mine.event}`,
      {method:'PATCH',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({action})},bindings);

  it.each([false,true])("lists, reads and dismisses exact LTDS/native events with eligibility-only=%s",async eligibilityOnly=>{
    const mine=await seedDelivery(`happy-${eligibilityOnly}`,eligibilityOnly,eligibilityOnly?undefined:'project-alpha:primary');
    const listed=await history(mine.nativeOwner,mine.workspace);expect(listed.status).toBe(200);
    expect((await listed.json() as {items:Array<{id:string}>}).items.map(item=>item.id)).toContain(mine.event);
    const result=await mutateDelivery(mine,'read');expect(result.status,await result.clone().text()).toBe(200);
    expect(await db.prepare('SELECT read_at FROM native_delivery_recipient_event_state WHERE event_id=? AND recipient_identity_id=?')
      .bind(mine.event,mine.identity).first('read_at')).toEqual(expect.any(String));
    expect([403,404]).toContain((await mutateDelivery(mine,'dismiss',other)).status);
    expect((await mutateDelivery(mine,'dismiss')).status).toBe(200);
    const dismissed=await history(mine.nativeOwner,mine.workspace);expect(dismissed.status).toBe(200);
    expect((await dismissed.json() as {items:Array<{id:string}>}).items.map(item=>item.id)).not.toContain(mine.event);
  });

  it('pauses native delivery state writes only after resolving workspace authority',async()=>{
    const mine=await seedDelivery('delivery-maintenance');
    const paused=await mutateDelivery(mine,'read',mine.nativeOwner,{...env,CLIENT_PORTAL_NOTIFICATION_MIGRATION_MAINTENANCE:'true'});
    expect(paused.status).toBe(503);expect(paused.headers.get('Retry-After')).toBe('900');
    expect(await db.prepare('SELECT count(*) FROM native_delivery_recipient_event_state WHERE event_id=?').bind(mine.event).first('count(*)')).toBe(0);
  });

  it('never transfers former-identity read state to a new exact principal binding',async()=>{
    const mine=await seedDelivery('identity-state'),next={...mine.nativeOwner,subject:'replacement-person',email:'replacement@example.test'},identity=`replacement-${mine.event}`;
    expect((await mutateDelivery(mine,'read')).status).toBe(200);
    await db.batch([
      db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES(?,?,?,?,'active')").bind(identity,next.issuer,next.subject,next.email),
      db.prepare("INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status,source_version) VALUES(?,?,?,'project_alpha','active','member-v1')").bind(`membership-${identity}`,mine.workspace,identity),
      db.prepare("UPDATE pa_portal_principals SET identity_id=?,email_hint=? WHERE workspace_id=? AND public_id=?").bind(identity,next.email,mine.workspace,mine.principalId),
      ...[['workspace.view','workspace',mine.workspace],['delivery.view','folder',mine.binding]].map(([capability,scopeType,scopePublicId])=>
        db.prepare("INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status) VALUES(?,?,?,?,'allow',?,?,'project_alpha','active')")
          .bind(`${identity}-${capability}`,mine.workspace,identity,capability,scopeType,scopePublicId)),
    ]);
    expect((await mutateDelivery(mine,'dismiss')).status).toBe(404);
    const page=await history(next,mine.workspace);expect(page.status).toBe(200);
    expect((await page.json() as {items:Array<{id:string;readAt:string|null}>}).items.find(item=>item.id===mine.event)?.readAt).toBeNull();
    expect((await mutateDelivery(mine,'read',next)).status).toBe(200);
    expect(await db.prepare('SELECT count(*) n FROM native_delivery_recipient_event_state WHERE event_id=?').bind(mine.event).first('n')).toBe(2);
  });

  it('makes an explicit A-to-B principal rebind authoritative over stale eligibility',async()=>{
    const mine=await seedDelivery('identity-rebind-precedence',true),replacement={...mine.nativeOwner,subject:'replacement-same-email'},
      replacementIdentity=`replacement-${mine.event}`;
    await db.batch([
      db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES(?,?,?,?,'active')")
        .bind(replacementIdentity,replacement.issuer,replacement.subject,replacement.email),
      db.prepare("INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status,source_version) VALUES(?,?,?,'project_alpha','active','member-v1')")
        .bind(`membership-${replacementIdentity}`,mine.workspace,replacementIdentity),
      ...[['workspace.view','workspace',mine.workspace],['delivery.view','folder',mine.binding]].map(([capability,scopeType,scopePublicId])=>
        db.prepare("INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status) VALUES(?,?,?,?,'allow',?,?,'project_alpha','active')")
          .bind(`${replacementIdentity}-${capability}`,mine.workspace,replacementIdentity,capability,scopeType,scopePublicId)),
    ]);

    let reached=false;
    expect(await mutateNativeDeliveryNotification(env,mine.nativeOwner,mine.session,mine.event,'read',async()=>{
      reached=true;
      await db.prepare("UPDATE pa_portal_principals SET identity_id=? WHERE workspace_id=? AND public_id=?")
        .bind(replacementIdentity,mine.workspace,mine.principalId).run();
    })).toBe(false);
    expect(reached).toBe(true);
    expect(await db.prepare('SELECT count(*) FROM native_delivery_recipient_event_state WHERE event_id=?')
      .bind(mine.event).first('count(*)')).toBe(0);

    expect((await history(mine.nativeOwner,mine.workspace)).status).toBe(403);
    expect([403,404]).toContain((await mutateDelivery(mine,'read')).status);
    const replacementHistory=await history(replacement,mine.workspace);
    expect(replacementHistory.status).toBe(200);
    expect((await replacementHistory.json() as {items:Array<{id:string;readAt:string|null}>}).items)
      .toContainEqual(expect.objectContaining({id:mine.event,readAt:null}));
    expect((await mutateDelivery(mine,'read',replacement)).status).toBe(200);
    expect(await db.prepare('SELECT count(*) FROM native_delivery_recipient_event_state WHERE event_id=? AND recipient_identity_id=?')
      .bind(mine.event,replacementIdentity).first('count(*)')).toBe(1);
    expect(await db.prepare('SELECT count(*) FROM native_delivery_recipient_event_state WHERE event_id=? AND recipient_identity_id=?')
      .bind(mine.event,mine.identity).first('count(*)')).toBe(0);
  });

  it('database constraints reject changing immutable receipt, grant and membership ownership',async()=>{
    const mine=await seedDelivery('immutable-authority');
    await expect(db.prepare("UPDATE project_alpha_delivery_intent_receipts SET project_alpha_source_id='project-alpha:other' WHERE receipt_id=?").bind(mine.receipt).run()).rejects.toThrow('immutable');
    await expect(db.prepare("UPDATE project_alpha_delivery_portal_grants SET expires_at='2020-01-01' WHERE id=?").bind(mine.grant).run()).rejects.toThrow('immutable');
    await expect(db.prepare("UPDATE portal_v2_workspace_memberships SET source_type='operations' WHERE workspace_id=?").bind(mine.workspace).run()).rejects.toThrow('immutable');
  });

  const races:Array<[string,(mine:DeliveryFixture)=>Promise<unknown>]>=[
    ['source revision',m=>db.prepare("UPDATE pa_portal_source_authorities SET version=version+1 WHERE source_id=?").bind(m.source).run()],
    ['root revocation',m=>db.prepare("INSERT INTO portal_v2_root_access_policies(projection_source_id,root_type,root_public_id,state,reason_code,created_by_staff_id,updated_by_staff_id) VALUES(?,'organization',?,'revoked','test','test','test')").bind(m.source,m.root).run()],
    ['generation change',m=>db.prepare("UPDATE portal_v2_directory_generations SET status='superseded' WHERE id=?").bind(m.generation).run()],
    ['root version',m=>db.prepare("UPDATE portal_v2_directory_entities SET source_version='v2' WHERE workspace_id=? AND public_id=?").bind(m.workspace,m.root).run()],
    ['lineage active state',m=>db.prepare("UPDATE portal_v2_directory_entities SET active=0 WHERE workspace_id=? AND public_id=?").bind(m.workspace,m.root).run()],
    ['principal version',m=>db.prepare("UPDATE pa_portal_principals SET source_version='member-v2' WHERE workspace_id=? AND public_id=?").bind(m.workspace,m.principalId).run()],
    ['principal rebind',m=>db.prepare("UPDATE pa_portal_principals SET identity_id=NULL WHERE workspace_id=? AND public_id=?").bind(m.workspace,m.principalId).run()],
    ['binding version',m=>db.prepare("UPDATE portal_v2_folder_bindings SET source_version='v2' WHERE id=?").bind(m.binding).run()],
    ['binding prefix',m=>db.prepare("UPDATE portal_v2_folder_bindings SET r2_prefix='clients/changed/' WHERE id=?").bind(m.binding).run()],
    ['grant revoked version',m=>db.prepare("UPDATE project_alpha_delivery_portal_grants SET grant_version=2,status='revoked',revoked_at=datetime('now'),revoke_reason_code='project_alpha_delivery_revoked' WHERE id=?").bind(m.grant).run()],
    ['grant expiry transition',m=>db.prepare("UPDATE project_alpha_delivery_portal_grants SET grant_version=2,status='expired' WHERE id=?").bind(m.grant).run()],
    ['membership revoked',m=>db.prepare("UPDATE portal_v2_workspace_memberships SET revoked_at=datetime('now') WHERE workspace_id=?").bind(m.workspace).run()],
    ['membership version',m=>db.prepare("UPDATE portal_v2_workspace_memberships SET source_version='member-v2' WHERE workspace_id=?").bind(m.workspace).run()],
    ['identity revoked',m=>db.prepare("UPDATE portal_v2_identities SET revoked_at=datetime('now') WHERE id=?").bind(m.identity).run()],
    ['identity email',m=>db.prepare("UPDATE portal_v2_identities SET verified_email='changed@example.test' WHERE id=?").bind(m.identity).run()],
    ['allow revoked',m=>db.prepare("UPDATE portal_v2_entitlements SET revoked_at=datetime('now') WHERE id=?").bind(m.entitlement).run()],
    ['allow expired',m=>db.prepare("UPDATE portal_v2_entitlements SET expires_at='2020-01-01' WHERE id=?").bind(m.entitlement).run()],
    ['delivery deny',m=>db.prepare("INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status) VALUES(?,?,?,'delivery.view','deny','folder',?,'operations','active')").bind(`deny-${m.event}`,m.workspace,m.identity,m.binding).run()],
    ['shell deny',m=>db.prepare("INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status) VALUES(?,?,?,'workspace.view','deny','workspace',?,'operations','active')").bind(`deny-${m.event}`,m.workspace,m.identity,m.workspace).run()],
    ['identity deny',m=>db.prepare("INSERT INTO portal_v2_identity_denials(id,identity_id,workspace_id,scope_type,scope_public_id,status,reason_code,created_by_actor_type,created_by_actor_id) VALUES(?,?,?,'folder',?,'active','test','system','test')").bind(`deny-${m.event}`,m.identity,m.workspace,m.binding).run()],
  ];
  it.each(races)('atomically denies an interleaved %s change',async(name,race)=>{
    const mine=await seedDelivery(`race-${name.replaceAll(' ','-')}`,false,name==='membership version'?'project-alpha:primary':undefined);
    let reached=false;
    expect(await mutateNativeDeliveryNotification(env,mine.nativeOwner,mine.session,mine.event,'read',async()=>{reached=true;await race(mine);})).toBe(false);
    expect(reached).toBe(true);
    expect(await db.prepare('SELECT count(*) FROM native_delivery_recipient_event_state WHERE event_id=?').bind(mine.event).first('count(*)')).toBe(0);
  });

  it.each(['version','email','rebind'])('denies stale eligibility %s before and during state writes',async change=>{
    const mine=await seedDelivery(`eligible-${change}`,true);
    let reached=false;
    expect(await mutateNativeDeliveryNotification(env,mine.nativeOwner,mine.session,mine.event,'read',async()=>{
      reached=true;
      if(change==='rebind')await db.prepare('DELETE FROM portal_v2_identity_eligibility_bindings WHERE workspace_id=? AND identity_id=?').bind(mine.workspace,mine.identity).run();
      else {const column=change==='version'?'principal_source_version':'verified_email';
        await db.prepare(`UPDATE portal_v2_identity_eligibility_bindings SET ${column}=? WHERE workspace_id=? AND identity_id=?`)
          .bind(change==='email'?'different@example.test':'stale',mine.workspace,mine.identity).run();}
    })).toBe(false);
    expect(reached).toBe(true);expect([403,404]).toContain((await mutateDelivery(mine,'read')).status);
  });

  it('rechecks completed-project access terms inside an existing read-state update',async()=>{
    const mine=await seedDelivery('terms-expiry',false,'project-alpha:primary',true,true),terms=mine.terms;
    expect((await mutateDelivery(mine,'read')).status).toBe(200);
    let reached=false;
    expect(await mutateNativeDeliveryNotification(env,mine.nativeOwner,mine.session,mine.event,'dismiss',async()=>{
      reached=true;
      await db.prepare("UPDATE portal_v2_project_lifecycle SET lifecycle_status='completed',completed_at=datetime('now','-8 days'),source_version='v2' WHERE workspace_id=? AND project_public_id=?")
        .bind(mine.workspace,mine.project).run();
      // The production lifecycle trigger creates the immutable deadline.
      expect(await db.prepare("SELECT datetime(deadline_at)<=datetime('now') expired FROM portal_project_access_deadlines WHERE access_terms_id=?")
        .bind(terms).first('expired')).toBe(1);
    })).toBe(false);
    expect(reached).toBe(true);
    expect(await db.prepare('SELECT dismissed_at FROM native_delivery_recipient_event_state WHERE event_id=? AND recipient_identity_id=?')
      .bind(mine.event,mine.identity).first('dismissed_at')).toBeNull();
  });

  it('rejects a newly introduced ancestor deny without trusting the old scope list',async()=>{
    const mine=await seedDelivery('new-ancestor',false,'project-alpha:primary',true),department=`dept-${mine.event}`;
    let reached=false;
    expect(await mutateNativeDeliveryNotification(env,mine.nativeOwner,mine.session,mine.event,'read',async()=>{
      reached=true;
      await db.batch([
        db.prepare("INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active) VALUES(?,?,'department',?,?,'Department','v1',1)").bind(mine.workspace,mine.generation,department,mine.root),
        db.prepare("INSERT INTO portal_v2_directory_relations(workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version) VALUES(?,?,?,'contains','organization',?,'department',?,'v1')").bind(mine.workspace,mine.generation,`edge-org-${mine.event}`,mine.root,department),
        db.prepare("INSERT INTO portal_v2_directory_relations(workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version) VALUES(?,?,?,'contains','department',?,'project',?,'v1')").bind(mine.workspace,mine.generation,`edge-proj-${mine.event}`,department,mine.project),
        db.prepare("INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status) VALUES(?,?,?,'delivery.view','deny','department',?,'operations','active')").bind(`deny-${mine.event}`,mine.workspace,mine.identity,department),
      ]);
    })).toBe(false);
    expect(reached).toBe(true);
    expect(await db.prepare('SELECT count(*) n FROM native_delivery_recipient_event_state WHERE event_id=?').bind(mine.event).first('n')).toBe(0);
  });
});
