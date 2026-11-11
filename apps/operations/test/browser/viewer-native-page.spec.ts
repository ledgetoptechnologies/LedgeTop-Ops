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
async function mockViewer(context: BrowserContext, options: { recovery: Record<string, boolean>; recoverStatuses?: number[] }) {
  const calls: Call[] = [];
  const statuses = [...(options.recoverStatuses ?? [202])];
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
    if (path === "/api/v1/storage") return route.fulfill({ json: { storage: null, trash: { items: [], nextCursor: null, totalCount: 0, totalBytes: 0 } } });
    if (path === "/api/v1/processing/presets") return route.fulfill({ json: { presets: [] } });
    return route.fulfill({ json: { projects: [], datasets: [], outputs: [], providers: [], nextCursor: null, totalCount: 0, totalBytes: 0 } });
  });
  return calls;
}
const processingBootstrap = { enabled: true, viewerBaseUrl: VIEWER, permissions: ["viewer.processing.read", "viewer.processing.write"],
  units: { default: "imperial", resolved: "imperial" }, events: [] };
const grant = { grant: "g".repeat(43), grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800,
  redeemUrl: `${VIEWER}/api/v1/admin-sessions/redeem`, workspaceUrl: `${VIEWER}/workspace/${"g".repeat(43)}`, units: { default: "imperial", resolved: "imperial" } };
const processingRoutes = (url: URL, method: string, route: Route) => url.pathname === "/api/viewer/processing" ? route.fulfill({ json: processingBootstrap })
  : url.pathname === "/api/viewer/admin-grant" && method === "POST" ? route.fulfill({ status: 201, json: grant }) : undefined;

test("a processing notification link still opens the attempt review with the advertised recovery", async ({ page, context }) => {
  const ops = await mockOps(page, ["viewer.view"], processingRoutes);
  const viewer = await mockViewer(context, { recovery: { "attempt-ben": true }, recoverStatuses: [503, 202] });
  await page.goto("/operations/processing?attemptId=attempt-ben");
  await expect(page).toHaveURL(/\/operations\/processing\?attemptId=attempt-ben$/);
  await expect(page.getByRole("link", { name: "Back to 3D models" })).toHaveAttribute("href", "/viewer");
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
  await page.goto("/viewer/processing?attemptId=attempt-other");
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

test("the native model shell opens a session only for its exact target", async ({ page }) => {
  const bodies: unknown[] = [];
  await page.context().route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: { ...session(["viewer.view"]), csrfToken: "csrf-native" } });
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

test("a stale native target is denied without iframe navigation or legacy association fallback", async ({ page }) => {
  const bodies: unknown[] = [];
  const sessionPaths: string[] = [];
  await page.context().route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: { ...session(["viewer.view"]), csrfToken: "csrf-native-stale" } });
    if (path === "/api/viewer/native-associations/association-7/session" && request.method() === "POST") {
      sessionPaths.push(path);
      bodies.push(JSON.parse(request.postData() || "null"));
      return route.fulfill({ status: 409, json: { error: "The native project target changed. Review the current target and try again." } });
    }
    if (path === "/api/viewer/associations/association-7/session") {
      sessionPaths.push(path);
      return route.fulfill({ status: 201, json: { modelId: "model-seawall", grant: "11111111-1111-4111-8111-111111111111",
        grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800,
        redeemUrl: `${VIEWER}/api/v1/sessions/redeem`, embedUrl: `${VIEWER}/session/11111111-1111-4111-8111-111111111111` } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  const { workspaceName: _name, projectName: _project, clientName: _client, ...exact } = target("workspace-harbor", "Harbor Authority");
  const query = new URLSearchParams(exact).toString();
  await page.goto(`/viewer/session/native/association-7/model-seawall?${query}`);
  await expect(page.getByRole("alert")).toContainText("native project target changed");
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(sessionPaths).toEqual(["/api/viewer/native-associations/association-7/session"]);
  expect(bodies).toEqual([exact]);
  expect(page.url()).not.toContain("grant=");
});

const overview = (failed = 0, observationWarnings?: number) => ({ enabled: true, viewerBaseUrl: VIEWER, overview: { generatedAt: date,
  projects: { active: 1, total: 1 }, models: { published: 1, total: 1, bytes: 0 },
  jobs: { queued: 0, running: 2, reviewReady: 0, failed, ...(observationWarnings === undefined ? {} : { observationWarnings }) }, providers: { enabled: 1, healthy: 1, total: 1 },
  storage: { usedBytes: 0, availableBytes: null }, platform: { ready: true, workerLive: true, lifecycleBlocked: false } } });

for (const width of [320, 390]) test(`the 3D models page and attempt review fit ${width}px without horizontal scrolling`, async ({ page, context }) => {
  await page.setViewportSize({ width, height: 844 });
  await mockOps(page, ["viewer.view", "viewer.manage"], (url, method, route) =>
    url.pathname === "/api/viewer/overview" ? route.fulfill({ json: overview() })
      : url.pathname === "/api/viewer/direct-share-catalog" ? route.fulfill({ json: { projects: [{ viewerProjectId: "vp-1",
        name: "A very long Viewer project name for the Seawall and Harbor survey", publishedTaskCount: 3, updatedAt: date }], nextCursor: null } })
        : processingRoutes(url, method, route));
  await mockViewer(context, { recovery: { "attempt-ben": true } });
  await page.goto("/viewer");
  await expect(page.getByRole("list", { name: "Viewer projects" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto("/operations/processing?attemptId=attempt-ben");
  await expect(page.locator(".viewer-ingest-recovery").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("authenticated model routes retain Operations navigation through denied sessions and browser Back", async ({ page }) => {
  await mockOps(page, ["viewer.view", "operations.view"], (url, method, route) =>
    url.pathname === "/api/viewer/associations/association-one/session" && method === "POST"
      ? route.fulfill({ status: 403, json: { error: "Model is unavailable" } })
      : undefined);
  await page.goto("/viewer/session/association-one/model-one");
  await expect(page.locator(".ops-header")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Secure 3D Viewer" })).toBeVisible();
  const nav = page.getByRole("navigation", { name: /^(Primary navigation|Mobile primary navigation)$/ });
  if (!(await nav.first().isVisible())) await page.getByRole("button", { name: "Open navigation" }).click();
  await nav.locator('a[href="/operations"]:visible').click();
  await expect(page).toHaveURL(/\/operations$/);
  await expect(page.getByRole("heading", { name: "Secure 3D Viewer" })).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Secure 3D Viewer" })).toBeVisible();
});


test("failed processing totals open the Viewer workspace, which owns processing", async ({ page, context }) => {
  const ops = await mockOps(page, ["viewer.view"], (url, method, route) => url.pathname === "/api/viewer/overview"
    ? route.fulfill({ json: overview(2) }) : processingRoutes(url, method, route));
  await context.route(`${VIEWER}/**`, route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Viewer</title>" }));
  await page.goto("/viewer");
  await expect(page.getByText("2 processing jobs need attention.", { exact: false })).toBeVisible();
  const popup = context.waitForEvent("page");
  await page.getByRole("button", { name: "Review in Viewer" }).click();
  await expect.poll(async () => (await popup).url()).toBe(grant.workspaceUrl);
  expect(ops.filter(call => call.path === "/api/viewer/admin-grant" && call.method === "POST")).toHaveLength(1);
});

test("status checks say unknown on an older Viewer, never zero, and no problems only when the Viewer reports none", async ({ page }) => {
  let reply = overview();
  await mockOps(page, ["viewer.view"], (url, method, route) => url.pathname === "/api/viewer/overview"
    ? route.fulfill({ json: reply }) : processingRoutes(url, method, route));
  await page.goto("/viewer");
  const card = page.getByLabel("3D Viewer platform overview").locator("section.ltds-card", { hasText: "Status checks" });
  await expect(card).toContainText("Not reported");
  await expect(card).toContainText("This Viewer version doesn't report status checks.");
  await expect(card).not.toContainText("0");
  await expect(page.getByText("can't be confirmed right now", { exact: false })).toHaveCount(0);
  reply = overview(0, 0);
  await page.reload();
  await expect(card).toContainText("No problems reported");
  await expect(page.getByText("can't be confirmed right now", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Check in Viewer" })).toHaveCount(0);
});

test("jobs whose status can't be checked are a separate warning from failed jobs and open the Viewer", async ({ page, context }) => {
  let reply = overview(0, 3);
  const ops = await mockOps(page, ["viewer.view"], (url, method, route) => url.pathname === "/api/viewer/overview"
    ? route.fulfill({ json: reply }) : processingRoutes(url, method, route));
  await context.route(`${VIEWER}/**`, route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Viewer</title>" }));
  await page.goto("/viewer");
  const card = page.getByLabel("3D Viewer platform overview").locator("section.ltds-card", { hasText: "Status checks" });
  await expect(card).toContainText("3 can't be checked");
  await expect(card).toContainText("A status-check problem does not mean the processing jobs failed.");
  await expect(page.getByText("The status of 3 active processing jobs can't be confirmed right now. A status-check problem does not mean the processing jobs failed.")).toBeVisible();
  await expect(page.getByText("need attention", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review in Viewer" })).toHaveCount(0);
  const popup = context.waitForEvent("page");
  await page.getByRole("button", { name: "Check in Viewer" }).click();
  await expect.poll(async () => (await popup).url()).toBe(grant.workspaceUrl);
  expect(ops.filter(call => call.path === "/api/viewer/admin-grant" && call.method === "POST")).toHaveLength(1);
  await (await popup).close();
  reply = overview(2, 1);
  await page.reload();
  await expect(card).toContainText("1 can't be checked");
  await expect(card).toContainText("A status-check problem does not mean the processing job failed.");
  await expect(page.getByText("The status of 1 active processing job can't be confirmed right now.", { exact: false })).toBeVisible();
  await expect(page.getByText("2 processing jobs need attention.", { exact: false })).toBeVisible();
});
