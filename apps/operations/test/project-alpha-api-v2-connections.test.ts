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
