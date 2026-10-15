import { describe, expect, it, vi } from "vitest";
import { nativeDeliveryDeploymentEnabled, NATIVE_DELIVERY_PRODUCTION_PROFILE,
  type NativeDeliveryDeploymentEnv } from "../src/worker/operations-native-delivery-deployment";
import { applyOperationsPortalNativeDeliveryAuthority, readOperationsPortalNativeDeliveryAuthorityStatus,
  readOperationsPortalNativeDeliveryAuthorityDisposition, cancelOperationsPortalNativeDeliveryAuthority }
  from "../src/worker/operations-portal-native-delivery-authority";
import { authorizeNativeOperationsDelivery } from "../src/worker/client-portal/operations-native-delivery-authorization";
import { appendOperationsNativeContentStart } from "../src/worker/client-portal/operations-native-content-audit";
import { createOperationsNativeDeliveryRouter } from "../src/worker/client-portal/operations-native-delivery-routes";
import type { Env } from "../src/worker/types";

const deployment: NativeDeliveryDeploymentEnv = {
  ENVIRONMENT: "production", EXPECTED_HOST: "portal.ledgetopdroneservices.com",
  PUBLIC_BASE_URL: "https://portal.ledgetopdroneservices.com",
  PUBLIC_SHARE_ORIGIN: "https://portal.ledgetopdroneservices.com",
  CLIENT_PORTAL_ORIGIN: "https://client.ledgetopdroneservices.com",
  CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE: NATIVE_DELIVERY_PRODUCTION_PROFILE,
};
const enabled = {
  CLIENT_PORTAL_ENABLED: "true",
  CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_WRITER_ENABLED: "true",
  CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_STATUS_ENABLED: "true",
  CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_CANCELLATION_ENABLED: "true",
  CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED: "true",
  CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_ENABLED: "true",
};
const denied: NativeDeliveryDeploymentEnv[] = [
  { ENVIRONMENT: "local" }, { ENVIRONMENT: "staging" }, { ENVIRONMENT: undefined },
  { CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE: undefined },
  { CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE: "staging" },
  { CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE: NATIVE_DELIVERY_PRODUCTION_PROFILE + " " },
  { EXPECTED_HOST: "client.ledgetopdroneservices.com" },
  { PUBLIC_BASE_URL: "https://client.ledgetopdroneservices.com" },
  { PUBLIC_SHARE_ORIGIN: "https://portal.ledgetoptechnologies.com" },
  { CLIENT_PORTAL_ORIGIN: "https://portal.ledgetopdroneservices.com" },
  { CLIENT_PORTAL_ORIGIN: "https://client-staging.ledgetopdroneservices.com" },
  ...["accountId", "workerName", "databaseBinding", "databaseId", "portalOrigin", "publicShareOrigin", "version"].map(key => ({
    CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE: JSON.stringify({ ...JSON.parse(NATIVE_DELIVERY_PRODUCTION_PROFILE), [key]: "wrong" }),
  })),
];

describe("explicit native delivery production deployment admission", () => {
  it("keeps staging admission and requires the exact versioned production profile", () => {
    expect(nativeDeliveryDeploymentEnabled(deployment)).toBe(true);
    expect(nativeDeliveryDeploymentEnabled(deployment, "rpc")).toBe(true);
    expect(nativeDeliveryDeploymentEnabled({ ENVIRONMENT: "staging" }, "rpc")).toBe(true);
    expect(nativeDeliveryDeploymentEnabled({ ENVIRONMENT: "staging" })).toBe(false);
    expect(nativeDeliveryDeploymentEnabled({ ENVIRONMENT: "staging", CLIENT_PORTAL_ORIGIN: "https://client-staging.ledgetopdroneservices.com" })).toBe(true);
    for (const override of denied) {
      expect(nativeDeliveryDeploymentEnabled({ ...deployment, ...override })).toBe(false);
      expect(nativeDeliveryDeploymentEnabled({ ...deployment, ...override }, "rpc")).toBe(false);
    }
  });

  it("fails closed across all private delivery surfaces before database work", async () => {
    const withSession = vi.fn(() => { throw new Error("must not access D1"); });
    const DELIVERY_DB = { withSession } as unknown as D1Database;
    for (const override of denied) {
      const env = { ...deployment, ...enabled, ...override, DELIVERY_DB };
      for (const method of [applyOperationsPortalNativeDeliveryAuthority, readOperationsPortalNativeDeliveryAuthorityStatus,
        readOperationsPortalNativeDeliveryAuthorityDisposition, cancelOperationsPortalNativeDeliveryAuthority]) {
        expect(JSON.parse(await method(env, "{}"))).toMatchObject({ ok: false, code: "disabled" });
      }
      expect(await authorizeNativeOperationsDelivery(env, { issuer: "test", subject: "test" }, "invalid", "folder.list"))
        .toEqual({ ok: false, code: "disabled" });
      await expect(appendOperationsNativeContentStart(env, {} as never)).rejects.toMatchObject({ reason: "disabled" });
    }
    expect(withSession).not.toHaveBeenCalled();
    for (const method of [applyOperationsPortalNativeDeliveryAuthority, readOperationsPortalNativeDeliveryAuthorityStatus,
      readOperationsPortalNativeDeliveryAuthorityDisposition, cancelOperationsPortalNativeDeliveryAuthority]) {
      expect(JSON.parse(await method({ ...deployment, ...enabled, DELIVERY_DB }, "{}"))).toMatchObject({ ok: false, code: "invalid" });
    }
    expect(withSession).not.toHaveBeenCalled();
  });

  it("requires authentication on the primary portal and denies public/secondary/cross-environment hosts", async () => {
    const resolvePrincipal = vi.fn(async () => null);
    const router = createOperationsNativeDeliveryRouter({ resolvePrincipal });
    // Admission/authentication tests must finish before unrelated bindings are used.
    const env = { ...deployment, ...enabled } as unknown as Env;
    for (const origin of [deployment.PUBLIC_SHARE_ORIGIN, "https://portal.ledgetoptechnologies.com", "https://client-staging.ledgetopdroneservices.com"]) {
      expect((await router.fetch(new Request(`${origin}/deliveries`), env)).status).toBe(404);
    }
    expect(resolvePrincipal).not.toHaveBeenCalled();
    const response = await router.fetch(new Request(`${deployment.CLIENT_PORTAL_ORIGIN}/deliveries`), env);
    expect(response.status).toBe(401); expect(resolvePrincipal).toHaveBeenCalledTimes(1);
    for (const override of denied) {
      expect((await router.fetch(new Request(`${deployment.CLIENT_PORTAL_ORIGIN}/deliveries`), { ...env, ...override })).status).toBe(404);
    }
    expect(resolvePrincipal).toHaveBeenCalledTimes(1);
  });
});
