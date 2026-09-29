import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
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
  if (grants.length) await database.batch(grants.map(permission => database.prepare(
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

async function canonicalOwnerEnv(enabled: "true" | "false"): Promise<Env> {
  const env = await permissionEnv(enabled, []);
  await env.OPS_DB.exec(`
    CREATE TABLE permissions(key TEXT PRIMARY KEY,description TEXT);
    CREATE TABLE roles(id TEXT PRIMARY KEY);
    CREATE TABLE staff_users(id TEXT PRIMARY KEY);
    INSERT INTO roles VALUES('role-owner'),('role-admin');
    INSERT INTO staff_users VALUES('staff-admin');
    DELETE FROM staff_role_assignments;
    INSERT INTO staff_role_assignments VALUES('staff-admin','role-owner','global',NULL);
  `.replace(/\s*\n\s*/g, " "));
  for (const migration of ["0026_viewer_permissions.sql", "0027_viewer_processing_control_plane.sql"]) {
    await env.OPS_DB.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8")
      .replace(/^\s*--.*$/gm, "").replace(/\s*\n\s*/g, " "));
  }
  return env;
}

describe("Viewer admin permission projection", () => {
  it("consistently projects canonical owner management authority without individual overrides", async () => {
    const env = await canonicalOwnerEnv("true");
    const initial = await viewerAdminPermissions(env, principal);
    const renewed = await viewerAdminPermissions(env, principal);
    expect(renewed).toEqual(initial);
    expect(initial).toEqual(expect.arrayContaining([
      "viewer.shares.read", "viewer.shares.create", "viewer.shares.revoke", "viewer.processing.publish",
    ]));
    expect(await env.OPS_DB.prepare("SELECT COUNT(*) AS n FROM staff_permission_overrides").first("n")).toBe(0);
  });

  it("keeps the sharing kill switch effective even for the canonical owner", async () => {
    const permissions = await viewerAdminPermissions(await canonicalOwnerEnv("false"), principal);
    expect(permissions).toContain("viewer.processing.publish");
    expect(permissions).toContain("viewer.shares.read");
    expect(permissions).toContain("viewer.shares.revoke");
    expect(permissions).not.toContain("viewer.shares.create");
  });

  it("does not infer owner authority from forged attributes, email, or the protected owner's ID", async () => {
    const env = await permissionEnv("true", []);
    const forged = Object.assign({}, principal, {
      id: "staff-beau-koltz", email: "owner@example.test", owner: true,
      sync_protected: 1, role: "role-owner", permissions: ["viewer.share.create"],
    });
    expect(await viewerAdminPermissions(env, forged)).toEqual([]);
    expect(await viewerAdminPermissions(env, principal)).toEqual([]);
  });

  it("keeps read-only staff and client-like identities from gaining management scopes", async () => {
    const env = await permissionEnv("true", ["viewer.view"]);
    const permissions = await viewerAdminPermissions(env, principal);
    expect(permissions).toContain("viewer.projects.read");
    expect(permissions).not.toContain("viewer.shares.create");
    expect(permissions).not.toContain("viewer.processing.publish");
    expect(await viewerAdminPermissions(env, { ...principal, id: "client-one" })).toEqual([]);
  });

  it("recomputes authority after the owner assignment is revoked", async () => {
    const env = await canonicalOwnerEnv("true");
    expect(await viewerAdminPermissions(env, principal)).toContain("viewer.shares.create");
    await env.OPS_DB.prepare("DELETE FROM staff_role_assignments WHERE staff_id=?").bind(principal.id).run();
    expect(await viewerAdminPermissions(env, principal)).toEqual([]);
  });

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
