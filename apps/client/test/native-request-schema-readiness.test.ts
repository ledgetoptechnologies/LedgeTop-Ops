import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  nativeRequestSchemaReady,
  nativeServiceRequestsEnabled,
} from "../src/worker/client-portal/native-request-authority";
import type { Env } from "../src/worker/types";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

describe("native request migration readiness", () => {
  let runtime: Miniflare;

  beforeAll(() => {
    runtime = new Miniflare({
      compatibilityDate: "2026-08-06",
      modules: true,
      script: "export default {fetch(){return new Response('ok')}}",
      d1Databases: { DELIVERY_DB: "native-request-schema-readiness" },
    });
  });

  afterAll(async () => runtime.dispose());

  it("keeps enablement unavailable through expand, then observes the exact 0185 contract after the bounded cache expires", async () => {
    const db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    const migrations = readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort();
    for (const name of migrations.filter(name => name < "0185")) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"));
      if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
    }
    const env = {
      DELIVERY_DB: db,
      CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED: "true",
      CLIENT_PORTAL_REQUEST_V2_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
    } as Env;

    expect(nativeServiceRequestsEnabled(env)).toBe(true);
    expect(await nativeRequestSchemaReady(env, { now: 1_000 })).toBe(false);

    const migration = splitD1MigrationStatements(readFileSync(new URL("0185_native_service_request_ownership.sql", directory), "utf8"));
    await db.batch(migration.map(sql => db.prepare(sql)));
    expect(await nativeRequestSchemaReady(env, { now: 1_001 }), "cached pre-expand result").toBe(false);
    expect(await nativeRequestSchemaReady(env, { now: 31_001 }), "post-expand contract").toBe(true);

    await db.prepare("DROP TRIGGER portal_native_request_attachment_ticket_owner_update").run();
    expect(await nativeRequestSchemaReady(env, { refresh: true, now: 31_002 }), "missing contract trigger").toBe(false);
  }, 60_000);
});
