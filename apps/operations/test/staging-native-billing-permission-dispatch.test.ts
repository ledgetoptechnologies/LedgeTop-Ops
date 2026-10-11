import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  standard: vi.fn(async () => new Response("standard")),
  delegation: vi.fn(async (_request: Request, _dependencies: unknown) => new Response("delegation")),
  billing: vi.fn(async () => new Response("billing")),
  assets: vi.fn(async () => new Response("page")),
}));

vi.mock("../src/worker/index", () => ({ default: { fetch: mocks.standard, queue: vi.fn(), scheduled: vi.fn() } }));
vi.mock("../src/worker/operations-portal-native-recipient-owner-http", () => ({ handleOperationsNativeRecipientOwnerHttp: vi.fn() }));
vi.mock("../src/worker/operations-portal-native-delivery-authority-owner-http", () => ({ handleOperationsPortalNativeDeliveryAuthorityOwnerHttp: vi.fn() }));
vi.mock("../src/worker/operations-portal-workspace-owner-http", () => ({ handleOperationsPortalWorkspaceOwnerHttp: vi.fn() }));
vi.mock("../src/worker/operations-portal-native-billing-authority-owner-http", () => ({ handleOperationsPortalNativeBillingAuthorityOwnerHttp: mocks.billing }));
vi.mock("../src/worker/operations-portal-native-billing-permission-owner-http", () => ({
  OPERATIONS_NATIVE_BILLING_PERMISSION_OWNER_BASE: "/api/native-client-portal/operations-billing-permissions",
  handleOperationsPortalNativeBillingPermissionOwnerHttp: mocks.delegation,
}));
vi.mock("../src/worker/operations-portal-native-billing-authority-issuer", () => ({
  reviewOperationsPortalNativeBillingCandidate: vi.fn(), grantOperationsPortalNativeBillingAuthority: vi.fn(),
  revokeOperationsPortalNativeBillingAuthority: vi.fn(), readOperationsPortalNativeBillingAuthorityStatus: vi.fn(),
}));
vi.mock("../src/worker/operations-portal-native-delivery-authorization-entrypoint", () => ({
  OperationsPortalNativeDeliveryAuthorizationReader: class {},
}));
vi.mock("../src/worker/client-portal-native-financial-entrypoint", () => ({
  ClientPortalNativeFinancialReader: class {},
}));

import worker from "../src/worker/staging-native-authority-entrypoint";

const origin = "https://ops-staging.ledgetopdroneservices.com";
const api = "/api/native-client-portal/operations-billing-permissions/session";
const page = "/administration/client-portal/operations-billing-permissions";
type WorkerEnv = Parameters<typeof worker.fetch>[1];
const enabled: Partial<WorkerEnv> = {
  ENVIRONMENT: "staging", EXPECTED_HOST: "ops-staging.ledgetopdroneservices.com", PUBLIC_BASE_URL: origin,
  CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED: "true", CLIENT_PORTAL_NATIVE_RECIPIENT_OWNER_ENABLED: "true",
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: "true",
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: { fetch: vi.fn(), connect: vi.fn(),
    applyNativeAuthority: vi.fn(), getNativeAuthorityStatus: vi.fn() },
  OPERATIONS_PORTAL_NATIVE_DELIVERY_OWNER_ENABLED: "true", OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_DISPATCH_ENABLED: "true",
  OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY: { applyNativeDeliveryAuthority: vi.fn(), getNativeDeliveryAuthorityStatus: vi.fn() },
  OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED: "true",
  OPERATIONS_PORTAL_NATIVE_BILLING_OWNER_ENABLED: "true", TEAM_DOMAIN: "example", OPERATIONS_AUD: "aud",
  OPERATIONS_SESSION_SECRET: "test-secret", ASSETS: { fetch: mocks.assets, connect: vi.fn() },
};
const dispatch = (url: string, overrides: Record<string, unknown> = {}) =>
  // Only the admission and dispatch bindings are exercised by this mock-backed test.
  worker.fetch(new Request(url), { ...enabled, ...overrides } as WorkerEnv, {} as ExecutionContext);

describe("mounted billing permission delegation dispatch", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("dispatches only exact staging API and page to their respective handlers", async () => {
    expect(await (await dispatch(`${origin}${api}`)).text()).toBe("delegation");
    expect(mocks.delegation).toHaveBeenCalledTimes(1);
    expect(mocks.delegation.mock.calls[0]?.[1]).toMatchObject({
      environment: "staging", expectedHost: "ops-staging.ledgetopdroneservices.com", delegationFlag: "true",
      configuration: { origin, enabled: true },
    });
    expect(await (await dispatch(`${origin}${page}`)).text()).toBe("page");
    expect(mocks.assets).toHaveBeenCalledTimes(1);
    expect(mocks.billing).not.toHaveBeenCalled();
    expect(mocks.standard).not.toHaveBeenCalled();
  });

  it("returns 404 before any handler for default-off, production, or other host", async () => {
    for (const url of [`${origin}${api}`, `${origin}${page}`]) {
      for (const overrides of [
        { OPERATIONS_PORTAL_NATIVE_BILLING_OWNER_ENABLED: undefined },
        { OPERATIONS_PORTAL_NATIVE_BILLING_OWNER_ENABLED: "false" },
        { ENVIRONMENT: "production" },
      ]) expect((await dispatch(url, overrides)).status).toBe(404);
    }
    expect((await dispatch(`https://ops.ledgetopdroneservices.com${api}`)).status).toBe(404);
    expect((await dispatch(`https://ops.ledgetopdroneservices.com${page}`)).status).toBe(404);
    expect(mocks.delegation).not.toHaveBeenCalled();
    expect(mocks.assets).not.toHaveBeenCalled();
    expect(mocks.standard).not.toHaveBeenCalled();
  });

  it("does not capture neighboring paths or confuse billing authority routing", async () => {
    expect(await (await dispatch(`${origin}/api/native-client-portal/operations-billing-permissions-extra/session`)).text()).toBe("standard");
    expect(await (await dispatch(`${origin}/administration/client-portal/operations-billing-permissions-extra`)).text()).toBe("standard");
    expect(await (await dispatch(`${origin}/api/native-client-portal/operations-billing-authority/session`)).text()).toBe("billing");
    expect(mocks.standard).toHaveBeenCalledTimes(2);
    expect(mocks.billing).toHaveBeenCalledTimes(1);
    expect(mocks.delegation).not.toHaveBeenCalled();
  });
});
