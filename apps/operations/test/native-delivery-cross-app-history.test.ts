import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Hono } from "hono";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCatalogSourceContext, PRIMARY_CATALOG_SOURCE, type CatalogSourceContext } from "@ltds/shared";
import { applyProjectAlphaDeliveryIntent } from "../src/worker/project-alpha-delivery-intents";
import { primaryDeliveryAuthorityProof } from "../src/worker/project-alpha-primary-delivery-authority";
import type { Env as OperationsEnv } from "../src/worker/types";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { reservePrimaryPortalSigningKeys } from "../../client/src/worker/project-alpha-portal-authority";
import { createClientPortalRouter } from "../../client/src/worker/client-portal/routes";
import { d1ClientPortalRepository } from "../../client/src/worker/client-portal/repository";
import type { VerifiedClientPrincipal } from "../../client/src/worker/client-portal/types";
import type { Env as ClientEnv } from "../../client/src/worker/types";

const origin = "https://client.example.test";
const primary = PRIMARY_CATALOG_SOURCE;
const secondary = createCatalogSourceContext("project-alpha:secondary");
const hmacSecret = "native-delivery-cross-app-primary-secret-0001";

type NativeFixture = {
  source: CatalogSourceContext;
  workspaceId: string;
  rootId: string;
  bindingId: string;
  principalId: string;
  owner: VerifiedClientPrincipal;
  alternate: VerifiedClientPrincipal;
  ownerIdentityId: string;
  alternateIdentityId: string;
};
const fingerprint = (payload: unknown) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");
const primaryProof = primaryDeliveryAuthorityProof({ mode: "legacy_primary", sourceId: primary.sourceId,
  revision: 0, version: 0, profile: "primary_legacy" });

describe("Operations delivery acceptance to Client native notification history — migrated D1", { timeout: 240_000 }, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: OperationsEnv & ClientEnv;

  beforeAll(async () => {
    runtime = new Miniflare({
      compatibilityDate: "2026-08-06",
      modules: true,
      script: "export default {fetch(){return new Response('ok')}}",
      d1Databases: { DELIVERY_DB: "native-delivery-cross-app-history" },
    });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const migrations = new URL("../../client/migrations/", import.meta.url);
    for (const name of readdirSync(migrations).filter(name => /^\d+.*\.sql$/.test(name) && name <= "0203_primary_delivery_authority.sql").sort()) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(name, migrations), "utf8"));
      if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
    }
    env = {
      DELIVERY_DB: db,
      OPS_DB: db,
      PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED: "true",
      PROJECT_ALPHA_PORTAL_APPLICATION_KEY: "project-alpha",
      PROJECT_ALPHA_PORTAL_HMAC_KEY_ID: "cross-app-primary-v1",
      PROJECT_ALPHA_PORTAL_HMAC_SECRET: hmacSecret,
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true",
      CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED: "true",
      CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED: "true",
      CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true",
      CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED: "true",
      AUTHENTICATED_DELIVERY_GRANTS_ENABLED: "true",
      CLIENT_PORTAL_ENABLED: "true",
      CLIENT_PORTAL_ORIGIN: origin,
      DELIVERY_SESSION_SECRET: "native-delivery-cross-app-session-secret-0001",
      ENVIRONMENT: "development",
    } as OperationsEnv & ClientEnv;
    await reservePrimaryPortalSigningKeys(env);
  }, 180_000);

  afterAll(async () => runtime?.dispose());

  async function seed(name: string, source: CatalogSourceContext): Promise<NativeFixture> {
    const workspaceId = `${name}-workspace`, rootId = `${name}-organization`, bindingId = `${name}-binding`, principalId = `${name}-principal`;
    const owner: VerifiedClientPrincipal = { issuer: "https://issuer.example.test", subject: `${name}-owner`, email: `${name}-owner@example.test` };
    // The alternate subject is deliberately a separate portal identity that is
    // explicitly eligible for the same immutable Project Alpha principal.
    const alternate: VerifiedClientPrincipal = { issuer: owner.issuer, subject: `${name}-alternate`, email: owner.email };
    const ownerIdentityId = `${name}-identity-owner`, alternateIdentityId = `${name}-identity-alternate`;

    if (source.sourceId === secondary.sourceId) {
      await db.batch([
        db.prepare(`INSERT INTO pa_portal_source_authorities
          (source_id,producer_binding_id,snapshot_origin,snapshot_base_path,application_key,state,active_revision,version,connector_revision,connector_version)
          VALUES(?,?,'https://secondary.example.test','/api/portal','secondary_cross_app','pending',1,1,1,1)`)
          .bind(source.sourceId, `${name}-connector`),
        db.prepare(`INSERT INTO pa_portal_source_authority_revisions
          (source_id,revision,credential_ref,access_issuer,access_audience,access_subject,current_key_id,current_key_fingerprint,created_by)
          VALUES(?,1,'secondary-credential','https://secondary.example.test','operations','secondary-producer','secondary-key',?,'test')`)
          .bind(source.sourceId, "a".repeat(64)),
        db.prepare("UPDATE pa_portal_source_authorities SET state='active',version=2 WHERE source_id=?").bind(source.sourceId),
      ]);
    }

    await db.batch([
      db.prepare("INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id) VALUES(?,?,?)")
        .bind(workspaceId, source.sourceId, `${name}-source-workspace`),
      db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id)
        VALUES(?,'organization',?,'Cross-app native workspace','active',?)`).bind(workspaceId, rootId, source.sourceId),
      db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES(?,?,?,?, 'active')")
        .bind(ownerIdentityId, owner.issuer, owner.subject, owner.email),
      db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES(?,?,?,?, 'active')")
        .bind(alternateIdentityId, alternate.issuer, alternate.subject, alternate.email),
      ...[ownerIdentityId, alternateIdentityId].map((identityId, index) => db.prepare(`INSERT INTO portal_v2_workspace_memberships
        (id,workspace_id,identity_id,source_type,status,source_version) VALUES(?,?,?,'project_alpha','active','principal-v1')`)
        .bind(`${name}-membership-${index}`, workspaceId, identityId)),
      db.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status)
        VALUES(?,?,?,?,'Delivery recipient','principal-v1','active')`).bind(workspaceId, principalId, ownerIdentityId, owner.email),
      db.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete,activated_at)
        VALUES(?,?,?,1,'active',1,datetime('now'))`).bind(`${name}-generation`, workspaceId, `${name}-generation`),
      db.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,display_name,source_version,active)
        VALUES(?,?,'organization',?,'Cross-app organization','root-v1',1)`).bind(workspaceId, `${name}-generation`, rootId),
      db.prepare("INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version) VALUES(?,?,3)")
        .bind(`${name}-generation`, workspaceId),
      db.prepare("INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)")
        .bind(workspaceId, `${name}-generation`),
      db.prepare(`INSERT INTO portal_v2_folder_bindings
        (id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version,status)
        VALUES(?,?,'organization',?,'clients/cross-app/','project_alpha','root-v1','active')`).bind(bindingId, workspaceId, rootId),
      db.prepare(`INSERT INTO pa_portal_entitlement_intents
        (workspace_id,public_id,principal_public_id,capability,effect,scope_type,scope_public_id,source_version,status,valid_from)
        VALUES(?,?,?,'delivery.view','allow','organization',?,'principal-v1','active',datetime('now','-1 minute'))`)
        .bind(workspaceId, `${name}-intent`, principalId, rootId),
      ...[ownerIdentityId, alternateIdentityId].flatMap((identityId, index) => [
        db.prepare(`INSERT INTO portal_v2_entitlements
          (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
          VALUES(?,?,?,'workspace.view','allow','workspace',?,'project_alpha','active')`)
          .bind(`${name}-workspace-view-${index}`, workspaceId, identityId, workspaceId),
        db.prepare(`INSERT INTO portal_v2_entitlements
          (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
          VALUES(?,?,?,'delivery.view','allow','folder',?,'project_alpha','active')`)
          .bind(`${name}-delivery-view-${index}`, workspaceId, identityId, bindingId),
      ]),
    ]);
    return { source, workspaceId, rootId, bindingId, principalId, owner, alternate, ownerIdentityId, alternateIdentityId };
  }

  const appFor = (principal: VerifiedClientPrincipal) => new Hono().route("/api/client", createClientPortalRouter({
    resolvePrincipal: async () => principal,
    repository: d1ClientPortalRepository,
  }));
  const history = (principal: VerifiedClientPrincipal, workspaceId: string) => appFor(principal).request(`${origin}/api/client/notification-history`, {
    headers: { "X-LTDS-Workspace-Id": workspaceId },
  }, env);
  const mutate = (principal: VerifiedClientPrincipal, workspaceId: string, eventId: string, action: "read" | "dismiss") => appFor(principal)
    .request(`${origin}/api/client/v2/workspaces/${workspaceId}/native-delivery-notifications/${eventId}`, {
      method: "PATCH",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }, env);

  it("uses the Operations applier to create source-bound immutable events that Client lists and tracks per identity", async () => {
    const primaryFixture = await seed("primary", primary);
    const secondaryFixture = await seed("secondary", secondary);
    const accept = async (fixture: NativeFixture, deliveryId: string) => {
      const payload = {
        schemaVersion: 1, applicationKey: "project-alpha", deliveryId, occurredAt: "2026-09-06T12:00:00.000Z",
        scope: { type: "organization", publicId: fixture.rootId }, audience: { type: "principal", publicId: fixture.principalId },
        accessMode: "portal", expiresAt: null, label: null, notify: true,
      };
      const proof = fixture.source.sourceId === primary.sourceId ? primaryProof : {
        sourceId: fixture.source.sourceId, revision: 1, version: 2, connectorRevision: 1, connectorVersion: 1,
      };
      return applyProjectAlphaDeliveryIntent(env, payload, { deliveryId, fingerprint: fingerprint(payload) },
        fixture.source, env.PROJECT_ALPHA_PORTAL_APPLICATION_KEY, proof);
    };

    const primaryAccepted = await accept(primaryFixture, "primary-cross-app-delivery");
    expect(primaryAccepted.status).toBe("accepted");
    const primaryEvent = await db.prepare(`SELECT event.id,event.source_id,event.workspace_id,event.receipt_id,event.grant_id,event.folder_binding_id,
      event.principal_public_id,event.event_type FROM native_delivery_recipient_events event WHERE event.receipt_id=?`)
      .bind(primaryAccepted.receiptId).first<{ id: string; source_id: string; workspace_id: string; receipt_id: string; grant_id: string; folder_binding_id: string; principal_public_id: string; event_type: string }>();
    expect(primaryEvent).toEqual({
      id: expect.any(String), source_id: primary.sourceId, workspace_id: primaryFixture.workspaceId, receipt_id: primaryAccepted.receiptId,
      grant_id: expect.any(String), folder_binding_id: primaryFixture.bindingId, principal_public_id: primaryFixture.principalId, event_type: "grant_accepted",
    });
    expect(await db.prepare("SELECT count(*) count FROM project_alpha_delivery_portal_grants WHERE id=?").bind(primaryEvent!.grant_id).first<number>("count")).toBe(1);
    await expect(db.prepare("UPDATE native_delivery_recipient_events SET principal_public_id='redirected' WHERE id=?").bind(primaryEvent!.id).run())
      .rejects.toThrow(/immutable/);

    const primaryHistory = await history(primaryFixture.owner, primaryFixture.workspaceId);
    expect(primaryHistory.status).toBe(200);
    expect((await primaryHistory.json() as { coverage: { delivery: string }; items: Array<{ id: string; kind: string; readAt: string | null; mutationPath: string }> }))
      .toMatchObject({ coverage: { delivery: "included_project_alpha_grant_notices" }, items: [{
        id: primaryEvent!.id, kind: "delivery", readAt: null,
        mutationPath: `/api/client/v2/workspaces/${primaryFixture.workspaceId}/native-delivery-notifications/${primaryEvent!.id}`,
      }] });

    expect((await mutate(primaryFixture.owner, primaryFixture.workspaceId, primaryEvent!.id, "read")).status).toBe(200);
    await db.prepare(`INSERT INTO portal_v2_identity_eligibility_bindings
      (identity_id,workspace_id,principal_public_id,principal_source_version,verified_email) VALUES(?,?,?,?,?)`)
      .bind(primaryFixture.alternateIdentityId, primaryFixture.workspaceId, primaryFixture.principalId, "principal-v1", primaryFixture.alternate.email).run();
    expect((await history(primaryFixture.alternate, primaryFixture.workspaceId)).status).toBe(403);
    await db.prepare(`UPDATE pa_portal_principals SET identity_id=? WHERE workspace_id=? AND public_id=?`)
      .bind(primaryFixture.alternateIdentityId, primaryFixture.workspaceId, primaryFixture.principalId).run();
    const alternateBeforeDismiss = await history(primaryFixture.alternate, primaryFixture.workspaceId);
    expect(alternateBeforeDismiss.status).toBe(200);
    expect((await alternateBeforeDismiss.json() as { items: Array<{ id: string; readAt: string | null }> }).items)
      .toEqual([expect.objectContaining({ id: primaryEvent!.id, readAt: null })]);
    expect((await mutate(primaryFixture.alternate, primaryFixture.workspaceId, primaryEvent!.id, "dismiss")).status).toBe(200);
    expect((await db.prepare(`SELECT recipient_identity_id,read_at,dismissed_at FROM native_delivery_recipient_event_state
      WHERE event_id=? ORDER BY recipient_identity_id`).bind(primaryEvent!.id).all()).results).toEqual([
      { recipient_identity_id: primaryFixture.alternateIdentityId, read_at: null, dismissed_at: expect.any(String) },
      { recipient_identity_id: primaryFixture.ownerIdentityId, read_at: expect.any(String), dismissed_at: null },
    ]);
    expect((await (await history(primaryFixture.alternate, primaryFixture.workspaceId)).json() as { items: unknown[] }).items).toEqual([]);
    await db.prepare(`UPDATE pa_portal_principals SET identity_id=? WHERE workspace_id=? AND public_id=?`)
      .bind(primaryFixture.ownerIdentityId, primaryFixture.workspaceId, primaryFixture.principalId).run();
    expect((await (await history(primaryFixture.owner, primaryFixture.workspaceId)).json() as { items: Array<{ id: string; readAt: string | null }> }).items)
      .toEqual([expect.objectContaining({ id: primaryEvent!.id, readAt: expect.any(String) })]);

    const secondaryAccepted = await accept(secondaryFixture, "secondary-cross-app-delivery");
    expect(secondaryAccepted.status).toBe("accepted");
    const secondaryEvent = await db.prepare("SELECT id,source_id,workspace_id FROM native_delivery_recipient_events WHERE receipt_id=?")
      .bind(secondaryAccepted.receiptId).first<{ id: string; source_id: string; workspace_id: string }>();
    expect(secondaryEvent).toEqual({ id: expect.any(String), source_id: secondary.sourceId, workspace_id: secondaryFixture.workspaceId });
    const secondaryHistory = await history(secondaryFixture.owner, secondaryFixture.workspaceId);
    expect(secondaryHistory.status).toBe(200);
    expect((await secondaryHistory.json() as { items: Array<{ id: string }> }).items).toEqual([expect.objectContaining({ id: secondaryEvent!.id })]);
  }, 180_000);
});
