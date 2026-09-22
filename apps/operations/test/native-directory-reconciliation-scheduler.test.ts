import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import {
  runNativeDirectoryReconciliationScheduler,
  type NativeDirectoryReconciliationSchedulerEnvironment,
  type NativeDirectoryReconciliationSchedulerOptions,
} from "../src/worker/native-directory-reconciliation-scheduler";
import type { ProjectAlphaDirectoryReconciliationResult } from "../src/worker/project-alpha-directory-reconciliation";

let runtime: Miniflare, db: D1Database, counter = 0;
const sourceA = "project-alpha:a", sourceB = "project-alpha:b", sourceDisabled = "project-alpha:disabled";
function uuid(): string { return `20000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`; }
function configuredCrons(source: string): string[] {
  const encoded = source.match(/"triggers"\s*:\s*\{\s*"crons"\s*:\s*(\[[^\]]*\])/u)?.[1];
  if (!encoded) throw new Error("missing cron trigger configuration");
  return JSON.parse(encoded) as string[];
}
function scheduledMinutes(cron: string): number[] {
  const field = cron.split(" ")[0];
  const range = field.match(/^(\d+)-(\d+)\/(\d+)$/u);
  const wildcard = field.match(/^\*\/(\d+)$/u);
  if (/^\d+$/u.test(field)) return [Number(field)];
  const start = range ? Number(range[1]) : 0;
  const end = range ? Number(range[2]) : 59;
  const step = range ? Number(range[3]) : wildcard ? Number(wildcard[1]) : Number.NaN;
  if (!Number.isInteger(step) || step < 1) throw new Error(`unsupported cron minute field ${field}`);
  const minutes: number[] = [];
  for (let minute = start; minute <= end; minute += step) minutes.push(minute);
  return minutes;
}
function splitSql(sql: string): string[] {
  const statements: string[] = []; let current = "", trigger = false;
  for (const line of sql.split(/\r?\n/u)) {
    if (!current && /^\s*--/u.test(line)) continue;
    if (/^\s*CREATE\s+TRIGGER\b/iu.test(line)) trigger = true;
    current += `${line}\n`;
    if ((!trigger && /;\s*$/u.test(line)) || (trigger && /^\s*END;\s*$/iu.test(line))) {
      statements.push(current.trim()); current = ""; trigger = false;
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}
async function applySql(sql: string): Promise<void> { for (const statement of splitSql(sql)) await db.prepare(statement).run(); }
function connections(enabled = [sourceA, sourceB], disabled = [sourceDisabled]): string {
  const all = [...enabled, ...disabled];
  return JSON.stringify({ version: 1, instances: Object.fromEntries(all.map((sourceId, index) => [sourceId, {
    sourceId, enabled: enabled.includes(sourceId), baseUrl: `https://pa-${index}.example.test`, apiKey: `private-${index}`,
    sourceInstanceId: `30000000-0000-4000-8000-${String(index * 3 + 1).padStart(12, "0")}`,
    applicationId: `30000000-0000-4000-8000-${String(index * 3 + 2).padStart(12, "0")}`,
    historyEpoch: `30000000-0000-4000-8000-${String(index * 3 + 3).padStart(12, "0")}`,
  }])) });
}
function env(overrides: Record<string, unknown> = {}): NativeDirectoryReconciliationSchedulerEnvironment {
  return { OPS_DB: db, PROJECT_ALPHA_DIRECTORY_RECONCILIATION_ENABLED: "true",
    PROJECT_ALPHA_API_V2_CONNECTIONS: connections(), ...overrides };
}
async function durableResult(sourceId: string, status: "complete" | "uncertain", reason?: string): Promise<ProjectAlphaDirectoryReconciliationResult> {
  const runId = uuid(), at = "2026-09-22T12:00:00.000Z";
  await db.prepare(`INSERT INTO project_alpha_directory_reconciliation_runs(run_id,source_id,status,
    source_instance_id,application_id,history_epoch_id,authorization_generation,pages_observed,items_observed,
    local_items_observed,failure_reason,started_at,completed_at) VALUES(?,?,?,?,?,?,?,1,0,0,?,?,?)`)
    .bind(runId, sourceId, status, uuid(), uuid(), uuid(), "1", status === "uncertain" ? reason ?? "uncertain" : null,
      at, at).run();
  return { sourceId, runId, status, ...(reason ? { reason } : {}), pages: 1, items: 0, findings: 0,
    previousCompleteRunId: null };
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB");
  await applySql(readFileSync(new URL("../migrations/0136_project_alpha_directory_reconciliation.sql", import.meta.url), "utf8"));
  await applySql(readFileSync(new URL("../migrations/0137_project_alpha_directory_reconciliation_scheduler.sql", import.meta.url), "utf8"));
});
beforeEach(async () => {
  await db.prepare("DELETE FROM project_alpha_directory_reconciliation_schedule_sources").run().catch(() => {});
  // The production table is durable. Tests reset only through a fresh logical
  // state because its DELETE guard is itself part of the contract.
  const rows = await db.prepare("SELECT source_id FROM project_alpha_directory_reconciliation_schedule_sources").all<{ source_id: string }>();
  for (const row of rows.results) await db.prepare(`UPDATE project_alpha_directory_reconciliation_schedule_sources SET
    next_attempt_at=0,consecutive_uncertain=0,last_status=NULL,last_run_id=NULL,last_attempt_at=NULL,
    updated_at='1970-01-01T00:00:00.000Z' WHERE source_id=?`).bind(row.source_id).run();
  await db.prepare(`UPDATE project_alpha_directory_reconciliation_scheduler SET cursor_source_id=NULL,
    lease_token=NULL,lease_expires_at=NULL,updated_at='1970-01-01T00:00:00.000Z' WHERE scheduler_id=1`).run();
});
afterAll(async () => runtime.dispose());

describe("default-off native Directory reconciliation scheduler", () => {
  it("does zero work while disabled and uses a unique 15-minute checked-in cron", async () => {
    const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    const entrypoint = readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8");
    const reconciliationCron = "6-51/15 * * * *";
    expect(config).toMatch(/"PROJECT_ALPHA_DIRECTORY_RECONCILIATION_ENABLED"\s*:\s*"false"/);
    expect(configuredCrons(config)).toContain(reconciliationCron);
    expect(configuredCrons(config).filter((candidate) => candidate === reconciliationCron)).toHaveLength(1);
    expect(scheduledMinutes(reconciliationCron)).toEqual([6, 21, 36, 51]);
    for (const cron of configuredCrons(config).filter((candidate) => candidate !== reconciliationCron)) {
      expect(scheduledMinutes(cron)).not.toEqual(scheduledMinutes(reconciliationCron));
    }
    expect(config).not.toContain("0-55/5 * * * *");
    expect(entrypoint).toContain(`NATIVE_DIRECTORY_RECONCILIATION_CRON = "${reconciliationCron}"`);
    expect(entrypoint).toContain("runNativeDirectoryReconciliationScheduler(env)");
    const disabled = new Proxy({ PROJECT_ALPHA_DIRECTORY_RECONCILIATION_ENABLED: "false" }, { get(target, key) {
      if (key === "PROJECT_ALPHA_DIRECTORY_RECONCILIATION_ENABLED") return target.PROJECT_ALPHA_DIRECTORY_RECONCILIATION_ENABLED;
      throw new Error(`unexpected binding access ${String(key)}`);
    } });
    await expect(runNativeDirectoryReconciliationScheduler(disabled as never)).resolves.toEqual({
      status: "disabled", attempted: 0, complete: 0, uncertain: 0, exhausted: false,
    });
  });

  it("fails closed on malformed configuration before database or reconciliation work", async () => {
    const reconcile = vi.fn();
    const malformed = new Proxy({ PROJECT_ALPHA_DIRECTORY_RECONCILIATION_ENABLED: "true",
      PROJECT_ALPHA_API_V2_CONNECTIONS: "{private@example.test" }, { get(target, key) {
      if (key === "OPS_DB") throw new Error("database must not be touched");
      return Reflect.get(target, key);
    } });
    await expect(runNativeDirectoryReconciliationScheduler(malformed as never, { reconcile })).resolves
      .toMatchObject({ status: "unavailable", attempted: 0 });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("rotates fairly across two enabled sources, skips disabled sources, and starts one source per tick", async () => {
    const selected: string[] = [];
    const reconcile: NonNullable<NativeDirectoryReconciliationSchedulerOptions["reconcile"]> = async (_env, sourceId) => {
      selected.push(sourceId); return durableResult(sourceId, "complete");
    };
    await expect(runNativeDirectoryReconciliationScheduler(env(), { now: () => 1_000, reconcile }))
      .resolves.toMatchObject({ status: "ran", attempted: 1, complete: 1 });
    await expect(runNativeDirectoryReconciliationScheduler(env(), { now: () => 1_000, reconcile }))
      .resolves.toMatchObject({ status: "ran", attempted: 1, complete: 1 });
    expect(selected).toEqual([sourceA, sourceB]);
    expect(selected).not.toContain(sourceDisabled);
  });

  it("does not overlap an active lease and recovers an expired lease", async () => {
    const reconcile = vi.fn(async (_env, sourceId: string) => durableResult(sourceId, "complete"));
    await db.prepare(`UPDATE project_alpha_directory_reconciliation_scheduler SET lease_token='live',
      lease_expires_at=2000 WHERE scheduler_id=1`).run();
    await expect(runNativeDirectoryReconciliationScheduler(env(), { now: () => 1_000, reconcile }))
      .resolves.toMatchObject({ status: "contended", attempted: 0 });
    expect(reconcile).not.toHaveBeenCalled();
    await expect(runNativeDirectoryReconciliationScheduler(env(), { now: () => 2_001, reconcile }))
      .resolves.toMatchObject({ status: "ran", attempted: 1, complete: 1 });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("renews fenced ownership while reconciliation remains in flight past its initial lease", async () => {
    let current = 1_000, release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const reconcile: NonNullable<NativeDirectoryReconciliationSchedulerOptions["reconcile"]> = async (_env, sourceId) => {
      entered();
      await gate;
      return durableResult(sourceId, "complete");
    };
    const first = runNativeDirectoryReconciliationScheduler(env(), { now: () => current, maxRuntimeMs: 10, reconcile });
    await started;
    try {
      current = 1_005;
      await vi.waitFor(async () => {
        const state = await db.prepare(`SELECT lease_expires_at leaseExpiresAt FROM
          project_alpha_directory_reconciliation_scheduler WHERE scheduler_id=1`).first<{ leaseExpiresAt: number }>();
        expect(state?.leaseExpiresAt).toBeGreaterThan(6_010);
      });
      current = 6_011;
      await expect(runNativeDirectoryReconciliationScheduler(env(), { now: () => current, maxRuntimeMs: 10, reconcile }))
        .resolves.toMatchObject({ status: "contended", attempted: 0 });
    } finally {
      release();
      await first.catch(() => undefined);
    }
    await expect(first).resolves.toMatchObject({ status: "ran", attempted: 1, complete: 1 });
  });

  it("stops before starting remote work when the tick deadline is exhausted", async () => {
    const reconcile = vi.fn(); const times = [1_000, 1_011];
    await expect(runNativeDirectoryReconciliationScheduler(env(), {
      now: () => times.shift() ?? 1_011, maxRuntimeMs: 10, reconcile,
    })).resolves.toMatchObject({ status: "idle", attempted: 0, exhausted: true });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("durably backs off an uncertain source and resumes it when retry becomes due", async () => {
    const calls: string[] = [];
    const reconcile: NonNullable<NativeDirectoryReconciliationSchedulerOptions["reconcile"]> = async (_env, sourceId) => {
      calls.push(sourceId); return durableResult(sourceId, calls.length === 1 ? "uncertain" : "complete", "timeout");
    };
    const single = env({ PROJECT_ALPHA_API_V2_CONNECTIONS: connections([sourceA], []) });
    await expect(runNativeDirectoryReconciliationScheduler(single, { now: () => 1_000, reconcile }))
      .resolves.toMatchObject({ status: "ran", attempted: 1, uncertain: 1 });
    await expect(runNativeDirectoryReconciliationScheduler(single, { now: () => 30_999, reconcile }))
      .resolves.toMatchObject({ status: "idle", attempted: 0 });
    await expect(runNativeDirectoryReconciliationScheduler(single, { now: () => 31_000, reconcile }))
      .resolves.toMatchObject({ status: "ran", attempted: 1, complete: 1 });
    expect(calls).toEqual([sourceA, sourceA]);
  });

  it("advances fair rotation when a source throws before returning a result", async () => {
    const calls: string[] = [];
    const reconcile: NonNullable<NativeDirectoryReconciliationSchedulerOptions["reconcile"]> = async (_env, sourceId) => {
      calls.push(sourceId);
      if (sourceId === sourceA) throw new Error("private transport failure");
      return durableResult(sourceId, "complete");
    };
    await expect(runNativeDirectoryReconciliationScheduler(env(), { now: () => 1_000, reconcile }))
      .resolves.toMatchObject({ status: "ran", attempted: 1, uncertain: 1 });
    await expect(runNativeDirectoryReconciliationScheduler(env(), { now: () => 301_000, reconcile }))
      .resolves.toMatchObject({ status: "ran", attempted: 1, complete: 1 });
    expect(calls).toEqual([sourceA, sourceB]);
  });

  it("returns and logs only aggregate non-sensitive fields", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runNativeDirectoryReconciliationScheduler(env(), {
        now: () => 1_000, reconcile: async (_environment, sourceId) => durableResult(sourceId, "complete"),
      });
      expect(JSON.stringify(result)).not.toMatch(/private|example\.test|project-alpha:/i);
      expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
      const entrypoint = readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8");
      expect(entrypoint).toContain('event: "native_directory.reconciliation.tick", ...result');
      expect(entrypoint).toContain('event: "native_directory.reconciliation.error"');
    } finally { log.mockRestore(); error.mockRestore(); }
  });
});
