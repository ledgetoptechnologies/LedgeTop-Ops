import { describe, expect, it, vi } from "vitest";
import { sendConfiguredProjectAlphaProjectCreateCommand, sendProjectAlphaProjectCreateCommand, sendProjectAlphaProjectUpdateCommand, sendProjectAlphaProjectBindingCommand, sendProjectAlphaProjectRefreshCommand, validatedProjectAlphaProjectAcknowledgement, type ProjectAlphaProjectCreateCommand, type ProjectAlphaProjectOutcome, type ProjectAlphaProjectUpdateCommand, type ProjectAlphaProjectBindCommand, type ProjectAlphaProjectRefreshCommand } from "../src/worker/project-alpha-project-api-v2";
import { readProjectAlphaProject } from "../src/worker/project-alpha-project-read-api-v2";
import { readProjectAlphaProjectInventory } from "../src/worker/project-alpha-project-inventory-api-v2";
import { readProjectAlphaProjectBindingStatus } from "../src/worker/project-alpha-project-binding-status-api-v2";
import { sendProjectAlphaProjectLifecycleCommand } from "../src/worker/project-alpha-project-lifecycle-api-v2";

const source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", application = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", epoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", request = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", org = "1".repeat(32), project = "2".repeat(32);
const connection = { baseUrl: "https://alpha.example.test", apiKey: "test-secret", expectedSourceInstanceId: source, expectedApplicationId: application, expectedHistoryEpoch: epoch };
const create: ProjectAlphaProjectCreateCommand = { commandId: request, externalId: "ops/project-1", expectedAuthorizationGeneration: "0", project: { name: "Survey", description: "", estimatedStart: "1000-01-01", estimatedEnd: "9999-12-31" }, organization: { externalId: "ops/org-1", expectedPublicId: org, expectedRevision: "1", expectedProjectionSha256: "a".repeat(64) }, client: null };
function metadata(route: Record<string, unknown>, capabilities = ["api.capabilities.read", route.requiredCapability as string]) { return { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: request, grantedCapabilities: capabilities.map(name => ({ name })), implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" }, route] }; }
function json(value: unknown, status = 200, headers: Record<string, string> = {}) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Request-ID": request, ...headers } }); }
function syncReceipt() { return { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: request, replayed: false, result: { resource: { type: "project", id: create.externalId, publicId: project, revision: "1", projectionSha256: "a".repeat(64) }, authorizationGeneration: "1", presentation: { portalPublished: false, publicLinkEnabled: false } } }; }

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
  });
  it("mints detached settlement evidence only for a validated transport acknowledgement", async () => {
    const route = { method: "POST", path: "/api/v2/projects/commands", requiredCapability: "projects.create", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
    const send = vi.fn<typeof fetch>(async (_url, init) => init?.method === "GET" ? json(metadata(route)) : json(syncReceipt(), 201));
    const outcome = await sendProjectAlphaProjectCreateCommand(connection, create, send);
    const evidence = validatedProjectAlphaProjectAcknowledgement(outcome);
    expect(evidence).toEqual({ type: "create", command: create, response: syncReceipt(), destinationOrigin: "https://alpha.example.test" });

    const fabricated = { status: "acknowledged", httpStatus: 201, response: syncReceipt() } as ProjectAlphaProjectOutcome;
    expect(validatedProjectAlphaProjectAcknowledgement(fabricated)).toBeNull();

    if (outcome.status === "acknowledged") {
      (outcome.response.result.resource as { publicId: string }).publicId = "f".repeat(32);
    }
    expect(() => { (evidence!.command as { externalId: string }).externalId = "mutated"; }).toThrow(TypeError);
    expect(() => { (evidence!.response.result.resource as { publicId: string }).publicId = "f".repeat(32); }).toThrow(TypeError);
    expect(validatedProjectAlphaProjectAcknowledgement(outcome)).toEqual({
      type: "create", command: create, response: syncReceipt(), destinationOrigin: "https://alpha.example.test",
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
  it("keeps reads and inventory non-authoritative and bounded", async () => {
    const readRoute = { method: "GET", path: "/api/v2/projects/{publicId}", requiredCapability: "projects.v2.read", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
    const readBody = { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: request, replayed: false, accepted: true, resource: { type: "project", id: project, revision: "1", projectionSha256: "a".repeat(64) }, data: { name: "Survey", description: null, status: "active", archived: false, overdueWarning: false, completedAt: null, archivedAt: null, estimatedStart: null, estimatedEnd: null, clientPublicId: null, organizationPublicId: org } };
    const readSend = vi.fn<typeof fetch>(async url => String(url).endsWith("capabilities") ? json(metadata(readRoute)) : json(readBody));
    await expect(readProjectAlphaProject(connection, project, readSend)).resolves.toMatchObject({ status: "read", response: { resource: { id: project } } });
    const invRoute = { method: "GET", path: "/api/v2/projects/inventory", requiredCapability: "projects.inventory.read", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
    const invSend = vi.fn<typeof fetch>(async url => String(url).endsWith("capabilities") ? json(metadata(invRoute)) : json({ apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: request, authorizationGeneration: "1", projects: [], nextCursor: null }));
    await expect(readProjectAlphaProjectInventory(connection, { limit: 1 }, invSend)).resolves.toMatchObject({ status: "observed", response: { projects: [], nextCursor: null } });
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
