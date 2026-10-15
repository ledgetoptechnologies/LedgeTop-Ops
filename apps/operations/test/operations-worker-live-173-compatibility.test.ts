import crypto from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

const mocks = vi.hoisted(() => ({ authenticateStaff: vi.fn() }));
vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {},
  WorkerEntrypoint: class {},
  DurableObject: class {},
}));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: mocks.authenticateStaff }));

import worker from "../src/worker/index";
import { NATIVE_DIRECTORY_PROFILE_ROUTE } from "../src/worker/native-directory-profile-routes";
import type { Env, StaffPrincipal } from "../src/worker/types";

const principal: StaffPrincipal = {
  id: "live-173-owner",
  email: "live-173-owner@example.test",
  displayName: "Live 173 Owner",
  accessSubject: "access|live-173-owner",
  projectAlphaUserId: null,
};
const execution = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const migrationHash = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");

describe("candidate Operations Worker compatibility with the exact live-0173 schema", { timeout: 180_000 }, () => {
  let runtime: Miniflare;
  let database: D1Database;
  let env: Env;

  beforeAll(async () => {
    runtime = new Miniflare({
      modules: true,
      compatibilityDate: "2026-08-06",
      script: "export default {fetch(){return new Response('schema-host')}}",
      d1Databases: ["OPS_DB"],
    });
    database = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    const names = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort().slice(0, 173);
    expect(names.at(-1)).toBe("0173_operations_directory_intent_acquired_destination_transition.sql");
    expect(migrationHash(names.join("\n"))).toBe("46d20b48362be8052f5b2fd35ec4ccefee2c267476a2a076af87a955c4cfca3a");
    expect(migrationHash(names.map(name => `${name}\0${migrationHash(readFileSync(new URL(name, directory)))}`).join("\n")))
      .toBe("cd35de12e87325fb6de854f4ecba47e5172e115f75830af9f4a908710d10a450");
    for (const name of names) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"));
      await database.batch(statements.map(statement => database.prepare(statement)));
    }
    expect(await database.prepare(`SELECT name FROM sqlite_schema
      WHERE type='table' AND name='project_alpha_project_inbound_proposals'`).first()).toBeNull();
    await database.batch([
      database.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status)
        VALUES(?,?,?,?, 'active')`).bind(principal.id, principal.email, principal.displayName, principal.accessSubject),
      database.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by)
        VALUES('live-173-owner-role',?,'role-owner','global',NULL,'global',?)`).bind(principal.id, principal.id),
    ]);
    env = {
      OPS_DB: database,
      ENVIRONMENT: "staging",
      EXPECTED_HOST: "ops-staging.example.test",
      INCOMING_EXPECTED_HOST: "incoming-staging.example.test",
      PUBLIC_BASE_URL: "https://ops-staging.example.test",
      OPERATIONS_SESSION_SECRET: "live-173-session-secret-at-least-32-characters",
      AUDIT_IP_SECRET: "live-173-audit-secret-at-least-32-characters",
      APPLICATION_KEY: "ltt_ops",
      NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED: "false",
    } as unknown as Env;
    mocks.authenticateStaff.mockResolvedValue(principal);
  });

  afterAll(async () => { await runtime?.dispose(); });

  it("serves health and an authenticated legacy read before the 0174-0180 suffix", async () => {
    const health = await worker.fetch(new Request("https://ops-staging.example.test/health"), env, execution);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok", service: "ltds-ops" });

    const roles = await worker.fetch(new Request("https://ops-staging.example.test/api/admin/roles"), env, execution);
    expect(roles.status).toBe(200);
    const payload = await roles.json() as { roles: Array<{ id: string }>; permissions: Array<{ key: string }> };
    expect(payload.roles.some(role => role.id === "role-owner")).toBe(true);
    expect(payload.permissions.some(permission => permission.key === "roles.manage")).toBe(true);
  });

  it("keeps the new Directory mutation surface default-off without touching suffix tables", async () => {
    const authenticatedBefore = mocks.authenticateStaff.mock.calls.length;
    const response = await worker.fetch(new Request(`https://ops-staging.example.test${NATIVE_DIRECTORY_PROFILE_ROUTE}/organizations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }), env, execution);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(mocks.authenticateStaff).toHaveBeenCalledTimes(authenticatedBefore);
    expect(await database.prepare(`SELECT name FROM sqlite_schema
      WHERE type='table' AND name='project_alpha_project_inbound_proposals'`).first()).toBeNull();
  });
});
