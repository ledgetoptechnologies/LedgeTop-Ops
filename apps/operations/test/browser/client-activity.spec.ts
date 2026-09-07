import { expect, test, type Page, type Route } from "@playwright/test";

const source = "project-alpha:primary", otherSource = "project-alpha:business_b";
const clientPath = "/clients/sources/project-alpha%3Aprimary/business/organizations/42";
const clientApi = "/api/client-hub/sources/project-alpha%3Aprimary/business/organizations/42";
const capabilities = { directory: true, requests: false, delivery: false, viewer: false };
const activityAsOf = "2026-08-26T18:00:00.000Z";
function client(id: string, name: string, activity: string | null = null) {
  return { workspace_id: null, kind: "organization", route_kind: "organizations", public_id: id, display_name: name, status: "active",
    portal_status: "not_supported", account_count: 0, project_count: 1, request_count: 0, contact_count: 2,
    source_id: source, source_name: "Primary business", root_namespace: "business", pa_public_id: null,
    detail_path: `${clientPath.slice(0, clientPath.lastIndexOf("/"))}/${id}`, meaningful_activity_at: activity };
}
const root = () => client("42", "Acme customer", "2026-08-25T10:20:30Z");
const sources = [{ source_id: source, display_name: "Primary business" }, { source_id: otherSource, display_name: "Second business" }];
const response = (clients = [root()], nextCursor: string | null = null) => ({ clients, nextCursor, capabilities, sources,
  indexUpdatedAt: "2026-08-26T17:59:00Z", activityAsOf, activityCoverage: "project_alpha_business_records" });
type Handler = (route: Route, url: URL) => Promise<unknown>;
async function fixture(page: Page, directory: Handler, activity?: Handler) {
  const calls: URL[] = [];
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url()); calls.push(url);
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: "staff-one", email: "staff@example.test", displayName: "Staff", status: "Active",
      profileType: "Employee", isAdministrator: false, permissions: ["team.view", "projects.view"], divisions: [] }, csrfToken: "test",
      timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    if (url.pathname === "/api/client-hub") return directory(route, url);
    if (url.pathname === `${clientApi}/activity` && activity) return activity(route, url);
    if (url.pathname === clientApi) return route.fulfill({ json: { client: root(), contacts: [], accounts: [], projects: [], requests: [],
      deliveryGrants: [], authenticatedDeliveryGrants: [], viewerGrants: [], contextVersion: "client-context", capabilities,
      businessActivityAvailable: true,
      businessProjects: [{ id: "project-one", name: "Site inspection", status: "active", start_date: null, end_date: null, created_at: null, manager_name: null }],
      pages: { businessProjects: { available: true, reason: null, nextCursor: null, hasMore: false, returned: 1, limit: 5 } },
      portalIdentities: { items: [], page: { available: false, reason: "workspace_unavailable", nextCursor: null, hasMore: false, returned: 0, limit: 5 },
        contextVersion: "client-context", refreshedAt: activityAsOf, capabilities: { canManagePortal: false, canManageEligibilityBlocks: false } } } });
    if (url.pathname === `${clientApi}/business-projects/project-one`) return route.fulfill({ json: {
      canonicalRoot: { sourceId: source, rootNamespace: "business", kind: "organization", publicId: "42" },
      client: { display_name: "Acme customer", detail_path: clientPath }, contextVersion: "project-context", refreshedAt: activityAsOf,
      project: { id: "project-one", name: "Site inspection", description: null, status: "active", start_date: null, end_date: null, created_at: null, manager: null },
      businessActivityAvailable: true,
      linkedContact: null, availability: { linkedContact: "not_projected", siteContacts: "not_projected", billingContacts: "not_projected", projectMemory: "not_projected" } } });
    if (url.pathname === `${clientApi}/business-projects/project-one/internal-notes` && route.request().method() === "GET") return route.fulfill({ json: {
      canonicalRoot: { sourceId: source, rootNamespace: "business", kind: "organization", publicId: "42" },
      contextVersion: "project-context", projectId: "project-one", notes: [], capabilities: { canManageNotes: false },
    } });
    return route.fulfill({ status: 404, json: { error: "Unsupported fixture route" } });
  });
  return calls;
}
const cards = (page: Page) => page.locator(".client-directory-card");
function update(id: string, name = "Site inspection", recordKind: "project" | "client" = "project") {
  return { id, sourceId: source, recordKind, recordId: recordKind === "project" ? "project-one" : "contact-one", recordName: name,
    action: "upsert" as const, origin: "projection_event" as const, occurredAt: "2026-08-25T10:20:30.000Z", observedAt: "2026-08-25T10:21:00.000Z",
    detailPath: recordKind === "project" ? `${clientPath}/projects/project-one` : clientPath };
}
type UpdateItem = Omit<ReturnType<typeof update>, "action" | "origin"> & {
  action: "upsert" | "revoke" | "source_record_updated";
  origin: "projection_event" | "source_observation";
};
function activityPage(items: UpdateItem[] = [update("1")], nextCursor: string | null = null, contextVersion = "client-context", limit = 5) {
  return { canonicalRoot: { sourceId: source, rootNamespace: "business", kind: "organization", publicId: "42" },
    contextVersion, refreshedAt: activityAsOf, asOf: activityAsOf, coverage: "source_records_only",
    items, page: { available: true, reason: null as string | null, nextCursor, hasMore: Boolean(nextCursor), returned: items.length, limit } };
}
const updates = (page: Page) => page.getByRole("region", { name: "Business record updates", exact: true });

test("recent is the default server order and name ordering preserves its own continuation", async ({ page }) => {
  const recent = [client("z", "Zebra recent", "2026-08-26T17:00:00Z"), client("a", "Alpha older", "2026-08-24T10:00:00Z")];
  const calls = await fixture(page, (route, url) => route.fulfill({ json: response(url.searchParams.has("cursor") ? [client("n", "No update")]
    : url.searchParams.get("sort") === "name" ? [...recent].reverse() : recent, url.searchParams.has("cursor") ? null : `${url.searchParams.get("sort")}-next`) }));
  await page.goto("/clients");
  await expect(page.getByRole("combobox", { name: "Sort clients" })).toHaveValue("recent");
  await expect(cards(page).locator("h3")).toHaveText(["Zebra recent", "Alpha older"]);
  expect(new URL(page.url()).searchParams.has("sort")).toBe(false);
  await page.getByRole("button", { name: "Load more clients" }).click();
  await expect(cards(page)).toHaveCount(3);
  expect(calls.some(url => url.searchParams.get("cursor") === "recent-next" && url.searchParams.get("sort") === "recent")).toBe(true);
  await page.getByRole("combobox", { name: "Sort clients" }).selectOption("name");
  await expect(cards(page).locator("h3")).toHaveText(["Alpha older", "Zebra recent"]);
  await expect(page).toHaveURL("/clients?sort=name");
  await page.getByRole("button", { name: "Load more clients" }).click();
  expect(calls.some(url => url.searchParams.get("cursor") === "name-next" && url.searchParams.get("sort") === "name")).toBe(true);
  await page.getByRole("combobox", { name: "Sort clients" }).selectOption("recent");
  await expect(page).toHaveURL("/clients");
});

test("sort and filters survive source and project links, refresh and Back Forward", async ({ page }) => {
  const calls = await fixture(page, route => route.fulfill({ json: response() }));
  const initial = "/clients?q=Acme&kind=organization&source=project-alpha%3Aprimary&sort=name";
  await page.goto(initial);
  await expect(page.getByRole("combobox", { name: "Sort clients" })).toHaveValue("name");
  await page.getByRole("link", { name: "Open Acme customer client workspace" }).click();
  await expect(page.getByRole("link", { name: "← Client Hub" })).toHaveAttribute("href", initial);
  await page.getByRole("link", { name: "Site inspection", exact: true }).click();
  const project = page.getByRole("region", { name: "Business project workspace", exact: true });
  await expect(project.getByRole("heading", { name: "Site inspection", exact: true })).toBeVisible();
  for (const [key, value] of new URLSearchParams(initial.split("?")[1])) expect(new URL(page.url()).searchParams.get(key)).toBe(value);
  await page.reload();
  const back = project.getByRole("link", { name: "Acme customer", exact: true });
  expect(new URL(await back.getAttribute("href") || "", page.url()).searchParams.get("sort")).toBe("name");
  await back.click(); await page.getByRole("link", { name: "← Client Hub" }).click();
  await expect(page.getByRole("combobox", { name: "Sort clients" })).toHaveValue("name");
  await page.getByRole("combobox", { name: "Sort clients" }).selectOption("recent");
  await page.goBack(); await expect(page.getByRole("combobox", { name: "Sort clients" })).toHaveValue("name");
  await page.goForward(); await expect(page.getByRole("combobox", { name: "Sort clients" })).toHaveValue("recent");
  expect(calls.filter(url => url.pathname === "/api/client-hub").every(url => url.searchParams.get("q") === "Acme" && url.searchParams.get("source") === source)).toBe(true);
});

test("changing sort aborts an old continuation and ignores its late response", async ({ page }) => {
  let old: Route | null = null;
  await fixture(page, async (route, url) => {
    if (url.searchParams.get("cursor") === "recent-more") { old = route; return; }
    return route.fulfill({ json: response([client(url.searchParams.get("sort") === "name" ? "a" : "z", url.searchParams.get("sort") === "name" ? "Alphabetical customer" : "Recent customer")],
      url.searchParams.get("sort") === "name" ? null : "recent-more") });
  });
  await page.goto("/clients"); await page.getByRole("button", { name: "Load more clients" }).click();
  await expect.poll(() => Boolean(old)).toBe(true);
  await page.getByRole("combobox", { name: "Sort clients" }).selectOption("name");
  await expect(cards(page).locator("h3")).toHaveText(["Alphabetical customer"]);
  await old!.fulfill({ json: response([client("old", "Obsolete late customer")]) }).catch(() => undefined);
  await expect(cards(page).locator("h3")).toHaveText(["Alphabetical customer"]);
  await expect(page.getByRole("button", { name: "Load more clients" })).toHaveCount(0);
});

test("business dates are strict, source observations are not activity, and the server clock is authoritative", async ({ page }) => {
  // A local clock behind the server must not make genuine server-observed updates look invalid.
  await page.clock.setFixedTime(new Date("2020-01-01T00:00:00Z"));
  const values = [client("iso", "ISO update", "2026-08-25T10:20:30Z"), client("sql", "SQL UTC update", "2026-08-25 10:20:30"),
    client("offset", "Offset update", "2026-08-25T12:20:30+02:00"), client("none", "No update"),
    client("future", "Future update", "2026-08-26T18:00:01Z"), client("bad", "Malformed update", "yesterday"),
    client("rollover", "Impossible calendar date", "2026-02-30T12:00:00Z"), client("zone", "Missing timezone", "2026-08-25T10:20:30")];
  await fixture(page, route => route.fulfill({ json: response(values) }));
  await page.goto("/clients");
  for (const label of ["ISO update", "SQL UTC update", "Offset update"]) {
    await expect(page.getByRole("link", { name: `Open ${label} client workspace` }).locator("time")).toHaveAttribute("datetime", "2026-08-25T10:20:30.000Z");
  }
  await expect(page.getByRole("link", { name: "Open No update client workspace" })).toContainText("No business update recorded");
  for (const label of ["Future update", "Malformed update", "Impossible calendar date", "Missing timezone"]) {
    const card = page.getByRole("link", { name: `Open ${label} client workspace` });
    await expect(card).toContainText("Business update unavailable"); await expect(card.locator("time")).toHaveCount(0);
  }
  await expect(page.locator(".client-directory-freshness time")).toHaveAttribute("datetime", "2026-08-26T17:59:00.000Z");
  await expect(page.getByText("Recent order uses business record updates you can access; synchronization and page views do not count.")).toBeVisible();
});

test("legacy responses without an observation time show valid timestamps without substituting the browser clock", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2020-01-01T00:00:00Z"));
  await fixture(page, route => route.fulfill({ json: { clients: [root()], nextCursor: null, capabilities } }));
  await page.goto("/clients");
  await expect(cards(page).locator("time")).toHaveAttribute("datetime", "2026-08-25T10:20:30.000Z");
});

test("a regrouped customer displays only its server-computed business update", async ({ page }) => {
  const party = { ...root(), business_party_id: "party-one", business_party_name: "Acme linked customer", business_party_member_count: 2,
    detail_path: "/clients/parties/party-one", meaningful_activity_at: "2026-08-26T16:00:00Z" };
  await fixture(page, route => route.fulfill({ json: response([party]) }));
  await page.goto("/clients?sort=name");
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText("Linked customer · 2 business records");
  await expect(cards(page).locator("time")).toHaveAttribute("datetime", "2026-08-26T16:00:00.000Z");
  await expect(cards(page)).toHaveAttribute("href", "/clients/parties/party-one?sort=name");
  await expect(cards(page).getByText("Shared projects", { exact: true })).toHaveCount(0);
});

test("stale activity cursors clear old dates and refresh without reusing the cursor", async ({ page }) => {
  let reads = 0;
  const calls = await fixture(page, (route, url) => {
    if (url.searchParams.has("cursor")) return route.fulfill({ status: 409, json: { error: "Business updates changed. Refresh the client directory." } });
    reads += 1;
    return route.fulfill({ json: response([client(reads === 1 ? "old" : "new", reads === 1 ? "Previous customer" : "Current customer", "2026-08-25T10:20:30Z")], reads === 1 ? "stale-updates" : null) });
  });
  await page.goto("/clients?sort=name"); await page.getByRole("button", { name: "Load more clients" }).click();
  await expect(page.getByRole("alert")).toContainText("Business updates changed");
  await expect(cards(page)).toHaveCount(0); await expect(page.locator(".client-directory-update time")).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh clients" }).click();
  await expect(cards(page).locator("h3")).toHaveText(["Current customer"]);
  expect(calls.filter(url => url.searchParams.get("cursor") === "stale-updates")).toHaveLength(1);
});

test("resetting search filters retains alphabetical preference and invalid sort inputs default safely", async ({ page }) => {
  const calls = await fixture(page, (route, url) => route.fulfill({ json: response(url.searchParams.has("q") ? [] : [root()]) }));
  await page.goto("/clients?q=missing&kind=organization&sort=name");
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(page).toHaveURL("/clients?sort=name"); await expect(page.getByRole("combobox", { name: "Sort clients" })).toHaveValue("name");
  await page.goto("/clients?sort=unsupported"); await expect(page.getByRole("combobox", { name: "Sort clients" })).toHaveValue("recent");
  expect(calls.filter(url => url.pathname === "/api/client-hub").at(-1)!.searchParams.get("sort")).toBe("recent");
});

test("sort controls and compact business update cards fit mobile through ultrawide layouts", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const clients = [client("42", `Recently updated ${"Long client name ".repeat(4)}`, "2026-08-26T17:00:00Z"),
    client("older", "Older business record", "2026-07-01T12:00:00Z"), client("none", "No recorded business update")];
  await fixture(page, route => route.fulfill({ json: response(clients) }));
  await page.goto("/clients"); await expect(cards(page)).toHaveCount(3);
  for (const width of [375, 640, 1280, 3440]) {
    await page.setViewportSize({ width, height: 900 });
    const sort = page.getByRole("combobox", { name: "Sort clients" }); await sort.focus(); await expect(sort).toBeFocused();
    expect((await sort.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    for (const card of await cards(page).all()) {
      const label = await card.locator(".client-directory-update dt").boundingBox(), value = await card.locator(".client-directory-update dd").boundingBox();
      expect(value!.y).toBeGreaterThanOrEqual(label!.y + label!.height);
      expect((await card.boundingBox())!.width).toBeLessThanOrEqual(width);
    }
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`client-business-update-${width}.png`) });
    await page.screenshot({ path: testInfo.outputPath(`client-business-update-${width}-full.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});

test("source updates load on demand, page by5 then25, and retry locally without losing focus or other records", async ({ page }) => {
  let more: Route | null = null, continuationCalls = 0;
  const calls = await fixture(page, route => route.fulfill({ json: response() }), async (route, url) => {
    if (url.searchParams.has("cursor") && ++continuationCalls === 1) { more = route; return; }
    return route.fulfill({ json: url.searchParams.has("cursor") ? activityPage([update("1"), update("2", "Earlier contact update", "client")], null, "client-context", 25)
      : activityPage([update("1")], "updates-next") });
  });
  await page.goto(`${clientPath}?q=Acme&sort=name`);
  await expect(updates(page).getByRole("button", { name: "Show business updates" })).toBeVisible();
  expect(calls.some(url => url.pathname.endsWith("/activity"))).toBe(false);
  const show = updates(page).getByRole("button", { name: "Show business updates" }); await show.focus(); await page.keyboard.press("Enter");
  await expect(updates(page).getByRole("button", { name: "Load more business updates" })).toBeFocused();
  await expect(updates(page).getByRole("link", { name: "Open project" })).toHaveAttribute("href", `${clientPath}/projects/project-one?q=Acme&sort=name`);
  await page.keyboard.press("Enter"); await expect.poll(() => Boolean(more)).toBe(true); await page.keyboard.press("Enter");
  expect(continuationCalls).toBe(1);
  await more!.fulfill({ status: 503, json: { error: "Updates are temporarily unavailable." } });
  await expect(updates(page).getByRole("alert")).toContainText("temporarily unavailable");
  await expect(updates(page).locator("li")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Acme customer", exact: true })).toBeVisible();
  await updates(page).getByRole("button", { name: "Retry business updates" }).click();
  await expect(updates(page).locator("li")).toHaveCount(2);
  await expect(updates(page).getByRole("button", { name: "Business updates loaded" })).toBeFocused();
  const reads = calls.filter(url => url.pathname.endsWith("/activity"));
  expect(reads.map(url => url.searchParams.get("limit"))).toEqual(["5", "25", "25"]);
  expect(reads.every(url => url.searchParams.get("expectedContextVersion") === "client-context" && !url.searchParams.has("projectId"))).toBe(true);
});

test("project updates use the exact project scope and retain client navigation", async ({ page }) => {
  const calls = await fixture(page, route => route.fulfill({ json: response() }), (route, url) => route.fulfill({ json: activityPage([update("1")], null,
    url.searchParams.get("expectedContextVersion") || "") }));
  await page.goto(`${clientPath}/projects/project-one?sort=name`);
  await updates(page).getByRole("button", { name: "Show business updates" }).click();
  await expect(updates(page).locator("li")).toHaveCount(1);
  await expect(updates(page).getByRole("link", { name: "Open project" })).toHaveCount(0);
  const request = calls.find(url => url.pathname.endsWith("/activity"))!;
  expect(request.searchParams.get("projectId")).toBe("project-one");
  expect(request.searchParams.get("expectedContextVersion")).toBe("project-context");
  await expect(page.getByRole("navigation", { name: "Project breadcrumbs" }).getByRole("link", { name: "Client Hub" })).toHaveAttribute("href", "/clients?sort=name");
});

for (const status of [401, 403, 404, 409]) test(`source activity ${status} clears the complete protected client workspace`, async ({ page }) => {
  await fixture(page, route => route.fulfill({ json: response() }), route => route.fulfill({ status, json: { error: "Activity context is no longer available." } }));
  await page.goto(clientPath); await updates(page).getByRole("button", { name: "Show business updates" }).click();
  await expect(page.getByText("Client workspace needs refreshing", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Acme customer", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Site inspection", exact: true })).toHaveCount(0);
  await expect(updates(page)).toHaveCount(0);
});

test("a timeline context mismatch invalidates project details instead of leaving stale contact or project data", async ({ page }) => {
  await fixture(page, route => route.fulfill({ json: response() }), route => route.fulfill({ json: activityPage([update("1")], null, "changed-project-context") }));
  await page.goto(`${clientPath}/projects/project-one`); await updates(page).getByRole("button", { name: "Show business updates" }).click();
  await expect(page.getByRole("alert")).toContainText("context changed");
  await expect(page.getByRole("heading", { name: "Site inspection", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Project overview", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reload project workspace" })).toBeVisible();
});

test("refreshing a project aborts a pending update page and a late response cannot repopulate it", async ({ page }) => {
  let pending: Route | null = null;
  const calls = await fixture(page, route => route.fulfill({ json: response() }), async route => { pending = route; });
  await page.goto(`${clientPath}/projects/project-one`); await updates(page).getByRole("button", { name: "Show business updates" }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByRole("button", { name: "Refresh project", exact: true }).click();
  await expect(updates(page).getByRole("button", { name: "Show business updates" })).toBeVisible();
  await pending!.fulfill({ json: activityPage([update("1", "Obsolete change")], null, "project-context") }).catch(() => undefined);
  await expect(page.getByText("Obsolete change", { exact: true })).toHaveCount(0);
  expect(calls.filter(url => url.pathname.endsWith("/activity"))).toHaveLength(1);
});

test("unavailable or malformed history remains an honest section state without invented updates", async ({ page }) => {
  let attempt = 0;
  await fixture(page, route => route.fulfill({ json: response() }), route => {
    if (++attempt === 1) return route.fulfill({ json: { ...activityPage([]), page: { ...activityPage([]).page, available: false, reason: "permission_required" } } });
    return route.fulfill({ json: activityPage([{ ...update("1"), occurredAt: "2026-02-30T12:00:00Z" }]) });
  });
  await page.goto(clientPath); await updates(page).getByRole("button", { name: "Show business updates" }).click();
  await expect(updates(page).getByText("Permission is required to view these updates.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Acme customer", exact: true })).toBeVisible();
  await updates(page).getByRole("button", { name: "Refresh business updates" }).click();
  await expect(updates(page).getByRole("alert")).toContainText("could not be verified");
  await expect(updates(page).locator("li")).toHaveCount(0);
});

test("populated source-record history is legible at mobile, narrow, laptop and ultrawide sizes", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const items = [update("1", `Roof and site survey ${"Long project name ".repeat(5)}`),
    { ...update("2"), action: "source_record_updated" as const, origin: "source_observation" as const }];
  await fixture(page, route => route.fulfill({ json: response() }), route => route.fulfill({ json: activityPage(items, "history-more", "project-context") }));
  await page.goto(`${clientPath}/projects/project-one`); await updates(page).getByRole("button", { name: "Show business updates" }).click();
  await expect(updates(page).locator("li")).toHaveCount(2);
  for (const width of [375, 640, 1280, 3440]) {
    await page.setViewportSize({ width, height: 900 });
    const more = updates(page).getByRole("button", { name: "Load more business updates" }); await more.focus(); await expect(more).toBeFocused();
    expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    for (const row of await updates(page).locator("li").all()) {
      const name = await row.locator("strong").boundingBox(), metadata = await row.locator("div > small").boundingBox();
      expect(metadata!.y).toBeGreaterThanOrEqual(name!.y + name!.height);
    }
    await updates(page).screenshot({ path: testInfo.outputPath(`client-business-history-${width}-section.png`) });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`client-business-history-${width}-full.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});
