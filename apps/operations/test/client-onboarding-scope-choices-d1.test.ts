import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { readClientOnboardingScopeChoices } from "../src/worker/client-onboarding-scope-choices";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";

let runtime: Miniflare | undefined, db: D1Database, sequence = 0;
async function actor(): Promise<AuthenticatedNativeStaffWithAdmissionVersion> {
  const staffId = `scope-choice-staff-${++sequence}`, subject = `access|${staffId}`, email = `${staffId}@example.test`;
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject) VALUES(?,?,?,?)").bind(staffId, email, staffId, subject),
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(staffId, subject, staffId),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(staffId, email, staffId),
  ]);
  return { identity: { kind: "native", staffId, verifiedAccessSubject: subject, email, displayName: staffId, profileVersion: 1 },
    admissionVersion: 1, verifiedUntil: new Date(Date.now() + 3600_000).toISOString() };
}
async function grant(auth: AuthenticatedNativeStaffWithAdmissionVersion, effect: "allow" | "deny", kind: string,
  area: string | null = null, division: string | null = null, permission = "directory.profile.edit") {
  const id = `scope-choice-grant-${++sequence}`;
  await db.prepare(`INSERT INTO native_directory_grants
    (id,staff_id,permission,effect,scope_kind,business_area_id,division_id,granted_by) VALUES(?,?,?,?,?,?,?,?)`)
    .bind(id, auth.identity.staffId, permission, effect, kind, area, division, auth.identity.staffId).run();
  return id;
}
async function read(auth: AuthenticatedNativeStaffWithAdmissionVersion) {
  let calls = 0;
  const readOnly = { withSession(mode: string) {
    expect(mode).toBe("first-primary");
    const session = db.withSession("first-primary");
    return { prepare(sql: string) {
      calls++;
      expect(sql).toMatch(/^WITH authority AS/);
      expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE|PRAGMA)\b/i);
      return session.prepare(sql);
    } };
  } } as unknown as D1Database;
  const result = await readClientOnboardingScopeChoices(readOnly, auth);
  expect(calls).toBe(1);
  return result;
}

describe("onboarding scope choices against migrated D1", () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(item => /^\d{4}_.+\.sql$/.test(item) && item.slice(0, 4) <= "0220").sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
    await db.batch([
      db.prepare("INSERT INTO native_business_areas(id,name) VALUES('area:a','Drone Services')"),
      db.prepare("INSERT INTO native_business_areas(id,name) VALUES('area:b','Technologies')"),
      db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('area:inactive','Inactive Area',0)"),
      db.prepare("INSERT INTO native_business_divisions(id,business_area_id,name) VALUES('division:a','area:a','Greenleaf')"),
      db.prepare("INSERT INTO native_business_divisions(id,business_area_id,name) VALUES('division:b','area:a','Chippewa Falls')"),
      db.prepare("INSERT INTO native_business_divisions(id,business_area_id,name,active) VALUES('division:inactive','area:a','Inactive Division',0)"),
      db.prepare("INSERT INTO native_business_divisions(id,business_area_id,name) VALUES('division:inactive-parent','area:inactive','Unavailable')"),
    ]);
  }, 120_000);
  afterAll(async () => runtime?.dispose());

  it("offers names with area-wide and per-division choices to a global profile editor without other grants", async () => {
    const auth = await actor(); await grant(auth, "allow", "global");
    const result = await read(auth);
    expect(result.scopes.find(scope => scope.businessAreaId === "area:a")).toEqual({ businessAreaId: "area:a", name: "Drone Services",
      allowAreaWide: true, divisions: [{ divisionId: "division:b", name: "Chippewa Falls" }, { divisionId: "division:a", name: "Greenleaf" }] });
    expect(JSON.stringify(result)).not.toContain("inactive");
    expect(result.scopes.find(scope => scope.businessAreaId === "area:b")).toEqual({ businessAreaId: "area:b", name: "Technologies", allowAreaWide: true, divisions: [] });
  });
  it("never offers area-wide authority or sibling names to a division-only issuer", async () => {
    const auth = await actor(); await grant(auth, "allow", "division", null, "division:a");
    expect(await read(auth)).toEqual({ scopes: [{ businessAreaId: "area:a", name: "Drone Services", allowAreaWide: false,
      divisions: [{ divisionId: "division:a", name: "Greenleaf" }] }] });
  });
  it("applies area and global denies over narrower allows, and division denies only to that division", async () => {
    const auth = await actor(); await grant(auth, "allow", "global");
    await grant(auth, "deny", "division", null, "division:b");
    expect((await read(auth)).scopes.find(scope => scope.businessAreaId === "area:a")).toMatchObject({ allowAreaWide: true,
      divisions: [{ divisionId: "division:a", name: "Greenleaf" }] });
    await grant(auth, "deny", "business_area", "area:a");
    await grant(auth, "allow", "division", null, "division:a");
    expect((await read(auth)).scopes.some(scope => scope.businessAreaId === "area:a")).toBe(false);
    await grant(auth, "deny", "global");
    expect(await read(auth)).toEqual({ scopes: [] });
  });
  it("does not infer scope permission from an unrelated permission or cache a revoked grant", async () => {
    const auth = await actor(); await grant(auth, "allow", "global", null, null, "directory.profile.view");
    expect(await read(auth)).toEqual({ scopes: [] });
    const id = await grant(auth, "allow", "business_area", "area:b");
    expect((await read(auth)).scopes.map(scope => scope.businessAreaId)).toEqual(["area:b"]);
    await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id=?").bind(id).run();
    expect(await read(auth)).toEqual({ scopes: [] });
  });
  it("denies stale profile, admission, subject, email and expired or revoked staff instead of returning choices", async () => {
    const auth = await actor(); await grant(auth, "allow", "global");
    for (const stale of [
      { ...auth, admissionVersion: 2 },
      { ...auth, identity: { ...auth.identity, profileVersion: 2 } },
      { ...auth, identity: { ...auth.identity, verifiedAccessSubject: "access|other" } },
      { ...auth, identity: { ...auth.identity, email: "other@example.test" } },
      { ...auth, verifiedUntil: "2020-01-01T00:00:00.000Z" },
    ]) await expect(readClientOnboardingScopeChoices(db, stale)).rejects.toThrow("client_onboarding_scope_choices_denied");
    await db.prepare("UPDATE native_staff_admissions SET active=0,version=version+1 WHERE staff_id=?").bind(auth.identity.staffId).run();
    await expect(readClientOnboardingScopeChoices(db, auth)).rejects.toThrow("client_onboarding_scope_choices_denied");
  });
  it("refuses an oversized result rather than silently truncating permitted choices", async () => {
    const auth = await actor(); await grant(auth, "allow", "business_area", "area:b");
    for (let start = 0; start < 513; start += 64)
      await db.batch(Array.from({ length: Math.min(64, 513 - start) }, (_, offset) => db.prepare(
        "INSERT INTO native_business_divisions(id,business_area_id,name) VALUES(?,'area:b',?)")
        .bind(`division:overflow:${start + offset}`, `Overflow ${start + offset}`)));
    await expect(readClientOnboardingScopeChoices(db, auth)).rejects.toThrow("client_onboarding_scope_choices_unavailable");
  });
});
