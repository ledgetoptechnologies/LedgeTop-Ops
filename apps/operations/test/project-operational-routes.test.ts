import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  readProjectOperationalWorkspace: vi.fn(),
  saveProjectOperationalContacts: vi.fn(),
  saveProjectMemory: vi.fn(),
  listClientHubCollection: vi.fn(),
}));
vi.mock("../src/worker/project-operational-memory", () => ({
  readProjectOperationalWorkspace: services.readProjectOperationalWorkspace,
  saveProjectOperationalContacts: services.saveProjectOperationalContacts,
  saveProjectMemory: services.saveProjectMemory,
}));
vi.mock("../src/worker/client-hub-collections", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/client-hub-collections")>(),
  listClientHubCollection: services.listClientHubCollection,
}));

import { registerProjectOperationalRoutes } from "../src/worker/project-operational-routes";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { Env, StaffPrincipal } from "../src/worker/types";

const principal = { id: "staff-one" } as StaffPrincipal;
const context: ClientHubCollectionContext = { root: { source_id: "project-alpha:primary", root_namespace: "business", kind: "organization", public_id: "org-one",
    pa_public_id: "org-one", mapping_status: "mapped", display_name: "Exact Root Organization", sort_name: "exact root organization",
    status: "active", portal_status: "active", workspace_id: "workspace-one", legacy_account_id: null, account_count: 1,
    project_count: 1, request_count: 0, contact_count: 26, meaningful_activity_at: "2026-08-26T12:00:00Z",
    source_version: "source-version-one", indexed_at: "2026-08-26T12:00:00Z", scan_generation: 1 },
  canonicalRoot: { sourceId: "project-alpha:primary", rootNamespace: "business", kind: "organization", publicId: "org-one" },
  access: { directory: true, requests: true, delivery: false, viewer: false }, contextVersion: "a".repeat(43) };
const workspace = { canonicalRoot: context.canonicalRoot, contextVersion: context.contextVersion,
  project: { id: "project-one", sourceId: "project-alpha:primary", status: "active" },
  contacts: { version: 0, assignments: [], revisions: [] }, memory: { version: 0,
    snapshot: { plan: "", actualOutcome: "", deviationsAndReasons: "", observations: "", problems: "", successes: "", recommendations: "", nextTimeRequests: "" }, revisions: [] },
  capabilities: { canManageContacts: true, canManageMemory: true } };
const path = "/api/client-hub/sources/project-alpha%3Aprimary/business/organizations/org-one/business-projects/project-one";

function fixture() {
  const resolve = vi.fn(async () => context), verify = vi.fn(async () => undefined);
  const app = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
  app.use("*", async (c, next) => { c.set("principal", principal); c.set("administrator", false); await next(); });
  registerProjectOperationalRoutes(app, resolve, verify);
  return { app, resolve, verify, env: {} as Env };
}
beforeEach(() => {
  vi.clearAllMocks();
  services.readProjectOperationalWorkspace.mockResolvedValue(workspace);
  services.listClientHubCollection.mockResolvedValue({ items: [{ public_id: "contact-one", display_name: "Exact root contact", email: null, phone: null, record_type: "business_contact" }],
    page: { available: true, reason: null, nextCursor: null, hasMore: false, returned: 1, limit: 25 }, canonicalRoot: context.canonicalRoot, contextVersion: context.contextVersion });
  services.saveProjectOperationalContacts.mockResolvedValue({ sourceId: "project-alpha:primary", projectId: "project-one", version: 1, replayed: false });
  services.saveProjectMemory.mockResolvedValue({ sourceId: "project-alpha:primary", projectId: "project-one", version: 1, replayed: false });
});

describe("project operational routes", () => {
  it("resolves current context server-side and exposes only the bounded exact-root contact page", async () => {
    const { app, resolve, verify, env } = fixture();
    const response = await app.request(`${path}/operational-workspace?expectedContextVersion=${context.contextVersion}`, {}, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ canonicalRoot: context.canonicalRoot,
      contactOptions: [{ public_id: "contact-one", display_name: "Exact root contact" }], contactPage: { limit: 25 } });
    expect(resolve).toHaveBeenCalledWith(env, principal, "organization", "org-one", "project-alpha:primary", "business");
    expect(services.listClientHubCollection).toHaveBeenCalledWith(env, context, "businessContacts", { limit: 25 });
    expect(verify).toHaveBeenCalledWith(env, principal, context);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("binds progressive contact cursors to the existing bounded collection service", async () => {
    const { app, env } = fixture();
    const response = await app.request(`${path}/operational-workspace?contactCursor=opaque_cursor`, {}, env);
    expect(response.status).toBe(200);
    expect(services.listClientHubCollection).toHaveBeenCalledWith(env, context, "businessContacts", { limit: 25, cursor: "opaque_cursor" });
  });

  it("rejects stale context and staff authorization failure before reading operational records", async () => {
    const first = fixture();
    const stale = await first.app.request(`${path}/operational-workspace?expectedContextVersion=${"z".repeat(43)}`, {}, first.env);
    expect(stale.status).toBe(409); expect(services.readProjectOperationalWorkspace).not.toHaveBeenCalled();
    const denied = fixture(); denied.resolve.mockRejectedValueOnce(new HTTPException(403, { message: "Client-directory access is required" }));
    const response = await denied.app.request(`${path}/operational-workspace`, {}, denied.env);
    expect(response.status).toBe(403); expect(services.readProjectOperationalWorkspace).not.toHaveBeenCalled();
  });

  it("delegates save-body validation and preserves expected versions and idempotency input", async () => {
    const { app, env } = fixture();
    const contacts = { expectedContextVersion: context.contextVersion, expectedVersion: 4, idempotencyKey: "contacts_operation_1234",
      assignments: [{ contactId: "contact-one", role: "site_contact", preferredContactMethod: "phone", instructions: "Call first" }] };
    expect((await app.request(`${path}/operational-contacts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(contacts) }, env)).status).toBe(200);
    expect(services.saveProjectOperationalContacts).toHaveBeenCalledWith(env, principal, context, "project-one", contacts);
    const memory = { expectedContextVersion: context.contextVersion, expectedVersion: 2, idempotencyKey: "memory_operation_12345",
      memory: { ...workspace.memory.snapshot, plan: "Plan" }, amendmentReason: null };
    expect((await app.request(`${path}/operational-memory`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(memory) }, env)).status).toBe(200);
    expect(services.saveProjectMemory).toHaveBeenCalledWith(env, principal, context, "project-one", memory);
  });

  it("fails closed when post-read context verification changes", async () => {
    const { app, verify, env } = fixture(); verify.mockRejectedValueOnce(new HTTPException(409, { message: "Client mapping changed" }));
    const response = await app.request(`${path}/operational-workspace`, {}, env);
    expect(response.status).toBe(409); expect(services.readProjectOperationalWorkspace).toHaveBeenCalledTimes(1);
  });

  it.each([
    "/api/client-hub/sources/delivery%3Alocal/business/organizations/org-one/business-projects/project-one/operational-workspace",
    "/api/client-hub/sources/project-alpha%3Aprimary/portal/organizations/org-one/business-projects/project-one/operational-workspace",
    "/api/client-hub/sources/project-alpha%3Aprimary/business/accounts/org-one/business-projects/project-one/operational-workspace",
  ])("rejects unsupported source or route %s before context resolution", async invalid => {
    const { app, resolve, env } = fixture(); expect((await app.request(invalid, {}, env)).status).toBe(404); expect(resolve).not.toHaveBeenCalled();
  });
});
