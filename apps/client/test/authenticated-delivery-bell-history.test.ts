import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClientNotificationHistoryRouter, mutateAuthenticatedDeliveryNotification } from "../src/worker/client-portal/notification-history";
import { reservePrimaryPortalSigningKeys } from "../src/worker/project-alpha-portal-authority";
import { readNativeAuthenticatedDeliveryGrants } from "../src/worker/client-portal/authenticated-delivery-grants";
import { resolveNativePortalWorkspaceReadContext } from "../src/worker/client-portal/workspace-v2";
import type { EffectivePortalWorkspaceContext } from "../src/worker/client-portal/workspace-v2";
import type { ClientPortalSession, VerifiedClientPrincipal } from "../src/worker/client-portal/types";
import type { Env } from "../src/worker/types";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const origin = "https://client.example.test";
const nativeHistoryCreatedAt = "2026-09-01T00:00:00.000Z";
const primaryPrincipal: VerifiedClientPrincipal = {
  issuer: "https://issuer.test", subject: "bell-effective-subject", email: "bell-effective@example.test",
};
const nativePrincipal: VerifiedClientPrincipal = {
  issuer: "https://issuer.test", subject: "bell-native-subject", email: "bell-native@example.test",
};

type Vars = {
  clientSession: ClientPortalSession;
  clientPrincipal: VerifiedClientPrincipal;
  clientWorkspace: EffectivePortalWorkspaceContext | null;
};

describe("authenticated delivery bell history — migrated D1", { timeout: 240_000 }, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-07-22", modules: true,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: { DELIVERY_DB: "authenticated-bell-history" } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"));
      if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
    }
    env = {
      DELIVERY_DB: db,
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true",
      CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED: "true",
      CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true",
      AUTHENTICATED_DELIVERY_GRANTS_ENABLED: "true",
      CLIENT_PORTAL_ORIGIN: origin,
      DELIVERY_SESSION_SECRET: "authenticated-bell-history-session-secret-0001",
      PROJECT_ALPHA_PORTAL_HMAC_SECRET: "authenticated-bell-history-primary-hmac-secret-0001",
      ENVIRONMENT: "development",
    } as Env;
    await reservePrimaryPortalSigningKeys(env);
    await seedFixtures();
  }, 180_000);

  afterAll(async () => runtime?.dispose());

  afterEach(async ({ task }) => {
    if (task.name !== "paginates native authenticated and legacy delivery kinds without loss") return;
    // This suite shares one migrated database. Keep pagination's extra notices
    // out of subsequent first-page checks without deleting immutable events or
    // changing the original native and legacy notices used by those checks.
    await db.prepare(`INSERT INTO authenticated_delivery_recipient_event_state
      (event_id,recipient_identity_id,dismissed_at)
      SELECT id,identity_id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM authenticated_delivery_recipient_events
      WHERE workspace_id='bell-native-workspace' AND identity_id='bell-native-global'
        AND id GLOB 'bell-native-page-*-event'`).run();
  });

  const effectiveWorkspace: EffectivePortalWorkspaceContext = {
    workspaceId: "bell-effective-workspace", identityId: "bell-effective-global", rootType: "organization",
    rootPublicId: "bell-effective-org", legacyAccountId: "bell-effective-account", legacyIdentityId: "bell-effective-legacy",
    displayName: "Effective bell workspace", role: "manager", canViewBilling: false,
  };
  const effectiveSession: ClientPortalSession = {
    accountId: "bell-effective-account", identityId: "bell-effective-legacy", workspaceId: effectiveWorkspace.workspaceId,
    principalIssuer: primaryPrincipal.issuer, principalSubject: primaryPrincipal.subject, principalEmail: primaryPrincipal.email,
    displayName: effectiveWorkspace.displayName, role: "manager", canViewBilling: false,
  };
  const nativeSession: ClientPortalSession = {
    accountId: "", identityId: "", workspaceId: "bell-native-workspace", nativeSourceId: "project-alpha:bellnative",
    nativePortalIdentityId: "bell-native-global", principalIssuer: nativePrincipal.issuer, principalSubject: nativePrincipal.subject,
    principalEmail: nativePrincipal.email, displayName: "Native bell workspace", role: "member", canViewBilling: false,
  };

  function historyApp(principal: VerifiedClientPrincipal, session: ClientPortalSession, workspace: EffectivePortalWorkspaceContext | null) {
    const app = new Hono<{ Bindings: Env; Variables: Vars }>();
    app.use("*", async (c, next) => {
      c.set("clientPrincipal", principal);
      c.set("clientSession", session);
      c.set("clientWorkspace", workspace);
      await next();
    });
    app.route("/", createClientNotificationHistoryRouter({
      // Keep this suite focused on the new source. Existing ledgers are omitted
      // so they cannot hide the authenticated event under test.
      notificationSchemaAvailable: async () => false,
      feedbackSchemaAvailable: async () => false,
    }));
    return app;
  }

  async function seedFixtures() {
    await db.batch([
      db.prepare(`INSERT INTO client_accounts(id,display_name,status,project_alpha_organization_id,project_alpha_source_id)
        VALUES('bell-effective-account','Effective account','active','bell-effective-org','project-alpha:primary')`),
      db.prepare(`INSERT INTO client_identity_links(id,account_id,issuer,subject,email)
        VALUES('bell-effective-legacy','bell-effective-account',?,?,?)`).bind(primaryPrincipal.issuer, primaryPrincipal.subject, primaryPrincipal.email),
      db.prepare(`INSERT INTO client_account_members(account_id,identity_id,role)
        VALUES('bell-effective-account','bell-effective-legacy','manager')`),
      db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,legacy_account_id,display_name,status,project_alpha_source_id)
        VALUES('bell-effective-workspace','organization','bell-effective-org','bell-effective-account','Effective bell workspace','active','project-alpha:primary')`),
      db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status)
        VALUES('bell-effective-global',?,?,?,'active')`).bind(primaryPrincipal.issuer, primaryPrincipal.subject, primaryPrincipal.email),
      db.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status,source_version)
        VALUES('bell-effective-membership','bell-effective-workspace','bell-effective-global','legacy','active','bell-effective-v1')`),
      db.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status)
        VALUES('bell-effective-workspace','bell-effective-principal','bell-effective-global',?,'Effective bell principal','bell-effective-v1','active')`).bind(primaryPrincipal.email),
      db.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete,activated_at)
        VALUES('bell-effective-generation','bell-effective-workspace','bell-effective-generation',1,'active',1,datetime('now'))`),
      db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active)
        VALUES('bell-effective-workspace','bell-effective-generation','organization','bell-effective-org',NULL,'Effective bell org','bell-effective-v1',1)`),
      db.prepare(`INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version)
        VALUES('bell-effective-generation','bell-effective-workspace',3)`),
      db.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence)
        VALUES('bell-effective-workspace','bell-effective-generation',1)`),
      db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,source_version,status)
        VALUES('bell-effective-view','bell-effective-workspace','bell-effective-global','workspace.view','allow','workspace','bell-effective-workspace','project_alpha','bell-effective-v1','active'),
          ('bell-effective-delivery','bell-effective-workspace','bell-effective-global','delivery.view','allow','folder','bell-effective-binding','project_alpha','bell-effective-v1','active')`),
      db.prepare(`INSERT INTO portal_v2_identity_eligibility_bindings(identity_id,workspace_id,principal_public_id,principal_source_version,verified_email)
        VALUES('bell-effective-global','bell-effective-workspace','bell-effective-principal','bell-effective-v1',?)`).bind(primaryPrincipal.email),
      db.prepare(`INSERT INTO portal_v2_identity_eligibility_legacy_bridges(workspace_id,identity_id,legacy_account_id,legacy_identity_id)
        VALUES('bell-effective-workspace','bell-effective-global','bell-effective-account','bell-effective-legacy')`),
      db.prepare(`INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version,status)
        VALUES('bell-effective-binding','bell-effective-workspace','organization','bell-effective-org','clients/bell/effective/','project_alpha','bell-effective-v1','active')`),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants(id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id)
        VALUES('bell-effective-grant','bell-effective-logical',1,'bell-effective-workspace','bell-effective-binding','bell-effective-v1','principal','bell-effective-principal','bell-effective-v1','bell-test','staff-bell')`),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_recipients(grant_id,workspace_id,principal_public_id,identity_id,principal_source_version)
        VALUES('bell-effective-grant','bell-effective-workspace','bell-effective-principal','bell-effective-global','bell-effective-v1')`),
      db.prepare(`INSERT INTO portal_authenticated_delivery_notification_policies(grant_id,grant_version,logical_grant_id,workspace_id,source_id,identity_id,principal_public_id,principal_source_version,access_notice_enabled,change_mode,updated_by_staff_id)
        VALUES('bell-effective-grant',1,'bell-effective-logical','bell-effective-workspace','project-alpha:primary','bell-effective-global','bell-effective-principal','bell-effective-v1',1,'both','staff-bell')`),
    ]);
    await seedBatch("effective", "project-alpha:primary", "bell-effective-workspace", "bell-effective-global", "bell-effective-binding", "bell-effective-grant", "bell-effective-logical", "bell-effective-principal", "bell-effective-v1", "bell-effective-org");
    // Keep the 0189 receipt test self-contained. The migrated fixture has the
    // directory snapshot but no PA projection snapshot, so provide the
    // minimum coherent projection checkpoint required by the receipt trigger.
    await db.batch([
      db.prepare(`INSERT INTO pa_portal_projection_generations
        (id,workspace_id,source_generation,source_sequence,snapshot_hash,page_count,record_count,workspace_root_type,workspace_root_public_id,workspace_display_name,workspace_source_version,workspace_active,status,complete,projection_source_id)
        VALUES('bell-effective-projection','bell-effective-workspace','bell-effective-projection',1,?,1,1,'organization','bell-effective-org','Effective bell workspace','bell-effective-v1',1,'active',1,'project-alpha:primary')`).bind("a".repeat(64)),
      db.prepare(`INSERT INTO pa_portal_projection_checkpoints
        (workspace_id,source_generation,source_sequence,snapshot_generation_id)
        VALUES('bell-effective-workspace','bell-effective-projection',1,'bell-effective-projection')`),
    ]);

    await db.batch([
      db.prepare(`INSERT INTO pa_portal_source_authorities(source_id,producer_binding_id,snapshot_origin,snapshot_base_path,application_key,state,active_revision,version,connector_revision,connector_version)
        VALUES('project-alpha:bellnative','bellnative-binding','https://native.example.test','/api/portal','bellnative','active',1,1,1,1)`),
      db.prepare(`INSERT INTO pa_portal_source_authority_revisions(source_id,revision,credential_ref,access_issuer,access_audience,access_subject,current_key_id,current_key_fingerprint,created_by)
        VALUES('project-alpha:bellnative',1,'bellnative-credential','https://native.example.test','bellnative','bellnative-subject','bellnative-key',?, 'staff-bell')`).bind("b".repeat(64)),
      db.prepare(`INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id)
        VALUES('bell-native-workspace','project-alpha:bellnative','bell-native-source-workspace')`),
      db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id)
        VALUES('bell-native-workspace','organization','bell-native-org','Native bell workspace','active','project-alpha:bellnative')`),
      db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status)
        VALUES('bell-native-global',?,?,?,'active')`).bind(nativePrincipal.issuer, nativePrincipal.subject, nativePrincipal.email),
      db.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status,source_version)
        VALUES('bell-native-membership','bell-native-workspace','bell-native-global','project_alpha','active','bell-native-v1')`),
      db.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status)
        VALUES('bell-native-workspace','bell-native-principal','bell-native-global',?,'Native bell principal','bell-native-v1','active')`).bind(nativePrincipal.email),
      db.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete,activated_at)
        VALUES('bell-native-generation','bell-native-workspace','bell-native-generation',1,'active',1,datetime('now'))`),
      db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active)
        VALUES('bell-native-workspace','bell-native-generation','organization','bell-native-org',NULL,'Native bell org','bell-native-v1',1)`),
      db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active)
        VALUES('bell-native-workspace','bell-native-generation','project','bell-native-project','bell-native-org','Native bell project','bell-native-v1',1)`),
      db.prepare(`INSERT INTO portal_v2_project_lifecycle(workspace_id,generation_id,project_public_id,lifecycle_status,source_version)
        VALUES('bell-native-workspace','bell-native-generation','bell-native-project','active','bell-native-v1')`),
      db.prepare(`INSERT INTO portal_v2_directory_relations
        (workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version,active)
        VALUES('bell-native-workspace','bell-native-generation','bell-native-contains-project','contains','organization','bell-native-org','project','bell-native-project','bell-native-v1',1)`),
      db.prepare(`INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version)
        VALUES('bell-native-generation','bell-native-workspace',3)`),
      db.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence)
        VALUES('bell-native-workspace','bell-native-generation',1)`),
      db.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,source_version,status)
        VALUES('bell-native-view','bell-native-workspace','bell-native-global','workspace.view','allow','workspace','bell-native-workspace','project_alpha','bell-native-v1','active'),
          ('bell-native-delivery','bell-native-workspace','bell-native-global','delivery.view','allow','folder','bell-native-binding','project_alpha','bell-native-v1','active')`),
      db.prepare(`INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version,status)
        VALUES('bell-native-binding','bell-native-workspace','project','bell-native-project','clients/bell/native/','project_alpha','bell-native-v1','active')`),
      db.prepare(`INSERT INTO portal_native_staff_bindings(binding_id,source_id,workspace_id,project_id,project_public_id,r2_prefix,division_id)
        VALUES('bell-native-binding','project-alpha:bellnative','bell-native-workspace','bell-native-project','bell-native-project','clients/bell/native/','bell-native-division')`),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants(id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id)
        VALUES('bell-native-grant','bell-native-auth-logical',1,'bell-native-workspace','bell-native-binding','bell-native-v1','principal','bell-native-principal','bell-native-v1','bell-test','staff-bell')`),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_recipients(grant_id,workspace_id,principal_public_id,identity_id,principal_source_version)
        VALUES('bell-native-grant','bell-native-workspace','bell-native-principal','bell-native-global','bell-native-v1')`),
      db.prepare(`INSERT INTO portal_native_staff_grants
        (grant_id,binding_id,source_id,authorization_id,actor_id,idempotency_key,fingerprint,state,publication_deadline)
        VALUES('bell-native-grant','bell-native-binding','project-alpha:bellnative','bell-native-authorization','staff-bell','bell-native-idempotency',?,'pending',datetime('now','+1 day'))`)
        .bind("d".repeat(64)),
      db.prepare(`INSERT INTO portal_authenticated_delivery_notification_policies(grant_id,grant_version,logical_grant_id,workspace_id,source_id,identity_id,principal_public_id,principal_source_version,access_notice_enabled,change_mode,updated_by_staff_id)
        VALUES('bell-native-grant',1,'bell-native-auth-logical','bell-native-workspace','project-alpha:bellnative','bell-native-global','bell-native-principal','bell-native-v1',1,'both','staff-bell')`),
    ]);
    await db.prepare("UPDATE portal_native_staff_grants SET state='active' WHERE grant_id='bell-native-grant'").run();
    await seedBatch("native", "project-alpha:bellnative", "bell-native-workspace", "bell-native-global", "bell-native-binding", "bell-native-grant", "bell-native-auth-logical", "bell-native-principal", "bell-native-v1", "bell-native-project", "project", nativeHistoryCreatedAt);
    // Keep one independent legacy native-delivery event so the history merge
    // exercises two existing kinds without reusing the authenticated grant ID.
    await db.batch([
      db.prepare(`INSERT INTO project_alpha_delivery_intent_receipts
        (receipt_id,delivery_id,request_fingerprint,access_mode,resource_id,status,project_alpha_source_id)
        VALUES('bell-native-legacy-receipt','bell-native-legacy-delivery',?,'portal','bell-native-legacy-grant','accepted','project-alpha:bellnative')`).bind("e".repeat(64)),
      db.prepare(`INSERT INTO project_alpha_delivery_portal_grants
        (id,receipt_id,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,audience_source_version,grant_version,status,actor_id)
        VALUES('bell-native-legacy-grant','bell-native-legacy-receipt','bell-native-workspace','bell-native-binding','bell-native-v1','principal','bell-native-principal','bell-native-v1',1,'active','staff-bell')`),
      db.prepare(`INSERT INTO native_delivery_recipient_events
        (id,source_id,workspace_id,receipt_id,grant_id,grant_version,folder_binding_id,binding_source_version,owner_scope_type,owner_public_id,r2_prefix,principal_public_id,principal_source_version,event_type,created_at)
        VALUES('bell-native-legacy-event','project-alpha:bellnative','bell-native-workspace','bell-native-legacy-receipt','bell-native-legacy-grant',1,'bell-native-binding','bell-native-v1','project','bell-native-project','clients/bell/native/','bell-native-principal','bell-native-v1','grant_accepted',?)`).bind(nativeHistoryCreatedAt),
    ]);
  }

  async function seedBatch(label: string, source: string, workspace: string, identity: string, binding: string, grant: string,
    logicalGrant: string, principal: string, principalVersion: string, owner: string, ownerScopeType: "organization" | "project" = "organization",
    eventCreatedAt = new Date().toISOString()) {
    const batch = `bell-${label}-batch`, event = `bell-${label}-event`, policyVersion = 1;
    await db.batch([
      db.prepare(`INSERT INTO portal_authenticated_delivery_change_batches
        (id,grant_id,grant_version,logical_grant_id,workspace_id,source_id,folder_binding_id,binding_source_version,owner_scope_type,owner_public_id,r2_prefix,identity_id,principal_public_id,principal_source_version,policy_version,eligible_at,added_count,removed_count,bell_published_at)
        VALUES(?,?,1,?,?,?,?,?,? ,?,?,?, ?,?, ?,datetime('now','-1 second'),2,0,datetime('now'))`)
        .bind(batch,grant,logicalGrant,workspace,source,binding,principalVersion,ownerScopeType,owner,owner === "bell-effective-org" ? "clients/bell/effective/" : "clients/bell/native/",identity,principal,principalVersion,policyVersion),
      db.prepare(`INSERT INTO authenticated_delivery_recipient_events
        (id,batch_id,grant_id,grant_version,logical_grant_id,source_id,workspace_id,folder_binding_id,binding_source_version,owner_scope_type,owner_public_id,r2_prefix,identity_id,principal_public_id,principal_source_version,policy_version,added_count,removed_count,created_at)
        SELECT ?,id,grant_id,grant_version,logical_grant_id,source_id,workspace_id,folder_binding_id,binding_source_version,owner_scope_type,owner_public_id,r2_prefix,identity_id,principal_public_id,principal_source_version,policy_version,added_count,removed_count,?
        FROM portal_authenticated_delivery_change_batches WHERE id=?`).bind(event,eventCreatedAt,batch),
    ]);
  }

  async function seedNativeAuthenticatedPage(index: number, createdAt: string) {
    const suffix = String(index).padStart(2, "0");
    const grant = `bell-native-page-grant-${suffix}`;
    const logicalGrant = `bell-native-page-logical-${suffix}`;
    await db.batch([
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants
        (id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id)
        VALUES(?,?,1,'bell-native-workspace','bell-native-binding','bell-native-v1','principal','bell-native-principal','bell-native-v1','bell-pagination','staff-bell')`)
        .bind(grant, logicalGrant),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_recipients
        (grant_id,workspace_id,principal_public_id,identity_id,principal_source_version)
        VALUES(?,'bell-native-workspace','bell-native-principal','bell-native-global','bell-native-v1')`).bind(grant),
      db.prepare(`INSERT INTO portal_authenticated_delivery_notification_policies
        (grant_id,grant_version,logical_grant_id,workspace_id,source_id,identity_id,principal_public_id,principal_source_version,access_notice_enabled,change_mode,updated_by_staff_id)
        VALUES(?,1,?,'bell-native-workspace','project-alpha:bellnative','bell-native-global','bell-native-principal','bell-native-v1',1,'both','staff-bell')`)
        .bind(grant, logicalGrant),
      db.prepare(`INSERT INTO portal_native_staff_grants
        (grant_id,binding_id,source_id,authorization_id,actor_id,idempotency_key,fingerprint,state,publication_deadline)
        VALUES(?, 'bell-native-binding','project-alpha:bellnative',?,'staff-bell',?,?,'pending',datetime('now','+1 day'))`)
        .bind(grant, `bell-native-page-authorization-${suffix}`, `bell-native-page-idempotency-${suffix}`, "f".repeat(64)),
    ]);
    await db.prepare("UPDATE portal_native_staff_grants SET state='active' WHERE grant_id=?").bind(grant).run();
    await seedBatch(`native-page-${suffix}`, "project-alpha:bellnative", "bell-native-workspace", "bell-native-global",
      "bell-native-binding", grant, logicalGrant, "bell-native-principal", "bell-native-v1", "bell-native-project", "project", createdAt);
  }

  it("reads effective-workspace events by global identity, not the legacy adapter identity", async () => {
    const response = await historyApp(primaryPrincipal, effectiveSession, effectiveWorkspace).request(`${origin}/notification-history`, {}, env);
    expect(response.status, await response.clone().text()).toBe(200);
    const page = await response.json() as { coverage: { authenticatedDelivery: string }; items: Array<{ id: string; kind: string; actionPath: string | null }> };
    expect(page.coverage.authenticatedDelivery).toBe("included");
    const effectiveItem = page.items.find(item => item.id === "bell-effective-event");
    expect(effectiveItem).toEqual(expect.objectContaining({ id: "bell-effective-event", kind: "authenticated_delivery" }));
    expect(effectiveItem?.actionPath).toMatch(/^\/portal\/deliveries\?workspace=bell-effective-workspace&folder=ad1_[A-Za-z0-9_-]+$/);
  });

  it("keeps authenticated history pages immutable across mixed cursor reads", async () => {
    const historicalCreatedAt = new Date(Date.now() - 5_000).toISOString();
    for (let index = 0; index < 26; index += 1) {
      const label = `effective-page-${String(index).padStart(2, "0")}`;
      const grant = `bell-page-grant-${String(index).padStart(2, "0")}`;
      const logicalGrant = `bell-page-logical-${String(index).padStart(2, "0")}`;
      await db.batch([
        db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants
          (id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id)
          VALUES(?,?,1,'bell-effective-workspace','bell-effective-binding','bell-effective-v1','principal','bell-effective-principal','bell-effective-v1','bell-pagination','staff-bell')`)
          .bind(grant, logicalGrant),
        db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_recipients
          (grant_id,workspace_id,principal_public_id,identity_id,principal_source_version)
          VALUES(?,'bell-effective-workspace','bell-effective-principal','bell-effective-global','bell-effective-v1')`).bind(grant),
        db.prepare(`INSERT INTO portal_authenticated_delivery_notification_policies
          (grant_id,grant_version,logical_grant_id,workspace_id,source_id,identity_id,principal_public_id,principal_source_version,access_notice_enabled,change_mode,updated_by_staff_id)
          VALUES(?,1,?,'bell-effective-workspace','project-alpha:primary','bell-effective-global','bell-effective-principal','bell-effective-v1',1,'both','staff-bell')`)
          .bind(grant, logicalGrant),
      ]);
      await seedBatch(label, "project-alpha:primary", "bell-effective-workspace", "bell-effective-global",
        "bell-effective-binding", grant, logicalGrant, "bell-effective-principal",
        "bell-effective-v1", "bell-effective-org", "organization", historicalCreatedAt);
    }

    const firstResponse = await historyApp(primaryPrincipal, effectiveSession, effectiveWorkspace)
      .request(`${origin}/notification-history`, {}, env);
    expect(firstResponse.status, await firstResponse.clone().text()).toBe(200);
    const first = await firstResponse.json() as {
      asOf: string;
      items: Array<{ id: string; kind: string }>;
      nextCursor: string | null;
    };
    expect(first.items).toHaveLength(25);
    expect(first.items.every(item => item.kind === "authenticated_delivery")).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));

    // The cursor's rowid watermark must fence this event even though it is
    // inserted before the second request with the same source timestamp.
    const futureGrant = "bell-page-grant-future", futureLogicalGrant = "bell-page-logical-future";
    await db.batch([
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants
        (id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id)
        VALUES(?,?,1,'bell-effective-workspace','bell-effective-binding','bell-effective-v1','principal','bell-effective-principal','bell-effective-v1','bell-pagination','staff-bell')`)
        .bind(futureGrant, futureLogicalGrant),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_recipients
        (grant_id,workspace_id,principal_public_id,identity_id,principal_source_version)
        VALUES(?,'bell-effective-workspace','bell-effective-principal','bell-effective-global','bell-effective-v1')`).bind(futureGrant),
      db.prepare(`INSERT INTO portal_authenticated_delivery_notification_policies
        (grant_id,grant_version,logical_grant_id,workspace_id,source_id,identity_id,principal_public_id,principal_source_version,access_notice_enabled,change_mode,updated_by_staff_id)
        VALUES(?,1,?,'bell-effective-workspace','project-alpha:primary','bell-effective-global','bell-effective-principal','bell-effective-v1',1,'both','staff-bell')`)
        .bind(futureGrant, futureLogicalGrant),
    ]);
    await seedBatch("effective-page-future", "project-alpha:primary", "bell-effective-workspace", "bell-effective-global",
      "bell-effective-binding", futureGrant, futureLogicalGrant, "bell-effective-principal",
      "bell-effective-v1", "bell-effective-org", "organization", historicalCreatedAt);

    const secondResponse = await historyApp(primaryPrincipal, effectiveSession, effectiveWorkspace)
      .request(`${origin}/notification-history?cursor=${encodeURIComponent(first.nextCursor!)}`, {}, env);
    expect(secondResponse.status, await secondResponse.clone().text()).toBe(200);
    const second = await secondResponse.json() as {
      asOf: string;
      items: Array<{ id: string; kind: string }>;
      nextCursor: string | null;
    };
    expect(second.asOf).toBe(first.asOf);
    expect(second.items).toHaveLength(2);
    expect(second.items.every(item => item.kind === "authenticated_delivery")).toBe(true);
    expect(second.nextCursor).toBeNull();

    const firstIds = first.items.map(item => item.id);
    const secondIds = second.items.map(item => item.id);
    expect(new Set(firstIds).size).toBe(firstIds.length);
    expect(new Set(secondIds).size).toBe(secondIds.length);
    expect(secondIds.some(id => firstIds.includes(id))).toBe(false);
    expect([...firstIds, ...secondIds]).toHaveLength(27);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(27);
    expect(firstIds.some(id => id === "bell-effective-page-future-event")).toBe(false);
    expect(secondIds.some(id => id === "bell-effective-page-future-event")).toBe(false);
    expect([...firstIds, ...secondIds].some(id => id.startsWith("bell-native"))).toBe(false);

    // A cursor is bound to both actor and workspace scope; another source
    // cannot turn it into a cross-workspace read.
    const crossSourceResponse = await historyApp(nativePrincipal, nativeSession, null)
      .request(`${origin}/notification-history?cursor=${encodeURIComponent(first.nextCursor!)}`, {}, env);
    expect(crossSourceResponse.status, await crossSourceResponse.clone().text()).toBe(409);
  }, 180_000);

  it("paginates native authenticated and legacy delivery kinds without loss", async () => {
    for (let index = 0; index < 25; index += 1)
      await seedNativeAuthenticatedPage(index, nativeHistoryCreatedAt);

    const firstResponse = await historyApp(nativePrincipal, nativeSession, null)
      .request(`${origin}/notification-history`, {}, env);
    expect(firstResponse.status, await firstResponse.clone().text()).toBe(200);
    const first = await firstResponse.json() as {
      asOf: string;
      items: Array<{ id: string; kind: string }>;
      nextCursor: string | null;
    };
    expect(first.items).toHaveLength(25);
    expect(first.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "bell-native-legacy-event", kind: "delivery" }),
      expect.objectContaining({ kind: "authenticated_delivery" }),
    ]));
    expect(first.nextCursor).toEqual(expect.any(String));

    // Insert a backdated authenticated event after the first page. The cursor
    // must retain each stream's original rowid watermark and not surface it.
    await seedNativeAuthenticatedPage(25, nativeHistoryCreatedAt);

    const secondResponse = await historyApp(nativePrincipal, nativeSession, null)
      .request(`${origin}/notification-history?cursor=${encodeURIComponent(first.nextCursor!)}`, {}, env);
    expect(secondResponse.status, await secondResponse.clone().text()).toBe(200);
    const second = await secondResponse.json() as {
      asOf: string;
      items: Array<{ id: string; kind: string }>;
      nextCursor: string | null;
    };
    expect(second.asOf).toBe(first.asOf);
    expect(second.items).toHaveLength(2);
    expect(second.items.every(item => item.kind === "authenticated_delivery")).toBe(true);
    expect(second.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "bell-native-event", kind: "authenticated_delivery" }),
    ]));
    expect(second.nextCursor).toBeNull();

    const firstIds = first.items.map(item => item.id);
    const secondIds = second.items.map(item => item.id);
    expect(new Set(firstIds).size).toBe(firstIds.length);
    expect(new Set(secondIds).size).toBe(secondIds.length);
    expect(secondIds.some(id => firstIds.includes(id))).toBe(false);
    expect([...firstIds, ...secondIds]).toHaveLength(27);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(27);
    expect([...firstIds, ...secondIds]).not.toContain("bell-native-page-25-event");
  }, 240_000);

  it("merges authenticated delivery with the existing native history kind without cross-source leakage", async () => {
    const response = await historyApp(nativePrincipal, nativeSession, null).request(`${origin}/notification-history`, {}, env);
    expect(response.status, await response.clone().text()).toBe(200);
    const page = await response.json() as { items: Array<{ id: string; kind: string }> };
    expect(page.items.map(item => item.id)).toEqual(expect.arrayContaining(["bell-native-event", "bell-native-legacy-event"]));
    expect(page.items.find(item => item.id === "bell-native-event")?.kind).toBe("authenticated_delivery");
    expect(page.items.find(item => item.id === "bell-native-legacy-event")?.kind).toBe("delivery");
    expect(new Set(page.items.map(item => item.id)).size).toBe(page.items.length);
    expect(page.items.some(item => item.id === "bell-effective-event")).toBe(false);
  });

  it("authorizes native history with an opaque np1 folder action and fences dismiss state", async () => {
    const nativeContext = await resolveNativePortalWorkspaceReadContext(env, nativePrincipal, nativeSession.workspaceId!);
    expect(nativeContext).not.toBeNull();
    const nativeGrants = await readNativeAuthenticatedDeliveryGrants(env, nativePrincipal, nativeContext!, "bell-native-binding", { grantId: "bell-native-grant" });
    expect(nativeGrants).toEqual(expect.arrayContaining([expect.objectContaining({ source: "staff", grant_id: "bell-native-grant" })]));
    const response = await historyApp(nativePrincipal, nativeSession, null).request(`${origin}/notification-history`, {}, env);
    expect(response.status, await response.clone().text()).toBe(200);
    const page = await response.json() as { items: Array<{ id: string; kind: string; actionPath: string | null; mutationPath: string }> };
    const item = page.items.find(value => value.id === "bell-native-event");
    expect(item).toEqual(expect.objectContaining({ kind: "authenticated_delivery" }));
    expect(item?.actionPath).toMatch(/^\/portal\/deliveries\?workspace=bell-native-workspace&folder=np1_[A-Za-z0-9_-]+$/);
    expect(item?.actionPath).not.toMatch(/bell-native-binding|clients\/bell\/native/);
    expect(item?.mutationPath).toBe("/api/client/notification-history/authenticated-delivery/bell-native-event");

    const marked = await mutateAuthenticatedDeliveryNotification(env, nativePrincipal, nativeSession, null, "bell-native-event", "read");
    expect(marked).toBe(true);
    expect(await db.prepare("SELECT read_at FROM authenticated_delivery_recipient_event_state WHERE event_id=? AND recipient_identity_id=?")
      .bind("bell-native-event", "bell-native-global").first("read_at")).toEqual(expect.any(String));
    expect(await mutateAuthenticatedDeliveryNotification(env, primaryPrincipal, nativeSession, null, "bell-native-event", "dismiss")).toBe(false);
    expect(await mutateAuthenticatedDeliveryNotification(env, nativePrincipal, nativeSession, null, "bell-native-event", "dismiss")).toBe(true);
  });

  it("requires the exact active 0189 receipt and supports read-then-dismiss UPSERT", async () => {
    await db.prepare("UPDATE portal_v2_folder_bindings SET source_type='operations' WHERE id='bell-effective-binding'").run();
    const withoutReceipt = await historyApp(primaryPrincipal, effectiveSession, effectiveWorkspace)
      .request(`${origin}/notification-history`, {}, env);
    expect(withoutReceipt.status, await withoutReceipt.clone().text()).toBe(200);
    expect((await withoutReceipt.json() as { items: Array<{ id: string }> }).items)
      .not.toContainEqual(expect.objectContaining({ id: "bell-effective-event" }));
    expect(await mutateAuthenticatedDeliveryNotification(env, primaryPrincipal, effectiveSession, effectiveWorkspace, "bell-effective-event", "read")).toBe(false);

    await db.prepare(`INSERT INTO portal_primary_staff_bindings
      (binding_id,workspace_id,source_id,root_type,root_public_id,owner_scope_type,owner_public_id,project_public_id,
       directory_generation_id,snapshot_generation_id,source_sequence,root_source_version,project_source_version,r2_prefix,
       ops_project_id,ops_context_version,created_by_staff_id,reason_code,state)
      VALUES('bell-effective-binding','bell-effective-workspace','project-alpha:primary','organization','bell-effective-org','organization','bell-effective-org',NULL,
       'bell-effective-generation','bell-effective-projection',1,'bell-effective-v1',NULL,'clients/bell/effective/',NULL,?,'staff-bell','migration_0189_legacy_compat','active')`)
      .bind("0".repeat(64)).run();

    const withReceipt = await historyApp(primaryPrincipal, effectiveSession, effectiveWorkspace)
      .request(`${origin}/notification-history`, {}, env);
    expect(withReceipt.status, await withReceipt.clone().text()).toBe(200);
    expect((await withReceipt.json() as { items: Array<{ id: string }> }).items).toContainEqual(expect.objectContaining({ id: "bell-effective-event" }));
    expect(await mutateAuthenticatedDeliveryNotification(env, primaryPrincipal, effectiveSession, effectiveWorkspace, "bell-effective-event", "read")).toBe(true);
    expect(await mutateAuthenticatedDeliveryNotification(env, primaryPrincipal, effectiveSession, effectiveWorkspace, "bell-effective-event", "dismiss")).toBe(true);
    expect(await db.prepare("SELECT read_at,dismissed_at FROM authenticated_delivery_recipient_event_state WHERE event_id='bell-effective-event' AND recipient_identity_id='bell-effective-global'").first())
      .toEqual(expect.objectContaining({ read_at: expect.any(String), dismissed_at: expect.any(String) }));
    expect(await mutateAuthenticatedDeliveryNotification(env, nativePrincipal, nativeSession, null, "bell-effective-event", "read")).toBe(false);
    const crossed = { ...effectiveSession, workspaceId: "bell-native-workspace", accountId: "bell-effective-account", identityId: "bell-effective-legacy" };
    expect(await mutateAuthenticatedDeliveryNotification(env, primaryPrincipal, crossed, null, "bell-effective-event", "read")).toBe(false);
    expect(await db.prepare("SELECT count(*) FROM authenticated_delivery_recipient_event_state WHERE event_id='bell-effective-event'").first("count(*)")).toBe(1);
    // Leave the shared fixture clean for the following revocation race test.
    await db.prepare("DELETE FROM authenticated_delivery_recipient_event_state WHERE event_id='bell-effective-event'").run();
  });

  it("rejects source/workspace crossover and revocation between read and state write", async () => {
    const foreignSession = { ...effectiveSession, workspaceId: "bell-native-workspace", accountId: "", identityId: "" };
    expect(await mutateAuthenticatedDeliveryNotification(env, primaryPrincipal, foreignSession, null, "bell-effective-event", "read")).toBe(false);
    expect(await db.prepare("SELECT count(*) FROM authenticated_delivery_recipient_event_state WHERE event_id=?")
      .bind("bell-effective-event").first("count(*)")).toBe(0);

    const raced = await mutateAuthenticatedDeliveryNotification(env, primaryPrincipal, effectiveSession, effectiveWorkspace, "bell-effective-event", "read", async () => {
      await db.prepare("UPDATE portal_v2_authenticated_delivery_grants SET status='revoked',revoked_at=datetime('now'),revoked_by_staff_id='staff-bell',revoke_reason_code='test' WHERE id='bell-effective-grant'").run();
    });
    expect(raced).toBe(false);
    expect(await db.prepare("SELECT count(*) FROM authenticated_delivery_recipient_event_state WHERE event_id=?")
      .bind("bell-effective-event").first("count(*)")).toBe(0);
  });

});
