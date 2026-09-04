import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import contactFixture from "../../../packages/shared/fixtures/project-alpha-portal-contact-assignments-v4.json";
import relationFixture from "../../../packages/shared/fixtures/project-alpha-portal-relations-v3.json";
import serviceFixture from "../../../packages/shared/fixtures/project-alpha-service-assignments-v1.json";
import { handleProjectAlphaPortalProjectionRequest } from "../src/worker/project-alpha-portal";
import { handleProjectAlphaServiceAssignmentsRequest } from "../src/worker/project-alpha-service-assignments";
import type { Env } from "../src/worker/types";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const applicationKey = "field_operations_portal";
const keyId = "joined-metadata-v1";
const secret = "joined-metadata-authority-secret-at-least-thirty-two-bytes";
const portalPath = "/api/internal/project-alpha/portal-v2";
const servicePath = "/api/internal/project-alpha/service-assignments-v1";
const sourceId = "project-alpha:primary";

async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function sign(path: string, body: string, timestamp: string, deliveryId: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const payload = `${timestamp}\nPOST\n${path}\n${keyId}\n${deliveryId}\n${body}`;
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `sha256=${[...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function serviceSnapshotHash(items: unknown[]): Promise<string> {
  const pageHash = await sha256(JSON.stringify({ schemaVersion: 1, items }));
  return sha256(JSON.stringify({ schemaVersion: 1, pageCount: 1, itemCount: items.length,
    pages: [{ pageNumber: 1, itemCount: items.length, pageHash }] }));
}

describe("joined Project Alpha metadata remains non-authorizing", () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default {fetch(){return new Response('ok')}}",
      d1Databases: { DELIVERY_DB: "joined-portal-metadata-authority" } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"));
      if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
    }
    env = {
      DELIVERY_DB: db,
      PROJECT_ALPHA_PORTAL_SYNC_ENABLED: "true",
      PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED: "true",
      PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED: "true",
      PROJECT_ALPHA_PORTAL_APPLICATION_KEY: applicationKey,
      PROJECT_ALPHA_PORTAL_HMAC_KEY_ID: keyId,
      PROJECT_ALPHA_PORTAL_HMAC_SECRET: secret,
      PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN: "https://access.example.test",
      PROJECT_ALPHA_PORTAL_ACCESS_AUD: "joined-audience",
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true",
      CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED: "false",
      AUTHENTICATED_DELIVERY_GRANTS_ENABLED: "false",
      CLIENT_PORTAL_REQUEST_V2_ENABLED: "false",
      CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED: "false",
    } as Env;
  }, 60_000);

  afterAll(async () => runtime.dispose());

  async function deliver(path: string, payload: Record<string, unknown>) {
    const body = JSON.stringify(payload), timestamp = new Date().toISOString();
    const request = new Request(`https://client.test${path}`, { method: "POST", body, headers: {
      "Content-Type": "application/json",
      "X-Portal-Integration-Application-Key": applicationKey,
      "X-Portal-Integration-Timestamp": timestamp,
      "X-Portal-Integration-Body-SHA256": await sha256(body),
      "X-Portal-Integration-Key-Id": keyId,
      "X-Portal-Integration-Delivery-Id": String(payload.deliveryId),
      "X-Portal-Integration-Signature": await sign(path, body, timestamp, String(payload.deliveryId)),
    } });
    return path === portalPath
      ? handleProjectAlphaPortalProjectionRequest(request, env, async () => undefined)
      : handleProjectAlphaServiceAssignmentsRequest(request, env, async () => undefined);
  }

  async function authorityCounts() {
    const tables = ["portal_v2_workspace_memberships", "portal_v2_authenticated_delivery_grants",
      "client_service_requests", "delivery_notifications", "client_portal_notifications"];
    return Object.fromEntries(await Promise.all(tables.map(async table =>
      [table, await db.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)")])));
  }

  it("ingests and revokes combined metadata without creating membership, delivery, request, billing, or notification authority", async () => {
    const base = structuredClone(contactFixture.valid.snapshotPage) as Record<string, any>;
    const relationPage = relationFixture.valid.snapshotPage;
    base.deliveryId = "joined-v4-page";
    base.sourceGeneration = "joined-v4-generation";
    base.sourceSequence = 40;
    base.snapshotHash = "9".repeat(64);
    base.principals = structuredClone(relationPage.principals).map((principal: Record<string, unknown>) => ({
      ...principal, publicId: "pa-principal-manager-joined",
    }));
    base.entitlements = structuredClone(relationPage.entitlements).map((entitlement: Record<string, unknown>, index: number) => ({
      ...entitlement,
      publicId: `joined-entitlement-${index}`,
      principalPublicId: "pa-principal-manager-joined",
      scopePublicId: index === 0 ? base.workspace.publicId : "pa-project-north",
      scopeType: index === 0 ? "workspace" : "project",
    }));
    base.recordCount = base.entities.length + base.principals.length + base.entitlements.length
      + base.relations.length + base.projectLifecycles.length + base.contactAssignments.length;
    const activate = { schemaVersion: 4, applicationKey, deliveryId: "joined-v4-activate",
      occurredAt: base.occurredAt, sourceGeneration: base.sourceGeneration, sourceSequence: base.sourceSequence,
      workspaceId: base.workspaceId, kind: "snapshot.activate", snapshotHash: base.snapshotHash,
      pageCount: 1, recordCount: base.recordCount };

    expect((await deliver(portalPath, base)).status).toBe(200);
    expect((await deliver(portalPath, activate)).status).toBe(200);
    expect(await db.prepare("SELECT count(*) FROM pa_portal_principals WHERE workspace_id=? AND status='active'")
      .bind(base.workspaceId).first<number>("count(*)")).toBe(1);
    expect(await db.prepare("SELECT count(*) FROM portal_v2_contact_assignments WHERE workspace_id=? AND active=1")
      .bind(base.workspaceId).first<number>("count(*)")).toBe(1);
    expect(await authorityCounts()).toEqual({ portal_v2_workspace_memberships: 0,
      portal_v2_authenticated_delivery_grants: 0, client_service_requests: 0,
      delivery_notifications: 0, client_portal_notifications: 0 });

    await db.batch([
      db.prepare(`INSERT INTO pa_service_assignment_receiver_grants
        (source_id,capability,contract_version,state,created_by)
        VALUES(?,'portal.service-assignments.publish',1,'active','joined-test')`).bind(sourceId),
      db.prepare(`INSERT INTO pa_service_assignment_receiver_workspaces(source_id,workspace_id,state,created_by)
        VALUES(?,?,'active','joined-test')`).bind(sourceId, base.workspaceId),
    ]);
    const serviceItem = { ...structuredClone(serviceFixture.snapshotPage.items[0]),
      assignmentPublicId: "joined-service-assignment", subjectPublicId: "pa-project-north" };
    const snapshotHash = await serviceSnapshotHash([serviceItem]);
    const servicePage = { ...structuredClone(serviceFixture.snapshotPage), applicationKey,
      deliveryId: "joined-service-page", sourceGeneration: "joined-service-generation", sourceSequence: 1,
      snapshotHash, items: [serviceItem] };
    const serviceActivate = { ...structuredClone(serviceFixture.snapshotActivate), applicationKey,
      deliveryId: "joined-service-activate", sourceGeneration: servicePage.sourceGeneration,
      sourceSequence: 1, snapshotHash };
    expect((await deliver(servicePath, servicePage)).status).toBe(200);
    expect((await deliver(servicePath, serviceActivate)).status).toBe(200);
    expect(await db.prepare("SELECT count(*) FROM pa_service_assignments WHERE active=1")
      .first<number>("count(*)")).toBe(1);
    expect(await authorityCounts()).toEqual({ portal_v2_workspace_memberships: 0,
      portal_v2_authenticated_delivery_grants: 0, client_service_requests: 0,
      delivery_notifications: 0, client_portal_notifications: 0 });

    const serviceTombstone = { ...structuredClone(serviceFixture.tombstoneEvent), applicationKey,
      deliveryId: "joined-service-tombstone", sourceGeneration: servicePage.sourceGeneration,
      event: { ...structuredClone(serviceFixture.tombstoneEvent.event),
        assignmentPublicId: serviceItem.assignmentPublicId, sourceVersion: serviceItem.sourceVersion } };
    expect((await deliver(servicePath, serviceTombstone)).status).toBe(200);
    const contactTombstone = { ...structuredClone(contactFixture.valid.assignmentTombstone),
      deliveryId: "joined-contact-tombstone", sourceGeneration: base.sourceGeneration,
      sourceSequence: 41, workspaceId: base.workspaceId };
    expect((await deliver(portalPath, contactTombstone)).status).toBe(200);
    const rootTombstone = { ...structuredClone(relationFixture.valid.workspaceTombstoneEvent),
      schemaVersion: 4, applicationKey, deliveryId: "joined-root-tombstone",
      sourceGeneration: base.sourceGeneration, sourceSequence: 42, workspaceId: base.workspaceId,
      event: { ...structuredClone(relationFixture.valid.workspaceTombstoneEvent.event),
        publicId: base.workspaceId } };
    expect((await deliver(portalPath, rootTombstone)).status).toBe(200);

    expect(await db.prepare("SELECT active FROM pa_service_assignment_entity_state WHERE assignment_public_id=?")
      .bind(serviceItem.assignmentPublicId).first<number>("active")).toBe(0);
    expect(await db.prepare("SELECT status FROM portal_v2_workspaces WHERE id=?")
      .bind(base.workspaceId).first<string>("status")).toBe("suspended");
    expect(await authorityCounts()).toEqual({ portal_v2_workspace_memberships: 0,
      portal_v2_authenticated_delivery_grants: 0, client_service_requests: 0,
      delivery_notifications: 0, client_portal_notifications: 0 });
  }, 60_000);
});
