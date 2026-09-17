import { describe, expect, it } from "vitest";
import {
  prepareProjectAlphaApiV2MonitorControlCommand,
  ProjectAlphaApiV2MonitorControlCommandError,
} from "../src/worker/project-alpha-api-v2-monitor-control-command";

const sourceInstance = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const application = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const epoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const connection = {
  sourceId: "project-alpha:primary", applicationId: application,
  baseUrl: "https://primary.example.test", expectedSourceInstanceId: sourceInstance,
  expectedHistoryEpoch: epoch, apiKey: "do-not-return-this-key",
};
const config = (value: unknown = connection) => JSON.stringify({ version: 1, connections: [value] });
const command = (value: Record<string, unknown> = {}) => ({ expectedRevision: 0, enabled: true, ...value });

describe("Project Alpha API-v2 monitor control command", () => {
  it("derives a frozen identity-only enable command from deployment configuration", () => {
    const result = prepareProjectAlphaApiV2MonitorControlCommand(command(), config());
    expect(result).toMatchObject({ expectedRevision: 0, enabled: true,
      identities: [{ sourceId: connection.sourceId, applicationId: application, baseUrl: connection.baseUrl,
        expectedSourceInstanceId: sourceInstance, expectedHistoryEpoch: epoch }] });
    expect(result.identitiesJson).not.toContain("apiKey");
    expect(JSON.stringify(result)).not.toContain(connection.apiKey);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.identities)).toBe(true);
    expect(Object.isFrozen(result.identities[0])).toBe(true);
  });

  it("requires exactly a bounded revision and enabled flag", () => {
    for (const value of [null, [], { expectedRevision: 0 }, { enabled: true },
      command({ expectedRevision: -1 }), command({ expectedRevision: 1.5 }),
      command({ expectedRevision: Number.MAX_SAFE_INTEGER }), command({ enabled: 1 }),
      command({ identities: [] }), command({ apiKey: "browser-key" })]) {
      expect(() => prepareProjectAlphaApiV2MonitorControlCommand(value, config()))
        .toThrow(ProjectAlphaApiV2MonitorControlCommandError);
    }
  });

  it("rejects accessors, symbols, non-enumerable extras, and proxy failures without invoking them", () => {
    let reads = 0;
    const accessor = command();
    Object.defineProperty(accessor, "enabled", { enumerable: true, get: () => { reads += 1; return true; } });
    expect(() => prepareProjectAlphaApiV2MonitorControlCommand(accessor, config()))
      .toThrow(ProjectAlphaApiV2MonitorControlCommandError);
    const symbolExtra = { ...command(), [Symbol("extra")]: true };
    expect(() => prepareProjectAlphaApiV2MonitorControlCommand(symbolExtra, config()))
      .toThrow(ProjectAlphaApiV2MonitorControlCommandError);
    const hiddenExtra = command();
    Object.defineProperty(hiddenExtra, "extra", { enumerable: false, value: true });
    expect(() => prepareProjectAlphaApiV2MonitorControlCommand(hiddenExtra, config()))
      .toThrow(ProjectAlphaApiV2MonitorControlCommandError);
    const broken = new Proxy(command(), { getPrototypeOf: () => { throw new Error("untrusted detail"); } });
    expect(() => prepareProjectAlphaApiV2MonitorControlCommand(broken, config()))
      .toThrow(ProjectAlphaApiV2MonitorControlCommandError);
    expect(reads).toBe(0);
  });

  it("allows disable with absent or malformed configuration and always emits no identities", () => {
    for (const raw of [undefined, "not-json", JSON.stringify({ version: 2, connections: [] }),
      config({ ...connection, expectedHistoryEpoch: epoch.toUpperCase() })]) {
      const result = prepareProjectAlphaApiV2MonitorControlCommand(
        { expectedRevision: 7, enabled: false }, raw);
      expect(result).toMatchObject({ expectedRevision: 7, enabled: false, identities: [], identitiesJson: "[]" });
    }
  });

  it("pins only deployment-enabled instances so lifecycle selection matches the scheduler", () => {
    const disabled = { ...connection, sourceId: "project-alpha:secondary",
      applicationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      expectedSourceInstanceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", enabled: false };
    const result = prepareProjectAlphaApiV2MonitorControlCommand(command(),
      JSON.stringify({ version: 1, connections: [connection, disabled] }));
    expect(result.identities).toHaveLength(1);
    expect(result.identities[0]).toMatchObject({ sourceId: connection.sourceId,
      applicationId: connection.applicationId });
    expect(result.identitiesJson).not.toContain(disabled.sourceId);
  });

  it("rejects malformed, duplicate, and noncanonical enabled configuration opaquely", () => {
    const duplicate = JSON.stringify({ version: 1, connections: [connection, { ...connection, baseUrl: "https://other.example.test" }] });
    for (const raw of [undefined, "not-json", config({ ...connection, apiKey: " browser-key " }),
      config({ ...connection, applicationId: application.toUpperCase() }), duplicate]) {
      expect(() => prepareProjectAlphaApiV2MonitorControlCommand(command(), raw))
        .toThrow(ProjectAlphaApiV2MonitorControlCommandError);
      try { prepareProjectAlphaApiV2MonitorControlCommand(command(), raw); }
      catch (error) { expect(String(error)).not.toContain(connection.apiKey); }
    }
  });

  it("takes a detached configuration snapshot and never accepts caller identities", () => {
    const source = { ...connection };
    const raw = JSON.stringify({ version: 1, connections: [source] });
    const result = prepareProjectAlphaApiV2MonitorControlCommand(command(), raw);
    source.sourceId = "project-alpha:changed";
    expect(result.identities[0]?.sourceId).toBe(connection.sourceId);
    expect(() => prepareProjectAlphaApiV2MonitorControlCommand(
      { expectedRevision: 0, enabled: true, identities: [connection] }, config())).toThrow();
  });
});
