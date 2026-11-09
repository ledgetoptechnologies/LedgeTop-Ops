import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import {
  evaluatePermission, hasLocalGlobalAllow, isAdministrator, loadGrants,
  prepareAclAdministratorRead, prepareAclGrantRead, prepareAclLocalGlobalAllowRead,
  scopeFromAclGrantSnapshot, sqlScope,
} from "../src/worker/acl";
import type { Env, GrantRow, StaffPrincipal } from "../src/worker/types";

const principal: StaffPrincipal = { id: "synthetic-staff", email: "staff@example.test", displayName: "Staff",
  accessSubject: "subject", projectAlphaUserId: "synthetic-pa" };

describe("ACL snapshot read builders", { timeout: 120_000 }, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22",
      script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "acl-snapshot" } });
    db = await runtime.getD1Database("DB") as unknown as D1Database;
    env = { OPS_DB: db } as Env;
    await db.batch([
      db.prepare("CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT)"),
      db.prepare("CREATE TABLE local_staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT)"),
      db.prepare("CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT)"),
      db.prepare("CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,division_id TEXT)"),
      db.prepare("INSERT INTO role_permissions VALUES('role-admin','operations.view'),('role-operator','operations.view')"),
      db.prepare("INSERT INTO staff_role_assignments VALUES('synthetic-staff','role-admin','global',NULL)"),
      db.prepare("INSERT INTO local_staff_role_assignments VALUES('synthetic-staff','role-operator','assigned',NULL),('synthetic-staff','role-operator','division','north')"),
      db.prepare("INSERT INTO staff_permission_overrides VALUES('synthetic-staff','operations.view','deny','division','south'),('synthetic-staff','operations.view_all','allow','global',NULL)"),
    ]);
  }, 120_000);
  afterAll(async () => { await runtime?.dispose(); });

  it("matches current web reads for grants, administrator and explicit global allow", async () => {
    const session = db.withSession("first-primary");
    const [grantsResult, adminResult, broadResult] = await session.batch([
      prepareAclGrantRead(session, principal.id), prepareAclAdministratorRead(session, principal.id),
      prepareAclLocalGlobalAllowRead(session, principal.id, "operations.view_all"),
    ]);
    const grants = grantsResult!.results as GrantRow[];
    expect(grants).toEqual(await loadGrants(env, principal.id));
    expect(Boolean(adminResult!.results[0])).toBe(await isAdministrator(env, principal));
    expect(Boolean(broadResult!.results[0])).toBe(await hasLocalGlobalAllow(env, principal, "operations.view_all"));
    expect(scopeFromAclGrantSnapshot(grants, "operations.view")).toEqual(await sqlScope(env, principal, "operations.view"));
    expect(scopeFromAclGrantSnapshot(grants, "operations.view")).toMatchObject({ global: true, assigned: true,
      divisions: ["north"], deniedDivisions: ["south"], deniedGlobal: false });
    expect(evaluatePermission(grants, principal, "operations.view", { divisionId: "north" })).toBe(true);
    expect(evaluatePermission(grants, principal, "operations.view", { divisionId: "south" })).toBe(false);
  });

  it("preserves global-deny precedence and excludes other staff", async () => {
    await db.batch([
      db.prepare("INSERT INTO staff_permission_overrides VALUES('synthetic-staff','operations.view','deny','global',NULL)"),
      db.prepare("INSERT INTO staff_permission_overrides VALUES('other-staff','operations.view_all','allow','global',NULL)"),
    ]);
    const session = db.withSession("first-primary");
    const [grantsResult, otherAdmin, otherBroad] = await session.batch([
      prepareAclGrantRead(session, principal.id), prepareAclAdministratorRead(session, "other-staff"),
      prepareAclLocalGlobalAllowRead(session, "another-staff", "operations.view_all"),
    ]);
    const grants = grantsResult!.results as GrantRow[];
    expect(scopeFromAclGrantSnapshot(grants, "operations.view")).toMatchObject({ global: false, deniedGlobal: true });
    expect(evaluatePermission(grants, principal, "operations.view", { assignedStaffIds: [principal.id] })).toBe(false);
    expect(otherAdmin!.results).toEqual([]);
    expect(otherBroad!.results).toEqual([]);
  });
});
