import { describe, expect, it, vi } from "vitest";
import { nativeDeliveryDeploymentEnabled, NATIVE_DELIVERY_PRODUCTION_PROFILE, NATIVE_DELIVERY_APP_PORTAL_PRODUCTION_PROFILE,
  NATIVE_DELIVERY_APP_PORTAL_OVERLAP_PRODUCTION_PROFILE, NATIVE_DELIVERY_APP_DELIVERY_OVERLAP_PRODUCTION_PROFILE,
  nativeDeliveryRequestOriginAllowed,
  type NativeDeliveryDeploymentEnv } from "../src/worker/operations-native-delivery-deployment";
import { applyOperationsPortalNativeDeliveryAuthority, readOperationsPortalNativeDeliveryAuthorityStatus,
  readOperationsPortalNativeDeliveryAuthorityDisposition, cancelOperationsPortalNativeDeliveryAuthority }
  from "../src/worker/operations-portal-native-delivery-authority";
import { authorizeNativeOperationsDelivery } from "../src/worker/client-portal/operations-native-delivery-authorization";
import { appendOperationsNativeContentStart } from "../src/worker/client-portal/operations-native-content-audit";
import { createOperationsNativeDeliveryRouter } from "../src/worker/client-portal/operations-native-delivery-routes";
import type { Env } from "../src/worker/types";
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import { publishOperationsPortalWorkspaceRpc, getOperationsPortalWorkspacePublicationStatusRpc,
  cancelOperationsPortalWorkspacePublicationRpc, getOperationsPortalWorkspacePublicationDispositionRpc }
  from "../src/worker/operations-portal-workspace-publication-entrypoint";

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
  CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "true",
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
  it("accepts exact installed overlap metadata without reopening legacy browser access", () => {
    for (const publicOrigin of ["https://portal.ledgetopdroneservices.com", "https://delivery.ledgetop.app"]) {
      const profile = publicOrigin === "https://delivery.ledgetop.app"
        ? NATIVE_DELIVERY_APP_DELIVERY_OVERLAP_PRODUCTION_PROFILE : NATIVE_DELIVERY_APP_PORTAL_OVERLAP_PRODUCTION_PROFILE;
      const env = { ...deployment, EXPECTED_HOST: new URL(publicOrigin).host,
        PUBLIC_BASE_URL: publicOrigin, PUBLIC_SHARE_ORIGIN: publicOrigin,
        CLIENT_PORTAL_ORIGIN: "https://portal.ledgetop.app",
        CLIENT_PORTAL_ORIGINS: "https://portal.ledgetop.app,https://portal.ledgetopdroneservices.com",
        CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE: profile };
      expect(nativeDeliveryDeploymentEnabled(env)).toBe(true);
      expect(nativeDeliveryRequestOriginAllowed(env, "https://portal.ledgetop.app/portal/data")).toBe(true);
      for (const origin of ["https://portal.ledgetopdroneservices.com", "https://client.ledgetopdroneservices.com", "https://delivery.ledgetop.app"])
        expect(nativeDeliveryRequestOriginAllowed(env, origin + "/portal/data")).toBe(false);
      const changed = JSON.stringify({ ...JSON.parse(profile), databaseId: "unreviewed" });
      expect(nativeDeliveryDeploymentEnabled({ ...env, CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE: changed })).toBe(false);
    }
  });

  it("keeps staging admission and requires the exact versioned production profile", () => {
    expect(nativeDeliveryDeploymentEnabled(deployment)).toBe(true);
    expect(nativeDeliveryDeploymentEnabled(deployment, "rpc")).toBe(true);
    expect(nativeDeliveryDeploymentEnabled(deployment, "publication")).toBe(true);
    expect(nativeDeliveryDeploymentEnabled({ ENVIRONMENT: "staging", EXPECTED_HOST: "delivery-staging.ledgetopdroneservices.com" }, "publication")).toBe(true);
    expect(nativeDeliveryDeploymentEnabled({ ENVIRONMENT: "staging", EXPECTED_HOST: "client-staging.ledgetopdroneservices.com" }, "publication")).toBe(false);
    expect(nativeDeliveryDeploymentEnabled({ ENVIRONMENT: "staging" }, "rpc")).toBe(true);
    expect(nativeDeliveryDeploymentEnabled({ ENVIRONMENT: "staging" })).toBe(false);
    expect(nativeDeliveryDeploymentEnabled({ ENVIRONMENT: "staging", CLIENT_PORTAL_ORIGIN: "https://client-staging.ledgetopdroneservices.com" })).toBe(true);
    for (const override of denied) {
      expect(nativeDeliveryDeploymentEnabled({ ...deployment, ...override })).toBe(false);
      expect(nativeDeliveryDeploymentEnabled({ ...deployment, ...override }, "rpc")).toBe(false);
      expect(nativeDeliveryDeploymentEnabled({ ...deployment, ...override }, "publication")).toBe(false);
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
      for (const method of [publishOperationsPortalWorkspaceRpc, getOperationsPortalWorkspacePublicationStatusRpc,
        cancelOperationsPortalWorkspacePublicationRpc, getOperationsPortalWorkspacePublicationDispositionRpc]) {
        expect(await method(env, {})).toMatchObject({ ok: false, code: "disabled" });
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


describe("exact .app private host overlap", () => {
  const portal="https://portal.ledgetop.app";
  const candidate={...deployment, ...enabled, CLIENT_PORTAL_ORIGIN:portal,
    CLIENT_PORTAL_ORIGINS:portal,
    CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE:NATIVE_DELIVERY_APP_PORTAL_PRODUCTION_PROFILE};
  it("admits only the canonical portal before authentication", async()=>{
    const resolvePrincipal=vi.fn(async()=>null), router=createOperationsNativeDeliveryRouter({resolvePrincipal});
    const response=await router.fetch(new Request(`${portal}/deliveries`),candidate as unknown as Env);
    expect(response.status).toBe(401);expect(response.headers.get("Location")).toBeNull();
    expect(resolvePrincipal).toHaveBeenCalledTimes(1);
    for(const origin of ["https://portal.ledgetopdroneservices.com","https://portal.ledgetoptechnologies.com","https://client.ledgetopdroneservices.com",
      "https://ops.ledgetop.app","https://ledgetop.app"])
      expect((await router.fetch(new Request(`${origin}/deliveries`),candidate as unknown as Env)).status).toBe(404);
    expect(resolvePrincipal).toHaveBeenCalledTimes(1);
  });
  it("requires the exact physical profile and explicit private alias registration",async()=>{
    const resolvePrincipal=vi.fn(async()=>null), router=createOperationsNativeDeliveryRouter({resolvePrincipal});
    const profile=JSON.parse(NATIVE_DELIVERY_APP_PORTAL_PRODUCTION_PROFILE);
    for(const change of [{databaseId:"wrong-database"},{privateRequestOrigins:["https://portal.ledgetopdroneservices.com"]},
      {privateRequestOrigins:[portal,"https://portal.ledgetoptechnologies.com"]}]) {
      const env={...candidate,CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE:JSON.stringify({...profile,...change})};
      for(const surface of ["portal","rpc","publication"] as const) expect(nativeDeliveryDeploymentEnabled(env,surface)).toBe(false);
      expect((await router.fetch(new Request(`${portal}/deliveries`),env as unknown as Env)).status).toBe(404);
    }
    const extraAlias={...candidate,CLIENT_PORTAL_ORIGINS:`${portal},https://portal.ledgetopdroneservices.com`};
    expect((await router.fetch(new Request("https://portal.ledgetopdroneservices.com/deliveries"),extraAlias as unknown as Env)).status).toBe(404);
    expect(resolvePrincipal).not.toHaveBeenCalled();
  });
});
