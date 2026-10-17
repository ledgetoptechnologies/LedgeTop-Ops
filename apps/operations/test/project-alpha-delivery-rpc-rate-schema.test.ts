import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { HTTPException } from "hono/http-exception";
import { createCatalogSourceContext } from "@ltds/shared";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import { applyProjectAlphaDeliveryRpcBudget } from "../src/worker/project-alpha-delivery-intents";
import type { Env } from "../src/worker/types";

const primary = createCatalogSourceContext("project-alpha:primary");
const secondary = createCatalogSourceContext("project-alpha:secondary");
const ordinaryTable = "project_alpha_delivery_intent_rate_limits";
const sourceTable = "project_alpha_delivery_intent_source_rate_limits";
// Freeze only the SQL limiter window; all actual schema, UPSERT and quota guards remain real.
function fixedRateWindow(database: D1Database): D1Database {
  return new Proxy(database, { get(target, property) {
    if (property === "prepare") return (sql: string) => target.prepare(
      sql.includes(ordinaryTable) || sql.includes(sourceTable)
        ? sql.replaceAll("strftime('%Y-%m-%dT%H:%M:00Z','now')", "'2026-10-17T08:00:00Z'") : sql);
    const value = target[property as keyof D1Database];
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
let runtime: Miniflare, database: D1Database, legacyDatabase: D1Database;
const env = () => ({ OPS_DB: database }) as Env;
async function migration(db: D1Database, name: string) {
  for (const sql of splitD1MigrationStatements(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"))) {
    await db.prepare(sql).run();
  }
}
async function rows(table: string) {
  return (await database.prepare(`SELECT * FROM ${table} ORDER BY scope`).all()).results;
}
async function seed(sourceId: string, scope: string, count: number) {
  const legacy = sourceId === primary.sourceId && (scope === "preflight" || scope === "intent");
  await database.prepare(legacy
    ? `INSERT INTO ${ordinaryTable}(scope,window_start,request_count) VALUES(?,strftime('%Y-%m-%dT%H:%M:00Z','now'),?)`
    : `INSERT INTO ${sourceTable}(source_id,scope,window_start,request_count) VALUES(?,?,strftime('%Y-%m-%dT%H:%M:00Z','now'),?)`)
    .bind(...(legacy ? [scope, count] : [sourceId, scope, count])).run();
}
async function rateLimited(fn: () => Promise<void>) {
  try { await fn(); throw new Error("Expected rate limit"); }
  catch (error) { expect(error).toBeInstanceOf(HTTPException); expect((error as HTTPException).status).toBe(429); }
}

describe("delivery RPC budgets against canonical 0031 and 0049 schemas", () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
      d1Databases: { OPS_DB: crypto.randomUUID(), LEGACY_DB: crypto.randomUUID() } });
    database = fixedRateWindow(await runtime.getD1Database("OPS_DB") as D1Database);
    legacyDatabase = fixedRateWindow(await runtime.getD1Database("LEGACY_DB") as D1Database);
    for (const db of [database, legacyDatabase]) await migration(db, "0031_project_alpha_delivery_intent_rate_limits.sql");
    await migration(database, "0049_project_alpha_delivery_source_rate_limits.sql");
  });
  afterAll(async () => { await runtime?.dispose(); });
  beforeEach(async () => {
    await database.batch([database.prepare(`DELETE FROM ${ordinaryTable}`), database.prepare(`DELETE FROM ${sourceTable}`)]);
  });

  it.each(["preflight", "provision", "revoke"] as const)("admits primary %s with a separate attempt bucket and unchanged accepted bucket", async kind => {
    await applyProjectAlphaDeliveryRpcBudget(env(), primary, kind);
    const accepted = kind === "preflight" ? "preflight" : "intent";
    expect(await rows(sourceTable)).toEqual([expect.objectContaining({ source_id: primary.sourceId, scope: `attempt_${accepted}`, request_count: 1 })]);
    expect(await rows(ordinaryTable)).toEqual([expect.objectContaining({ scope: accepted, request_count: 1 })]);
  });

  it("keeps secondary attempts and accepted requests source-qualified and isolated from primary", async () => {
    for (const source of [primary, secondary]) {
      await applyProjectAlphaDeliveryRpcBudget(env(), source, "preflight");
      await applyProjectAlphaDeliveryRpcBudget(env(), source, "provision");
      await applyProjectAlphaDeliveryRpcBudget(env(), source, "revoke");
    }
    expect(await rows(ordinaryTable)).toEqual([
      expect.objectContaining({ scope: "intent", request_count: 2 }), expect.objectContaining({ scope: "preflight", request_count: 1 }),
    ]);
    for (const [sourceId, count] of [[primary.sourceId, 2], [secondary.sourceId, 4]] as const) {
      const actual = (await rows(sourceTable)).filter(row => row.source_id === sourceId);
      expect(actual).toHaveLength(count);
      expect(actual.find(row => row.scope === "attempt_intent")?.request_count).toBe(2);
    }
    expect((await rows(sourceTable)).find(row => row.source_id === secondary.sourceId && row.scope === "intent")?.request_count).toBe(2);
  });

  it.each([
    [primary, "preflight", "attempt_preflight", 600], [primary, "provision", "attempt_intent", 300],
    [secondary, "preflight", "attempt_preflight", 600], [secondary, "provision", "attempt_intent", 300],
  ] as const)("consumes the final %s %s attempt then denies without incrementing accepted quota", async (source, kind, scope, maximum) => {
    await seed(source.sourceId, scope, maximum - 1);
    await applyProjectAlphaDeliveryRpcBudget(env(), source, kind);
    await rateLimited(() => applyProjectAlphaDeliveryRpcBudget(env(), source, kind));
    const actual = await rows(sourceTable);
    expect(actual.find(row => row.source_id === source.sourceId && row.scope === scope)?.request_count).toBe(maximum);
    const accepted = kind === "preflight" ? "preflight" : "intent";
    expect((source.sourceId === primary.sourceId ? await rows(ordinaryTable) : actual)
      .find(row => row.scope === accepted)?.request_count).toBe(1);
  });

  it.each([
    [primary, "preflight", "preflight", 120], [primary, "provision", "intent", 60],
    [secondary, "preflight", "preflight", 120], [secondary, "provision", "intent", 60],
  ] as const)("denies exhausted %s %s accepted quota while accounting for its attempt", async (source, kind, scope, maximum) => {
    await seed(source.sourceId, scope, maximum);
    await rateLimited(() => applyProjectAlphaDeliveryRpcBudget(env(), source, kind));
    const actual = await rows(sourceTable);
    expect(actual.find(row => row.source_id === source.sourceId && row.scope === `attempt_${scope}`)?.request_count).toBe(1);
    expect((source.sourceId === primary.sourceId ? await rows(ordinaryTable) : actual)
      .find(row => row.scope === scope)?.request_count).toBe(maximum);
  });

  it("fails closed on missing 0049 instead of placing attempts in the legacy table", async () => {
    for (const source of [primary, secondary]) {
      await expect(applyProjectAlphaDeliveryRpcBudget({ OPS_DB: legacyDatabase } as Env, source, "preflight"))
        .rejects.toMatchObject({ status: 503 });
    }
    expect((await legacyDatabase.prepare(`SELECT * FROM ${ordinaryTable}`).all()).results).toEqual([]);
  });
});
