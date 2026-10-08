import { describe, expect, it, vi } from "vitest";
import {
  readConfiguredProjectAlphaProjectAdoptionCandidates, readProjectAlphaProjectAdoptionCandidates,
  type ProjectAlphaProjectAdoptionCandidatesQuery,
} from "../src/worker/project-alpha-project-adoption-candidates-api-v2";

const source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const application = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const epoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const request = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const connection = { baseUrl: "https://alpha.example.test", apiKey: "test-secret",
  expectedSourceInstanceId: source, expectedApplicationId: application, expectedHistoryEpoch: epoch };
const route = { method: "GET", path: "/api/v2/projects/adoption-candidates",
  requiredCapability: "projects.adoption_candidates.read", requiresSourceInstanceId: true,
  requiresApplicationId: true, requiresHistoryEpoch: true };
const candidate = (publicId = "2".repeat(32)) => ({ publicId, revision: "1", projectionSha256: "a".repeat(64),
  name: "Football 2027", status: "not_started", archived: false, organizationPublicId: "1".repeat(32), clientPublicId: null });
const page = () => ({ apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch,
  requestId: request, authorizationGeneration: "3", projects: [candidate()], nextCursor: null });
const capabilities = () => ({ apiVersion: "2", sourceInstanceId: source, applicationId: application,
  historyEpoch: epoch, requestId: request, grantedCapabilities: [{ name: "api.capabilities.read" },
    { name: route.requiredCapability }], implementedEndpoints: [
    { method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" }, route] });
function json(value: unknown, headers: Record<string, string> = {}, raw?: string) {
  return new Response(raw ?? JSON.stringify(value), { headers: { "Content-Type": "application/json",
    "Cache-Control": "no-store", "X-Request-ID": request, ...headers } });
}
function sendPage(value: unknown, headers: Record<string, string> = {}, raw?: string) {
  return vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities")
    ? json(capabilities()) : json(value, headers, raw));
}

describe("PA-created Project discovery transport", () => {
  it("preflights the explicit new scope and sends only bounded GETs with pinned identity", async () => {
  const value = { ...page(), nextCursor: candidate().publicId };
    const send = sendPage(value);
    await expect(readProjectAlphaProjectAdoptionCandidates(connection, { cursor: "1".repeat(32), limit: 1 }, send))
      .resolves.toEqual({ status: "observed", httpStatus: 200, response: value });
    expect(send).toHaveBeenCalledTimes(2);
    expect(String(send.mock.calls[1]![0])).toBe(`https://alpha.example.test${route.path}?limit=1&cursor=${"1".repeat(32)}`);
    for (const [, init] of send.mock.calls) {
      expect(init?.method).toBe("GET"); expect(init?.body).toBeUndefined();
      expect(init?.redirect).toBe("manual");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer test-secret");
    }
    const headers = new Headers(send.mock.calls[1]![1]?.headers);
    expect(headers.get("X-PA-Source-Instance-ID")).toBe(source);
    expect(headers.get("X-PA-Application-ID")).toBe(application);
    expect(headers.get("X-PA-History-Epoch")).toBe(epoch);
  });
  it("keeps disabled configured sources dormant", async () => {
    const send = vi.fn<typeof fetch>();
    const env = { PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: {
      "project-alpha:test": { sourceId: "project-alpha:test", enabled: false, baseUrl: connection.baseUrl,
        apiKey: connection.apiKey, sourceInstanceId: source, applicationId: application, historyEpoch: epoch } } }) };
    await expect(readConfiguredProjectAlphaProjectAdoptionCandidates(env, "project-alpha:test", {}, send))
      .resolves.toEqual({ status: "disabled", sourceId: "project-alpha:test" });
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects invalid queries without fetching", async () => {
    const send = vi.fn<typeof fetch>();
    for (const query of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { cursor: "external-project-id" },
      { cursor: "A".repeat(32) }, { extra: true }, null, []]) {
      await expect(readProjectAlphaProjectAdoptionCandidates(connection,
        query as ProjectAlphaProjectAdoptionCandidatesQuery, send)).resolves.toEqual({ status: "rejected", reason: "invalid_command" });
    }
    expect(send).not.toHaveBeenCalled();
  });
  it("does not substitute inventory permission for discovery permission", async () => {
    const metadata = capabilities(); metadata.grantedCapabilities = [{ name: "api.capabilities.read" }, { name: "projects.inventory.read" }];
    const send = vi.fn<typeof fetch>(async () => json(metadata));
    await expect(readProjectAlphaProjectAdoptionCandidates(connection, {}, send)).resolves.toMatchObject({ status: "blocked", reason: "preflight" });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("rejects lineage, request correlation, privacy and pagination contract drift", async () => {
    const mutations: ((value: ReturnType<typeof page>) => unknown)[] = [
      value => ({ ...value, historyEpoch: source }), value => ({ ...value, applicationId: source }),
      value => ({ ...value, sourceInstanceId: application }), value => ({ ...value, requestId: source }),
      value => ({ ...value, authorizationGeneration: "03" }),
      value => ({ ...value, projects: [{ ...candidate(), externalId: "secret-binding" }] }),
      value => ({ ...value, projects: [{ ...candidate(), archived: true }] }),
      value => ({ ...value, projects: [{ ...candidate(), clientPublicId: "bad" }] }),
      value => ({ ...value, projects: [{ ...candidate(), status: "overdue" }] }),
      value => ({ ...value, projects: [{ ...candidate(), name: "x".repeat(151) }] }),
      value => ({ ...value, projects: [candidate(), candidate()] }),
      value => ({ ...value, projects: [candidate("1".repeat(32))] }),
      value => ({ ...value, nextCursor: "f".repeat(32) }),
      value => ({ ...value, projects: [], nextCursor: "2".repeat(32) }),
    ];
    for (const mutate of mutations) {
      await expect(readProjectAlphaProjectAdoptionCandidates(connection, { cursor: "1".repeat(32), limit: 1 }, sendPage(mutate(page()))))
        .resolves.toMatchObject({ status: "uncertain", reason: "invalid_contract" });
    }
  });
  it("rejects unsafe response headers, duplicate JSON and oversized bodies", async () => {
    const unsafeHeaders: Record<string, string>[] = [{ "Set-Cookie": "untrusted=value" }, { Location: "https://evil.example" },
      { "Cache-Control": "public" }, { "Content-Type": "text/html" }];
    for (const headers of unsafeHeaders) {
      await expect(readProjectAlphaProjectAdoptionCandidates(connection, {}, sendPage(page(), headers)))
        .resolves.toMatchObject({ status: "uncertain", reason: "invalid_contract" });
    }
    const raw = JSON.stringify(page()).replace('"apiVersion":"2"', '"apiVersion":"2","apiVersion":"2"');
    await expect(readProjectAlphaProjectAdoptionCandidates(connection, {}, sendPage(null, {}, raw)))
      .resolves.toMatchObject({ status: "uncertain", reason: "invalid_contract" });
    await expect(readProjectAlphaProjectAdoptionCandidates(connection, {}, sendPage(null, {}, " ".repeat(262145))))
      .resolves.toMatchObject({ status: "uncertain", reason: "response_limit" });
  });
  it("reports conflicts without creating authority or retaining arbitrary error bodies", async () => {
    const send = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? json(capabilities())
      : new Response("private diagnostic must not escape", { status: 409, headers: { "X-Request-ID": request } }));
    await expect(readProjectAlphaProjectAdoptionCandidates(connection, {}, send))
      .resolves.toEqual({ status: "conflict", reason: "http_status", httpStatus: 409, requestId: request });
  });
});
