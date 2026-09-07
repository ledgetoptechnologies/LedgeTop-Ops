import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleProjectAlphaPortalProjectionRequest } from "../src/worker/project-alpha-portal";
import { createClientPortalRouter } from "../src/worker/client-portal/routes";
import { d1ClientPortalRepository } from "../src/worker/client-portal/repository";
import { PORTAL_WORKSPACE_HEADER, resolveEffectivePortalWorkspaceContext } from "../src/worker/client-portal/workspace-v2";
import type { VerifiedClientPrincipal } from "../src/worker/client-portal/types";
import type { Env } from "../src/worker/types";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const applicationKey = "field_operations_portal";
const keyId = "primary-native-test-v1";
const secret = "primary-native-test-secret-at-least-thirty-two-bytes";
const ingressPath = "/api/internal/project-alpha/portal-v2";
const origin = "https://client.test";
const flags = ["CLIENT_PORTAL_HIERARCHY_V2_ENABLED", "CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED",
  "CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED", "CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED"] as const;

async function hexDigest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

describe("primary signed-native first-login eligibility", () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;
  const sendEmail = vi.fn();

  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default {fetch(){return new Response('ok')}}",
      d1Databases: { DELIVERY_DB: "primary-native-portal-eligibility" } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"));
      if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
    }
    env = {
      DELIVERY_DB: db, CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_ORIGIN: origin,
      PROJECT_ALPHA_PORTAL_SYNC_ENABLED: "true", PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED: "true", PROJECT_ALPHA_PORTAL_APPLICATION_KEY: applicationKey,
      PROJECT_ALPHA_PORTAL_HMAC_KEY_ID: keyId, PROJECT_ALPHA_PORTAL_HMAC_SECRET: secret,
      PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      PROJECT_ALPHA_PORTAL_ACCESS_AUD: "primary-native-sync-audience",
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true", CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: "true",
      CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED: "true", CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true",
      CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED: "true",
      CLIENT_PORTAL_INVITATION_EMAIL_ENABLED: "true", CLIENT_PORTAL_INVITATION_EMAIL: { send: sendEmail },
    } as unknown as Env;
  }, 60_000);

  afterAll(async () => runtime?.dispose());

  async function deliver(payload: Record<string, unknown>, environment = env) {
    const body = JSON.stringify(payload), timestamp = new Date().toISOString();
    const signingKeyId = environment.PROJECT_ALPHA_PORTAL_HMAC_KEY_ID!;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(environment.PROJECT_ALPHA_PORTAL_HMAC_SECRET!),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(
      `${timestamp}\nPOST\n${ingressPath}\n${signingKeyId}\n${payload.deliveryId}\n${body}`));
    const signature = [...new Uint8Array(signed)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return handleProjectAlphaPortalProjectionRequest(new Request(`${origin}${ingressPath}`, {
      method: "POST", headers: { "Content-Type": "application/json",
        "X-Portal-Integration-Application-Key": applicationKey, "X-Portal-Integration-Timestamp": timestamp,
        "X-Portal-Integration-Body-SHA256": await hexDigest(body), "X-Portal-Integration-Key-Id": signingKeyId,
        "X-Portal-Integration-Delivery-Id": String(payload.deliveryId), "X-Portal-Integration-Signature": `sha256=${signature}` }, body,
    }), environment, async () => undefined);
  }

  async function project(name: string, options: { duplicateEmail?: boolean; noPrincipals?: boolean } = {}) {
    const workspaceId = `pa-workspace-${name}`, rootId = `pa-org-${name}`;
    const actor: VerifiedClientPrincipal = { issuer: "https://team.cloudflareaccess.com",
      subject: `subject-${name}`, email: `${name}@example.test` };
    const principalId = `pa-principal-${name}`;
    const principals = options.noPrincipals ? [] : [{ publicId: principalId, emailHint: actor.email,
      displayName: "Verified person", sourceVersion: "principal-v1", active: true }];
    if (options.duplicateEmail) principals.push({ ...principals[0]!, publicId: `${principalId}-duplicate` });
    const entitlements = options.noPrincipals ? [] : ["workspace.view", "directory.read"].map((capability, index) => ({
      publicId: `pa-entitlement-${name}-${index}`, principalPublicId: principalId, capability, effect: "allow",
      scopeType: "workspace", scopePublicId: workspaceId, sourceVersion: "grant-v1", active: true,
      validFrom: "2026-01-01T00:00:00.000Z", expiresAt: null,
    }));
    const common = { schemaVersion: 2, applicationKey, occurredAt: "2026-09-03T00:00:00.000Z",
      sourceGeneration: `generation-${name}`, sourceSequence: 10, workspaceId, snapshotHash: "b".repeat(64),
      pageCount: 1, recordCount: 1 + principals.length + entitlements.length };
    const page = { ...common, kind: "snapshot.page", deliveryId: `${name}-page`, pageNumber: 1,
      workspace: { publicId: workspaceId, rootType: "organization", rootPublicId: rootId,
        displayName: `Organization ${name}`, sourceVersion: "root-v1", active: true },
      entities: [{ type: "organization", publicId: rootId, parentPublicId: null, displayName: `Organization ${name}`,
        sourceVersion: "root-v1", active: true, primaryContact: false }], principals, entitlements };
    const pageResponse = await deliver(page);
    if (options.duplicateEmail) {
      // The production staging uniqueness constraint rejects ambiguity before
      // activation, rather than allowing a duplicate-email workspace to exist.
      expect(pageResponse.status).toBe(409);
      expect(await db.prepare("SELECT count(*) n FROM portal_v2_workspaces WHERE id=?")
        .bind(workspaceId).first("n")).toBe(0);
      return { workspaceId, rootId, actor, principalId, common, page };
    }
    expect(await pageResponse.json()).not.toHaveProperty("error");
    expect(pageResponse.status).toBe(200);
    const activation = await deliver({ ...common, kind: "snapshot.activate", deliveryId: `${name}-activate` });
    expect(await activation.json()).not.toHaveProperty("error");
    expect(activation.status).toBe(200);
    expect(await db.prepare("SELECT legacy_account_id FROM portal_v2_workspaces WHERE id=?").bind(workspaceId)
      .first("legacy_account_id")).toBeNull();
    return { workspaceId, rootId, actor, principalId, common, page };
  }

  function router(actor: VerifiedClientPrincipal) {
    return createClientPortalRouter({ resolvePrincipal: async () => actor, repository: d1ClientPortalRepository });
  }
  async function request(actor: VerifiedClientPrincipal, path: string, environment = env) {
    return router(actor).request(`${origin}${path}`, {}, environment);
  }
  async function assertNoBinding(workspaceId: string) {
    expect(await db.prepare("SELECT count(*) n FROM portal_v2_workspace_memberships WHERE workspace_id=?")
      .bind(workspaceId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM portal_v2_identity_eligibility_bindings WHERE workspace_id=?")
      .bind(workspaceId).first("n")).toBe(0);
  }
  async function assertNoLegacyOrMail() {
    for (const table of ["client_accounts", "client_identity_links", "client_account_members",
      "portal_v2_legacy_member_bridges", "portal_v2_identity_eligibility_legacy_bridges", "client_account_invitations",
      "portal_v2_invitations", "portal_v2_invitation_email_outbox", "client_portal_notification_outbox"])
      expect(await db.prepare(`SELECT count(*) n FROM ${table}`).first("n"), table).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  }

  it("bootstraps the exact signed principal once and serves native list/context/hierarchy without legacy adapters", async () => {
    const { actor, workspaceId, rootId, principalId } = await project("success");
    await assertNoBinding(workspaceId);
    for (let replay = 0; replay < 2; replay++) {
      const session = await request(actor, "/session");
      expect(session.status).toBe(200);
      expect(await session.json()).toMatchObject({ account: { id: "" }, capabilities: { workspaceHierarchyV2: true } });
      const list = await request(actor, "/v2/workspaces");
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual({ workspaces: [expect.objectContaining({ id: workspaceId,
        sourceId: "project-alpha:primary", resourceMode: "native", rootPublicId: rootId })] });
      const context = await request(actor, `/v2/workspaces/${workspaceId}/context`);
      expect(context.status).toBe(200);
      expect(await context.json()).toMatchObject({ workspace: { id: workspaceId, resourceMode: "native" },
        capabilities: { directoryRead: true } });
      const hierarchy = await request(actor, `/v2/workspaces/${workspaceId}/hierarchy`);
      expect(hierarchy.status).toBe(200);
      expect(await hierarchy.json()).toMatchObject({ entries: [expect.objectContaining({ publicId: rootId })] });
    }
    const identities = await db.prepare("SELECT id,issuer,subject,verified_email FROM portal_v2_identities WHERE issuer=? AND subject=?")
      .bind(actor.issuer, actor.subject).all();
    expect(identities.results).toHaveLength(1);
    expect(identities.results[0]).toMatchObject({ issuer: actor.issuer, subject: actor.subject, verified_email: actor.email });
    expect(await db.prepare("SELECT identity_id FROM pa_portal_principals WHERE workspace_id=? AND public_id=?")
      .bind(workspaceId, principalId).first("identity_id")).toBe(identities.results[0]!.id);
    expect(await db.prepare("SELECT count(*) n FROM portal_v2_workspace_memberships WHERE workspace_id=?")
      .bind(workspaceId).first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM portal_v2_identity_eligibility_bindings WHERE workspace_id=?")
      .bind(workspaceId).first("n")).toBe(1);
    expect(await resolveEffectivePortalWorkspaceContext(env, actor, workspaceId)).toBeNull();
    const legacyProjects = vi.spyOn(d1ClientPortalRepository, "listProjects");
    try {
      const generic = await router(actor).request(`${origin}/projects`, { headers: { [PORTAL_WORKSPACE_HEADER]: workspaceId } }, env);
      expect(generic.status).toBe(403);
      expect(legacyProjects).not.toHaveBeenCalled();
    } finally { legacyProjects.mockRestore(); }
    await assertNoLegacyOrMail();
  }, 60_000);

  it.each(flags)("does not bind while %s is disabled", async flag => {
    const { actor, workspaceId } = await project(`gate-${flags.indexOf(flag)}`);
    const response = await request(actor, "/v2/workspaces", { ...env, [flag]: "false" });
    expect([403, 404]).toContain(response.status);
    await assertNoBinding(workspaceId);
  });

  it("leaves no-email roots and ambiguous signed principal emails unclaimed", async () => {
    const noEmail = await project("no-email", { noPrincipals: true });
    expect((await request({ ...noEmail.actor, email: "" }, "/session")).status).toBe(403);
    await assertNoBinding(noEmail.workspaceId);
    const ambiguous = await project("ambiguous", { duplicateEmail: true });
    expect((await request(ambiguous.actor, "/session")).status).toBe(403);
    await assertNoBinding(ambiguous.workspaceId);
    await assertNoLegacyOrMail();
  });

  it.each(["missing", "unreserved"])("fails closed with a %s primary current signing secret", async state => {
    const { actor, workspaceId } = await project(`authority-${state}`);
    const changed = { ...env, PROJECT_ALPHA_PORTAL_HMAC_SECRET: state === "missing"
      ? undefined : "unreserved-primary-secret-at-least-thirty-two-bytes" } as Env;
    expect((await request(actor, "/session", changed)).status).toBe(403);
    await assertNoBinding(workspaceId);
    // The signed ingress reserved the actual configured key; restoring that
    // unchanged configuration is sufficient and needs no authority-row seed.
    expect((await request(actor, "/session")).status).toBe(200);
    expect((await request(actor, `/v2/workspaces/${workspaceId}/context`, changed)).status).toBe(404);
  }, 15_000);

  it("removes native visibility immediately after a signed root tombstone", async () => {
    const { actor, workspaceId, common } = await project("revoked-root");
    expect((await request(actor, "/session")).status).toBe(200);
    const { snapshotHash: _hash, pageCount: _pages, recordCount: _records, ...eventEnvelope } = common;
    const revoked = await deliver({ ...eventEnvelope, sourceSequence: 11, kind: "event", deliveryId: "revoked-root-event",
      event: { resource: "workspace", action: "tombstone", publicId: workspaceId, sourceVersion: "root-v2" } });
    expect(revoked.status).toBe(200);
    const list = await request(actor, "/v2/workspaces");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ workspaces: [] });
    expect((await request(actor, `/v2/workspaces/${workspaceId}/context`)).status).toBe(404);
    expect((await request(actor, `/v2/workspaces/${workspaceId}/hierarchy`)).status).toBe(404);
    await assertNoLegacyOrMail();
  }, 15_000);

  it("invalidates captured native context when current or previous signing authority changes", async () => {
    const { actor, workspaceId, page } = await project("key-context");
    expect((await request(actor, "/session")).status).toBe(200);
    const contextPath = `/v2/workspaces/${workspaceId}/context`;
    const original = await (await request(actor, contextPath)).json() as { contextVersion: string };
    for (const slot of ["current", "previous"] as const) {
      const rotated = { ...env, ...(slot === "current" ? {
        PROJECT_ALPHA_PORTAL_HMAC_KEY_ID: "primary-native-rotated-v2",
        PROJECT_ALPHA_PORTAL_HMAC_SECRET: "primary-native-rotated-current-secret-thirty-two-bytes",
      } : {
        PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_KEY_ID: "primary-native-previous-v0",
        PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_SECRET: "primary-native-rotated-previous-secret-thirty-two-bytes",
      }) } as Env;
      expect((await request(actor, contextPath, rotated)).status).toBe(404);
      // Exact delivery replay changes no generation or source sequence. Only
      // authenticated ingress may reserve the newly configured signing key.
      const replay = await deliver(page, rotated);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ status: "duplicate" });
      const current = await request(actor, contextPath, rotated);
      expect(current.status).toBe(200);
      expect((await current.json() as { contextVersion: string }).contextVersion).not.toBe(original.contextVersion);
      expect((await request(actor, `${contextPath}?expectedContext=${encodeURIComponent(original.contextVersion)}`, rotated)).status).toBe(409);
      expect((await request(actor, `/v2/workspaces/${workspaceId}/hierarchy?expectedContext=${encodeURIComponent(original.contextVersion)}`, rotated)).status).toBe(409);
    }
  }, 60_000);

  it("does not re-enroll a signed principal after its tombstone", async () => {
    const { actor, workspaceId, principalId, common } = await project("revoked-principal");
    expect((await request(actor, "/session")).status).toBe(200);
    const { snapshotHash: _hash, pageCount: _pages, recordCount: _records, ...eventEnvelope } = common;
    expect((await deliver({ ...eventEnvelope, sourceSequence: 11, kind: "event", deliveryId: "revoked-principal-event",
      event: { resource: "principal", action: "tombstone", publicId: principalId, sourceVersion: "principal-v2" } })).status).toBe(200);
    expect(await (await request(actor, "/v2/workspaces")).json()).toEqual({ workspaces: [] });
    expect((await request(actor, `/v2/workspaces/${workspaceId}/context`)).status).toBe(404);
    expect(await db.prepare("SELECT count(*) n FROM portal_v2_workspace_memberships WHERE workspace_id=? AND status='active' AND revoked_at IS NULL")
      .bind(workspaceId).first("n")).toBe(0);
    await assertNoLegacyOrMail();
  }, 60_000);
});
