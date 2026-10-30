import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { Miniflare } from "miniflare";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { readNativeStaffBootstrapSnapshot } from "../../../scripts/native-staff-bootstrap-d1.mjs";
import { validateLiveOwnerReview } from "../../../scripts/native-staff-bootstrap-owner-approval.mjs";
import { registerNativeStaffCohortReviewRoute, NATIVE_STAFF_COHORT_REVIEW_PATH } from "../src/worker/staff-login-link-routes";
import { csrfToken } from "../src/worker/request-security";
import type { Env, StaffPrincipal } from "../src/worker/types";

const issuer = "https://synthetic-cohort-review.cloudflareaccess.com";
const audience = "synthetic-cohort-review-audience";
const origin = "https://ops.example.test";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const owner: StaffPrincipal = { id: "review-primary-owner", email: "review-primary-owner@example.test",
  displayName: "Synthetic Review Owner", accessSubject: "access|review-primary-owner", projectAlphaUserId: null };
const nonOwner: StaffPrincipal = { id: "review-non-owner", email: "review-non-owner@example.test",
  displayName: "Synthetic Non Owner", accessSubject: "access|review-non-owner", projectAlphaUserId: null };
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

let runtime: Miniflare;
let db: D1Database;
let mountedEnv: Env;
let signingKey: CryptoKey;
let jwksFetchCount = 0;
let bridge: { fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> };

async function accessToken(person: StaffPrincipal, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: person.email, type: "app", ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "synthetic-cohort-review-key" })
    .setIssuer(issuer).setAudience(audience).setSubject(person.accessSubject)
    .setIssuedAt(now).setExpirationTime(now + 600).sign(signingKey);
}

function request(assertion: string, options: { body?: string; origin?: string; csrf?: string; url?: string } = {}) {
  return new Request(options.url ?? `${origin}${NATIVE_STAFF_COHORT_REVIEW_PATH}`, { method: "POST", headers: {
    "Cf-Access-Jwt-Assertion": assertion,
    Origin: options.origin ?? origin,
    "Sec-Fetch-Site": "same-origin",
    "Content-Type": "application/json",
    "X-CSRF-Token": options.csrf ?? "",
  }, body: options.body ?? "{}" });
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

async function databaseDigest(): Promise<string> {
  const objects = (await db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','view','trigger','index') ORDER BY type,name")
    .all<{ type: string; name: string; sql: string | null }>()).results;
  const tables = objects.filter(item => item.type === "table" && !item.name.startsWith("_cf_")
    && !item.name.startsWith("sqlite_")).map(item => item.name).sort();
  const rows: Array<{ name: string; rows: unknown[] }> = [];
  for (const name of tables) {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const values = (await db.prepare(`SELECT * FROM ${quoted}`).all()).results as unknown[];
    rows.push({ name, rows: values.map(value => JSON.parse(canonical(value))).sort((a, b) => canonical(a).localeCompare(canonical(b))) });
  }
  return sha256(canonical({ objects, rows }));
}

async function send(input: Request, database: D1Database = db) {
  const env = database === db ? mountedEnv : { ...mountedEnv, OPS_DB: database } as Env;
  return bridge.fetch(input, env, ctx);
}

describe("primary owner cohort review bridge against synthetic Operations schema through migration 0225", () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", cf: false,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    await db.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
    const directory = new URL("../migrations/", import.meta.url);
    const migrations = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/u.test(name) && Number(name.slice(0, 4)) <= 225).sort();
    expect(migrations).toHaveLength(225);
    expect(migrations.at(-1)).toBe("0225_native_staff_lifecycle_bridge.sql");
    for (const name of migrations) {
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
      await db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name).run();
    }
    const post0225 = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('staff_login_bindings','staff_login_binding_intents','staff_login_generations')").all()).results;
    expect(post0225).toEqual([]);

    await db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status)
      VALUES(?,?,?,?, 'active'),(?,?,?,?,'active')`)
      .bind(owner.id, owner.email, owner.displayName, owner.accessSubject,
        nonOwner.id, nonOwner.email, nonOwner.displayName, nonOwner.accessSubject).run();
    await db.batch([
      db.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by)
        VALUES('synthetic-global-owner-role',?,'role-owner','global',NULL,'global',?)`).bind(owner.id, owner.id),
      db.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
        VALUES(?,?,1,?)`).bind(owner.id, owner.accessSubject, owner.id),
      db.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name)
        VALUES(?,?,?)`).bind(owner.id, owner.email, owner.displayName),
      db.prepare("UPDATE staff_users SET access_subject=? WHERE id=?").bind(nonOwner.accessSubject, nonOwner.id),
    ]);

    const pair = await generateKeyPair("RS256");
    signingKey = pair.privateKey;
    const jwk = { ...await exportJWK(pair.publicKey), kid: "synthetic-cohort-review-key", alg: "RS256", use: "sig" };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.href !== `${issuer}/cdn-cgi/access/certs`) throw new Error("synthetic_jwks_transport_unexpected_url");
      jwksFetchCount += 1;
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: {
        "Content-Type": "application/json", "Cache-Control": "public, max-age=60",
      } });
    });

    const reviewApp = new Hono();
    registerNativeStaffCohortReviewRoute(reviewApp as never);
    const retained = Object.freeze({
      fetch: () => new Response("retained-handler", { status: 207 }),
      queue: () => "retained-queue",
      scheduled: () => "retained-scheduled",
    });
    const bridgeModuleUrl = new URL("../../../scripts/native-staff-cohort-review-bridge.mjs", import.meta.url).href;
    const { createNativeStaffCohortReviewBridge } = await import(bridgeModuleUrl);
    bridge = createNativeStaffCohortReviewBridge(retained, reviewApp as never);
    mountedEnv = { OPS_DB: db, TEAM_DOMAIN: issuer, OPERATIONS_AUD: audience, ENVIRONMENT: "staging",
      EXPECTED_HOST: new URL(origin).hostname, PUBLIC_BASE_URL: origin, OPERATIONS_ORIGINS: origin,
      OPERATIONS_SESSION_SECRET: "synthetic-cohort-review-session-secret-for-tests-only" } as Env;
  }, 300_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await runtime?.dispose();
  });

  it("serves the exact primary global owner review and passes the current issuer validator without writes", async () => {
    const snapshot = await readNativeStaffBootstrapSnapshot(db, []);
    expect(snapshot.migrationNames).toHaveLength(225);
    expect(snapshot.migrationNames.at(-1)).toBe("0225_native_staff_lifecycle_bridge.sql");
    const before = await databaseDigest();
    const ownerIdentityBefore = await db.prepare("SELECT id,email,access_subject,last_seen_at,status FROM staff_users WHERE id=?")
      .bind(owner.id).first();
    const auth = await accessToken(owner);
    const csrf = await csrfToken(mountedEnv, owner);
    const response = await send(request(auth, { csrf }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    const review = await response.json() as { packet: Record<string, any>; packetSha256: string };
    expect(review.packet).toMatchObject({ kind: "operations-current-staff-cohort-review-draft-v1", status: "draft",
      advisory: true, executionAuthority: false, bootstrapApproval: false, acceptedReceipt: false,
      installerClaim: false, ownerStaffId: owner.id });
    expect(review.packet.cohort).toContainEqual(expect.objectContaining({ staffId: owner.id,
      status: "active", accessSubject: owner.accessSubject, bridgeStatus: "matched",
      admission: expect.objectContaining({ active: 1, bound_access_subject: owner.accessSubject }),
      profile: expect.objectContaining({ login_email: owner.email, display_name: owner.displayName }) }));
    expect(review.packet.tables.staff_role_assignments).toContainEqual(expect.objectContaining({ staff_id: owner.id,
      role_id: "role-owner", scope: "global" }));
    const proof = validateLiveOwnerReview(review, snapshot,
      { access: { owner: { staffId: owner.id, accessSubject: owner.accessSubject } } }, { staffId: owner.id });
    expect(proof).toMatchObject({ liveStaffCount: snapshot.currentStaffCount, liveCohortPacketSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(jwksFetchCount).toBeGreaterThan(0);
    expect(await databaseDigest()).toBe(before);
    expect(await db.prepare("SELECT id,email,access_subject,last_seen_at,status FROM staff_users WHERE id=?")
      .bind(owner.id).first()).toEqual(ownerIdentityBefore);
  }, 60_000);

  it("rejects nonowners, alternate and service identities, wrong origins, CSRF failures, and invalid bodies without writes", async () => {
    const before = await databaseDigest();
    const nonOwnerToken = await accessToken(nonOwner);
    expect((await send(request(nonOwnerToken, { csrf: await csrfToken(mountedEnv, nonOwner) }))).status).toBe(403);
    const alternate = await new SignJWT({ email: owner.email, type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: "synthetic-cohort-review-key" }).setIssuer(issuer).setAudience(audience)
      .setSubject("access|alternate-unbound-subject").setIssuedAt().setExpirationTime("10m").sign(signingKey);
    expect((await send(request(alternate, { csrf: await csrfToken(mountedEnv, owner) }))).status).toBe(403);
    const serviceToken = await accessToken(owner, { common_name: "synthetic-service-token", service_token_status: true, service_token_id: "synthetic-service-id" });
    expect((await send(request(serviceToken, { csrf: await csrfToken(mountedEnv, owner) }))).status).toBe(401);
    expect((await send(request(await accessToken(owner), { csrf: await csrfToken(mountedEnv, owner), origin: "https://attacker.example.test" }))).status).toBe(403);
    expect((await send(request(await accessToken(owner), { csrf: "invalid-csrf" }))).status).toBe(403);
    expect((await send(request(await accessToken(owner), { csrf: await csrfToken(mountedEnv, owner), body: JSON.stringify({ staffId: nonOwner.id }) }))).status).toBe(400);
    expect((await send(request(await accessToken(owner), { csrf: await csrfToken(mountedEnv, owner), body: "{" }))).status).toBe(400);
    expect(await databaseDigest()).toBe(before);
  }, 60_000);

  it("fails closed when the exact 225-schema snapshot drifts between its two read passes", async () => {
    const ownerToken = await accessToken(owner);
    const csrf = await csrfToken(mountedEnv, owner);
    const originalBatch = db.batch.bind(db);
    let injected = false;
    const changingDb = new Proxy(db, { get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        const result = await originalBatch(statements);
        if (!injected) {
          injected = true;
          await db.prepare(`INSERT INTO staff_permission_overrides
            (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
            VALUES('cohort-review-drift',?,'operations.view','deny','global',NULL,'global',?)`)
            .bind(owner.id, owner.id).run();
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as D1Database;
    const response = await send(request(ownerToken, { csrf }), changingDb);
    expect(injected).toBe(true);
    expect(response.status).toBe(409);
    expect(await db.prepare("SELECT count(*) n FROM staff_permission_overrides WHERE id='cohort-review-drift'").first<number>("n")).toBe(1);
    await db.prepare("DELETE FROM staff_permission_overrides WHERE id='cohort-review-drift'").run();
  }, 60_000);

  it("delegates unrelated paths to the retained Worker", async () => {
    const response = await bridge.fetch(new Request(`${origin}/health`), mountedEnv, ctx);
    expect(response.status).toBe(207);
    expect(await response.text()).toBe("retained-handler");
  });
});
