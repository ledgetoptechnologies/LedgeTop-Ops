import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const VIEWER = "https://viewer.ledgetopdroneservices.com";
const date = "2026-10-20T12:00:00.000Z";
type Call = { method: string; path: string; key?: string; body: unknown };

function session(permissions: string[]) {
  return { user: { id: "staff-one", email: "staff@example.test", displayName: "Staff", status: "Active", profileType: "Employee",
    isAdministrator: false, permissions, divisions: [] }, csrfToken: "csrf", timezone: "America/Chicago", mapStyleUrl: null,
    mapboxPublicToken: null, units: { default: "imperial", resolved: "imperial" }, capabilities: {} };
}
const target = (workspaceId: string, workspaceName: string, sourceId = "project-alpha:primary") => ({ sourceId, workspaceId, workspaceName,
  projectPublicId: "pa-project-7", projectId: "project-7", projectName: "Seawall survey", clientName: "Coastal Engineering",
  generationId: "generation-3", sourceVersion: "2026-10-19T00:00:00.000Z" });
const model = (id: string, title: string) => ({ id, title, provider: "webodm", status: "ready", available: true,
  activeVersion: { id: `${id}-v1`, providerVersionId: "1", createdAt: date, updatedAt: date }, updatedAt: date });
const association = { id: "association-7", projectId: "project-7", projectAlphaProjectId: "pa-project-7", projectSourceVersion: "2026-10-19T00:00:00.000Z",
  projectName: "Seawall survey", clientName: "Coastal Engineering", viewerModelId: "model-seawall", viewerModelVersionId: "model-seawall-v1",
  viewerResourceVersion: "1", modelTitle: "Seawall orthomosaic", modelProvider: "webodm", modelStatus: "ready", state: "active", version: 1,
  createdAt: date, updatedAt: date, revokedAt: null };

async function record(route: Route, calls: Call[]) {
  const request = route.request(), url = new URL(request.url());
  const call = { method: request.method(), path: url.pathname + url.search, key: request.headers()["idempotency-key"], body: request.postData() ? JSON.parse(request.postData()!) : null };
  calls.push(call);
  return { request, url, call };
}

async function mockOps(page: Page, permissions: string[], handle: (url: URL, method: string, route: Route) => Promise<void> | undefined) {
  const calls: Call[] = [];
  await page.route("**/api/**", async route => {
    // Only Operations' own API; the cross-origin Viewer API has its own mock.
    if (new URL(route.request().url()).origin === VIEWER) return route.fallback();
    const { url, request } = await record(route, calls);
    if (url.pathname === "/api/session") return route.fulfill({ json: session(permissions) });
    const handled = handle(url, request.method(), route);
    if (handled) return handled;
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return calls;
}

/** The Viewer admin API: a session, a task list with two failed attempts and per-attempt diagnostics. */
async function mockViewer(context: BrowserContext, options: { recovery: Record<string, boolean>; recoverStatuses?: number[];
  providers?: Array<Record<string, unknown>>; providerStatuses?: number[]; patchStatuses?: number[] }) {
  const calls: Call[] = [];
  const statuses = [...(options.recoverStatuses ?? [202])];
  const providerStatuses = [...(options.providerStatuses ?? [201])], patchStatuses = [...(options.patchStatuses ?? [200])];
  const attempt = (id: string, taskId: string, number: number) => ({ id, taskId, datasetId: `dataset-${taskId}`, attemptNumber: number, providerId: "provider-1",
    providerTaskId: "upstream", presetId: null, options: {}, status: "failed", progress: 1, providerOutputCursor: null, capabilityFingerprint: null,
    errorCode: "ingest_failed", errorMessage: "The finished model couldn't be imported.", resultModelId: null, resultModelVersionId: null, createdBy: "ops:staff-one",
    createdAt: date, updatedAt: date, startedAt: date, upstreamCompletedAt: date, ingestedAt: null, completedAt: null, submissionPhase: null, uploadedFileCount: 120 });
  const tasks = [
    { id: "task-ben", projectId: "vp-1", datasetId: "dataset-task-ben", displayName: "Ben's ranch survey", status: "failed", activeAttemptId: "attempt-ben",
      latestAttempt: attempt("attempt-ben", "task-ben", 2), publishedModelId: null, description: null, metadata: {}, createdBy: "ops:staff-one", createdAt: date, updatedAt: date, archivedAt: null },
    { id: "task-other", projectId: "vp-1", datasetId: "dataset-task-other", displayName: "Barn roof inspection", status: "failed", activeAttemptId: "attempt-other",
      latestAttempt: attempt("attempt-other", "task-other", 1), publishedModelId: null, description: null, metadata: {}, createdBy: "ops:staff-one", createdAt: date, updatedAt: date, archivedAt: null },
  ];
  await context.route(`${VIEWER}/api/v1/**`, async original => {
    // The Viewer API is cross-origin: answer preflights and allow the Operations origin.
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, idempotency-key, accept",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE", "Access-Control-Expose-Headers": "retry-after, location" };
    if (original.request().method() === "OPTIONS") return original.fulfill({ status: 204, headers: cors });
    const route = { request: () => original.request(), fulfill: (response: Parameters<Route["fulfill"]>[0]) => original.fulfill({ ...response, headers: { ...cors, ...(response?.headers ?? {}) } }) } as Route;
    const { url, request } = await record(route, calls);
    const path = url.pathname;
    if (path === "/api/v1/admin-sessions/redeem") return route.fulfill({ json: { accessToken: "a".repeat(43),
      session: { id: "admin-session", subject: "ops:staff-one", permissions: ["viewer.processing.read", "viewer.processing.write"], expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
      units: { default: "imperial", resolved: "imperial" } } });
    if (path === "/api/v1/tasks") return route.fulfill({ json: { tasks, nextCursor: null } });
    const detail = /^\/api\/v1\/attempts\/([^/]+)$/.exec(path);
    if (detail) return route.fulfill({ json: { attempt: tasks.find(task => task.latestAttempt.id === detail[1])!.latestAttempt, logs: [] } });
    const diagnostics = /^\/api\/v1\/attempts\/([^/]+)\/diagnostics$/.exec(path);
    if (diagnostics) return route.fulfill({ json: { diagnostics: { recovery: { kind: "ingest", available: options.recovery[diagnostics[1]!] === true, remainingRequests: 3 } } } });
    if (/\/recover-ingest$/.test(path) && request.method() === "POST") {
      const status = statuses.shift() ?? 202;
      return route.fulfill({ status, json: status === 202 ? { attempt: { id: "attempt-ben", status: "ingesting" } } : { error: "temporarily_unavailable" } });
    }
    if (/\/retry$/.test(path) && request.method() === "POST") return route.fulfill({ status: 202, json: { attempt: { id: "attempt-other-2" } } });
    if (path === "/api/v1/processing/providers" && request.method() === "POST") {
      const status = providerStatuses.shift() ?? 201;
      return route.fulfill({ status, json: status === 201 ? { provider: { id: "provider-new" } } : { error: "invalid_request" } });
    }
    const providerPatch = /^\/api\/v1\/processing\/providers\/([^/]+)$/.exec(path);
    if (providerPatch && request.method() === "PATCH") {
      const body = JSON.parse(request.postData() || "{}"), provider = (options.providers ?? []).find(item => item.id === providerPatch[1]);
      // Mirrors Viewer: a provider-managed install refuses admissionLimit outright.
      if (provider?.dispatchMode === "provider_managed" && Object.hasOwn(body, "admissionLimit")) return route.fulfill({ status: 400, json: { error: "provider_dispatch_managed" } });
      const status = patchStatuses.shift() ?? 200;
      return route.fulfill({ status, json: status === 200 ? { provider: { ...provider, ...body } } : { error: "temporarily_unavailable" } });
    }
    if (path === "/api/v1/processing/providers") return route.fulfill({ json: { providers: options.providers ?? [], nextCursor: null } });
    if (path === "/api/v1/storage") return route.fulfill({ json: { storage: null, trash: { items: [], nextCursor: null, totalCount: 0, totalBytes: 0 } } });
    if (path === "/api/v1/processing/presets") return route.fulfill({ json: { presets: [] } });
    return route.fulfill({ json: { projects: [], datasets: [], outputs: [], providers: [], nextCursor: null, totalCount: 0, totalBytes: 0 } });
  });
  return calls;
}
const processingBootstrap = { enabled: true, viewerBaseUrl: VIEWER, permissions: ["viewer.processing.read", "viewer.processing.write", "viewer.providers.write"],
  units: { default: "imperial", resolved: "imperial" }, events: [] };
const grant = { grant: "g".repeat(43), grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800,
  redeemUrl: `${VIEWER}/api/v1/admin-sessions/redeem`, workspaceUrl: `${VIEWER}/workspace/${"g".repeat(43)}`, units: { default: "imperial", resolved: "imperial" } };
const processingRoutes = (url: URL, method: string, route: Route) => url.pathname === "/api/viewer/processing" ? route.fulfill({ json: processingBootstrap })
  : url.pathname === "/api/viewer/admin-grant" && method === "POST" ? route.fulfill({ status: 201, json: grant }) : undefined;

test("a processing notification link opens the attempt in the native Processing section with the advertised recovery", async ({ page, context }) => {
  const ops = await mockOps(page, ["viewer.view"], processingRoutes);
  const viewer = await mockViewer(context, { recovery: { "attempt-ben": true }, recoverStatuses: [503, 202] });
  await page.goto("/operations/processing?attemptId=attempt-ben");
  await expect(page.getByRole("navigation", { name: "3D Viewer sections" }).getByRole("button", { name: "Processing" })).toHaveAttribute("aria-current", "page");
  const review = page.locator(".ltds-card").filter({ has: page.getByRole("heading", { name: "Requested processing review" }) });
  await expect(review.getByRole("heading", { name: "Ben's ranch survey" })).toBeVisible();
  const recovery = review.getByRole("region", { name: "Model import recovery" });
  await expect(recovery).toContainText("doesn't reprocess");
  await recovery.getByRole("button", { name: "Recover model import" }).click();
  await expect(recovery.getByRole("alert")).toContainText("isn't confirmed");
  await recovery.getByRole("button", { name: "Retry same recovery" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Model import recovery started" })).toBeVisible();
  const recoveries = viewer.filter(call => call.path.endsWith("/attempts/attempt-ben/recover-ingest"));
  expect(recoveries).toHaveLength(2);
  expect(recoveries[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(recoveries[1]!.key).toBe(recoveries[0]!.key);
  expect(recoveries.every(call => JSON.stringify(call.body) === "{}")).toBe(true);
  expect(viewer.some(call => call.path.endsWith("/retry"))).toBe(false);
  expect(ops.some(call => call.path === "/api/viewer/processing")).toBe(true);
});

test("Retry never reprocesses an attempt whose finished import can be recovered", async ({ page, context }) => {
  await mockOps(page, ["viewer.view"], processingRoutes);
  const viewer = await mockViewer(context, { recovery: { "attempt-ben": true, "attempt-other": false } });
  await page.goto("/viewer/processing");
  await page.getByRole("navigation", { name: "Processing sections" }).getByRole("button", { name: "Tasks" }).click();
  const ben = page.locator("article").filter({ has: page.getByRole("heading", { name: "Ben's ranch survey" }) });
  await ben.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Recover the model import instead of reprocessing" })).toBeVisible();
  await expect(ben.getByRole("region", { name: "Model import recovery" })).toBeVisible();
  await expect(ben.getByRole("button", { name: "Retry" })).toHaveCount(0);
  expect(viewer.some(call => call.path.endsWith("/attempt-ben/retry"))).toBe(false);
  // Without an advertised recovery, Retry behaves as before.
  const other = page.locator("article").filter({ has: page.getByRole("heading", { name: "Barn roof inspection" }) });
  await other.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => viewer.filter(call => call.path.endsWith("/attempt-other/retry")).length).toBe(1);
  await expect(other.getByRole("region", { name: "Model import recovery" })).toHaveCount(0);
});

const nativeData = (associations: unknown[] = [association]) => ({ enabled: true,
  projects: [target("workspace-coastal", "Coastal Engineering"), target("workspace-harbor", "Harbor Authority")],
  models: [model("model-seawall", "Seawall orthomosaic"), model("model-ranch", "Ranch 3D mesh"), { ...model("model-busy", "Still processing"), status: "processing" }],
  associations });

test("staff link a ready model to a native client project with the exact returned target and a retained key", async ({ page }) => {
  let posts = 0;
  const ops = await mockOps(page, ["viewer.view", "viewer.manage"], (url, method, route) => {
    if (url.pathname === "/api/viewer/overview") return route.fulfill({ json: { enabled: false, viewerBaseUrl: null, overview: null } });
    if (url.pathname === "/api/viewer/native-associations" && method === "GET") return route.fulfill({ json: nativeData() });
    if (url.pathname === "/api/viewer/native-associations" && method === "POST") { posts += 1; return route.fulfill(posts === 1 ? { status: 503, json: { error: "Viewer unavailable" } } : { status: 201, json: { association, replayed: false } }); }
    return undefined;
  });
  await page.goto("/viewer");
  await page.getByRole("button", { name: "Client models" }).click();
  await expect(page).toHaveURL(/\/viewer\/models$/);
  const form = page.locator("form.viewer-association-form");
  await expect(form.getByRole("combobox", { name: "Model" }).locator("option", { hasText: "Still processing" })).toHaveCount(0);
  await form.getByRole("combobox", { name: "Client project" }).selectOption({ label: "Harbor Authority · Seawall survey" });
  await form.getByRole("combobox", { name: "Model" }).selectOption({ label: "Ranch 3D mesh" });
  await form.getByRole("button", { name: "Link model" }).click();
  await expect(page.getByRole("alert")).toContainText("isn't confirmed");
  await expect(form.getByRole("combobox", { name: "Client project" })).toBeDisabled();
  await form.getByRole("button", { name: "Retry same link" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Ranch 3D mesh is linked to Seawall survey" })).toBeVisible();
  const links = ops.filter(call => call.method === "POST" && call.path === "/api/viewer/native-associations");
  expect(links).toHaveLength(2);
  expect(links[1]!.key).toBe(links[0]!.key);
  const { workspaceName: _name, projectName: _project, clientName: _client, ...exact } = target("workspace-harbor", "Harbor Authority");
  expect(links[0]!.body).toEqual({ ...exact, viewerModelId: "model-ranch" });
  expect(links[1]!.body).toEqual(links[0]!.body);
});

test("an unconfirmed link can't be stranded by a refreshed catalog and retries exactly as sent", async ({ page }) => {
  let reads = 0, posts = 0;
  const ops = await mockOps(page, ["viewer.view", "viewer.manage"], (url, method, route) => {
    if (url.pathname === "/api/viewer/native-associations" && method === "GET") {
      reads += 1;
      // After the first read the project has a newer generation.
      return route.fulfill({ json: reads === 1 ? nativeData() : { ...nativeData(), projects: nativeData().projects.map(project => ({ ...project, generationId: "generation-4" })) } });
    }
    if (url.pathname === "/api/viewer/native-associations" && method === "POST") { posts += 1; return route.fulfill(posts === 1 ? { status: 503, json: { error: "Viewer unavailable" } } : { status: 201, json: { association, replayed: false } }); }
    return undefined;
  });
  await page.goto("/viewer/models");
  const form = page.locator("form.viewer-association-form");
  await form.getByRole("combobox", { name: "Client project" }).selectOption({ label: "Harbor Authority · Seawall survey" });
  await form.getByRole("combobox", { name: "Model" }).selectOption({ label: "Ranch 3D mesh" });
  await form.getByRole("button", { name: "Link model" }).click();
  await expect(form.getByRole("button", { name: "Retry same link" })).toBeEnabled();
  // A catalog read can't run while the link is unconfirmed, so it can't strand the retry.
  await expect(page.getByRole("button", { name: "Refresh" })).toBeDisabled();
  expect(reads).toBe(1);
  await form.getByRole("button", { name: "Retry same link" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Ranch 3D mesh is linked to Seawall survey" })).toBeVisible();
  const links = ops.filter(call => call.method === "POST" && call.path === "/api/viewer/native-associations");
  expect(links).toHaveLength(2);
  expect(links[1]!.key).toBe(links[0]!.key);
  expect(links[1]!.body).toEqual(links[0]!.body);
  expect((links[1]!.body as { generationId: string }).generationId).toBe("generation-3");
  // Afterwards the list is current again and a new link would use the newer generation.
  await expect(page.getByRole("button", { name: "Refresh" })).toBeEnabled();
  expect(reads).toBe(2);
});

test("a changed client project is reloaded and never substituted", async ({ page }) => {
  let reads = 0;
  const ops = await mockOps(page, ["viewer.view", "viewer.manage"], (url, method, route) => {
    if (url.pathname === "/api/viewer/native-associations" && method === "GET") { reads += 1; return route.fulfill({ json: reads === 1 ? nativeData() : { ...nativeData(), projects: [target("workspace-coastal", "Coastal Engineering")] } }); }
    if (url.pathname === "/api/viewer/native-associations" && method === "POST") return route.fulfill({ status: 409, json: { error: "Native client project changed or is unavailable" } });
    return undefined;
  });
  await page.goto("/viewer/models");
  const form = page.locator("form.viewer-association-form");
  await form.getByRole("combobox", { name: "Client project" }).selectOption({ label: "Harbor Authority · Seawall survey" });
  await form.getByRole("combobox", { name: "Model" }).selectOption({ label: "Ranch 3D mesh" });
  await form.getByRole("button", { name: "Link model" }).click();
  await expect(page.getByRole("alert")).toContainText("changed or is no longer available");
  await expect(form.getByRole("combobox", { name: "Client project" })).toHaveValue("");
  await expect(form.getByRole("combobox", { name: "Client project" }).locator("option", { hasText: "Harbor Authority" })).toHaveCount(0);
  expect(reads).toBe(2);
  expect(ops.filter(call => call.method === "POST")).toHaveLength(1);
});

test("a linked model opens for each client account it belongs to, and view-only staff can't link", async ({ page, context }) => {
  await mockOps(page, ["viewer.view"], (url, method, route) =>
    url.pathname === "/api/viewer/native-associations" && method === "GET" ? route.fulfill({ json: nativeData() }) : undefined);
  await page.goto("/viewer/models");
  await expect(page.getByRole("heading", { name: "Link a model to a client project" })).toHaveCount(0);
  const row = page.locator("article").filter({ has: page.getByRole("heading", { name: "Seawall orthomosaic" }) });
  await expect(row).toContainText("Coastal Engineering · Seawall survey");
  const popup = context.waitForEvent("page");
  await row.getByRole("button", { name: "Open for Harbor Authority" }).click();
  const opened = await popup;
  await expect.poll(() => opened.url()).toContain("/viewer/session/native/association-7/model-seawall?");
  const query = new URL(opened.url()).searchParams;
  expect(Object.fromEntries(query)).toEqual({ sourceId: "project-alpha:primary", workspaceId: "workspace-harbor", projectPublicId: "pa-project-7",
    projectId: "project-7", generationId: "generation-3", sourceVersion: "2026-10-19T00:00:00.000Z" });
});

test("the native model shell opens a session only for its exact target", async ({ page }) => {
  const bodies: unknown[] = [];
  await page.context().route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: { csrfToken: "csrf-native" } });
    if (path === "/api/viewer/native-associations/association-7/session" && request.method() === "POST") {
      bodies.push(JSON.parse(request.postData() || "null"));
      return route.fulfill({ status: 201, json: { modelId: "model-seawall", grant: "11111111-1111-4111-8111-111111111111",
        grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800,
        redeemUrl: `${VIEWER}/api/v1/sessions/redeem`, embedUrl: `${VIEWER}/session/11111111-1111-4111-8111-111111111111` } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.context().route(`${VIEWER}/**`, route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Viewer</title>" }));
  const { workspaceName: _name, projectName: _project, clientName: _client, ...exact } = target("workspace-harbor", "Harbor Authority");
  await page.goto(`/viewer/session/native/association-7/model-seawall?${new URLSearchParams(exact).toString()}`);
  await expect(page.locator("iframe")).toHaveAttribute("src", `${VIEWER}/session/11111111-1111-4111-8111-111111111111`);
  expect(bodies).toEqual([exact]);
});

for (const width of [320, 390]) test(`the Viewer page sections fit ${width}px without horizontal scrolling`, async ({ page, context }) => {
  await page.setViewportSize({ width, height: 844 });
  await mockOps(page, ["viewer.view", "viewer.manage"], (url, method, route) =>
    url.pathname === "/api/viewer/native-associations" && method === "GET" ? route.fulfill({ json: nativeData() }) : processingRoutes(url, method, route));
  await mockViewer(context, { recovery: { "attempt-ben": true } });
  for (const path of ["/viewer/models", "/operations/processing?attemptId=attempt-ben"]) {
    await page.goto(path);
    await expect(page.getByRole("navigation", { name: "3D Viewer sections" })).toBeVisible();
    await expect(page.locator(".viewer-association-list, .viewer-ingest-recovery").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

const provider = (id: string, displayName: string, extra: Record<string, unknown>) => ({ id, displayName, type: "nodeodm", endpoint: `https://${id}.example.test`,
  enabled: false, activeAttempts: 0, credential: { configured: true, updatedAt: date }, capabilities: null, capabilityFingerprint: null,
  lastHealth: "healthy", lastHealthAt: date, createdAt: date, updatedAt: date, ...extra });
// Production Viewer reports and accepts an admission limit; staging reports provider-managed dispatch and rejects it.
const providerShapes = [provider("legacy", "Production NodeODM", { admissionLimit: 4 }),
  provider("managed", "Staging ClusterODM", { type: "clusterodm", dispatchMode: "provider_managed", submissionConcurrency: 1 })];
async function openProviders(page: Page) {
  await page.goto("/viewer/processing");
  await page.getByRole("navigation", { name: "Processing sections" }).getByRole("button", { name: "Providers" }).click();
}

test("a new provider sends only the fields Viewer accepts, and a refused request can be corrected and sent again", async ({ page, context }) => {
  await mockOps(page, ["viewer.view"], processingRoutes);
  const viewer = await mockViewer(context, { recovery: {}, providers: providerShapes, providerStatuses: [400, 201] });
  await openProviders(page);
  const form = page.locator("form.viewer-processing-form");
  await expect(form.getByRole("combobox", { name: "Type" })).toHaveCount(0);
  await form.getByLabel("Name").fill("Field NodeODM");
  await form.getByLabel("HTTPS or private endpoint").fill("https://odm.example.test");
  await form.getByLabel("Provider token (optional)").fill("p".repeat(40));
  await form.getByRole("button", { name: "Add disabled provider" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "invalid_request" })).toBeVisible();
  // The token is cleared after every attempt; the operator re-enters it to try again.
  await expect(form.getByLabel("Provider token (optional)")).toHaveValue("");
  await form.getByLabel("Provider token (optional)").fill("q".repeat(40));
  await form.getByRole("button", { name: "Add disabled provider" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Provider credential stored" })).toBeVisible();
  const creates = viewer.filter(call => call.method === "POST" && call.path === "/api/v1/processing/providers");
  expect(creates.map(call => call.body)).toEqual([
    { displayName: "Field NodeODM", endpoint: "https://odm.example.test", credential: { token: "p".repeat(40) } },
    { displayName: "Field NodeODM", endpoint: "https://odm.example.test", credential: { token: "q".repeat(40) } }]);
});

test("provider settings follow each install: a legacy admission limit stays editable, provider-managed admission is never sent", async ({ page, context }) => {
  await mockOps(page, ["viewer.view"], processingRoutes);
  const viewer = await mockViewer(context, { recovery: {}, providers: providerShapes, patchStatuses: [200, 503, 200] });
  await openProviders(page);
  const legacy = page.locator("article.viewer-provider-card").filter({ has: page.getByRole("heading", { name: "Production NodeODM" }) });
  const managed = page.locator("article.viewer-provider-card").filter({ has: page.getByRole("heading", { name: "Staging ClusterODM" }) });
  await expect(legacy).toContainText("admission limit 4");
  await expect(managed).toContainText("admission managed by the provider");
  await legacy.getByText("Edit provider settings").click();
  await legacy.getByLabel("Admission limit").fill("6");
  await legacy.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Provider settings saved" })).toBeVisible();
  await managed.getByText("Edit provider settings").click();
  await expect(managed.getByLabel("Admission limit")).toHaveCount(0);
  await expect(managed).toContainText("The provider manages job admission");
  await managed.getByLabel("Name").fill("Staging ClusterODM pool");
  await managed.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "temporarily_unavailable" })).toBeVisible();
  await managed.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Provider settings saved" })).toBeVisible();
  const patches = viewer.filter(call => call.method === "PATCH" && call.path.startsWith("/api/v1/processing/providers/"));
  expect(patches.map(call => [call.path, call.body])).toEqual([
    ["/api/v1/processing/providers/legacy", { displayName: "Production NodeODM", endpoint: "https://legacy.example.test", admissionLimit: 6 }],
    ["/api/v1/processing/providers/managed", { displayName: "Staging ClusterODM pool", endpoint: "https://managed.example.test" }],
    ["/api/v1/processing/providers/managed", { displayName: "Staging ClusterODM pool", endpoint: "https://managed.example.test" }]]);
});
