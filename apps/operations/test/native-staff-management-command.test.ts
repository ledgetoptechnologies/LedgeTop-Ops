import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { executeNativeStaffManagementCommand } from "../src/worker/native-staff-management-command";

let runtime: Miniflare | undefined;
let db: D1Database;
const actor = "command-admin-a";
const survivor = "command-admin-b";
const target = "command-target";
const actions = ["staff.onboarding.create", "staff.onboarding.approve", "staff.admission.disable", "staff.membership.manage", "staff.directory_grant.manage", "staff.admin_delegation.manage"];
const directoryCaps = ["directory.profile.view", "directory.profile.edit", "directory.identity.link", "directory.enrollment.manage", "directory.portal_access.manage"];
const adminCaps = actions;

async function staff(id: string, subject: string): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name) VALUES(?,?,?)").bind(id, `${id}@example.test`, id),
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,'staff-beau-koltz')").bind(id, subject),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(id, `${id}@example.test`, id),
  ]);
}
async function completeAdmin(id: string): Promise<void> {
  await db.batch(actions.map((capability) => db.prepare(`INSERT INTO native_staff_management_delegations
    (id,actor_staff_id,capability,effect,scope_kind,granted_by) VALUES(?,?,?,'allow','global',?)`).bind(`${id}:${capability}`, id, capability, id)));
  await db.batch([
    ...directoryCaps.map((capability) => db.prepare(`INSERT INTO native_staff_delegation_ceilings
      (id,parent_delegation_id,authority_domain,capability,effect,grant_allow,grant_deny,operation_create,operation_revoke,scope_kind)
      VALUES(?,?,'directory',?,'allow',1,1,1,1,'global')`).bind(`${id}:directory:${capability}`, `${id}:staff.directory_grant.manage`, capability)),
    ...adminCaps.map((capability) => db.prepare(`INSERT INTO native_staff_delegation_ceilings
      (id,parent_delegation_id,authority_domain,capability,effect,grant_allow,grant_deny,operation_create,operation_revoke,scope_kind)
      VALUES(?,?,'staff_admin',?,'allow',1,1,1,1,'global')`).bind(`${id}:admin:${capability}`, `${id}:staff.admin_delegation.manage`, capability)),
  ]);
}
const command = (commandId: string, actorId = actor, subject = "command-subject-a", targetId = target, expectedVersion = 1) => ({ commandId, contractVersion: 1, capability: "staff.admission.disable", actor: { staffId: actorId, verifiedAccessSubject: subject }, targetStaffId: targetId, expectedVersion, reason: "Synthetic command test" });
describe("native staff management admission-disable command", () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const migration of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= "0074").sort()) {
      const sql = readFileSync(new URL(migration, directory), "utf8");
      await db.batch(splitD1MigrationStatements(sql).map((statement) => db.prepare(statement)));
    }
    await staff(actor, "command-subject-a"); await staff(survivor, "command-subject-b"); await staff(target, "command-subject-target");
    await completeAdmin(actor); await completeAdmin(survivor);
  }, 120_000);
  afterAll(async () => runtime?.dispose());

  it("atomically disables an admitted target and exactly replays the immutable receipt", async () => {
    const input = command("management-disable-1");
    expect(await executeNativeStaffManagementCommand(db, input)).toEqual({ commandId: "management-disable-1", contractVersion: 1, capability: "staff.admission.disable", targetStaffId: target, resultVersion: 2, replayed: false });
    expect(await executeNativeStaffManagementCommand(db, input)).toMatchObject({ replayed: true, resultVersion: 2 });
    expect(await db.prepare("SELECT active,version FROM native_staff_admissions WHERE staff_id=?").bind(target).first()).toEqual({ active: 0, version: 2 });
    expect(await db.prepare("SELECT count(*) count FROM native_staff_management_commands WHERE command_id='management-disable-1'").first("count")).toBe(1);
    expect(await db.prepare("SELECT count(*) count FROM native_staff_management_fences").first("count")).toBe(0);
  });

  it("rejects unsupported commands, stale versions, changed subjects, and revoked current authority", async () => {
    await expect(executeNativeStaffManagementCommand(db, { ...command("unsupported"), capability: "staff.membership.manage" })).rejects.toThrow("native_staff_management_command_denied");
    await expect(executeNativeStaffManagementCommand(db, command("stale", actor, "command-subject-a", actor, 99))).rejects.toThrow("native_staff_management_command_denied");
    await expect(executeNativeStaffManagementCommand(db, command("wrong-subject", actor, "command-subject-other", actor))).rejects.toThrow("native_staff_management_command_denied");
    await db.prepare("UPDATE native_staff_management_delegations SET active=0,version=version+1 WHERE id=?").bind(`${actor}:staff.admission.disable`).run();
    await expect(executeNativeStaffManagementCommand(db, command("revoked", actor, "command-subject-a", actor))).rejects.toThrow("native_staff_management_command_denied");
    await db.prepare("UPDATE native_staff_management_delegations SET active=1,version=version+1 WHERE id=?").bind(`${actor}:staff.admission.disable`).run();
  });

  it("allows self-disable only while another complete candidate survives", async () => {
    expect(await executeNativeStaffManagementCommand(db, command("self-disable-a", actor, "command-subject-a", actor))).toMatchObject({ replayed: false, resultVersion: 2 });
    await expect(executeNativeStaffManagementCommand(db, command("self-disable-a", actor, "command-subject-a", actor))).rejects.toThrow("native_staff_management_command_denied");
    await expect(executeNativeStaffManagementCommand(db, command("last-disable-b", survivor, "command-subject-b", survivor))).rejects.toThrow("native_staff_management_command_denied");
    expect(await db.prepare("SELECT active FROM native_staff_admissions WHERE staff_id=?").bind(survivor).first("active")).toBe(1);
  });

  it("rolls back admission and fence when the late immutable audit insert fails", async () => {
    await staff("rollback-target", "command-subject-rollback");
    await db.prepare(`CREATE TRIGGER synthetic_management_receipt_failure BEFORE INSERT ON native_staff_management_commands
      WHEN NEW.command_id='rollback-command' BEGIN SELECT RAISE(ABORT,'synthetic late failure'); END`).run();
    await expect(executeNativeStaffManagementCommand(db, command("rollback-command", survivor, "command-subject-b", "rollback-target"))).rejects.toThrow("native_staff_management_command_denied");
    expect(await db.prepare("SELECT active,version FROM native_staff_admissions WHERE staff_id='rollback-target'").first()).toEqual({ active: 1, version: 1 });
    expect(await db.prepare("SELECT count(*) count FROM native_staff_management_fences WHERE command_id='rollback-command'").first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM native_staff_management_commands WHERE command_id='rollback-command'").first("count")).toBe(0);
  });
});
