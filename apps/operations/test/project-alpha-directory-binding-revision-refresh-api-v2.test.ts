import { describe, expect, it, vi } from "vitest";
import {
  isProjectAlphaDirectoryBindingRevisionRefreshCommand,
  sendProjectAlphaDirectoryBindingRevisionRefreshCommand,
  validatedProjectAlphaDirectoryBindingRevisionRefreshAcknowledgement,
  type ProjectAlphaDirectoryBindingRevisionRefreshCommand,
  type ProjectAlphaDirectoryBindingRevisionRefreshSuccess,
} from "../src/worker/project-alpha-directory-binding-revision-refresh-api-v2";

const source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", application = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", epoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", commandId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", requestId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", publicId = "1".repeat(32);
const connection = { baseUrl: "https://pa.example.test", apiKey: "synthetic-refresh-secret", expectedSourceInstanceId: source, expectedApplicationId: application, expectedHistoryEpoch: epoch };
const command = (): ProjectAlphaDirectoryBindingRevisionRefreshCommand => ({ commandId, externalId: "ops-client-42", expectedPriorRevision: "7", expectedLiveRevision: "8", expectedAuthorizationGeneration: "42" });
const endpoint = { method: "POST", path: "/api/v2/directory/clients/bindings/revisions/commands", requiredCapability: "directory.clients.binding.revision.refresh", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
const metadata = () => ({ apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId, grantedCapabilities: [{ name: "api.capabilities.read" }, { name: "directory.clients.binding.revision.refresh" }], implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" }, endpoint] });
const receipt = () => ({ sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId, replayed: false, result: { resource: { type: "client", id: command().externalId, revision: "8" }, binding: { publicId, previousRevision: "7", authorizationGeneration: "43" } } });
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Request-ID": requestId, ...headers } });

describe("PA directory binding revision refresh transport", () => {
  it("preflights only the exact refresh route/scope and sends the exact fenced JSON", async () => {
    const send = vi.fn<typeof fetch>(async (url) => String(url).endsWith("/capabilities") ? json(metadata()) : json(receipt()));
    expect(await sendProjectAlphaDirectoryBindingRevisionRefreshCommand(connection, "client", command(), send)).toMatchObject({ status: "acknowledged", httpStatus: 200 });
    expect(String(send.mock.calls[1]![0])).toBe("https://pa.example.test/api/v2/directory/clients/bindings/revisions/commands");
    const init = send.mock.calls[1]![1]!;
    expect(init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit", cache: "no-store" });
    expect(JSON.parse(String(init.body))).toEqual(command());
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer synthetic-refresh-secret");
    expect(headers.get("X-PA-Source-Instance-ID")).toBe(source);
    expect(headers.get("X-PA-Application-ID")).toBe(application);
    expect(headers.get("X-PA-History-Epoch")).toBe(epoch);
  });

  it.each(["missing-scope", "wrong-route", "foreign-resource", "wrong-prior-revision", "wrong-generation", "extra-response-field"])("fails closed for %s", async variant => {
    const meta = metadata(), body = receipt();
    if (variant === "missing-scope") meta.grantedCapabilities.pop();
    if (variant === "wrong-route") meta.implementedEndpoints[1] = { ...endpoint, path: "/api/v2/directory/clients/bindings/commands" };
    if (variant === "foreign-resource") body.result.resource.id = "other-client";
    if (variant === "wrong-prior-revision") body.result.binding.previousRevision = "6";
    if (variant === "wrong-generation") body.result.binding.authorizationGeneration = "44";
    const payload = variant === "extra-response-field" ? { ...body, privateError: "must-not-accept" } : body;
    const send = vi.fn<typeof fetch>(async (url) => String(url).endsWith("/capabilities") ? json(meta) : json(payload));
    const result = await sendProjectAlphaDirectoryBindingRevisionRefreshCommand(connection, "client", command(), send);
    if (variant === "missing-scope" || variant === "wrong-route") { expect(result).toMatchObject({ status: "blocked", reason: "preflight" }); expect(send).toHaveBeenCalledTimes(1); }
    else expect(result).toMatchObject({ status: "uncertain", reason: "invalid_contract" });
  });

  it("accepts a strict replay receipt and rejects malformed or non-advancing refresh commands before network access", async () => {
    const replay = receipt() as ProjectAlphaDirectoryBindingRevisionRefreshSuccess; replay.replayed = true;
    const send = vi.fn<typeof fetch>(async (url) => String(url).endsWith("/capabilities") ? json(metadata()) : json(replay));
    const result = await sendProjectAlphaDirectoryBindingRevisionRefreshCommand(connection, "client", command(), send);
    expect(result).toMatchObject({ status: "acknowledged" });
    expect(validatedProjectAlphaDirectoryBindingRevisionRefreshAcknowledgement(result)).toMatchObject({ command: command(), response: replay, destinationOrigin: "https://pa.example.test" });
    expect(validatedProjectAlphaDirectoryBindingRevisionRefreshAcknowledgement({ status: "acknowledged", httpStatus: 200, response: replay })).toBeNull();
    for (const invalid of [{ ...command(), unexpected: true }, { ...command(), expectedPriorRevision: "0" }, { ...command(), expectedLiveRevision: "7" }, { ...command(), expectedLiveRevision: "6" }, { ...command(), expectedAuthorizationGeneration: "01" }, { ...command(), expectedAuthorizationGeneration: "9223372036854775807" }, { ...command(), externalId: "bad\u0000id" }]) {
      expect(isProjectAlphaDirectoryBindingRevisionRefreshCommand(invalid)).toBe(false);
      expect(await sendProjectAlphaDirectoryBindingRevisionRefreshCommand(connection, "client", invalid, send)).toMatchObject({ status: "rejected", reason: "invalid_command" });
    }
  });
});
