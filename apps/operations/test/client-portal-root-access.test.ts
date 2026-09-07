import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import migration from "../../client/migrations/0197_portal_root_access_policy.sql?raw";

const mocks = vi.hoisted(() => ({ administrator: vi.fn(), denyReady: vi.fn() }));
vi.mock("../src/worker/acl", () => ({ isAdministrator: mocks.administrator }));
vi.mock("../src/worker/client-portal-deny-policies", () => ({ portalDenyPolicyManagementEnabled: mocks.denyReady }));

import { mutatePortalRootAccess, readPortalRootAccess } from "../src/worker/client-portal-root-access";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { Env, StaffPrincipal } from "../src/worker/types";

const active: Miniflare[] = [];
const actor = { id: "staff-admin" } as StaffPrincipal;
const context = { root: { source_id: "project-alpha:primary", root_namespace: "business", kind: "organization",
  pa_public_id: "org-one" }, contextVersion: "context-one",
  canonicalRoot: { sourceId: "project-alpha:primary", rootNamespace: "business", kind: "organization", publicId: "business-one" },
  access: { directory: true, requests: true, delivery: true, viewer: true } } as unknown as ClientHubCollectionContext;
const live = async () => {};
const secondaryContext = { ...context, root: { ...context.root, source_id: "project-alpha:ledge-top-technologies",
  pa_public_id: "org-ltt" }, canonicalRoot: { sourceId: "project-alpha:ledge-top-technologies",
  rootNamespace: "business", kind: "organization", publicId: "business-ltt" } } as unknown as ClientHubCollectionContext;

async function fixture() {
  const instance = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { DELIVERY_DB: "root-access" } });
  active.push(instance);
  const db = await instance.getD1Database("DELIVERY_DB") as unknown as D1Database;
  await db.exec(migration.replace(/^\s*--.*$/gm, "").replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "")
    .replace(/\s*\n\s*/g, " "));
  return { db, env: { DELIVERY_DB: db, CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED: "true",
    CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true", CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED: "true" } as Env };
}

beforeEach(() => { mocks.administrator.mockResolvedValue(true); mocks.denyReady.mockReturnValue(true); });
afterEach(async () => Promise.all(active.splice(0).map(instance => instance.dispose())));

describe("Client Hub root portal access", () => {
  it("revokes and restores one exact source root with idempotent, versioned audit", async () => {
    const { db, env } = await fixture();
    const revoked = await mutatePortalRootAccess(env, actor, context, { action: "revoke",
      expectedContextVersion: "context-one", expectedVersion: 0, reasonCode: "security_hold" }, "root-revoke-key-0001", live);
    expect(revoked).toEqual({ outcome: "root_access_revoked", version: 1, replayed: false });
    expect(await readPortalRootAccess(env, actor, context)).toMatchObject({ state: "revoked", version: 1,
      canRevoke: false, canRestore: true });
    expect(await mutatePortalRootAccess(env, actor, context, { action: "revoke",
      expectedContextVersion: "context-one", expectedVersion: 0, reasonCode: "security_hold" }, "root-revoke-key-0001", live))
      .toEqual({ outcome: "root_access_revoked", version: 1, replayed: true });
    await expect(mutatePortalRootAccess(env, actor, context, { action: "restore",
      expectedContextVersion: "context-one", expectedVersion: 0, reasonCode: "operator_restore" }, "root-restore-key-0001", live))
      .rejects.toMatchObject({ status: 409 });
    expect(await mutatePortalRootAccess(env, actor, context, { action: "restore",
      expectedContextVersion: "context-one", expectedVersion: 1, reasonCode: "operator_restore" }, "root-restore-key-0002", live))
      .toEqual({ outcome: "root_access_restored", version: 2, replayed: false });
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_root_access_policy_audit").first("count")).toBe(2);
  });

  it("does not expose the control outside an exact business root or to a non-administrator", async () => {
    const { env } = await fixture();
    expect(await readPortalRootAccess(env, actor, { ...context,
      root: { ...context.root, root_namespace: "portal" } } as ClientHubCollectionContext)).toMatchObject({ available: false });
    mocks.administrator.mockResolvedValue(false);
    await expect(mutatePortalRootAccess(env, actor, context, { action: "revoke",
      expectedContextVersion: "context-one", expectedVersion: 0, reasonCode: "security_hold" }, "root-revoke-key-0002", live))
      .rejects.toMatchObject({ status: 403 });
  });

  it("keeps a secondary Project Alpha root independent from the primary policy", async () => {
    const { db, env } = await fixture();
    expect(await mutatePortalRootAccess(env, actor, secondaryContext, { action: "revoke",
      expectedContextVersion: "context-one", expectedVersion: 0, reasonCode: "security_hold" }, "root-ltt-revoke-0001", live))
      .toEqual({ outcome: "root_access_revoked", version: 1, replayed: false });
    expect(await readPortalRootAccess(env, actor, secondaryContext)).toMatchObject({ available: true, state: "revoked", version: 1 });
    expect(await readPortalRootAccess(env, actor, context)).toMatchObject({ available: true, state: "active", version: 0 });
    expect((await db.prepare("SELECT projection_source_id,root_public_id FROM portal_v2_root_access_policies").all()).results)
      .toMatchObject([{ projection_source_id: "project-alpha:ledge-top-technologies", root_public_id: "org-ltt" }]);
  });

  it("allows only one concurrent mutation for the same expected version", async () => {
    const { db, env } = await fixture();
    const attempts = await Promise.allSettled([
      mutatePortalRootAccess(env, actor, context, { action: "revoke",
        expectedContextVersion: "context-one", expectedVersion: 0, reasonCode: "security_hold" }, "root-race-key-0001", live),
      mutatePortalRootAccess(env, actor, context, { action: "revoke",
        expectedContextVersion: "context-one", expectedVersion: 0, reasonCode: "security_hold" }, "root-race-key-0002", live),
    ]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_root_access_policy_audit").first("count")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) count FROM portal_v2_root_access_policy_mutations").first("count")).toBe(1);
    expect(await db.prepare("SELECT state,version FROM portal_v2_root_access_policies").first()).toEqual({ state: "revoked", version: 1 });
  });
});
