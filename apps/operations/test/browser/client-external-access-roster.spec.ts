import { expect, test, type Page, type Route } from "@playwright/test";
import type { ExternalAccessResult, ExternalAccessRow } from "../../src/client/ClientExternalAccessRoster";

const path = "/clients/sources/project-alpha%3Aprimary/business/organizations/42";
const base = "/api/client-hub/sources/project-alpha%3Aprimary/business/organizations/42";
const canonicalRoot = { sourceId: "project-alpha:primary", rootNamespace: "business", kind: "organization", publicId: "42" };
const contextVersion = "context-one";
function row(id: string, overrides: Partial<ExternalAccessRow> = {}): ExternalAccessRow {
  return { row_key: JSON.stringify(["membership", id]), kind: "membership", display_name: `Person ${id}`, email_hint: `${id}@example.test`,
    access_status: "active", source_type: "operations", expires_at: null, revoked_at: null, assigned_access_count: 2,
    created_at: "2026-08-27T12:00:00Z", ...overrides };
}
function page(items: ExternalAccessRow[], more = false, cursor = "next-page"): ExternalAccessResult {
  return { items, page: { available: true, reason: null, nextCursor: more ? cursor : null, hasMore: more, returned: items.length, limit: 5 },
    canonicalRoot, contextVersion, refreshedAt: "2026-08-27T12:00:00Z" };
}
function detail(externalAccess = page([row("one"), row("invite", { kind: "invitation", row_key: '["invitation","invite"]',
  display_name: "pending@example.test", email_hint: "pending@example.test", access_status: "pending", source_type: "client_invitation",
  expires_at: "2099-01-01T00:00:00Z", assigned_access_count: 1 })], true)) {
  return { client: { workspace_id: "workspace-one", public_id: "42", kind: "organization", route_kind: "organizations",
    source_id: "project-alpha:primary", root_namespace: "business", pa_public_id: "a".repeat(32), detail_path: path,
    display_name: "Acme Construction", status: "active", portal_status: "active", account_count: 0, project_count: 0, request_count: 0, contact_count: 0 },
    contextVersion, externalAccess,
    portalIdentities: { items: [], page: { available: true, reason: null, nextCursor: null, hasMore: false, returned: 0, limit: 5 },
      contextVersion, refreshedAt: "2026-08-27T12:00:00Z", capabilities: { canManagePortal: false, canManageEligibilityBlocks: false } },
    contacts: [], accounts: [], projects: [], requests: [], deliveryGrants: [], authenticatedDeliveryGrants: [], viewerGrants: [],
    capabilities: { directory: true, requests: false, delivery: false, viewer: false } };
}
type Handler = (route: Route, url: URL) => Promise<unknown>;
async function mock(pageInstance: Page, handler: Handler, detailFactory: () => unknown = () => detail()) {
  const requests: Array<{ url: URL; method: string }> = [];
  await pageInstance.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()); requests.push({ url, method: request.method() });
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: "staff-one", email: "staff@example.test", displayName: "Staff",
      status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["team.view"], divisions: [] }, csrfToken: "csrf",
      timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    if (url.pathname === base) return route.fulfill({ json: detailFactory() });
    return handler(route, url);
  });
  return requests;
}
const roster = (pageInstance: Page) => pageInstance.getByRole("region", { name: "External access", exact: true });

test("external access is read-only, paged, source-labelled, and preserves URL search", async ({ page: browser }) => {
  const requests = await mock(browser, (route, url) => {
    if (url.pathname !== `${base}/external-access`) return route.fulfill({ status: 404 });
    if (url.searchParams.get("cursor")) return route.fulfill({ json: page([row("one"), row("blocked", { access_status: "blocked", source_type: "project_alpha", assigned_access_count: 1 })]) });
    const query = url.searchParams.get("q");
    return route.fulfill({ json: page([row("searched", { display_name: query ? `Found ${query}` : "Person searched", source_type: "legacy" })]) });
  });
  await browser.goto(`${path}?q=directory-query&kind=organization`);
  await expect(roster(browser).getByText("Person one", { exact: true })).toBeVisible();
  await expect(roster(browser).getByText("Pending invitation", { exact: true })).toBeVisible();
  await expect(roster(browser).getByText("Client invitation", { exact: true })).toBeVisible();
  await roster(browser).getByRole("button", { name: "Load more external access" }).click();
  await expect(roster(browser).getByRole("article")).toHaveCount(3);
  await expect(roster(browser).getByRole("article", { name: "External access for Person blocked" }).getByText("Sign-in blocked", { exact: true })).toBeVisible();
  await roster(browser).getByRole("searchbox", { name: "Search external access" }).fill("Alex Client");
  await roster(browser).getByRole("combobox", { name: "Access status" }).selectOption("all");
  await roster(browser).getByRole("button", { name: "Search access" }).click();
  await expect(roster(browser).getByText("Found Alex Client", { exact: true })).toBeVisible();
  const current = new URL(browser.url());
  expect(current.searchParams.get("q")).toBe("directory-query");
  expect(current.searchParams.get("kind")).toBe("organization");
  expect(current.searchParams.get("access_q")).toBe("Alex Client");
  expect(current.searchParams.get("access_status")).toBe("all");
  await browser.reload();
  await expect(roster(browser).getByText("Found Alex Client", { exact: true })).toBeVisible();
  expect(requests.some(request => request.method === "POST")).toBe(false);
  await expect(roster(browser).getByRole("button", { name: /grant|revoke|block|invite/i })).toHaveCount(0);
});

test("a transient continuation failure retains records and retries the exact page", async ({ page: browser }) => {
  let attempts = 0;
  await mock(browser, (route, url) => {
    if (url.pathname === `${base}/external-access` && url.searchParams.get("cursor")) {
      attempts += 1;
      return attempts === 1 ? route.fulfill({ status: 503, json: { error: "Roster service unavailable" } })
        : route.fulfill({ json: page([row("two")]) });
    }
    return route.fulfill({ status: 404 });
  });
  await browser.goto(path);
  await roster(browser).getByRole("button", { name: "Load more external access" }).click();
  await expect(roster(browser).getByRole("alert")).toContainText("Roster service unavailable");
  await expect(roster(browser).getByText("Person one", { exact: true })).toBeVisible();
  await roster(browser).getByRole("button", { name: "Retry external access" }).click();
  await expect(roster(browser).getByText("Person two", { exact: true })).toBeVisible();
  expect(attempts).toBe(2);
});

test("a failing new search clears rows from the previous filter and retries that search", async ({ page: browser }) => {
  let attempts = 0;
  await mock(browser, (route, url) => {
    if (url.pathname === `${base}/external-access` && url.searchParams.get("q") === "New Person") {
      attempts += 1;
      return attempts === 1 ? route.fulfill({ status: 503, json: { error: "Search temporarily unavailable" } })
        : route.fulfill({ json: page([row("new", { display_name: "New Person" })]) });
    }
    return route.fulfill({ status: 404 });
  });
  await browser.goto(path);
  await expect(roster(browser).getByText("Person one", { exact: true })).toBeVisible();
  await roster(browser).getByRole("searchbox", { name: "Search external access" }).fill("New Person");
  await roster(browser).getByRole("button", { name: "Search access" }).click();
  await expect(roster(browser).getByRole("alert")).toContainText("Search temporarily unavailable");
  await expect(roster(browser).getByText("Person one", { exact: true })).toHaveCount(0);
  await roster(browser).getByRole("button", { name: "Retry external access" }).click();
  await expect(roster(browser).getByText("New Person", { exact: true })).toBeVisible();
  expect(attempts).toBe(2);
});

test("authority or client-context failure invalidates the complete workspace", async ({ page: browser }) => {
  await mock(browser, (route, url) => url.pathname === `${base}/external-access`
    ? route.fulfill({ status: 409, json: { error: "Client access changed" } }) : route.fulfill({ status: 404 }));
  await browser.goto(`${path}?access_status=all`);
  await expect(browser.getByRole("button", { name: "Refresh client workspace" })).toBeVisible();
  await expect(roster(browser)).toHaveCount(0);
});

test("external access remains readable without horizontal overflow at supported widths", async ({ page: browser }) => {
  const long = row("long", { display_name: "A very long external collaborator name for regional construction coordination",
    email_hint: "long-external-collaborator-address@regional-construction-services.example.test", expires_at: "not-a-date", access_status: "needs_review" });
  await mock(browser, route => route.fulfill({ status: 404 }), () => detail(page([long])));
  await browser.goto(path);
  for (const width of [375, 640, 1280, 3440]) {
    await browser.setViewportSize({ width, height: 960 });
    await expect.poll(() => browser.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(roster(browser).getByText("Expiry not verified", { exact: true })).toBeVisible();
    for (const control of await roster(browser).locator("button,input,select").all())
      expect((await control.boundingBox())?.height || 0).toBeGreaterThanOrEqual(44);
  }
});
