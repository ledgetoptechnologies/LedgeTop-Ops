import { describe, expect, it, vi } from "vitest";
import { SEPARATE_NATIVE_STAGE as stage, type SeparateNativeStagingEnv,
  exactSeparateNativeStagingDeployment } from "../src/worker/separate-staging-native-authority-policy";
import { createSeparateNativeStagingHandler } from "../src/worker/separate-staging-native-authority-handler";

const base: SeparateNativeStagingEnv = {
  ENVIRONMENT: "staging", STAGING_NATIVE_REQUEST_PROFILE: stage.profile,
  EXPECTED_HOST: stage.host, PUBLIC_BASE_URL: stage.origin, DELIVERY_BASE_URL: stage.recipientOrigin,
  TEAM_DOMAIN: stage.issuer, OPERATIONS_AUD: stage.audience,
};
const recipientPath = "/api/native-client-portal/operations-recipient-enrollment/session";
const workspacePath = "/api/native-client-portal/operations-workspaces/session";
const request = (path: string, origin = stage.origin) => new Request(`${origin}${path}`);
const recipient = () => ({ ...base, CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED: "true",
  CLIENT_PORTAL_NATIVE_RECIPIENT_OWNER_ENABLED: "true",
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: "true",
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: { applyNativeAuthority() {}, getNativeAuthorityStatus() {} } });
function fixture() {
  const calls = { ordinary: vi.fn(async () => new Response("ordinary")),
    recipient: vi.fn(async () => new Response("recipient")), workspace: vi.fn(async () => new Response("workspace")) };
  const handle = createSeparateNativeStagingHandler<SeparateNativeStagingEnv, undefined>(calls);
  return { calls, handle };
}

describe("separate-account native staging admission", () => {
  it.each([
    { ENVIRONMENT: "production" }, { ENVIRONMENT: "development" },
    { STAGING_NATIVE_REQUEST_PROFILE: undefined }, { STAGING_NATIVE_REQUEST_PROFILE: "legacy" },
    { EXPECTED_HOST: "ops-staging.ledgetopdroneservices.com" },
    { PUBLIC_BASE_URL: "https://ops.ledgetop.app" }, { PUBLIC_BASE_URL: `${stage.origin}/` },
    { DELIVERY_BASE_URL: "https://portal.ledgetop.app" },
    { TEAM_DOMAIN: "https://ledgetoptechnologies.cloudflareaccess.com" },
    { OPERATIONS_AUD: "a".repeat(64) },
  ])("rejects configuration drift before dispatch: %j", async override => {
    const { calls, handle } = fixture();
    expect(await handle(request(recipientPath), { ...recipient(), ...override }, undefined).then(r => r.status)).toBe(404);
    Object.values(calls).forEach(call => expect(call).not.toHaveBeenCalled());
  });

  it.each(["https://ops.ledgetop.app", "https://ops-staging.ledgetopdroneservices.com",
    "http://ledge-top-ops-staging.ledge-top-staging.workers.dev", `${stage.origin}:8443`,
    "https://ledge-top-ops-staging.ledge-top-staging.workers.dev.example.invalid",
  ])("rejects another request origin even with correct env and forged Origin header: %s", async origin => {
    const { calls, handle } = fixture();
    const forged = new Request(`${origin}${recipientPath}`, { headers: { Origin: stage.origin } });
    expect((await handle(forged, recipient(), undefined)).status).toBe(404);
    Object.values(calls).forEach(call => expect(call).not.toHaveBeenCalled());
  });

  it("keeps owner routes default-off while configuration alone admits ordinary app handling", async () => {
    const { calls, handle } = fixture();
    expect(exactSeparateNativeStagingDeployment(request("/"), base)).toBe(true);
    expect((await handle(request(recipientPath), base, undefined)).status).toBe(404);
    expect((await handle(request(workspacePath), base, undefined)).status).toBe(404);
    expect((await handle(request("/account"), base, undefined)).status).toBe(200);
    expect(calls.ordinary).toHaveBeenCalledOnce(); expect(calls.recipient).not.toHaveBeenCalled();
  });

  it.each(["CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED", "CLIENT_PORTAL_NATIVE_RECIPIENT_OWNER_ENABLED",
    "OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED"] as const)("requires independent literal-true gate %s", async flag => {
    const { calls, handle } = fixture();
    for (const value of [undefined, "false", "TRUE"]) {
      expect((await handle(request(recipientPath), { ...recipient(), [flag]: value }, undefined)).status).toBe(404);
    }
    expect(calls.recipient).not.toHaveBeenCalled();
  });

  it("requires complete private authority methods and delegates to existing authentication without financial/file gates", async () => {
    const { calls, handle } = fixture();
    for (const binding of [undefined, {}, { applyNativeAuthority() {} },
      new Proxy({}, { get() { throw new Error("unavailable binding"); } })]) {
      expect((await handle(request(recipientPath), { ...recipient(), OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: binding }, undefined)).status).toBe(404);
    }
    expect(calls.recipient).not.toHaveBeenCalled();
    expect(await (await handle(request(recipientPath), recipient(), undefined)).text()).toBe("recipient");
    expect(calls.recipient).toHaveBeenCalledOnce(); expect(calls.ordinary).not.toHaveBeenCalled();
  });

  it("keeps workspace publication independently gated and receipted by its existing handler", async () => {
    const { calls, handle } = fixture();
    const enabled = { ...base, OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED: "true",
      OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_DISPATCH_ENABLED: "true",
      OPERATIONS_PORTAL_WORKSPACE_PUBLICATION: { publishWorkspace() {}, getPublicationStatus() {} } };
    expect((await handle(request(workspacePath), { ...enabled, OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED: "false" }, undefined)).status).toBe(404);
    expect((await handle(request(workspacePath), { ...enabled, OPERATIONS_PORTAL_WORKSPACE_PUBLICATION: {} }, undefined)).status).toBe(404);
    expect(await (await handle(request(workspacePath), enabled, undefined)).text()).toBe("workspace");
    expect(calls.workspace).toHaveBeenCalledOnce(); expect(calls.recipient).not.toHaveBeenCalled();
  });

  it.each(["/api/native-client-portal/operations-billing-authority/session",
    "/api/native-client-portal/operations-delivery-authority/session",
    "/api/native-client-portal/directory-maintenance-authority/session",
    "/api/native-client-portal/not-reviewed", "/administration/staging/directory-maintenance-authority",
    "/administration/client-portal/operations-billing-permissions",
  ])("does not expose excluded authority paths through the ordinary worker: %s", async path => {
    const { calls, handle } = fixture();
    expect((await handle(request(path), recipient(), undefined)).status).toBe(404);
    Object.values(calls).forEach(call => expect(call).not.toHaveBeenCalled());
  });
});
