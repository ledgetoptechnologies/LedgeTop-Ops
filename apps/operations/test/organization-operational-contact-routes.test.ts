import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  readOrganizationOperationalContacts: vi.fn(),
  saveOrganizationOperationalContacts: vi.fn(),
  listClientHubCollection: vi.fn(),
}));
vi.mock("../src/worker/organization-operational-contacts", () => ({
  readOrganizationOperationalContacts: services.readOrganizationOperationalContacts,
  saveOrganizationOperationalContacts: services.saveOrganizationOperationalContacts,
}));
vi.mock("../src/worker/client-hub-collections", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/client-hub-collections")>(),
  listClientHubCollection: services.listClientHubCollection,
}));

import { registerOrganizationOperationalContactRoutes } from "../src/worker/organization-operational-contact-routes";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { Env, StaffPrincipal } from "../src/worker/types";

const principal = { id: "staff-one" } as StaffPrincipal;
const context: ClientHubCollectionContext = { root: { source_id: "project-alpha:primary", root_namespace: "business",
    kind: "organization", public_id: "org-one", pa_public_id: "org-one", mapping_status: "mapped",
    display_name: "Exact organization", sort_name: "exact organization", status: "active", portal_status: "active",
    workspace_id: "workspace-one", legacy_account_id: null, account_count: 1, project_count: 1, request_count: 0,
    contact_count: 2, meaningful_activity_at: "2026-08-28T12:00:00Z", source_version: "source-version-one",
    indexed_at: "2026-08-28T12:00:00Z", scan_generation: 1 },
  canonicalRoot: { sourceId: "project-alpha:primary", rootNamespace: "business", kind: "organization", publicId: "org-one" },
  access: { directory: true, requests: true, delivery: false, viewer: false }, contextVersion: "a".repeat(43) };
const workspace = { canonicalRoot: context.canonicalRoot, contextVersion: context.contextVersion,
  organization: { id: "org-one", sourceId: "project-alpha:primary", revision: "organization-revision-one" },
  contacts: { version: 1, assignments: [{ id: "assignment-one", role: "primary_operational", sortOrder: 0,
    availability: "available", contact: { id: "contact-one", displayName: "Exact contact", email: null, phone: null } }],
    revisions: [{ version: 1, actorId: "staff-one", createdAt: "2026-08-28T12:00:00Z" }] },
  capabilities: { canManageOrganizationContacts: true } };
const path = "/api/client-hub/sources/project-alpha%3Aprimary/business/organizations/org-one/organization-operational-contacts";

function fixture() {
  const resolve = vi.fn(async () => context), verify = vi.fn(async () => undefined);
  const app = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
  app.use("*", async (c, next) => { c.set("principal", principal); c.set("administrator", false); await next(); });
  registerOrganizationOperationalContactRoutes(app, resolve, verify);
  return { app, resolve, verify, env: {} as Env };
}

beforeEach(() => {
  vi.clearAllMocks();
  services.readOrganizationOperationalContacts.mockResolvedValue(workspace);
  services.saveOrganizationOperationalContacts.mockResolvedValue({ sourceId: "project-alpha:primary",
    organizationId: "org-one", version: 2, replayed: false });
  services.listClientHubCollection.mockResolvedValue({
    items: [{ public_id: "contact-one", display_name: "Exact contact", email: null, phone: null, record_type: "business_contact" }],
    page: { available: true, reason: null, nextCursor: null, hasMore: false, returned: 1, limit: 25 },
    canonicalRoot: context.canonicalRoot, contextVersion: context.contextVersion,
  });
});

describe("organization operational contact routes", () => {
  it("resolves the exact organization and returns a bounded contact-option page", async () => {
    const { app, resolve, verify, env } = fixture();
    const response = await app.request(`${path}?expectedContextVersion=${context.contextVersion}`, {}, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ organization: workspace.organization,
      contacts: workspace.contacts, contactOptions: [{ public_id: "contact-one" }], contactPage: { returned: 1, limit: 25 } });
    expect(resolve).toHaveBeenCalledWith(env, principal, "organization", "org-one", "project-alpha:primary", "business");
    expect(services.listClientHubCollection).toHaveBeenCalledWith(env, context, "businessContacts", { limit: 25 });
    expect(verify).toHaveBeenCalledWith(env, principal, context);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("passes the progressive contact cursor through the existing exact-root collection", async () => {
    const { app, env } = fixture();
    expect((await app.request(`${path}?contactCursor=opaque_cursor`, {}, env)).status).toBe(200);
    expect(services.listClientHubCollection).toHaveBeenCalledWith(env, context, "businessContacts",
      { limit: 25, cursor: "opaque_cursor" });
  });

  it("rejects stale context before reading organization contact records", async () => {
    const { app, verify, env } = fixture();
    const response = await app.request(`${path}?expectedContextVersion=${"z".repeat(43)}`, {}, env);
    expect(response.status).toBe(409);
    expect(services.readOrganizationOperationalContacts).not.toHaveBeenCalled();
    expect(services.listClientHubCollection).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it("delegates the exact versioned mutation and reverifies context before release", async () => {
    const { app, verify, env } = fixture();
    const body = { expectedContextVersion: context.contextVersion, expectedVersion: 1,
      idempotencyKey: "organization_contacts_operation_1234", assignments: [
        { contactId: "contact-one", role: "primary_operational" },
        { contactId: "contact-two", role: "delivery" },
      ] };
    const response = await app.request(path, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body) }, env);
    expect(response.status).toBe(200);
    expect(services.saveOrganizationOperationalContacts).toHaveBeenCalledWith(env, principal, context, body);
    expect(verify).toHaveBeenCalledWith(env, principal, context);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not release read or mutation results after post-read context verification changes", async () => {
    const read = fixture(); read.verify.mockRejectedValueOnce(new HTTPException(409, { message: "Client mapping changed" }));
    expect((await read.app.request(path, {}, read.env)).status).toBe(409);
    const write = fixture(); write.verify.mockRejectedValueOnce(new HTTPException(409, { message: "Client mapping changed" }));
    expect((await write.app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, write.env)).status).toBe(409);
  });

  it.each([
    "/api/client-hub/sources/delivery%3Alocal/business/organizations/org-one/organization-operational-contacts",
    "/api/client-hub/sources/project-alpha%3Aprimary/portal/organizations/org-one/organization-operational-contacts",
    "/api/client-hub/sources/project-alpha%3Aprimary/business/standalone/org-one/organization-operational-contacts",
  ])("rejects unsupported source, namespace or kind %s before context resolution", async invalid => {
    const { app, resolve, env } = fixture();
    expect((await app.request(invalid, {}, env)).status).toBe(404);
    expect(resolve).not.toHaveBeenCalled();
  });
});
