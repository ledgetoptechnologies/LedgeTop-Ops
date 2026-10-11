import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  standard: vi.fn(async () => new Response("standard")),
  maintenance: vi.fn(async (_request: Request, _dependencies: unknown) => new Response("maintenance")),
  billing: vi.fn(async () => new Response("billing")),
  assets: vi.fn(async () => new Response("page")),
}));
vi.mock("../src/worker/index", () => ({ default: { fetch: mocks.standard, queue: vi.fn(), scheduled: vi.fn() } }));
vi.mock("../src/worker/operations-native-directory-maintenance-owner-http", () => ({
  handleOperationsNativeDirectoryMaintenanceOwnerHttp: mocks.maintenance,
}));
vi.mock("../src/worker/operations-portal-native-recipient-owner-http", () => ({ handleOperationsNativeRecipientOwnerHttp: vi.fn() }));
vi.mock("../src/worker/operations-portal-native-delivery-authority-owner-http", () => ({ handleOperationsPortalNativeDeliveryAuthorityOwnerHttp: vi.fn() }));
vi.mock("../src/worker/operations-portal-workspace-owner-http", () => ({ handleOperationsPortalWorkspaceOwnerHttp: vi.fn() }));
vi.mock("../src/worker/operations-portal-native-billing-authority-owner-http", () => ({ handleOperationsPortalNativeBillingAuthorityOwnerHttp: mocks.billing }));
vi.mock("../src/worker/operations-portal-native-billing-permission-owner-http", () => ({
  OPERATIONS_NATIVE_BILLING_PERMISSION_OWNER_BASE: "/api/native-client-portal/operations-billing-permissions",
  handleOperationsPortalNativeBillingPermissionOwnerHttp: vi.fn(),
}));
vi.mock("../src/worker/operations-portal-native-billing-authority-issuer", () => ({
  reviewOperationsPortalNativeBillingCandidate: vi.fn(), grantOperationsPortalNativeBillingAuthority: vi.fn(),
  revokeOperationsPortalNativeBillingAuthority: vi.fn(), readOperationsPortalNativeBillingAuthorityStatus: vi.fn(),
}));
vi.mock("../src/worker/operations-portal-native-delivery-authorization-entrypoint", () => ({
  OperationsPortalNativeDeliveryAuthorizationReader: class {},
}));
vi.mock("../src/worker/client-portal-native-financial-entrypoint", () => ({ ClientPortalNativeFinancialReader: class {} }));

import worker from "../src/worker/staging-native-authority-entrypoint";

const origin = "https://ops-staging.ledgetopdroneservices.com";
const api = "/api/native-client-portal/directory-maintenance-authority/session";
const page = "/administration/staging/directory-maintenance-authority";
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
  NATIVE_DIRECTORY_MAINTENANCE_OWNER_ENABLED: "true", TEAM_DOMAIN: "example", OPERATIONS_AUD: "aud",
  OPERATIONS_SESSION_SECRET: "test-secret", ASSETS: { fetch: mocks.assets, connect: vi.fn() },
};
const dispatch = (url: string, overrides: Record<string, unknown> = {}) =>
  worker.fetch(new Request(url), { ...enabled, ...overrides } as WorkerEnv, {} as ExecutionContext);

describe("mounted staging directory maintenance dispatch", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("routes exact staging API and page to their own handlers", async () => {
    expect(await (await dispatch(`${origin}${api}`)).text()).toBe("maintenance");
    expect(mocks.maintenance.mock.calls[0]?.[1]).toMatchObject({
      environment: "staging", expectedHost: "ops-staging.ledgetopdroneservices.com", enabledFlag: "true",
      configuration: { origin, enabled: true },
    });
    expect(await (await dispatch(`${origin}${page}`)).text()).toBe("page");
    expect(mocks.assets).toHaveBeenCalledTimes(1);
    expect(mocks.billing).not.toHaveBeenCalled();
    expect(mocks.standard).not.toHaveBeenCalled();
  });

  it("never dispatches when its own flag is absent or staging identity drifts", async () => {
    for (const url of [`${origin}${api}`, `${origin}${page}`]) for (const override of [
      { NATIVE_DIRECTORY_MAINTENANCE_OWNER_ENABLED: undefined, OPERATIONS_PORTAL_NATIVE_BILLING_OWNER_ENABLED: "true" },
      { NATIVE_DIRECTORY_MAINTENANCE_OWNER_ENABLED: "false" },
      { ENVIRONMENT: "production" },
      { PUBLIC_BASE_URL: "https://ops.ledgetopdroneservices.com" },
    ]) expect((await dispatch(url, override)).status).toBe(404);
    expect((await dispatch(`https://ops.ledgetopdroneservices.com${api}`)).status).toBe(404);
    expect((await dispatch(`https://ops.ledgetopdroneservices.com${page}`)).status).toBe(404);
    expect(mocks.maintenance).not.toHaveBeenCalled();
    expect(mocks.assets).not.toHaveBeenCalled();
    expect(mocks.standard).not.toHaveBeenCalled();
  });

  it("does not capture similarly prefixed paths", async () => {
    expect(await (await dispatch(`${origin}/api/native-client-portal/directory-maintenance-authority-extra/session`)).text()).toBe("standard");
    expect(await (await dispatch(`${origin}/administration/staging/directory-maintenance-authority-extra`)).text()).toBe("standard");
    expect(mocks.maintenance).not.toHaveBeenCalled();
    expect(mocks.standard).toHaveBeenCalledTimes(2);
  });
});
