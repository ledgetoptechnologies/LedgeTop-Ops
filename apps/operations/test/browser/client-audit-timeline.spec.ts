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
const projectCoverage = {
  source_record_activity: { available: true, reason: null },
  operational_project_activity: { available: true, reason: null },
};
const accessCoverage = {
  workspace_membership: { available: true, reason: null }, workspace_invitation_request: { available: true, reason: null },
  workspace_peer_administrator: { available: true, reason: null }, portal_identity_denial: { available: true, reason: null },
  authenticated_delivery_grant: { available: false, reason: "permission_required" },
  delegated_client_share: { available: false, reason: "permission_required" },
  viewer_client_grant: { available: false, reason: "permission_required" }, project_access: { available: false, reason: "not_collected" },
};
const notificationCoverage = {
  delivery_share_notification: { available: false, reason: "permission_required" },
  project_access_collaborator_notice: { available: false, reason: "not_collected" },
  project_access_companion_notice: { available: false, reason: "not_collected" },
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
  return { canonicalRoot, projectId, contextVersion, refreshedAt: asOf, asOf, coverage, projectCoverage, accessCoverage, notificationCoverage,
    filters: filters(url), items,
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
function operationalWorkspace() {
  return { canonicalRoot, contextVersion: "project-context",
    project: { id: "project-one", sourceId: source, status: "active", revision: "project-one-revision" },
    contacts: { version: 0, assignments: [], revisions: [] },
    memory: { version: 0, snapshot: { plan: "", actualOutcome: "", deviationsAndReasons: "", observations: "", problems: "",
      successes: "", recommendations: "", nextTimeRequests: "" }, revisions: [] },
    capabilities: { canManageContacts: false, canManageMemory: false }, contactOptions: [],
    contactPage: { available: false, reason: "permission_required", nextCursor: null, hasMore: false, returned: 0, limit: 25 } };
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
    if (url.pathname === `${projectApi}/operational-workspace`) return route.fulfill({ json: operationalWorkspace() });
    if (url.pathname === `${clientApi}/collections/businessProjects`) return route.fulfill({ json: { canonicalRoot,
      contextVersion: "project-context", items: [{ id: "project-one", name: "Church survey", status: "active", row_key: "business:project-one" }],
      page: { available: true, reason: null, nextCursor: null, hasMore: false, returned: 1, limit: 25 } } });
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
  await expect(section.getByText("not collected", { exact: true }).first()).toBeVisible();
  await expect(section.getByText("Access · project access", { exact: true })).toBeVisible();
  await expect(section.getByText("Notifications · project access collaborator notice", { exact: true })).toBeVisible();
  await expect(section.getByText("Notifications · project access companion notice", { exact: true })).toBeVisible();
  await expect(section.getByText("Notifications · delivery share notification", { exact: true })).toBeVisible();
  await expect(section.getByText("permission required", { exact: true }).first()).toBeVisible();
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
  const pending: Route[] = [];
  let mode: "pending" | "mismatch" = "pending";
  const calls = await fixture(page, async (route, url) => {
    if (mode === "pending") { pending.push(route); return; }
    return route.fulfill({ status: 409, json: { error: "The project context changed. Refresh and retry." } });
  });
  await page.goto(projectPath);
  let section = projectTimeline(page);
  await section.getByRole("button", { name: "Apply timeline filters" }).click();
  await expect.poll(() => pending.length).toBe(1);
  const stale = pending[0]!;
  await page.getByRole("button", { name: "Refresh project", exact: true }).click();
  // Applied filters are URL state, so a parent refresh intentionally restores
  // them in a new child request while aborting the request from the old tree.
  await expect.poll(() => pending.length).toBe(2);
  await stale.fulfill({ json: timeline(new URL(stale.request().url()), [item("late")], null, "project-context", "project-one") }).catch(() => undefined);
  await expect(page.getByText("Alex Client", { exact: true })).toHaveCount(0);
  const current = pending[1]!;
  await current.fulfill({ json: timeline(new URL(current.request().url()), [], null, "project-context", "project-one") });
  await expect(projectTimeline(page).getByText("No matching events are available within the reported coverage.", { exact: true })).toBeVisible();
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

test("project timeline renders redacted operational activity without new authority controls", async ({ page }) => {
  await fixture(page, (route, url) => route.fulfill({ json: timeline(url, [item("operational", {
    producer: "operations", producerEventId: "operational-project:event-memory-amended", category: "project",
    action: "project.memory.amended", actor: { type: "staff", label: "Team" },
    resource: { type: "project_operational_record", id: "project-one", label: "Church survey", detailPath: projectPath },
    result: "succeeded",
  })], null, "project-context", "project-one") }));
  await page.goto(projectPath);
  const section = projectTimeline(page);
  await section.getByRole("combobox", { name: "Category" }).selectOption("project");
  await section.getByRole("combobox", { name: "Actor" }).selectOption("staff");
  await section.getByRole("combobox", { name: "Result" }).selectOption("succeeded");
  await section.getByRole("button", { name: "Apply timeline filters" }).click();
  await expect(section.getByText("Church survey", { exact: true })).toBeVisible();
  await expect(section.getByText("Projects · project.memory.amended", { exact: true })).toBeVisible();
  await expect(section.getByText("Team · staff", { exact: true })).toBeVisible();
  await expect(section.getByText("operations", { exact: true })).toBeVisible();
  await section.getByText("Timeline coverage", { exact: true }).click();
  await expect(section.getByText("Projects · operational project activity", { exact: true })).toBeVisible();
  await expect(section.getByText("Projects · source record activity", { exact: true })).toBeVisible();
  expect(await section.getByRole("button", { name: /grant|authorize|invite/i }).count()).toBe(0);
  await page.setViewportSize({ width: 375, height: 850 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(376);
});

test("all applied filters survive refresh and browser history without exposing continuation state", async ({ page }) => {
  await fixture(page, (route, url) => route.fulfill({ json: timeline(url, [item("access-shortcut")]) }));
  await page.goto(`${clientPath}?panel=delivery`);
  const section = clientTimeline(page);
  await section.getByRole("button", { name: "View access history" }).click();
  await expect(page).toHaveURL(/panel=delivery.*audit\.active=1.*audit\.category=access/);
  await expect(section.getByRole("combobox", { name: "Category" })).toHaveValue("access");
  await expect(section.getByText("Alex Client", { exact: true })).toBeVisible();

  await section.getByRole("combobox", { name: "Actor" }).selectOption("staff");
  await section.getByRole("combobox", { name: "Result" }).selectOption("denied");
  await section.getByLabel("From date (UTC)").fill("2026-08-01");
  await section.getByLabel("To date (UTC)").fill("2026-08-26");
  await section.getByRole("button", { name: "Apply timeline filters" }).click();
  const appliedUrl = new URL(page.url());
  expect(Object.fromEntries(["panel", "audit.active", "audit.category", "audit.actor", "audit.result", "audit.from", "audit.to"]
    .map(key => [key, appliedUrl.searchParams.get(key)]))).toEqual({ panel: "delivery", "audit.active": "1",
      "audit.category": "access", "audit.actor": "staff", "audit.result": "denied",
      "audit.from": "2026-08-01", "audit.to": "2026-08-26" });
  expect(appliedUrl.searchParams.has("cursor")).toBe(false); expect(appliedUrl.searchParams.has("proof")).toBe(false);

  await page.reload();
  const refreshed = clientTimeline(page);
  await expect(refreshed.getByRole("combobox", { name: "Category" })).toHaveValue("access");
  await expect(refreshed.getByRole("combobox", { name: "Actor" })).toHaveValue("staff");
  await expect(refreshed.getByRole("combobox", { name: "Result" })).toHaveValue("denied");
  await expect(refreshed.getByLabel("From date (UTC)")).toHaveValue("2026-08-01");
  await expect(refreshed.getByLabel("To date (UTC)")).toHaveValue("2026-08-26");
  await expect(refreshed.getByText("Alex Client", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(376);
  expect((await refreshed.getByRole("button", { name: "View access history" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);

  await refreshed.getByRole("button", { name: "Reset timeline" }).click();
  await expect(page).toHaveURL(`${clientPath}?panel=delivery`);
  await expect(refreshed.getByText("Apply filters to load the timeline.", { exact: true })).toBeVisible();
  await page.goBack();
  await expect(refreshed.getByRole("combobox", { name: "Actor" })).toHaveValue("staff");
  await expect(refreshed.getByText("Alex Client", { exact: true })).toBeVisible();
  await page.goForward();
  await expect(refreshed.getByText("Apply filters to load the timeline.", { exact: true })).toBeVisible();
});
