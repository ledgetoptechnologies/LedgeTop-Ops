import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import {
  applyProjectAlphaApiV2MonitorLifecycle,
  getProjectAlphaApiV2ActiveMonitorIdentity,
  ProjectAlphaApiV2MonitorLifecycleConflict,
  readProjectAlphaApiV2MonitorLifecycle,
} from "../src/worker/project-alpha-api-v2-monitor-lifecycle";

const first = {
  sourceId: "project-alpha:primary",
  applicationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  baseUrl: "https://primary.example.test",
  expectedSourceInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  expectedHistoryEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
} as const;
const second = { ...first, sourceId: "project-alpha:secondary", baseUrl: "https://secondary.example.test",
  expectedSourceInstanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" } as const;

let runtime: Miniflare;
let database: D1Database;
beforeEach(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  database = await runtime.getD1Database("OPS_DB") as D1Database;
  const files = readdirSync(new URL("../migrations/", import.meta.url))
    .filter(file => /^\d{4}_.*\.sql$/.test(file)).sort();
  for (const file of files) {
    const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
    await database.batch(splitD1MigrationStatements(sql).map(statement => database.prepare(statement)));
  }
}, 120_000);
afterEach(async () => { await runtime.dispose(); });

const apply = (expectedRevision: number, enabled: boolean, identities: readonly unknown[]) =>
  applyProjectAlphaApiV2MonitorLifecycle(database, { expectedRevision, enabled, identities });

describe("Project Alpha API-v2 explicit monitor lifecycle", () => {
  it("defaults missing state to inactive and fails closed for active checks", async () => {
    expect(await readProjectAlphaApiV2MonitorLifecycle(database)).toEqual({ revision: 0, enabled: false, identities: [] });
    expect(await getProjectAlphaApiV2ActiveMonitorIdentity(database, 1, first)).toBeNull();
  });

  it("applies an exact detached identity set and unchanged state is idempotent", async () => {
    expect(await apply(0, true, [second, first])).toMatchObject({ revision: 1, enabled: true, identities: [first, second] });
    expect(await getProjectAlphaApiV2ActiveMonitorIdentity(database, 1, first)).toEqual(first);
    expect(await apply(1, true, [first, second])).toMatchObject({ revision: 1, enabled: true });
    expect(await database.prepare("SELECT count(*) FROM project_alpha_api_v2_monitor_lifecycle_history")
      .first<number>("count(*)")).toBe(1);
  });

  it("uses CAS, rolls back wrong revisions, and serializes concurrent transitions", async () => {
    await apply(0, true, [first]);
    await expect(apply(0, false, [])).rejects.toBeInstanceOf(ProjectAlphaApiV2MonitorLifecycleConflict);
    const attempts = await Promise.allSettled([apply(1, true, [first, second]), apply(1, false, [])]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await readProjectAlphaApiV2MonitorLifecycle(database)).revision).toBe(2);
  });

  it("deliberately disables and re-enables, rejecting an old revision and removed pins", async () => {
    await apply(0, true, [first, second]);
    await apply(1, false, []);
    expect(await getProjectAlphaApiV2ActiveMonitorIdentity(database, 1, first)).toBeNull();
    await expect(apply(1, true, [first])).rejects.toBeInstanceOf(ProjectAlphaApiV2MonitorLifecycleConflict);
    await apply(2, true, [first]);
    expect(await getProjectAlphaApiV2ActiveMonitorIdentity(database, 3, first)).toEqual(first);
    expect(await getProjectAlphaApiV2ActiveMonitorIdentity(database, 3, second)).toBeNull();
    const history = await database.prepare("SELECT identities_json FROM project_alpha_api_v2_monitor_lifecycle_history ORDER BY revision")
      .all<{ identities_json: string }>();
    expect(JSON.parse(history.results[0]!.identities_json)).toEqual([first, second]);
    expect(JSON.stringify(history)).not.toMatch(/apiKey|secret|credential/i);
  });

  it("rejects credential-bearing, duplicate, malformed, and noncanonical identities without changing state", async () => {
    await apply(0, true, [first]);
    for (const bad of [
      { ...first, apiKey: "synthetic-private-key" },
      { ...first, expectedHistoryEpoch: "not-a-uuid" },
      first,
    ]) {
      await expect(apply(1, true, [bad, ...(bad === first ? [first] : [])]))
        .rejects.toThrow();
    }
    expect(await readProjectAlphaApiV2MonitorLifecycle(database)).toMatchObject({ revision: 1, enabled: true });
    await expect(apply(1, true, [first, { ...second, sourceId: first.sourceId }])).rejects.toThrow();
    await expect(apply(1, true, [first, { ...second, expectedSourceInstanceId: first.expectedSourceInstanceId }])).rejects.toThrow();
    let reads = 0;
    const accessor = Object.defineProperty({}, "sourceId", { enumerable: true, get() { reads++; return first.sourceId; } });
    await expect(apply(1, true, [accessor])).rejects.toThrow();
    expect(reads).toBe(0);
  });

  it("rolls back the head when immutable history cannot be appended", async () => {
    await apply(0, true, [first]);
    await database.prepare(`CREATE TRIGGER synthetic_lifecycle_history_failure BEFORE INSERT
      ON project_alpha_api_v2_monitor_lifecycle_history WHEN NEW.revision=2
      BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`).run();
    await expect(apply(1, false, [])).rejects.toThrow();
    expect(await readProjectAlphaApiV2MonitorLifecycle(database)).toMatchObject({ revision: 1, enabled: true });
    expect(await database.prepare("SELECT count(*) AS n FROM project_alpha_api_v2_monitor_lifecycle_history")
      .first<number>("n")).toBe(1);
    await expect(database.prepare("DELETE FROM project_alpha_api_v2_monitor_lifecycle_history").run()).rejects.toThrow();
  });

  it("rejects a corrupted persisted configuration and denies active membership", async () => {
    await apply(0, true, [first]);
    await database.prepare(`UPDATE project_alpha_api_v2_monitor_lifecycle_heads
      SET revision=2,identities_json=? WHERE lifecycle_id=1`)
      .bind(JSON.stringify([{ ...first, apiKey: "synthetic-secret" }])).run();
    await expect(readProjectAlphaApiV2MonitorLifecycle(database)).rejects.toThrow();
    expect(await getProjectAlphaApiV2ActiveMonitorIdentity(database, 2, first)).toBeNull();
  });
});
