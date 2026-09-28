import { expect, test, type Page } from "@playwright/test";

const response = {
  resourceMode: "operations_home",
  homes: [{
    authorityId: "12345678-1234-4123-8123-123456789abc",
    workspaceId: "workspace-one",
    ownershipEpoch: 2,
    grantRevision: 4,
    services: [
      { serviceId: "service-one", providerId: "provider-a", displayLabel: "Aerial operations", revision: 3 },
      { serviceId: "service-two", providerId: "provider-b", displayLabel: "Infrastructure review", revision: 1 },
    ],
  }],
};

async function expectAuthorizedNavigation(page: Page, unavailableLinks: string[] = []) {
  const trigger = page.getByRole("button", { name: "Open navigation", exact: true });
  const mobile = await trigger.isVisible();
  if (mobile) await trigger.click();
  const navigation = page.getByRole("navigation", {
    name: mobile ? "Mobile client portal navigation" : "Client portal", exact: true,
  });
  await expect(navigation).toHaveCount(1);
  await expect(navigation).toBeVisible();
  for (const name of unavailableLinks) await expect(navigation.getByRole("link", { name, exact: true })).toHaveCount(0);
  if (mobile) {
    await page.getByRole("button", { name: "Close navigation", exact: true }).click();
    await expect(navigation).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
}

async function interceptClientApi(page: Page, status: number, body: unknown, clientSession?: unknown) {
  const calls: string[] = [];
  await page.route("**/api/client/**", route => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    if (path === "/api/client/v2/operations/home") return route.fulfill({ status, json: body });
    if (path === "/api/client/session") return clientSession
      ? route.fulfill({ json: clientSession })
      : route.fulfill({ status: 401, json: { error: "Sign in required" } });
    if (path === "/api/client/projects") return route.fulfill({ json: { projects: [] } });
    if (path === "/api/client/service-requests") return route.fulfill({ json: { requests: [] } });
    if (path === "/api/client/map-config") return route.fulfill({ json: { mapboxPublicToken: null } });
    if (path === "/api/client/notification-history") return route.fulfill({ json: {
      scope: { sourceId: "project-alpha:primary", workspaceId: null, rootType: "client", rootPublicId: "account-a" },
      asOf: "2026-09-28T12:00:00.000Z", coverage: {
        requests: "omitted_feature_disabled", feedback: "omitted_feature_disabled",
        authenticatedDelivery: "omitted_feature_disabled", delivery: "omitted_no_explicit_grant_authority",
      }, items: [], nextCursor: null,
    } });
    if (path === "/api/client/request-readiness") return route.fulfill({ json: {
      mode: "legacy", workspaceId: null, target: { kind: "root", projectId: null },
      canStartRequest: false, reason: "request_not_permitted",
      root: { canStartRequest: false, reason: "request_not_permitted" },
      projectRequestsSupported: false, refreshedAt: "2026-09-28T12:00:00.000Z",
    } });
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  return calls;
}

test("operations metadata remains the only surface when the independent client bootstrap is denied", async ({ page }) => {
  const calls = await interceptClientApi(page, 200, response);
  await page.goto("/portal");
  await expect(page.getByRole("heading", { name: "Your services" })).toBeVisible();
  await expect(page.getByText("Aerial operations", { exact: true })).toBeVisible();
  await expect(page.getByText("Infrastructure review", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Client resources unavailable" })).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByText(/projects|files|billing/i)).toHaveCount(0);
  expect(calls).toEqual(["/api/client/v2/operations/home", "/api/client/session"]);
});

test("independently authorized client portal composes an actionless operations summary in one shell", async ({ page }) => {
  const calls = await interceptClientApi(page, 200, response, {
    account: { id: "account-a", displayName: "Acme Surveying" },
    capabilities: { requestV2: false, feedback: false },
  });
  await page.goto("/portal");

  await expect(page.getByRole("heading", { name: "Hello, Acme Surveying" })).toHaveCount(1);
  await expectAuthorizedNavigation(page, ["Requests", "Feedback"]);
  await expect(page.getByRole("link", { name: "Requests" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Feedback" })).toHaveCount(0);
  const summary = page.getByRole("region", { name: "Independent operations service summary" });
  await expect(summary).toContainText("Files and requests follow the access for your selected workspace");
  await expect(summary.getByText("Aerial operations", { exact: true })).toBeVisible();
  await expect(summary.getByRole("link")).toHaveCount(0);
  await expect(summary.getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Your services" })).toHaveCount(0);
  await expect.poll(() => calls.length).toBe(7);
  expect(calls.slice(0, 2)).toEqual(["/api/client/v2/operations/home", "/api/client/session"]);
  expect(new Set(calls.slice(2))).toEqual(new Set([
    "/api/client/projects", "/api/client/service-requests", "/api/client/map-config",
    "/api/client/notification-history", "/api/client/request-readiness",
  ]));
});

test("independently authorized native dashboard keeps its workspace distinct from operations metadata", async ({ page }) => {
  const calls: Array<{ path: string; workspace?: string }> = [];
  const nativeWorkspace = {
    id: "workspace-b", rootType: "organization", rootPublicId: "org-shared",
    displayName: "Native Resource Workspace", resourceMode: "native", sourceId: "project-alpha:coastal",
  };
  await page.route("**/api/client/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    calls.push({ path, workspace: request.headers()["x-ltds-workspace-id"] });
    if (path === "/api/client/v2/operations/home") return route.fulfill({ json: response });
    if (path === "/api/client/session") return route.fulfill({ json: {
      account: { id: "", displayName: "Client portal" }, capabilities: { workspaceHierarchyV2: true },
    } });
    if (path === "/api/client/v2/workspaces") return route.fulfill({ json: { workspaces: [nativeWorkspace] } });
    if (path === "/api/client/v2/workspaces/workspace-b/context") return route.fulfill({ json: {
      workspace: nativeWorkspace, contextVersion: "context-workspace-b",
      features: {
        directory: { state: "available", reason: "authorized_capability" },
        deliveries: { state: "temporarily_unavailable", reason: "backend_unavailable" },
        serviceRequests: { state: "not_supported", reason: "source_not_supported" },
        feedback: { state: "not_in_access", reason: "capability_not_granted" },
        models: { state: "not_supported", reason: "source_not_supported" },
        team: { state: "not_supported", reason: "source_not_supported" },
        billing: { state: "not_supported", reason: "source_not_supported" },
      },
      capabilities: {
        directoryRead: true, deliveryView: false, requestV2: false, requestAttachments: false,
        feedback: false, manageTeam: false, workspaceMembershipManagement: false,
        delegatedShares: false, viewer: false, viewerShares: false, viewBilling: false,
      },
    } });
    if (path === "/api/client/v2/workspaces/workspace-b/hierarchy") return route.fulfill({ json: {
      workspaceId: "workspace-b", sourceId: "project-alpha:coastal", contextVersion: "context-workspace-b",
      page: { nextCursor: null }, entries: [],
    } });
    if (path === "/api/client/notification-history") return route.fulfill({ json: {
      scope: { sourceId: "project-alpha:coastal", workspaceId: "workspace-b", rootType: "organization", rootPublicId: "org-shared" },
      asOf: "2026-09-28T12:00:00.000Z", coverage: {
        requests: "omitted_feature_disabled", feedback: "omitted_feature_disabled",
        authenticatedDelivery: "omitted_feature_disabled", delivery: "omitted_no_explicit_grant_authority",
      }, items: [], nextCursor: null,
    } });
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });

  await page.goto("/portal?workspace=workspace-b");
  await expect(page.getByRole("heading", { name: "Native Resource Workspace" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Operations services" })).toBeVisible();
  await expect(page.getByText("Aerial operations", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Hello,/ })).toHaveCount(0);
  await expectAuthorizedNavigation(page);
  expect(calls.some(call => call.path.endsWith("/context"))).toBe(true);
  expect(calls.every(call => call.workspace !== "workspace-one")).toBe(true);
});

test("invalid client workspace hint can recover through a fresh operations probe and available client workspace", async ({ page }) => {
  const calls = await interceptClientApi(page, 200, response, {
    account: { id: "account-a", displayName: "Authorized Client" }, capabilities: { workspaceHierarchyV2: true },
  });
  await page.route("**/api/client/v2/workspaces", route => route.fulfill({ json: { workspaces: [{
    id: "authorized-workspace", rootType: "standalone_client", rootPublicId: "client-a", displayName: "Authorized resources",
  }] } }));
  await page.goto("/portal?workspace=not-authorized");
  await expect(page.getByRole("heading", { name: "Client resources unavailable" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your services" })).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Hello,/ })).toHaveCount(0);
  expect(calls).not.toContain("/api/client/v2/workspaces/not-authorized/context");
  await page.getByRole("button", { name: "Try available client workspaces" }).click();
  await expect(page).toHaveURL(/\/portal$/);
  await expect(page.getByRole("heading", { name: "Hello, Authorized Client" })).toBeVisible();
  await expectAuthorizedNavigation(page);
  expect(calls.filter(path => path === "/api/client/v2/operations/home")).toHaveLength(2);
});

test("client recovery stops before client reads when the fresh operations probe is denied", async ({ page }) => {
  const calls: string[] = [];
  let operationsReads = 0;
  await page.route("**/api/client/**", route => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    if (path === "/api/client/v2/operations/home") return ++operationsReads === 1
      ? route.fulfill({ json: response })
      : route.fulfill({ status: 403, json: { error: "not enabled" } });
    if (path === "/api/client/session") return route.fulfill({ json: {
      account: { id: "account-a", displayName: "Authorized Client" }, capabilities: { workspaceHierarchyV2: true },
    } });
    if (path === "/api/client/v2/workspaces") return route.fulfill({ json: { workspaces: [{
      id: "authorized-workspace", rootType: "standalone_client", rootPublicId: "client-a", displayName: "Authorized resources",
    }] } });
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  await page.goto("/portal?workspace=not-authorized");
  await expect(page.getByRole("heading", { name: "Client resources unavailable" })).toBeVisible();
  expect(calls.filter(path => path === "/api/client/session")).toHaveLength(1);
  await page.getByRole("button", { name: "Try available client workspaces" }).click();
  await expect(page.getByRole("heading", { name: "Service home access is not enabled" })).toBeVisible();
  expect(calls.filter(path => path === "/api/client/v2/operations/home")).toHaveLength(2);
  expect(calls.filter(path => path === "/api/client/session")).toHaveLength(1);
});

test("unified portal accepts server metadata boundaries and opaque slash IDs", async ({ page }) => {
  const label = "L".repeat(160);
  const boundaryResponse = {
    resourceMode: "operations_home",
    homes: [{
      authorityId: "abcdefab-cdef-4abc-8def-abcdefabcdef",
      workspaceId: `/${"w".repeat(199)}`,
      ownershipEpoch: 1,
      grantRevision: 1,
      services: [{
        serviceId: `/${"s".repeat(190)}`,
        providerId: `/${"p".repeat(127)}`,
        displayLabel: label,
        revision: 1,
      }],
    }],
  };
  const calls = await interceptClientApi(page, 200, boundaryResponse);
  await page.goto("/portal");
  await expect(page.getByText(label, { exact: true })).toBeVisible();
  expect(calls).toEqual(["/api/client/v2/operations/home", "/api/client/session"]);
});

for (const [status, heading] of [[401, "Sign in required"], [403, "Service home access is not enabled"], [503, "Service home unavailable"]] as const) {
  test(`${status} never starts the legacy portal`, async ({ page }) => {
    const calls = await interceptClientApi(page, status, { error: "unavailable" });
    await page.goto("/portal");
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    expect(calls).toEqual(["/api/client/v2/operations/home"]);
  });
}

test("malformed success never starts the legacy portal", async ({ page }) => {
  const calls = await interceptClientApi(page, 200, { resourceMode: "operations_home", homes: response.homes, extra: true });
  await page.goto("/portal");
  await expect(page.getByRole("heading", { name: "Service home unavailable" })).toBeVisible();
  expect(calls).toEqual(["/api/client/v2/operations/home"]);
});

test("network failure never starts the legacy portal", async ({ page }) => {
  const calls: string[] = [];
  await page.route("**/api/client/**", route => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    return path === "/api/client/v2/operations/home"
      ? route.abort("connectionfailed")
      : route.fulfill({ status: 500, json: { error: "unexpected legacy request" } });
  });
  await page.goto("/portal");
  await expect(page.getByRole("heading", { name: "Service home unavailable" })).toBeVisible();
  expect(calls).toEqual(["/api/client/v2/operations/home"]);
});

test("404 is the sole legacy fallback", async ({ page }) => {
  const calls = await interceptClientApi(page, 404, { error: "disabled" });
  await page.goto("/portal");
  await expect(page.getByText(/sign in/i).first()).toBeVisible();
  await expect.poll(() => calls).toContain("/api/client/session");
});

test("legacy subroutes and public routes do not use the operations probe", async ({ page }) => {
  const calls = await interceptClientApi(page, 200, response);
  await page.goto("/portal/projects");
  await expect.poll(() => calls).toContain("/api/client/session");
  expect(calls).not.toContain("/api/client/v2/operations/home");
});
