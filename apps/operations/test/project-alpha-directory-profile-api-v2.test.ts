import { describe, expect, it, vi } from "vitest";
import {
  sendConfiguredProjectAlphaDirectoryCreate,
  sendProjectAlphaDirectoryCreate,
  sendProjectAlphaDirectoryProfileUpdate,
  validatedProjectAlphaDirectoryCreateGenerationConflict,
  type ProjectAlphaDirectoryClientCreateCommand,
  type ProjectAlphaDirectoryClientCreateProfile,
  type ProjectAlphaDirectoryClientUpdateProfile,
  type ProjectAlphaDirectoryOrganizationProfile,
  type ProjectAlphaDirectoryProfileUpdateCommand,
} from "../src/worker/project-alpha-directory-profile-api-v2";
import type { ProjectAlphaApiV2Endpoint } from "../src/worker/project-alpha-api-v2";

const sourceId = "project-alpha:source-a";
const source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const application = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const epoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const requestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const commandId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const clientId = "1".repeat(32);
const organizationId = "2".repeat(32);
const connection = { baseUrl: "https://source-a.example.test", apiKey: "transport-secret", expectedSourceInstanceId: source, expectedApplicationId: application, expectedHistoryEpoch: epoch };
const env = { PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: { [sourceId]: { sourceId, enabled: true, baseUrl: connection.baseUrl, apiKey: connection.apiKey, sourceInstanceId: source, applicationId: application, historyEpoch: epoch } } }) };
const organizationProfile: ProjectAlphaDirectoryOrganizationProfile = { name: "Example Organization", generalEmail: "org@example.test", generalPhone: "512-555-0100", addressLine1: "1 Main Street", addressLine2: "", city: "Austin", state: "TX", postalCode: "78701", country: "US" };
const clientProfile: ProjectAlphaDirectoryClientCreateProfile = { name: "Example Client", email: "client@example.test", phone: "512-555-0101", clientType: "business", addressLine1: "2 Main Street", addressLine2: "", city: "Austin", state: "TX", postalCode: "78702", country: "US" };
const clientUpdateProfile: ProjectAlphaDirectoryClientUpdateProfile = { name: "Example Client Updated", email: "client@example.test", phone: "512-555-0101", addressLine1: "2 Main Street", addressLine2: "", city: "Austin", state: "TX", postalCode: "78702", country: "US" };

function endpoint(kind: "client" | "organization", operation: "create" | "update"): ProjectAlphaApiV2Endpoint {
  const plural = kind === "client" ? "clients" : "organizations";
  return operation === "create"
    ? { method: "POST", path: `/api/v2/directory/${plural}/commands`, requiredCapability: `directory.${plural}.create`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true }
    : { method: "POST", path: `/api/v2/directory/${plural}/{publicId}/profile/commands`, requiredCapability: `directory.${plural}.write`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
}
function capabilities(required: ProjectAlphaApiV2Endpoint, extraGrantedCapabilities: string[] = []) {
  return { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId,
    grantedCapabilities: [{ name: "api.capabilities.read" }, { name: required.requiredCapability }, ...extraGrantedCapabilities.map(name => ({ name }))],
    implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" }, required] };
}
function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Request-ID": requestId, ...headers } });
}
function updateReceipt(kind: "client" | "organization", publicId: string, revision = "2", generation = "7") {
  return { sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId, replayed: false, result: { resource: { type: kind, publicId, revision }, authorizationGeneration: generation } };
}
function createReceipt(kind: "client" | "organization", externalId: string, publicId: string, replayed = false, generation = "1") {
  return { sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId, replayed, result: { resource: { type: kind, id: externalId, publicId, revision: "1" }, authorizationGeneration: generation } };
}

describe("Project Alpha API-v2 Directory profile transport", () => {
  const staleEnvelope = () => ({ apiVersion: "2", sourceInstanceId: source, applicationId: application,
    historyEpoch: epoch, requestId, error: { code: "authorization_generation_conflict" } });
  const staleCommand: ProjectAlphaDirectoryClientCreateCommand = { commandId, externalId: "ops/client/stale",
    expectedAuthorizationGeneration: "7", profile: clientProfile, organization: null };
  function staleTransport(make: () => Response): typeof fetch {
    return vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities")
      ? json(capabilities(endpoint("client", "create"))) : make());
  }
  it("retains only an exact, trusted create-generation discriminator with unforgeable transport evidence", async () => {
    const outcome = await sendProjectAlphaDirectoryCreate(connection, "client", staleCommand,
      staleTransport(() => json(staleEnvelope(), 409)));
    expect(outcome).toEqual({ status: "conflict", reason: "http_status", httpStatus: 409, requestId,
      errorCode: "authorization_generation_conflict" });
    expect(validatedProjectAlphaDirectoryCreateGenerationConflict(outcome)).toEqual({ commandJson: JSON.stringify(staleCommand),
      destinationOrigin: connection.baseUrl, requestId, sourceInstanceId: source, applicationId: application, historyEpoch: epoch });
    expect(validatedProjectAlphaDirectoryCreateGenerationConflict({ ...outcome })).toBeNull();
    expect(validatedProjectAlphaDirectoryCreateGenerationConflict(null)).toBeNull();
  });
  it.each([
    ["empty", () => new Response("", { status: 409, headers: json(null).headers })],
    ["malformed", () => new Response("{", { status: 409, headers: json(null).headers })],
    ["duplicate key", () => new Response(JSON.stringify(staleEnvelope()).replace('"apiVersion":"2"', '"apiVersion":"2","apiVersion":"2"'), { status: 409, headers: json(null).headers })],
    ["unknown code", () => json({ ...staleEnvelope(), error: { code: "external_id_conflict" } }, 409)],
    ["extra key", () => json({ ...staleEnvelope(), detail: "untrusted upstream text" }, 409)],
    ["extra error key", () => json({ ...staleEnvelope(), error: { code: "authorization_generation_conflict", detail: "private" } }, 409)],
    ["wrong version", () => json({ ...staleEnvelope(), apiVersion: "3" }, 409)],
    ["wrong source", () => json({ ...staleEnvelope(), sourceInstanceId: commandId }, 409)],
    ["wrong application", () => json({ ...staleEnvelope(), applicationId: commandId }, 409)],
    ["wrong epoch", () => json({ ...staleEnvelope(), historyEpoch: commandId }, 409)],
    ["wrong request", () => json({ ...staleEnvelope(), requestId: commandId }, 409)],
  ])("does not authorize recovery from %s conflicts", async (_name, make) => {
    const outcome = await sendProjectAlphaDirectoryCreate(connection, "client", staleCommand, staleTransport(make));
    expect(outcome).toEqual({ status: "conflict", reason: "http_status", httpStatus: 409, requestId });
    expect(validatedProjectAlphaDirectoryCreateGenerationConflict(outcome)).toBeNull();
  });
  it.each([
    ["cookie", { "Set-Cookie": "forbidden" }],
    ["redirect", { Location: "https://elsewhere.example.test" }],
    ["cache", { "Cache-Control": "public" }],
    ["content type", { "Content-Type": "text/html" }],
  ])("rejects an otherwise valid discriminator with untrusted %s headers", async (_name, headers) => {
    const outcome = await sendProjectAlphaDirectoryCreate(connection, "client", staleCommand,
      staleTransport(() => json(staleEnvelope(), 409, headers)));
    expect(outcome).toMatchObject({ status: "uncertain", reason: "invalid_contract" });
    expect(validatedProjectAlphaDirectoryCreateGenerationConflict(outcome)).toBeNull();
  });
  it("bounds declared and streamed conflict bodies", async () => {
    for (const make of [() => json(staleEnvelope(), 409, { "Content-Length": "65537" }),
      () => new Response("x".repeat(65537), { status: 409, headers: json(null).headers })]) {
      const outcome = await sendProjectAlphaDirectoryCreate(connection, "client", staleCommand, staleTransport(make));
      expect(outcome).toMatchObject({ status: "uncertain", reason: "response_limit" });
      expect(validatedProjectAlphaDirectoryCreateGenerationConflict(outcome)).toBeNull();
    }
  });

  it("sends the exact PA organization profile update contract and identity fences", async () => {
    const command: ProjectAlphaDirectoryProfileUpdateCommand = { commandId, expectedRevision: "1", expectedAuthorizationGeneration: "7", profile: organizationProfile };
    const send = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/capabilities")) return json(capabilities(endpoint("organization", "update")));
      expect(String(url)).toBe(`https://source-a.example.test/api/v2/directory/organizations/${organizationId}/profile/commands`);
      expect(init).toMatchObject({ method: "POST", redirect: "manual", credentials: "omit", cache: "no-store" });
      expect(JSON.parse(String(init?.body))).toEqual(command);
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer transport-secret");
      expect(headers.get("X-PA-Source-Instance-ID")).toBe(source);
      expect(headers.get("X-PA-Application-ID")).toBe(application);
      expect(headers.get("X-PA-History-Epoch")).toBe(epoch);
      return json(updateReceipt("organization", organizationId));
    });
    await expect(sendProjectAlphaDirectoryProfileUpdate(connection, "organization", organizationId, command, send)).resolves.toMatchObject({ status: "acknowledged", httpStatus: 200, response: { result: { resource: { type: "organization", publicId: organizationId, revision: "2" } } } });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("sends the exact PA client create contract, including the optional relationship field", async () => {
    const command: ProjectAlphaDirectoryClientCreateCommand = { commandId, externalId: "ops/client/42", expectedAuthorizationGeneration: "0", profile: clientProfile, organization: { externalId: "ops/org/9", expectedRevision: "3" } };
    const send = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/capabilities")) return json(capabilities(endpoint("client", "create"), ["directory.clients.organization.assign"]));
      expect(String(url)).toBe("https://source-a.example.test/api/v2/directory/clients/commands");
      expect(init).toMatchObject({ method: "POST", redirect: "manual", credentials: "omit", cache: "no-store" });
      expect(JSON.parse(String(init?.body))).toEqual(command);
      return json(createReceipt("client", command.externalId, clientId), 201);
    });
    await expect(sendProjectAlphaDirectoryCreate(connection, "client", command, send)).resolves.toMatchObject({ status: "acknowledged", httpStatus: 201, response: { result: { resource: { type: "client", id: command.externalId, publicId: clientId, revision: "1" } } } });
  });

  it("requires the grant-only organization assignment scope before creating an attached client", async () => {
    const command: ProjectAlphaDirectoryClientCreateCommand = { commandId, externalId: "ops/client/without-assignment", expectedAuthorizationGeneration: "0", profile: clientProfile, organization: { externalId: "ops/org/9", expectedRevision: "3" } };
    const send = vi.fn<typeof fetch>(async url => json(capabilities(endpoint("client", "create"))));
    await expect(sendProjectAlphaDirectoryCreate(connection, "client", command, send)).resolves.toMatchObject({
      status: "blocked", reason: "preflight", preflight: { status: "unauthorized", reason: "missing_capability" },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("accepts PA's exact create replay receipt as HTTP 200/replayed", async () => {
    const command: ProjectAlphaDirectoryClientCreateCommand = { commandId, externalId: "ops/client/replay", expectedAuthorizationGeneration: "0", profile: clientProfile, organization: null };
    const send = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? json(capabilities(endpoint("client", "create"))) : json(createReceipt("client", command.externalId, clientId, true), 200));
    await expect(sendProjectAlphaDirectoryCreate(connection, "client", command, send)).resolves.toMatchObject({ status: "acknowledged", httpStatus: 200, response: { replayed: true } });
  });

  it("uses the PA client update profile shape without clientType", async () => {
    const command: ProjectAlphaDirectoryProfileUpdateCommand = { commandId, expectedRevision: "9", expectedAuthorizationGeneration: "7", profile: clientUpdateProfile };
    const send = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/capabilities")) return json(capabilities(endpoint("client", "update")));
      const body = JSON.parse(String(init?.body));
      expect(body.profile).toEqual(clientUpdateProfile);
      expect(Object.hasOwn(body.profile, "clientType")).toBe(false);
      return json(updateReceipt("client", clientId, "10"));
    });
    await expect(sendProjectAlphaDirectoryProfileUpdate(connection, "client", clientId, command, send)).resolves.toMatchObject({ status: "acknowledged", response: { result: { resource: { type: "client", revision: "10" } } } });
  });

  it("accepts equal and numerically later revisions, including 10 after 9", async () => {
    const command: ProjectAlphaDirectoryProfileUpdateCommand = { commandId, expectedRevision: "9", expectedAuthorizationGeneration: "7", profile: organizationProfile };
    const send = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? json(capabilities(endpoint("organization", "update"))) : json(updateReceipt("organization", organizationId, "10")));
    await expect(sendProjectAlphaDirectoryProfileUpdate(connection, "organization", organizationId, command, send)).resolves.toMatchObject({ status: "acknowledged", response: { result: { resource: { revision: "10" } } } });
    const equal = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? json(capabilities(endpoint("organization", "update"))) : json({ ...updateReceipt("organization", organizationId, "9"), replayed: true }));
    await expect(sendProjectAlphaDirectoryProfileUpdate(connection, "organization", organizationId, command, equal)).resolves.toMatchObject({ status: "acknowledged", response: { replayed: true } });
  });

  it("is default-off through the configured bridge", async () => {
    const send = vi.fn<typeof fetch>();
    const disabled = { PROJECT_ALPHA_API_V2_CONNECTIONS: env.PROJECT_ALPHA_API_V2_CONNECTIONS!.replace('"enabled":true', '"enabled":false') };
    await expect(sendConfiguredProjectAlphaDirectoryCreate(disabled, sourceId, "organization", { commandId, externalId: "ops/org/1", expectedAuthorizationGeneration: "0", profile: organizationProfile }, send)).resolves.toEqual({ status: "disabled", sourceId });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong identity", () => json({ ...updateReceipt("organization", organizationId), applicationId: "ffffffff-ffff-4fff-8fff-ffffffffffff" })],
    ["redirect", () => json(updateReceipt("organization", organizationId), 200, { Location: "https://elsewhere.example.test" })],
    ["cookie", () => json(updateReceipt("organization", organizationId), 200, { "Set-Cookie": "session=forbidden" })],
    ["missing cache protection", () => new Response(JSON.stringify(updateReceipt("organization", organizationId)), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "X-Request-ID": requestId } })],
    ["malformed JSON", () => new Response("{", { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Request-ID": requestId } })],
  ])("fails closed for %s", async (_name, make) => {
    const command: ProjectAlphaDirectoryProfileUpdateCommand = { commandId, expectedRevision: "1", expectedAuthorizationGeneration: "7", profile: organizationProfile };
    const send = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? json(capabilities(endpoint("organization", "update"))) : make());
    await expect(sendProjectAlphaDirectoryProfileUpdate(connection, "organization", organizationId, command, send)).resolves.toMatchObject({ status: "uncertain", reason: "invalid_contract" });
  });

  it("fails closed when PA reports a different authorization generation for an update", async () => {
    const command: ProjectAlphaDirectoryProfileUpdateCommand = { commandId, expectedRevision: "1", expectedAuthorizationGeneration: "7", profile: organizationProfile };
    const send = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities")
      ? json(capabilities(endpoint("organization", "update")))
      : json(updateReceipt("organization", organizationId, "2", "8")));
    await expect(sendProjectAlphaDirectoryProfileUpdate(connection, "organization", organizationId, command, send)).resolves.toMatchObject({ status: "uncertain", reason: "invalid_contract" });
  });

  it("fails closed when PA reports anything other than expected generation plus one for a create", async () => {
    const command: ProjectAlphaDirectoryClientCreateCommand = { commandId, externalId: "ops/client/generation-mismatch", expectedAuthorizationGeneration: "7", profile: clientProfile, organization: null };
    const send = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities")
      ? json(capabilities(endpoint("client", "create")))
      : json(createReceipt("client", command.externalId, clientId, false, "9"), 201));
    await expect(sendProjectAlphaDirectoryCreate(connection, "client", command, send)).resolves.toMatchObject({ status: "uncertain", reason: "invalid_contract" });
  });

  it("rejects stale, malformed, overlong, and mismatched idempotency commands before fetch", async () => {
    const send = vi.fn<typeof fetch>();
    await expect(sendProjectAlphaDirectoryProfileUpdate(connection, "organization", organizationId, { commandId: "bad", expectedRevision: "1", expectedAuthorizationGeneration: "7", profile: organizationProfile }, send)).resolves.toEqual({ status: "rejected", reason: "invalid_command" });
    await expect(sendProjectAlphaDirectoryProfileUpdate(connection, "organization", organizationId, { commandId, expectedRevision: "0", expectedAuthorizationGeneration: "7", profile: organizationProfile }, send)).resolves.toEqual({ status: "rejected", reason: "invalid_command" });
    await expect(sendProjectAlphaDirectoryCreate(connection, "client", { commandId, externalId: "", expectedAuthorizationGeneration: "0", profile: clientProfile, organization: null }, send)).resolves.toEqual({ status: "rejected", reason: "invalid_command" });
    await expect(sendProjectAlphaDirectoryCreate(connection, "client", { commandId, externalId: "ops/client/max-generation", expectedAuthorizationGeneration: "9223372036854775807", profile: clientProfile, organization: null }, send)).resolves.toEqual({ status: "rejected", reason: "invalid_command" });
    const overlong = { ...organizationProfile, name: "x".repeat(151) };
    await expect(sendProjectAlphaDirectoryProfileUpdate(connection, "organization", organizationId, { commandId, expectedRevision: "1", expectedAuthorizationGeneration: "7", profile: overlong }, send)).resolves.toEqual({ status: "rejected", reason: "invalid_command" });
    const invalidClientState = { ...clientUpdateProfile, state: "TEX" };
    await expect(sendProjectAlphaDirectoryProfileUpdate(connection, "client", clientId, { commandId, expectedRevision: "1", expectedAuthorizationGeneration: "7", profile: invalidClientState }, send)).resolves.toEqual({ status: "rejected", reason: "invalid_command" });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([[409, "conflict"], [403, "blocked"], [400, "rejected"]] as const)("classifies PA HTTP %i as %s", async (status, expected) => {
    const command: ProjectAlphaDirectoryProfileUpdateCommand = { commandId, expectedRevision: "1", expectedAuthorizationGeneration: "7", profile: organizationProfile };
    const send = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? json(capabilities(endpoint("organization", "update"))) : json({}, status));
    await expect(sendProjectAlphaDirectoryProfileUpdate(connection, "organization", organizationId, command, send)).resolves.toMatchObject({ status: expected, httpStatus: status, reason: "http_status" });
  });

  it("returns timeout diagnostics without exposing credentials", async () => {
    const command: ProjectAlphaDirectoryProfileUpdateCommand = { commandId, expectedRevision: "1", expectedAuthorizationGeneration: "7", profile: organizationProfile };
    vi.useFakeTimers();
    try {
      const send = vi.fn<typeof fetch>(async (url, init) => String(url).endsWith("/capabilities")
        ? json(capabilities(endpoint("organization", "update")))
        : new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })));
      const pending = sendProjectAlphaDirectoryProfileUpdate(connection, "organization", organizationId, command, send);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toMatchObject({ status: "uncertain", reason: "timeout" });
      expect(JSON.stringify(await pending)).not.toContain("transport-secret");
    } finally { vi.useRealTimers(); }
  });
});
