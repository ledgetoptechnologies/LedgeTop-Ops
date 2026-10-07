import { describe, expect, it } from "vitest";
import { parseProjectAlphaApiV2Connections, ProjectAlphaApiV2ConfigurationError, resolveProjectAlphaApiV2Connection } from "../src/worker/project-alpha-api-v2-config";
import { ProjectAlphaApiV2ConnectionConfigurationError, resolveProjectAlphaApiV2Connection as resolveCommandConnection } from "../src/worker/project-alpha-api-v2-connections";

const source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const application = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const epoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const valid = {
  sourceId: "project-alpha:primary", applicationId: application, baseUrl: "https://alpha.example.test",
  expectedSourceInstanceId: source, expectedHistoryEpoch: epoch, apiKey: "server-only-key",
};
const envelope = (connection: Record<string, unknown> = valid) => JSON.stringify({ version: 1, connections: [connection] });
const request = () => ({ sourceId: valid.sourceId, applicationId: valid.applicationId, baseUrl: valid.baseUrl,
  expectedSourceInstanceId: valid.expectedSourceInstanceId, expectedHistoryEpoch: valid.expectedHistoryEpoch });

describe("Project Alpha API v2 deployment configuration", () => {
  it("parses detached connections and derives the transport application identity", () => {
    const parsed = parseProjectAlphaApiV2Connections(envelope({ ...valid, accessClientId: "access-id", accessClientSecret: "access-secret" }));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ ...valid, expectedApplicationId: application, accessClientId: "access-id", accessClientSecret: "access-secret" });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed[0])).toBe(true);
  });

  it("reads the existing deployment instances envelope without widening its schema", () => {
    const instances = JSON.stringify({ version: 1, instances: {
      [valid.sourceId]: { sourceId: valid.sourceId, enabled: true, baseUrl: valid.baseUrl,
        apiKey: valid.apiKey, sourceInstanceId: valid.expectedSourceInstanceId,
        applicationId: valid.applicationId, historyEpoch: valid.expectedHistoryEpoch },
    } });
    expect(parseProjectAlphaApiV2Connections(instances)[0]).toMatchObject({ ...valid, enabled: true });
    const widened = JSON.stringify({ version: 1, instances: {
      [valid.sourceId]: { sourceId: valid.sourceId, enabled: true, baseUrl: valid.baseUrl,
        apiKey: valid.apiKey, sourceInstanceId: valid.expectedSourceInstanceId,
        applicationId: valid.applicationId, historyEpoch: valid.expectedHistoryEpoch, ignored: true },
    } });
    expect(() => parseProjectAlphaApiV2Connections(widened)).toThrow(ProjectAlphaApiV2ConfigurationError);
  });

  it("uses the same strict identity validation for the monitor and API-v2 command paths", () => {
    const secondSource = "project-alpha:secondary";
    const second = {
      sourceId: secondSource,
      applicationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      baseUrl: "https://beta.example.test",
      expectedSourceInstanceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      expectedHistoryEpoch: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      apiKey: "second-server-only-key",
    };
    const asInstances = (a: typeof valid, b: typeof second) => JSON.stringify({ version: 1, instances: {
      [a.sourceId]: { sourceId: a.sourceId, enabled: true, baseUrl: a.baseUrl, apiKey: a.apiKey,
        sourceInstanceId: a.expectedSourceInstanceId, applicationId: a.applicationId, historyEpoch: a.expectedHistoryEpoch },
      [b.sourceId]: { sourceId: b.sourceId, enabled: true, baseUrl: b.baseUrl, apiKey: b.apiKey,
        sourceInstanceId: b.expectedSourceInstanceId, applicationId: b.applicationId, historyEpoch: b.expectedHistoryEpoch },
    } });
    const invalidPairs = [
      [valid, { ...second, expectedSourceInstanceId: valid.expectedSourceInstanceId, applicationId: valid.applicationId }],
    ] as const;
    for (const [first, next] of invalidPairs) {
      const raw = asInstances(first, next);
      expect(() => parseProjectAlphaApiV2Connections(raw)).toThrow(ProjectAlphaApiV2ConfigurationError);
      expect(() => resolveCommandConnection({ PROJECT_ALPHA_API_V2_CONNECTIONS: raw }, valid.sourceId))
        .toThrow(ProjectAlphaApiV2ConnectionConfigurationError);
    }
    const sharedPaLocalIds = asInstances(valid, { ...second,
      applicationId: valid.applicationId, expectedHistoryEpoch: valid.expectedHistoryEpoch });
    expect(parseProjectAlphaApiV2Connections(sharedPaLocalIds)).toHaveLength(2);
    expect(resolveCommandConnection({ PROJECT_ALPHA_API_V2_CONNECTIONS: sharedPaLocalIds }, valid.sourceId).enabled).toBe(true);
    const sharedOrigin = asInstances(valid, { ...second, baseUrl: valid.baseUrl });
    expect(parseProjectAlphaApiV2Connections(sharedOrigin)).toHaveLength(2);
    expect(resolveCommandConnection({ PROJECT_ALPHA_API_V2_CONNECTIONS: sharedOrigin }, secondSource).enabled).toBe(true);
  });

  it("keeps the legacy monitor fixture's enablement default while canonical instances remain default-off", () => {
    const instances = JSON.stringify({ version: 1, instances: {
      [valid.sourceId]: { sourceId: valid.sourceId, baseUrl: valid.baseUrl, apiKey: valid.apiKey,
        sourceInstanceId: valid.expectedSourceInstanceId, applicationId: valid.applicationId,
        historyEpoch: valid.expectedHistoryEpoch },
    } });
    expect(parseProjectAlphaApiV2Connections(instances)[0]?.enabled).toBe(false);
    expect(parseProjectAlphaApiV2Connections(envelope())[0]?.enabled).toBe(true);
  });

  it("normalizes legacy monitor arrays with multiple independent PA sources", () => {
    const second = { ...valid, sourceId: "project-alpha:secondary",
      baseUrl: "https://beta.example.test", expectedSourceInstanceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" };
    expect(parseProjectAlphaApiV2Connections(JSON.stringify({ version: 1, connections: [valid, second] })))
      .toHaveLength(2);
  });

  it("normalizes UUID casing exactly like the command resolver", () => {
    const upper = JSON.stringify({ version: 1, instances: {
      [valid.sourceId]: { sourceId: valid.sourceId, enabled: true, baseUrl: `${valid.baseUrl}/`, apiKey: valid.apiKey,
        sourceInstanceId: valid.expectedSourceInstanceId.toUpperCase(), applicationId: valid.applicationId.toUpperCase(),
        historyEpoch: valid.expectedHistoryEpoch.toUpperCase() },
    } });
    expect(parseProjectAlphaApiV2Connections(upper)[0]).toMatchObject({
      sourceId: valid.sourceId, enabled: true, baseUrl: valid.baseUrl,
      expectedSourceInstanceId: valid.expectedSourceInstanceId,
      applicationId: valid.applicationId, expectedApplicationId: valid.applicationId,
      expectedHistoryEpoch: valid.expectedHistoryEpoch,
    });
  });

  it("requires a strict bounded envelope and canonical UUIDv4 identities", () => {
    for (const raw of [undefined, "", "not-json", JSON.stringify({ version: 2, connections: [] }),
      JSON.stringify({ version: 1, connections: [{ ...valid, extra: true }] }),
      envelope({ ...valid, baseUrl: "https://alpha.example.test/api" }),
      envelope({ ...valid, baseUrl: "http://alpha.example.test" }),
      envelope({ ...valid, baseUrl: "https://user:password@alpha.example.test" }),
      envelope({ ...valid, baseUrl: "https://alpha.example.test?query=1" }),
      envelope({ ...valid, apiKey: " \r\n" }),
      envelope({ ...valid, apiKey: " surrounding-space " }),
      envelope({ ...valid, apiKey: "ключ" }),
      envelope({ ...valid, accessClientId: "id" }),
      envelope({ ...valid, accessClientId: " id", accessClientSecret: "secret" }),
      envelope({ ...valid, accessClientId: "ключ", accessClientSecret: "secret" }),
      envelope({ ...valid, accessClientId: "", accessClientSecret: "secret" })]) {
      expect(() => parseProjectAlphaApiV2Connections(raw)).toThrow(ProjectAlphaApiV2ConfigurationError);
    }
    const tooMany = Array.from({ length: 65 }, (_, index) => ({ ...valid,
      sourceId: `project-alpha:source-${index}`, expectedSourceInstanceId: `${String(index).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa` }));
    expect(() => parseProjectAlphaApiV2Connections(JSON.stringify({ version: 1, connections: tooMany })))
      .toThrow(ProjectAlphaApiV2ConfigurationError);
    expect(() => parseProjectAlphaApiV2Connections("x".repeat(256 * 1024 + 1))).toThrow(ProjectAlphaApiV2ConfigurationError);
  });

  it("rejects duplicate source IDs and source UUID/application pairs", () => {
    const duplicateSource = JSON.stringify({ version: 1, connections: [valid, { ...valid, expectedSourceInstanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }] });
    const duplicatePair = JSON.stringify({ version: 1, connections: [valid, { ...valid, sourceId: "project-alpha:secondary" }] });
    expect(() => parseProjectAlphaApiV2Connections(duplicateSource)).toThrow(ProjectAlphaApiV2ConfigurationError);
    expect(() => parseProjectAlphaApiV2Connections(duplicatePair)).toThrow(ProjectAlphaApiV2ConfigurationError);
  });

  it("matches every durable identity and never falls back by name", () => {
    const config = resolveProjectAlphaApiV2Connection(envelope(), request());
    expect(config.apiKey).toBe(valid.apiKey);
    for (const changed of [
      { sourceId: "project-alpha:other" }, { applicationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
      { baseUrl: "https://other.example.test" }, { expectedSourceInstanceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
      { expectedHistoryEpoch: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
    ]) expect(() => resolveProjectAlphaApiV2Connection(envelope(), { ...request(), ...changed })).toThrow(ProjectAlphaApiV2ConfigurationError);
  });

  it("keeps errors opaque and does not echo a configured secret", () => {
    const secret = "do-not-echo-this-key";
    try { resolveProjectAlphaApiV2Connection(envelope({ ...valid, apiKey: secret }), { ...request(), applicationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }); }
    catch (error) {
      expect(error).toBeInstanceOf(ProjectAlphaApiV2ConfigurationError);
      expect(String(error)).not.toContain(secret);
    }
  });

  it("snapshots requested metadata without invoking accessors or accepting proxy failures", () => {
    let reads = 0;
    const accessor = {};
    Object.defineProperty(accessor, "sourceId", { enumerable: true, get: () => { reads += 1; return valid.sourceId; } });
    for (const requested of [accessor, { ...request(), [Symbol("extra")]: true },
      Object.defineProperty({ ...request() }, "extra", { enumerable: false, value: true }),
      Object.defineProperty({ ...request() }, "__proto__", { enumerable: true, value: "unexpected" }), null]) {
      expect(() => resolveProjectAlphaApiV2Connection(envelope(), requested as never)).toThrow(ProjectAlphaApiV2ConfigurationError);
    }
    expect(reads).toBe(0);
    const broken = new Proxy(request(), { getPrototypeOf: () => { throw new Error("proxy detail"); } });
    expect(() => resolveProjectAlphaApiV2Connection(envelope(), broken)).toThrow(ProjectAlphaApiV2ConfigurationError);
    try { resolveProjectAlphaApiV2Connection(envelope(), broken); } catch (error) {
      expect(String(error)).not.toContain("proxy detail");
    }
  });
});
