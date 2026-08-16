import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateStaff: vi.fn(), authorizeItem: vi.fn(), listGrants: vi.fn(), searchAudiences: vi.fn(),
  listDenials: vi.fn(), searchIdentities: vi.fn(), searchScopes: vi.fn(), isAdministrator: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: mocks.authenticateStaff }));
vi.mock("../src/worker/acl", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/acl")>(), isAdministrator: mocks.isAdministrator,
}));
vi.mock("../src/worker/delivery", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/delivery")>(), authorizeItem: mocks.authorizeItem,
}));
vi.mock("../src/worker/authenticated-delivery-grants", () => ({
  authenticatedDeliveryGrantsEnabled: () => true,
  createAuthenticatedDeliveryGrant: vi.fn(), restoreAuthenticatedDeliveryGrant: vi.fn(),
  revokeAuthenticatedDeliveryGrant: vi.fn(), listAuthenticatedDeliveryGrants: mocks.listGrants,
  searchAuthenticatedDeliveryGrantAudiences: mocks.searchAudiences,
}));
vi.mock("../src/worker/client-portal-deny-policies", () => ({
  portalDenyPolicyManagementEnabled: () => true,
  createPortalIdentityDenial: vi.fn(), revokePortalIdentityDenial: vi.fn(),
  listPortalIdentityDenials: mocks.listDenials, searchPortalDenyIdentities: mocks.searchIdentities,
  searchPortalDenyScopes: mocks.searchScopes,
}));

import worker from "../src/worker/index";
import type { Env as OperationsEnv } from "../src/worker/types";

const principal = { id: "staff-admin", email: "admin@example.test", displayName: "Admin",
  accessSubject: "access-admin", projectAlphaUserId: "pa-admin" };
const context = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const env = { ENVIRONMENT: "development", EXPECTED_HOST: "ops.example",
  INCOMING_EXPECTED_HOST: "incoming.example", INCOMING_BASE_URL: "https://incoming.example" } as unknown as OperationsEnv;

describe("portal grant and deny management read routes", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.authenticateStaff.mockResolvedValue(principal);
    mocks.isAdministrator.mockResolvedValue(true);
    mocks.authorizeItem.mockResolvedValue("Jobs/Clients/Acme/");
    mocks.listGrants.mockResolvedValue({ folderBindingId: "binding-a", grants: [] });
    mocks.searchAudiences.mockResolvedValue({ audiences: [] });
    mocks.listDenials.mockResolvedValue({ denials: [] });
    mocks.searchIdentities.mockResolvedValue({ identities: [] });
    mocks.searchScopes.mockResolvedValue({ scopes: [] });
  });

  it("authorizes the opaque folder reference before listing scoped grants", async () => {
    const response = await worker.fetch(new Request("https://ops.example/api/delivery/authenticated-grants?folderRef=folder-acme"), env, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ folderBindingId: "binding-a", grants: [] });
    expect(mocks.authorizeItem).toHaveBeenCalledWith(env, principal, "folder-acme");
    expect(mocks.listGrants).toHaveBeenCalledWith(env, principal, "Jobs/Clients/Acme/");
  });

  it("validates and forwards bounded audience and denial scope searches", async () => {
    const audience = await worker.fetch(new Request("https://ops.example/api/delivery/authenticated-grants/audiences?folderBindingId=binding-a&q=Acme"), env, context);
    expect(audience.status).toBe(200);
    expect(mocks.searchAudiences).toHaveBeenCalledWith(env, principal, "binding-a", "Acme");

    const scope = await worker.fetch(new Request("https://ops.example/api/client-portal/identity-denials/scopes?scopeType=project&q=Hilly"), env, context);
    expect(scope.status).toBe(200);
    expect(mocks.searchScopes).toHaveBeenCalledWith(env, principal, "project", "Hilly");

    const invalid = await worker.fetch(new Request("https://ops.example/api/client-portal/identity-denials/scopes?scopeType=folder&q=secret"), env, context);
    expect(invalid.status).toBe(400);
    expect(mocks.searchScopes).toHaveBeenCalledTimes(1);
  });

  it("hydrates denial management through the gated list function", async () => {
    const response = await worker.fetch(new Request("https://ops.example/api/client-portal/identity-denials"), env, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ denials: [] });
    expect(mocks.listDenials).toHaveBeenCalledWith(env, principal);
  });
});
