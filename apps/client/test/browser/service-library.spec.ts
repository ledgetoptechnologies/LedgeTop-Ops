import { expect, test, type Page, type Route } from "@playwright/test";
import type { PortalServiceCatalogItem, PortalServiceDraft } from "../../src/client/portal-api";

const mapping: PortalServiceCatalogItem = { publicId: "map", sourceVersion: "v1", name: "Site mapping", category: "Mapping & survey", summary: "Current site documentation.", displayOrder: 1, geometryRequirement: "optional", questions: [{ id: "notes", label: "Mapping requirements", type: "text", required: false, helpText: null, maxLength: 1000 }] };
const photos: PortalServiceCatalogItem = { publicId: "photos", sourceVersion: "v1", name: "Progress photography", category: "Photography", summary: "Scheduled progress photos.", displayOrder: 2, geometryRequirement: "none", questions: [{ id: "count", label: "Visit count", type: "number", required: false, helpText: null, minimum: 1, maximum: 30 }] };
const catalog = [mapping, photos];
const project = { id: "project-a", externalRef: "A1", clientName: "Acme", projectName: "North Site", canRequestService: true, status: "active", summary: null, siteAddress: null, serviceAddress: null, projectContactName: null, projectContactEmail: null, projectContactPhone: null, nextMilestone: null, lastUpdateAt: null };
const pageOf = (services = catalog, nextCursor: string | null = null, sequence = 1) => ({ services, nextCursor, complete: nextCursor === null, source: { generation: "generation-a", sequence } });
function readiness(projectId: string | null, options: { allowed?: boolean; root?: boolean; supported?: boolean; reason?: string; mode?: string; workspaceId?: string | null } = {}) {
  const root = options.root ?? true, allowed = options.allowed ?? (projectId ? true : root);
  return { mode: options.mode || "catalog", workspaceId: options.workspaceId ?? null, target: { kind: projectId ? "project" : "root", projectId }, canStartRequest: allowed, reason: options.reason || (allowed ? "ready" : "request_not_permitted"), root: { canStartRequest: root, reason: root ? "ready" : "request_not_permitted" }, projectRequestsSupported: options.supported ?? true, refreshedAt: "2026-08-25T12:00:00.000Z" };
}
function draftOf(services = [mapping], answers: Record<string, Record<string, unknown>> = {}): PortalServiceDraft {
  return { id: "draft-library", state: "draft", version: 1, projectId: null, requestType: "service", title: "Saved request", details: "Saved scope", location: null, preferredStartAt: null, deliverables: null, siteContactName: null, siteContactEmail: null, siteContactPhone: null, desiredCompletionAt: null, latitude: null, longitude: null, areaGeoJson: null, poiPoints: [], areaSquareMeters: null, areaAcres: null, services: services.map(service => ({ ...service, answers: answers[service.publicId] || {} })), submittedRequestId: null, createdAt: "2026-08-25T12:00:00.000Z", updatedAt: "2026-08-25T12:00:00.000Z" };
}
async function fixture(page: Page, options: { services?: PortalServiceCatalogItem[]; draft?: PortalServiceDraft; root?: boolean; supported?: boolean; mode?: string; handler?: (route: Route, url: URL) => Promise<boolean> } = {}) {
  const writes: Array<Record<string, any>> = [], calls: string[] = [];
  let saved = options.draft || draftOf([]);
  await page.route("**/api/client/**", async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    calls.push(`${req.method()} ${url.pathname}${url.search}`);
    if (await options.handler?.(route, url)) return;
    if (path === "/api/client/session") return route.fulfill({ json: { account: { id: "account-a", displayName: "Acme" }, capabilities: { requestV2: options.mode !== "legacy", requestAttachments: false } } });
    if (path === "/api/client/projects") return route.fulfill({ json: { projects: [project] } });
    if (path === "/api/client/service-requests") return route.fulfill({ json: { requests: [] } });
    if (path === "/api/client/map-config") return route.fulfill({ json: { mapboxPublicToken: null } });
    if (path === "/api/client/notifications") return route.fulfill({ json: { notifications: [], unreadCount: 0, cursor: null } });
    if (path === "/api/client/request-readiness") return route.fulfill({ json: readiness(url.searchParams.get("projectId"), { root: options.root, supported: options.supported, mode: options.mode }) });
    if (path === "/api/client/service-catalog/page") return route.fulfill({ json: pageOf(options.services || catalog) });
    if (path === "/api/client/service-catalog") return route.fulfill({ json: { services: options.services || catalog } });
    if (path.endsWith("/pricing-hint")) return route.fulfill({ json: { available: false, hint: null } });
    if (path === "/api/client/service-request-drafts" && req.method() === "GET") return route.fulfill({ json: { drafts: options.draft ? [{ id: saved.id, projectId: saved.projectId, title: saved.title, serviceNames: saved.services.map(s => s.name), areaAcres: null, updatedAt: saved.updatedAt }] : [] } });
    if (path === `/api/client/service-request-drafts/${saved.id}` && req.method() === "GET") return route.fulfill({ json: { draft: saved } });
    if (path.startsWith("/api/client/service-request-drafts") && ["POST", "PUT"].includes(req.method())) {
      const body = req.postDataJSON(); writes.push(body);
      saved = { ...saved, ...body, version: saved.version + 1, services: body.services.map((selected: { publicId: string; sourceVersion: string; answers: Record<string, unknown> }) => ({ ...(options.services || catalog).find(service => service.publicId === selected.publicId)!, ...selected })) };
      return route.fulfill({ json: { draft: saved } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return { writes, calls };
}
async function start(page: Page, scope = "general") {
  await page.goto("/portal/requests/new");
  await page.getByLabel("Request context", { exact: true }).selectOption(scope);
  await page.getByRole("button", { name: "Start request", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Choose a category" })).toBeVisible();
}
async function selectMapping(page: Page) {
  await page.getByRole("button", { name: "Mapping & survey 1 service", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select Site mapping", exact: true }).check();
}

test("categories are the initial view and cross-category search preserves selected answers and saved versions", async ({ page }) => {
  const state = await fixture(page);
  await start(page);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await selectMapping(page);
  await page.getByLabel("Mapping requirements").fill("Keep the north boundary.");
  await expect(page.getByText("Draft saved", { exact: true })).toBeVisible();
  const savedCount = state.writes.length;
  await page.getByRole("button", { name: "All categories", exact: true }).click();
  await page.getByRole("button", { name: "Photography 1 service", exact: true }).click();
  await expect(page.getByLabel("Mapping requirements")).toHaveValue("Keep the north boundary.");
  await page.getByLabel("Search all services").fill("nothing matches");
  await page.getByRole("button", { name: "Search services", exact: true }).click();
  await expect(page.getByText("No services match this selection.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Mapping requirements")).toHaveValue("Keep the north boundary.");
  await page.waitForTimeout(800);
  expect(state.writes).toHaveLength(savedCount);
  await page.reload();
  await expect(page.getByLabel("Mapping requirements")).toHaveValue("Keep the north boundary.");
  await expect(page.getByRole("heading", { name: "Results for “nothing matches”" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Photography", exact: true })).toBeVisible();
  await expect(page.getByLabel("Mapping requirements")).toHaveValue("Keep the north boundary.");
});

test("incomplete catalog pages never call an unloaded saved service unpublished and continuation failures retry the same cursor", async ({ page }) => {
  let continuation = 0;
  await fixture(page, { draft: draftOf([photos], { photos: { count: 7 } }), handler: async (route, url) => {
    if (url.pathname !== "/api/client/service-catalog/page") return false;
    if (!url.search) await route.fulfill({ json: pageOf([mapping], "page-2") });
    else { continuation += 1; expect(url.searchParams.get("cursor")).toBe("page-2"); await route.fulfill(continuation === 1 ? { status: 503, json: { error: "Temporary read issue" } } : { json: pageOf([]) }); }
    return true;
  } });
  await page.goto("/portal/requests/new?draft=draft-library");
  await expect(page.getByLabel("Visit count")).toHaveValue("7");
  await expect(page.getByText(/not in the loaded services yet/)).toBeVisible();
  await expect(page.getByText(/no longer available in the current library/)).toHaveCount(0);
  await page.getByRole("button", { name: "Load more services", exact: true }).click();
  await expect(page.getByText(/More services could not be loaded/)).toBeVisible();
  await page.getByRole("button", { name: "Retry loading more services", exact: true }).click();
  await expect(page.getByText(/no longer available in the current library/)).toBeVisible();
  await expect(page.getByLabel("Visit count")).toHaveValue("7");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText(/resolve every changed or unavailable selection/)).toBeVisible();
});

test("a checkpoint change clears published pages but keeps selected questions until explicit current-version acknowledgement", async ({ page }) => {
  let changed = false;
  const current = { ...mapping, sourceVersion: "v2", questions: [{ id: "new", label: "Current requirements", type: "text" as const, required: false, helpText: null, maxLength: 1000 }] };
  await fixture(page, { draft: draftOf([mapping], { map: { notes: "Saved answer" } }), handler: async (route, url) => {
    if (url.pathname !== "/api/client/service-catalog/page") return false;
    if (url.search) { changed = true; await route.fulfill({ status: 409, json: { code: "catalog_changed", error: "Changed" } }); }
    else await route.fulfill({ json: changed ? pageOf([current], null, 2) : pageOf([mapping], "next") });
    return true;
  } });
  await page.goto("/portal/requests/new?draft=draft-library");
  await page.getByRole("button", { name: "Load more services", exact: true }).click();
  await expect(page.getByText(/The service library changed. Refresh it/)).toBeVisible();
  await expect(page.getByLabel("Mapping requirements")).toHaveValue("Saved answer");
  await page.getByRole("button", { name: "Retry service library", exact: true }).click();
  await expect(page.getByText("This service changed in Project Alpha.")).toBeVisible();
  await expect(page.getByLabel("Current requirements")).toHaveCount(0);
  await page.getByRole("button", { name: "Use current service version", exact: true }).click();
  await expect(page.getByLabel("Current requirements")).toHaveValue("");
  await expect(page.getByLabel("Mapping requirements")).toHaveCount(0);
});

test("project-only users choose an exact authorized target before any catalog read or autosave", async ({ page }) => {
  const state = await fixture(page, { root: false });
  await page.goto("/portal/requests/new");
  await expect(page.getByLabel("Request context", { exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "New or one-off service" })).toHaveCount(0);
  expect(state.calls.some(call => call.includes("service-catalog"))).toBe(false);
  expect(state.writes).toHaveLength(0);
  await page.getByLabel("Request context", { exact: true }).selectOption("project:project-a");
  await page.getByRole("button", { name: "Start request", exact: true }).click();
  await selectMapping(page);
  await expect.poll(() => state.writes.length).toBeGreaterThan(0);
  expect(state.writes.every(body => body.projectId === "project-a")).toBe(true);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Project context", { exact: true })).toHaveCount(0);
});

test("unavailable readiness hides new-request actions and a direct URL never mounts a draft form", async ({ page }) => {
  const state = await fixture(page, { handler: async (route, url) => {
    if (url.pathname !== "/api/client/request-readiness") return false;
    await route.fulfill({ json: { ...readiness(null, { allowed: false, root: false, supported: false, reason: "catalog_unavailable" }), root: { canStartRequest: false, reason: "catalog_unavailable" } } }); return true;
  } });
  await page.goto("/portal/requests");
  await expect(page.getByText(/service library is not ready/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit new request" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Request history", exact: true })).toBeVisible();
  await page.goto("/portal/requests/new");
  await expect(page.getByText(/service library is not ready/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "What services do you need?" })).toHaveCount(0);
  expect(state.calls.some(call => call.includes("service-catalog"))).toBe(false);
  expect(state.writes).toHaveLength(0);
});

test("legacy project-only access starts only in its permitted project and does not request the catalog", async ({ page }) => {
  const state = await fixture(page, { root: false, mode: "legacy" });
  await page.goto("/portal/requests/new");
  await expect(page.getByRole("option", { name: "New or one-off service" })).toHaveCount(0);
  await page.getByLabel("Request context", { exact: true }).selectOption("project:project-a");
  await page.getByRole("button", { name: "Start request", exact: true }).click();
  await expect(page.getByLabel("Service request title")).toBeVisible();
  await expect(page.getByLabel("Project context", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "What services do you need?" })).toHaveCount(0);
  expect(state.calls.some(call => call.includes("service-catalog"))).toBe(false);
  expect(state.writes).toHaveLength(0);
});

test("a saved draft never silently moves to another context when its project is no longer available", async ({ page }) => {
  const saved = { ...draftOf([mapping]), projectId: "removed-project" };
  const state = await fixture(page, { draft: saved });
  await page.goto("/portal/requests/new?draft=draft-library&request_scope=general");
  await expect(page.getByText(/Saved drafts have not been moved to another project/)).toBeVisible();
  expect(state.writes).toHaveLength(0);
  expect(state.calls.some(call => call.includes("service-catalog"))).toBe(false);
});

test("saved answers remain read-only when every service is unavailable, without autosave or submission", async ({ page }) => {
  const state = await fixture(page, { draft: draftOf([mapping], { map: { notes: "Preserve my saved north boundary" } }), handler: async (route, url) => {
    if (url.pathname !== "/api/client/request-readiness") return false;
    await route.fulfill({ json: readiness(null, { allowed: false, root: false, supported: false, reason: "catalog_unavailable" }) }); return true;
  } });
  await page.goto("/portal/requests/new?draft=draft-library");
  await expect(page.getByRole("heading", { name: "Saved draft — read only" })).toBeVisible();
  await expect(page.getByText("Preserve my saved north boundary")).toBeVisible();
  await expect(page.getByText("Saved scope", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check availability again" })).toBeVisible();
  await expect(page.locator(".portal-request-wizard")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Submit request", exact: true })).toHaveCount(0);
  expect(state.calls.some(call => call.includes("service-catalog"))).toBe(false);
  expect(state.writes).toHaveLength(0);
});

for (const [reason, message] of [
  ["no_services_assigned", "No services are currently assigned"],
  ["service_assignments_unavailable", "Assigned services cannot be verified"],
] as const) test(`assignment readiness ${reason} preserves a saved draft read only`, async ({ page }) => {
  const state = await fixture(page, { draft: draftOf([mapping], { map: { notes: "Keep this saved answer" } }), handler: async (route, url) => {
    if (url.pathname !== "/api/client/request-readiness") return false;
    await route.fulfill({ json: readiness(null, { allowed: false, root: false, supported: false, reason }) }); return true;
  } });
  await page.goto("/portal/requests/new?draft=draft-library");
  await expect(page.getByText(new RegExp(message))).toBeVisible();
  await expect(page.getByRole("heading", { name: "Saved draft — read only" })).toBeVisible();
  await expect(page.getByText("Keep this saved answer")).toBeVisible();
  expect(state.calls.some(call => call.includes("service-catalog"))).toBe(false);
  expect(state.writes).toHaveLength(0);
});

test("denied saved-draft reads do not expose snapshots while readiness is unavailable", async ({ page }) => {
  const state = await fixture(page, { draft: draftOf([mapping]), handler: async (route, url) => {
    if (url.pathname === "/api/client/request-readiness") { await route.fulfill({ json: readiness(null, { allowed: false, root: false, supported: false, reason: "catalog_unavailable" }) }); return true; }
    if (url.pathname === "/api/client/service-request-drafts/draft-library") { await route.fulfill({ status: 403, json: { error: "Denied" } }); return true; }
    return false;
  } });
  await page.goto("/portal/requests/new?draft=draft-library");
  await expect(page.getByText(/This saved draft could not be opened/)).toBeVisible();
  await expect(page.getByText("Saved scope", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Saved draft — read only" })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});

test("a readiness response for a different project cannot start the selected request", async ({ page }) => {
  const state = await fixture(page, { handler: async (route, url) => {
    if (url.pathname !== "/api/client/request-readiness" || !url.search) return false;
    await route.fulfill({ json: readiness("other-project") }); return true;
  } });
  await page.goto("/portal/requests/new");
  await page.getByLabel("Request context", { exact: true }).selectOption("project:project-a");
  await expect(page.getByText(/Request availability could not be verified/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Start request", exact: true })).toBeDisabled();
  expect(state.calls.some(call => call.includes("service-catalog"))).toBe(false);
  expect(state.writes).toHaveLength(0);
});

test("an authorized saved read never substitutes for failed current readiness authorization", async ({ page }) => {
  await fixture(page, { draft: draftOf([mapping], { map: { notes: "Do not resurface this answer" } }), handler: async (route, url) => {
    if (url.pathname !== "/api/client/request-readiness") return false;
    await route.fulfill({ status: 403, json: { error: "Access changed" } }); return true;
  } });
  await page.goto("/portal/requests/new?draft=draft-library");
  await expect(page.getByText(/Request availability could not be verified/)).toBeVisible();
  await expect(page.getByText("Do not resurface this answer")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Saved draft — read only" })).toHaveCount(0);
});

test("a delayed autosave cannot rewrite the URL or start queued saves after leaving the wizard", async ({ page }) => {
  let complete: (() => void) | undefined, creates = 0, updates = 0;
  await fixture(page, { handler: async (route, url) => {
    if (url.pathname === "/api/client/service-request-drafts" && route.request().method() === "POST") {
      creates += 1;
      await new Promise<void>(resolve => { complete = resolve; });
      await route.fulfill({ json: { draft: draftOf([mapping]) } }); return true;
    }
    if (url.pathname.startsWith("/api/client/service-request-drafts/") && route.request().method() === "PUT") updates += 1;
    return false;
  } });
  await start(page); await selectMapping(page);
  await expect.poll(() => creates).toBe(1);
  await page.getByLabel("Mapping requirements").fill("Queued newer answer");
  await page.waitForTimeout(850);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(/\/portal\/requests$/);
  complete!();
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/portal\/requests$/);
  expect(creates).toBe(1); expect(updates).toBe(0);
});

test("only typed uninitialized-catalog errors allow a bounded legacy fallback without declaring missing selections unpublished", async ({ page }) => {
  await fixture(page, { services: [mapping], draft: draftOf([photos], { photos: { count: 3 } }), handler: async (route, url) => {
    if (url.pathname !== "/api/client/service-catalog/page") return false;
    await route.fulfill({ status: 503, json: { code: "catalog_not_ready", error: "Not initialized" } }); return true;
  } });
  await page.goto("/portal/requests/new?draft=draft-library");
  await expect(page.getByText(/Showing available legacy services \(up to 500\)/)).toBeVisible();
  await expect(page.getByText(/not in the loaded services yet/)).toBeVisible();
  await expect(page.getByText(/no longer available in the current library/)).toHaveCount(0);
  await expect(page.getByLabel("Visit count")).toHaveValue("3");
});

for (const status of [403, 503]) test(`catalog ${status} without the typed compatibility code never falls back`, async ({ page }) => {
  const state = await fixture(page, { handler: async (route, url) => {
    if (url.pathname !== "/api/client/service-catalog/page") return false;
    await route.fulfill({ status, json: { error: "Unavailable" } }); return true;
  } });
  await page.goto("/portal/requests/new");
  await page.getByLabel("Request context", { exact: true }).selectOption("general");
  await page.getByRole("button", { name: "Start request", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry service library" })).toBeVisible();
  expect(state.calls).not.toContain("GET /api/client/service-catalog");
});

test("selection is limited to ten unique services and only explicit removal clears its answers", async ({ page }) => {
  const many = Array.from({ length: 11 }, (_, index) => ({ ...mapping, publicId: `service-${index}`, name: `Service ${index + 1}`, questions: [] }));
  const state = await fixture(page, { services: many });
  await start(page);
  await page.getByRole("button", { name: "Mapping & survey 11 services" }).click();
  for (let index = 1; index <= 10; index += 1) await page.getByRole("checkbox", { name: `Select Service ${index}`, exact: true }).check();
  await expect(page.getByRole("checkbox", { name: "Select Service 11", exact: true })).toBeDisabled();
  await expect(page.getByText("10 of 10 services selected")).toBeVisible();
  await page.getByRole("button", { name: "Remove Service 1", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select Service 11", exact: true }).check();
  await expect.poll(() => state.writes.at(-1)?.services?.length).toBe(10);
  expect(new Set(state.writes.at(-1)?.services.map((item: { publicId: string }) => item.publicId)).size).toBe(10);
});

test("category and selected-question layouts remain usable by keyboard on mobile, narrow, laptop and ultrawide", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await fixture(page, { services: [{ ...mapping, name: "Site mapping and photogrammetric documentation for large regional development projects" }, photos] });
  await start(page);
  const category = page.getByRole("button", { name: "Mapping & survey 1 service", exact: true });
  await category.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Mapping & survey", exact: true })).toBeFocused();
  await page.getByRole("checkbox", { name: /Select Site mapping/ }).check();
  await page.getByLabel("Mapping requirements").fill("Preserve this answer while browsing and reflowing.");
  for (const width of [375, 640, 1280, 3440]) {
    await page.setViewportSize({ width, height: 960 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    for (const button of await page.locator(".portal-service-library button:visible").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(43);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`service-library-${width}.png`), fullPage: true });
  }
  expect(pageErrors).toEqual([]);
});
