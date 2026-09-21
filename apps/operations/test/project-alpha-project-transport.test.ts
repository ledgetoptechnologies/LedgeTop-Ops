import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { privateProjectAlphaProjectSettlementEvidence, sendConfiguredProjectAlphaProjectCreateCommand, sendProjectAlphaProjectCreateCommand, sendProjectAlphaProjectUpdateCommand, sendProjectAlphaProjectBindingCommand, sendProjectAlphaProjectRefreshCommand, validatedProjectAlphaProjectAcknowledgement, type ProjectAlphaProjectCreateCommand, type ProjectAlphaProjectOutcome, type ProjectAlphaProjectUpdateCommand, type ProjectAlphaProjectBindCommand, type ProjectAlphaProjectRefreshCommand } from "../src/worker/project-alpha-project-api-v2";
import { privateProjectAlphaProjectReadEvidence, readProjectAlphaProject, validatedProjectAlphaProjectRead } from "../src/worker/project-alpha-project-read-api-v2";
import { readProjectAlphaProjectInventory } from "../src/worker/project-alpha-project-inventory-api-v2";
import { readProjectAlphaProjectBindingStatus } from "../src/worker/project-alpha-project-binding-status-api-v2";
import { sendProjectAlphaProjectLifecycleCommand } from "../src/worker/project-alpha-project-lifecycle-api-v2";

const source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", application = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", epoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", request = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", org = "1".repeat(32), project = "2".repeat(32);
const connection = { baseUrl: "https://alpha.example.test", apiKey: "test-secret", expectedSourceInstanceId: source, expectedApplicationId: application, expectedHistoryEpoch: epoch };
const create: ProjectAlphaProjectCreateCommand = { commandId: request, externalId: "ops/project-1", expectedAuthorizationGeneration: "0", project: { name: "Survey", description: "", estimatedStart: "1000-01-01", estimatedEnd: "9999-12-31" }, organization: { externalId: "ops/org-1", expectedPublicId: org, expectedRevision: "1", expectedProjectionSha256: "a".repeat(64) }, client: null };
function metadata(route: Record<string, unknown>, capabilities = ["api.capabilities.read", route.requiredCapability as string]) { return { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: request, grantedCapabilities: capabilities.map(name => ({ name })), implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" }, route] }; }
function json(value: unknown, status = 200, headers: Record<string, string> = {}, raw?: string) { return new Response(raw ?? JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Request-ID": request, ...headers } }); }
function syncReceipt() { return { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: request, replayed: false, result: { resource: { type: "project", id: create.externalId, publicId: project, revision: "1", projectionSha256: "a".repeat(64) }, authorizationGeneration: "1", presentation: { portalPublished: false, publicLinkEnabled: false } } }; }
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("dormant PA project v2 transport", () => {
  it("is default-off before any capability or command fetch", async () => {
    const send = vi.fn<typeof fetch>();
    const env = { PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: { "project-alpha:test": { sourceId: "project-alpha:test", enabled: false, baseUrl: connection.baseUrl, apiKey: connection.apiKey, sourceInstanceId: source, applicationId: application, historyEpoch: epoch } } }) };
    await expect(sendConfiguredProjectAlphaProjectCreateCommand(env, "project-alpha:test", create, send)).resolves.toEqual({ status: "disabled", sourceId: "project-alpha:test" });
    expect(send).not.toHaveBeenCalled();
  });
  it("preflights exact route, sends identity headers and preserves command bytes", async () => {
    const route = { method: "POST", path: "/api/v2/projects/commands", requiredCapability: "projects.create", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
    const send = vi.fn<typeof fetch>(async (_url, init) => init?.method === "GET" ? json(metadata(route)) : json(syncReceipt(), 201));
    await expect(sendProjectAlphaProjectCreateCommand(connection, create, send)).resolves.toMatchObject({ status: "acknowledged", httpStatus: 201 });
    const init = send.mock.calls[1]![1]!; expect(String(send.mock.calls[1]![0])).toBe("https://alpha.example.test/api/v2/projects/commands"); expect(JSON.parse(String(init.body))).toEqual(create);
    const headers = new Headers(init.headers); expect(headers.get("Authorization")).toBe("Bearer test-secret"); expect(headers.get("X-PA-Source-Instance-ID")).toBe(source); expect(headers.get("X-PA-Application-ID")).toBe(application); expect(headers.get("X-PA-History-Epoch")).toBe(epoch);
    expect(headers.get("CF-Access-Client-Id")).toBeNull(); expect(headers.get("CF-Access-Client-Secret")).toBeNull();
  });
  it("attaches an Access service credential pair to both preflight and command requests", async () => {
    const route = { method: "POST", path: "/api/v2/projects/commands", requiredCapability: "projects.create", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
    const access = { accessClientId: "access-client-id", accessClientSecret: "access-client-secret" };
    const send = vi.fn<typeof fetch>(async (_url, init) => init?.method === "GET" ? json(metadata(route)) : json(syncReceipt(), 201));
    await expect(sendProjectAlphaProjectCreateCommand({ ...connection, ...access }, create, send)).resolves.toMatchObject({ status: "acknowledged", httpStatus: 201 });
    for (const [, init] of send.mock.calls) {
      const headers = new Headers(init!.headers);
      expect(headers.get("CF-Access-Client-Id")).toBe(access.accessClientId);
      expect(headers.get("CF-Access-Client-Secret")).toBe(access.accessClientSecret);
    }
  });
  it("rejects a create acknowledgement that implicitly publishes the project", async () => {
    const route = { method: "POST", path: "/api/v2/projects/commands", requiredCapability: "projects.create", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
    for (const presentation of [
      { portalPublished: true, publicLinkEnabled: false },
      { portalPublished: false, publicLinkEnabled: true },
    ]) {
      const receipt = syncReceipt(); receipt.result.presentation = presentation;
      const send = vi.fn<typeof fetch>(async (_url, init) => init?.method === "GET" ? json(metadata(route)) : json(receipt, 201));
      const outcome = await sendProjectAlphaProjectCreateCommand(connection, create, send);
      expect(outcome).toMatchObject({ status: "uncertain", reason: "invalid_contract" });
      expect(validatedProjectAlphaProjectAcknowledgement(outcome)).toBeNull();
    }
  });
  it("mints detached settlement evidence only for a validated transport acknowledgement", async () => {
    const route = { method: "POST", path: "/api/v2/projects/commands", requiredCapability: "projects.create", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
    const send = vi.fn<typeof fetch>(async (_url, init) => init?.method === "GET" ? json(metadata(route)) : json(syncReceipt(), 201));
    const outcome = await sendProjectAlphaProjectCreateCommand(connection, create, send);
    const evidence = validatedProjectAlphaProjectAcknowledgement(outcome);
    expect(evidence).toEqual({ type: "create", command: create, response: syncReceipt(), destinationOrigin: "https://alpha.example.test", requestSha256: sha256(JSON.stringify(create)), responseSha256: sha256(JSON.stringify(syncReceipt())) });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(privateProjectAlphaProjectSettlementEvidence(evidence)).toBe(evidence);
    expect(privateProjectAlphaProjectSettlementEvidence(JSON.parse(JSON.stringify(evidence)))).toBeNull();

    const fabricated = { status: "acknowledged", httpStatus: 201, response: syncReceipt() } as ProjectAlphaProjectOutcome;
    expect(validatedProjectAlphaProjectAcknowledgement(fabricated)).toBeNull();

    if (outcome.status === "acknowledged") {
      (outcome.response.result.resource as { publicId: string }).publicId = "f".repeat(32);
    }
    expect(() => { (evidence!.command as { externalId: string }).externalId = "mutated"; }).toThrow(TypeError);
    expect(() => { (evidence!.response.result.resource as { publicId: string }).publicId = "f".repeat(32); }).toThrow(TypeError);
    expect(validatedProjectAlphaProjectAcknowledgement(outcome)).toEqual({
      type: "create", command: create, response: syncReceipt(), destinationOrigin: "https://alpha.example.test", requestSha256: sha256(JSON.stringify(create)), responseSha256: sha256(JSON.stringify(syncReceipt())),
    });
  });
  it("does not post when capability identity or route shape drifts", async () => {
    const route = { method: "POST", path: "/api/v2/projects/commands", requiredCapability: "projects.create", requiresSourceInstanceId: false, requiresApplicationId: true, requiresHistoryEpoch: true };
    const send = vi.fn<typeof fetch>(async () => json(metadata(route)));
    await expect(sendProjectAlphaProjectCreateCommand(connection, create, send)).resolves.toMatchObject({ status: "blocked", reason: "preflight" }); expect(send).toHaveBeenCalledTimes(1);
  });
  it("requires canonical lowercase UUIDs in commands and response correlation", async () => {
    const route = { method: "POST", path: "/api/v2/projects/commands", requiredCapability: "projects.create", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
    const unused = vi.fn<typeof fetch>();
    await expect(sendProjectAlphaProjectCreateCommand(connection, { ...create, commandId: request.toUpperCase() }, unused)).resolves.toEqual({ status: "rejected", reason: "invalid_command" });
    expect(unused).not.toHaveBeenCalled();
    const uppercaseRequest = request.toUpperCase();
    const send = vi.fn<typeof fetch>(async (_url, init) => init?.method === "GET" ? json(metadata(route)) : json({ ...syncReceipt(), requestId: uppercaseRequest }, 201, { "X-Request-ID": uppercaseRequest }));
    await expect(sendProjectAlphaProjectCreateCommand(connection, create, send)).resolves.toMatchObject({ status: "uncertain", reason: "invalid_contract" });
    expect(validatedProjectAlphaProjectAcknowledgement(await sendProjectAlphaProjectCreateCommand(connection, create, send))).toBeNull();
  });
  it("accepts only the exact, correlated Project-v2 command conflict envelopes", async () => {
    const route = { method: "POST", path: "/api/v2/projects/commands", requiredCapability: "projects.create", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
    const verified = (code: string) => ({ apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: request, error: { code } });
    const identityWithoutEcho = { apiVersion: "2", requestId: request, error: { code: "identity_conflict" } };
    const send = (body: unknown, raw?: string, headers?: Record<string, string>) => vi.fn<typeof fetch>(async (_url, init) =>
      init?.method === "GET" ? json(metadata(route)) : json(body, 409, headers, raw));

    await expect(sendProjectAlphaProjectCreateCommand(connection, create, send(identityWithoutEcho))).resolves
      .toEqual({ status: "conflict", reason: "identity_conflict", httpStatus: 409, requestId: request });
    for (const code of ["identity_conflict", "command_id_conflict", "authorization_generation_conflict", "external_binding_conflict", "relationship_proof_conflict", "resource_precondition_conflict", "database_constraint_conflict"]) {
      await expect(sendProjectAlphaProjectCreateCommand(connection, create, send(verified(code)))).resolves
        .toEqual({ status: "conflict", reason: code, httpStatus: 409, requestId: request });
    }
  });
  it("fails closed for malformed, surplus, mismatched, oversized, or duplicate command conflict envelopes", async () => {
    const route = { method: "POST", path: "/api/v2/projects/commands", requiredCapability: "projects.create", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
    const valid = { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: request, error: { code: "command_id_conflict" } };
    const send = (body: unknown, raw?: string, headers?: Record<string, string>) => vi.fn<typeof fetch>(async (_url, init) =>
      init?.method === "GET" ? json(metadata(route)) : json(body, 409, headers, raw));
    const duplicate = `{"apiVersion":"2","requestId":"${request}","requestId":"${request}","error":{"code":"identity_conflict"}}`;
    const cases: Array<[unknown, string | undefined, Record<string, string> | undefined]> = [
      [{ ...valid, sourceInstanceId: epoch }, undefined, undefined],
      [{ ...valid, extra: true }, undefined, undefined],
      [{ apiVersion: "2", requestId: request, error: { code: "command_id_conflict" } }, undefined, undefined],
      [{ apiVersion: "2", sourceInstanceId: source, requestId: request, error: { code: "identity_conflict" } }, undefined, undefined],
      [{ apiVersion: "2", sourceInstanceId: epoch, applicationId: application, historyEpoch: epoch, requestId: request, error: { code: "identity_conflict" } }, undefined, undefined],
      [valid, duplicate, undefined],
      [valid, " ".repeat(64 * 1024 + 1), undefined],
      [{ ...valid, requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }, undefined, undefined],
      [valid, undefined, { "X-Request-ID": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }],
    ];
    for (const [body, raw, headers] of cases) {
      await expect(sendProjectAlphaProjectCreateCommand(connection, create, send(body, raw, headers))).resolves
        .toMatchObject({ status: "uncertain", reason: "invalid_contract", httpStatus: 409 });
    }
  });
  it("keeps reads and inventory non-authoritative and bounded", async () => {
    const readRoute = { method: "GET", path: "/api/v2/projects/{publicId}", requiredCapability: "projects.v2.read", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
    const readBody = { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: request, replayed: false, accepted: true, resource: { type: "project", id: project, revision: "1", projectionSha256: "a".repeat(64) }, data: { name: "Survey", description: null, status: "active", archived: false, overdueWarning: false, completedAt: null, archivedAt: null, estimatedStart: null, estimatedEnd: null, clientPublicId: null, organizationPublicId: org } };
    const readSend = vi.fn<typeof fetch>(async url => String(url).endsWith("capabilities") ? json(metadata(readRoute)) : json(readBody));
    await expect(readProjectAlphaProject(connection, project, readSend)).resolves.toMatchObject({ status: "read", response: { resource: { id: project } } });
    const invRoute = { method: "GET", path: "/api/v2/projects/inventory", requiredCapability: "projects.inventory.read", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
    const invSend = vi.fn<typeof fetch>(async url => String(url).endsWith("capabilities") ? json(metadata(invRoute)) : json({ apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: request, authorizationGeneration: "1", projects: [], nextCursor: null }));
    await expect(readProjectAlphaProjectInventory(connection, { limit: 1 }, invSend)).resolves.toMatchObject({ status: "observed", response: { projects: [], nextCursor: null } });
  });
  it("returns typed stale-binding discovery and recovery evidence only for exact trusted 409 envelopes", async () => {
    const inventoryRoute = { method: "GET", path: "/api/v2/projects/inventory", requiredCapability: "projects.inventory.read", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
    const inventoryStale = { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: request, error: { code: "binding_stale", externalId: "ops/project-1" } };
    const inventorySend = vi.fn<typeof fetch>(async url => String(url).endsWith("capabilities") ? json(metadata(inventoryRoute)) : json(inventoryStale, 409));
    await expect(readProjectAlphaProjectInventory(connection, { cursor: "ops/project-0", limit: 1 }, inventorySend)).resolves.toEqual({ status: "binding_stale", httpStatus: 409, response: inventoryStale });

    const bindingRoute = { method: "GET", path: "/api/v2/projects/bindings/status/{base64urlExternalId}", requiredCapability: "projects.binding_status.read", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
    const bindingStale = { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: request, error: { code: "binding_stale" }, authorizationGeneration: "2", binding: { externalId: "ops/project-1", publicId: project, revision: "2" }, resource: { revision: "3", projectionSha256: "b".repeat(64) } };
    const bindingSend = vi.fn<typeof fetch>(async url => String(url).endsWith("capabilities") ? json(metadata(bindingRoute)) : json(bindingStale, 409));
    await expect(readProjectAlphaProjectBindingStatus(connection, "ops/project-1", bindingSend)).resolves.toEqual({ status: "binding_stale", httpStatus: 409, response: bindingStale });

    const current = { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: request, authorizationGeneration: "3", binding: { externalId: "ops/project-1", publicId: project, createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:01.000Z" }, resource: { revision: "3", projectionSha256: "b".repeat(64), status: "active", archived: false } };
    const currentSend = vi.fn<typeof fetch>(async url => String(url).endsWith("capabilities") ? json(metadata(bindingRoute)) : json(current));
    await expect(readProjectAlphaProjectBindingStatus(connection, "ops/project-1", currentSend)).resolves.toEqual({ status: "observed", httpStatus: 200, response: current });
  });
  it("keeps bare 409s as ordinary conflicts and fails closed on untrusted or invalid stale bodies", async () => {
    const inventoryRoute = { method: "GET", path: "/api/v2/projects/inventory", requiredCapability: "projects.inventory.read", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
    const bindingRoute = { method: "GET", path: "/api/v2/projects/bindings/status/{base64urlExternalId}", requiredCapability: "projects.binding_status.read", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
    const trustedHeaders = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Request-ID": request };
    const bare = (route: Record<string, unknown>) => vi.fn<typeof fetch>(async url => String(url).endsWith("capabilities") ? json(metadata(route)) : new Response(null, { status: 409, headers: trustedHeaders }));
    await expect(readProjectAlphaProjectInventory(connection, {}, bare(inventoryRoute))).resolves.toEqual({ status: "conflict", reason: "http_status", httpStatus: 409, requestId: request });
    await expect(readProjectAlphaProjectBindingStatus(connection, "ops/project-1", bare(bindingRoute))).resolves.toEqual({ status: "conflict", reason: "http_status", httpStatus: 409, requestId: request });

    const untrustedHeaders: Record<string, string>[] = [
      { "Content-Type": "application/json", "Cache-Control": "no-store" },
      { ...trustedHeaders, "X-Request-ID": "not-a-request-id" },
      { "Content-Type": "application/json", "X-Request-ID": request },
      { ...trustedHeaders, "Cache-Control": "public" },
      { "Cache-Control": "no-store", "X-Request-ID": request },
      { ...trustedHeaders, "Set-Cookie": "session=unsafe" },
      { ...trustedHeaders, Location: "https://elsewhere.example.test" },
    ];
    for (const headers of untrustedHeaders) {
      const inventorySend = vi.fn<typeof fetch>(async url => String(url).endsWith("capabilities") ? json(metadata(inventoryRoute)) : new Response(null, { status: 409, headers }));
      await expect(readProjectAlphaProjectInventory(connection, {}, inventorySend)).resolves.toMatchObject({ status: "uncertain", reason: "invalid_contract", httpStatus: 409 });
      const bindingSend = vi.fn<typeof fetch>(async url => String(url).endsWith("capabilities") ? json(metadata(bindingRoute)) : new Response(null, { status: 409, headers }));
      await expect(readProjectAlphaProjectBindingStatus(connection, "ops/project-1", bindingSend)).resolves.toMatchObject({ status: "uncertain", reason: "invalid_contract", httpStatus: 409 });
    }
    const wrongLength = vi.fn<typeof fetch>(async url => String(url).endsWith("capabilities") ? json(metadata(inventoryRoute)) : new Response(new ReadableStream({ start(controller) { controller.close(); } }), { status: 409, headers: { ...trustedHeaders, "Content-Length": "1" } }));
    await expect(readProjectAlphaProjectInventory(connection, {}, wrongLength)).resolves.toMatchObject({ status: "uncertain", reason: "invalid_contract", httpStatus: 409 });

    const inventoryStale = { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: request, error: { code: "binding_stale", externalId: "ops/project-1" } };
    const untrustedInventory = vi.fn<typeof fetch>(async url => String(url).endsWith("capabilities") ? json(metadata(inventoryRoute)) : json(inventoryStale, 409, { "Cache-Control": "public" }));
    await expect(readProjectAlphaProjectInventory(connection, {}, untrustedInventory)).resolves.toMatchObject({ status: "uncertain", reason: "invalid_contract", httpStatus: 409 });

    const bindingStale = { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: request, error: { code: "binding_stale" }, authorizationGeneration: "2", binding: { externalId: "ops/project-1", publicId: project, revision: "2" }, resource: { revision: "3", projectionSha256: "b".repeat(64) } };
    const invalidInventory = [
      { ...inventoryStale, applicationId: source },
      { ...inventoryStale, requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
      { ...inventoryStale, extra: true },
      { ...inventoryStale, error: { ...inventoryStale.error, externalId: "" } },
      { ...inventoryStale, error: { ...inventoryStale.error, code: "conflict" } },
    ];
    for (const body of invalidInventory) {
      const send = vi.fn<typeof fetch>(async url => String(url).endsWith("capabilities") ? json(metadata(inventoryRoute)) : json(body, 409));
      await expect(readProjectAlphaProjectInventory(connection, { cursor: "ops/project-0" }, send)).resolves.toMatchObject({ status: "uncertain", reason: "invalid_contract", httpStatus: 409 });
    }
    const invalidBinding = [
      { ...bindingStale, authorizationGeneration: "02" },
      { ...bindingStale, error: { code: "binding_stale", extra: true } },
      { ...bindingStale, binding: { ...bindingStale.binding, externalId: "ops/project-2" } },
      { ...bindingStale, binding: { ...bindingStale.binding, publicId: "not-a-public-id" } },
      { ...bindingStale, resource: { ...bindingStale.resource, revision: "2" } },
      { ...bindingStale, resource: { ...bindingStale.resource, projectionSha256: "B".repeat(64) } },
    ];
    for (const body of invalidBinding) {
      const send = vi.fn<typeof fetch>(async url => String(url).endsWith("capabilities") ? json(metadata(bindingRoute)) : json(body, 409));
      await expect(readProjectAlphaProjectBindingStatus(connection, "ops/project-1", send)).resolves.toMatchObject({ status: "uncertain", reason: "invalid_contract", httpStatus: 409 });
    }
  });
  it("mints non-forgeable project-read evidence from exact raw response bytes", async () => {
    const readRoute = { method: "GET", path: "/api/v2/projects/{publicId}", requiredCapability: "projects.v2.read", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
    const readBody = { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: request, replayed: false, accepted: true, resource: { type: "project", id: project, revision: "1", projectionSha256: "a".repeat(64) }, data: { name: "Survey", description: null, status: "active", archived: false, overdueWarning: false, completedAt: null, archivedAt: null, estimatedStart: null, estimatedEnd: null, clientPublicId: null, organizationPublicId: org } };
    const raw = `\n${JSON.stringify(readBody, null, 2)}\n`;
    const send = vi.fn<typeof fetch>(async url => String(url).endsWith("capabilities") ? json(metadata(readRoute)) : json(readBody, 200, {}, raw));
    const outcome = await readProjectAlphaProject(connection, project, send), evidence = validatedProjectAlphaProjectRead(outcome);
    expect(evidence).toMatchObject({ requestedPublicId: project, response: readBody, responseJson: raw,
      destinationOrigin: connection.baseUrl, responseSha256: sha256(raw) });
    expect(privateProjectAlphaProjectReadEvidence(evidence)).toBe(evidence);
    expect(privateProjectAlphaProjectReadEvidence(JSON.parse(JSON.stringify(evidence)))).toBeNull();
    expect(validatedProjectAlphaProjectRead({ status: "read", httpStatus: 200, response: readBody } as never)).toBeNull();
  });
  it("uses separate lifecycle capability and exact reversible body", async () => {
    const route = { method: "POST", path: `/api/v2/projects/${project}/archive/commands`, requiredCapability: "projects.lifecycle.archive", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
    const body = { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: request, replayed: false, accepted: true, resource: { type: "project", id: project, revision: "2" }, result: { status: "active", completedAt: null, archived: true, archivedAt: "2026-09-15T00:00:00.000Z", presentation: { portalPublished: false, publicLinkEnabled: false } } };
    const send = vi.fn<typeof fetch>(async (_url, init) => init?.method === "GET" ? json(metadata(route)) : json(body));
    await expect(sendProjectAlphaProjectLifecycleCommand(connection, project, "archive", { commandId: request, expectedRevision: "1" }, send)).resolves.toMatchObject({ status: "acknowledged", response: { result: { archived: true } } });
  });
  it("canonicalizes reordered PA command envelopes before serialization", async () => {
    const commands: Array<[string, object, object, number, string[]]> = [
      ["create", { client: null, organization: create.organization, project: create.project, expectedAuthorizationGeneration: "0", externalId: create.externalId, commandId: create.commandId }, create, 201, ["commandId", "externalId", "expectedAuthorizationGeneration", "project", "organization", "client"]],
      ["update", { project: create.project, expectedAuthorizationGeneration: "1", expectedProjectionSha256: "a".repeat(64), expectedRevision: "1", externalId: create.externalId, commandId: create.commandId }, { commandId: create.commandId, externalId: create.externalId, expectedRevision: "1", expectedProjectionSha256: "a".repeat(64), expectedAuthorizationGeneration: "1", project: create.project } as ProjectAlphaProjectUpdateCommand, 200, ["commandId", "externalId", "expectedRevision", "expectedProjectionSha256", "expectedAuthorizationGeneration", "project"]],
      ["bind", { expectedAuthorizationGeneration: "0", expectedProjectionSha256: "a".repeat(64), expectedRevision: "1", expectedPublicId: project, externalId: create.externalId, commandId: create.commandId }, { commandId: create.commandId, externalId: create.externalId, expectedPublicId: project, expectedRevision: "1", expectedProjectionSha256: "a".repeat(64), expectedAuthorizationGeneration: "0" } as ProjectAlphaProjectBindCommand, 200, ["commandId", "externalId", "expectedPublicId", "expectedRevision", "expectedProjectionSha256", "expectedAuthorizationGeneration"]],
      ["refresh", { expectedAuthorizationGeneration: "1", expectedProjectionSha256: "a".repeat(64), expectedRevision: "2", expectedPriorRevision: "1", expectedPublicId: project, externalId: create.externalId, commandId: create.commandId }, { commandId: create.commandId, externalId: create.externalId, expectedPublicId: project, expectedPriorRevision: "1", expectedRevision: "2", expectedProjectionSha256: "a".repeat(64), expectedAuthorizationGeneration: "1" } as ProjectAlphaProjectRefreshCommand, 200, ["commandId", "externalId", "expectedPublicId", "expectedPriorRevision", "expectedRevision", "expectedProjectionSha256", "expectedAuthorizationGeneration"]],
    ];
    for (const [kind, reordered, canonical, status, fields] of commands) {
      const route = kind === "create" ? { method: "POST", path: "/api/v2/projects/commands", requiredCapability: "projects.create", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true } : kind === "update" ? { method: "POST", path: "/api/v2/projects/profile/commands", requiredCapability: "projects.write", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true } : kind === "bind" ? { method: "POST", path: "/api/v2/projects/bindings/commands", requiredCapability: "projects.bind", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true } : { method: "POST", path: "/api/v2/projects/bindings/revisions/commands", requiredCapability: "projects.binding.revision.refresh", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
      const response = syncReceipt(); if (kind === "update") { response.result.resource.revision = "2"; response.result.authorizationGeneration = "1"; } if (kind === "refresh") { response.result.resource.revision = "2"; response.result.authorizationGeneration = "2"; }
      const send = vi.fn<typeof fetch>(async (_url, init) => init?.method === "GET" ? json(metadata(route)) : json(response, status));
      const outcome = kind === "create" ? await sendProjectAlphaProjectCreateCommand(connection, reordered as ProjectAlphaProjectCreateCommand, send) : kind === "update" ? await sendProjectAlphaProjectUpdateCommand(connection, reordered as ProjectAlphaProjectUpdateCommand, send) : kind === "bind" ? await sendProjectAlphaProjectBindingCommand(connection, reordered as ProjectAlphaProjectBindCommand, send) : await sendProjectAlphaProjectRefreshCommand(connection, reordered as ProjectAlphaProjectRefreshCommand, send);
      expect(outcome.status).toBe("acknowledged"); expect(Object.keys(JSON.parse(String(send.mock.calls[1]![1]!.body)))).toEqual(fields); expect(JSON.parse(String(send.mock.calls[1]![1]!.body))).toEqual(canonical);
    }
  });
  it("requires a trusted response fence before mapping binding 404 to not_found", async () => {
    const route = { method: "GET", path: "/api/v2/projects/bindings/status/{base64urlExternalId}", requiredCapability: "projects.binding_status.read", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
    const bare = vi.fn<typeof fetch>(async url => String(url).endsWith("capabilities") ? json(metadata(route)) : new Response("private", { status: 404 }));
    await expect(readProjectAlphaProjectBindingStatus(connection, "ops/project-1", bare)).resolves.toMatchObject({ status: "uncertain", reason: "invalid_contract" });
    const trusted404 = vi.fn<typeof fetch>(async url => String(url).endsWith("capabilities") ? json(metadata(route)) : json({}, 404));
    await expect(readProjectAlphaProjectBindingStatus(connection, "ops/project-1", trusted404)).resolves.toEqual({ status: "not_found" });
  });
});
