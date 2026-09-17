import { describe, expect, it } from "vitest";
import { ProjectAlphaApiV2MonitorSchedulerSelectionError, selectProjectAlphaApiV2MonitorSchedulerRevision } from "../src/worker/project-alpha-api-v2-monitor-scheduler-selection";

const primary = { sourceId: "project-alpha:primary", applicationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  baseUrl: "https://primary.example.test", expectedSourceInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  expectedHistoryEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
const secondary = { ...primary, sourceId: "project-alpha:secondary", baseUrl: "https://secondary.example.test",
  expectedSourceInstanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" };
const command = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function database(identities: readonly object[], enabled = 1) {
  const row = { lifecycle_id: 1, revision: 7, enabled, identities_json: JSON.stringify(identities),
    operator_command_id: command, audited: 1 };
  return { withSession: () => ({ prepare: () => ({ first: async () => row }) }) } as unknown as D1Database;
}

function connections(primaryEnabled: boolean, secondaryEnabled: boolean) {
  return JSON.stringify({ version: 1, instances: {
    [primary.sourceId]: { sourceId: primary.sourceId, enabled: primaryEnabled, baseUrl: primary.baseUrl,
      apiKey: "synthetic-primary", sourceInstanceId: primary.expectedSourceInstanceId,
      applicationId: primary.applicationId, historyEpoch: primary.expectedHistoryEpoch },
    [secondary.sourceId]: { sourceId: secondary.sourceId, enabled: secondaryEnabled, baseUrl: secondary.baseUrl,
      apiKey: "synthetic-secondary", sourceInstanceId: secondary.expectedSourceInstanceId,
      applicationId: secondary.applicationId, historyEpoch: secondary.expectedHistoryEpoch },
  } });
}

describe("API-v2 monitor scheduler identity selection", () => {
  it("excludes a freshly disabled configured instance from the active lifecycle identity set", async () => {
    await expect(selectProjectAlphaApiV2MonitorSchedulerRevision(database([primary]),
      { enabled: "true", connections: connections(true, false) })).resolves.toEqual({ status: "selected", revision: 7 });
  });

  it("requires lifecycle control to retire a disabled identity before scheduling another cycle", async () => {
    await expect(selectProjectAlphaApiV2MonitorSchedulerRevision(database([primary, secondary]),
      { enabled: "true", connections: connections(true, false) }))
      .rejects.toBeInstanceOf(ProjectAlphaApiV2MonitorSchedulerSelectionError);
  });

  it("treats an audited disabled lifecycle as a disabled schedule without parsing stale configuration", async () => {
    await expect(selectProjectAlphaApiV2MonitorSchedulerRevision(database([], 0),
      { enabled: "true", connections: "not-read" })).resolves.toEqual({ status: "disabled" });
  });
});
