import { describe, expect, it, vi } from "vitest";
import { sendConfiguredProjectAlphaProjectCreateCommand, sendProjectAlphaProjectCreateCommand, type ProjectAlphaProjectCreateCommand } from "../src/worker/project-alpha-project-api-v2";
import { readProjectAlphaProject } from "../src/worker/project-alpha-project-read-api-v2";
import { readProjectAlphaProjectInventory } from "../src/worker/project-alpha-project-inventory-api-v2";
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
  it("does not post when capability identity or route shape drifts", async () => {
    const route = { method: "POST", path: "/api/v2/projects/commands", requiredCapability: "projects.create", requiresSourceInstanceId: false, requiresApplicationId: true, requiresHistoryEpoch: true };
    const send = vi.fn<typeof fetch>(async () => json(metadata(route)));
    await expect(sendProjectAlphaProjectCreateCommand(connection, create, send)).resolves.toMatchObject({ status: "blocked", reason: "preflight" }); expect(send).toHaveBeenCalledTimes(1);
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
});
