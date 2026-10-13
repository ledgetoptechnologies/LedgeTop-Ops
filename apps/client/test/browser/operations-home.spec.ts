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

async function interceptClientApi(page: Page, status: number, body: unknown, clientSession?: unknown,
  operationsHomeForRead?: (read: number) => { status: number; body: unknown }) {
  const calls: string[] = [];
  let operationsHomeReads = 0;
  await page.route("**/api/client/**", route => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    if (path === "/api/client/v2/operations/home") {
      const result = operationsHomeForRead?.(operationsHomeReads++);
      return route.fulfill({ status: result?.status ?? status, json: result?.body ?? body });
    }
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
  await expect(page.getByRole("link", { name: /projects|files|billing/i })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /projects|files|billing/i })).toHaveCount(0);
  const accountMenu = page.getByRole("button", { name: "Account menu for Client portal" });
  await expect(accountMenu).toBeVisible();
  await accountMenu.click();
  await expect(page.getByRole("menuitem", { name: "Logout" }))
    .toHaveAttribute("href", "/cdn-cgi/access/logout");
  expect(calls).toEqual(["/api/client/v2/operations/home", "/api/client/session"]);
});

test("native operations home does not label an absent optional Client workspace as unavailable", async ({ page }) => {
  const calls: string[] = [];
  const nativeHome = { ...response, homes: [{ ...response.homes[0], services: [] }] };
  await page.route("**/api/client/**", route => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    if (path === "/api/client/v2/operations/home") return route.fulfill({ json: nativeHome });
    if (path === "/api/client/session") return route.fulfill({
      status: 403,
      json: { error: "Client access is not provisioned" },
    });
    if (path === "/api/client/operations/data/context") return route.fulfill({ json: {
      resourceMode: "operations_native_delivery",
      homes: [],
    } });
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });

  await page.goto("/portal");
  await expect(page.getByRole("heading", { name: "Your services" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No services available" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Client resources unavailable" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Shared deliveries" })).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  expect(calls.slice(0, 2)).toEqual(["/api/client/v2/operations/home", "/api/client/session"]);
});

for (const [name, emptyResponse, detail] of [
  ["no authorized homes", { ...response, homes: [] }, "Your account has no active operations services."],
  ["an authorized home with no listed services", { ...response, homes: [{ ...response.homes[0], services: [] }] }, "No services are currently listed for this access."],
] as const) {
  test(`operations-only home represents ${name} as unavailable`, async ({ page }) => {
    const calls = await interceptClientApi(page, 200, emptyResponse);
    await page.goto("/portal");

    const summary = page.getByRole("region", { name: "Independent operations service summary" });
    await expect(summary.getByRole("heading", { name: "No services available" })).toBeVisible();
    await expect(summary.getByText(detail, { exact: true })).toBeVisible();
    await expect(summary.getByRole("heading", { name: "Available services", exact: true })).toHaveCount(0);
    await expect(summary.getByRole("link")).toHaveCount(0);
    await expect(summary.getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("navigation")).toHaveCount(0);
    expect(calls).toEqual(["/api/client/v2/operations/home", "/api/client/session"]);
  });
}

test("independently authorized client portal composes an actionless operations summary in one shell", async ({ page }) => {
  const calls = await interceptClientApi(page, 200, response, {
    account: { id: "account-a", displayName: "Acme Surveying" },
    capabilities: { requestV2: false, feedback: false },
  });
  await page.goto("/portal");

  await expect(page.getByRole("heading", { name: "Acme Surveying" })).toHaveCount(1);
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

test("removes a previously authorized service summary when foreground revalidation is denied", async ({ page }) => {
  const calls = await interceptClientApi(page, 200, response, undefined, read => read === 0
    ? { status: 200, body: response }
    : { status: 403, body: { error: "service home access revoked" } });
  await page.goto("/portal");
  await expect(page.getByText("Aerial operations", { exact: true })).toBeVisible();

  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByText("Sign in required", { exact: true })).toBeVisible();
  await expect(page.getByText("Aerial operations", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Infrastructure review", { exact: true })).toHaveCount(0);
  expect(calls.filter(path => path === "/api/client/v2/operations/home").length).toBeGreaterThanOrEqual(2);
});

test("combined portal keeps its operations heading when an authorized home has no listed services", async ({ page }) => {
  const calls = await interceptClientApi(page, 200, {
    ...response,
    homes: [{ ...response.homes[0], services: [] }],
  }, {
    account: { id: "account-a", displayName: "Acme Surveying" },
    capabilities: { requestV2: false, feedback: false },
  });
  await page.goto("/portal");

  const summary = page.getByRole("region", { name: "Independent operations service summary" });
  await expect(summary.getByRole("heading", { name: "Operations services" })).toBeVisible();
  await expect(summary.getByText("No services are currently listed for this access.", { exact: true })).toBeVisible();
  await expect(summary.getByRole("heading", { name: "No services available", exact: true })).toHaveCount(0);
  await expect(summary.getByRole("link")).toHaveCount(0);
  await expect(summary.getByRole("button")).toHaveCount(0);
  await expectAuthorizedNavigation(page, ["Requests", "Feedback"]);
  await expect.poll(() => calls.length).toBe(7);
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
    if (path === "/api/client/operations/data/deliveries") return route.fulfill({ json: {
      resourceMode: "operations_native_delivery", items: [{ id: "ond1_native_dashboard_delivery", displayName: "Native dashboard delivery" }], page: { nextCursor: null },
    } });
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });

  await page.goto("/portal?workspace=workspace-b");
  await expect(page.getByRole("heading", { name: "Native Resource Workspace" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Operations services" })).toBeVisible();
  await expect(page.getByText("Aerial operations", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Client portal" })).toHaveCount(0);
  await expectAuthorizedNavigation(page);
  const nativeBrowser = page.getByRole("region", { name: "Shared deliveries" });
  await expect(nativeBrowser.getByRole("button", { name: "Browse shared deliveries" })).toBeVisible();
  expect(calls.some(call => call.path === "/api/client/operations/data/deliveries")).toBe(false);
  await nativeBrowser.getByRole("button", { name: "Browse shared deliveries" }).click();
  await expect(nativeBrowser.getByText("Native dashboard delivery", { exact: true })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Authorized Client" })).toHaveCount(0);
  expect(calls).not.toContain("/api/client/v2/workspaces/not-authorized/context");
  await page.getByRole("button", { name: "Try available client workspaces" }).click();
  await expect(page).toHaveURL(/\/portal$/);
  await expect(page.getByRole("heading", { name: "Authorized Client" })).toBeVisible();
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

const deliveryAlpha = "ond1_delivery_alpha";
const deliveryBeta = "ond1_delivery_beta";
const rootFolder = deliveryAlpha;
const childFolder = "ond1_folder_child";
const fileOne = "ond1_file_one";
const fileTwo = "ond1_file_two";

function nativeFile(id: string, name: string) {
  return {
    id, name, size: 2048, uploadedAt: "2026-09-30T12:00:00.000Z", contentType: "application/pdf", kind: "pdf",
    previewPath: `/api/client/operations/data/files/${id}/preview`, thumbnailPath: null,
    downloadPath: `/api/client/operations/data/files/${id}/download`,
  };
}

async function interceptOperationsNativeData(page: Page, native: (url: URL) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>) {
  const calls: string[] = [];
  await page.route("**/api/client/**", async route => {
    const url = new URL(route.request().url());
    calls.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/client/v2/operations/home") return route.fulfill({ json: response });
    if (url.pathname === "/api/client/session") return route.fulfill({ status: 401, json: { error: "Sign in required" } });
    if (url.pathname.startsWith("/api/client/operations/data/")) {
      const result = await native(url);
      return route.fulfill({ status: result.status ?? 200, json: result.body });
    }
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  return calls;
}

test("native shared-delivery browser is opt-in and pages only through server-provided handles and actions", async ({ page }) => {
  const calls = await interceptOperationsNativeData(page, url => {
    if (url.pathname === "/api/client/operations/data/deliveries") return url.searchParams.has("cursor")
      ? { body: { resourceMode: "operations_native_delivery", items: [{ id: deliveryBeta, displayName: "Beta delivery" }], page: { nextCursor: null } } }
      : { body: { resourceMode: "operations_native_delivery", items: [{ id: deliveryAlpha, displayName: "Alpha delivery" }], page: { nextCursor: "ond1_cursor_deliveries" } } };
    if (url.pathname === `/api/client/operations/data/folders/${rootFolder}`) return url.searchParams.has("cursor")
      ? { body: { resourceMode: "operations_native_delivery", files: [nativeFile(fileTwo, "second-report.pdf")], folders: [], breadcrumbs: [{ id: "ond1_rotated_root_breadcrumb", name: "Alpha delivery" }], folderId: rootFolder, prefix: "", cursor: null } }
      : { body: { resourceMode: "operations_native_delivery", files: [nativeFile(fileOne, "first-report.pdf")], folders: [{ id: childFolder, name: "Edited photographs" }], breadcrumbs: [{ id: rootFolder, name: "Alpha delivery" }], folderId: rootFolder, prefix: "", cursor: "ond1_cursor_files" } };
    if (url.pathname === `/api/client/operations/data/folders/${childFolder}`) return {
      body: { resourceMode: "operations_native_delivery", files: [], folders: [], breadcrumbs: [{ id: rootFolder, name: "Alpha delivery" }, { id: childFolder, name: "Edited photographs" }], folderId: childFolder, prefix: "", cursor: null },
    };
    return { status: 404, body: { error: "not found" } };
  });

  await page.goto("/portal");
  const browser = page.getByRole("region", { name: "Shared deliveries" });
  await expect(browser.getByRole("button", { name: "Browse shared deliveries" })).toBeVisible();
  expect(calls.filter(call => call.startsWith("/api/client/operations/data/"))).toEqual([]);

  await browser.getByRole("button", { name: "Browse shared deliveries" }).click();
  await expect(browser.getByText("Alpha delivery", { exact: true })).toBeVisible();
  await browser.getByRole("button", { name: "Load more deliveries" }).click();
  await expect(browser.getByText("Beta delivery", { exact: true })).toBeVisible();

  await browser.getByRole("button", { name: /Alpha delivery/ }).click();
  await expect(browser.getByText("first-report.pdf", { exact: true })).toBeVisible();
  await expect(browser.getByRole("link", { name: "Preview" })).toHaveAttribute("href", `/api/client/operations/data/files/${fileOne}/preview`);
  await expect(browser.getByRole("link", { name: "Download" })).toHaveAttribute("href", `/api/client/operations/data/files/${fileOne}/download`);
  await browser.getByRole("button", { name: "Load more files" }).click();
  await expect(browser.getByText("second-report.pdf", { exact: true })).toBeVisible();

  await browser.getByRole("button", { name: /Edited photographs/ }).click();
  await expect(browser.getByRole("navigation", { name: "Shared delivery folders" })).toContainText("Alpha delivery");
  await expect(browser.getByText("No files are available in this folder.", { exact: true })).toBeVisible();
  expect(calls).toContain("/api/client/operations/data/deliveries?cursor=ond1_cursor_deliveries");
  expect(calls).toContain(`/api/client/operations/data/folders/${rootFolder}?cursor=ond1_cursor_files`);
});

test("native shared-delivery browser retries an unavailable discovery without exposing a fallback", async ({ page }) => {
  let reads = 0;
  const calls = await interceptOperationsNativeData(page, url => {
    if (url.pathname !== "/api/client/operations/data/deliveries") return { status: 404, body: { error: "not found" } };
    return ++reads === 1
      ? { status: 503, body: { error: "private upstream detail" } }
      : { body: { resourceMode: "operations_native_delivery", items: [{ id: deliveryAlpha, displayName: "Recovered delivery" }], page: { nextCursor: null } } };
  });
  await page.goto("/portal");
  const browser = page.getByRole("region", { name: "Shared deliveries" });
  await browser.getByRole("button", { name: "Browse shared deliveries" }).click();
  await expect(browser.getByText("Shared deliveries are temporarily unavailable.", { exact: true })).toBeVisible();
  await browser.getByRole("button", { name: "Retry" }).click();
  await expect(browser.getByText("Recovered delivery", { exact: true })).toBeVisible();
  expect(calls).not.toContain("/api/client/projects");
});

for (const revokedStatus of [401, 403, 404, 410]) {
  test(`native shared-delivery browser clears private data when access refresh returns ${revokedStatus}`, async ({ page }) => {
    let reads = 0;
    const calls = await interceptOperationsNativeData(page, url => {
      if (url.pathname === "/api/client/operations/data/deliveries") return ++reads === 1
        ? { body: { resourceMode: "operations_native_delivery", items: [{ id: deliveryAlpha, displayName: "Private delivery" }], page: { nextCursor: null } } }
        : { status: revokedStatus, body: { error: "not available" } };
      if (url.pathname === `/api/client/operations/data/folders/${deliveryAlpha}`) return {
        body: { resourceMode: "operations_native_delivery", files: [nativeFile(fileOne, "private-report.pdf")], folders: [], breadcrumbs: [{ id: deliveryAlpha, name: "Private delivery" }], folderId: deliveryAlpha, prefix: "", cursor: null },
      };
      return { status: 404, body: { error: "not found" } };
    });
    await page.goto("/portal");
    const browser = page.getByRole("region", { name: "Shared deliveries" });
    await browser.getByRole("button", { name: "Browse shared deliveries" }).click();
    await browser.getByRole("button", { name: /Private delivery/ }).click();
    await expect(browser.getByText("private-report.pdf", { exact: true })).toBeVisible();

    await browser.getByRole("button", { name: "Refresh access" }).click();
    await expect(browser.getByText("private-report.pdf", { exact: true })).toHaveCount(0);
    await expect(browser.getByText("Private delivery", { exact: true })).toHaveCount(0);
    await expect(browser.getByRole("alert")).toContainText("could not be verified");
    expect(reads).toBe(2);
    expect(calls).not.toContain("/api/client/projects");
  });
}

test("focus revalidation aborts an in-flight folder scope and ignores its late response", async ({ page }) => {
  let discoveryReads = 0;
  let releaseFolder: (() => void) | undefined;
  const folderBlocked = new Promise<void>(resolve => { releaseFolder = resolve; });
  const calls = await interceptOperationsNativeData(page, async url => {
    if (url.pathname === "/api/client/operations/data/deliveries") return ++discoveryReads === 1
      ? { body: { resourceMode: "operations_native_delivery", items: [{ id: deliveryAlpha, displayName: "Old delivery" }], page: { nextCursor: null } } }
      : { body: { resourceMode: "operations_native_delivery", items: [{ id: deliveryBeta, displayName: "Revalidated delivery" }], page: { nextCursor: null } } };
    if (url.pathname === `/api/client/operations/data/folders/${deliveryAlpha}`) {
      await folderBlocked;
      return { body: { resourceMode: "operations_native_delivery", files: [nativeFile(fileOne, "stale-private.pdf")], folders: [], breadcrumbs: [{ id: deliveryAlpha, name: "Old delivery" }], folderId: deliveryAlpha, prefix: "", cursor: null } };
    }
    return { status: 404, body: { error: "not found" } };
  });
  await page.goto("/portal");
  const browser = page.getByRole("region", { name: "Shared deliveries" });
  await browser.getByRole("button", { name: "Browse shared deliveries" }).click();
  await browser.getByRole("button", { name: /Old delivery/ }).click();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(browser.getByRole("button", { name: "Browse shared deliveries" })).toBeVisible();
  releaseFolder?.();
  await expect(browser.getByText("stale-private.pdf", { exact: true })).toHaveCount(0);
  expect(calls.filter(call => call === "/api/client/v2/operations/home").length).toBeGreaterThanOrEqual(2);
});

test("an Operations authority scope change remounts the browser and suppresses a prior scope response", async ({ page }) => {
  let homeReads = 0;
  let releaseFolder: (() => void) | undefined;
  const folderBlocked = new Promise<void>(resolve => { releaseFolder = resolve; });
  await page.route("**/api/client/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/client/v2/operations/home") {
      const body = ++homeReads === 1 ? response : {
        ...response,
        homes: [{ ...response.homes[0], authorityId: "abcdefab-cdef-4abc-8def-abcdefabcdef", workspaceId: "workspace-two", grantRevision: 5 }],
      };
      return route.fulfill({ json: body });
    }
    if (url.pathname === "/api/client/session") return route.fulfill({ status: 401, json: { error: "Sign in required" } });
    if (url.pathname === "/api/client/operations/data/deliveries") return route.fulfill({ json: {
      resourceMode: "operations_native_delivery", items: [{ id: deliveryAlpha, displayName: "Previous scope delivery" }], page: { nextCursor: null },
    } });
    if (url.pathname === `/api/client/operations/data/folders/${deliveryAlpha}`) {
      await folderBlocked;
      return route.fulfill({ json: {
        resourceMode: "operations_native_delivery", files: [nativeFile(fileOne, "prior-scope-private.pdf")], folders: [],
        breadcrumbs: [{ id: deliveryAlpha, name: "Previous scope delivery" }], folderId: deliveryAlpha, prefix: "", cursor: null,
      } }).catch(() => undefined);
    }
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });

  await page.goto("/portal");
  let browser = page.getByRole("region", { name: "Shared deliveries" });
  await browser.getByRole("button", { name: "Browse shared deliveries" }).click();
  await browser.getByRole("button", { name: /Previous scope delivery/ }).click();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByText("Aerial operations", { exact: true })).toBeVisible();
  browser = page.getByRole("region", { name: "Shared deliveries" });
  await expect(browser.getByRole("button", { name: "Browse shared deliveries" })).toBeVisible();
  releaseFolder?.();
  await expect(browser.getByText("prior-scope-private.pdf", { exact: true })).toHaveCount(0);
  expect(homeReads).toBeGreaterThanOrEqual(2);
});

test("combined portal remounts native data on a newly verified Operations authority scope", async ({ page }) => {
  const changedHome = {
    ...response,
    homes: [{ ...response.homes[0], authorityId: "abcdefab-cdef-4abc-8def-abcdefabcdef", workspaceId: "workspace-new", grantRevision: 5 }],
  };
  const calls = await interceptClientApi(page, 200, response, {
    account: { id: "account-a", displayName: "Authorized Client" }, capabilities: { requestV2: false, feedback: false },
  }, read => ({ status: 200, body: read === 0 ? response : changedHome }));
  let dataReads = 0;
  await page.route("**/api/client/operations/data/deliveries", route => {
    dataReads++;
    return route.fulfill({ json: {
      resourceMode: "operations_native_delivery", items: [{ id: deliveryAlpha, displayName: "Prior authority delivery" }], page: { nextCursor: null },
    } });
  });
  await page.goto("/portal");
  let browser = page.getByRole("region", { name: "Shared deliveries" });
  await expect(browser.getByRole("button", { name: "Browse shared deliveries" })).toBeVisible();
  expect(dataReads).toBe(0);
  await browser.getByRole("button", { name: "Browse shared deliveries" }).click();
  await expect(browser.getByText("Prior authority delivery", { exact: true })).toBeVisible();

  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => calls.filter(path => path === "/api/client/v2/operations/home").length).toBeGreaterThanOrEqual(2);
  browser = page.getByRole("region", { name: "Shared deliveries" });
  await expect(browser.getByText("Prior authority delivery", { exact: true })).toHaveCount(0);
  await expect(browser.getByRole("button", { name: "Browse shared deliveries" })).toBeVisible();
  expect(dataReads).toBe(1);
});

test("combined portal hides native delivery data when Operations-home revalidation is denied", async ({ page }) => {
  const calls = await interceptClientApi(page, 200, response, {
    account: { id: "account-a", displayName: "Authorized Client" }, capabilities: { requestV2: false, feedback: false },
  }, read => read === 0 ? { status: 200, body: response } : { status: 403, body: { error: "revoked" } });
  await page.route("**/api/client/operations/data/deliveries", route => route.fulfill({ json: {
    resourceMode: "operations_native_delivery", items: [{ id: deliveryAlpha, displayName: "Private combined delivery" }], page: { nextCursor: null },
  } }));
  await page.goto("/portal");
  const browser = page.getByRole("region", { name: "Shared deliveries" });
  await browser.getByRole("button", { name: "Browse shared deliveries" }).click();
  await expect(browser.getByText("Private combined delivery", { exact: true })).toBeVisible();

  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("heading", { name: "Operations services unavailable" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Shared deliveries" })).toHaveCount(0);
  await expect(page.getByText("Private combined delivery", { exact: true })).toHaveCount(0);
  expect(calls.filter(path => path === "/api/client/v2/operations/home").length).toBeGreaterThanOrEqual(2);
});
