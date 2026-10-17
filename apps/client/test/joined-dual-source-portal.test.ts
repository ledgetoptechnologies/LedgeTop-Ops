import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import fixture from "../../../packages/shared/fixtures/project-alpha-portal-contact-assignments-v4.json";
import { ingestOpsSyncPortalProjection } from "../src/worker/ops-sync-portal-entrypoint";
import { authorizeNativePortalReadTarget, listPortalWorkspaces, resolveNativePortalWorkspaceReadContext } from "../src/worker/client-portal/workspace-v2";
import type { Env } from "../src/worker/types";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const primary = "project-alpha:primary", secondary = "project-alpha:joined-secondary";
const applicationKey = fixture.valid.snapshotPage.applicationKey;
const upstreamWorkspace = fixture.valid.snapshotPage.workspaceId;
const issuer = "https://joined.example.test";
const person = (subject: string) => ({ issuer, subject, email: "manager@example.test" });
const manager = { publicId: "pa-principal-manager", emailHint: "manager@example.test", displayName: "Manager", sourceVersion: "principal-v1", active: true };

describe("joined primary and secondary portal acceptance through Ops Sync", () => {
  let runtime: Miniflare, db: D1Database, env: Env;
  let localSecondary: string;
  let originalShare: unknown;

  async function ingest(sourceId: string, payload: Record<string, unknown>, key = applicationKey) {
    return ingestOpsSyncPortalProjection(env, { protocolVersion: 1, sourceId, applicationKey: key,
      deliveryId: String(payload.deliveryId), projectionKind: "portal", body: JSON.stringify(payload) });
  }
  function event(sequence: number, resource: Record<string, unknown>) {
    return { schemaVersion: 4, applicationKey, deliveryId: `joined-event-${sequence}`, occurredAt: "2026-10-13T18:00:00.000Z",
      sourceGeneration: fixture.valid.snapshotPage.sourceGeneration, sourceSequence: sequence, workspaceId: upstreamWorkspace, kind: "event", event: resource };
  }
  async function refresh(sourceId: string, sequence: number) {
    expect(await ingest(sourceId, event(sequence, { resource: "principal", action: "upsert", principal: { ...manager, sourceVersion: `principal-v${sequence}` } })))
      .toMatchObject({ ok: true, status: "completed" });
  }
  async function context(subject: string, workspaceId: string) {
    return resolveNativePortalWorkspaceReadContext(env, person(subject), workspaceId);
  }
  async function share() { return db.prepare("SELECT * FROM shares WHERE id='existing-public-share'").first(); }

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: { DELIVERY_DB: "joined-dual-source" } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
    env = { DELIVERY_DB: db, PROJECT_ALPHA_PORTAL_SYNC_ENABLED: "true", PROJECT_ALPHA_PORTAL_APPLICATION_KEY: applicationKey,
      PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED: "false",
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true", CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true",
      CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED: "false" } as Env;
    await db.batch([
      db.prepare(`INSERT INTO pa_portal_source_authorities(source_id,producer_binding_id,snapshot_origin,snapshot_base_path,application_key,state,
        active_revision,version,connector_revision,connector_version) VALUES(?,'joined-binding','https://secondary.example.test','/portal',?,'active',1,1,1,1)`)
        .bind(secondary, applicationKey),
      db.prepare(`INSERT INTO pa_portal_source_authority_revisions(source_id,revision,credential_ref,access_issuer,access_audience,access_subject,
        current_key_id,current_key_fingerprint,created_by) VALUES(?,1,'test-only',?,'joined-audience','producer','joined-key',?,'test')`)
        .bind(secondary, issuer, "a".repeat(64)),
      db.prepare(`INSERT INTO projects(id,client_name,project_name,r2_prefix) VALUES('existing-public-project','Existing','Existing Project','existing/')`),
      db.prepare(`INSERT INTO shares(id,project_id,token_hash,public_id,created_by_type,created_by_id)
        VALUES('existing-public-share','existing-public-project','existing-token-hash','existing-public-url','integration','test')`),
      ...["primary-person", "secondary-person"].map(subject => db.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status)
        VALUES(?,?,?,'manager@example.test','active')`).bind(subject, issuer, subject)),
    ]);
    originalShare = await share();
  }, 90_000);
  afterAll(async () => runtime.dispose());

  it("does not enroll primary private authority for malformed payloads or mismatched delivery IDs", async () => {
    expect(await ingest(primary, { ...fixture.valid.snapshotPage, pageNumber: 0 })).toMatchObject({ ok: false, code: "rejected" });
    expect(await ingestOpsSyncPortalProjection(env, { protocolVersion: 1, sourceId: primary, applicationKey,
      deliveryId: "mismatched-delivery", projectionKind: "portal", body: JSON.stringify(fixture.valid.snapshotPage) }))
      .toMatchObject({ ok: false, code: "delivery-mismatch" });
    expect(await db.prepare("SELECT count(*) n FROM pa_portal_primary_private_authority").first("n")).toBe(0);
  });

  it("isolates identical producer IDs without inferring access from email or billing metadata", async () => {
    const page = { ...structuredClone(fixture.valid.snapshotPage), principals: [manager], entitlements: [
      { publicId: "joined-workspace-grant", principalPublicId: manager.publicId, capability: "workspace.view", effect: "allow",
        scopeType: "workspace", scopePublicId: upstreamWorkspace, sourceVersion: "grant-v1", active: true, validFrom: "2026-08-01T00:00:00.000Z", expiresAt: null },
      { publicId: "joined-project-grant", principalPublicId: manager.publicId, capability: "delivery.view", effect: "allow",
        scopeType: "project", scopePublicId: "pa-project-north", sourceVersion: "grant-v1", active: true, validFrom: "2026-08-01T00:00:00.000Z", expiresAt: null },
    ], recordCount: fixture.valid.snapshotPage.recordCount + 3 };
    const activate = { ...fixture.valid.snapshotActivate, recordCount: page.recordCount };
    for (const source of [primary, secondary]) {
      expect(await ingest(source, page)).toMatchObject({ ok: true, status: "completed" });
      expect(await ingest(source, activate)).toMatchObject({ ok: true, status: "completed" });
      expect(await ingest(source, page)).toMatchObject({ ok: true, status: "duplicate" });
    }
    const mappings = (await db.prepare("SELECT workspace_id,projection_source_id FROM pa_portal_workspace_sources WHERE source_workspace_id=? ORDER BY projection_source_id")
      .bind(upstreamWorkspace).all<{ workspace_id: string; projection_source_id: string }>()).results;
    expect(mappings).toHaveLength(2);
    expect(mappings.find(row => row.projection_source_id === primary)?.workspace_id).toBe(upstreamWorkspace);
    localSecondary = mappings.find(row => row.projection_source_id === secondary)!.workspace_id;
    expect(localSecondary).not.toBe(upstreamWorkspace);
    // Matching email hints and billing contact metadata alone confer no access.
    expect(await context("primary-person", upstreamWorkspace)).toBeNull();
    expect(await context("secondary-person", localSecondary)).toBeNull();
    expect(await db.prepare("SELECT count(*) n FROM portal_v2_workspace_memberships").first("n")).toBe(0);
  }, 30_000);

  it("isolates explicitly bound native memberships and read grants without copied PA HMAC credentials", async () => {
    for (const [source, workspaceId, identity] of [[primary, upstreamWorkspace, "primary-person"], [secondary, localSecondary, "secondary-person"]]) {
      await db.prepare("UPDATE pa_portal_principals SET identity_id=? WHERE workspace_id=? AND public_id=?").bind(identity, workspaceId, manager.publicId).run();
      // An explicit existing principal link remains authoritative without an auto-eligibility witness.
      expect(await db.prepare("SELECT count(*) n FROM portal_v2_identity_eligibility_bindings WHERE workspace_id=?")
        .bind(workspaceId).first("n")).toBe(0);
      await refresh(source!, 21);
      const own = await context(identity!, workspaceId!);
      expect(own).toMatchObject({ workspaceId, sourceId: source, identityId: identity });
      expect(await authorizeNativePortalReadTarget(env, own!, "delivery.view", { scopeType: "project", publicId: "pa-project-north" })).toBe(true);
      expect((await listPortalWorkspaces(env, person(identity!))).map(row => row.id)).toEqual([workspaceId]);
    }
    expect(await context("primary-person", localSecondary)).toBeNull();
    expect(await context("secondary-person", upstreamWorkspace)).toBeNull();
    expect(await db.prepare("SELECT count(*) n FROM pa_portal_source_signing_keys WHERE source_id=?").bind(primary).first("n")).toBe(0);
    expect(await resolveNativePortalWorkspaceReadContext({ ...env, PROJECT_ALPHA_PORTAL_APPLICATION_KEY: "different-application" }, person("primary-person"), upstreamWorkspace)).toBeNull();
    expect(await resolveNativePortalWorkspaceReadContext({ ...env, PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED: "true" }, person("primary-person"), upstreamWorkspace)).toBeNull();
    const memberships = (await db.prepare("SELECT workspace_id,identity_id FROM portal_v2_workspace_memberships ORDER BY identity_id").all()).results;
    expect(memberships).toEqual([{ workspace_id: upstreamWorkspace, identity_id: "primary-person" }, { workspace_id: localSecondary, identity_id: "secondary-person" }]);
    expect(await db.prepare("SELECT count(*) n FROM client_account_members").first("n")).toBe(0);
    expect(await share()).toEqual(originalShare);
  }, 30_000);

  it("fails closed for a mismatched or disabled sibling while preserving primary access", async () => {
    const payload = event(22, { resource: "principal", action: "upsert", principal: { ...manager, sourceVersion: "principal-v22" } });
    expect(await ingest(secondary, payload, "wrong-application")).toMatchObject({ ok: false, code: "source-mismatch" });
    await db.prepare("UPDATE pa_portal_source_authorities SET state='suspended',version=version+1 WHERE source_id=?").bind(secondary).run();
    expect(await ingest(secondary, payload)).toMatchObject({ ok: false, code: "source-unavailable" });
    expect(await context("secondary-person", localSecondary)).toBeNull();
    expect(await context("primary-person", upstreamWorkspace)).not.toBeNull();
    expect(await db.prepare("SELECT source_sequence FROM pa_portal_projection_checkpoints WHERE workspace_id=?").bind(localSecondary).first("source_sequence")).toBe(21);
    await db.prepare("UPDATE pa_portal_source_authorities SET state='active',version=version+1 WHERE source_id=?").bind(secondary).run();
    expect(await context("secondary-person", localSecondary)).not.toBeNull();
  });

  it("honors primary private authority suspension without disabling the secondary or silently reenrolling", async () => {
    await db.prepare("UPDATE pa_portal_primary_private_authority SET state='suspended',version=version+1 WHERE source_id=?").bind(primary).run();
    expect(await context("primary-person", upstreamWorkspace)).toBeNull();
    expect(await context("secondary-person", localSecondary)).not.toBeNull();
    expect(await ingest(primary, event(22, { resource: "principal", action: "upsert", principal: { ...manager, sourceVersion: "principal-v22" } })))
      .toMatchObject({ ok: false });
    expect(await db.prepare("SELECT state FROM pa_portal_primary_private_authority WHERE source_id=?").bind(primary).first("state")).toBe("suspended");
    expect(await db.prepare("SELECT source_sequence FROM pa_portal_projection_checkpoints WHERE workspace_id=?").bind(upstreamWorkspace).first("source_sequence")).toBe(21);
    await db.prepare("UPDATE pa_portal_primary_private_authority SET state='active',version=version+1 WHERE source_id=?").bind(primary).run();
    expect(await context("primary-person", upstreamWorkspace)).not.toBeNull();
  });

  it("revokes secondary billing metadata and principal without changing the colliding primary records or public share", async () => {
    const assignment = fixture.valid.snapshotPage.contactAssignments[0]!;
    expect(await ingest(secondary, event(22, { resource: "contact_assignment", action: "tombstone", publicId: assignment.publicId, sourceVersion: "assignment-revoked" })))
      .toMatchObject({ ok: true, status: "completed" });
    const currentAssignment = (workspaceId: string) => db.prepare(`SELECT assignment.active FROM portal_v2_contact_assignments assignment
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=assignment.workspace_id AND checkpoint.active_generation_id=assignment.generation_id
      WHERE assignment.workspace_id=? AND assignment.public_id=?`).bind(workspaceId, assignment.publicId).first("active");
    expect(await currentAssignment(localSecondary)).toBe(0);
    expect(await currentAssignment(upstreamWorkspace)).toBe(1);
    expect(await ingest(secondary, event(23, { resource: "principal", action: "tombstone", publicId: manager.publicId, sourceVersion: "principal-revoked" })))
      .toMatchObject({ ok: true, status: "completed" });
    expect(await context("secondary-person", localSecondary)).toBeNull();
    const primaryContext = await context("primary-person", upstreamWorkspace);
    expect(primaryContext).not.toBeNull();
    expect(await authorizeNativePortalReadTarget(env, primaryContext!, "delivery.view", { scopeType: "project", publicId: "pa-project-north" })).toBe(true);
    expect((await listPortalWorkspaces(env, person("secondary-person")))).toEqual([]);
    expect(await db.prepare("SELECT count(*) n FROM portal_v2_entitlements WHERE workspace_id=? AND status='active'").bind(localSecondary).first("n")).toBe(0);
    expect(await db.prepare("SELECT source_sequence FROM pa_portal_projection_checkpoints WHERE workspace_id=?").bind(upstreamWorkspace).first("source_sequence")).toBe(21);
    expect(await share()).toEqual(originalShare);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("cannot revive retired primary private authority by replaying valid projection traffic", async () => {
    await db.prepare("UPDATE pa_portal_primary_private_authority SET state='retired',version=version+1 WHERE source_id=?").bind(primary).run();
    expect(await ingest(primary, event(22, { resource: "principal", action: "upsert", principal: { ...manager, sourceVersion: "principal-v22" } })))
      .toMatchObject({ ok: false });
    expect(await context("primary-person", upstreamWorkspace)).toBeNull();
    expect(await db.prepare("SELECT state FROM pa_portal_primary_private_authority WHERE source_id=?").bind(primary).first("state")).toBe("retired");
    expect(await share()).toEqual(originalShare);
  });
});
