import { expect, test, type Page, type Request } from "@playwright/test";
import { sampleStaffTenant } from "../../../../packages/shared/test-fixtures/competitor-intel-sample";

const user = (permissions: string[], intel: boolean) => ({
  user: { id: "owner-a", email: "owner@example.test", displayName: "Owner User", status: "Active", profileType: "Administrator",
    isAdministrator: true, permissions, divisions: [] },
  csrfToken: "csrf-test", timezone: "America/Chicago", capabilities: { intel: { enabled: intel } },
});
const businesses = [{ key: "drone-services", name: "Ledge Top Drone Services" }, { key: "technologies", name: "Ledge Top Technologies" }];
const website = {
  property: { name: "ledgetopdroneservices.com" }, range: { start: "2026-09-26", end: "2026-10-23" },
  freshness: { fetchedAt: "2026-10-24T06:00:00Z", stale: false },
  totals: { users: 1240, sessions: 1610, pageViews: 4120, engagementRate: 0.612, conversions: 18 },
  previous: { users: 1000, sessions: 1700, pageViews: 4120, engagementRate: 0.6, conversions: 12 },
  topPages: [{ path: "/services/roof-inspections", title: "Roof inspections", pageViews: 820, users: 610 }],
  sources: [{ channel: "Organic Search", sessions: 900 }, { channel: "Direct", sessions: 410 }],
};
const search = {
  site: { url: "sc-domain:ledgetopdroneservices.com" }, range: { start: "2026-09-26", end: "2026-10-23" },
  freshness: { fetchedAt: "2026-10-23T06:00:00Z", stale: true },
  totals: { clicks: 312, impressions: 18400, ctr: 0.017, position: 14.2 }, previous: { clicks: 280, impressions: 17000, ctr: 0.0165, position: 16.8 },
  queries: [{ query: "drone roof inspection", clicks: 44, impressions: 1900, ctr: 0.023, position: 6.1 }],
  pages: [{ url: "https://ledgetopdroneservices.com/", clicks: 120, impressions: 8000, ctr: 0.015, position: 11.3 }],
};

type Answer = { status?: number; json: unknown };
async function mockOps(page: Page, options: { permissions?: string[]; intel?: boolean; list?: Answer; sections?: Record<string, Answer> } = {}) {
  const requests: Request[] = [];
  await page.route("**/api/**", route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    requests.push(request);
    if (path === "/api/session") return route.fulfill({ json: user(options.permissions ?? ["dashboard.view", "administration.view"], options.intel ?? true) });
    if (path === "/api/intel/businesses") return route.fulfill(options.list ?? { json: { businesses } });
    const match = /^\/api\/intel\/([^/]+)\/(competitors|website|search-console)(\/commands)?$/.exec(path);
    if (match) {
      if (match[3]) return route.fulfill({ status: 202, json: { accepted: true } });
      const override = options.sections?.[`${match[1]}/${match[2]}`];
      if (override) return route.fulfill(override);
      return route.fulfill({ json: match[2] === "competitors" ? sampleStaffTenant : match[2] === "website" ? website : search });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return requests;
}
const intelPaths = (requests: Request[]) => requests.map(request => new URL(request.url())).filter(url => url.pathname.startsWith("/api/intel/"))
  .map(url => `${url.pathname}${url.search}`);

test("Intel opens from the Administration menu and shows competitor intel for Drone Services first", async ({ page }) => {
  const requests = await mockOps(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Administration" }).click();
  await page.locator("#ops-manage-menu").getByRole("link", { name: "Intel" }).click();
  await expect(page).toHaveURL(/\/intel/);
  await expect(page.getByRole("heading", { name: "Intel", level: 1 })).toBeVisible();
  const switcher = page.getByRole("group", { name: "Business" });
  await expect(switcher.getByRole("button", { name: "Ledge Top Drone Services" })).toHaveAttribute("aria-pressed", "true");
  await expect(switcher.getByRole("button", { name: "Ledge Top Technologies" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("heading", { name: sampleStaffTenant.tenantName })).toBeVisible();
  expect(intelPaths(requests)).toEqual(["/api/intel/businesses", "/api/intel/drone-services/competitors"]);
});

test("switching business loads that business only and explains what isn't set up", async ({ page }) => {
  const requests = await mockOps(page, { sections: { "technologies/competitors": { status: 404, json: { error: "Not configured", code: "not_configured" } } } });
  await page.goto("/intel");
  await page.getByRole("button", { name: "Ledge Top Technologies" }).click();
  await expect(page.getByText("Competitors for Ledge Top Technologies haven't been added yet.")).toBeVisible();
  await expect(page.getByRole("heading", { name: sampleStaffTenant.tenantName })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("business")).toBe("technologies");
  expect(intelPaths(requests)).toContain("/api/intel/technologies/competitors");
});

test("website stats show totals with changes, top pages and sources, and follow the chosen period", async ({ page }) => {
  const requests = await mockOps(page);
  await page.goto("/intel?business=drone-services&view=website");
  const totals = page.getByRole("list", { name: "Website totals" });
  await expect(totals.getByRole("listitem").filter({ hasText: "Visitors" })).toContainText("1,240");
  await expect(totals.getByRole("listitem").filter({ hasText: "Visitors" })).toContainText("▲ 24.0% vs previous period");
  await expect(totals.getByRole("listitem").filter({ hasText: "Visits" }).first()).toContainText("▼ 5.3% vs previous period");
  await expect(totals.getByRole("listitem").filter({ hasText: "Page views" })).toContainText("No change");
  await expect(page.getByRole("table", { name: "Top pages" })).toContainText("Roof inspections");
  await expect(page.getByRole("table", { name: "Where visits came from" })).toContainText("Organic Search");
  await expect(page.getByText(/Google Analytics · ledgetopdroneservices\.com · Updated/)).toBeVisible();
  await page.getByLabel("Period").selectOption("90d");
  await expect.poll(() => intelPaths(requests)).toContain("/api/intel/drone-services/website?range=90d");
  expect(new URL(page.url()).searchParams.get("range")).toBe("90d");
});

test("Search Console treats a lower average position as better and flags out-of-date data", async ({ page }) => {
  await mockOps(page);
  await page.goto("/intel?business=drone-services&view=search");
  const position = page.getByRole("list", { name: "Search totals" }).getByRole("listitem").filter({ hasText: "Average position" });
  await expect(position).toContainText("14.2");
  await expect(position.locator(".intel-change")).toHaveClass(/intel-up/);
  await expect(page.getByText(/Out of date, last updated/)).toBeVisible();
  await expect(page.getByRole("table", { name: "Top searches" })).toContainText("drone roof inspection");
  await expect(page.getByRole("table", { name: "Top pages in search" })).toContainText("https://ledgetopdroneservices.com/");
});

test("an unconnected source says so instead of showing zeros", async ({ page }) => {
  await mockOps(page, { sections: { "technologies/website": { status: 404, json: { error: "Not connected", code: "not_connected" } } } });
  await page.goto("/intel?business=technologies&view=website");
  await expect(page.getByText("Google Analytics isn't connected for Ledge Top Technologies yet.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Website totals" })).toHaveCount(0);
});

test("competitor review commands go to the selected business with the staff CSRF token", async ({ page }) => {
  const requests = await mockOps(page);
  await page.goto("/intel?business=drone-services&view=competitors");
  await page.getByRole("button", { name: "Run scan" }).click();
  await expect.poll(() => requests.filter(request => request.method() === "POST").length).toBe(1);
  const post = requests.find(request => request.method() === "POST")!;
  expect(new URL(post.url()).pathname).toBe("/api/intel/drone-services/competitors/commands");
  expect(post.headers()["x-csrf-token"]).toBe("csrf-test");
  expect(post.postDataJSON()).toMatchObject({ kind: "run_scan" });
});

test("Intel is hidden unless the session grants it, even to administrators, and a server refusal shows nothing private", async ({ page }) => {
  await mockOps(page, { intel: false });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Administration" }).click();
  await expect(page.locator("#ops-manage-menu").getByRole("link", { name: "Administration" })).toBeVisible();
  await expect(page.locator("#ops-manage-menu").getByRole("link", { name: "Intel" })).toHaveCount(0);
  await page.goto("/intel");
  await expect(page).not.toHaveURL(/\/intel/);

  await page.unrouteAll();
  await mockOps(page, { list: { status: 403, json: { error: "Forbidden" } } });
  await page.goto("/intel");
  await expect(page.getByText("No Ledge Top business is set up for Intel on your account yet.")).toBeVisible();
});

test("Intel fits a phone screen", async ({ page }) => {
  await mockOps(page);
  await page.goto("/intel?business=drone-services&view=search");
  await expect(page.getByRole("table", { name: "Top searches" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
