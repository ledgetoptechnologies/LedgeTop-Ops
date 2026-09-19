import { describe, expect, it, vi } from "vitest";
import {
  readConfiguredProjectAlphaDirectoryBindingStatus,
  readConfiguredProjectAlphaDirectoryProfile,
} from "../src/worker/project-alpha-directory-read-api-v2";

const sourceA = "project-alpha:source-a", sourceB = "project-alpha:source-b";
const ids = {
  a: { source: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", application: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", epoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
  b: { source: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", application: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", epoch: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
};
const requestId = "11111111-1111-4111-8111-111111111111", clientId = "1".repeat(32), organizationId = "2".repeat(32);
function env(enabled = true) {
  const entry = (sourceId: string, identity: typeof ids.a, baseUrl: string) => ({ sourceId, enabled, baseUrl, apiKey: `not-to-be-returned-${sourceId}`,
    sourceInstanceId: identity.source, applicationId: identity.application, historyEpoch: identity.epoch });
  return { PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: {
    [sourceA]: entry(sourceA, ids.a, "https://source-a.example.test"), [sourceB]: entry(sourceB, ids.b, "https://source-b.example.test"),
  } }) };
}
function endpoint(kind: "client" | "organization", binding = false) {
  const plural = kind === "client" ? "clients" : "organizations";
  return binding
    ? { method: "GET", path: `/api/v2/bindings/${kind}/status/{base64urlExternalId}`, requiredCapability: `directory.${plural}.binding_status.read`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true }
    : { method: "GET", path: `/api/v2/directory/${plural}/{publicId}`, requiredCapability: `directory.${plural}.read`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
}
function capabilities(identity: typeof ids.a, required: ReturnType<typeof endpoint>) {
  return { apiVersion: "2", sourceInstanceId: identity.source, applicationId: identity.application, historyEpoch: identity.epoch, requestId,
    grantedCapabilities: [{ name: "api.capabilities.read" }, { name: required.requiredCapability }],
    implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" }, required] };
}
function profile(identity: typeof ids.a, kind: "client" | "organization" = "client") {
  const data = { publicId: clientId, name: "Example Client", email: "public@example.test", phone: null,
    address: { line1: "1 Main Street", line2: null, city: "Austin", state: "TX", postalCode: "78701", country: "US" } };
  return { apiVersion: "2", sourceInstanceId: identity.source, applicationId: identity.application, historyEpoch: identity.epoch, requestId, authorizationGeneration: "7",
    resource: { type: kind, id: clientId, revision: "8" }, data: kind === "client" ? { ...data, clientType: "business", organizationPublicId: organizationId } : data };
}
function binding(identity: typeof ids.a, publicId = clientId) {
  return { apiVersion: "2", sourceInstanceId: identity.source, historyEpoch: identity.epoch, authorizationGeneration: "7",
    binding: { type: "client", externalId: "ops/client-42", publicId, createdAt: "2026-09-15T12:34:56.789Z" },
    resource: { revision: "8", present: true }, applicationId: identity.application, requestId };
}
function response(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Request-ID": requestId, ...headers } });
}
function json(value: unknown, status = 200, headers: Record<string, string> = {}) { return response(JSON.stringify(value), status, headers); }
function sendFor(identity: typeof ids.a, required: ReturnType<typeof endpoint>, result: Response) {
  return vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? json(capabilities(identity, required)) : result);
}

describe("dormant Project Alpha API-v2 directory reads", () => {
  it("keeps source-keyed reads isolated, negotiates the exact profile route/scope, and returns an explicitly non-authoritative observation", async () => {
    const send = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/capabilities")) return json(capabilities(ids.b, endpoint("client")));
      expect(String(url)).toBe(`https://source-b.example.test/api/v2/directory/clients/${clientId}`);
      expect(init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit", cache: "no-store" });
      const headers = new Headers(init?.headers);
      expect(headers.get("X-PA-Source-Instance-ID")).toBe(ids.b.source);
      expect(headers.get("X-PA-Application-ID")).toBe(ids.b.application);
      expect(headers.get("X-PA-History-Epoch")).toBe(ids.b.epoch);
      return json(profile(ids.b));
    });
    const result = await readConfiguredProjectAlphaDirectoryProfile(env(), sourceB, "client", clientId, send);
    expect(result).toMatchObject({ status: "observed", observation: { authoritative: false, sourceId: sourceB, sourceInstanceId: ids.b.source, profile: { publicId: clientId, clientType: "business" } } });
    expect(JSON.stringify(result)).not.toContain("not-to-be-returned");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not fetch a disabled connection", async () => {
    const send = vi.fn<typeof fetch>(async () => { throw new Error("must not fetch"); });
    await expect(readConfiguredProjectAlphaDirectoryProfile(env(false), sourceA, "client", clientId, send)).resolves.toEqual({ status: "disabled", sourceId: sourceA });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong identity", "invalid_contract", () => json(profile(ids.b))],
    ["redirect", "invalid_contract", () => json(profile(ids.a), 200, { Location: "https://elsewhere.example.test" })],
    ["cookie", "invalid_contract", () => json(profile(ids.a), 200, { "Set-Cookie": "session=forbidden" })],
    ["missing request identity", "invalid_contract", () => json(profile(ids.a), 200, { "X-Request-ID": "" })],
    ["oversize", "response_limit", () => response("{}", 200, { "Content-Length": "65537" })],
    ["malformed JSON", "invalid_contract", () => response("{", 200)],
    ["duplicate JSON", "invalid_contract", () => response(JSON.stringify(profile(ids.a)).replace('"name":', '"name":"shadow","name":'), 200)],
    ["sensitive extension", "invalid_contract", () => json({ ...profile(ids.a), data: { ...profile(ids.a).data, apiKey: "never" } })],
    ["raw numeric PA id", "invalid_contract", () => json({ ...profile(ids.a), resource: { ...profile(ids.a).resource, id: 7 } })],
  ])("fails closed for %s", async (_name, reason, make) => {
    const result = await readConfiguredProjectAlphaDirectoryProfile(env(), sourceA, "client", clientId, sendFor(ids.a, endpoint("client"), make()));
    expect(result).toMatchObject({ status: "uncertain", reason });
  });

  it.each([[404, "not_found"], [410, "tombstoned"], [409, "conflict"]] as const)("returns a non-authoritative %s state for a safe %i response", async (status, expected) => {
    const result = await readConfiguredProjectAlphaDirectoryProfile(env(), sourceA, "client", clientId, sendFor(ids.a, endpoint("client"), json({}, status)));
    expect(result).toEqual({ status: expected });
  });

  it("preflights the exact binding-status route/scope, uses canonical base64url, and rejects remaps instead of promoting them", async () => {
    const required = endpoint("client", true);
    const send = sendFor(ids.a, required, json(binding(ids.a, organizationId)));
    const result = await readConfiguredProjectAlphaDirectoryBindingStatus(env(), sourceA, "client", "ops/client-42", clientId, send);
    expect(result).toMatchObject({ status: "uncertain", reason: "invalid_contract" });
    expect(String(send.mock.calls[1]![0])).toBe("https://source-a.example.test/api/v2/bindings/client/status/b3BzL2NsaWVudC00Mg");
  });

  it("returns only the exact, fenced binding status payload", async () => {
    const result = await readConfiguredProjectAlphaDirectoryBindingStatus(env(), sourceA, "client", "ops/client-42", clientId,
      sendFor(ids.a, endpoint("client", true), json(binding(ids.a))));
    expect(result).toMatchObject({ status: "observed", observation: { authoritative: false, binding: { externalId: "ops/client-42", publicId: clientId, createdAt: "2026-09-15T12:34:56.789Z" }, resource: { revision: "8", present: true }, authorizationGeneration: "7" } });
  });
});
