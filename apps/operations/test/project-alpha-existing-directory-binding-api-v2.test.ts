import { describe, expect, it, vi } from "vitest";
import {
  sendConfiguredProjectAlphaExistingDirectoryBinding,
  validatedProjectAlphaExistingDirectoryBindingEvidence,
} from "../src/worker/project-alpha-existing-directory-binding-api-v2";

const sourceId = "project-alpha:primary", source = "10000000-0000-4000-8000-000000000001";
const application = "10000000-0000-4000-8000-000000000002", epoch = "10000000-0000-4000-8000-000000000003";
const requestId = "10000000-0000-4000-8000-000000000004", commandId = "20000000-0000-4000-8000-000000000001";
const publicId = "a".repeat(32);
const command = { commandId, externalId: "native-customer", expectedPublicId: publicId, expectedRevision: "7",
  expectedAuthorizationGeneration: "7" };
const endpoint = { method: "POST", path: "/api/v2/directory/organizations/bindings/commands",
  requiredCapability: "directory.organizations.bind", requiresSourceInstanceId: true, requiresApplicationId: true,
  requiresExpectedPublicId: true, requiresExpectedRevision: true, requiresHistoryEpoch: true };
const metadata = () => ({ apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch,
  requestId, grantedCapabilities: [{ name: "api.capabilities.read" }, { name: "directory.organizations.bind" }],
  implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" }, { ...endpoint }] });
const receipt = () => ({ replayed: false, result: { binding: { publicId },
  resource: { type: "organization", id: "native-customer", revision: "7" }, authorizationGeneration: "8" }, requestId,
  sourceInstanceId: source, historyEpoch: epoch, applicationId: application });
const response = (value: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Request-ID": requestId, ...extra },
});
const env = { PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: { [sourceId]: {
  sourceId, enabled: true, baseUrl: "https://pa.example.test", apiKey: "server-secret", sourceInstanceId: source,
  applicationId: application, historyEpoch: epoch,
} } }) };

describe("existing Directory binding API-v2 transport", () => {
  it("preflights the exact endpoint and validates an identity-only receipt", async () => {
    const send = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? response(metadata()) : response(receipt()));
    const outcome = await sendConfiguredProjectAlphaExistingDirectoryBinding(env, sourceId, "organization", command, send);
    expect(outcome).toMatchObject({ status: "acknowledged", response: receipt() });
    expect(validatedProjectAlphaExistingDirectoryBindingEvidence(outcome)).toMatchObject({
      kind: "organization", command, destinationOrigin: "https://pa.example.test",
    });
    const init = send.mock.calls[1]![1]!;
    expect(init).toMatchObject({ method: "POST", redirect: "manual", credentials: "omit", cache: "no-store" });
    expect(JSON.parse(String(init.body))).toEqual(command);
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer server-secret");
  });

  it.each(["duplicate", "foreign", "cookie", "redirect", "missing-revision-flag"]) ("fails closed for %s", async variant => {
    const meta = metadata(), body: Record<string, unknown> = receipt();
    if (variant === "foreign") body.applicationId = "30000000-0000-4000-8000-000000000001";
    if (variant === "missing-revision-flag") delete (meta.implementedEndpoints[1] as Record<string, unknown>).requiresExpectedRevision;
    const send = vi.fn<typeof fetch>(async url => {
      if (String(url).endsWith("/capabilities")) return response(meta);
      if (variant === "duplicate") return new Response('{"replayed":false,"replayed":true}', { status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Request-ID": requestId } });
      if (variant === "redirect") return response(body, 302, { Location: "https://evil.example.test" });
      return response(body, 200, variant === "cookie" ? { "Set-Cookie": "session=bad" } : {});
    });
    const outcome = await sendConfiguredProjectAlphaExistingDirectoryBinding(env, sourceId, "organization", command, send);
    expect(outcome.status).not.toBe("acknowledged");
    if (variant === "missing-revision-flag") expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects accessors, extra fields, and malformed identifiers before POST", async () => {
    const send = vi.fn<typeof fetch>(async () => response(metadata()));
    const accessor = { ...command } as Record<string, unknown>;
    Object.defineProperty(accessor, "commandId", { enumerable: true, get: () => commandId });
    for (const value of [accessor, { ...command, credential: "caller-secret" }, { ...command, expectedRevision: "07" },
      { commandId, externalId: "native-customer", expectedPublicId: publicId, expectedRevision: "7" },
      { ...command, expectedAuthorizationGeneration: "07" }, { ...command, expectedAuthorizationGeneration: "9223372036854775807" }]) {
      expect(await sendConfiguredProjectAlphaExistingDirectoryBinding(env, sourceId, "organization", value, send))
        .toMatchObject({ status: "rejected", reason: "invalid_command" });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["missing", "stale", "malformed", "extra-result"]) ("rejects %s result authorization generation evidence", async variant => {
    const body = receipt() as Record<string, unknown>;
    const result = body.result as Record<string, unknown>;
    if (variant === "missing") delete result.authorizationGeneration;
    if (variant === "stale") result.authorizationGeneration = "7";
    if (variant === "malformed") result.authorizationGeneration = "08";
    if (variant === "extra-result") result.untrusted = true;
    const send = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? response(metadata()) : response(body));
    await expect(sendConfiguredProjectAlphaExistingDirectoryBinding(env, sourceId, "organization", command, send))
      .resolves.toMatchObject({ status: "uncertain", reason: "invalid_contract" });
  });

  it("accepts PA's correlated bare 409 as a binding conflict", async () => {
    const send = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? response(metadata())
      : new Response(null, { status: 409, headers: { "Content-Type": "application/json; charset=UTF-8",
        "Cache-Control": "no-store", "X-Request-ID": requestId } }));
    const outcome = await sendConfiguredProjectAlphaExistingDirectoryBinding(env, sourceId, "organization", command, send);
    expect(outcome).toEqual({ status: "conflict", reason: "http_status", httpStatus: 409, requestId });
    expect(validatedProjectAlphaExistingDirectoryBindingEvidence(outcome)).toBeNull();
  });

  it.each([
    ["missing request ID", { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" }, null],
    ["malformed request ID", { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Request-ID": "not-a-uuid" }, null],
    ["non-empty malformed body", { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Request-ID": requestId }, " "],
  ])("fails closed for a bare-conflict-shaped response with %s", async (_variant, headers, body) => {
    const send = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? response(metadata())
      : new Response(body, { status: 409, headers }));
    await expect(sendConfiguredProjectAlphaExistingDirectoryBinding(env, sourceId, "organization", command, send))
      .resolves.toMatchObject({ status: "uncertain", reason: "invalid_contract", httpStatus: 409 });
  });
});
