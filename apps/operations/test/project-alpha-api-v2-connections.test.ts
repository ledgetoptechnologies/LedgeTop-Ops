import { describe, expect, it, vi } from "vitest";
import {
  ProjectAlphaApiV2ConnectionConfigurationError,
  probeConfiguredProjectAlphaApiV2Connection,
  resolveProjectAlphaApiV2Connection,
} from "../src/worker/project-alpha-api-v2-connections";

const first = "project-alpha:source-a";
const second = "project-alpha:source-b";
const ids = {
  first: { source: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", application: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", epoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
  second: { source: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", application: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", epoch: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
};
function entry(sourceId: string, value: typeof ids.first, baseUrl: string, enabled?: boolean) {
  return { sourceId, ...(enabled === undefined ? {} : { enabled }), baseUrl, apiKey: `secret-for-${sourceId}`,
    sourceInstanceId: value.source, applicationId: value.application, historyEpoch: value.epoch };
}
function environment(instances: Record<string, unknown>) {
  return { PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances }) };
}
function rawEnvironment(raw: string) { return { PROJECT_ALPHA_API_V2_CONNECTIONS: raw }; }
function metadata(value: typeof ids.first) {
  return { apiVersion: "2", sourceInstanceId: value.source, applicationId: value.application, historyEpoch: value.epoch,
    requestId: "11111111-1111-4111-8111-111111111111", grantedCapabilities: [{ name: "api.capabilities.read" }],
    implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" }] };
}

describe("deployment-owned Project Alpha API-v2 connections", () => {
  it("resolves isolated source-keyed instances and defaults omitted enablement to false", () => {
    const env = environment({ [first]: entry(first, ids.first, "https://source-a.example.test"), [second]: entry(second, ids.second, "https://source-b.example.test", true) });
    const one = resolveProjectAlphaApiV2Connection(env, first);
    const two = resolveProjectAlphaApiV2Connection(env, second);
    expect(one).toMatchObject({ sourceId: first, enabled: false, connection: { baseUrl: "https://source-a.example.test", expectedSourceInstanceId: ids.first.source } });
    expect(two).toMatchObject({ sourceId: second, enabled: true, connection: { baseUrl: "https://source-b.example.test", expectedSourceInstanceId: ids.second.source } });
    expect(one.connection).not.toHaveProperty("apiKey");
    expect(JSON.stringify(one)).not.toContain(`secret-for-${first}`);
    expect(one.connection).not.toEqual(two.connection);
  });

  it("never calls the network for a disabled instance", async () => {
    const send = vi.fn<typeof fetch>(async () => { throw new Error("network must remain unused"); });
    const result = await probeConfiguredProjectAlphaApiV2Connection(environment({ [first]: entry(first, ids.first, "https://source-a.example.test", false) }), first, [], send);
    expect(result).toEqual({ status: "disabled", sourceId: first });
    expect(send).not.toHaveBeenCalled();
  });

  it("permits an explicit enabled caller to use the existing capability probe without exposing a key", async () => {
    const secret = `secret-for-${first}`;
    const send = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(metadata(ids.first)), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Request-ID": "11111111-1111-4111-8111-111111111111" } }));
    const result = await probeConfiguredProjectAlphaApiV2Connection(environment({ [first]: entry(first, ids.first, "https://source-a.example.test", true) }), first, [], send);
    expect(result).toMatchObject({ status: "verified", sourceInstanceId: ids.first.source.toLowerCase() });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(String(send.mock.calls[0]![0])).toBe("https://source-a.example.test/api/v2/capabilities");
  });

  it.each([
    " leading", "trailing ", "internal space", "tab\tinside", "line\nbreak", "carriage\rreturn", "nul\0byte", "delete\u007fbyte", "caf\u00e9",
  ])("rejects header-unsafe API-key values", value => {
    expect(() => resolveProjectAlphaApiV2Connection(environment({ [first]: { ...entry(first, ids.first, "https://source-a.example.test"), apiKey: value } }), first))
      .toThrow(ProjectAlphaApiV2ConnectionConfigurationError);
  });

  it("rejects duplicate JSON members before JSON.parse can retain a last value", () => {
    const item = JSON.stringify(entry(first, ids.first, "https://source-a.example.test"));
    const complete = environment({ [first]: entry(first, ids.first, "https://source-a.example.test") }).PROJECT_ALPHA_API_V2_CONNECTIONS!;
    const duplicateRootInstances = complete.replace('"instances":', '"instances":{},"instances":');
    const duplicateAlias = `{"version":1,"instances":{"${first}":${item},"${first}":${item}}}`;
    const duplicateApiKey = item.replace('"apiKey":', String.raw`"\u0061piKey":"shadow","apiKey":`);
    const duplicateBaseUrl = item.replace('"baseUrl":', '"baseUrl":"https://shadow.example.test","baseUrl":');
    const duplicateHistoryEpoch = item.replace('"historyEpoch":', '"historyEpoch":"11111111-1111-4111-8111-111111111111","historyEpoch":');
    for (const raw of [
      duplicateRootInstances,
      duplicateAlias,
      `{"version":1,"instances":{"${first}":${duplicateApiKey}}}`,
      `{"version":1,"instances":{"${first}":${duplicateBaseUrl}}}`,
      `{"version":1,"instances":{"${first}":${duplicateHistoryEpoch}}}`,
    ]) expect(() => resolveProjectAlphaApiV2Connection(rawEnvironment(raw), first)).toThrow(ProjectAlphaApiV2ConnectionConfigurationError);
  });

  it("sanitizes throwing environment, proxy, and parsed-object traps", () => {
    const secret = "trap-detail-must-not-escape";
    const accessor = Object.create(null, { PROJECT_ALPHA_API_V2_CONNECTIONS: { enumerable: true, get() { throw new Error(secret); } } });
    const proxy = new Proxy({}, { get() { throw new Error(secret); } });
    for (const env of [accessor, proxy]) {
      try { resolveProjectAlphaApiV2Connection(env as never, first); throw new Error("expected rejection"); }
      catch (error) { expect(error).toBeInstanceOf(ProjectAlphaApiV2ConnectionConfigurationError); expect(String(error)).not.toContain(secret); }
    }
    const configured = environment({ [first]: entry(first, ids.first, "https://source-a.example.test") });
    const raw = configured.PROJECT_ALPHA_API_V2_CONNECTIONS!;
    const parse = JSON.parse;
    const spy = vi.spyOn(JSON, "parse").mockImplementation(((value: string) => value === raw
      ? new Proxy({}, { getPrototypeOf() { throw new Error(secret); } }) : parse(value)) as typeof JSON.parse);
    try {
      expect(() => resolveProjectAlphaApiV2Connection(configured, first)).toThrow(ProjectAlphaApiV2ConnectionConfigurationError);
    } finally { spy.mockRestore(); }
  });

  it.each([
    () => ({ version: 2, instances: {} }),
    () => ({ version: 1, instances: { [first]: { ...entry(first, ids.first, "https://source-a.example.test"), extra: true } } }),
    () => ({ version: 1, instances: { [first]: entry(first, ids.first, "http://source-a.example.test") } }),
    () => ({ version: 1, instances: { [first]: entry(first, ids.first, "https://source-a.example.test/path") } }),
    () => ({ version: 1, instances: { [first]: entry(first, ids.first, "https://source-a.example.test?") } }),
    () => ({ version: 1, instances: { [first]: entry(first, ids.first, "https://source-a.example.test#") } }),
    () => ({ version: 1, instances: { [first]: entry(first, ids.first, "https://user@source-a.example.test") } }),
    () => ({ version: 1, instances: { [first]: { ...entry(first, ids.first, "https://source-a.example.test"), enabled: "false" } } }),
    () => ({ version: 1, instances: { [first]: { ...entry(first, ids.first, "https://source-a.example.test"), sourceInstanceId: "not-a-uuid" } } }),
    () => ({ version: 1, instances: { [first]: { ...entry(first, ids.first, "https://source-a.example.test"), applicationId: "not-a-uuid" } } }),
    () => ({ version: 1, instances: { [first]: { ...entry(first, ids.first, "https://source-a.example.test"), historyEpoch: "not-a-uuid" } } }),
    () => ({ version: 1, instances: { [first]: { ...entry(first, ids.first, "https://source-a.example.test"), apiKey: " \t" } } }),
    () => ({ version: 1, instances: { "project-alpha:": entry("project-alpha:", ids.first, "https://source-a.example.test") } }),
    () => ({ version: 1, instances: { "wrong:source": entry("wrong:source", ids.first, "https://source-a.example.test") } }),
    () => ({ version: 1, instances: { "project-alpha:repeated:colon": entry("project-alpha:repeated:colon", ids.first, "https://source-a.example.test") } }),
    () => ({ version: 1, instances: { [`project-alpha:${"a".repeat(65)}`]: entry(`project-alpha:${"a".repeat(65)}`, ids.first, "https://source-a.example.test") } }),
    () => ({ version: 1, instances: { [first]: entry(first, ids.first, "https://source-a.example.test"), [second]: entry(second, ids.second, "https://source-a.example.test") } }),
    () => ({ version: 1, instances: { [first]: entry(first, ids.first, "https://source-a.example.test"), [second]: entry(second, { ...ids.second, source: ids.first.source }, "https://source-b.example.test") } }),
    () => ({ version: 1, instances: { [first]: entry(first, ids.first, "https://source-a.example.test"), [second]: entry(second, { ...ids.second, application: ids.first.application }, "https://source-b.example.test") } }),
    () => ({ version: 1, instances: { [first]: entry(first, ids.first, "https://source-a.example.test"), [second]: entry(second, { ...ids.second, epoch: ids.first.epoch }, "https://source-b.example.test") } }),
    () => ({ version: 1, instances: { [first]: entry(first, ids.first, "https://source-a.example.test"), [second]: entry(first, ids.second, "https://source-b.example.test") } }),
  ])("rejects malformed, non-origin, duplicate, and unknown configuration", make => {
    const env = { PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify(make()) };
    expect(() => resolveProjectAlphaApiV2Connection(env, first)).toThrow(ProjectAlphaApiV2ConnectionConfigurationError);
  });

  it("fails closed for absent, oversized, and unavailable source configuration without a fetch", async () => {
    const send = vi.fn<typeof fetch>();
    for (const env of [
      {},
      { PROJECT_ALPHA_API_V2_CONNECTIONS: "x".repeat(256 * 1024 + 1) },
      environment({ [first]: entry(first, ids.first, "https://source-a.example.test") }),
    ]) {
      expect(await probeConfiguredProjectAlphaApiV2Connection(env, second, [], send)).toEqual({ status: "misconfigured", reason: "configuration" });
    }
    expect(send).not.toHaveBeenCalled();
  });
});
