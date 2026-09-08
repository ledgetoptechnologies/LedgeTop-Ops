import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";

const mocks = vi.hoisted(() => ({ ready: vi.fn(), enabled: vi.fn() }));
vi.mock("../src/worker/delivery-change-projector", () => ({
  deliveryChangeProjectionReady: mocks.ready,
  authenticatedDeliveryChangeRecoveryEnabled: mocks.enabled,
}));

import { deliveryChangeRecoveryStatus } from "../src/worker/delivery-change-recovery-status";
import type { Env } from "../src/worker/types";

describe("delivery-change recovery status aggregate", { timeout: 60_000 }, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;

  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22",
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["DELIVERY_DB"] });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.prepare(`CREATE TABLE portal_authenticated_delivery_change_projection_jobs (
      status TEXT NOT NULL,last_reason_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    )`).run();
    env = { DELIVERY_DB: db } as Env;
  });

  beforeEach(async () => {
    await db.prepare("DELETE FROM portal_authenticated_delivery_change_projection_jobs").run();
    mocks.ready.mockReset().mockResolvedValue(true);
    mocks.enabled.mockReset().mockReturnValue(true);
  });

  afterAll(async () => runtime?.dispose());

  async function insert(status: string, reason: string | null, createdAt: string, updatedAt = createdAt) {
    await db.prepare(`INSERT INTO portal_authenticated_delivery_change_projection_jobs
      (status,last_reason_code,created_at,updated_at) VALUES(?,?,?,?)`).bind(status, reason, createdAt, updatedAt).run();
  }

  it("returns only a bounded fixed-code aggregate, including retained work while enabled", async () => {
    await insert("pending", null, "2026-09-07T12:05:00.000Z");
    await insert("processing", null, "2026-09-07T12:01:00.000Z");
    await insert("completed", null, "2026-09-07T12:00:00.000Z");
    await insert("failed", "staging-fence", "2026-09-07T12:02:00.000Z", "2026-09-07T12:03:00.000Z");
    await insert("failed", "staging-failed", "2026-09-07T12:04:00.000Z", "2026-09-07T12:06:00.000Z");

    const result = await deliveryChangeRecoveryStatus(env);
    expect(result).toEqual({
      enabled: true, state: "attention", reason: null,
      counts: { pending: 1, processing: 1, completed: 1, failed: 2 },
      failures: [{ reason: "staging-fence", count: 1 }, { reason: "staging-failed", count: 1 }],
      oldestPendingAt: "2026-09-07T12:01:00.000Z",
      lastFailureAt: "2026-09-07T12:06:00.000Z",
    });
    expect(JSON.stringify(result)).not.toMatch(/receipt|identity|Jobs\/Clients|@/i);
  });

  it("keeps accepted pending and failed work visible while recovery is paused", async () => {
    mocks.enabled.mockReturnValue(false);
    await insert("pending", null, "2026-09-07T12:00:00.000Z");
    await insert("failed", "authority-suppressed", "2026-09-07T12:01:00.000Z", "2026-09-07T12:02:00.000Z");

    await expect(deliveryChangeRecoveryStatus(env)).resolves.toEqual({
      enabled: false, state: "disabled", reason: null,
      counts: { pending: 1, processing: 0, completed: 0, failed: 1 },
      failures: [{ reason: "authority-suppressed", count: 1 }],
      oldestPendingAt: "2026-09-07T12:00:00.000Z",
      lastFailureAt: "2026-09-07T12:02:00.000Z",
    });
  });

  it("distinguishes a verified empty queue from an unavailable queue", async () => {
    await expect(deliveryChangeRecoveryStatus(env)).resolves.toEqual({
      enabled: true, state: "ready", reason: null,
      counts: { pending: 0, processing: 0, completed: 0, failed: 0 },
      failures: [], oldestPendingAt: null, lastFailureAt: null,
    });
  });

  it("uses a fixed fallback for terminal failures without a stored reason", async () => {
    await insert("failed", null, "2026-09-07T12:00:00.000Z");
    const result = await deliveryChangeRecoveryStatus(env);
    expect(result.state).toBe("attention");
    expect(result.failures).toEqual([{ reason: "staging-failed", count: 1 }]);
  });

  it("does not present malformed outstanding timestamps as a healthy queue", async () => {
    await insert("processing", null, "private/path/not-a-date");
    const result = await deliveryChangeRecoveryStatus(env);
    expect(result.state).toBe("unavailable");
    expect(result.counts).toBeNull();
    expect(JSON.stringify(result)).not.toContain("private/path");
  });

  it("reports missing projection readiness as unavailable rather than an empty healthy queue", async () => {
    mocks.ready.mockResolvedValue(false);
    await insert("pending", null, "2026-09-07T12:00:00.000Z");

    await expect(deliveryChangeRecoveryStatus(env)).resolves.toEqual({
      enabled: true, state: "unavailable", reason: "schema_unavailable", counts: null,
      failures: [], oldestPendingAt: null, lastFailureAt: null,
    });
  });

  it("fails closed on corrupt aggregate rows without exposing row content", async () => {
    await insert("failed", "private/path/identity", "2026-09-07T12:00:00.000Z");

    const result = await deliveryChangeRecoveryStatus(env);
    expect(result).toEqual({
      enabled: true, state: "unavailable", reason: "status_unavailable", counts: null,
      failures: [], oldestPendingAt: null, lastFailureAt: null,
    });
    expect(JSON.stringify(result)).not.toContain("private/path/identity");
  });

  it("fails closed on an unknown stored state instead of treating it as an empty queue", async () => {
    await insert("unknown-private-state", null, "2026-09-07T12:00:00.000Z");

    await expect(deliveryChangeRecoveryStatus(env)).resolves.toEqual({
      enabled: true, state: "unavailable", reason: "status_unavailable", counts: null,
      failures: [], oldestPendingAt: null, lastFailureAt: null,
    });
  });

  it("sanitizes raw D1 failures into the same unavailable result", async () => {
    const broken = { ...env, DELIVERY_DB: {
      withSession: () => ({ prepare: () => { throw new Error("private-r2-key-and-recipient@example.test"); } }),
    } } as unknown as Env;

    const result = await deliveryChangeRecoveryStatus(broken);
    expect(result).toEqual({
      enabled: true, state: "unavailable", reason: "status_unavailable", counts: null,
      failures: [], oldestPendingAt: null, lastFailureAt: null,
    });
    expect(JSON.stringify(result)).not.toMatch(/private-r2-key|recipient@example/);
  });
});
