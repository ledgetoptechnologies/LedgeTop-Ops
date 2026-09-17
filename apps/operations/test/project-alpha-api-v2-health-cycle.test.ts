import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), record: vi.fn(), probe: vi.fn(), active: vi.fn() }));
vi.mock("../src/worker/project-alpha-api-v2", () => ({ probeProjectAlphaDirectoryApiV2: mocks.probe }));
vi.mock("../src/worker/project-alpha-api-v2-incident-store", () => ({
  readProjectAlphaApiV2Incident: mocks.read, recordProjectAlphaApiV2IncidentObservation: mocks.record,
  ProjectAlphaApiV2IncidentStoreConflict: class extends Error {},
}));
vi.mock("../src/worker/project-alpha-api-v2-monitor-lifecycle", () => ({
  isProjectAlphaApiV2MonitorIdentityActive: mocks.active,
}));
import { ProjectAlphaApiV2IncidentStoreConflict } from "../src/worker/project-alpha-api-v2-incident-store";
import { runProjectAlphaApiV2HealthCycle } from "../src/worker/project-alpha-api-v2-health-cycle";

const sourceInstance = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const applicationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const expectedHistoryEpoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const config = JSON.stringify({ version: 1, connections: [
  { sourceId: "project-alpha:primary", applicationId, expectedHistoryEpoch, expectedSourceInstanceId: sourceInstance,
    baseUrl: "https://primary.example.test", apiKey: "synthetic-private-key" },
  { sourceId: "project-alpha:secondary", applicationId, expectedHistoryEpoch,
    expectedSourceInstanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    baseUrl: "https://secondary.example.test", apiKey: "synthetic-private-key" },
] });
const database = {} as D1Database; // All persistence boundaries are mocked in this composition test.
beforeEach(() => {
  vi.resetAllMocks();
  mocks.read.mockResolvedValue({ revision: 0, state: null });
  mocks.record.mockResolvedValue({ status: "recorded", revision: 1 });
  mocks.probe.mockResolvedValue({ status: "unavailable", reason: "timeout" });
  mocks.active.mockResolvedValue(true);
});

describe("independent API-v2 health cycle", () => {
  it("handles an enabled empty configuration without probing or fabricating a healthy source", async () => {
    expect(await runProjectAlphaApiV2HealthCycle(database,
      { enabled: "true", connections: JSON.stringify({ version: 1, connections: [] }), expectedMonitorRevision: 1 }))
      .toEqual({ status: "checked", verified: 0, unhealthy: 0, storageErrors: 0, contended: 0 });
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("does nothing when disabled, even with absent configuration", async () => {
    expect(await runProjectAlphaApiV2HealthCycle(database, { enabled: "false", connections: undefined, expectedMonitorRevision: 1 }))
      .toEqual({ status: "disabled", verified: 0, unhealthy: 0, storageErrors: 0, contended: 0 });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it("skips a freshly deployment-disabled instance without a probe or denied disabled-state write", async () => {
    const disabled = JSON.stringify({ version: 1, instances: {
      "project-alpha:primary": { sourceId: "project-alpha:primary", enabled: false,
        baseUrl: "https://primary.example.test", apiKey: "synthetic-private-key",
        sourceInstanceId: sourceInstance, applicationId, historyEpoch: expectedHistoryEpoch },
    } });
    expect(await runProjectAlphaApiV2HealthCycle(database,
      { enabled: "true", connections: disabled, expectedMonitorRevision: 1 }, fetch, () => 100))
      .toEqual({ status: "checked", verified: 0, unhealthy: 0, storageErrors: 0, contended: 0 });
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("probes both instances without requiring a queued command, and persists each result", async () => {
    mocks.probe.mockImplementation(async connection => connection.sourceId.endsWith("primary")
      ? { status: "unavailable", reason: "timeout" }
      : { status: "verified", sourceInstanceId: connection.expectedSourceInstanceId,
        applicationId, historyEpoch: expectedHistoryEpoch, requestId: applicationId, grantedCapabilities: [] });
    const result = await runProjectAlphaApiV2HealthCycle(database, { enabled: "true", connections: config, expectedMonitorRevision: 1 }, fetch, () => 100);
    expect(result).toEqual({ status: "checked", verified: 1, unhealthy: 1, storageErrors: 0, contended: 0 });
    expect(mocks.probe).toHaveBeenCalledTimes(2);
    expect(mocks.record).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("synthetic-private-key");
    for (const [, input] of mocks.record.mock.calls) {
      expect(input.observation.startedAt).toBe(100);
      expect(input.identity).not.toHaveProperty("apiKey");
      const configured = JSON.parse(config).connections.find((item: { sourceId: string }) => item.sourceId === input.identity.sourceId);
      expect(input.identity).toEqual({ sourceId: configured.sourceId, applicationId: configured.applicationId,
        baseUrl: configured.baseUrl, expectedSourceInstanceId: configured.expectedSourceInstanceId,
        expectedHistoryEpoch: configured.expectedHistoryEpoch });
    }
  });

  it("isolates a storage failure so the other source is still probed", async () => {
    mocks.read.mockImplementation(async (_db, selected) => {
      if (selected.sourceId.endsWith("primary")) throw Error("private database diagnostic");
      return { revision: 0, state: null };
    });
    expect(await runProjectAlphaApiV2HealthCycle(database, { enabled: "true", connections: config, expectedMonitorRevision: 1 }, fetch, () => 100))
      .toMatchObject({ unhealthy: 1, storageErrors: 1 });
    expect(mocks.probe).toHaveBeenCalledTimes(1);
  });

  it("retries a revision conflict once without changing the original observation timestamp", async () => {
    mocks.record.mockRejectedValueOnce(new ProjectAlphaApiV2IncidentStoreConflict());
    let clock = 100;
    expect(await runProjectAlphaApiV2HealthCycle(database, { enabled: "true", connections: config, expectedMonitorRevision: 1 }, fetch, () => clock++))
      .toMatchObject({ unhealthy: 2, storageErrors: 0, contended: 0 });
    expect(mocks.record).toHaveBeenCalledTimes(3);
    const primary = mocks.record.mock.calls.map(([, input]) => input)
      .filter(input => input.identity.sourceId === "project-alpha:primary");
    expect(primary.map(input => input.observation.startedAt)).toEqual([100, 100]);
  });

  it("bounds repeated contention and reports no secret diagnostics", async () => {
    mocks.record.mockRejectedValue(new ProjectAlphaApiV2IncidentStoreConflict());
    expect(await runProjectAlphaApiV2HealthCycle(database, { enabled: "true", connections: config, expectedMonitorRevision: 1 }, fetch, () => 100))
      .toMatchObject({ contended: 2, storageErrors: 0 });
    expect(mocks.record).toHaveBeenCalledTimes(4);
  });

  it("rejects malformed configuration before any asynchronous I/O", async () => {
    await expect(runProjectAlphaApiV2HealthCycle(database, { enabled: "true", connections: "private-invalid-json", expectedMonitorRevision: 1 }))
      .rejects.toThrow("project_alpha_api_v2_health_configuration_denied");
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("does not probe a connection after the explicit lifecycle pin is no longer active", async () => {
    mocks.active.mockResolvedValue(false);
    expect(await runProjectAlphaApiV2HealthCycle(database,
      { enabled: "true", connections: config, expectedMonitorRevision: 1 }, fetch, () => 100))
      .toEqual({ status: "checked", verified: 0, unhealthy: 0, storageErrors: 0, contended: 0 });
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
