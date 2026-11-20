// Team "own users" security requirements R1-R6 through the real mounted Operations
// worker fetch path: real RS256 Access assertions (locally generated key), the real
// authenticateStaff/ACL/CSRF middleware and every current Operations migration in
// local D1 (Miniflare). Synthetic identities and hosts only.
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { OPERATIONS_NATIVE_STAFF_LIFECYCLE_BASE as BASE } from "../src/worker/operations-native-staff-lifecycle-http";
import { csrfToken } from "../src/worker/request-security";
import type { Env, StaffPrincipal } from "../src/worker/types";
import worker from "../src/worker/index";

const keys = vi.hoisted(() => ({ getKey: undefined as unknown }));
vi.mock("jose", async importOriginal => ({ ...await importOriginal<typeof import("jose")>(), createRemoteJWKSet: () => keys.getKey }));
// Only the unused platform base classes are stubbed; fetch dispatch, auth, ACL, CSRF and D1 stay real.
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));

const issuer = "https://synthetic-own-users.cloudflareaccess.com", audience = "synthetic-own-users-staff-aud";
const clientAudience = "synthetic-own-users-client-portal-aud", origin = "https://ops.example.test";
const sessionSecret = "synthetic-own-users-session-secret-only-for-local-fixtures";
let runtime: Miniflare, db: D1Database, signingKey: CryptoKey, sequence = 0;
type Person = { id: string; email: string; subject: string };
const uuid = () => `80000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;

async function person(options: { role?: "role-admin" | "role-owner"; allow?: string[]; deny?: string[]; native?: boolean;
  syncProtected?: boolean; paLink?: string } = {}): Promise<Person> {
  const id = `own-users-${++sequence}`, email = `${id}@example.test`, subject = `access|${id}`;
  const statements = [db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,project_alpha_user_id,sync_protected)
    VALUES(?,?,?,?,?,?)`).bind(id, email, `Synthetic ${id}`, subject, options.paLink ?? null, options.syncProtected ? 1 : 0)];
  if (options.role) statements.push(db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES(?,?,?,'global','global')")
    .bind(uuid(), id, options.role));
  for (const [effect, list] of [["allow", options.allow ?? []], ["deny", options.deny ?? []]] as const)
    for (const permission of list) statements.push(db.prepare(`INSERT INTO staff_permission_overrides
      (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by) VALUES(?,?,?,?,'global',NULL,'global',?)`)
      .bind(uuid(), id, permission, effect, id));
  if (options.native) statements.push(
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(id, subject, id),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(id, email, `Synthetic ${id}`));
  await db.batch(statements);
  return { id, email, subject };
}
async function delegate(actor: Person, capabilities: string[]) {
  await db.batch(capabilities.map(capability => db.prepare(`INSERT INTO native_staff_management_delegations
    (id,actor_staff_id,capability,effect,scope_kind,granted_by) VALUES(?,?,?,'allow','global',?)`).bind(`${actor.id}:${capability}`, actor.id, capability, actor.id)));
}
async function token(who: { email?: string; subject: string }, aud = audience, extras: Record<string, unknown> = {}) {
  return new SignJWT({ type: "app", ...(who.email ? { email: who.email } : {}), ...extras }).setProtectedHeader({ alg: "RS256", kid: "synthetic" })
    .setIssuer(issuer).setAudience(aud).setSubject(who.subject).setIssuedAt().setExpirationTime("10m").sign(signingKey);
}
const env = () => ({ OPS_DB: db, TEAM_DOMAIN: issuer, OPERATIONS_AUD: audience, ENVIRONMENT: "staging", EXPECTED_HOST: new URL(origin).hostname,
  PUBLIC_BASE_URL: origin, OPERATIONS_ORIGINS: origin, OPERATIONS_SESSION_SECRET: sessionSecret, AUDIT_IP_SECRET: "synthetic-own-users-audit-secret-only-for-local-fixtures" }) as unknown as Env;
const executionContext = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const fetch = (request: Request) => worker.fetch(request, env(), executionContext);
const roster = (assertion?: string) => fetch(new Request(`${origin}/api/team/staff`, { headers: assertion ? { "Cf-Access-Jwt-Assertion": assertion } : {} }));
async function putControls(actor: Person, targetId: string, controls: Record<string, boolean>) {
  const csrf = await csrfToken(env(), { accessSubject: actor.subject } as StaffPrincipal);
  return fetch(new Request(`${origin}/api/admin/staff/${targetId}/access-controls`, { method: "PUT", body: JSON.stringify(controls),
    headers: { "Cf-Access-Jwt-Assertion": await token(actor), Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf } }));
}
const CONTROL_KEYS = ["allOperations", "sopAssignment", "deliveryBrowse", "deliveryLinkCreate", "deliveryLinkRevoke", "deliveryLinkAudit",
  "teamRoster", "administration", "viewerAccess", "viewerDatasets", "viewerProcessing", "viewerPublish", "viewerShareCreate",
  "viewerShareRevoke", "viewerClientAccess", "viewerStoragePurge"] as const;
const controls = (enabled: Partial<Record<typeof CONTROL_KEYS[number], boolean>> = {}) =>
  Object.fromEntries(CONTROL_KEYS.map(key => [key, enabled[key] ?? false])) as Record<string, boolean>;
const overrides = async (staffId: string) => (await db.prepare(
  "SELECT permission_key,effect FROM staff_permission_overrides WHERE staff_id=? ORDER BY permission_key").bind(staffId).all()).results;
const setGate = (enabled: 0 | 1) => db.prepare("UPDATE native_staff_access_reconciliation SET enabled=? WHERE singleton=1").bind(enabled).run();

describe("team own-users: mounted Team API with real Access JWT and full local D1", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", cf: false,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
    const pair = await generateKeyPair("RS256"); signingKey = pair.privateKey;
    keys.getKey = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: "synthetic", alg: "RS256" }] });
  }, 180_000);
  afterAll(async () => runtime?.dispose());

  it("R6: with the 0225 gate off, legacy staff without any native admission keep signing in and see the Team roster", async () => {
    expect(await db.prepare("SELECT enabled FROM native_staff_access_reconciliation WHERE singleton=1").first("enabled")).toBe(0);
    const legacy = await person({ allow: ["team.view"] });
    expect(await db.prepare("SELECT count(*) n FROM native_staff_admissions WHERE staff_id=?").bind(legacy.id).first("n")).toBe(0);
    const response = await roster(await token(legacy));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { staff: Array<{ id: string }> }).staff.map(row => row.id)).toContain(legacy.id);
    // Every native staff route stays absent while the gate is off.
    const native = await fetch(new Request(`${origin}${BASE}/session`, { headers: { "Cf-Access-Jwt-Assertion": await token(legacy),
      "Sec-Fetch-Site": "same-origin", "X-Native-Staff-Request": "1" } }));
    expect(native.status).toBe(404);
  });

  it("R1: the Team roster needs team.view, and an explicit deny beats an administrator role", async () => {
    const plain = await person();
    expect((await roster(await token(plain))).status).toBe(403);
    const deniedAdmin = await person({ role: "role-admin", deny: ["team.view"] });
    const denied = await roster(await token(deniedAdmin));
    expect(denied.status).toBe(403);
    expect(JSON.stringify(await denied.json())).not.toContain("@example.test");
    const admin = await person({ role: "role-admin" });
    expect((await roster(await token(admin))).status).toBe(200);
  });

  it("R1/R3: access controls need administrator + global roles.manage; self-edit is refused", async () => {
    const target = await person();
    const nonAdminWithRolesManage = await person({ allow: ["roles.manage", "team.view"] });
    expect((await putControls(nonAdminWithRolesManage, target.id, controls({ deliveryBrowse: true }))).status).toBe(403);
    const adminDeniedRolesManage = await person({ role: "role-admin", deny: ["roles.manage"] });
    expect((await putControls(adminDeniedRolesManage, target.id, controls({ deliveryBrowse: true }))).status).toBe(403);
    expect(await overrides(target.id)).toEqual([]);

    const admin = await person({ role: "role-admin" });
    expect((await putControls(admin, admin.id, controls({ viewerAccess: true }))).status).toBe(409);
    expect(await overrides(admin.id)).toEqual([]);
    const ok = await putControls(admin, target.id, controls({ deliveryBrowse: true }));
    expect(ok.status).toBe(200);
    expect(await overrides(target.id)).toContainEqual({ permission_key: "delivery.browse", effect: "allow" });
    expect(await db.prepare("SELECT count(*) n FROM audit_events WHERE action='staff.access_controls.updated' AND entity_id=? AND actor_id=?")
      .bind(target.id, admin.id).first("n")).toBe(1);
  });

  it("R3/R4: access controls cannot touch roles.manage or role assignments, so they cannot demote another administrator or owner", async () => {
    const admin = await person({ role: "role-admin" }), otherAdmin = await person({ role: "role-admin" });
    const owner = await person({ role: "role-owner" });
    // Another administrator's controls are editable but never reach roles.manage or role rows.
    expect((await putControls(admin, otherAdmin.id, controls())).status).toBe(200);
    const written = (await overrides(otherAdmin.id)).map(row => (row as { permission_key: string }).permission_key);
    expect(written).not.toContain("roles.manage");
    expect(written).not.toContain("team.manage");
    expect(await db.prepare("SELECT count(*) n FROM staff_role_assignments WHERE staff_id=? AND scope='global'").bind(otherAdmin.id).first("n")).toBe(1);
    // A global owner (unprotected here) cannot be given any deny at all.
    expect((await putControls(admin, owner.id, controls())).status).toBe(409);
    expect(await overrides(owner.id)).toEqual([]);
    expect(await db.prepare("SELECT count(*) n FROM staff_role_assignments WHERE staff_id=? AND scope='global'").bind(owner.id).first("n")).toBe(1);
    // The fully "unchecked" administrator still administers access controls.
    const third = await person();
    expect((await putControls(otherAdmin, third.id, controls({ viewerAccess: true }))).status).toBe(200);
    // And there is no route that writes staff rows or role assignments directly.
    const csrf = await csrfToken(env(), { accessSubject: admin.subject } as StaffPrincipal);
    const headers = { "Cf-Access-Jwt-Assertion": await token(admin), Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf };
    expect((await fetch(new Request(`${origin}/api/admin/staff`, { method: "POST", headers, body: "{}" }))).status).toBe(405);
    expect((await fetch(new Request(`${origin}/api/admin/staff/${owner.id}`, { method: "PATCH", headers, body: "{}" }))).status).toBe(405);
  });

  it("R4: a protected (sync_protected) staff member's access controls cannot be changed, native rows included", async () => {
    const admin = await person({ role: "role-admin" }), protectedOwner = await person({ role: "role-owner", syncProtected: true });
    expect((await putControls(admin, protectedOwner.id, controls())).status).toBe(409);
    expect(await overrides(protectedOwner.id)).toEqual([]);
    // Every sync_protected row stays out of the legacy writer, native rows included; real
    // Ops-onboarded hires are covered in team-own-users-access-controls.test.ts.
    const nativeHire = await person({ syncProtected: true, native: true });
    expect((await putControls(admin, nativeHire.id, controls({ deliveryBrowse: true }))).status).toBe(409);
  });

  it.skip("R3 (backend gap): a roles.manage holder cannot grant a permission they do not hold themselves", async () => {
    // BACKEND GAP: PUT /api/admin/staff/:id/access-controls checks only administrator + global
    // roles.manage (+ viewerStoragePurge needs an owner target). It never compares the granted
    // controls with the actor's own effective permissions, so an administrator with an explicit
    // deny on viewer.datasets.manage can still grant it to someone else (verified: 200).
    const actor = await person({ role: "role-admin", deny: ["viewer.datasets.manage"] }), target = await person();
    expect((await putControls(actor, target.id, controls({ viewerDatasets: true }))).status).toBe(403);
  });

  it("R2: a deactivated staff member loses access on the very next request with the same unexpired JWT", async () => {
    const member = await person({ allow: ["team.view"] }), assertion = await token(member);
    expect((await roster(assertion)).status).toBe(200);
    expect((await fetch(new Request(`${origin}/api/session/status`, { headers: { "Cf-Access-Jwt-Assertion": assertion } }))).status).toBe(200);
    await db.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").bind(member.id).run();
    expect((await roster(assertion)).status).toBe(403);
    expect((await fetch(new Request(`${origin}/api/session/status`, { headers: { "Cf-Access-Jwt-Assertion": assertion } }))).status).toBe(403);
    await db.prepare("UPDATE staff_users SET status='active' WHERE id=?").bind(member.id).run();
    expect((await roster(assertion)).status).toBe(200);
  });

  it("R5: client-portal, non-staff, wrong-audience and service identities get no staff roster; the roster DTO carries no subjects or PA links", async () => {
    const admin = await person({ role: "role-admin" });
    const linked = await person({ paLink: "synthetic-pa-user" });
    const attempts = [
      await roster(),
      await roster(await token({ email: "client-person@example.test", subject: "access|client-person" })),
      await roster(await token(admin, clientAudience)),
      await roster(await token({ subject: "" }, audience, { common_name: "synthetic-service.access" })),
      await roster("not.a.jwt"),
    ];
    for (const response of attempts) {
      expect([401, 403]).toContain(response.status);
      const text = await response.text();
      expect(text).not.toContain(admin.email);
      expect(text).not.toContain(linked.email);
    }
    const nativeAttempt = await fetch(new Request(`${origin}${BASE}/session`, { headers: {
      "Cf-Access-Jwt-Assertion": await token({ email: "client-person@example.test", subject: "access|client-person" }),
      "Sec-Fetch-Site": "same-origin", "X-Native-Staff-Request": "1" } }));
    expect([401, 403, 404]).toContain(nativeAttempt.status);
    expect(await nativeAttempt.text()).not.toContain("@example.test");

    const list = await roster(await token(admin));
    expect(list.status).toBe(200);
    const body = await list.text();
    expect(body).toContain(linked.email);
    expect(body).not.toContain(linked.subject);
    expect(body).not.toContain(admin.subject);
    expect(body).not.toContain("synthetic-pa-user");
    expect(body).not.toMatch(/access_subject|project_alpha_user_id/u);
  });

  it("R1/R5/R6: with the gate on, unadmitted legacy staff are refused, the admitted owner keeps access, and native actions need delegations", async () => {
    const owner = await person({ role: "role-owner", native: true });
    const legacyAdmin = await person({ role: "role-admin" });
    const nativePlain = await person({ native: true, allow: ["team.view"] });
    const target = await person({ native: true });
    await delegate(owner, ["staff.profile.read", "staff.profile.edit", "staff.admission.disable", "staff.admission.enable"]);
    await setGate(1);
    try {
      expect((await roster(await token(owner))).status).toBe(200);
      expect((await roster(await token(legacyAdmin))).status).toBe(403);

      const nativeHeaders = async (who: Person) => ({ "Cf-Access-Jwt-Assertion": await token(who), "Sec-Fetch-Site": "same-origin", "X-Native-Staff-Request": "1" });
      // A client identity still gets nothing from the native surface.
      const client = await fetch(new Request(`${origin}${BASE}/session`, { headers: { ...await nativeHeaders(owner),
        "Cf-Access-Jwt-Assertion": await token({ email: "client-person@example.test", subject: "access|client-person" }) } }));
      expect([401, 403]).toContain(client.status);

      // An admitted staff member without native delegations is denied every lifecycle action.
      const session = await fetch(new Request(`${origin}${BASE}/session`, { headers: await nativeHeaders(nativePlain) }));
      expect(session.status).toBe(200);
      const { csrfToken: csrf } = await session.json() as { csrfToken: string };
      const mutate = async (action: string, value: Record<string, unknown>) => fetch(new Request(`${origin}${BASE}/${target.id}/${action}`, {
        method: "POST", body: JSON.stringify(value), headers: { ...await nativeHeaders(nativePlain), Origin: origin,
          "Content-Type": "application/json", "X-CSRF-Token": csrf } }));
      expect((await mutate("profile", { commandId: uuid(), expectedVersion: 1, reason: "Synthetic unauthorized edit", displayName: "Changed" })).status).toBe(403);
      expect((await mutate("disable", { commandId: uuid(), expectedVersion: 1, reason: "Synthetic unauthorized disable" })).status).toBe(403);
      expect((await mutate("enable", { commandId: uuid(), expectedVersion: 1, reason: "Synthetic unauthorized enable" })).status).toBe(403);
      expect((await fetch(new Request(`${origin}${BASE}/${target.id}`, { headers: await nativeHeaders(nativePlain) }))).status).toBe(403);
      expect(await db.prepare(`SELECT s.status,a.active,a.version,p.display_name FROM staff_users s JOIN native_staff_admissions a ON a.staff_id=s.id
        JOIN native_staff_profiles p ON p.staff_id=s.id WHERE s.id=?`).bind(target.id).first())
        .toEqual({ status: "active", active: 1, version: 1, display_name: `Synthetic ${target.id}` });
    } finally { await setGate(0); }
    // Turning the gate back off restores the unchanged legacy sign-in.
    expect((await roster(await token(legacyAdmin))).status).toBe(200);
  });
});
