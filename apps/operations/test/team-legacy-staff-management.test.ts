// Legacy Team staff management (create, name and status) through the real mounted
// Operations worker: real RS256 Access assertions (locally generated key), the real
// authenticateStaff/ACL/CSRF middleware and every Operations migration in local D1.
// Synthetic identities and hosts only.
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { csrfToken } from "../src/worker/request-security";
import type { Env, StaffPrincipal } from "../src/worker/types";
import worker from "../src/worker/index";
import { legacyStaffAnotherAdministratorSql } from "../src/worker/legacy-staff-sql";

const keys = vi.hoisted(() => ({ getKey: undefined as unknown }));
vi.mock("jose", async importOriginal => ({ ...await importOriginal<typeof import("jose")>(), createRemoteJWKSet: () => keys.getKey }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));

const issuer = "https://synthetic-legacy-staff.cloudflareaccess.com", audience = "synthetic-legacy-staff-aud";
const origin = "https://ops.example.test";
let runtime: Miniflare, db: D1Database, signingKey: CryptoKey, sequence = 0;
let beforeBatch: (() => Promise<void>) | null = null;
type Person = { id: string; email: string; subject: string };
const uuid = () => `90000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;

async function person(options: { role?: "role-admin" | "role-owner"; localOwner?: boolean; allow?: string[]; deny?: string[];
  native?: boolean; syncProtected?: boolean; id?: string } = {}): Promise<Person> {
  const id = options.id ?? `legacy-staff-${++sequence}`, email = `${id}@example.test`, subject = `access|${id}`;
  const statements = [db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,sync_protected) VALUES(?,?,?,?,?)`)
    .bind(id, email, `Synthetic ${id}`, subject, options.syncProtected ? 1 : 0)];
  if (options.role) statements.push(db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES(?,?,?,'global','global')")
    .bind(uuid(), id, options.role));
  if (options.localOwner) statements.push(db.prepare("INSERT INTO local_staff_role_assignments(id,staff_id,role_id,scope,created_by) VALUES(?,?,'role-owner','global',?)")
    .bind(uuid(), id, id));
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
async function token(who: { email: string; subject: string }) {
  return new SignJWT({ type: "app", email: who.email }).setProtectedHeader({ alg: "RS256", kid: "synthetic" })
    .setIssuer(issuer).setAudience(audience).setSubject(who.subject).setIssuedAt().setExpirationTime("10m").sign(signingKey);
}
// The D1 binding seen by the worker; beforeBatch lets a test interleave a concurrent write
// between the route's reads and its atomic write batch.
const opsDb = () => new Proxy(db, { get(target, key) {
  if (key === "batch") return async (statements: D1PreparedStatement[]) => { const hook = beforeBatch; beforeBatch = null;
    if (hook) await hook(); return target.batch(statements); };
  const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
} });
const env = () => ({ OPS_DB: opsDb(), TEAM_DOMAIN: issuer, OPERATIONS_AUD: audience, ENVIRONMENT: "staging", EXPECTED_HOST: new URL(origin).hostname,
  PUBLIC_BASE_URL: origin, OPERATIONS_ORIGINS: origin, OPERATIONS_SESSION_SECRET: "synthetic-legacy-staff-session-secret-local-only",
  AUDIT_IP_SECRET: "synthetic-legacy-staff-audit-secret-local-only" }) as unknown as Env;
const executionContext = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const fetch = (request: Request) => worker.fetch(request, env(), executionContext);
async function send(actor: Person, method: "POST" | "PATCH", path: string, value: unknown) {
  const csrf = await csrfToken(env(), { accessSubject: actor.subject } as StaffPrincipal);
  return fetch(new Request(`${origin}${path}`, { method, body: JSON.stringify(value), headers: {
    "Cf-Access-Jwt-Assertion": await token(actor), Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf } }));
}
const create = (actor: Person, value: unknown) => send(actor, "POST", "/api/admin/staff", value);
const edit = (actor: Person, id: string, value: unknown) => send(actor, "PATCH", `/api/admin/staff/${encodeURIComponent(id)}`, value);
const row = (id: string) => db.prepare("SELECT * FROM staff_users WHERE id=?").bind(id).first<Record<string, unknown>>();
const version = async (id: string) => (await row(id))!.updated_at as string;
const audits = (id: string, action: string) => db.prepare("SELECT count(*) n FROM audit_events WHERE entity_id=? AND action=?").bind(id, action).first("n");
type RosterRow = { id: string; profile_editable?: boolean; updated_at?: string };
async function roster(actor: Person) {
  const response = await fetch(new Request(`${origin}/api/team/staff`, { headers: { "Cf-Access-Jwt-Assertion": await token(actor) } }));
  expect(response.status).toBe(200);
  return response.json() as Promise<{ staff: RosterRow[]; can_manage_staff: boolean }>;
}
const setGate = (enabled: 0 | 1) => db.prepare("UPDATE native_staff_access_reconciliation SET enabled=? WHERE singleton=1").bind(enabled).run();
// Re-creates the named triggers after running a fixture write that the trigger would refuse.
async function withoutTriggers(table: string, event: "INSERT" | "UPDATE", write: () => Promise<unknown>) {
  const triggers = (await db.prepare(`SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND sql LIKE ?`)
    .bind(table, `%${event} ON ${table}%`).all<{ name: string; sql: string }>()).results;
  await db.batch(triggers.map(trigger => db.prepare(`DROP TRIGGER ${trigger.name}`)));
  try { await write(); } finally { await db.batch(triggers.map(trigger => db.prepare(trigger.sql))); }
}
// A pending native onboarding row (fixture only; the real create path needs a fenced command).
async function pendingOnboarding(email: string, proposedStaffId = `native-proposed-${++sequence}`) {
  const creator = await person({ native: true });
  await withoutTriggers("native_staff_pending_onboarding", "INSERT", () => db.prepare(`INSERT INTO native_staff_pending_onboarding
    (onboarding_id,proposed_staff_id,login_email,display_name,invitation_secret_sha256,expires_at,state,version,proposal_json,
     proposal_sha256,created_by_staff_id,created_by_subject,reason) VALUES(?,?,?,?,?,?,'pending',1,'{}',?,?,?,?)`)
    .bind(uuid(), proposedStaffId, email, "Synthetic Pending", "a".repeat(64), new Date(Date.now() + 86_400_000).toISOString(),
      "b".repeat(64), creator.id, creator.subject, "Synthetic onboarding fixture").run());
}
const session = async (who: { email: string; subject: string }) =>
  (await fetch(new Request(`${origin}/api/session/status`, { headers: { "Cf-Access-Jwt-Assertion": await token(who) } }))).status;

describe("legacy Team staff management: mounted worker, real Access JWT, full local D1", { timeout: 120_000 }, () => {
  let admin: Person;
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", cf: false,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    const names = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort();
    expect(names.some(name => name.startsWith("0244_"))).toBe(true);
    for (const name of names)
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
    const pair = await generateKeyPair("RS256"); signingKey = pair.privateKey;
    keys.getKey = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: "synthetic", alg: "RS256" }] });
    admin = await person({ role: "role-admin" });
  }, 180_000);
  afterAll(async () => runtime?.dispose());

  it("creates a local staff row with no access; the first sign-in binds its Access subject", async () => {
    const commandId = uuid();
    const response = await create(admin, { commandId, displayName: "  New Synthetic Person ", email: " New.Person@Example.TEST " });
    expect(response.status).toBe(201);
    const { staff } = await response.json() as { staff: { id: string; email: string } };
    expect(staff).toMatchObject({ id: `staff-local-${commandId}`, email: "new.person@example.test", display_name: "New Synthetic Person", status: "active" });
    expect(await row(staff.id)).toMatchObject({ status: "active", provisioning_source: "local", sync_protected: 0,
      project_alpha_user_id: null, access_subject: null });
    for (const table of ["staff_role_assignments", "local_staff_role_assignments", "staff_permission_overrides", "staff_divisions",
      "native_staff_admissions", "native_staff_profiles"])
      expect(await db.prepare(`SELECT count(*) n FROM ${table} WHERE staff_id=?`).bind(staff.id).first("n")).toBe(0);
    expect(await audits(staff.id, "staff.created")).toBe(1);
    // No roles or overrides: the new person signs in but holds no Team access yet.
    const newcomer = { id: staff.id, email: staff.email, subject: "access|synthetic-newcomer" };
    expect(await session(newcomer)).toBe(200);
    expect((await row(staff.id))!.access_subject).toBe("access|synthetic-newcomer");
    expect((await fetch(new Request(`${origin}/api/team/staff`, { headers: { "Cf-Access-Jwt-Assertion": await token(newcomer) } }))).status).toBe(403);
    // A different Access identity with the same email is refused after binding.
    expect(await session({ email: staff.email, subject: "access|someone-else" })).toBe(403);
  });

  it("an identical retry replays without a duplicate; a different payload under the same command is a conflict", async () => {
    const commandId = uuid(), value = { commandId, displayName: "Retry Person", email: "retry.person@example.test" };
    expect((await create(admin, value)).status).toBe(201);
    const again = await create(admin, value);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ replayed: true, staff: { id: `staff-local-${commandId}` } });
    expect((await create(admin, { ...value, displayName: "Other Name" })).status).toBe(409);
    expect((await create(admin, { ...value, email: "retry.other@example.test" })).status).toBe(409);
    expect(await db.prepare("SELECT count(*) n FROM staff_users WHERE email LIKE 'retry.%'").first("n")).toBe(1);
    expect(await audits(`staff-local-${commandId}`, "staff.created")).toBe(1);
  });

  it("refuses a duplicate email or an active sign-in alias with 409", async () => {
    const existing = await person();
    expect((await create(admin, { commandId: uuid(), displayName: "Dup", email: existing.email.toUpperCase() })).status).toBe(409);
    // An active 0226 alternate sign-in email of an owner.
    const owner = await person({ role: "role-owner" }), alias = "owner.alias@example.test", intentId = uuid(), created = Date.now() - 10_000;
    await db.batch([
      db.prepare("INSERT INTO staff_login_generations VALUES(?,0)").bind(owner.id),
      db.prepare(`INSERT INTO staff_login_binding_intents(id,staff_id,canonical_email,canonical_subject,issuer,alternate_email,token_sha256,generation,
        created_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?,?,0,?,?)`).bind(intentId, owner.id, owner.email, owner.subject, issuer, alias,
        intentId.replaceAll("-", "").padStart(64, "0"), created, created + 900_000),
      db.prepare("INSERT INTO staff_login_bindings(id,staff_id,issuer,login_email,access_subject,intent_id,created_at_ms) VALUES(?,?,?,?,?,?,?)")
        .bind(uuid(), owner.id, issuer, alias, "access|owner-alias", intentId, created),
    ]);
    const response = await create(admin, { commandId: uuid(), displayName: "Alias", email: alias });
    expect(response.status).toBe(409);
    expect(await db.prepare("SELECT count(*) n FROM staff_users WHERE email=?").bind(alias).first("n")).toBe(0);
    // Even when the pre-check is raced, the 0226 trigger aborts and maps to 409.
    const raced = "raced.alias@example.test", racedIntent = uuid();
    beforeBatch = async () => { await db.batch([
      db.prepare(`INSERT INTO staff_login_binding_intents(id,staff_id,canonical_email,canonical_subject,issuer,alternate_email,token_sha256,generation,
        created_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?,?,1,?,?)`).bind(racedIntent, owner.id, owner.email, owner.subject, issuer, raced,
        racedIntent.replaceAll("-", "").padStart(64, "0"), created, created + 900_000),
      db.prepare("INSERT INTO staff_login_bindings(id,staff_id,issuer,login_email,access_subject,intent_id,created_at_ms) VALUES(?,?,?,?,?,?,?)")
        .bind(uuid(), owner.id, issuer, raced, "access|owner-raced", racedIntent, created)]); };
    const racedResponse = await create(admin, { commandId: uuid(), displayName: "Raced", email: raced });
    expect(racedResponse.status).toBe(409);
    expect(await db.prepare("SELECT count(*) n FROM staff_users WHERE email=?").bind(raced).first("n")).toBe(0);
    expect((await create(admin, { commandId: uuid(), displayName: "Bad", email: "not-an-email" })).status).toBe(400);
    expect((await create(admin, { commandId: "not-a-uuid", displayName: "Bad", email: "bad@example.test" })).status).toBe(400);
    expect((await create(admin, { commandId: uuid(), displayName: "Bad", email: "bad2@example.test", role: "role-admin" })).status).toBe(400);
  });

  it("needs administrator + global roles.manage with deny precedence, for create and edit", async () => {
    const target = await person();
    const nonAdmin = await person({ allow: ["roles.manage", "team.view"] });
    const deniedAdmin = await person({ role: "role-admin", deny: ["roles.manage"] });
    for (const actor of [nonAdmin, deniedAdmin]) {
      expect((await create(actor, { commandId: uuid(), displayName: "Nope", email: `nope-${actor.id}@example.test` })).status).toBe(403);
      expect((await edit(actor, target.id, { expectedUpdatedAt: await version(target.id), displayName: "Nope" })).status).toBe(403);
    }
    expect((await row(target.id))!.display_name).toBe(`Synthetic ${target.id}`);
    expect(await db.prepare("SELECT count(*) n FROM staff_users WHERE email LIKE 'nope-%'").first("n")).toBe(0);
  });

  it("edits the name with optimistic concurrency; an exact repeat is harmless; a stale version is refused", async () => {
    const target = await person(), before = await version(target.id);
    const response = await edit(admin, target.id, { expectedUpdatedAt: before, displayName: "Renamed Person" });
    expect(response.status).toBe(200);
    const after = await version(target.id);
    expect(after).not.toBe(before);
    expect(await audits(target.id, "staff.profile.updated")).toBe(1);
    expect(await audits(target.id, "staff.status.changed")).toBe(0);
    const repeat = await edit(admin, target.id, { expectedUpdatedAt: before, displayName: "Renamed Person" });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ unchanged: true });
    expect(await audits(target.id, "staff.profile.updated")).toBe(1);
    expect((await edit(admin, target.id, { expectedUpdatedAt: before, displayName: "Stale Name" })).status).toBe(409);
    expect((await row(target.id))!.display_name).toBe("Renamed Person");
    expect(await version(target.id)).toBe(after);
  });

  it("deactivation refuses the person's very next request; reactivation restores sign-in", async () => {
    const member = await person({ allow: ["team.view"] }), assertion = await token(member);
    const status = async () => (await fetch(new Request(`${origin}/api/team/staff`, { headers: { "Cf-Access-Jwt-Assertion": assertion } }))).status;
    expect(await status()).toBe(200);
    expect((await edit(admin, member.id, { expectedUpdatedAt: await version(member.id), status: "inactive" })).status).toBe(200);
    expect(await status()).toBe(403);
    expect(await audits(member.id, "staff.status.changed")).toBe(1);
    expect((await edit(admin, member.id, { expectedUpdatedAt: await version(member.id), status: "active" })).status).toBe(200);
    expect(await status()).toBe(200);
    expect(await audits(member.id, "staff.status.changed")).toBe(2);
  });

  it("refuses self, owners, native rows, sync-protected rows and email/role keys without writing", async () => {
    // The migration-seeded protected owner (looked up, not named here).
    const seededOwner = await db.prepare(`SELECT staff_id FROM staff_role_assignments WHERE role_id='role-owner' AND scope='global'
      ORDER BY rowid LIMIT 1`).first<string>("staff_id");
    const fixed = { id: seededOwner!, email: "", subject: "" };
    const cases: Array<[Person, number]> = [
      [admin, 409], [fixed as Person, 409], [await person({ role: "role-owner" }), 409], [await person({ localOwner: true }), 409],
      [await person({ native: true }), 409], [await person({ syncProtected: true }), 409],
    ];
    for (const [target, expected] of cases) {
      const before = await row(target.id);
      expect((await edit(admin, target.id, { expectedUpdatedAt: before!.updated_at, status: "inactive" })).status).toBe(expected);
      expect((await edit(admin, target.id, { expectedUpdatedAt: before!.updated_at, displayName: "Changed" })).status).toBe(expected);
      expect({ ...await row(target.id), last_seen_at: null }).toEqual({ ...before, last_seen_at: null });
    }
    const plain = await person(), before = await row(plain.id);
    for (const extra of [{ email: "changed@example.test" }, { role: "role-admin" }, { roles: ["role-admin"] }])
      expect((await edit(admin, plain.id, { expectedUpdatedAt: before!.updated_at, displayName: "Changed", ...extra })).status).toBe(400);
    expect((await edit(admin, "legacy-staff-missing", { expectedUpdatedAt: "x", displayName: "Changed" })).status).toBe(404);
    expect(await row(plain.id)).toEqual(before);
    expect(await db.prepare("SELECT count(*) n FROM audit_events WHERE entity_id=? AND action IN ('staff.profile.updated','staff.status.changed')")
      .bind(plain.id).first("n")).toBe(0);
  });

  it("race: a target that becomes an owner between read and write is refused with nothing written", async () => {
    for (const table of ["staff_role_assignments", "local_staff_role_assignments"]) {
      const target = await person(), before = await row(target.id);
      beforeBatch = async () => {
        await (table === "staff_role_assignments"
          ? db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES(?,?,'role-owner','global','global')").bind(uuid(), target.id)
          : db.prepare("INSERT INTO local_staff_role_assignments(id,staff_id,role_id,scope,created_by) VALUES(?,?,'role-owner','global',?)").bind(uuid(), target.id, target.id)).run();
      };
      expect((await edit(admin, target.id, { expectedUpdatedAt: before!.updated_at, status: "inactive", displayName: "Raced" })).status).toBe(409);
      expect(await row(target.id)).toEqual(before);
      expect(await db.prepare("SELECT count(*) n FROM audit_events WHERE entity_id=? AND action LIKE 'staff.%'").bind(target.id).first("n")).toBe(0);
    }
    // A concurrent version change inside the window is also refused.
    const target = await person(), before = await row(target.id);
    beforeBatch = async () => { await db.prepare("UPDATE staff_users SET updated_at='2000-01-01 00:00:00' WHERE id=?").bind(target.id).run(); };
    expect((await edit(admin, target.id, { expectedUpdatedAt: before!.updated_at, displayName: "Raced" })).status).toBe(409);
    expect((await row(target.id))!.display_name).toBe(before!.display_name);
  });

  it("roster flags match the route decisions", async () => {
    const plain = await person(), owner = await person({ role: "role-owner" }), localOwner = await person({ localOwner: true });
    const native = await person({ native: true }), syncProtected = await person({ syncProtected: true });
    const viewer = await person({ allow: ["team.view"] }), deniedAdmin = await person({ role: "role-admin", deny: ["roles.manage"] });
    const list = await roster(admin);
    expect(list.can_manage_staff).toBe(true);
    const flags = new Map(list.staff.map(entry => [entry.id, entry]));
    for (const target of [admin, owner, localOwner, native, syncProtected, plain]) {
      const flag = flags.get(target.id)!.profile_editable;
      const status = (await edit(admin, target.id, { expectedUpdatedAt: flags.get(target.id)!.updated_at, displayName: `Flag ${target.id}` })).status;
      expect(flag).toBe(status === 200);
      expect(status === 200 || status === 409).toBe(true);
    }
    expect(flags.get(plain.id)!.profile_editable).toBe(true);
    const viewerList = await roster(viewer);
    expect(viewerList.can_manage_staff).toBe(false);
    expect(viewerList.staff.every(entry => entry.profile_editable === undefined)).toBe(true);
    expect(JSON.stringify(viewerList)).not.toContain("native_lifecycle");
    const deniedList = await roster(deniedAdmin);
    expect(deniedList.can_manage_staff).toBe(false);
    expect(deniedList.staff.every(entry => entry.profile_editable === false)).toBe(true);
  });
  it("refuses unsafe names and malformed emails", async () => {
    for (const displayName of ["Admin‮evil", "Zero​width", "Line break", "Tab\tname"])
      expect((await create(admin, { commandId: uuid(), displayName, email: `unsafe-${++sequence}@example.test` })).status).toBe(400);
    for (const email of ["two@at@example.test", "space d@example.test", "nodot@localhost", "üml@example.test", "a@b.c"])
      expect((await create(admin, { commandId: uuid(), displayName: "Synthetic", email })).status).toBe(400);
    const plain = await person();
    expect((await edit(admin, plain.id, { expectedUpdatedAt: await version(plain.id), displayName: "Bidi‭name" })).status).toBe(400);
  });

  it("refuses an email reserved by a pending native onboarding, and edits of onboarding-provenance rows", async () => {
    const reserved = "pending.hire@example.test";
    await pendingOnboarding(reserved);
    const response = await create(admin, { commandId: uuid(), displayName: "Pending", email: "Pending.Hire@example.test" });
    expect(response.status).toBe(409);
    expect(await db.prepare("SELECT count(*) n FROM staff_users WHERE email=?").bind(reserved).first("n")).toBe(0);
    // Raced: the reservation lands between the pre-check and the write; the in-batch guard refuses.
    const raced = "raced.hire@example.test";
    beforeBatch = () => pendingOnboarding(raced);
    expect((await create(admin, { commandId: uuid(), displayName: "Raced", email: raced })).status).toBe(409);
    expect(await db.prepare("SELECT count(*) n FROM staff_users WHERE email=?").bind(raced).first("n")).toBe(0);
    // A staff row that only has native onboarding provenance (no admission or profile) is not legacy-editable.
    const provenance = await person();
    await pendingOnboarding(`provenance-${provenance.id}@example.test`, provenance.id);
    const before = await row(provenance.id);
    expect((await edit(admin, provenance.id, { expectedUpdatedAt: before!.updated_at, status: "inactive" })).status).toBe(409);
    expect(await row(provenance.id)).toEqual(before);
    expect((await roster(admin)).staff.find(entry => entry.id === provenance.id)!.profile_editable).toBe(false);
  });

  it("refuses both routes with native_cutover_active once the 0225 switch is on, including inside the batch", async () => {
    const nativeAdmin = await person({ role: "role-admin", native: true }), target = await person();
    await setGate(1);
    try {
      const created = await create(nativeAdmin, { commandId: uuid(), displayName: "Cutover", email: "cutover.person@example.test" });
      expect(created.status).toBe(409);
      expect(await created.json()).toMatchObject({ code: "native_cutover_active" });
      const edited = await edit(nativeAdmin, target.id, { expectedUpdatedAt: await version(target.id), displayName: "Cutover" });
      expect(edited.status).toBe(409);
      expect(await edited.json()).toMatchObject({ code: "native_cutover_active" });
    } finally { await setGate(0); }
    const before = await row(target.id);
    beforeBatch = async () => { await setGate(1); };
    try {
      const raced = await edit(admin, target.id, { expectedUpdatedAt: before!.updated_at, status: "inactive" });
      expect(raced.status).toBe(409);
      expect(await raced.json()).toMatchObject({ code: "native_cutover_active" });
    } finally { await setGate(0); }
    expect(await row(target.id)).toEqual(before);
    beforeBatch = async () => { await setGate(1); };
    try {
      expect((await create(admin, { commandId: uuid(), displayName: "Raced", email: "cutover.raced@example.test" })).status).toBe(409);
    } finally { await setGate(0); }
    expect(await db.prepare("SELECT count(*) n FROM staff_users WHERE email LIKE 'cutover.%'").first("n")).toBe(0);
  });

  it("a different administrator cannot replay another administrator's command", async () => {
    const other = await person({ role: "role-admin" }), commandId = uuid();
    const value = { commandId, displayName: "Replay Target", email: "replay.target@example.test" };
    expect((await create(admin, value)).status).toBe(201);
    expect((await create(other, value)).status).toBe(409);
    expect(await db.prepare("SELECT count(*) n FROM staff_users WHERE email=?").bind(value.email).first("n")).toBe(1);
    expect(await audits(`staff-local-${commandId}`, "staff.created")).toBe(1);
  });

  it("rechecks the acting administrator inside the batch", async () => {
    const actor = await person({ role: "role-admin" }), target = await person(), before = await row(target.id);
    beforeBatch = async () => { await db.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
      VALUES(?,?,'roles.manage','deny','global',NULL,'global',?)`).bind(uuid(), actor.id, actor.id).run(); };
    expect((await edit(actor, target.id, { expectedUpdatedAt: before!.updated_at, status: "inactive" })).status).toBe(403);
    expect(await row(target.id)).toEqual(before);
    const second = await person({ role: "role-admin" });
    beforeBatch = async () => { await db.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").bind(second.id).run(); };
    expect((await create(second, { commandId: uuid(), displayName: "Late", email: "late.actor@example.test" })).status).toBe(403);
    expect(await db.prepare("SELECT count(*) n FROM staff_users WHERE email='late.actor@example.test'").first("n")).toBe(0);
  });

  it("reactivation reports retained roles, access settings and alternate sign-ins", async () => {
    const target = await person({ role: "role-admin", allow: ["delivery.browse"] });
    expect((await edit(admin, target.id, { expectedUpdatedAt: await version(target.id), status: "inactive" })).status).toBe(200);
    const reactivated = await edit(admin, target.id, { expectedUpdatedAt: await version(target.id), status: "active" });
    expect(reactivated.status).toBe(200);
    expect(await reactivated.json()).toMatchObject({ retained: { roles: 1, overrides: 1, alternateLogins: 0 } });
    expect(await db.prepare("SELECT count(*) n FROM staff_role_assignments WHERE staff_id=?").bind(target.id).first("n")).toBe(1);
    const renamed = await edit(admin, target.id, { expectedUpdatedAt: await version(target.id), displayName: "Just Renamed" });
    expect(await renamed.json()).not.toHaveProperty("retained");
  });

  it("maps an alternate sign-in collision on edit to 409", async () => {
    const owner = await person({ role: "role-owner" }), target = await person(), intentId = uuid(), created = Date.now() - 10_000;
    const aliasSubject = `access|alias-${owner.id}`;
    await db.batch([
      db.prepare("INSERT INTO staff_login_generations VALUES(?,0)").bind(owner.id),
      db.prepare(`INSERT INTO staff_login_binding_intents(id,staff_id,canonical_email,canonical_subject,issuer,alternate_email,token_sha256,generation,
        created_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?,?,0,?,?)`).bind(intentId, owner.id, owner.email, owner.subject, issuer,
        `alias-${owner.id}@example.test`, intentId.replaceAll("-", "").padStart(64, "0"), created, created + 900_000),
      db.prepare("INSERT INTO staff_login_bindings(id,staff_id,issuer,login_email,access_subject,intent_id,created_at_ms) VALUES(?,?,?,?,?,?,?)")
        .bind(uuid(), owner.id, issuer, `alias-${owner.id}@example.test`, aliasSubject, intentId, created),
    ]);
    // Fixture only: a legacy row whose subject already equals an active alternate sign-in.
    await withoutTriggers("staff_users", "UPDATE", () =>
      db.prepare("UPDATE staff_users SET access_subject=? WHERE id=?").bind(aliasSubject, target.id).run());
    const before = await row(target.id);
    expect((await edit(admin, target.id, { expectedUpdatedAt: before!.updated_at, displayName: "Collides" })).status).toBe(409);
    expect(await row(target.id)).toEqual(before);
  });

  it("roster hides updated_at from non-administrators", async () => {
    const viewer = await person({ allow: ["team.view"] });
    expect((await roster(viewer)).staff.every(entry => entry.updated_at === undefined)).toBe(true);
    expect((await roster(admin)).staff.every(entry => typeof entry.updated_at === "string")).toBe(true);
  });

  // Last: it deactivates every other administrator. Through the route the actor always counts as
  // another active administrator, so the guard SQL is checked directly. It uses exactly the
  // isAdministrator predicate: a local-only role-admin does not count.
  it("last-admin guard: refuses when no other active administrator (staff_role_assignments) remains", async () => {
    const guard = (targetId: string) => db.prepare(`SELECT ${legacyStaffAnotherAdministratorSql} ok`).bind(targetId, targetId).first("ok");
    const last = await person({ role: "role-admin" }), plain = await person();
    const localOnly = await person();
    await db.prepare("INSERT INTO local_staff_role_assignments(id,staff_id,role_id,scope,created_by) VALUES(?,?,'role-admin','global',?)")
      .bind(uuid(), localOnly.id, localOnly.id).run();
    expect(await guard(last.id)).toBe(1);
    await db.prepare(`UPDATE staff_users SET status='inactive' WHERE id<>? AND id IN (SELECT staff_id FROM staff_role_assignments
      WHERE role_id IN ('role-owner','role-admin') AND scope='global')`).bind(last.id).run();
    expect(await guard(last.id)).toBe(0);
    expect(await guard(plain.id)).toBe(1);
  });
});
