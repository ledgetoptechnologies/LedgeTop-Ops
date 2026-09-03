import { expect, test, type Page, type Request as PlaywrightRequest, type Route } from "@playwright/test";

const sourceId = "project-alpha:business-b";
const path = `/clients/sources/${encodeURIComponent(sourceId)}/business/organizations/42`;
const base = `/api/client-hub/sources/${encodeURIComponent(sourceId)}/business/organizations/42`;
const management = `${base}/project-management`;
const root = { sourceId, rootNamespace: "business", kind: "organization", publicId: "42" };
const contextVersion = "client-context-one";
function businessProjectsCard(page: Page) {
  return page.locator(".ltds-card").filter({ has: page.getByRole("heading", { name: "Business projects", exact: true }) });
}
function project(id: string) { return { id, row_key: `project:${id}`, name: `Project ${id}`, status: "active", manager_name: null,
  start_date: null, end_date: null, created_at: "2026-08-28T12:00:00Z" }; }
function detail(projects: ReturnType<typeof project>[] = []) {
  return { client: { workspace_id: null, public_id: "42", kind: "organization", route_kind: "organizations", source_id: sourceId,
    source_name: "Business B", root_namespace: "business", pa_public_id: "external-org-42", detail_path: path, display_name: "Acme Construction",
    status: "active", portal_status: "mapping_unavailable", account_count: 0, project_count: projects.length, request_count: 0, contact_count: 0 },
    contextVersion, contacts: [], accounts: [], projects: [], requests: [], deliveryGrants: [], authenticatedDeliveryGrants: [], viewerGrants: [],
    businessProjects: projects, pages: { businessProjects: { available: true, reason: null, hasMore: false, nextCursor: null, limit: 5, returned: projects.length } },
    projectManagementAvailable: true,
    capabilities: { directory: true, requests: false, delivery: false, viewer: false } };
}
function status(overrides: Record<string, unknown> = {}) {
  return { canonicalRoot: root, contextVersion, source: { sourceId, displayName: "Business B", state: "active" },
    availability: { available: true, reason: "available", explanation: "Create the authoritative project in Business B." },
    action: { label: "Create project in Project Alpha", href: "https://alpha-business-b.example.test/clients/external-org-42/projects/create", external: true },
    sync: { status: "healthy", lastAttemptAt: "2026-08-28T12:00:00Z", lastSuccessAt: "2026-08-28T12:00:00Z",
      explanation: "The latest Business B synchronization completed successfully.",
      refresh: { label: "Refresh synchronization status", href: management, method: "GET" }, requestSync: null }, ...overrides };
}
async function fixture(page: Page, managementHandler: (route: Route, request: PlaywrightRequest) => Promise<unknown>,
  options: { permissions?: string[]; detail?: () => ReturnType<typeof detail>; path?: string; base?: string } = {}) {
  const calls: Array<{ url: URL; method: string; csrf?: string }> = [];
  const detailPath = options.path ?? path, detailBase = options.base ?? base;
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()); calls.push({ url, method: request.method(), csrf: request.headers()["x-csrf-token"] });
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: "staff-one", email: "staff@example.test", displayName: "Staff",
      status: "Active", profileType: "Employee", isAdministrator: false, permissions: options.permissions ?? ["team.view"], divisions: [] },
      csrfToken: "csrf-project-management", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    if (url.pathname === detailBase) return route.fulfill({ json: (options.detail ?? (() => detail()))() });
    if (url.pathname === `${detailBase}/project-management`
      || /^\/api\/admin\/integrations\/project-alpha\/connectors\/[^/]+\/sync$/.test(url.pathname)) return managementHandler(route, request);
    return route.fulfill({ status: 503, json: { error: "Ancillary fixture endpoint unavailable" } });
  });
  return { calls, detailPath };
}

test("exact-source project creation opens only the reviewed external URL and refreshes the synchronized project list", async ({ page }, testInfo) => {
  let managementReads = 0, refreshed = false;
  const { calls } = await fixture(page, async route => {
    managementReads += 1; if (managementReads > 1) refreshed = true;
    return route.fulfill({ json: status() });
  }, { detail: () => detail(refreshed ? [project("created-after-sync")] : []) });
  await page.goto(`${path}?q=Acme&kind=organization&source=${encodeURIComponent(sourceId)}`);
  const region = businessProjectsCard(page), link = region.getByRole("link", { name: /Create project in Project Alpha/ });
  await expect(link).toHaveAttribute("href", "https://alpha-business-b.example.test/clients/external-org-42/projects/create");
  await expect(link).toHaveAttribute("target", "_blank"); await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(link).toHaveAccessibleName("Create project in Project Alpha (opens in a new tab)");
  await expect(region).toContainText("It will appear here after Project Alpha synchronizes");
  await link.evaluate(node => node.addEventListener("click", event => event.preventDefault(), { once: true })); await link.click();
  expect(calls.filter(call => call.method !== "GET")).toHaveLength(0);
  await region.getByRole("button", { name: "Refresh synchronization status" }).click();
  await expect(region.getByText("Project created-after-sync", { exact: true })).toBeVisible();
  expect(managementReads).toBeGreaterThanOrEqual(2);
  await page.setViewportSize({ width: 375, height: 900 }); await region.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const linkBox = (await link.boundingBox())!; expect(linkBox.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: testInfo.outputPath("project-management-mobile.png") });
});

test("only a backend-authorized sync control posts once with CSRF and then refreshes the exact workspace", async ({ page }) => {
  let synced = false, reads = 0;
  const { calls } = await fixture(page, async (route, request) => {
    if (request.method() === "POST") { synced = true; return route.fulfill({ json: { sourceId, changedCollections: ["projects"] } }); }
    reads += 1; return route.fulfill({ json: status({ sync: { ...status().sync,
      requestSync: { label: "Sync source now", href: `/api/admin/integrations/project-alpha/connectors/${encodeURIComponent(sourceId)}/sync`, method: "POST" } } }) });
  }, { permissions: ["team.view", "integrations.manage"], detail: () => detail(synced ? [project("synced")] : []) });
  await page.goto(path);
  const button = page.getByRole("button", { name: "Sync source now" });
  const dialog = page.waitForEvent("dialog"); const click = button.click(); const confirmation = await dialog;
  expect(confirmation.message()).toContain("Project Alpha remains the project owner"); await confirmation.accept(); await click;
  await expect(businessProjectsCard(page).getByText("Project synced", { exact: true })).toBeVisible();
  const posts = calls.filter(call => call.method === "POST"); expect(posts).toHaveLength(1); expect(posts[0]!.csrf).toBe("csrf-project-management");
  expect(reads).toBeGreaterThanOrEqual(2);
});

test("unavailable and malformed project-management actions fail closed without local creation", async ({ page }) => {
  let response = status({ availability: { available: false, reason: "source_mapping_unavailable", explanation: "The exact client identifier is unavailable." }, action: null });
  const { calls } = await fixture(page, route => route.fulfill({ json: response }));
  await page.goto(path);
  const region = businessProjectsCard(page);
  await expect(region).toContainText("The exact client identifier is unavailable.");
  await expect(region.getByRole("link", { name: /Create project/ })).toHaveCount(0);
  response = status({ action: { label: "Create project in Project Alpha", href: "http://unsafe.example.test/create", external: true } });
  await region.getByRole("button", { name: "Refresh synchronization status" }).click();
  await expect(region.getByRole("alert")).toContainText("could not be verified");
  await expect(region.getByRole("link", { name: /Create project/ })).toHaveCount(0);
  expect(calls.filter(call => call.method !== "GET")).toHaveLength(0);
});

test("an unenrolled exact-source connector is not presented as an unknown synchronization failure", async ({ page }) => {
  await fixture(page, route => route.fulfill({ json: status({
    source: { sourceId, displayName: "Business B", state: "unregistered" },
    availability: { available: false, reason: "source_not_registered", explanation: "This Project Alpha source is not registered for project management." },
    action: null,
    sync: { ...status().sync, status: "not_configured", lastAttemptAt: null, lastSuccessAt: null,
      explanation: "No exact-source project-management connector is enrolled for Business B. Existing business records may still come from the primary Project Alpha synchronization." },
  }) }));
  await page.goto(path);
  const region = businessProjectsCard(page);
  await expect(region).toContainText("Not configured");
  await expect(region).toContainText("Existing business records may still come from the primary Project Alpha synchronization.");
  await expect(region).not.toContainText("No successful Business B synchronization has been recorded yet.");
});

test("a changed exact root invalidates the full workspace and portal roots never request a business project action", async ({ page }) => {
  await fixture(page, route => route.fulfill({ json: status({ canonicalRoot: { ...root, publicId: "another-client" } }) }));
  await page.goto(path);
  await expect(page.getByRole("button", { name: "Refresh client workspace" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Business projects" })).toHaveCount(0);

  const portalPath = `/clients/sources/${encodeURIComponent(sourceId)}/portal/organizations/workspace-42`;
  const portalBase = `/api/client-hub/sources/${encodeURIComponent(sourceId)}/portal/organizations/workspace-42`;
  const portalDetail: ReturnType<typeof detail> & { client: Record<string, unknown> } = detail() as ReturnType<typeof detail> & { client: Record<string, unknown> };
  portalDetail.client.root_namespace = "portal"; portalDetail.client.public_id = "workspace-42";
  const second = await page.context().newPage();
  const fixtureResult = await fixture(second, route => route.fulfill({ status: 500 }), { path: portalPath, base: portalBase, detail: () => portalDetail });
  await second.goto(portalPath);
  await expect(second.getByRole("link", { name: /Create project in Project Alpha/ })).toHaveCount(0);
  expect(fixtureResult.calls.some(call => call.url.pathname.endsWith("/project-management"))).toBe(false);
  await second.close();
});
