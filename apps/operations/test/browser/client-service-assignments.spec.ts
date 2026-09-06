import { expect, test, type Page, type Route } from "@playwright/test";
import type { ClientServiceAssignmentResult, ClientServiceAssignmentRow } from "../../src/client/ClientServiceAssignments";

const path = "/clients/sources/project-alpha%3Aprimary/business/organizations/42";
const base = "/api/client-hub/sources/project-alpha%3Aprimary/business/organizations/42";
const canonicalRoot = { sourceId: "project-alpha:primary", rootNamespace: "business", kind: "organization", publicId: "42" };
const contextVersion = "context-one";
function row(id: string, overrides: Partial<ClientServiceAssignmentRow> = {}): ClientServiceAssignmentRow {
  return { row_key: JSON.stringify(["project-alpha:primary", id, `${id}-v1`]), assignment_public_id: id,
    service_public_id: `service-${id}`, service_name: `Service ${id}`, service_label: `Service ${id}`,
    service_source_version: "service-v1", assignment_source_version: `${id}-v1`, subject_type: "organization",
    subject_public_id: "organization-public", subject_name: "Acme Construction", effective_status: "effective",
    effective_from: null, effective_until: null, source_id: "project-alpha:primary", source_name: "Primary Project Alpha",
    source_generation: "snapshot-12", source_sequence: 12, source_updated_at: "2026-08-27T12:00:00Z", ...overrides };
}
function assignmentPage(items: ClientServiceAssignmentRow[], more = false, cursor = "next-page",
  availability: Partial<ClientServiceAssignmentResult["page"]> = {}): ClientServiceAssignmentResult {
  return { items, page: { available: true, reason: null, nextCursor: more ? cursor : null, hasMore: more,
    returned: items.length, limit: 5, ...availability }, readiness: { tables: "ready", receiver: "ready", source: "observed",
    directory: "ready", projection: "ready", catalog: "ready" }, canonicalRoot, contextVersion,
  refreshedAt: "2026-08-27T12:00:00Z" };
}
function detail(serviceAssignments = assignmentPage([row("one"), row("fallback", { service_name: null,
  service_public_id: "opaque-service-id", service_label: "opaque-service-id", effective_status: "upcoming",
  effective_from: "2099-01-01T00:00:00Z" })], true)) {
  return { client: { workspace_id: "workspace-one", public_id: "42", kind: "organization", route_kind: "organizations",
    source_id: "project-alpha:primary", root_namespace: "business", pa_public_id: "organization-public", detail_path: path,
    display_name: "Acme Construction", status: "active", portal_status: "active", account_count: 0, project_count: 0,
    request_count: 0, contact_count: 0 }, contextVersion, serviceAssignments,
  portalIdentities: { items: [], page: { available: true, reason: null, nextCursor: null, hasMore: false, returned: 0, limit: 5 },
    contextVersion, refreshedAt: "2026-08-27T12:00:00Z", capabilities: { canManagePortal: false, canManageEligibilityBlocks: false } },
  contacts: [], accounts: [], projects: [], requests: [], deliveryGrants: [], authenticatedDeliveryGrants: [], viewerGrants: [],
  capabilities: { directory: true, requests: true, delivery: false, viewer: false } };
}
type Handler = (route: Route, url: URL) => Promise<unknown>;
async function mock(pageInstance: Page, handler: Handler, detailFactory: () => unknown = () => detail()) {
  const requests: Array<{ url: URL; method: string }> = [];
  await pageInstance.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()); requests.push({ url, method: request.method() });
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: "staff-one", email: "staff@example.test",
      displayName: "Staff", status: "Active", profileType: "Administrator", isAdministrator: true,
      permissions: ["team.view", "operations.manage"], divisions: [] }, csrfToken: "csrf", timezone: "America/Chicago",
    mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    if (url.pathname === base) return route.fulfill({ json: detailFactory() });
    return handler(route, url);
  });
  return requests;
}
const card = (pageInstance: Page) => pageInstance.getByRole("region", { name: "Project Alpha service assignments", exact: true });

test("unavailable assignments can refresh and recover after a transient failure", async ({ page }) => {
  let attempts = 0;
  const requests = await mock(page, async (route, url) => {
    if (url.pathname !== `${base}/service-assignments`) return route.fulfill({ status: 404 });
    attempts += 1;
    return attempts === 1
      ? route.fulfill({ status: 503, json: { error: "Sync temporarily unavailable" } })
      : route.fulfill({ json: assignmentPage([row("recovered")]) });
  }, () => detail(assignmentPage([], false, "", { available: false, reason: "projection_not_ready" })));
  await page.goto(path);
  await expect(card(page).getByText("Service assignments unavailable", { exact: true })).toBeVisible();
  await card(page).getByRole("button", { name: "Refresh service assignments" }).click();
  await expect(card(page).getByRole("alert")).toContainText("Sync temporarily unavailable");
  await card(page).getByRole("button", { name: "Retry service assignments" }).click();
  await expect(card(page).getByText("Service recovered", { exact: true })).toBeVisible();
  await expect(card(page).getByText("Service assignments unavailable", { exact: true })).toHaveCount(0);
  expect(attempts).toBe(2);
  expect(requests.every(request => request.method === "GET")).toBe(true);
});

test("service assignments are exact, read-only, progressively loaded, and URL-filtered", async ({ page }) => {
  const requests = await mock(page, async (route, url) => {
    if (url.pathname !== `${base}/service-assignments`) return route.fulfill({ status: 404 });
    if (url.searchParams.get("cursor")) return route.fulfill({ json: assignmentPage([row("two", { effective_status: "expired",
      effective_until: "2000-01-01T00:00:00Z" })]) });
    const query = url.searchParams.get("q");
    return route.fulfill({ json: assignmentPage([row("searched", { service_name: query ? `Found ${query}` : "Service searched",
      service_label: query ? `Found ${query}` : "Service searched" })]) });
  });
  await page.goto(`${path}?q=directory-query&kind=organization`);
  await expect(card(page).getByText("Informational only.", { exact: true })).toBeVisible();
  await expect(card(page).getByText("Assignments do not grant portal access, enable service requests, or expose pricing.", { exact: false })).toBeVisible();
  await expect(card(page).getByText("opaque-service-id", { exact: true })).toBeVisible();
  await card(page).getByRole("button", { name: "Load more service assignments" }).click();
  await expect(card(page).getByRole("article")).toHaveCount(3);
  await card(page).getByRole("searchbox", { name: "Search assigned services" }).fill("Roof survey");
  await card(page).getByRole("combobox", { name: "Effective status" }).selectOption("effective");
  await card(page).getByRole("button", { name: "Search services" }).click();
  await expect(card(page).getByText("Found Roof survey", { exact: true })).toBeVisible();
  const current = new URL(page.url());
  expect(current.searchParams.get("q")).toBe("directory-query");
  expect(current.searchParams.get("service_q")).toBe("Roof survey");
  expect(current.searchParams.get("service_status")).toBe("effective");
  await page.reload();
  await expect(card(page).getByText("Found Roof survey", { exact: true })).toBeVisible();
  expect(requests.some(request => request.method === "POST")).toBe(false);
  await expect(card(page).getByRole("button", { name: /^(grant|assign|remove|enable|set price)\b/i })).toHaveCount(0);
});

test("a transient continuation failure preserves assignments and retries the exact page", async ({ page }) => {
  let attempts = 0;
  await mock(page, async (route, url) => {
    if (url.pathname === `${base}/service-assignments` && url.searchParams.get("cursor")) {
      attempts += 1;
      return attempts === 1 ? route.fulfill({ status: 503, json: { error: "Assignment service unavailable" } })
        : route.fulfill({ json: assignmentPage([row("two")]) });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto(path);
  await card(page).getByRole("button", { name: "Load more service assignments" }).click();
  await expect(card(page).getByRole("alert")).toContainText("Assignment service unavailable");
  await expect(card(page).getByText("Service one", { exact: true })).toBeVisible();
  await card(page).getByRole("button", { name: "Retry service assignments" }).click();
  await expect(card(page).getByText("Service two", { exact: true })).toBeVisible();
  expect(attempts).toBe(2);
});

test("a failed new service search clears stale rows and retries that search", async ({ page }) => {
  let attempts = 0;
  await mock(page, async (route, url) => {
    if (url.pathname === `${base}/service-assignments` && url.searchParams.get("q") === "New service") {
      attempts += 1;
      return attempts === 1 ? route.fulfill({ status: 503, json: { error: "Search temporarily unavailable" } })
        : route.fulfill({ json: assignmentPage([row("new", { service_label: "New service", service_name: "New service" })]) });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto(path);
  await expect(card(page).getByText("Service one", { exact: true })).toBeVisible();
  await card(page).getByRole("searchbox", { name: "Search assigned services" }).fill("New service");
  await card(page).getByRole("button", { name: "Search services" }).click();
  await expect(card(page).getByRole("alert")).toContainText("Search temporarily unavailable");
  await expect(card(page).getByText("Service one", { exact: true })).toHaveCount(0);
  await card(page).getByRole("button", { name: "Retry service assignments" }).click();
  await expect(card(page).getByText("New service", { exact: true })).toBeVisible();
  expect(attempts).toBe(2);
});

test("service assignment authority or context failure invalidates the whole client workspace", async ({ page }) => {
  await mock(page, async (route, url) => url.pathname === `${base}/service-assignments`
    ? route.fulfill({ status: 409, json: { error: "Assignment context changed" } }) : route.fulfill({ status: 404 }));
  await page.goto(`${path}?service_status=effective`);
  await expect(page.getByRole("button", { name: "Refresh client workspace" })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
});

test("unavailable and long service assignment states remain factual and responsive", async ({ page }) => {
  const long = row("long", { service_name: "A very long regional construction photogrammetry and documentation service name",
    service_label: "A very long regional construction photogrammetry and documentation service name",
    subject_name: "A very long organization name for regional construction coordination", source_id: "project-alpha:regional-secondary-source",
    source_name: "Regional Project Alpha source", effective_status: "needs_review", effective_from: "not-a-date" });
  await mock(page, route => route.fulfill({ status: 404 }), () => detail(assignmentPage([long])));
  await page.goto(path);
  for (const width of [375, 640, 1280, 3440]) {
    await page.setViewportSize({ width, height: 960 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(card(page).getByRole("article", { name: /Service assignment for/ }).getByText("Needs review", { exact: true })).toBeVisible();
    for (const control of await card(page).locator("button,input,select").all())
      expect((await control.boundingBox())?.height || 0).toBeGreaterThanOrEqual(44);
  }
});
