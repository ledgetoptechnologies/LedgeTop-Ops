import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {}, WorkflowEntrypoint: class {}, DurableObject: class {} }));
import worker from "../src/worker/index";
import type { Env } from "../src/worker/types";

const origin = "https://ops.ledgetopdroneservices.com";
const asset = new Response("owner asset", { status: 200 });
const base = {
  ENVIRONMENT: "production", EXPECTED_HOST: "ops.ledgetopdroneservices.com", PUBLIC_BASE_URL: origin,
  TEAM_DOMAIN: "https://ledgetoptechnologies.cloudflareaccess.com",
  OPERATIONS_AUD: "d09e298c864b9c8f4491b4b42a4dbe2ecbf558b5868d18258443740e56032407",
  OPERATIONS_SESSION_SECRET: "s".repeat(32), OPS_DB: {},
  ASSETS: { fetch: vi.fn(async () => asset.clone()) },
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: "true",
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: {
    applyNativeAuthority: vi.fn(), getNativeAuthorityStatus: vi.fn(),
  },
  OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_DISPATCH_ENABLED: "true",
  OPERATIONS_PORTAL_NATIVE_DELIVERY_CANCELLATION_ENABLED: "false",
  OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY: {
    applyNativeDeliveryAuthority: vi.fn(), getNativeDeliveryAuthorityStatus: vi.fn(),
  },
  OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_DISPATCH_ENABLED: "true",
  OPERATIONS_PORTAL_WORKSPACE_PUBLICATION: {
    publishWorkspace: vi.fn(), getPublicationStatus: vi.fn(),
  },
} as unknown as Env;
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext;
const send = (path: string, env: Env, headers?: HeadersInit) => worker.fetch!(new Request(`${origin}${path}`, { headers }), env, ctx);

describe("standard production native owner entrypoint", () => {
  it("checks in only default-off flags and exact production named RPC bindings", () => {
    const operations = JSON.parse(readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8"));
    const client = JSON.parse(readFileSync(resolve(process.cwd(), "../client/wrangler.jsonc"), "utf8"));
    for (const flag of ["OPERATIONS_PORTAL_NATIVE_DELIVERY_OWNER_ENABLED",
      "OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_DISPATCH_ENABLED", "OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED",
      "OPERATIONS_PORTAL_NATIVE_DELIVERY_CANCELLATION_ENABLED", "OPERATIONS_PORTAL_NATIVE_BILLING_OWNER_ENABLED",
      "OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED", "OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_DISPATCH_ENABLED"])
      expect(operations.vars[flag]).toBe("false");
    expect(operations.services).toEqual(expect.arrayContaining([
      { binding: "OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY", service: "ledgetop-clients",
        entrypoint: "OperationsPortalNativeDeliveryAuthorityIngress" },
      { binding: "OPERATIONS_PORTAL_WORKSPACE_PUBLICATION", service: "ledgetop-clients",
        entrypoint: "OperationsPortalWorkspacePublicationIngress" },
    ]));
    expect(client.services).toEqual(expect.arrayContaining([
      { binding: "CLIENT_PORTAL_NATIVE_FINANCIAL_READER", service: "ledgetop-ops",
        entrypoint: "ClientPortalNativeFinancialReader" },
      { binding: "OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER", service: "ledgetop-ops",
        entrypoint: "OperationsPortalNativeDeliveryAuthorizationReader" },
    ]));
  });
  it.each([
    ["recipient", "/administration/client-portal/operations-recipients", "CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED"],
    ["delivery", "/administration/client-portal/operations-delivery-authority", "OPERATIONS_PORTAL_NATIVE_DELIVERY_OWNER_ENABLED"],
    ["workspace", "/administration/client-portal/operations-workspaces", "OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED"],
    ["billing", "/administration/client-portal/operations-billing-authority", "OPERATIONS_PORTAL_NATIVE_BILLING_OWNER_ENABLED"],
    ["billing permissions", "/administration/client-portal/operations-billing-permissions", "OPERATIONS_PORTAL_NATIVE_BILLING_OWNER_ENABLED"],
  ] as const)("keeps %s default-off and serves its asset only with the exact explicit flag", async (_name, path, flag) => {
    const enabled = flag === "CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED"
      ? { CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED: "true", CLIENT_PORTAL_NATIVE_RECIPIENT_OWNER_ENABLED: "true" }
      : { [flag]: "true" };
    expect((await send(path, { ...base, ...enabled, [flag]: "false" })).status).toBe(404);
    const response = await send(path, { ...base, ...enabled });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("owner asset");
  });

  it("fails closed when the recipient page has only one flag or an incomplete private binding", async () => {
    const path = "/administration/client-portal/operations-recipients";
    expect((await send(path, { ...base, CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED: "true" })).status).toBe(404);
    expect((await send(path, { ...base, CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED: "true",
      CLIENT_PORTAL_NATIVE_RECIPIENT_OWNER_ENABLED: "true",
      OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: { applyNativeAuthority: vi.fn() } as never })).status).toBe(404);
  });

  it("fails closed for a missing workspace RPC binding and a wrong request origin", async () => {
    expect((await send("/administration/client-portal/operations-workspaces", {
      ...base, OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED: "true", OPERATIONS_PORTAL_WORKSPACE_PUBLICATION: undefined,
    })).status).toBe(404);
    const wrong = await worker.fetch!(new Request(
      "https://other.example.test/administration/client-portal/operations-delivery-authority"),
    { ...base, OPERATIONS_PORTAL_NATIVE_DELIVERY_OWNER_ENABLED: "true" }, ctx);
    expect(wrong.status).toBe(404);
  });

  it("rejects forged browser context headers before authentication", async () => {
    const response = await send("/api/native-client-portal/operations-delivery-authority/session",
      { ...base, OPERATIONS_PORTAL_NATIVE_DELIVERY_OWNER_ENABLED: "true" },
      { "Sec-Fetch-Site": "cross-site", "X-Native-Staff-Request": "1" });
    expect(response.status).toBe(403);
  });

  it.each([
    "/administration/staging/directory-maintenance-authority",
    "/api/native-client-portal/directory-maintenance-authority/session",
    "/api/native-directory/staging-empty-enrollment-fixture",
  ])("never serves staging-only maintenance or fixture routes from the standard production entrypoint: %s", async path => {
    const response = await send(path, { ...base, NATIVE_DIRECTORY_MAINTENANCE_OWNER_ENABLED: "true",
      NATIVE_DIRECTORY_STAGING_EMPTY_ENROLLMENT_FIXTURE_ENABLED: "true" } as Env);
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toBe("owner asset");
  });
});
