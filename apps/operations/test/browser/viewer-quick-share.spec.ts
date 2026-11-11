import { expect, test, type Page, type Route } from "@playwright/test";

const VIEWER = "https://viewer.ledgetopdroneservices.com";
const date = "2026-10-20T12:00:00.000Z";
type Call = { method: string; path: string; key?: string; body: unknown };

function session(permissions: string[]) {
  return { user: { id: "staff-one", email: "staff@example.test", displayName: "Staff", status: "Active", profileType: "Employee",
    isAdministrator: true, permissions, divisions: [] }, csrfToken: "csrf", timezone: "America/Chicago", mapStyleUrl: null,
    mapboxPublicToken: null, units: { default: "imperial", resolved: "imperial" }, capabilities: {} };
}
const MANAGER = ["viewer.view", "viewer.manage", "viewer.share.create", "viewer.share.revoke"];
const overview = { enabled: true, viewerBaseUrl: VIEWER, overview: { generatedAt: date,
  projects: { active: 2, total: 3 }, models: { published: 5, total: 7, bytes: 0 },
  jobs: { queued: 0, running: 1, reviewReady: 0, failed: 0 }, providers: { enabled: 1, healthy: 1, total: 1 },
  storage: { usedBytes: 0, availableBytes: null }, platform: { ready: true, workerLive: true, lifecycleBlocked: false } } };
const projects = { projects: [
  { viewerProjectId: "vp-seawall", name: "Seawall survey", publishedTaskCount: 2, updatedAt: date },
  // The source catalog may not provide counts yet.
  { viewerProjectId: "vp-ranch", name: "Ranch mapping" },
], nextCursor: null };
const tasks = { project: { viewerProjectId: "vp-seawall", name: "Seawall survey" }, tasks: [
  { taskId: "task-ortho", title: "Seawall orthomosaic", publishedAt: date, modelId: "model-ortho" },
  { taskId: "task-mesh", title: "Seawall 3D mesh", publishedAt: date, modelId: null },
], nextCursor: null };
const clients = [
  { sourceId: "project-alpha:primary", workspaceId: "ws-coastal", displayName: "Coastal Engineering", businessName: "Ledge Top" },
  { sourceId: "project-alpha:primary", workspaceId: "ws-harbor", displayName: "Harbor Authority", businessName: "Ledge Top" },
];
const grant = (overrides: Record<string, unknown> = {}) => ({ grantId: "grant-1", sourceId: "project-alpha:primary", workspaceId: "ws-harbor",
  viewerProjectId: "vp-seawall", taskId: "task-ortho", scopeType: "task", includeFuturePublished: false,
  permissions: { measure: true, cameras: true, download: false }, expiresAt: null, grantVersion: 1, revokedAt: null, createdAt: date,
  clientDisplayName: "Harbor Authority", ...overrides });

type Handler = (url: URL, method: string, route: Route) => Promise<void> | undefined;
async function mockOps(page: Page, permissions: string[], handle: Handler = () => undefined) {
  const calls: Call[] = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === VIEWER) return route.fallback();
    calls.push({ method: request.method(), path: url.pathname + url.search, key: request.headers()["idempotency-key"],
      body: request.postData() ? JSON.parse(request.postData()!) : null });
    if (url.pathname === "/api/session") return route.fulfill({ json: session(permissions) });
    const handled = handle(url, request.method(), route);
    if (handled) return handled;
    if (url.pathname === "/api/viewer/overview") return route.fulfill({ json: overview });
    if (url.pathname === "/api/viewer/direct-share-catalog") return route.fulfill({ json: projects });
    if (url.pathname === "/api/viewer/direct-share-catalog/vp-seawall/tasks") return route.fulfill({ json: tasks });
    if (url.pathname === "/api/viewer/direct-client-grants" && request.method() === "GET") return route.fulfill({ json: { clients, clientsNextCursor: null, grants: [] } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return calls;
}
const posts = (calls: Call[]) => calls.filter(call => call.method === "POST" && call.path === "/api/viewer/direct-client-grants");

async function openShare(page: Page, item: string) {
  await page.goto("/viewer");
  await page.getByRole("list", { name: "Viewer projects" }).getByRole("button", { name: /Seawall survey/ }).click();
  await page.getByRole("list", { name: "Published models in Seawall survey" }).getByRole("button", { name: new RegExp(item) }).click();
  return page.getByRole("dialog");
}

test("the 3D models page is one overview; old section links land on it", async ({ page }) => {
  await mockOps(page, MANAGER);
  for (const path of ["/viewer/models", "/viewer/sharing", "/viewer/processing", "/viewer/processing?tab=tasks", "/operations/processing"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/viewer$/);
    await expect(page.getByRole("heading", { name: "Viewer workspace", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open Viewer workspace" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Quick share" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Seawall survey 2 published models" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ranch mapping", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "3D Viewer sections" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^(Client models|Sharing & setup|Processing)$/ })).toHaveCount(0);
  }
});

test("staff share one published model with a client, with no business project or association", async ({ page }) => {
  const calls = await mockOps(page, MANAGER, (url, method, route) =>
    url.pathname === "/api/viewer/direct-client-grants" && method === "POST" ? route.fulfill({ status: 201, json: { grant: grant(), replayed: false } }) : undefined);
  const dialog = await openShare(page, "Seawall orthomosaic");
  await expect(dialog.getByRole("heading", { name: "Share Seawall orthomosaic" })).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "Client Workspace" })).toHaveAttribute("aria-selected", "true");
  await dialog.getByRole("option", { name: /Harbor Authority/ }).click();
  await expect(dialog.getByRole("checkbox", { name: "See camera photos" })).not.toBeChecked();
  await dialog.getByRole("checkbox", { name: "See camera photos" }).check();
  await dialog.getByRole("checkbox", { name: "Download files" }).check();
  await dialog.getByRole("checkbox", { name: /^Never/ }).uncheck();
  await dialog.getByLabel("Last day (Central time)").fill("2026-12-31");
  await dialog.getByRole("button", { name: "Review share" }).click();
  await expect(dialog.getByRole("region", { name: "Review share" })).toContainText("Share Seawall orthomosaic with Harbor Authority. Access ends Dec 31, 2026.");
  await expect(dialog.getByRole("region", { name: "Review share" })).toContainText("They can view the model, take measurements, see camera photos, and download files.");
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "Shared with Harbor Authority" })).toBeVisible();
  const sent = posts(calls);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(sent[0]!.body).toEqual({ sourceId: "project-alpha:primary", workspaceId: "ws-harbor", viewerProjectId: "vp-seawall",
    taskId: "task-ortho", scopeType: "task", includeFuturePublished: false, confirmedScope: true,
    expiresAt: "2027-01-01T05:59:59.000Z", permissions: { measure: true, cameras: true, download: true } });
  expect(calls.some(call => /native-associations|\/api\/viewer\/associations|^\/api\/viewer(\?|$)/.test(call.path))).toBe(false);
  expect(calls.some(call => call.path.startsWith("/api/viewer/direct-client-grants?viewerProjectId=vp-seawall"))).toBe(true);
});

test("a hung client lookup ends with a retry instead of an endless loading state", async ({ page }) => {
  test.setTimeout(30_000);
  await page.addInitScript(() => {
    const fetchWithNetwork = window.fetch.bind(window);
    let stallFirstClientLookup = true;
    window.fetch = (input, init = {}) => {
      const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : String(input), location.href);
      if (stallFirstClientLookup && url.pathname === "/api/viewer/direct-client-grants" && (init.method ?? "GET").toUpperCase() === "GET") {
        stallFirstClientLookup = false;
        return new Promise<Response>((_resolve, reject) => {
          const signal = init.signal;
          if (signal?.aborted) reject(new DOMException("The operation was aborted.", "AbortError"));
          else signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
        });
      }
      return fetchWithNetwork(input, init);
    };
  });
  const calls = await mockOps(page, MANAGER);
  const dialog = await openShare(page, "Seawall orthomosaic");
  await expect(dialog.getByRole("status")).toHaveText("Loading clients…");
  await expect(dialog.getByRole("alert")).toContainText("The client list took too long to load. Try again.", { timeout: 20_000 });
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(dialog.getByRole("option", { name: /Harbor Authority/ })).toBeVisible();
  expect(calls.filter(call => call.method === "GET" && call.path.startsWith("/api/viewer/direct-client-grants?"))).toHaveLength(1);
});

test("a share can end today in Central time, but not on a day that has already ended", async ({ page }) => {
  // 22:00 in Chicago is already the next day in UTC; the last day offered is still Chicago's today.
  await page.clock.setFixedTime(new Date("2026-10-28T03:00:00Z"));
  const calls = await mockOps(page, MANAGER, (url, method, route) =>
    url.pathname === "/api/viewer/direct-client-grants" && method === "POST" ? route.fulfill({ status: 201, json: { grant: grant(), replayed: false } }) : undefined);
  const dialog = await openShare(page, "Seawall orthomosaic");
  await dialog.getByRole("option", { name: /Harbor Authority/ }).click();
  await dialog.getByRole("checkbox", { name: /^Never/ }).uncheck();
  const lastDay = dialog.getByLabel("Last day (Central time)");
  await expect(lastDay).toHaveAttribute("min", "2026-10-27");
  await lastDay.fill("2026-10-26");
  await expect(dialog.getByRole("button", { name: "Review share" })).toBeDisabled();
  await lastDay.fill("2026-10-27");
  expect(await lastDay.evaluate(input => (input as HTMLInputElement).validity.valid)).toBe(true);
  await dialog.getByRole("button", { name: "Review share" }).click();
  await expect(dialog.getByRole("region", { name: "Review share" })).toContainText("Access ends Oct 27, 2026.");
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "Shared with Harbor Authority" })).toBeVisible();
  expect(posts(calls).map(post => (post.body as { expiresAt: string }).expiresAt)).toEqual(["2026-10-28T04:59:59.000Z"]);
});

test("an unconfirmed share is retried with the identical body and key, and the selection is locked", async ({ page }) => {
  let attempts = 0;
  const calls = await mockOps(page, MANAGER, (url, method, route) => {
    if (url.pathname !== "/api/viewer/direct-client-grants" || method !== "POST") return undefined;
    attempts += 1;
    return route.fulfill(attempts === 1 ? { status: 503, json: { error: "Viewer unavailable" } } : { status: 200, json: { grant: grant(), replayed: true } });
  });
  const dialog = await openShare(page, "Seawall orthomosaic");
  await dialog.getByRole("option", { name: /Harbor Authority/ }).click();
  await dialog.getByRole("button", { name: "Review share" }).click();
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("couldn't confirm");
  await expect(dialog.getByRole("button", { name: "Change" })).toBeDisabled();
  await expect(dialog.getByRole("checkbox", { name: "Download files" })).toBeDisabled();
  // The error sits above the retry button.
  const errorBox = await dialog.getByRole("alert").boundingBox(), retryBox = await dialog.getByRole("button", { name: "Try again" }).boundingBox();
  expect(errorBox!.y + errorBox!.height).toBeLessThanOrEqual(retryBox!.y);
  // An unconfirmed share can only be retried from here: its receipt belongs to this sign-in and expires.
  await expect(dialog.getByRole("button", { name: "Close" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Change" })).toBeDisabled();
  await expect(dialog.getByRole("checkbox", { name: "Download files" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
  expect(posts(calls)).toHaveLength(1);
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "Shared with Harbor Authority" })).toBeVisible();
  await expect(dialog.getByRole("status").filter({ hasText: "Shared with Harbor Authority" })).toHaveClass(/\bok\b/);
  const sent = posts(calls);
  expect(sent).toHaveLength(2);
  expect(sent[1]!.key).toBe(sent[0]!.key);
  expect(sent[1]!.body).toEqual(sent[0]!.body);
});

test("a duplicate reported after an unconfirmed share is not treated as a failure of that share", async ({ page }) => {
  let attempts = 0;
  const calls = await mockOps(page, MANAGER, (url, method, route) => {
    if (url.pathname !== "/api/viewer/direct-client-grants" || method !== "POST") return undefined;
    attempts += 1;
    return route.fulfill(attempts === 1 ? { status: 503, json: { error: "Viewer unavailable" } }
      : { status: 409, json: { error: "An active share already exists", code: "duplicate_active_grant" } });
  });
  const dialog = await openShare(page, "Seawall orthomosaic");
  await dialog.getByRole("option", { name: /Harbor Authority/ }).click();
  await dialog.getByRole("button", { name: "Review share" }).click();
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("couldn't confirm");
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(dialog.getByRole("alert")).toHaveText('Harbor Authority already has this share, possibly from your earlier attempt. Check "Already shared with" above.');
  await expect(dialog.getByRole("alert")).not.toContainText("An active share already exists");
  const sent = posts(calls);
  expect(sent).toHaveLength(2);
  expect(sent[1]!.key).toBe(sent[0]!.key);
  expect(sent[1]!.body).toEqual(sent[0]!.body);
});

test("a whole-project share needs the separate future-models opt-in", async ({ page }) => {
  const calls = await mockOps(page, MANAGER, (url, method, route) =>
    url.pathname === "/api/viewer/direct-client-grants" && method === "POST"
      ? route.fulfill({ status: 201, json: { grant: grant({ taskId: null, scopeType: "project", includeFuturePublished: true }), replayed: false } }) : undefined);
  const dialog = await openShare(page, "Whole project");
  await expect(dialog.getByRole("heading", { name: "Share Seawall survey (whole project)" })).toBeVisible();
  await dialog.getByRole("option", { name: /Coastal Engineering/ }).click();
  const optIn = dialog.getByRole("checkbox", { name: "Also share every model published to this project later" });
  await expect(optIn).not.toBeChecked();
  await expect(dialog.getByRole("button", { name: "Review share" })).toBeDisabled();
  await optIn.check();
  await dialog.getByRole("button", { name: "Review share" }).click();
  await expect(dialog.getByRole("region", { name: "Review share" })).toContainText("including every model published to it later");
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "Shared with Coastal Engineering" })).toBeVisible();
  expect(posts(calls)[0]!.body).toMatchObject({ workspaceId: "ws-coastal", viewerProjectId: "vp-seawall", taskId: null,
    scopeType: "project", includeFuturePublished: true, confirmedScope: true, expiresAt: null });
});

test("a client whose connection changed is reloaded, never substituted", async ({ page }) => {
  let reads = 0;
  const calls = await mockOps(page, MANAGER, (url, method, route) => {
    if (url.pathname !== "/api/viewer/direct-client-grants") return undefined;
    if (method === "POST") return route.fulfill({ status: 409, json: { error: "Client connection is unavailable; refresh the client connection", code: "relationship_missing" } });
    reads += 1;
    return route.fulfill({ json: { clients: reads === 1 ? clients : clients.slice(0, 1), clientsNextCursor: null, grants: [] } });
  });
  const dialog = await openShare(page, "Seawall orthomosaic");
  await dialog.getByRole("option", { name: /Harbor Authority/ }).click();
  await dialog.getByRole("button", { name: "Review share" }).click();
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Something changed with this client. Choose them again from the list.");
  await expect(dialog.getByRole("option", { name: /Coastal Engineering/ })).toBeVisible();
  await expect(dialog.getByRole("option", { name: /Harbor Authority/ })).toHaveCount(0);
  expect(posts(calls)).toHaveLength(1);
});

test("existing client shares for the model are listed and can be stopped", async ({ page }) => {
  const calls = await mockOps(page, MANAGER, (url, method, route) => {
    if (url.pathname === "/api/viewer/direct-client-grants" && method === "GET")
      return route.fulfill({ json: { clients, clientsNextCursor: null, grants: [grant(), grant({ grantId: "grant-other", taskId: "task-mesh", clientDisplayName: "Other" })] } });
    if (url.pathname === "/api/viewer/direct-client-grants/grant-1" && method === "DELETE") return route.fulfill({ json: { grant: grant({ revokedAt: date }), sessionRevocation: { pending: false } } });
    return undefined;
  });
  const dialog = await openShare(page, "Seawall orthomosaic");
  const existing = dialog.locator(".viewer-direct-share-existing");
  await expect(existing).toContainText("Harbor Authority");
  await expect(existing).not.toContainText("Other");
  page.once("dialog", confirm => void confirm.accept());
  await existing.getByRole("button", { name: "Stop sharing" }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "Stopped sharing with Harbor Authority" })).toBeVisible();
  const deleted = calls.find(call => call.method === "DELETE")!;
  expect(deleted.path).toBe("/api/viewer/direct-client-grants/grant-1");
  expect(deleted.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(deleted.body).toEqual({ reason: "Revoked by staff" });
});

test("public links are offered only for a single model with a public version", async ({ page }) => {
  const calls = await mockOps(page, MANAGER, (url, method, route) => {
    if (url.pathname === "/api/viewer/models/model-ortho/shares" && method === "GET") return route.fulfill({ json: { shares: [] } });
    if (url.pathname === "/api/viewer/models/model-ortho/shares" && method === "POST")
      return route.fulfill({ status: 201, json: { share: { id: "share-1", label: null, hasPassword: false, expiresAt: null, displayUnits: "imperial",
        accessCount: 0, lastAccessedAt: null, revokedAt: null, createdAt: date }, viewUrl: `${VIEWER}/s/abc` } });
    return undefined;
  });
  let dialog = await openShare(page, "Seawall 3D mesh");
  await expect(dialog.getByRole("tab", { name: "Public link" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByRole("list", { name: "Published models in Seawall survey" }).getByRole("button", { name: /Whole project/ }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("tab", { name: "Public link" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByRole("list", { name: "Published models in Seawall survey" }).getByRole("button", { name: /Seawall orthomosaic/ }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Public link" }).click();
  await dialog.getByRole("checkbox", { name: "Never expires" }).check();
  page.once("dialog", confirm => void confirm.accept());
  await dialog.getByRole("button", { name: "Create link" }).click();
  await expect(dialog.getByLabel("New link")).toHaveValue(`${VIEWER}/s/abc`);
  const created = calls.find(call => call.method === "POST" && call.path === "/api/viewer/models/model-ortho/shares")!;
  expect(created.body).toEqual({ label: null, expiresAt: null, displayUnits: "imperial", permissions: { view: true, measure: true, cameras: false, download: false } });
  expect(posts(calls)).toHaveLength(0);
});

test("when sharing is off the overview still works and Quick share says so calmly", async ({ page }) => {
  await mockOps(page, MANAGER, (url, _method, route) =>
    url.pathname.startsWith("/api/viewer/direct-share-catalog") ? route.fulfill({ status: 404, json: { error: "Not found" } }) : undefined);
  await page.goto("/viewer");
  await expect(page.getByText("5", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Quick share isn't available yet" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("view-only staff see totals but no Quick share or connection tools", async ({ page }) => {
  const calls = await mockOps(page, ["viewer.view"]);
  await page.goto("/viewer");
  await expect(page.getByRole("heading", { name: "Viewer workspace", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Quick share" })).toHaveCount(0);
  await expect(page.getByText("Connection details")).toHaveCount(0);
  expect(calls.some(call => call.path.startsWith("/api/viewer/direct-"))).toBe(false);
});

test("a slower earlier search can't replace a newer one, and a failed search hides the old list", async ({ page }) => {
  await mockOps(page, MANAGER, (url, _method, route) => {
    if (url.pathname !== "/api/viewer/direct-share-catalog") return undefined;
    const q = url.searchParams.get("q");
    if (q === "sea") return new Promise<void>(resolve => setTimeout(() => void route.fulfill({ json: { projects: [projects.projects[0]], nextCursor: null } }).then(resolve), 1_500));
    if (q === "ranch") return route.fulfill({ json: { projects: [projects.projects[1]], nextCursor: null } });
    if (q === "broken") return route.fulfill({ status: 500, json: { error: "Viewer unavailable" } });
    return undefined;
  });
  await page.goto("/viewer");
  const list = page.getByRole("list", { name: "Viewer projects" });
  await expect(list.getByRole("button")).toHaveCount(2);
  const search = page.getByRole("searchbox", { name: "Search Viewer projects" });
  await search.fill("sea");
  await expect(list).toHaveCount(0);
  await page.waitForTimeout(400);
  await search.fill("ranch");
  await expect(list.getByRole("button", { name: "Ranch mapping", exact: true })).toBeVisible();
  // Let the earlier "sea" answer arrive; it must not replace the current results.
  await page.waitForTimeout(1_500);
  await expect(list.getByRole("button")).toHaveCount(1);
  await expect(list.getByRole("button", { name: /Seawall survey/ })).toHaveCount(0);
  await search.fill("broken");
  await expect(page.getByRole("alert")).toContainText("Viewer projects couldn't be loaded");
  await expect(list).toHaveCount(0);
});

test("an unconfirmed public link is retried with the identical body and key, never duplicated", async ({ page }) => {
  let attempts = 0;
  const calls = await mockOps(page, MANAGER, (url, method, route) => {
    if (url.pathname !== "/api/viewer/models/model-ortho/shares") return undefined;
    if (method === "GET") return route.fulfill({ json: { shares: [] } });
    attempts += 1;
    return attempts === 1 ? route.fulfill({ status: 504, json: { error: "Gateway timeout" } })
      : route.fulfill({ status: 201, json: { share: { id: "share-1", label: "Board review", hasPassword: true, expiresAt: null, displayUnits: "metric",
        accessCount: 0, lastAccessedAt: null, revokedAt: null, createdAt: date }, viewUrl: `${VIEWER}/s/abc` } });
  });
  const dialog = await openShare(page, "Seawall orthomosaic");
  await dialog.getByRole("tab", { name: "Public link" }).click();
  await dialog.getByLabel("Label (optional)").fill("Board review");
  await dialog.getByRole("checkbox", { name: "Never expires" }).check();
  await dialog.getByLabel("Password (optional)").fill("correct horse");
  await dialog.getByRole("combobox", { name: "Measurement units" }).selectOption("metric");
  page.once("dialog", confirm => void confirm.accept());
  await dialog.getByRole("button", { name: "Create link" }).click();
  await expect(dialog.getByRole("alert")).toContainText("couldn't confirm the link was created");
  await expect(dialog.getByLabel("Label (optional)")).toBeDisabled();
  await expect(dialog.getByRole("checkbox", { name: "Allow model download" })).toBeDisabled();
  await expect(dialog.getByRole("tab", { name: "Client Workspace" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Close" })).toBeDisabled();
  await expect(dialog.getByRole("alert")).toContainText("couldn't confirm the link was created");
  await expect(dialog.getByLabel("Label (optional)")).toHaveValue("Board review");
  await expect(dialog.getByLabel("Label (optional)")).toBeDisabled();
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(dialog.getByLabel("New link")).toHaveValue(`${VIEWER}/s/abc`);
  await expect(dialog.getByRole("button", { name: "Close" })).toBeEnabled();
  const sent = calls.filter(call => call.method === "POST" && call.path === "/api/viewer/models/model-ortho/shares");
  expect(sent).toHaveLength(2);
  expect(sent[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(sent[1]!.key).toBe(sent[0]!.key);
  expect(sent[1]!.body).toEqual(sent[0]!.body);
  expect(sent[0]!.body).toEqual({ label: "Board review", expiresAt: null, displayUnits: "metric", password: "correct horse",
    permissions: { view: true, measure: true, cameras: false, download: false } });
});

test("Client Workspace is the first and selected method", async ({ page }) => {
  await mockOps(page, MANAGER);
  const dialog = await openShare(page, "Seawall orthomosaic");
  const tabs = dialog.getByRole("tab");
  await expect(tabs).toHaveText(["Client Workspace", "Public link"]);
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
});

test("a client who already has access is marked, and the review says what sharing again does", async ({ page }) => {
  const calls = await mockOps(page, MANAGER, (url, method, route) => {
    if (url.pathname !== "/api/viewer/direct-client-grants" || method !== "GET") return undefined;
    return route.fulfill({ json: { clients, clientsNextCursor: null, grants: [grant(),
      grant({ grantId: "grant-project", workspaceId: "ws-coastal", taskId: null, scopeType: "project", includeFuturePublished: true, clientDisplayName: "Coastal Engineering" })] } });
  });
  const dialog = await openShare(page, "Seawall orthomosaic");
  const harbor = dialog.getByRole("option", { name: /Harbor Authority/ });
  await expect(harbor).toContainText("Already has access");
  await expect(dialog.getByRole("option", { name: /Coastal Engineering/ })).toContainText("Already has access");
  // One business: no business line under each client.
  await expect(harbor).not.toContainText("Ledge Top");
  await harbor.click();
  await dialog.getByRole("button", { name: "Review share" }).click();
  const review = dialog.getByRole("region", { name: "Review share" });
  await expect(review).toContainText("Harbor Authority already has this share, so it can't be shared again.");
  await expect(dialog.getByRole("button", { name: "Share", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Back" }).click();
  await dialog.getByRole("button", { name: "Change" }).click();
  await dialog.getByRole("option", { name: /Coastal Engineering/ }).click();
  await dialog.getByRole("button", { name: "Review share" }).click();
  await expect(review).toContainText("already has this model through a whole-project share. This adds a separate share for this model");
  await expect(dialog.getByRole("button", { name: "Share", exact: true })).toBeEnabled();
  expect(posts(calls)).toHaveLength(0);
});

test("clients from more than one business show which business they come through", async ({ page }) => {
  await mockOps(page, MANAGER, (url, method, route) =>
    url.pathname === "/api/viewer/direct-client-grants" && method === "GET" ? route.fulfill({ json: { clients: [clients[0],
      { sourceId: "project-alpha:source-2", workspaceId: "ws-bay", displayName: "Bay Marine", businessName: "LTT" }], clientsNextCursor: null, grants: [] } }) : undefined);
  const dialog = await openShare(page, "Seawall orthomosaic");
  await expect(dialog.getByRole("option", { name: /Coastal Engineering/ })).toContainText("via Ledge Top");
  await expect(dialog.getByRole("option", { name: /Bay Marine/ })).toContainText("via Ledge Top LTT");
});

test("a project with no published models doesn't offer a whole-project share", async ({ page }) => {
  await mockOps(page, MANAGER, (url, _method, route) => url.pathname === "/api/viewer/direct-share-catalog/vp-ranch/tasks"
    ? route.fulfill({ json: { project: { viewerProjectId: "vp-ranch", name: "Ranch mapping" }, tasks: [], nextCursor: null } }) : undefined);
  await page.goto("/viewer");
  await page.getByRole("list", { name: "Viewer projects" }).getByRole("button", { name: "Ranch mapping", exact: true }).click();
  await expect(page.getByText("No published models yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Whole project/ })).toHaveCount(0);
});

test("a public link ends at the close of its last day in Central time", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-28T03:00:00Z"));
  const calls = await mockOps(page, MANAGER, (url, method, route) => {
    if (url.pathname !== "/api/viewer/models/model-ortho/shares") return undefined;
    if (method === "GET") return route.fulfill({ json: { shares: [] } });
    return route.fulfill({ status: 201, json: { share: { id: "share-1", label: null, hasPassword: false, expiresAt: "2026-11-01T05:59:59.000Z", displayUnits: "imperial",
      accessCount: 0, lastAccessedAt: null, revokedAt: null, createdAt: date }, viewUrl: `${VIEWER}/s/abc` } });
  });
  const dialog = await openShare(page, "Seawall orthomosaic");
  await dialog.getByRole("tab", { name: "Public link" }).click();
  const lastDay = dialog.getByLabel("Last day (Central time)");
  await expect(lastDay).toHaveValue("2026-11-03");
  await expect(lastDay).toHaveAttribute("min", "2026-10-27");
  await expect(lastDay).toHaveAttribute("max", "2026-11-25");
  await lastDay.fill("2026-10-31");
  await dialog.getByRole("button", { name: "Create link" }).click();
  await expect(dialog.getByLabel("New link")).toHaveValue(`${VIEWER}/s/abc`);
  const created = calls.find(call => call.method === "POST" && call.path === "/api/viewer/models/model-ortho/shares")!;
  expect((created.body as { expiresAt: string }).expiresAt).toBe("2026-11-01T04:59:59.000Z");
});

test("an unconfirmed client share older than the retry window is held: no new request, guidance to check existing access", async ({ page }) => {
  await page.clock.install();
  let attempts = 0;
  const calls = await mockOps(page, MANAGER, (url, method, route) => {
    if (url.pathname !== "/api/viewer/direct-client-grants" || method !== "POST") return undefined;
    attempts += 1;
    return route.fulfill({ status: 503, json: { error: "Viewer unavailable" } });
  });
  const dialog = await openShare(page, "Seawall orthomosaic");
  await dialog.getByRole("option", { name: /Harbor Authority/ }).click();
  await dialog.getByRole("button", { name: "Review share" }).click();
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("couldn't confirm");
  // A dialog left open past the Viewer's 24-hour receipt retention never re-sends.
  await page.clock.fastForward("25:00:00");
  await expect(dialog.getByRole("alert")).toContainText("too old to retry safely");
  await expect(dialog.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Close" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Check again" }).click();
  expect(posts(calls)).toHaveLength(1);
  expect(attempts).toBe(1);
});

test("an unconfirmed public link older than the retry window is held and its password is dropped", async ({ page }) => {
  await page.clock.install();
  let attempts = 0;
  const calls = await mockOps(page, MANAGER, (url, method, route) => {
    if (url.pathname !== "/api/viewer/models/model-ortho/shares") return undefined;
    if (method === "GET") return route.fulfill({ json: { shares: [] } });
    attempts += 1;
    return route.fulfill({ status: 504, json: { error: "Gateway timeout" } });
  });
  const dialog = await openShare(page, "Seawall orthomosaic");
  await dialog.getByRole("tab", { name: "Public link" }).click();
  await dialog.getByRole("checkbox", { name: "Never expires" }).check();
  await dialog.getByLabel("Password (optional)").fill("correct horse");
  page.once("dialog", confirm => void confirm.accept());
  await dialog.getByRole("button", { name: "Create link" }).click();
  await expect(dialog.getByRole("alert")).toContainText("couldn't confirm the link was created");
  await page.clock.fastForward("25:00:00");
  await expect(dialog.getByRole("alert")).toContainText("too old to retry safely");
  await expect(dialog.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(dialog.getByLabel("Password (optional)")).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeDisabled();
  const gets = calls.filter(call => call.method === "GET" && call.path === "/api/viewer/models/model-ortho/shares").length;
  await dialog.getByRole("button", { name: "Check again" }).click();
  await expect.poll(() => calls.filter(call => call.method === "GET" && call.path === "/api/viewer/models/model-ortho/shares").length).toBeGreaterThan(gets);
  expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
  expect(attempts).toBe(1);
});

test("a new client share leaves camera photos off unless staff turn them on", async ({ page }) => {
  const calls = await mockOps(page, MANAGER, (url, method, route) =>
    url.pathname === "/api/viewer/direct-client-grants" && method === "POST" ? route.fulfill({ status: 201, json: { grant: grant(), replayed: false } }) : undefined);
  const dialog = await openShare(page, "Seawall orthomosaic");
  await dialog.getByRole("option", { name: /Harbor Authority/ }).click();
  await expect(dialog.getByRole("checkbox", { name: "See camera photos" })).not.toBeChecked();
  await dialog.getByRole("button", { name: "Review share" }).click();
  const review = dialog.getByRole("region", { name: "Review share" });
  await expect(review).toContainText("They can view the model and take measurements.");
  await expect(review).not.toContainText("camera photos");
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "Shared with Harbor Authority" })).toBeVisible();
  expect(posts(calls)[0]!.body).toMatchObject({ permissions: { measure: true, cameras: false, download: false } });
  // The next share starts from the same defaults, not from what was last chosen.
  await dialog.getByRole("option", { name: /Harbor Authority/ }).click();
  await expect(dialog.getByRole("checkbox", { name: "See camera photos" })).not.toBeChecked();
});

test("a new public link leaves camera photos off, and staff can include them deliberately", async ({ page }) => {
  let next = 0;
  const calls = await mockOps(page, MANAGER, (url, method, route) => {
    if (url.pathname === "/api/viewer/models/model-ortho/shares" && method === "GET") return route.fulfill({ json: { shares: [] } });
    if (url.pathname === "/api/viewer/models/model-ortho/shares" && method === "POST") {
      next += 1;
      return route.fulfill({ status: 201, json: { share: { id: `share-${next}`, label: null, expiresAt: null, hasPassword: false,
        permissions: { view: true, measure: true, cameras: next === 2, download: false },
        accessCount: 0, lastAccessedAt: null, revokedAt: null, createdAt: date }, viewUrl: `${VIEWER}/s/link-${next}` } });
    }
    return undefined;
  });
  const dialog = await openShare(page, "Seawall orthomosaic");
  await dialog.getByRole("tab", { name: "Public link" }).click();
  const photos = dialog.getByRole("checkbox", { name: "Show camera photos and where they were taken" });
  await expect(photos).not.toBeChecked();
  await dialog.getByRole("checkbox", { name: "Never expires" }).check();
  page.once("dialog", confirm => void confirm.accept());
  await dialog.getByRole("button", { name: "Create link" }).click();
  await expect(dialog.getByLabel("New link")).toHaveValue(`${VIEWER}/s/link-1`);
  await photos.check();
  page.once("dialog", confirm => void confirm.accept());
  await dialog.getByRole("button", { name: "Create link" }).click();
  await expect(dialog.getByLabel("New link")).toHaveValue(`${VIEWER}/s/link-2`);
  const sent = calls.filter(call => call.method === "POST" && call.path === "/api/viewer/models/model-ortho/shares");
  expect(sent.map(call => (call.body as { permissions: { cameras: boolean } }).permissions.cameras)).toEqual([false, true]);
});
