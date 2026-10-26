import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { canonicalNativeStaffCohortReview, prepareNativeStaffCohortReview } from "../src/worker/native-staff-cohort-review";
import { csrfToken } from "../src/worker/request-security";
import type { Env, StaffPrincipal } from "../src/worker/types";
import worker from "../src/worker/index";

const keys = vi.hoisted(() => ({ getKey: undefined as unknown }));
vi.mock("jose", async importOriginal => ({ ...await importOriginal<typeof import("jose")>(), createRemoteJWKSet: () => keys.getKey }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));

const issuer = "https://synthetic-staff.cloudflareaccess.com", audience = "synthetic-staff-audience";
const origin = "https://ops.example.test", reviewPath = "/api/staff/current-cohort-review";
let runtime: Miniflare, db: D1Database, signingKey: CryptoKey, mountedEnv: Env;
const owner: StaffPrincipal = { id: "staff-beau-koltz", email: "beaukoltz@ledgetopdroneservices.com",
  displayName: "Beau Koltz", accessSubject: "access|synthetic-owner", projectAlphaUserId: null };
const manager: StaffPrincipal = { id: "staff-kollins-stirn", email: "kstirn@ledgetopdroneservices.com",
  displayName: "Kollins Stirn", accessSubject: "access|synthetic-kstirn", projectAlphaUserId: null };
const unboundOwner: StaffPrincipal = { id: "staff-unbound-review-owner", email: "unbound-review-owner@example.test",
  displayName: "Unbound Review Owner", accessSubject: "access|unbound-review-owner", projectAlphaUserId: null };

async function token(person: StaffPrincipal, subject = person.accessSubject) {
  return new SignJWT({ email: person.email, type: "app" }).setProtectedHeader({ alg: "RS256", kid: "synthetic" })
    .setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime("10m").sign(signingKey);
}
function request(assertion: string, csrf = "") {
  return new Request(`${origin}${reviewPath}`, { method: "POST", headers: {
    "Cf-Access-Jwt-Assertion": assertion, Origin: origin, "Sec-Fetch-Site": "same-origin",
    "Content-Type": "application/json", "X-CSRF-Token": csrf,
  }, body: "{}" });
}
async function stateCounts() {
  const names = ["staff_role_assignments", "staff_permission_overrides", "native_staff_admissions", "native_staff_profiles",
    "native_directory_grants", "native_directory_grant_generations", "native_directory_grant_history", "native_project_grants",
    "native_project_grant_generations", "native_staff_management_delegations", "native_staff_bootstrap_approvals", "native_staff_bootstrap_receipts"];
  const result: Record<string, number> = {};
  for (const name of names) result[name] = Number((await db.prepare(`SELECT count(*) n FROM ${name}`).first<number>("n")) ?? 0);
  return result;
}

describe("owner current-cohort review preparation on actual Operations 0221 schema", () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", cf: false,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    const migrations = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/u.test(name) && name.slice(0, 4) <= "0221").sort();
    for (const name of migrations)
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
    const pair = await generateKeyPair("RS256"); signingKey = pair.privateKey;
    keys.getKey = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: "synthetic", alg: "RS256" }] });
    await db.batch([
      db.prepare("UPDATE staff_users SET access_subject=? WHERE id=?").bind(owner.accessSubject, owner.id),
      db.prepare("UPDATE staff_users SET access_subject=? WHERE id=?").bind(manager.accessSubject, manager.id),
      db.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
        VALUES('review-allow',?,'operations.view','allow','global',NULL,'global',?),('review-deny',?,'operations.view','deny','global',NULL,'global',?)`)
        .bind(manager.id, owner.id, manager.id, owner.id),
      db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)")
        .bind(owner.id, owner.accessSubject, owner.id),
      db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)")
        .bind(owner.id, owner.email, owner.displayName),
      db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
        VALUES('review-directory-grant',?,'directory.profile.view','allow','global',1,?)`).bind(owner.id, owner.id),
      db.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,active,granted_by)
        VALUES('review-project-grant',?,'project.shared.sync','allow','global',1,?)`).bind(owner.id, owner.id),
      db.prepare("INSERT INTO staff_users(id,email,display_name) VALUES(?,?,?)").bind(unboundOwner.id, unboundOwner.email, unboundOwner.displayName),
      db.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key)
        VALUES('review-unbound-owner-assignment',?,'role-owner','global',NULL,'global')`).bind(unboundOwner.id),
    ]);
    mountedEnv = { OPS_DB: db, TEAM_DOMAIN: issuer, OPERATIONS_AUD: audience, ENVIRONMENT: "staging",
      EXPECTED_HOST: new URL(origin).hostname, PUBLIC_BASE_URL: origin, OPERATIONS_ORIGINS: origin,
      OPERATIONS_SESSION_SECRET: "synthetic-session-secret-only-for-local-review-tests-123" } as Env;
  }, 120_000);
  afterAll(async () => runtime?.dispose());

  it("returns exact current staff, role, direct override, bridge and grant state as a draft without authority", async () => {
    const before = await stateCounts();
    const ownerIdentityBefore = await db.prepare("SELECT email,access_subject,last_seen_at FROM staff_users WHERE id=?").bind(owner.id).first();
    const assertion = await token(owner);
    const response = await worker.fetch(request(assertion, await csrfToken(mountedEnv, owner)), mountedEnv,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const result = await response.json() as { packet: Record<string, any>; packetSha256: string };
    expect(result.packet).toMatchObject({
      kind: "operations-current-staff-cohort-review-draft-v1", status: "draft", advisory: true,
      executionAuthority: false, bootstrapApproval: false, acceptedReceipt: false, installerClaim: false,
      ownerStaffId: owner.id,
    });
    expect(result.packet.tables.staff_users).toContainEqual(expect.objectContaining({ id: manager.id, email: manager.email, status: "active" }));
    expect(result.packet.tables.staff_role_assignments).toContainEqual(expect.objectContaining({ staff_id: manager.id, role_id: "role-division-manager" }));
    expect(result.packet.tables.roles).toContainEqual(expect.objectContaining({ id: "role-owner" }));
    expect(result.packet.tables.role_permissions).toContainEqual(expect.objectContaining({ role_id: "role-owner", permission_key: "team.manage" }));
    expect(result.packet.tables.staff_permission_overrides).toContainEqual(expect.objectContaining({ id: "review-allow", effect: "allow" }));
    expect(result.packet.tables.staff_permission_overrides).toContainEqual(expect.objectContaining({ id: "review-deny", effect: "deny" }));
    expect(result.packet.tables.native_staff_access_reconciliation).toBeNull();
    expect(result.packet.tables.native_staff_control_plane_candidates).toEqual(expect.any(Array));
    expect(result.packet.tables.native_staff_lifecycle_control_plane_candidates).toBeNull();
    for (const table of ["native_directory_assignments", "native_directory_resource_scopes", "native_business_areas",
      "native_business_divisions", "native_staff_target_memberships", "native_staff_admin_delegations",
      "native_staff_authority_capabilities", "native_staff_management_delegations", "native_staff_delegation_ceilings"])
      expect(result.packet.tables[table]).toEqual(expect.any(Array));
    expect(result.packet.tables.native_staff_admissions).toContainEqual(expect.objectContaining({ staff_id: owner.id, bound_access_subject: owner.accessSubject, active: 1 }));
    expect(result.packet.tables.native_directory_grants).toContainEqual(expect.objectContaining({ id: "review-directory-grant", staff_id: owner.id }));
    expect(result.packet.tables.native_project_grants).toContainEqual(expect.objectContaining({ id: "review-project-grant", staff_id: owner.id }));
    expect(result.packet.cohort).toContainEqual(expect.objectContaining({ staffId: manager.id, bridgeStatus: "not_admitted",
      directPermissionOverrides: expect.arrayContaining([expect.objectContaining({ id: "review-allow", effect: "allow" }),
        expect.objectContaining({ id: "review-deny", effect: "deny" })]) }));
    expect(result.packet.cohort).toContainEqual(expect.objectContaining({ staffId: owner.id, bridgeStatus: "matched" }));
    expect(result.packetSha256).toBe(createHash("sha256").update(canonicalNativeStaffCohortReview(result.packet)).digest("hex"));
    expect(await stateCounts()).toEqual(before);
    expect(await db.prepare("SELECT email,access_subject,last_seen_at FROM staff_users WHERE id=?").bind(owner.id).first()).toEqual(ownerIdentityBefore);
    expect(result.packet.tables.native_staff_bootstrap_approvals).toHaveLength(before.native_staff_bootstrap_approvals!);
    expect(result.packet.tables.native_staff_bootstrap_receipts).toHaveLength(before.native_staff_bootstrap_receipts!);
  }, 20_000);

  it("includes scoped authority catalogs in the snapshot digest and detects their drift", async () => {
    const before = await prepareNativeStaffCohortReview(db, { staffId: owner.id });
    await db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('review-area','Review Area',1)").run();
    const after = await prepareNativeStaffCohortReview(db, { staffId: owner.id });
    expect(after.packet.snapshotSha256).not.toBe(before.packet.snapshotSha256);
    expect(after.packet.tables.native_business_areas).toContainEqual(expect.objectContaining({
      business_area_ref_sha256: createHash("sha256").update(JSON.stringify("review-area")).digest("hex"), active: 1,
    }));
    expect(after.packet.tables.native_directory_resource_scopes).toEqual(expect.any(Array));
  }, 20_000);

  it("denies a non-owner, an alternate subject, and a missing CSRF proof", async () => {
    const managerAssertion = await token(manager);
    expect((await worker.fetch(request(managerAssertion, await csrfToken(mountedEnv, manager)), mountedEnv,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext)).status).toBe(403);
    const ownerAssertion = await token(owner);
    expect((await worker.fetch(request(ownerAssertion, ""), mountedEnv,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext)).status).toBe(403);
    expect((await worker.fetch(request(await token(owner, "access|alternate-login"), await csrfToken(mountedEnv, owner)), mountedEnv,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext)).status).toBe(403);
    const unboundBefore = await db.prepare("SELECT access_subject FROM staff_users WHERE id=?").bind(unboundOwner.id).first("access_subject");
    expect((await worker.fetch(request(await token(unboundOwner), await csrfToken(mountedEnv, unboundOwner)), mountedEnv,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext)).status).toBe(403);
    expect(await db.prepare("SELECT access_subject FROM staff_users WHERE id=?").bind(unboundOwner.id).first("access_subject")).toBe(unboundBefore);
  });

  it("keeps exact-staff delegation targets joinable to the reviewed cohort", async () => {
    await db.prepare(`INSERT INTO native_staff_admin_delegations
      (id,actor_staff_id,action,effect,scope_kind,target_staff_id,granted_by)
      VALUES('review-exact-target',?,'staff.profile.edit','allow','exact_staff',?,?)`)
      .bind(owner.id, owner.id, owner.id).run();
    const result = await prepareNativeStaffCohortReview(db, { staffId: owner.id });
    expect(result.packet.tables.native_staff_admin_delegations).toContainEqual(expect.objectContaining({
      id: "review-exact-target", target_staff_id: owner.id,
    }));
    expect(result.packet.cohort).toContainEqual(expect.objectContaining({ staffId: owner.id }));
  }, 20_000);

  it("fails closed when a required 0221 authority table is absent", async () => {
    await db.prepare("ALTER TABLE native_staff_delegation_ceilings RENAME TO review_unavailable_ceilings").run();
    try {
      await expect(prepareNativeStaffCohortReview(db, { staffId: owner.id }))
        .rejects.toMatchObject({ code: "review_unavailable", status: 503 });
    } finally {
      await db.prepare("ALTER TABLE review_unavailable_ceilings RENAME TO native_staff_delegation_ceilings").run();
    }
  });

  it("refuses a cohort that changes between the two real D1 snapshots", async () => {
    const originalBatch = db.batch.bind(db);
    let calls = 0;
    // Inject a legal current-state change after the first complete SELECT batch.
    const changing = new Proxy(db, { get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        calls += 1;
        const result = await originalBatch(statements);
        if (calls === 1) await db.prepare(`INSERT INTO staff_permission_overrides
          (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
          VALUES('review-race',?,'operations.manage','deny','global',NULL,'global',?)`).bind(manager.id, owner.id).run();
        return result;
      };
      return Reflect.get(target, property, target);
    } }) as D1Database;
    await expect(prepareNativeStaffCohortReview(changing, { staffId: owner.id })).rejects.toMatchObject({ code: "cohort_changed", status: 409 });
    await db.prepare("DELETE FROM staff_permission_overrides WHERE id='review-race'").run();
  });
});
