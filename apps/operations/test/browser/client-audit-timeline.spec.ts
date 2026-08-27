import { expect, test, type Page, type Route } from "@playwright/test";

const source = "project-alpha:primary";
const clientPath = "/clients/sources/project-alpha%3Aprimary/business/organizations/42";
const clientApi = "/api/client-hub/sources/project-alpha%3Aprimary/business/organizations/42";
const projectPath = `${clientPath}/projects/project-one`;
const projectApi = `${clientApi}/business-projects/project-one`;
const asOf = "2026-08-26T19:00:00.000Z";
const canonicalRoot = { sourceId: source, rootNamespace: "business", kind: "organization", publicId: "42" };
const coverage = {
  project: { available: true, reason: null }, request: { available: true, reason: null },
  feedback: { available: false, reason: "not_collected" }, access: { available: true, reason: null },
  delivery: { available: false, reason: "permission_required" }, notification: { available: false, reason: "not_applicable" },
};
type Filters = { category: string; actorType: string; result: string; from: string | null; to: string | null };
function item(id: string, overrides: Record<string, unknown> = {}) {
  return { id, sourceId: source, producer: "portal_access", producerEventId: `event-${id}`, category: "access", action: "member_denied",
    actor: { type: "staff", label: "Morgan Manager" }, resource: { type: "workspace_member", id: "member-one", label: "Alex Client", detailPath: clientPath },
    result: "denied", occurredAt: "2026-08-26T18:30:00.000Z", ...overrides };
}
function filters(url: URL): Filters {
  return { category: url.searchParams.get("category") || "all", actorType: url.searchParams.get("actorType") || "all",
    result: url.searchParams.get("result") || "all", from: url.searchParams.get("from"), to: url.searchParams.get("to") };
}
function timeline(url: URL, items = [item("one")], nextCursor: string | null = null, contextVersion = "client-context", projectId: string | null = null) {
  return { canonicalRoot, projectId, contextVersion, refreshedAt: asOf, asOf, coverage, filters: filters(url), items,
    page: { nextCursor, hasMore: Boolean(nextCursor), returned: items.length, limit: 10 } };
}
function clientDetail() {
  return { client: { workspace_id: null, public_id: "42", kind: "organization", route_kind: "organizations", source_id: source,
    root_namespace: "business", pa_public_id: null, detail_path: clientPath, display_name: "Acme Construction", status: "active",
    portal_status: "not_provisioned", account_count: 0, project_count: 0, request_count: 0, contact_count: 0 },
    contacts: [], accounts: [], projects: [], requests: [], deliveryGrants: [], authenticatedDeliveryGrants: [], viewerGrants: [],
    contextVersion: "client-context", capabilities: { directory: true, requests: false, delivery: false, viewer: false },
    businessParty: null, canManageBusinessParties: false };
}
function projectDetail() {
  return { canonicalRoot, client: { display_name: "Acme Construction", detail_path: clientPath }, contextVersion: "project-context", refreshedAt: asOf,
    project: { id: "project-one", name: "Church survey", status: "active", description: null, start_date: null, end_date: null, created_at: null, manager: null },
    linkedContact: null, availability: { linkedContact: "not_projected", siteContacts: "not_projected", billingContacts: "not_projected", projectMemory: "not_projected" } };
}
type Handler = (route: Route, url: URL) => Promise<unknown>;
async function fixture(page: Page, timelineHandler: Handler) {
  const calls: URL[] = [];
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url()); calls.push(url);
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: "staff-one", email: "staff@example.test", displayName: "Staff", status: "Active",
      profileType: "Employee", isAdministrator: false, permissions: ["team.view", "projects.view"], divisions: [] }, csrfToken: "test",
      timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    if (url.pathname === clientApi) return route.fulfill({ json: clientDetail() });
    if (url.pathname === projectApi) return route.fulfill({ json: projectDetail() });
    if (url.pathname === `${clientApi}/timeline` || url.pathname === `${projectApi}/timeline`) return timelineHandler(route, url);
    return route.fulfill({ status: 404, json: { error: "Unsupported fixture route" } });
  });
  return calls;
}
const clientTimeline = (page: Page) => page.getByRole("region", { name: "Client audit timeline", exact: true });
const projectTimeline = (page: Page) => page.getByRole("region", { name: "Project audit timeline", exact: true });

test("client timeline applies exact server filters, discloses coverage, and retries one continuation without losing rows", async ({ page }) => {
  let continuation = 0;
  const calls = await fixture(page, (route, url) => {
    if (url.searchParams.has("cursor") && ++continuation === 1) return route.fulfill({ status: 503, json: { error: "Audit storage is temporarily unavailable." } });
    return route.fulfill({ json: timeline(url, url.searchParams.has("cursor") ? [item("two", { resource: { type: "workspace_member", label: "Taylor Client" } })]
      : [item("one")], url.searchParams.has("cursor") ? null : "audit-next") });
  });
  await page.goto(clientPath);
  const section = clientTimeline(page);
  await section.getByRole("combobox", { name: "Category" }).selectOption("access");
  await section.getByRole("combobox", { name: "Actor" }).selectOption("staff");
  await section.getByRole("combobox", { name: "Result" }).selectOption("denied");
  await section.getByLabel("From date (UTC)").fill("2026-08-01");
  await section.getByLabel("To date (UTC)").fill("2026-08-26");
  await section.getByRole("button", { name: "Apply timeline filters" }).click();
  await expect(section.getByText("Alex Client", { exact: true })).toBeVisible();
  await section.getByText("Timeline coverage", { exact: true }).click();
  await expect(section.getByText(/empty result does not prove/i)).toBeVisible();
  await expect(section.getByText("not collected", { exact: true })).toBeVisible();
  await expect(section.getByText("permission required", { exact: true })).toBeVisible();
  const first = calls.find(url => url.pathname.endsWith("/timeline"))!;
  expect(Object.fromEntries(["category", "actorType", "result", "from", "to", "limit", "expectedContextVersion"].map(key => [key, first.searchParams.get(key)]))).toEqual({
    category: "access", actorType: "staff", result: "denied", from: "2026-08-01T00:00:00.000Z", to: "2026-08-26T23:59:59.999Z", limit: "10", expectedContextVersion: "client-context",
  });
  const more = section.getByRole("button", { name: "Load more audit events" }); await more.focus(); await page.keyboard.press("Enter");
  await expect(section.getByRole("alert")).toContainText("temporarily unavailable");
  await expect(section.locator(".client-audit-events > li")).toHaveCount(1);
  await section.getByRole("button", { name: "Retry audit timeline" }).click();
  await expect(section.locator(".client-audit-events > li")).toHaveCount(2);
  await expect(section.getByText("All matching audit events loaded", { exact: true })).toBeVisible();
  const continued = calls.filter(url => url.searchParams.get("cursor") === "audit-next");
  expect(continued).toHaveLength(2);
  expect(continued.every(url => url.searchParams.get("category") === "access" && url.searchParams.get("expectedContextVersion") === "client-context")).toBe(true);
});

test("invalid dates and malformed responses fail locally without inventing events", async ({ page }) => {
  let reads = 0;
  await fixture(page, (route, url) => route.fulfill({ json: ++reads === 1 ? timeline(url, [{ ...item("bad"), sourceId: "project-alpha:other" }]) : timeline(url, []) }));
  await page.goto(clientPath);
  const section = clientTimeline(page);
  await section.getByLabel("From date (UTC)").fill("2026-08-20");
  await section.getByLabel("To date (UTC)").fill("2026-08-01");
  await section.getByRole("button", { name: "Apply timeline filters" }).click();
  await expect(section.getByRole("alert")).toContainText("From on or before To");
  expect(reads).toBe(0);
  await section.getByLabel("To date (UTC)").fill("2026-08-26");
  await section.getByRole("button", { name: "Apply timeline filters" }).click();
  await expect(section.getByRole("alert")).toContainText("could not be verified");
  await expect(section.locator(".client-audit-events > li")).toHaveCount(0);
  await section.getByRole("button", { name: "Retry audit timeline" }).click();
  await expect(section.getByText("No matching events are available within the reported coverage.", { exact: true })).toBeVisible();
});

test("project timeline uses the child route, invalidates stale context, and parent refresh cancels a pending page", async ({ page }) => {
  let pending: Route | null = null, mode: "pending" | "mismatch" = "pending";
  const calls = await fixture(page, async (route, url) => {
    if (mode === "pending") { pending = route; return; }
    return route.fulfill({ status: 409, json: { error: "The project context changed. Refresh and retry." } });
  });
  await page.goto(projectPath);
  let section = projectTimeline(page);
  await section.getByRole("button", { name: "Apply timeline filters" }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByRole("button", { name: "Refresh project", exact: true }).click();
  await expect(projectTimeline(page).getByText("Apply filters to load the timeline.", { exact: true })).toBeVisible();
  await pending!.fulfill({ json: timeline(new URL(pending!.request().url()), [item("late")], null, "project-context", "project-one") }).catch(() => undefined);
  await expect(page.getByText("Alex Client", { exact: true })).toHaveCount(0);
  mode = "mismatch"; section = projectTimeline(page);
  await section.getByRole("button", { name: "Apply timeline filters" }).click();
  await expect(page.getByRole("alert")).toContainText("context changed");
  await expect(page.getByRole("heading", { name: "Church survey", exact: true })).toHaveCount(0);
  const auditCalls = calls.filter(url => url.pathname.endsWith("/timeline"));
  expect(auditCalls.every(url => url.pathname === `${projectApi}/timeline` && url.searchParams.get("expectedContextVersion") === "project-context")).toBe(true);
});

test("populated audit controls and events remain usable on mobile and desktop", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await fixture(page, (route, url) => route.fulfill({ json: timeline(url, [item("long", { resource: { type: "workspace_member",
    label: `Regional construction client ${"with a long descriptive name ".repeat(5)}` } })]) }));
  await page.goto(clientPath); const section = clientTimeline(page);
  await section.getByRole("button", { name: "Apply timeline filters" }).click();
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    for (const control of await section.locator("select, input, button").all()) expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const label = await section.locator(".client-audit-events strong").boundingBox();
    const metadata = await section.locator(".client-audit-events small").first().boundingBox();
    expect(metadata!.y).toBeGreaterThanOrEqual(label!.y + label!.height);
    await section.screenshot({ path: testInfo.outputPath(`client-audit-${width}.png`) });
  }
  expect(errors).toEqual([]);
});
