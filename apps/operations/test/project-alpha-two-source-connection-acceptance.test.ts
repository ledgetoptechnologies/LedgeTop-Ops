import { describe, expect, it, vi } from "vitest";
import { probeConfiguredProjectAlphaApiV2Connection, withEnabledConfiguredProjectAlphaApiV2Connection, parseProjectAlphaApiV2ConnectionConfigurations } from "../src/worker/project-alpha-api-v2-connections";

const first = "project-alpha:staging", second = "project-alpha:source-2-staging";
const sources = {
  [first]: { sourceId: first, enabled: true, baseUrl: "https://pa-staging.ledgetoptechnologies.com",
    sourceInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", applicationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    historyEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", apiKey: "synthetic-first-key" },
  [second]: { sourceId: second, enabled: true, baseUrl: "https://pa-stage-two.ledgetoptechnologies.com",
    sourceInstanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", applicationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    historyEpoch: "ffffffff-ffff-4fff-8fff-ffffffffffff", apiKey: "synthetic-second-key" },
};
const scopes = ["api.capabilities.read", "directory.inventory.read", "projects.inventory.read"];
const routes = [
  { method: "GET", path: "/api/v2/capabilities", requiredCapability: scopes[0]! },
  { method: "GET", path: "/api/v2/directory/inventory", requiredCapability: scopes[1]! },
  { method: "GET", path: "/api/v2/projects/inventory", requiredCapability: scopes[2]! },
];
const env = (instances: Record<string, unknown> = sources) => ({ PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances }) });
function response(source: typeof sources[keyof typeof sources], granted = scopes) {
  return new Response(JSON.stringify({ apiVersion: "2", sourceInstanceId: source.sourceInstanceId,
    applicationId: source.applicationId, historyEpoch: source.historyEpoch,
    requestId: "11111111-1111-4111-8111-111111111111", grantedCapabilities: granted.map(name => ({ name })),
    implementedEndpoints: routes }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store",
    "X-Request-ID": "11111111-1111-4111-8111-111111111111" } });
}
const probe = (source: string, send: typeof fetch, configuration = env()) =>
  probeConfiguredProjectAlphaApiV2Connection(configuration, source, scopes, send, routes);

describe("two-source staging connection acceptance (synthetic transport)", () => {
  it("accepts the versioned operator profile's credential envelope through the actual runtime parser", async () => {
    const modulePath = new URL("../../../scripts/staging-ops-two-source-connection-profile-v1.mjs", import.meta.url).href;
    const profile = await import(modulePath);
    const metadata = { profile: profile.PROFILE, version: 1, sources: Object.fromEntries(
      ([first, second] as const).map((sourceId, index) => {
        const { apiKey, ...source } = sources[sourceId];
        return [index === 0 ? "stageOne" : "stageTwo", { ...source, scopes }];
      })) };
    const credentials = Object.fromEntries(Object.values(sources).map(source => [source.sourceId, { apiKey: source.apiKey }]));
    const raw = profile.buildTwoSourceStagingConnectionSecret(metadata, credentials);
    const parsed = parseProjectAlphaApiV2ConnectionConfigurations({ PROJECT_ALPHA_API_V2_CONNECTIONS: raw });
    expect(parsed.map(source => source.sourceId)).toEqual([first, second]);
    expect(parsed.map(source => source.baseUrl)).toEqual(Object.values(sources).map(source => source.baseUrl));
    metadata.sources.stageTwo!.applicationId = sources[first].applicationId;
    metadata.sources.stageTwo!.historyEpoch = sources[first].historyEpoch;
    expect(parseProjectAlphaApiV2ConnectionConfigurations({ PROJECT_ALPHA_API_V2_CONNECTIONS:
      profile.buildTwoSourceStagingConnectionSecret(metadata, credentials) })).toHaveLength(2);
  });

  it("pins each probe to its own origin, credential and identity while retaining the Stage One compatibility origin", async () => {
    const send = vi.fn<typeof fetch>(async (url, init) => {
      const selected = Object.values(sources).find(source => String(url) === `${source.baseUrl}/api/v2/capabilities`)!;
      expect(selected).toBeDefined();
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${selected.apiKey}`);
      expect(headers.get("CF-Access-Client-Secret")).toBeNull();
      expect(init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
      return response(selected);
    });
    for (const source of [first, second] as const) {
      const result = await probe(source, send);
      expect(result).toMatchObject({ status: "verified", sourceInstanceId: sources[source]!.sourceInstanceId,
        applicationId: sources[source]!.applicationId, historyEpoch: sources[source]!.historyEpoch });
      expect(JSON.stringify(result)).not.toContain("synthetic-");
    }
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each(["sourceInstanceId", "applicationId", "historyEpoch"] as const)("rejects crossed %s without trying the healthy sibling", async field => {
    const send = vi.fn<typeof fetch>(async () => response({ ...sources[second]!, [field]: sources[first]![field] }));
    expect(await probe(second, send)).toMatchObject({ status: "incompatible" });
    expect(send).toHaveBeenCalledOnce();
    expect(String(send.mock.calls[0]![0])).toBe(`${sources[second]!.baseUrl}/api/v2/capabilities`);
  });

  it("keeps missing scopes and unavailable sources independent, then permits recovery with the same pin", async () => {
    const send = vi.fn<typeof fetch>();
    send.mockResolvedValueOnce(response(sources[second]!, [scopes[0]!]))
      .mockRejectedValueOnce(new Error("private-provider-detail"))
      .mockResolvedValueOnce(response(sources[first]!))
      .mockResolvedValueOnce(response(sources[second]!));
    expect(await probe(second, send)).toMatchObject({ status: "unauthorized", reason: "missing_capability" });
    const offline = await probe(second, send);
    expect(offline).toEqual({ status: "unavailable", reason: "transport" });
    expect(JSON.stringify(offline)).not.toContain("private-provider-detail");
    expect(await probe(first, send)).toMatchObject({ status: "verified" });
    expect(await probe(second, send)).toMatchObject({ status: "verified", historyEpoch: sources[second]!.historyEpoch });
    expect(send.mock.calls.map(call => String(call[0]))).toEqual(([second, second, first, second] as const)
      .map(source => `${sources[source]!.baseUrl}/api/v2/capabilities`));
  });

  it("does not probe or dispatch a disabled sibling and still resolves the enabled source", async () => {
    const configuration = env({ ...sources, [second]: { ...sources[second], enabled: false } });
    const send = vi.fn<typeof fetch>(async () => response(sources[first]!));
    const writer = vi.fn(async () => "acknowledged");
    expect(await probe(second, send, configuration)).toEqual({ status: "disabled", sourceId: second });
    expect(await withEnabledConfiguredProjectAlphaApiV2Connection(configuration, second, writer))
      .toEqual({ status: "disabled", sourceId: second });
    expect(send).not.toHaveBeenCalled(); expect(writer).not.toHaveBeenCalled();
    expect(await probe(first, send, configuration)).toMatchObject({ status: "verified" });
  });

  it.each([true, false])("rejects a malformed sibling even when sibling enabled=%s, before any network or dispatch", async enabled => {
    const configuration = env({ ...sources, [second]: { ...sources[second], enabled, apiKey: "malformed key" } });
    const send = vi.fn<typeof fetch>(), writer = vi.fn(async () => "must-not-run");
    for (const source of [first, second]) {
      expect(await probe(source, send, configuration)).toEqual({ status: "misconfigured", reason: "configuration" });
      expect(await withEnabledConfiguredProjectAlphaApiV2Connection(configuration, source, writer)).toEqual({ status: "misconfigured" });
    }
    expect(send).not.toHaveBeenCalled(); expect(writer).not.toHaveBeenCalled();
  });
});
