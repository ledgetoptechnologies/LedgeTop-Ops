import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { viewerAdminPermissions } from "../src/worker/viewer-processing";
import type { Env, StaffPrincipal } from "../src/worker/types";

const instances: Miniflare[] = [];

afterEach(async () => Promise.all(instances.splice(0).map(instance => instance.dispose())));

async function permissionEnv(
  publicSharesEnabled?: "true" | "false",
  grants = ["viewer.view", "viewer.share.create", "viewer.share.revoke"],
): Promise<Env> {
  const instance = new Miniflare({
    compatibilityDate: "2026-08-06",
    modules: true,
    script: "export default {fetch(){return new Response('ok')}}",
    d1Databases: { OPS_DB: "viewer-admin-permissions" },
  });
  instances.push(instance);
  const database = await instance.getD1Database("OPS_DB") as unknown as D1Database;
  await database.exec(`
    CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT,PRIMARY KEY(role_id,permission_key));
    CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
    CREATE TABLE local_staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
    CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,division_id TEXT);
    INSERT INTO staff_role_assignments VALUES('staff-admin','role-admin','global',NULL);
  `.replace(/\s*\n\s*/g, " "));
  await database.batch(grants.map(permission => database.prepare(
    "INSERT INTO role_permissions(role_id,permission_key) VALUES('role-admin',?)",
  ).bind(permission)));
  return {
    OPS_DB: database,
    VIEWER_INTEGRATION_ENABLED: "true",
    VIEWER_PUBLIC_SHARES_ENABLED: publicSharesEnabled,
  } as unknown as Env;
}

const principal: StaffPrincipal = {
  id: "staff-admin",
  email: "staff@example.test",
  displayName: "Staff Admin",
  accessSubject: "staff-subject",
  projectAlphaUserId: null,
};

describe("Viewer admin permission projection", () => {
  it("suppresses new public-share issuance while preserving read and revoke when the gate is off", async () => {
    for (const enabled of [undefined, "false"] as const) {
      const permissions = await viewerAdminPermissions(await permissionEnv(enabled), principal);
      expect(permissions).toContain("viewer.projects.read");
      expect(permissions).toContain("viewer.shares.read");
      expect(permissions).toContain("viewer.shares.revoke");
      expect(permissions).not.toContain("viewer.shares.create");
    }
  });

  it("projects public-share creation only when the dedicated gate is explicitly enabled", async () => {
    const permissions = await viewerAdminPermissions(await permissionEnv("true"), principal);
    expect(permissions).toContain("viewer.shares.create");
    expect(permissions).toContain("viewer.shares.read");
    expect(permissions).toContain("viewer.shares.revoke");
  });

  it("does not turn a create-only grant into revoke authority while issuance is off", async () => {
    const permissions = await viewerAdminPermissions(
      await permissionEnv("false", ["viewer.view", "viewer.share.create"]), principal,
    );
    expect(permissions).toContain("viewer.shares.read");
    expect(permissions).not.toContain("viewer.shares.create");
    expect(permissions).not.toContain("viewer.shares.revoke");
  });

  it("keeps revoke-only staff able to list and revoke existing links while issuance is off", async () => {
    const permissions = await viewerAdminPermissions(
      await permissionEnv("false", ["viewer.view", "viewer.share.revoke"]), principal,
    );
    expect(permissions).toContain("viewer.shares.read");
    expect(permissions).toContain("viewer.shares.revoke");
    expect(permissions).not.toContain("viewer.shares.create");
  });
});
