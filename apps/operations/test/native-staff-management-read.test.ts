import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { readNativeStaffManagement } from "../src/worker/native-staff-management-read";

let runtime: Miniflare | undefined;
let db: D1Database;
const actor = "staff-beau-koltz";
const target = "staff-read-target";
const subject = "access-subject-read-actor";

describe("native staff management scoped reads", () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    const migrations = readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= "0067").sort();
    for (const migration of migrations) {
      const sql = readFileSync(new URL(migration, directory), "utf8");
      await db.batch(splitD1MigrationStatements(sql).map((statement) => db.prepare(statement)));
    }
    await db.batch([
      db.prepare("INSERT INTO staff_users(id,email,display_name) VALUES(?,?,?)").bind(target, "target@example.test", "Target bridge"),
      db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(actor, subject, actor),
      db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,0,?)").bind(target, "access-subject-target", actor),
      db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(actor, "actor@example.test", "Actor"),
      db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(target, "target@example.test", "Target"),
      db.prepare(`INSERT INTO native_staff_management_delegations(id,actor_staff_id,capability,effect,scope_kind,target_staff_id,granted_by)
        VALUES('read-profile',?,'staff.profile.read','allow','exact_staff',?,?)`).bind(actor, target, actor),
      db.prepare(`INSERT INTO native_staff_management_delegations(id,actor_staff_id,capability,effect,scope_kind,target_staff_id,granted_by)
        VALUES('read-effective',?,'staff.effective_access.read','allow','exact_staff',?,?)`).bind(actor, target, actor),
      db.prepare(`INSERT INTO native_staff_management_delegations(id,actor_staff_id,capability,effect,scope_kind,granted_by)
        VALUES('target-parent',?,'staff.directory_grant.manage','allow','global',?)`).bind(target, actor),
      db.prepare(`INSERT INTO native_staff_admin_delegations(id,actor_staff_id,action,effect,scope_kind,active,version,granted_by)
        VALUES('same-raw-id',?,'staff.profile.edit','allow','global',1,3,?)`).bind(target, actor),
      db.prepare(`INSERT INTO native_staff_management_delegations(id,actor_staff_id,capability,effect,scope_kind,granted_by)
        VALUES('same-raw-id',?,'staff.profile.edit','deny','global',?)`).bind(target, actor),
    ]);
    await db.prepare(`INSERT INTO native_staff_delegation_ceilings
      (id,parent_delegation_id,authority_domain,capability,effect,grant_allow,grant_deny,operation_create,operation_revoke,scope_kind)
      VALUES('target-ceiling','target-parent','directory','directory.profile.view','allow',1,1,1,1,'global')`).run();
  }, 120_000);

  afterAll(async () => runtime?.dispose());

  it("returns profile only under profile-read authority and freezes it", async () => {
    const result = await readNativeStaffManagement(db, { actorStaffId: actor, verifiedAccessSubject: subject, targetStaffId: target, capability: "staff.profile.read" });
    expect(result.scopedProfile).toEqual({ loginEmail: "target@example.test", displayName: "Target" });
    expect(result.managementSnapshot).toBeNull();
    expect(result.target).toMatchObject({ staffId: target, admissionActive: false, admissionVersion: 1, profileVersion: 1 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.scopedProfile!)).toBe(true);
  });

  it("returns only the target management snapshot with collision-safe references", async () => {
    const result = await readNativeStaffManagement(db, { actorStaffId: actor, verifiedAccessSubject: subject, targetStaffId: target, capability: "staff.effective_access.read" });
    expect(result.scopedProfile).toBeNull();
    expect(result.managementSnapshot?.partial).toBe(true);
    expect(result.managementSnapshot?.delegations.map((row) => row.referenceId)).toHaveLength(3);
    expect(new Set(result.managementSnapshot?.delegations.map((row) => row.referenceId)).size).toBe(3);
    expect(result.managementSnapshot?.delegations.some((row) => row.referenceId.includes("same-raw-id"))).toBe(false);
    expect(result.managementSnapshot?.ceilings).toHaveLength(1);
    expect(result.managementSnapshot?.ceilings[0]?.parentReferenceId).toMatch(/^management:[0-9a-f]{64}$/);
    expect(Object.isFrozen(result.managementSnapshot?.delegations)).toBe(true);
  });

  it("denies unsupported authority, subject changes, and actor revocation without profile disclosure", async () => {
    const impact = { actorStaffId: actor, verifiedAccessSubject: subject, targetStaffId: target, capability: "staff.revocation_impact.read" };
    await expect(readNativeStaffManagement(db, impact)).rejects.toThrow("native_staff_management_read_denied");
    await expect(readNativeStaffManagement(db, { ...impact, capability: "staff.profile.edit" })).rejects.toThrow("native_staff_management_read_denied");
    await expect(readNativeStaffManagement(db, { ...impact, capability: "staff.profile.read", verifiedAccessSubject: "access-subject-other" })).rejects.toThrow("native_staff_management_read_denied");
    await db.prepare("UPDATE native_staff_admissions SET active=0,version=version+1 WHERE staff_id=?").bind(actor).run();
    await expect(readNativeStaffManagement(db, { ...impact, capability: "staff.profile.read" })).rejects.toThrow("native_staff_management_read_denied");
  });
});
