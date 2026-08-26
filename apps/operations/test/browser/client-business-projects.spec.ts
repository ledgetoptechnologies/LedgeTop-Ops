import { expect, test, type Page, type Route } from "@playwright/test";

const path = "/clients/sources/project-alpha%3Aprimary/business/organizations/42";
const base = `/api${path.replace("/clients/", "/client-hub/")}`;
const canonicalRoot = { sourceId: "project-alpha:primary", rootNamespace: "business", kind: "organization", publicId: "42" };
function project(id: string, status: string | null = "active") {
  return { id, row_key: `business:${id}`, name: `Business project ${id}`, status, manager_name: "Bailey Manager", start_date: "2026-08-01", end_date: null,
    created_at: "2026-07-31T12:00:00Z", client_id: null, organization_id: "42", manager_user_id: "manager-one" };
}
function metadata(more = true, limit = 5) { return { available: true, reason: null as string | null, hasMore: more, nextCursor: more ? "next-business-page" : null, limit, returned: 1 }; }
function detail() {
  return { client: { workspace_id: null, public_id: "42", kind: "organization", route_kind: "organizations", source_id: canonicalRoot.sourceId,
    root_namespace: "business", pa_public_id: null, detail_path: path, display_name: "Acme Construction", status: "active", portal_status: "mapping_unavailable",
    account_count: 1, project_count: 1, request_count: 0, contact_count: 0 }, contextVersion: "context-one",
    contacts: [], accounts: [], projects: [{ id: "shared-one", row_key: "account-one:shared-one", account_id: "account-one", project_name: "Explicitly shared site", client_name: "Acme", active: 1, can_request_service: 0 }],
    requests: [], deliveryGrants: [], authenticatedDeliveryGrants: [], viewerGrants: [], businessProjects: [project("initial")], pages: { businessProjects: metadata() },
    capabilities: { directory: true, requests: false, delivery: false, viewer: false },
    portalIdentities: { items: [], page: { ...metadata(false), available: false, reason: "workspace_unavailable", returned: 0 }, contextVersion: "context-one",
      refreshedAt: "2026-08-25T12:00:00Z", capabilities: { canManagePortal: false, canManageEligibilityBlocks: false } } };
}
function response(items = [project("loaded")], more = false) { return { items, page: metadata(more), contextVersion: "context-one", canonicalRoot }; }
async function mock(page: Page, handler: (route: Route, url: URL) => Promise<unknown>, initial = detail()) {
  const requests: URL[] = [];
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url()); requests.push(url);
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: "staff-one", email: "staff@example.test", displayName: "Staff", status: "Active", profileType: "Employee",
      isAdministrator: false, permissions: ["team.view"], divisions: [] }, csrfToken: "test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    if (url.pathname === base) return route.fulfill({ json: initial });
    return handler(route, url);
  });
  return requests;
}
const section = (page: Page) => page.getByRole("region", { name: "Business projects", exact: true });

test("business projects remain separate from shared work with bounded pages and refresh-safe status history", async ({ page }) => {
  const initial = detail(); initial.businessProjects[0]!.status = null;
  const requests = await mock(page, (route, url) => route.fulfill({ json: response([project(`${url.searchParams.get("filter")}-${url.searchParams.has("cursor") ? "next" : "first"}`)], !url.searchParams.has("cursor")) }), initial);
  await page.goto(`${path}?q=acme&kind=organization&login_q=alex`);
  await expect(section(page).getByText("Business project initial", { exact: true })).toBeVisible();
  await expect(section(page).getByText("Status not recorded", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Shared projects", exact: true }).getByText("Explicitly shared site")).toBeVisible();
  await expect(section(page).getByRole("link")).toHaveCount(0);
  await expect(section(page).getByText("Project created:", { exact: false })).toBeVisible();
  await expect(section(page).getByText(/Last activity/)).toHaveCount(0);
  await page.getByRole("combobox", { name: "Project status", exact: true }).selectOption("completed");
  await expect(section(page).getByText("Business project completed-first")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("business_status")).toBe("completed");
  expect(new URL(page.url()).searchParams.get("login_q")).toBe("alex");
  await section(page).getByRole("button", { name: "Load more business projects" }).click();
  await expect(section(page).getByText("Business project completed-next")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Project status", exact: true })).toHaveValue("completed");
  await expect(section(page).getByText("Business project completed-first")).toBeVisible();
  await page.getByRole("combobox", { name: "Project status", exact: true }).selectOption("cancelled");
  await expect(section(page).getByText("Business project cancelled-first")).toBeVisible();
  await page.goBack();
  await expect(section(page).getByText("Business project completed-first")).toBeVisible();
  await page.goForward();
  await expect(section(page).getByText("Business project cancelled-first")).toBeVisible();
  await expect(page.getByRole("link", { name: "← Client Hub" })).toHaveAttribute("href", "/clients?q=acme&kind=organization");
  const pages = requests.filter(url => url.pathname.endsWith("/collections/businessProjects"));
  expect(pages.every(url => url.searchParams.get("limit") === (url.searchParams.has("cursor") ? "25" : "5"))).toBe(true);
  expect(pages.find(url => url.searchParams.has("cursor"))!.searchParams.get("filter")).toBe("completed");
});

test("business status changes cancel stale results and transient errors stay local", async ({ page }) => {
  let pending: Route | undefined, cancelledCalls = 0;
  await mock(page, async (route, url) => {
    if (url.searchParams.get("filter") === "current") { pending = route; return; }
    if (++cancelledCalls === 1) return route.fulfill({ status: 503, json: { error: "Business projects temporarily unavailable" } });
    return route.fulfill({ json: response([project("cancelled", "cancelled")]) });
  });
  await page.goto(path);
  await page.getByRole("combobox", { name: "Project status", exact: true }).selectOption("current");
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByRole("combobox", { name: "Project status", exact: true }).selectOption("cancelled");
  await expect(page.getByRole("alert")).toContainText("Business projects temporarily unavailable");
  await expect(page.getByText("Explicitly shared site", { exact: true })).toBeVisible();
  await pending!.fulfill({ json: response([project("stale")]) }).catch(() => undefined);
  await expect(page.getByText("Business project stale", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry business projects", exact: true }).click();
  await expect(section(page).getByText("Business project cancelled", { exact: true })).toBeVisible();
});

for (const failure of ["context", "items", "cursor", "permission"] as const) {
  test(`invalid business ${failure} responses clear the protected client workspace`, async ({ page }) => {
    await mock(page, route => {
      const value: Record<string, unknown> = response();
      if (failure === "context") value.contextVersion = "changed";
      if (failure === "items") value.items = null;
      if (failure === "cursor") value.page = { ...metadata(), nextCursor: null };
      if (failure === "permission") value.page = { ...metadata(false), available: false, reason: "permission_required" };
      return route.fulfill({ json: value });
    });
    await page.goto(path);
    await page.getByRole("combobox", { name: "Project status", exact: true }).selectOption("completed");
    await expect(page.getByRole("button", { name: "Refresh client workspace", exact: true })).toBeVisible();
    await expect(page.getByText("Explicitly shared site", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Portal logins", exact: true })).toHaveCount(0);
  });
}

test("business projects unavailable on this root do not fetch or expose meaningless filters", async ({ page }) => {
  const initial = detail();
  initial.businessProjects = [];
  initial.pages.businessProjects = { ...metadata(false), available: false, reason: "not_applicable" };
  const requests = await mock(page, route => route.fulfill({ status: 500 }), initial);
  await page.goto(`${path}?business_status=completed`);
  await expect(section(page)).toContainText("does not apply");
  await expect(page.getByRole("combobox", { name: "Project status", exact: true })).toHaveCount(0);
  expect(requests.some(url => url.pathname.includes("/collections/"))).toBe(false);
});
