import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { readEffectiveWorkspaceVisibilityMutationGuard } from '../src/worker/client-portal/effective-workspace-visibility-mutation-guard';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { d1ClientPortalRepository } from "../src/worker/client-portal/repository";
import { readEffectiveWorkspaceIdentityMutationGuard } from "../src/worker/client-portal/effective-workspace-identity-mutation-guard";
import {
  effectiveWorkspaceNotificationMutationGuardSql,
  readEffectiveWorkspaceNotificationMutationProof,
  type EffectivePortalWorkspaceContext,
} from "../src/worker/client-portal/workspace-v2";
import type { ClientPortalSession, VerifiedClientPrincipal } from "../src/worker/client-portal/types";
import type { Env } from "../src/worker/types";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const workspaceId = "notice-workspace";
const sourceId = "project-alpha:primary";
const principal: VerifiedClientPrincipal = {
  issuer: "https://issuer.test",
  subject: "notice-subject",
  email: "notice@example.test",
};
const session: ClientPortalSession = {
  accountId: "notice-account",
  identityId: "notice-identity",
  workspaceId,
  principalIssuer: principal.issuer,
  principalSubject: principal.subject,
  principalEmail: principal.email,
  displayName: "Notice client",
  role: "manager",
  canViewBilling: false,
};
const context: EffectivePortalWorkspaceContext = {
  workspaceId,
  identityId: "portal-notice-identity",
  rootType: "organization",
  rootPublicId: "pa-org-notice",
  legacyAccountId: session.accountId,
  legacyIdentityId: session.identityId,
  displayName: session.displayName,
  role: "manager",
  canViewBilling: false,
};

describe("selected workspace notification mutation guard", { timeout: 60_000 }, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;
  let databaseIndex = 0;

  beforeAll(() => {
    runtime = new Miniflare({
      compatibilityDate: "2026-08-06",
      modules: true,
      script: "export default {fetch(){return new Response('ok')}}",
      d1Databases: Object.fromEntries(Array.from({ length: 12 }, (_, index) =>
        [`NOTICE_GUARD_DB_${index}`, `notification-mutation-guard-${index}`])),
    });
  });

  afterAll(async () => runtime.dispose());

  beforeEach(async () => {
    db = await runtime.getD1Database(`NOTICE_GUARD_DB_${databaseIndex++}`) as unknown as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"));
      if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
    }
    env = {
      DELIVERY_DB: db,
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true",
      CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true",
      CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED: "true",
    } as Env;
    await seedBase();
  });

  async function seedBase() {
    await db.batch([
      db.prepare(`INSERT INTO client_accounts
        (id,display_name,status,project_alpha_organization_id,project_alpha_source_id)
        VALUES ('notice-account','Notice client','active','pa-org-notice',?)`).bind(sourceId),
      db.prepare(`INSERT INTO client_identity_links(id,account_id,issuer,subject,email)
        VALUES ('notice-identity','notice-account','https://issuer.test','notice-subject','notice@example.test'),
          ('bridge-identity','notice-account','bridge-issuer','bridge-subject','notice@example.test')`),
      db.prepare(`INSERT INTO client_account_members(account_id,identity_id,role)
        VALUES ('notice-account','notice-identity','manager'),('notice-account','bridge-identity','member')`),
      db.prepare(`INSERT INTO projects
        (id,client_name,project_name,r2_prefix,project_alpha_source_id,project_alpha_project_id)
        VALUES ('notice-project','Notice client','Notice project','clients/notice/project/',?,'pa-project-notice')`).bind(sourceId),
      db.prepare(`INSERT INTO client_project_grants(account_id,project_id,can_request_service)
        VALUES ('notice-account','notice-project',0)`),
      db.prepare(`INSERT INTO client_member_project_grants(account_id,identity_id,project_id,granted_by_identity_id)
        VALUES ('notice-account','notice-identity','notice-project','notice-identity'),
          ('notice-account','bridge-identity','notice-project','notice-identity')`),
      db.prepare(`INSERT INTO portal_v2_workspaces
        (id,root_type,pa_organization_public_id,legacy_account_id,display_name,status,project_alpha_source_id)
        VALUES (?,'organization','pa-org-notice','notice-account','Notice client','active',?)`).bind(workspaceId, sourceId),
      db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status)
        VALUES ('portal-notice-identity','https://issuer.test','notice-subject','notice@example.test','active')`),
      db.prepare(`INSERT INTO portal_v2_workspace_memberships
        (id,workspace_id,identity_id,source_type,status,source_version)
        VALUES ('notice-membership',?,'portal-notice-identity','project_alpha','active','membership-v1')`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_generations
        (id,workspace_id,source_generation,source_sequence,status,complete,activated_at)
        VALUES ('notice-directory',?,'directory-v1',1,'active',1,datetime('now'))`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,display_name,source_version,active)
        VALUES (?,'notice-directory','organization','pa-org-notice','Notice client','directory-v1',1),
          (?,'notice-directory','project','pa-project-notice','Notice project','directory-v1',1)`).bind(workspaceId, workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version)
        VALUES ('notice-directory',?,3)`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_project_lifecycle(workspace_id,generation_id,project_public_id,lifecycle_status,source_version)
        VALUES (?,'notice-directory','pa-project-notice','active','directory-v1')`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_relations
        (workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version,active)
        VALUES (?,'notice-directory','notice-contains','contains','organization','pa-org-notice','project','pa-project-notice','directory-v1',1)`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence)
        VALUES (?,'notice-directory',1)`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,source_version,status)
        VALUES ('notice-view',?,'portal-notice-identity','workspace.view','allow','workspace',?,'project_alpha','entitlement-v1','active'),
          ('notice-request-project',?,'portal-notice-identity','request.create','allow','project','pa-project-notice','project_alpha','entitlement-v1','active'),
          ('notice-delivery-folder',?,'portal-notice-identity','delivery.view','allow','folder','folder-binding','project_alpha','entitlement-v1','active')`)
        .bind(workspaceId, workspaceId, workspaceId, workspaceId),
    ]);
  }

  async function updateWithProof(notificationId: string, action: "read" | "dismiss" = "read") {
    const proof = await readEffectiveWorkspaceNotificationMutationProof(env, principal, context, notificationId);
    expect(proof).not.toBeNull();
    const guard = await composedGuard(proof!, context);
    return d1ClientPortalRepository.updateNotification(env, session, notificationId, action, guard);
  }

  async function composedGuard(proof: NonNullable<Awaited<ReturnType<typeof readEffectiveWorkspaceNotificationMutationProof>>>,
    targetContext: EffectivePortalWorkspaceContext = context) {
    const identityGuard = await readEffectiveWorkspaceIdentityMutationGuard(env, principal, targetContext);
    const visibilityGuard = await readEffectiveWorkspaceVisibilityMutationGuard(env, targetContext);
    const capabilityGuard = effectiveWorkspaceNotificationMutationGuardSql(proof!);
    return {
      sql: `(${identityGuard.sql}) AND (${visibilityGuard.sql}) AND (${capabilityGuard.sql})`,
      bindings: [...identityGuard.bindings, ...visibilityGuard.bindings, ...capabilityGuard.bindings],
    };
  }

  it("preserves direct project request notification mutation without a local request-service grant", async () => {
    await db.batch([
      db.prepare(`INSERT INTO client_service_requests
        (id,account_id,project_id,created_by_identity_id,request_type,title,details,status,catalog_source_id,idempotency_key,request_fingerprint)
        VALUES ('request-notice-source','notice-account','notice-project','notice-identity','service','Update','Notice','submitted',?,'request-key-0001',?)`)
        .bind(sourceId, "r".repeat(43)),
      db.prepare(`INSERT INTO client_portal_notifications
        (id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body,action_path)
        VALUES ('request-notice','notice-account','notice-identity','request_status','service_request','request-notice-source','request-notice-key','Update','Request update','/portal/requests')`),
    ]);
    expect(await updateWithProof("request-notice")).toBe(true);
    expect(await db.prepare("SELECT read_at IS NOT NULL marked FROM client_portal_notifications WHERE id='request-notice'").first("marked")).toBe(1);
  });

  it("rejects request notification mutation when membership, capability, or checkpoint changes after proof", async () => {
    for (const scenario of ["membership", "capability", "workspace_view", "checkpoint"] as const) {
      const id = `request-race-${scenario}`;
      await db.batch([
        db.prepare(`INSERT INTO client_service_requests
          (id,account_id,project_id,created_by_identity_id,request_type,title,details,status,catalog_source_id,idempotency_key,request_fingerprint)
          VALUES (?,'notice-account','notice-project','notice-identity','service','Update','Notice','submitted',?,?,?)`)
          .bind(`${id}-source`, sourceId, `${id}-request-key`, "s".repeat(43)),
        db.prepare(`INSERT INTO client_portal_notifications
          (id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body,action_path)
          VALUES (?,'notice-account','notice-identity','request_status','service_request',?,?, 'Update','Request update','/portal/requests')`)
          .bind(id, `${id}-source`, `${id}-notice-key`),
      ]);
      const proof = (await readEffectiveWorkspaceNotificationMutationProof(env, principal, context, id))!;
      if (scenario === "membership") await db.prepare("UPDATE portal_v2_workspace_memberships SET revoked_at=datetime('now') WHERE id='notice-membership'").run();
      if (scenario === "capability") await db.prepare("UPDATE portal_v2_entitlements SET revoked_at=datetime('now') WHERE id='notice-request-project'").run();
      if (scenario === "workspace_view") await db.prepare("UPDATE portal_v2_entitlements SET revoked_at=datetime('now') WHERE id='notice-view'").run();
      if (scenario === "checkpoint") await db.batch([
        db.prepare(`INSERT INTO portal_v2_directory_generations
          (id,workspace_id,source_generation,source_sequence,status,complete,activated_at)
          VALUES ('notice-directory-2',?,'directory-v2',2,'active',1,datetime('now'))`).bind(workspaceId),
        db.prepare(`INSERT INTO portal_v2_directory_entities
          (workspace_id,generation_id,entity_type,public_id,display_name,source_version,active)
          VALUES (?,'notice-directory-2','organization','pa-org-notice','Notice client','directory-v2',1),
            (?,'notice-directory-2','project','pa-project-notice','Notice project','directory-v2',1)`).bind(workspaceId, workspaceId),
        db.prepare("UPDATE portal_v2_directory_checkpoints SET active_generation_id='notice-directory-2',source_sequence=2 WHERE workspace_id=?").bind(workspaceId),
      ]);
      const guard = await composedGuard(proof);
      expect(await d1ClientPortalRepository.updateNotification(env, session, id, "read", guard)).toBe(false);
      expect(await db.prepare("SELECT read_at FROM client_portal_notifications WHERE id=?").bind(id).first("read_at")).toBeNull();
      await db.prepare("UPDATE portal_v2_workspace_memberships SET revoked_at=NULL WHERE id='notice-membership'").run();
      await db.prepare("UPDATE portal_v2_entitlements SET revoked_at=NULL WHERE id='notice-request-project'").run();
      await db.prepare("UPDATE portal_v2_entitlements SET revoked_at=NULL WHERE id='notice-view'").run();
      if (scenario !== "checkpoint")
        await db.prepare("UPDATE portal_v2_directory_checkpoints SET active_generation_id='notice-directory',source_sequence=1 WHERE workspace_id=?").bind(workspaceId).run();
    }
  });

  it("preserves bridge request notification identity selection", async () => {
    await db.batch([
      db.prepare("UPDATE client_account_members SET revoked_at=datetime('now') WHERE identity_id='notice-identity'"),
      db.prepare(`INSERT INTO portal_v2_workspace_memberships
        (id,workspace_id,identity_id,source_type,status,source_version)
        VALUES ('bridge-membership',?,'portal-notice-identity','client_invitation','active','bridge-v1')
        ON CONFLICT(workspace_id,identity_id) DO UPDATE SET source_type='client_invitation',source_version='bridge-v1',status='active',revoked_at=NULL`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_invitations(id,workspace_id,token_hash,invited_email,invited_by_identity_id,status,expires_at)
        VALUES ('bridge-invite',?,'${"a".repeat(43)}','notice@example.test','portal-notice-identity','accepted',datetime('now','+1 day'))`).bind(workspaceId),
      db.prepare(`INSERT INTO portal_v2_legacy_member_bridges
        (workspace_id,identity_id,legacy_account_id,legacy_identity_id,invitation_id)
        VALUES (?,'portal-notice-identity','notice-account','bridge-identity','bridge-invite')`).bind(workspaceId),
      db.prepare(`INSERT INTO client_service_requests
        (id,account_id,project_id,created_by_identity_id,request_type,title,details,status,catalog_source_id,idempotency_key,request_fingerprint)
        VALUES ('bridge-request-source','notice-account','notice-project','bridge-identity','service','Update','Notice','submitted',?,'bridge-request-key',?)`)
        .bind(sourceId, "b".repeat(43)),
      db.prepare(`INSERT INTO client_portal_notifications
        (id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body,action_path)
        VALUES ('bridge-request-notice','notice-account','bridge-identity','request_status','service_request','bridge-request-source','bridge-request-notice-key','Update','Request update','/portal/requests')`),
    ]);
    const bridgeSession = { ...session, identityId: "bridge-identity" };
    const bridgeContext = { ...context, legacyIdentityId: "bridge-identity" };
    const proof = await readEffectiveWorkspaceNotificationMutationProof(env, principal, bridgeContext, "bridge-request-notice");
    expect(proof?.legacyIdentityId).toBe("bridge-identity");
    expect(await d1ClientPortalRepository.updateNotification(
      env, bridgeSession, "bridge-request-notice", "dismiss", await composedGuard(proof!, bridgeContext),
    )).toBe(true);
  });

  it("rejects delivery notification mutation when binding, capability, or membership changes after proof", async () => {
    await db.batch([
      db.prepare(`INSERT INTO client_folder_associations
        (id,scope_type,project_id,account_id,r2_prefix,created_by,logical_grant_id,grant_version)
        VALUES ('folder-association','project','notice-project','notice-account','clients/notice/project/','staff','logical-folder',1)`),
      db.prepare(`INSERT INTO portal_v2_folder_bindings
        (id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version,status)
        VALUES ('folder-binding',?,'project','pa-project-notice','clients/notice/project/','project_alpha','directory-v1','active')`).bind(workspaceId),
    ]);
    for (const scenario of ["binding", "capability", "membership"] as const) {
      const id = `delivery-race-${scenario}`;
      await db.prepare(`INSERT INTO client_portal_notifications
        (id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body,action_path)
        VALUES (?,'notice-account','notice-identity','files_added','folder_grant','logical-folder',?,'Files','Delivery update','/portal/projects/notice-project')`)
        .bind(id, `${id}-key`).run();
      const proof = (await readEffectiveWorkspaceNotificationMutationProof(env, principal, context, id))!;
      if (scenario === "binding") await db.prepare("UPDATE portal_v2_folder_bindings SET source_version='directory-v2' WHERE id='folder-binding'").run();
      if (scenario === "capability") await db.prepare("UPDATE portal_v2_entitlements SET revoked_at=datetime('now') WHERE id='notice-delivery-folder'").run();
      if (scenario === "membership") await db.prepare("UPDATE portal_v2_workspace_memberships SET revoked_at=datetime('now') WHERE id='notice-membership'").run();
      expect(await d1ClientPortalRepository.updateNotification(
        env, session, id, "dismiss", await composedGuard(proof),
      )).toBe(false);
      expect(await db.prepare("SELECT dismissed_at FROM client_portal_notifications WHERE id=?").bind(id).first("dismissed_at")).toBeNull();
      await db.prepare("UPDATE portal_v2_folder_bindings SET source_version='directory-v1' WHERE id='folder-binding'").run();
      await db.prepare("UPDATE portal_v2_entitlements SET revoked_at=NULL WHERE id='notice-delivery-folder'").run();
      await db.prepare("UPDATE portal_v2_workspace_memberships SET revoked_at=NULL WHERE id='notice-membership'").run();
    }
    await db.prepare(`INSERT INTO client_portal_notifications
      (id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body,action_path)
      VALUES ('delivery-legit','notice-account','notice-identity','files_added','folder_grant','logical-folder','delivery-legit-key','Files','Delivery update','/portal/projects/notice-project')`).run();
    expect(await updateWithProof("delivery-legit", "read")).toBe(true);
  });
});
