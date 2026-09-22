import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";

const profileDispatch = vi.hoisted(() => vi.fn());
const relationshipDispatch = vi.hoisted(() => vi.fn());
vi.mock("../src/worker/project-alpha-directory-profile-outbox-dispatcher", () => ({
  dispatchProjectAlphaDirectoryProfileOutboxCommand: profileDispatch,
}));
vi.mock("../src/worker/project-alpha-directory-relationship-outbox-dispatcher", () => ({
  dispatchProjectAlphaDirectoryRelationshipCommand: relationshipDispatch,
}));

import { drainNativeDirectoryOutboxes } from "../src/worker/native-directory-outbox-scheduler";

let runtime: Miniflare;
let db: D1Database;
const dueAt = 1_000;

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function connections(sourceIds: readonly string[], disabled: readonly string[] = []): string {
  return JSON.stringify({ version: 1, instances: Object.fromEntries(sourceIds.map((sourceId, index) => [sourceId, {
    sourceId, enabled: !disabled.includes(sourceId), baseUrl: `https://pa-${index}.example.test`, apiKey: `secret-${index}`,
    sourceInstanceId: uuid(index * 3 + 1), applicationId: uuid(index * 3 + 2), historyEpoch: uuid(index * 3 + 3),
  }])) });
}

function environment(sourceIds: readonly string[], disabled: readonly string[] = []) {
  return { OPS_DB: db, NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED: "true",
    PROJECT_ALPHA_API_V2_CONNECTIONS: connections(sourceIds, disabled) };
}

async function command(queue: "profile" | "relationship", commandId: string, sourceId: string,
  state: "pending" | "leased" | "acknowledged" | "terminal" = "pending", eligibleAt = 0): Promise<void> {
  const table = queue === "profile" ? "project_alpha_directory_outbox" : "project_alpha_directory_relationship_outbox";
  await db.prepare(`INSERT INTO ${table}(command_id,source_id,state,next_attempt_at,lease_expires_at,created_at)
    VALUES(?,?,?,?,?,?)`).bind(commandId, sourceId, state, state === "pending" ? eligibleAt : 0,
      state === "leased" ? eligibleAt : null, `2026-09-22T00:00:${commandId.slice(-2)}.000Z`).run();
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22",
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  for (const table of ["project_alpha_directory_outbox", "project_alpha_directory_relationship_outbox"])
    await db.prepare(`CREATE TABLE ${table}(command_id TEXT PRIMARY KEY,source_id TEXT NOT NULL,state TEXT NOT NULL,
      next_attempt_at INTEGER NOT NULL,lease_expires_at INTEGER,created_at TEXT NOT NULL)`).run();
});

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM project_alpha_directory_outbox"),
    db.prepare("DELETE FROM project_alpha_directory_relationship_outbox"),
  ]);
  profileDispatch.mockReset().mockResolvedValue({ status: "acknowledged" });
  relationshipDispatch.mockReset().mockResolvedValue({ status: "acknowledged" });
});

afterAll(async () => runtime.dispose());

describe("native Directory scheduled outbox drain", () => {
  it("is default-off and returns before touching database or connection configuration", async () => {
    const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    const entrypoint = readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8");
    expect(config).toMatch(/"NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED"\s*:\s*"false"/);
    expect(config.match(/"1-56\/5 \* \* \* \*"/g)).toHaveLength(1);
    expect(entrypoint).toContain("drainNativeDirectoryOutboxes(env, { rotationTime: event.scheduledTime })");
    const disabled = new Proxy({ NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED: "false" }, { get(target, key) {
      if (key === "NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED") return target.NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED;
      throw new Error(`unexpected binding access: ${String(key)}`);
    } });
    await expect(drainNativeDirectoryOutboxes(disabled as never)).resolves.toEqual({ status: "disabled",
      attempted: 0, acknowledged: 0, conflicted: 0, uncertain: 0, blocked: 0, failed: 0, exhausted: false });
    expect(profileDispatch).not.toHaveBeenCalled();
    expect(relationshipDispatch).not.toHaveBeenCalled();
  });

  it("drains both queues, recovers expired leases, and skips live leases and terminal rows", async () => {
    const sourceId = "project-alpha:primary";
    await command("profile", "profile-due", sourceId);
    await command("relationship", "relationship-due", sourceId);
    await command("profile", "profile-expired", sourceId, "leased", dueAt - 1);
    await command("relationship", "relationship-live", sourceId, "leased", dueAt + 1);
    await command("profile", "profile-terminal", sourceId, "terminal");
    await command("relationship", "relationship-ack", sourceId, "acknowledged");
    const result = await drainNativeDirectoryOutboxes(environment([sourceId]), { now: () => dueAt, rotationTime: 0 });
    expect(result).toMatchObject({ status: "drained", attempted: 3, acknowledged: 3, failed: 0 });
    expect(profileDispatch.mock.calls.map(call => call[2])).toEqual(["profile-due", "profile-expired"]);
    expect(relationshipDispatch.mock.calls.map(call => call[2])).toEqual(["relationship-due"]);
  });

  it("rotates fairly across enabled sources and queues while enforcing the work bound", async () => {
    const sources = ["project-alpha:a", "project-alpha:b", "project-alpha:c"];
    const disabledSource = "project-alpha:disabled";
    for (const sourceId of [...sources, disabledSource, "project-alpha:unconfigured"])
      for (const queue of ["profile", "relationship"] as const) {
        const label = sourceId.slice("project-alpha:".length);
        await command(queue, `${label}-${queue}-1`, sourceId);
        await command(queue, `${label}-${queue}-2`, sourceId);
      }
    const order: string[] = [];
    profileDispatch.mockImplementation(async (_env, sourceId, commandId) => {
      order.push(`profile:${sourceId}:${commandId}`); return { status: "acknowledged" };
    });
    relationshipDispatch.mockImplementation(async (_env, sourceId, commandId) => {
      order.push(`relationship:${sourceId}:${commandId}`); return { status: "acknowledged" };
    });
    const selected = environment([...sources, disabledSource], [disabledSource]);
    await expect(drainNativeDirectoryOutboxes(selected, { now: () => dueAt, rotationTime: 0, maxCommands: 4 }))
      .resolves.toMatchObject({ attempted: 4, acknowledged: 4 });
    expect(order).toEqual([
      "profile:project-alpha:a:a-profile-1", "relationship:project-alpha:a:a-relationship-1",
      "profile:project-alpha:b:b-profile-1", "relationship:project-alpha:b:b-relationship-1",
    ]);
    order.length = 0;
    await drainNativeDirectoryOutboxes(selected, { now: () => dueAt, rotationTime: 5 * 60_000, maxCommands: 4 });
    expect(order).toEqual([
      "relationship:project-alpha:b:b-relationship-1", "profile:project-alpha:b:b-profile-1",
      "relationship:project-alpha:c:c-relationship-1", "profile:project-alpha:c:c-profile-1",
    ]);
    expect(order.every(value => !value.includes("disabled") && !value.includes("unconfigured"))).toBe(true);
  });

  it("stops starting commands at the time bound", async () => {
    const sourceId = "project-alpha:primary";
    await command("profile", "profile-one", sourceId);
    await command("profile", "profile-two", sourceId);
    const times = [dueAt, dueAt, dueAt + 101, dueAt + 101];
    const result = await drainNativeDirectoryOutboxes(environment([sourceId]), {
      now: () => times.shift() ?? dueAt + 101, rotationTime: 0, maxCommands: 4, maxRuntimeMs: 100,
    });
    expect(result).toMatchObject({ attempted: 1, acknowledged: 1, exhausted: true });
    expect(profileDispatch).toHaveBeenCalledTimes(1);
  });

  it("retains an outage command for a later retry without logging private failure data", async () => {
    const sourceId = "project-alpha:primary";
    await command("profile", "profile-outage", sourceId);
    profileDispatch.mockRejectedValueOnce(new Error("secret-token private@example.test"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(drainNativeDirectoryOutboxes(environment([sourceId]), { now: () => dueAt, rotationTime: 0 }))
      .resolves.toMatchObject({ attempted: 1, failed: 1, acknowledged: 0 });
    expect(await db.prepare("SELECT state FROM project_alpha_directory_outbox WHERE command_id='profile-outage'").first("state"))
      .toBe("pending");
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    profileDispatch.mockResolvedValueOnce({ status: "acknowledged" });
    await expect(drainNativeDirectoryOutboxes(environment([sourceId]), { now: () => dueAt, rotationTime: 0 }))
      .resolves.toMatchObject({ attempted: 1, acknowledged: 1, failed: 0 });
  });
});
