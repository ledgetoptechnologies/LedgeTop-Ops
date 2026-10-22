import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { readNativeStaffManagement } from "../src/worker/native-staff-management-read";

let runtime: Miniflare | undefined;
let db: D1Database;
const request = (capability = "staff.profile.read", targetStaffId = "employee") => ({
  actorStaffId: "reader", verifiedAccessSubject: "provider|reader/path", targetStaffId, capability,
});

// Alter only the in-memory response of a real disposable D1 batch. No schema
// checks or stored data are disabled to exercise the response-validation seam.
function alteredResults(transform: (results: D1Result<Record<string, unknown>>[]) => void): D1Database {
  return new Proxy(db, { get(database, key) {
    if (key === "withSession") return (...args: Parameters<D1Database["withSession"]>) => {
      const session = database.withSession(...args);
      return new Proxy(session, { get(target, property) {
        if (property === "batch") return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch<Record<string, unknown>>(statements);
          transform(results);
          return results;
        };
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      } });
    };
    const member = Reflect.get(database, key, database);
    return typeof member === "function" ? member.bind(database) : member;
  } });
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", script: "export default {fetch(){return new Response('fixture')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= "0067").sort()) {
    await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
  }
  for (const id of ["reader", "employee", "private-employee"]) {
    await db.batch([
      db.prepare("INSERT INTO staff_users(id,email,display_name,status,provisioning_source,sync_protected) VALUES(?,?,?,'active','local',1)").bind(id, `${id}@example.test`, id),
      db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(id, id === "reader" ? request().verifiedAccessSubject : `subject:${id}`, id),
      db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(id, `${id}@example.test`, id),
    ]);
  }
  for (const capability of ["staff.profile.read", "staff.effective_access.read"]) {
    await db.prepare(`INSERT INTO native_staff_management_delegations
      (id,actor_staff_id,capability,effect,scope_kind,target_staff_id,granted_by)
      VALUES(?,'reader',?,'allow','exact_staff','employee','reader')`).bind(`reader:${capability}`, capability).run();
  }
  await db.batch([
    db.prepare(`INSERT INTO native_staff_admin_delegations(id,actor_staff_id,action,effect,scope_kind,granted_by)
      VALUES('same-id','employee','staff.profile.edit','deny','global','reader')`),
    db.prepare(`INSERT INTO native_staff_management_delegations(id,actor_staff_id,capability,effect,scope_kind,granted_by)
      VALUES('same-id','employee','staff.profile.edit','allow','global','reader')`),
  ]);
}, 120_000);
afterAll(async () => { await runtime?.dispose(); });

describe("independent native staff read boundaries", () => {
  it("does not disclose management authority with profile-only access", async () => {
    const result = await readNativeStaffManagement(db, request());
    expect(result.scopedProfile).toMatchObject({ displayName: "employee", loginEmail: "employee@example.test" });
    expect(result.managementSnapshot).toBeNull();
    expect(JSON.stringify(result)).not.toContain("same-id");
  });

  it("copies the opaque subject, capability and target before awaiting the database", async () => {
    const value = request();
    const pending = readNativeStaffManagement(db, value);
    value.targetStaffId = "private-employee";
    value.capability = "staff.effective_access.read";
    value.verifiedAccessSubject = "different-subject";
    const result = await pending;
    expect(result.target.staffId).toBe("employee");
    expect(result.capability).toBe("staff.profile.read");
    expect(result.scopedProfile).not.toBeNull();
    expect(result.managementSnapshot).toBeNull();
  });

  it("rejects request accessors without invoking them", async () => {
    const value = request();
    let reads = 0;
    Object.defineProperty(value, "targetStaffId", { enumerable: true, get() { reads++; return "employee"; } });
    await expect(readNativeStaffManagement(db, value)).rejects.toThrow();
    expect(reads).toBe(0);
  });

  it("inspects target authority and preserves old/new identity provenance", async () => {
    const result = await readNativeStaffManagement(db, request("staff.effective_access.read"));
    expect(result.scopedProfile).toBeNull();
    const rows = result.managementSnapshot!.delegations;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.referenceId)).size).toBe(2);
    expect(rows.map(row => row.effect).sort()).toEqual(["allow", "deny"]);
    expect(JSON.stringify(result)).not.toContain("reader:staff.profile.read");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(rows)).toBe(true);
  });

  it("cannot inspect another target or upgrade the requested capability", async () => {
    await expect(readNativeStaffManagement(db, request("staff.profile.read", "private-employee"))).rejects.toThrow();
    await expect(readNativeStaffManagement(db, request("staff.revocation_impact.read"))).rejects.toThrow();
    await expect(readNativeStaffManagement(db, request("staff.profile.edit"))).rejects.toThrow();
    await expect(readNativeStaffManagement(db, { ...request(), verifiedAccessSubject: "subject:employee" })).rejects.toThrow();
  });

  it("rejects malformed target rows, future contracts and unsuccessful batches", async () => {
    const corruptions: ((results: D1Result<Record<string, unknown>>[]) => void)[] = [
      results => { results[6]!.results[0]!.contract_version = 2; },
      results => { results[6]!.results[0]!.business_area_id = "incompatible-with-global"; },
      results => { results[6]!.results[0]!.active = 0.5; },
      results => { results[1]!.results[0]!.login_email = "not-an-email"; },
      results => { Reflect.set(results[0]!, "success", false); },
      results => { results[4]!.results = Array.from({ length: 513 }, () => ({ ...results[4]!.results[0]! })); },
    ];
    for (const corrupt of corruptions) {
      await expect(readNativeStaffManagement(alteredResults(corrupt), request("staff.effective_access.read"))).rejects.toThrow("native_staff_management_read_denied");
    }
  });

  it("rejects row-array getters without evaluating them", async () => {
    let reads = 0;
    const altered = alteredResults(results => {
      const original = results[6]!.results[0]!;
      Object.defineProperty(results[6]!.results, "0", { enumerable: true, get() { reads++; return original; } });
    });
    await expect(readNativeStaffManagement(altered, request("staff.effective_access.read"))).rejects.toThrow("native_staff_management_read_denied");
    expect(reads).toBe(0);
  });

  it("rechecks subject/admission and does not reuse an earlier authorized read", async () => {
    await readNativeStaffManagement(db, request());
    await db.prepare("UPDATE native_staff_admissions SET active=0,version=version+1 WHERE staff_id='reader'").run();
    await expect(readNativeStaffManagement(db, request())).rejects.toThrow();
  });
});
