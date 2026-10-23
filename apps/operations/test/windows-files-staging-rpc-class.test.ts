import { expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {
  constructor(_ctx: ExecutionContext, readonly env: object) {}
} }));
import { OperationsPortalNativeDeliveryAuthorizationReader as Reader } from "../src/worker/operations-portal-native-delivery-authorization-entrypoint";
it("retains real named RPC class's original env gate and exposes catalog/download methods", async () => {
  const env = { ENVIRONMENT: "staging", PUBLIC_BASE_URL: "https://ops-staging.ledgetopdroneservices.com", EXPECTED_HOST: "ops-staging.ledgetopdroneservices.com",
    OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED: "false", OPS_DB: { withSession: vi.fn(() => { throw Error("No SQL expected"); }) } };
  const reader = new Reader({} as ExecutionContext, env as never);
  expect(JSON.parse(await reader.readWindowsCatalogSuccessorAuthorization("{}", "folder.list"))).toMatchObject({ code: "disabled" });
  expect(JSON.parse(await reader.readWindowsDeliverySuccessorAuthorization("{}"))).toMatchObject({ code: "disabled" });
  env.OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED = "true";
  expect(JSON.parse(await reader.readWindowsCatalogSuccessorAuthorization("{}", "folder.list"))).toMatchObject({ code: "invalid" });
  expect(JSON.parse(await reader.readWindowsDeliverySuccessorAuthorization("{}"))).toMatchObject({ code: "invalid" });
  expect(env.OPS_DB.withSession).not.toHaveBeenCalled();
  // This invokes the actual class methods with a platform-base test double;
  // it deliberately does not claim Workerd service-binding dispatch.
});
