import { expect, test, type Page, type Request } from "@playwright/test";
import { sampleStaffTenant } from "../../../../packages/shared/test-fixtures/competitor-intel-sample";

const user = (permissions: string[], intel: boolean) => ({
  user: { id: "owner-a", email: "owner@example.test", displayName: "Owner User", status: "Active", profileType: "Administrator",
    isAdministrator: true, permissions, divisions: [] },
  csrfToken: "csrf-test", timezone: "America/Chicago", capabilities: { intel: { enabled: intel } },
});
const businesses = [{ key: "drone-services", name: "Ledge Top Drone Services" }, { key: "technologies", name: "Ledge Top Technologies" }];
const digest = "q1_yGq5bBkqgXxkVdN7ZrUoQyN0nJbUqJKcB0g4tXvA";
const receipt = { operationId: "11111111-1111-4111-8111-111111111111", payloadSha256: digest, completedAt: "2026-10-24T06:00:00Z", acceptedAt: "2026-10-24T06:00:05Z" };
const sourcePage = (url: string, title: string | null, fetchStatus = "ok") => ({ url, title, observedAt: "2026-10-24T05:58:00Z", fetchStatus });
// Website ranges are the requested UTC change window ending today, so the fixture is built from the test's clock.
const windowFor = (days: number) => {
  const end = new Date(); end.setUTCHours(0, 0, 0, 0);
  return { start: new Date(end.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
};
const website = (days = 28) => ({
  schema: "ops.intel.website-monitor.v1", site: { canonicalDomain: "ledgetopdroneservices.com" }, range: windowFor(days),
  freshness: { fetchedAt: "2026-10-24T06:00:00Z", stale: false },
  monitoredPages: [{ ...sourcePage("https://ledgetopdroneservices.com/services/roof-inspections", "Roof inspections"), contentSha256: digest, contentLength: 18234 },
    { ...sourcePage("https://ledgetopdroneservices.com/pricing", null, "blocked"), contentSha256: digest, contentLength: 0 }],
  changesSincePrevious: [{ pageUrl: sourcePage("https://ledgetopdroneservices.com/services/roof-inspections", "Roof inspections"), changeType: "content_changed",
    summary: "Added a section on insurance claim photos.", addedSentences: ["We provide insurance-ready roof photos."], removedSentences: [], detectedAt: "2026-10-22T14:00:00Z" }],
  technical: { httpsOk: { value: true, state: "observed", reason: null }, sitemapPageCount: { value: 42, state: "observed", reason: null },
    robotsAllowsIndexing: { value: null, state: "unknown", reason: "robots_blocked" }, avgFetchMs: 640 },
  provenance: { source: "hermes_site_monitor", sourceAccountRef: null, collectedBy: "hermes", collectedAt: "2026-10-24T06:00:00Z", asOf: null,
    lastDataDate: null, dataRange: null, partial: false, partialReason: null, limits: [] },
  receipt,
});
const search = {
  site: { url: "sc-domain:ledgetopdroneservices.com" }, range: { start: "2026-09-23", end: "2026-10-20" },
  freshness: { fetchedAt: "2026-10-23T06:00:00Z", stale: true },
  totals: { clicks: 312, impressions: 18400, ctr: 0.017, position: 14.2 }, previous: null,
  queries: [{ query: "drone roof inspection", clicks: 44, impressions: 1900, ctr: 0.023, position: 6.1 },
    { query: "aerial survey near me", clicks: 0, impressions: 40, ctr: null, position: null }],
  pages: [{ url: "https://ledgetopdroneservices.com/", clicks: 120, impressions: 8000, ctr: 0.015, position: 11.3 }],
  daily: [{ date: "2026-10-20", clicks: 12, impressions: 700 }],
  comparison: { previousPeriod: { start: "2026-08-26", end: "2026-09-22", days: 28 }, clicksDeltaPercent: "11.4", impressionsDeltaPercent: "-2.5" },
  coverage: { state: "observed", reason: null, lastDataDate: "2026-10-20", dataRange: { start: "2026-09-23", end: "2026-10-20" }, partial: false,
    partialReason: null, limits: [] as string[], asOf: null, rangeSelection: "28d" },
  receipt,
};
const search7 = { ...search, range: { start: "2026-10-14", end: "2026-10-20" }, comparison: null, coverage: { ...search.coverage, rangeSelection: "7d" } };

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
      const days = Number((url.searchParams.get("range") ?? "28d").slice(0, -1));
      return route.fulfill({ json: match[2] === "competitors" ? sampleStaffTenant : match[2] === "website" ? website(days) : days === 7 ? search7 : search });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return requests;
}
const intelPaths = (requests: Request[]) => requests.map(request => new URL(request.url())).filter(url => url.pathname.startsWith("/api/intel/"))
  .map(url => `${url.pathname}${url.search}`);

const overviewCard = (page: Page, name: string) => page.getByRole("region", { name });

test("Intel opens from the Administration menu on an overview of both businesses that links to each detail view", async ({ page }) => {
  const requests = await mockOps(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Administration" }).click();
  await page.locator("#ops-manage-menu").getByRole("link", { name: "Intel" }).click();
  await expect(page).toHaveURL(/\/intel$/);
  await expect(page.getByRole("heading", { name: "Intel", level: 1 })).toBeVisible();
  for (const [key, name] of [["drone-services", "Ledge Top Drone Services"], ["technologies", "Ledge Top Technologies"]] as const) {
    const card = overviewCard(page, name);
    await expect(card.getByRole("heading", { name, level: 2 })).toBeVisible();
    await expect(card).toContainText(`${sampleStaffTenant.competitors.length} competitor`);
    await expect(card).toContainText("2 pages monitored · 1 change");
    await expect(card).toContainText("312 clicks · 18,400 impressions · Out of date");
    for (const [label, view] of [["Competitor Intel", "competitors"], ["Site monitor", "website"], ["Search Console", "search"]] as const)
      await expect(card.getByRole("link", { name: new RegExp(`^${label}`) })).toHaveAttribute("href", `/intel?business=${key}&view=${view}&range=28d`);
  }
  await expect(page.getByRole("group", { name: "Business" })).toHaveCount(0);
  expect(requests.filter(request => request.method() !== "GET")).toEqual([]);
  expect(intelPaths(requests).sort()).toEqual(["/api/intel/businesses",
    ...["drone-services", "technologies"].flatMap(key => [`/api/intel/${key}/competitors`, `/api/intel/${key}/search-console?range=28d`, `/api/intel/${key}/website?range=28d`])].sort());

  await overviewCard(page, "Ledge Top Technologies").getByRole("link", { name: /^Search Console/ }).click();
  await expect(page).toHaveURL(/\/intel\?business=technologies&view=search&range=28d$/);
  await expect(page.getByRole("group", { name: "Business" }).getByRole("button", { name: "Ledge Top Technologies" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("list", { name: "Search totals" })).toBeVisible();
  await page.goBack();
  await expect(overviewCard(page, "Ledge Top Drone Services")).toBeVisible();
  await overviewCard(page, "Ledge Top Drone Services").getByRole("link", { name: /^Competitor Intel/ }).click();
  await expect(page.getByRole("heading", { name: sampleStaffTenant.tenantName })).toBeVisible();
  await page.getByRole("link", { name: "← All businesses" }).click();
  await expect(page).toHaveURL(/\/intel$/);
  await expect(overviewCard(page, "Ledge Top Technologies")).toBeVisible();
});

test("the overview keeps each business and section separate: a failure or missing source never hides the rest or shows zeros", async ({ page }) => {
  await mockOps(page, { sections: {
    "technologies/competitors": { status: 500, json: { error: "Unavailable" } },
    "technologies/website": { status: 404, json: { error: "intel_website_not_connected" } },
    "technologies/search-console": { status: 404, json: { error: "intel_awaiting_first_data" } },
    "drone-services/search-console": { json: { ...search, totals: { clicks: null, impressions: null, ctr: null, position: null } } },
  } });
  await page.goto("/intel");
  const technologies = overviewCard(page, "Ledge Top Technologies"), drone = overviewCard(page, "Ledge Top Drone Services");
  await expect(technologies).toContainText("This view couldn't be loaded.");
  await expect(technologies).toContainText("Not set up yet");
  await expect(technologies).toContainText("Waiting for the first data");
  await expect(technologies).not.toContainText(/\b0\b/);
  await expect(drone).toContainText(`${sampleStaffTenant.competitors.length} competitor`);
  await expect(drone).toContainText("2 pages monitored");
  await expect(drone).toContainText("Clicks not available · Impressions not available");
  await expect(drone).not.toContainText("This view couldn't be loaded.");
  await page.unrouteAll();
  await mockOps(page);
  await technologies.getByRole("button", { name: "Try again" }).click();
  await expect(technologies).toContainText(`${sampleStaffTenant.competitors.length} competitor`);
});

test("the overview fits a phone screen", async ({ page }) => {
  await mockOps(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/intel");
  await expect(overviewCard(page, "Ledge Top Technologies")).toContainText("312 clicks");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("switching business loads that business only and explains what isn't set up", async ({ page }) => {
  const requests = await mockOps(page, { sections: { "technologies/competitors": { status: 404, json: { error: "Not configured", code: "not_configured" } } } });
  await page.goto("/intel?business=drone-services");
  await page.getByRole("button", { name: "Ledge Top Technologies" }).click();
  await expect(page.getByText("Competitors for Ledge Top Technologies haven't been added yet.")).toBeVisible();
  await expect(page.getByRole("heading", { name: sampleStaffTenant.tenantName })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("business")).toBe("technologies");
  expect(intelPaths(requests)).toContain("/api/intel/technologies/competitors");
});

test("the site monitor shows own-site health, monitored pages and changes, and follows the chosen period", async ({ page }) => {
  const requests = await mockOps(page);
  await page.goto("/intel?business=drone-services&view=website");
  await expect(page.getByText(/site monitoring, not visitor analytics/)).toBeVisible();
  const health = page.getByRole("list", { name: "Site health" });
  await expect(health.getByRole("listitem").filter({ hasText: "Secure (HTTPS)" })).toContainText("Yes");
  await expect(health.getByRole("listitem").filter({ hasText: "Pages in sitemap" })).toContainText("42");
  // An unknown fact gives its reason, never a yes/no or a zero.
  await expect(health.getByRole("listitem").filter({ hasText: "Search engines may index" })).toContainText("The site asks automated checks not to read this page");
  await expect(health.getByRole("listitem").filter({ hasText: "Average page response" })).toContainText("640 ms");
  const pages = page.getByRole("table", { name: "Monitored pages" });
  await expect(pages).toContainText("Roof inspections");
  await expect(pages.getByRole("row").filter({ hasText: "/pricing" })).toContainText("Blocked automated checks");
  const changes = page.getByRole("region", { name: "Changes in this period" });
  await expect(changes).toContainText("Content changed");
  await expect(changes).toContainText("Added a section on insurance claim photos.");
  await changes.getByText("What changed").click();
  await expect(changes).toContainText("We provide insurance-ready roof photos.");
  await expect(page.getByText(/Site monitor · ledgetopdroneservices\.com · Updated/)).toBeVisible();
  // No visitor-analytics metrics or Google Analytics labels.
  for (const label of ["Visitors", "Visits", "Page views", "Conversions"]) await expect(page.getByText(label, { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Google Analytics/)).toHaveCount(0);
  await page.getByRole("combobox", { name: /^Period/ }).selectOption("90d");
  await expect.poll(() => intelPaths(requests)).toContain("/api/intel/drone-services/website?range=90d");
  await expect(page.getByRole("list", { name: "Site health" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("range")).toBe("90d");
});

test("Search Console shows totals with the source's own changes, flags out-of-date data and lists top searches and pages", async ({ page }) => {
  await mockOps(page);
  await page.goto("/intel?business=drone-services&view=search");
  const totals = page.getByRole("list", { name: "Search totals" });
  const metric = (label: string) => totals.getByRole("listitem").filter({ has: page.getByText(label, { exact: true }) });
  await expect(metric("Clicks")).toContainText("312");
  await expect(metric("Clicks").locator(".intel-change")).toHaveText("▲ 11.4% vs previous 28 days");
  await expect(metric("Impressions").locator(".intel-change")).toHaveText("▼ 2.5% vs previous 28 days");
  // CTR is a fraction: 0.017 is 1.7%. There is no invented prior CTR or position.
  await expect(metric("Click-through rate")).toContainText("1.7%");
  await expect(metric("Click-through rate").locator(".intel-change")).toHaveCount(0);
  await expect(metric("Average position")).toContainText("14.2");
  await expect(metric("Average position")).toContainText("Lower is better");
  await expect(page.getByText(/Out of date, last updated/)).toBeVisible();
  await expect(page.getByText(/Sep 23, 2026 – Oct 20, 2026/)).toBeVisible();
  await expect(page.getByText("Google data through Oct 20, 2026.")).toBeVisible();
  const searches = page.getByRole("table", { name: "Top searches" });
  await expect(searches).toContainText("drone roof inspection");
  await expect(searches.getByRole("row").filter({ hasText: "aerial survey near me" })).toContainText("Not available");
  await expect(page.getByRole("table", { name: "Top pages in search" })).toContainText("https://ledgetopdroneservices.com/");
});

test("Search Console never fills unreported totals with zeros and says why they're missing", async ({ page }) => {
  await mockOps(page, { sections: { "drone-services/search-console": { json: { ...search, comparison: null,
    totals: { clicks: null, impressions: null, ctr: null, position: null }, queries: [], pages: [], daily: [],
    coverage: { ...search.coverage, state: "unknown", reason: "provider_data_delay", partial: true, partialReason: "data_limited", limits: ["Top 25 rows only"] } } } } });
  await page.goto("/intel?business=drone-services&view=search");
  const totals = page.getByRole("list", { name: "Search totals" });
  for (const label of ["Clicks", "Impressions", "Click-through rate", "Average position"])
    await expect(totals.getByRole("listitem").filter({ has: page.getByText(label, { exact: true }) })).toContainText("Not available");
  await expect(totals).not.toContainText(/\d/);
  await expect(totals.locator(".intel-change")).toHaveCount(0);
  const about = page.getByRole("list", { name: "About this data" });
  await expect(about).toContainText("Google didn't report totals for this period: Google hasn't finished reporting this period yet.");
  await expect(about).toContainText("Partial data: Google limited the data it reported.");
  await expect(about).toContainText("Top 25 rows only");
});

test("a period the source hasn't reported says so; a reply for a different period is never shown as the chosen one", async ({ page }) => {
  await mockOps(page, { sections: { "drone-services/search-console": { status: 404, json: { error: "intel_range_unavailable" } } } });
  await page.goto("/intel?business=drone-services&view=search&range=7d");
  await expect(page.getByText("Search Console hasn't reported the last 7 days for Ledge Top Drone Services. Choose another period.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Search totals" })).toHaveCount(0);
  await page.unrouteAll();
  // A 28-day answer to a 7-day request is refused rather than relabelled, whatever it claims to be.
  for (const json of [search, { ...search, coverage: { ...search.coverage, rangeSelection: "7d" } }]) {
    await mockOps(page, { sections: { "drone-services/search-console": { json } } });
    await page.goto("/intel?business=drone-services&view=search&range=7d");
    await expect(page.getByText("This view couldn't be loaded.")).toBeVisible();
    await expect(page.getByRole("list", { name: "Search totals" })).toHaveCount(0);
    await page.unrouteAll();
  }
});

test("a source that isn't connected, or hasn't sent data yet, says so instead of showing zeros", async ({ page }) => {
  await mockOps(page, { sections: { "technologies/website": { status: 404, json: { error: "intel_website_not_connected" } },
    "technologies/search-console": { status: 404, json: { error: "intel_awaiting_first_data" } } } });
  await page.goto("/intel?business=technologies&view=website");
  await expect(page.getByText("Ledge Top's site monitor isn't connected for Ledge Top Technologies yet.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Site health" })).toHaveCount(0);
  await page.getByRole("navigation", { name: "Intel views" }).getByRole("button", { name: "Search Console" }).click();
  await expect(page.getByText("Search Console is set up for Ledge Top Technologies, but no data has arrived yet.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Search totals" })).toHaveCount(0);
});

test("competitor intel is read-only: no scan, verdict or client report controls, and nothing is sent", async ({ page }) => {
  const requests = await mockOps(page);
  await page.goto("/intel?business=drone-services&view=competitors");
  await expect(page.getByRole("heading", { name: sampleStaffTenant.tenantName })).toBeVisible();
  for (const name of ["Run scan", "Review Google Ads", "Accurate", "Inaccurate", "Change verdict"])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Client report" })).toHaveCount(0);
  await page.getByRole("tab", { name: /Self-assessment/ }).click();
  await expect(page.getByRole("button", { name: "Run self-assessment" })).toHaveCount(0);
  expect(requests.filter(request => request.method() !== "GET")).toEqual([]);
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

test("a wrong-shaped business list or section shows an error instead of breaking the page", async ({ page }) => {
  await mockOps(page, { list: { json: { businesses: [{ key: 3 }] } } });
  await page.goto("/intel");
  await expect(page.getByText("Intel couldn't be loaded.")).toBeVisible();

  await page.unrouteAll();
  await mockOps(page, { sections: {
    "drone-services/website": { json: { ...website(), technical: "fine" } },
    "drone-services/search-console": { json: { site: { url: "x" } } },
    "drone-services/competitors": { json: { ...sampleStaffTenant, competitors: [{ subjectKey: "comp:x", name: "x", baseline: {} }] } },
  } });
  for (const view of ["website", "search", "competitors"]) {
    await page.goto(`/intel?business=drone-services&view=${view}`);
    await expect(page.getByText("This view couldn't be loaded.")).toBeVisible();
  }
});

for (const width of [320, 375, 390]) for (const font of ["default", "Arial"] as const)
  test(`at ${width}px (${font} font) every business and view choice is fully on screen and tappable`, async ({ page }) => {
  await mockOps(page);
  await page.setViewportSize({ width, height: 800 });
  await page.goto("/intel?business=drone-services&view=competitors");
  // Linux CI renders with wider fallback fonts; Arial reproduces that width here.
  if (font === "Arial") await page.addStyleTag({ content: "* { font-family: Arial, sans-serif !important; }" });
  await expect(page.getByRole("tab", { name: /Self-assessment/ })).toBeVisible();
  const controls = [page.getByRole("button", { name: "Ledge Top Drone Services" }), page.getByRole("button", { name: "Ledge Top Technologies" }),
    ...["Competitor Intel", "Site monitor", "Search Console"].map(name => page.getByRole("navigation", { name: "Intel views" }).getByRole("button", { name })),
    ...[/Review changes/, /^Competitors$/, /Google Ads/, /Self-assessment/].map(name => page.getByRole("tab", { name }))];
  for (const control of controls) {
    await control.scrollIntoViewIfNeeded();
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    // The control itself is what a tap at its centre reaches, not a neighbour or the header.
    expect(await control.evaluate(element => { const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return !!hit && element.contains(hit); })).toBe(true);
  }
  await page.getByRole("tab", { name: /Self-assessment/ }).click();
  await expect(page.getByRole("tab", { name: /Self-assessment/ })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Ledge Top Technologies" }).click();
  await expect(page.getByRole("button", { name: "Ledge Top Technologies" })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("Intel fits a phone screen", async ({ page }) => {
  await mockOps(page);
  await page.goto("/intel?business=drone-services&view=search");
  await expect(page.getByRole("table", { name: "Top searches" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
