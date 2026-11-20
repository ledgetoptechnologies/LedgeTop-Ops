// Fail-closed activation of the native staff Operations-access writer (R2.7,
// N17, N18) and its review-default policy checks. Real mounted worker, real
// RS256 Access assertions, real D1 migration chain; hires made by the real
// invitation -> claim -> approval flow. Synthetic identities and hosts only.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyMigrations, MIGRATION_0244, OperationsAccessFixture, origin, type Person } from "./helpers/staff-operations-access-fixture";
import { STAFF_OPERATIONS_ACCESS_SCHEMA_OBJECTS, STAFF_OPERATIONS_ACCESS_SCHEMA_SHA256, staffOperationsAccessSchemaDigest } from "../src/worker/staff-operations-access";
import { STAFF_OPERATIONS_ACCESS_CATALOG } from "../src/worker/staff-operations-access-policy";
import { STAFF_ACCESS_CONTROLS } from "../src/worker/staff-access-controls";
import { csrfToken } from "../src/worker/request-security";
import type { StaffPrincipal } from "../src/worker/types";

const keys = vi.hoisted(() => ({ resolver: undefined as unknown }));
vi.mock("../src/worker/access-jwks", () => ({ accessJwksResolver: () => keys.resolver }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));

type SchemaRow = { type: string; name: string; tbl_name: string; sql: string };
const PROBE = `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN (${STAFF_OPERATIONS_ACCESS_SCHEMA_OBJECTS.map(() => "?").join(",")})`;

async function safeTotals(f: OperationsAccessFixture) {
  const tables = new Set((await f.db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all<{ name: string }>()).results.map(row => row.name));
  const count = async (table: string) => tables.has(table) ? await f.db.prepare(`SELECT count(*) n FROM ${table}`).first<number>("n") : null;
  return { overrides: await count("staff_permission_overrides"), audit: await count("audit_events"),
    commands: await count("staff_operations_access_commands"), state: await count("staff_operations_access_state") };
}
/** GET and POST both answer `status` before any authentication, authorization or data read, and nothing is written. */
async function expectClosed(f: OperationsAccessFixture, actor: Person, targetId: string, status: 404 | 503, error: string) {
  const before = await safeTotals(f);
  const csrf = await csrfToken(f.env(), { accessSubject: actor.subject } as StaffPrincipal);
  const body = { commandId: crypto.randomUUID(), permission: "team.view", operation: "grant", expectedRevision: 0, expectedAdmissionVersion: 1, reason: "Closed" };
  f.recorded = [];
  try {
    for (const response of [await f.get(actor, targetId), await f.post(actor, targetId, body, { csrf }),
      await f.fetch(new Request(`${origin}/api/staff-operations-access/${targetId}`))]) {
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
    }
    expect(f.recorded.length).toBeGreaterThan(0);
    for (const text of f.recorded) expect(text, text).toMatch(/^SELECT (?:type,name,tbl_name,sql FROM sqlite_schema|permission,requires_explicit_actor_allow FROM staff_operations_access_catalog)/);
  } finally { f.recorded = undefined; }
  expect(await safeTotals(f)).toEqual(before);
}

describe("0244 absent, then applied to a populated database (N17, N18)", { timeout: 180_000 }, () => {
  let f: OperationsAccessFixture;
  beforeAll(async () => {
    f = await OperationsAccessFixture.create(keys, "b2000000", { migrate: false });
    await applyMigrations(f.db, name => name !== MIGRATION_0244);
    await f.seedOnboarders();
  }, 300_000);
  afterAll(async () => f?.dispose());

  it("N17: with 0244 absent the route is 404 before any auth read; N18: 0244 applies to a populated database and serves", async () => {
    const actor = await f.person({ role: "role-admin" }), hire = await f.nativeHire(), ordinary = await f.person({ native: false });
    // Pre-0244 history: a manual allow on the hire and ordinary legacy rows.
    for (const [staffId, permission] of [[hire.id, "sops.assign"], [ordinary.id, "team.view"]] as const)
      await f.db.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
        VALUES(?,?,?,'allow','global',NULL,'global',?)`).bind(f.uuid(), staffId, permission, actor.id).run();
    await expectClosed(f, actor, hire.id, 404, "staff_operations_access_not_found");
    const directory = new URL("../migrations/", import.meta.url);
    const { splitD1MigrationStatements } = await import("../../client/test/helpers/d1-migrations");
    await f.db.batch(splitD1MigrationStatements(readFileSync(new URL(MIGRATION_0244, directory), "utf8")).map(text => f.db.prepare(text)));
    expect((await f.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    const view = await f.view(actor, hire.id);
    expect(view).toMatchObject({ targetEditable: true, revision: 0, targetAdmissionVersion: 1 });
    expect(view.permissions.find(entry => entry.permission === "sops.assign")).toMatchObject({ state: "allow", editable: false, reason: "not_command_managed" });
    // A historical row is never deleted by the writer, nor directly.
    const revoke = await f.command(actor, hire.id, "sops.assign", "revoke");
    await f.refused(() => f.post(actor, hire.id, revoke.body, { csrf: revoke.view.csrfToken }), 409, "not_command_managed");
    await expect(f.db.prepare("DELETE FROM staff_permission_overrides WHERE staff_id=?").bind(hire.id).run())
      .rejects.toThrow(/staff_operations_access_override_requires_command/);
    expect((await f.change(actor, hire.id, "team.view")).response.status).toBe(200);
    // Legacy rows of ordinary staff are untouched by the guard.
    await f.db.prepare("DELETE FROM staff_permission_overrides WHERE staff_id=?").bind(ordinary.id).run();
  });
});

describe("0244 partial or altered fails closed; complete serves (R2.7)", { timeout: 300_000 }, () => {
  let f: OperationsAccessFixture, actor: Person, hire: Person, captured: SchemaRow[], catalogRows: Array<{ permission: string; requires_explicit_actor_allow: number }>;
  beforeAll(async () => {
    f = await OperationsAccessFixture.create(keys, "c3000000");
    await f.seedOnboarders();
    actor = await f.person({ role: "role-admin" }); hire = await f.nativeHire();
    captured = (await f.db.prepare(`${PROBE} ORDER BY rowid`).bind(...STAFF_OPERATIONS_ACCESS_SCHEMA_OBJECTS).all<SchemaRow>()).results;
    catalogRows = (await f.db.prepare("SELECT permission,requires_explicit_actor_allow FROM staff_operations_access_catalog ORDER BY rowid").all<{ permission: string; requires_explicit_actor_allow: number }>()).results;
  }, 300_000);
  afterAll(async () => f?.dispose());

  async function restore() {
    const present = new Set((await f.db.prepare(PROBE).bind(...STAFF_OPERATIONS_ACCESS_SCHEMA_OBJECTS).all<SchemaRow>()).results.map(row => row.name));
    for (const object of captured) {
      if (present.has(object.name)) continue;
      await f.db.prepare(object.sql).run();
      if (object.name === "staff_operations_access_catalog")
        await f.db.batch(catalogRows.map(row => f.db.prepare("INSERT INTO staff_operations_access_catalog VALUES(?,?)").bind(row.permission, row.requires_explicit_actor_allow)));
    }
  }
  const drop = (object: SchemaRow) => f.db.prepare(`DROP ${object.type.toUpperCase()} ${object.name}`).run();
  function altered(object: SchemaRow): string {
    if (object.type === "trigger") return object.sql.replace(/RAISE\(ABORT,'/, "RAISE(ABORT,'altered_");
    if (object.type === "view") return object.sql.replace(/SELECT /, "SELECT DISTINCT ");
    if (object.type === "index") return object.sql.replace(/\(override_id,result_revision\)/, "(override_id)");
    return object.sql.replace(/\)\s*$/, ",altered_for_test INTEGER)");
  }

  it("the installed objects and catalog rows match the reviewed digest", async () => {
    expect(captured.map(row => row.name).sort()).toEqual([...STAFF_OPERATIONS_ACCESS_SCHEMA_OBJECTS].sort());
    const digest = await staffOperationsAccessSchemaDigest(
      [...captured].sort((a, b) => a.name < b.name ? -1 : 1), [...catalogRows].sort((a, b) => a.permission < b.permission ? -1 : 1));
    expect(digest).toBe(STAFF_OPERATIONS_ACCESS_SCHEMA_SHA256);
    expect((await f.get(actor, hire.id)).status).toBe(200);
  });

  it("each 0244 object dropped in turn → 503 schema_incomplete before any auth read, with no write", async () => {
    for (const object of captured) {
      await drop(object);
      await expectClosed(f, actor, hire.id, 503, "schema_incomplete");
      await restore();
      expect((await f.get(actor, hire.id)).status, object.name).toBe(200);
    }
  });

  it("each 0244 object altered in turn, and an altered catalog row → 503 schema_incomplete with no write; complete serves", async () => {
    for (const object of captured) {
      const text = altered(object);
      expect(text, object.name).not.toBe(object.sql);
      await drop(object);
      await f.db.prepare(text).run();
      if (object.name === "staff_operations_access_catalog")
        await f.db.batch(catalogRows.map(row => f.db.prepare("INSERT INTO staff_operations_access_catalog(permission,requires_explicit_actor_allow) VALUES(?,?)").bind(row.permission, row.requires_explicit_actor_allow)));
      await expectClosed(f, actor, hire.id, 503, "schema_incomplete");
      await drop(object);
      await restore();
      expect((await f.get(actor, hire.id)).status, object.name).toBe(200);
    }
    await f.db.prepare("DROP TRIGGER staff_operations_access_catalog_no_update").run();
    await f.db.prepare("UPDATE staff_operations_access_catalog SET requires_explicit_actor_allow=0 WHERE permission='operations.view_all'").run();
    await expectClosed(f, actor, hire.id, 503, "schema_incomplete");
    await f.db.prepare("UPDATE staff_operations_access_catalog SET requires_explicit_actor_allow=1 WHERE permission='operations.view_all'").run();
    await restore();
    const served = await f.change(actor, hire.id, "team.view");
    expect(served.response.status).toBe(200);
  });

  it("REVIEW DEFAULTS: the installed catalog equals the TS policy and STAFF_ACCESS_CONTROLS minus viewer.storage.purge", async () => {
    const installed = catalogRows.map(row => ({ permission: row.permission, requiresExplicitActorAllow: row.requires_explicit_actor_allow === 1 }));
    expect(installed).toEqual(STAFF_OPERATIONS_ACCESS_CATALOG.map(row => ({ ...row })));
    expect(catalogRows.map(row => row.permission).sort()).toEqual(
      Object.values(STAFF_ACCESS_CONTROLS).flat().filter(permission => permission !== "viewer.storage.purge").sort());
    for (const never of ["roles.manage", "viewer.storage.purge", "administration.manage"])
      expect(catalogRows.some(row => row.permission === never)).toBe(false);
  });
});

describe("explicit-local keys (R2.1 e)", () => {
  it("every hasLocalGlobalAllow / prepareAclLocalGlobalAllowRead key in src is flagged requires_explicit_actor_allow", () => {
    const root = new URL("../src/", import.meta.url);
    const files: string[] = [];
    const walk = (directory: URL) => {
      for (const name of readdirSync(directory)) {
        const url = new URL(name, directory);
        if (statSync(url).isDirectory()) walk(new URL(`${name}/`, directory));
        else if (/\.tsx?$/.test(name)) files.push(url.pathname);
      }
    };
    walk(root);
    const found = new Map<string, string[]>();
    for (const file of files) {
      const source = readFileSync(new URL(`file://${file}`), "utf8");
      for (const match of source.matchAll(/\b(hasLocalGlobalAllow|prepareAclLocalGlobalAllowRead)\s*\(/g)) {
        let depth = 1, index = match.index! + match[0].length; const start = index;
        while (depth > 0 && index < source.length) { const char = source[index++]; if (char === "(") depth++; else if (char === ")") depth--; }
        const args = source.slice(start, index - 1);
        const last = args.split(",").at(-1)!.trim();
        if (/^export\b|function\s*$/.test(source.slice(Math.max(0, match.index! - 16), match.index!).trim()) || /:\s*Permission\b/.test(args)) continue; // definitions
        if (file.endsWith("/worker/acl.ts") && last === "permission") continue; // acl.ts wrapper forwards its own argument
        const literal = /^["'`]([a-z_.]+)["'`]$/.exec(last);
        expect(literal, `${file}: non-literal permission ${last}`).not.toBeNull();
        found.set(literal![1]!, [...found.get(literal![1]!) ?? [], file]);
      }
    }
    expect(found.size).toBeGreaterThan(0);
    expect([...found.values()].flat().length).toBeGreaterThanOrEqual(7);
    for (const permission of found.keys()) {
      const row = STAFF_OPERATIONS_ACCESS_CATALOG.find(entry => entry.permission === permission);
      // Not grantable at all is safe; grantable must be explicit-only.
      if (row) expect(row.requiresExplicitActorAllow, permission).toBe(true);
    }
    expect(found.has("operations.view_all")).toBe(true);
  });
});
