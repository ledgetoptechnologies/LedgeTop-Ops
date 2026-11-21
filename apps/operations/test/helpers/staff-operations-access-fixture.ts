// Shared mounted fixture for the native staff Operations-access writer (0244):
// real Operations worker fetch, real RS256 Access assertions from a locally
// generated key, real D1 (Miniflare) with the real migration chain, and hires
// made by the real Ops invitation -> claim -> approval services. Synthetic
// identities and hosts only. The test file must mock ../src/worker/access-jwks
// (to the resolver this fixture publishes) and cloudflare:workers.
import { readFileSync, readdirSync } from "node:fs";
import { expect } from "vitest";
import { Miniflare } from "miniflare";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { splitD1MigrationStatements } from "../../../client/test/helpers/d1-migrations";
import { createNativeStaffOnboarding, revealNativeStaffOnboarding } from "../../src/worker/native-staff-onboarding-create";
import { authenticateNativeStaffOnboardingClaimant, claimNativeStaffOnboarding } from "../../src/worker/native-staff-onboarding-claim";
import { approveNativeStaffOnboarding, readNativeStaffOnboardingReview } from "../../src/worker/native-staff-onboarding-approval";
import { executeOperationsStaffLifecycleCommand } from "../../src/worker/native-staff-management-command";
import type { Env } from "../../src/worker/types";
import worker from "../../src/worker/index";

export const issuer = "https://synthetic-ops-access.cloudflareaccess.com";
export const staffAudience = "synthetic-ops-access-staff", claimantAudience = "synthetic-ops-access-claimant";
export const origin = "https://ops.example.test";
const sessionSecret = "synthetic-ops-access-session-secret-local-fixture-only";
const keyring = { activeKeyId: "fixture", keys: { fixture: "e".repeat(64) } };
export const MIGRATION_0244 = "0244_staff_operations_access_writer.sql";
export type Person = { id: string; email: string; subject: string };
export type AccessEntry = { permission: string; state: string; operation: "grant" | "revoke" | null; editable: boolean; reason: string | null };
export type AccessView = { staffId: string; targetAdmissionVersion: number | null; revision: number; targetEditable: boolean;
  targetReason: string | null; permissions: AccessEntry[]; csrfToken: string; verifiedUntil: string };
export type Totals = { overrides: number; state: number; commands: number; audit: number };

export async function applyMigrations(db: D1Database, include: (name: string) => boolean = () => true) {
  const directory = new URL("../../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/u.test(name) && include(name)).sort())
    await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
}

export class OperationsAccessFixture {
  runtime!: Miniflare; db!: D1Database; signingKey!: CryptoKey; sequence = 0;
  creator!: Person; reviewer!: Person;
  /** Runs once, just before the next database.batch (the write transaction). */
  beforeBatch: (() => Promise<void>) | undefined;
  /** When set, every SQL text prepared through env.OPS_DB (or its sessions) is appended. */
  recorded: string[] | undefined;
  private constructor(private readonly prefix: string) {}

  static async create(sink: { resolver: unknown }, prefix: string, options: { migrate?: boolean } = {}) {
    const fixture = new OperationsAccessFixture(prefix);
    fixture.runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", cf: false,
      script: "export default {fetch(){return new Response('fixture')}}", d1Databases: ["OPS_DB"] });
    fixture.db = await fixture.runtime.getD1Database("OPS_DB") as D1Database;
    if (options.migrate !== false) await applyMigrations(fixture.db);
    const pair = await generateKeyPair("RS256"); fixture.signingKey = pair.privateKey;
    sink.resolver = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: "fixture", alg: "RS256" }] });
    return fixture;
  }
  async seedOnboarders() {
    this.creator = await this.person({ delegations: ["staff.onboarding.create"] });
    this.reviewer = await this.person({ delegations: ["staff.onboarding.approve"] });
  }
  dispose() { return this.runtime?.dispose(); }

  uuid() { return `${this.prefix}-0000-4000-8000-${String(++this.sequence).padStart(12, "0")}`; }
  expires() { return new Date(Date.now() + 600_000).toISOString(); }

  private wrap<T extends object>(target: T): T {
    const fixture = this;
    return new Proxy(target, { get(base, key) {
      if (key === "batch" && fixture.beforeBatch && base === (fixture.db as unknown)) return async (statements: D1PreparedStatement[]) => {
        const hook = fixture.beforeBatch; fixture.beforeBatch = undefined; await hook?.();
        return (base as unknown as D1Database).batch(statements);
      };
      if (key === "prepare" && fixture.recorded) return (sql: string) => {
        fixture.recorded?.push(sql); return (base as unknown as D1Database).prepare(sql);
      };
      if (key === "withSession" && fixture.recorded) return (constraint?: string) =>
        fixture.wrap((base as unknown as D1Database).withSession(constraint as never));
      const value = Reflect.get(base, key, base);
      return typeof value === "function" ? value.bind(base) : value;
    } });
  }
  env(): Env {
    return { OPS_DB: this.wrap(this.db), TEAM_DOMAIN: issuer, OPERATIONS_AUD: staffAudience, ENVIRONMENT: "staging",
      EXPECTED_HOST: new URL(origin).hostname, PUBLIC_BASE_URL: origin, OPERATIONS_ORIGINS: origin,
      OPERATIONS_SESSION_SECRET: sessionSecret, AUDIT_IP_SECRET: "synthetic-ops-access-audit-secret-local-fixture-only" } as unknown as Env;
  }
  fetch(request: Request) {
    return worker.fetch(request, this.env(), { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
  }
  async token(email: string, subject: string, options: { audience?: string; expiresAt?: number } = {}) {
    return new SignJWT({ email, type: "app" }).setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer(issuer).setAudience(options.audience ?? staffAudience).setSubject(subject).setIssuedAt()
      .setExpirationTime(options.expiresAt ?? "10m").sign(this.signingKey);
  }

  /** Directly inserted synthetic staff rows (never an onboarding provenance). */
  async person(options: { role?: "role-admin" | "role-owner"; allow?: string[]; deny?: string[]; native?: boolean;
    local?: boolean; syncProtected?: boolean; delegations?: string[] } = {}): Promise<Person> {
    const id = `ops-access-${this.prefix}-${++this.sequence}`, email = `${id}@example.test`, subject = `access|${id}`;
    const db = this.db;
    const statements = [db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,project_alpha_user_id,sync_protected,provisioning_source)
      VALUES(?,?,?,?,NULL,?,?)`).bind(id, email, `Synthetic ${id}`, subject, options.syncProtected ? 1 : 0, options.local ? "local" : "project-alpha")];
    if (options.role) statements.push(db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES(?,?,?,'global','global')")
      .bind(this.uuid(), id, options.role));
    for (const [effect, list] of [["allow", options.allow ?? []], ["deny", options.deny ?? []]] as const)
      for (const permission of list) statements.push(db.prepare(`INSERT INTO staff_permission_overrides
        (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by) VALUES(?,?,?,?,'global',NULL,'global',?)`)
        .bind(this.uuid(), id, permission, effect, id));
    if (options.native !== false) statements.push(
      db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(id, subject, id),
      db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(id, email, `Synthetic ${id}`));
    for (const capability of options.delegations ?? []) statements.push(db.prepare(`INSERT INTO native_staff_management_delegations
      (id,actor_staff_id,capability,effect,scope_kind,granted_by) VALUES(?,?,?,'allow','global',?)`).bind(`${id}:${capability}`, id, capability, id));
    await db.batch(statements);
    return { id, email, subject };
  }

  private nativeActor(who: Person) {
    return { staffId: who.id, verifiedAccessSubject: who.subject, admissionVersion: 1, profileVersion: 1, email: who.email, verifiedUntil: this.expires() };
  }
  private authenticated(who: Person) {
    return { identity: { kind: "native", staffId: who.id, verifiedAccessSubject: who.subject, email: who.email, displayName: who.id, profileVersion: 1 },
      admissionVersion: 1, verifiedUntil: this.expires() };
  }
  /** A hire created by the real Ops invitation -> claim -> approval flow. */
  async nativeHire(by: { creator: Person; approver: Person } = { creator: this.creator, approver: this.reviewer }): Promise<Person & { onboardingEmail: string; onboardingSubject: string }> {
    const db = this.db;
    const input = { commandId: this.uuid(), loginEmail: `hire-${this.prefix}-${++this.sequence}@example.test`,
      displayName: `Synthetic hire ${this.sequence}`, expiresAt: this.expires(), reason: "Operations access writer fixture" };
    const created = await createNativeStaffOnboarding(db, input, this.authenticated(by.creator) as never, keyring);
    const reveal = await revealNativeStaffOnboarding(db, input.commandId, this.authenticated(by.creator) as never, keyring);
    const subject = `access|hire-${this.prefix}-${++this.sequence}`;
    const verified = await authenticateNativeStaffOnboardingClaimant(new Request("https://claim.example.test/", {
      headers: { "Cf-Access-Jwt-Assertion": await this.token(input.loginEmail, subject, { audience: claimantAudience }) },
    }), { enabled: true, environment: "staging", issuer, staffAudience, claimantAudience });
    await claimNativeStaffOnboarding(db, { onboardingId: created.onboardingId, invitationSecret: reveal.invitationSecret }, verified);
    const review = await readNativeStaffOnboardingReview(db, created.onboardingId, this.nativeActor(by.approver));
    await approveNativeStaffOnboarding(db, { commandId: this.uuid(), onboardingId: created.onboardingId, expectedVersion: 2,
      proposalSha256: review.proposalSha256, claimEvidenceSha256: review.claimEvidenceSha256, reason: "Synthetic approval" },
    this.nativeActor(by.approver));
    expect(await db.prepare("SELECT provisioning_source,sync_protected,project_alpha_user_id FROM staff_users WHERE id=?")
      .bind(created.proposedStaffId).first()).toEqual({ provisioning_source: "local", sync_protected: 1, project_alpha_user_id: null });
    return { id: created.proposedStaffId, email: input.loginEmail, subject, onboardingEmail: input.loginEmail, onboardingSubject: subject };
  }

  async get(actor: Person, targetId: string, token?: string) {
    return this.fetch(new Request(`${origin}/api/staff-operations-access/${encodeURIComponent(targetId)}`, {
      headers: { "Cf-Access-Jwt-Assertion": token ?? await this.token(actor.email, actor.subject) } }));
  }
  async view(actor: Person, targetId: string, token?: string): Promise<AccessView> {
    const response = await this.get(actor, targetId, token);
    expect(response.status, await response.clone().text()).toBe(200);
    return await response.json() as AccessView;
  }
  async post(actor: Person, targetId: string, body: unknown, options: { csrf?: string; origin?: string; token?: string } = {}) {
    const token = options.token ?? await this.token(actor.email, actor.subject);
    const csrf = options.csrf ?? (await this.view(actor, targetId, token)).csrfToken;
    return this.fetch(new Request(`${origin}/api/staff-operations-access/${encodeURIComponent(targetId)}`, { method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "Cf-Access-Jwt-Assertion": token, Origin: options.origin ?? origin, "Content-Type": "application/json", "X-CSRF-Token": csrf } }));
  }
  /** A command built from a fresh GET (current revision and admission version). */
  async command(actor: Person, targetId: string, permission: string, operation?: "grant" | "revoke", token?: string) {
    const view = await this.view(actor, targetId, token);
    const entry = view.permissions.find(item => item.permission === permission);
    return { view, entry, body: { commandId: crypto.randomUUID(), permission, operation: operation ?? entry?.operation ?? "grant",
      expectedRevision: view.revision, expectedAdmissionVersion: view.targetAdmissionVersion ?? 1, reason: "Synthetic Operations access change" } };
  }
  async change(actor: Person, targetId: string, permission: string, operation?: "grant" | "revoke", token?: string) {
    const { view, body } = await this.command(actor, targetId, permission, operation, token);
    return { body, response: await this.post(actor, targetId, body, { csrf: view.csrfToken, token }) };
  }

  async totals(): Promise<Totals> {
    return await this.db.prepare(`SELECT (SELECT count(*) FROM staff_permission_overrides) overrides,
      (SELECT count(*) FROM staff_operations_access_state) state, (SELECT count(*) FROM staff_operations_access_commands) commands,
      (SELECT count(*) FROM audit_events) audit`).first<Totals>() as Totals;
  }
  /** Runs a refused request and proves override, state, command and audit counts are unchanged. */
  async refused(run: () => Promise<Response>, status: number, error?: string, reason?: string) {
    const before = await this.totals();
    const response = await run();
    const text = await response.text();
    expect(response.status, text).toBe(status);
    if (error) expect(JSON.parse(text)).toMatchObject({ error, ...(reason ? { reason } : {}) });
    expect(await this.totals()).toEqual(before);
    return text;
  }
  overrideRow(staffId: string, permission: string) {
    return this.db.prepare("SELECT id,effect,scope,created_by FROM staff_permission_overrides WHERE staff_id=? AND permission_key=?")
      .bind(staffId, permission).all();
  }
  /** Test-only: insert rows the guard would refuse (simulates historical/manual rows that predate 0244). */
  async withoutInsertGuard(run: () => Promise<unknown>) {
    const sql = await this.db.prepare("SELECT sql FROM sqlite_schema WHERE name='staff_operations_access_override_insert_guard'").first<string>("sql");
    await this.db.prepare("DROP TRIGGER staff_operations_access_override_insert_guard").run();
    try { await run(); } finally { await this.db.prepare(sql!).run(); }
  }

  /** Synthetic lifecycle control plane (as in the 0243 tests) and the 0225 bridge switch for this in-memory DB. */
  async lifecycleManager() {
    const manager = await this.person({});
    const actions = ["staff.onboarding.create", "staff.onboarding.approve", "staff.admission.disable",
      "staff.membership.manage", "staff.directory_grant.manage", "staff.admin_delegation.manage"];
    const directory = ["directory.profile.view", "directory.profile.edit", "directory.identity.link",
      "directory.enrollment.manage", "directory.portal_access.manage"];
    const db = this.db;
    await db.batch([...actions, "staff.admission.enable", "staff.profile.edit", "staff.profile.read"].map(capability =>
      db.prepare("INSERT INTO native_staff_management_delegations(id,actor_staff_id,capability,effect,scope_kind,granted_by) VALUES(?,?,?,'allow','global',?)")
        .bind(`${manager.id}:${capability}`, manager.id, capability, manager.id)));
    await db.batch([
      ...directory.map(capability => db.prepare(`INSERT INTO native_staff_delegation_ceilings
        (id,parent_delegation_id,authority_domain,capability,effect,grant_allow,grant_deny,operation_create,operation_revoke,scope_kind)
        VALUES(?,?,'directory',?,'allow',1,1,1,1,'global')`).bind(`${manager.id}:directory:${capability}`, `${manager.id}:staff.directory_grant.manage`, capability)),
      ...actions.map(capability => db.prepare(`INSERT INTO native_staff_delegation_ceilings
        (id,parent_delegation_id,authority_domain,capability,effect,grant_allow,grant_deny,operation_create,operation_revoke,scope_kind)
        VALUES(?,?,'staff_admin',?,'allow',1,1,1,1,'global')`).bind(`${manager.id}:admin:${capability}`, `${manager.id}:staff.admin_delegation.manage`, capability)),
    ]);
    return {
      manager,
      run: (capability: "staff.admission.disable" | "staff.admission.enable", targetId: string, expectedVersion: number) =>
        executeOperationsStaffLifecycleCommand(db, { commandId: crypto.randomUUID(), contractVersion: 1, capability,
          actor: { staffId: manager.id, verifiedAccessSubject: manager.subject }, targetStaffId: targetId, expectedVersion,
          reason: "Synthetic lifecycle change" }, { admissionVersion: 1, profileVersion: 1, verifiedUntil: this.expires() }),
    };
  }
}
