import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ health: vi.fn(), dispatch: vi.fn(), adapter: vi.fn() }));
vi.mock("../src/worker/project-alpha-api-v2-health-cycle", () => ({ runProjectAlphaApiV2HealthCycle: mocks.health }));
vi.mock("../src/worker/project-alpha-api-v2-incident-alert-dispatch", () => ({
  dispatchProjectAlphaApiV2IncidentAlert: mocks.dispatch,
  projectAlphaApiV2IncidentAlertDispatchDependencies: mocks.adapter,
}));
import { runProjectAlphaApiV2MonitorCycle } from "../src/worker/project-alpha-api-v2-monitor-cycle";
import type { Env } from "../src/worker/types";
const db = {} as D1Database; // All side effects are mocked in these composition cases.
const env = {} as Env;
const identity = { sourceId: "project-alpha:primary", applicationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  baseUrl: "https://primary.example.test", expectedSourceInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  expectedHistoryEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", apiKey: "synthetic-key" };
const input = { enabled: "true", expectedMonitorRevision: 7, recipient: "owner@example.test",
  connections: JSON.stringify({ version: 1, connections: [identity,
    { ...identity, sourceId: "project-alpha:secondary", expectedSourceInstanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }] }) };
const health = { status: "checked", verified: 0, unhealthy: 2, storageErrors: 0, contended: 0 };
beforeEach(() => { vi.resetAllMocks(); mocks.health.mockResolvedValue(health); mocks.dispatch.mockResolvedValue({ status: "sent" }); });

it("performs no I/O when disabled, including an unconfigured deployment", async () => {
  expect(await runProjectAlphaApiV2MonitorCycle(db, env,
    { ...input, enabled: "false", connections: undefined, expectedMonitorRevision: 0 }))
    .toMatchObject({ health: { status: "disabled" }, alerts: {} });
  expect(mocks.health).not.toHaveBeenCalled();
  expect(mocks.adapter).not.toHaveBeenCalled();
});

it("runs health before independent alert attempts and emits only sanitized counts", async () => {
  mocks.dispatch.mockRejectedValueOnce(Error("private database detail"));
  const result = await runProjectAlphaApiV2MonitorCycle(db, env, input);
  expect(result).toEqual({ health, alerts: { storage_error: 1, sent: 1 } });
  expect(mocks.health.mock.invocationCallOrder[0]).toBeLessThan(mocks.dispatch.mock.invocationCallOrder[0]!);
  expect(mocks.dispatch).toHaveBeenCalledTimes(2);
  for (const [request] of mocks.dispatch.mock.calls) {
    expect(request.monitorRevision).toBe(7);
    expect(request.identity.apiKey).toBeUndefined();
  }
  expect(JSON.stringify(result)).not.toMatch(/synthetic-key|owner@|private database/);
});

it("preserves reconciliation-required alert counts without treating them as not due", async () => {
  mocks.dispatch.mockResolvedValueOnce({ status: "reconciliation_required" })
    .mockResolvedValueOnce({ status: "not_due" });
  const result = await runProjectAlphaApiV2MonitorCycle(db, env, input);
  expect(result.alerts).toEqual({ reconciliation_required: 1, not_due: 1 });
  expect(mocks.dispatch).toHaveBeenCalledTimes(2);
});

it("rejects malformed connection configuration before side effects", async () => {
  await expect(runProjectAlphaApiV2MonitorCycle(db, env, { ...input, connections: "invalid" })).rejects.toThrow();
  expect(mocks.health).not.toHaveBeenCalled();
  expect(mocks.dispatch).not.toHaveBeenCalled();
});
