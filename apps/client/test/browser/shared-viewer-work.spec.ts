import { expect, test, type Page, type Route } from "@playwright/test";

/** 3D work shared directly with a client: one flat list across every client account, opened with each row's own grant. */
const date = "2026-08-26T12:00:00Z";
const viewerOrigin = "https://viewer.ledgetopdroneservices.com";
// Stored account names can be internal labels; the shared 3D work list must never show them.
const allWorkspaces = [
  { id: "workspace-b", rootType: "organization", rootPublicId: "org-shared", displayName: "QA internal label B", resourceMode: "native", sourceId: "project-alpha:coastal" },
  { id: "workspace-c", rootType: "organization", rootPublicId: "org-shared", displayName: "QA internal label C", resourceMode: "native", sourceId: "project-alpha:mountain" },
];
const features = () => ({directory: {state: "available", reason: "authorized_capability"}, deliveries: {state: "available", reason: "resource_authorization_required"},
  serviceRequests: {state: "not_supported", reason: "source_not_supported"}, feedback: {state: "temporarily_unavailable", reason: "backend_unavailable"},
  models: {state: "not_supported", reason: "source_not_supported"}, team: {state: "not_supported", reason: "source_not_supported"},
  billing: {state: "not_supported", reason: "source_not_supported"}});
const workspace = (id: string) => allWorkspaces.find(item => item.id === id)!;
const context = (id: string) => ({workspace: workspace(id), contextVersion: `context-${id}`, features: features(), capabilities: {directoryRead: true, deliveryView: true, requestV2: false, requestAttachments: false, feedback: false, manageTeam: false, workspaceMembershipManagement: false, delegatedShares: false, viewer: false, viewerShares: false, viewBilling: false}});
const hierarchy = (id: string) => ({workspaceId: id, sourceId: workspace(id).sourceId, contextVersion: `context-${id}`, page: {nextCursor: null}, entries: [
  {type: "project", publicId: `project-${id}`, parentType: null, parentPublicId: null, displayName: `Directory project ${id}`, sourceVersion: "1"},
]});
type Item = {grantId: string; taskId: string; scopeType: "project" | "task"; title: string; projectName: string; businessName: string; updatedAt: string; expiresAt?: string | null};
const viewerItem = (workspaceId: string, item: Item) => ({workspaceId, sharedAt: "2026-08-01T12:00:00Z", expiresAt: null,
  permissions: {measure: item.scopeType === "task", cameras: false, download: false}, ...item});
const viewerPage = (workspaceId: string, items: Item[], nextCursor: string | null = null) => ({workspaceId, contextVersion: `viewer-${workspaceId}`, items: items.map(item => viewerItem(workspaceId, item)), nextCursor});

type Call = {path: string; query: URLSearchParams; method: string; workspace?: string; key?: string; body?: unknown};
async function mock(page: Page, workspaces: typeof allWorkspaces, viewer: (route: Route, call: Call, workspaceId: string) => Promise<unknown> | undefined) {
  const calls: Call[] = [];
  await page.context().route("**/api/client/**", async route => {
    const request = route.request(), url = new URL(request.url());
    const call: Call = {path: url.pathname, query: url.searchParams, method: request.method(), workspace: request.headers()["x-ltds-workspace-id"],
      key: request.headers()["idempotency-key"], body: request.method() === "POST" ? request.postDataJSON() : undefined};
    calls.push(call);
    if (call.path === "/api/client/session") return route.fulfill({json: {account: {id: "", displayName: "Client portal"}, capabilities: {workspaceHierarchyV2: true}}});
    if (call.path === "/api/client/v2/workspaces") return route.fulfill({json: {workspaces}});
    const match = call.path.match(/^\/api\/client\/v2\/workspaces\/(workspace-[bc])\/(.+)$/);
    if (match && workspaces.some(item => item.id === match[1])) {
      const id = match[1]!, suffix = match[2]!;
      if (suffix === "context") { const handled = viewer(route, call, id); if (handled) return handled; return route.fulfill({json: context(id)}); }
      if (suffix === "hierarchy") return route.fulfill({json: hierarchy(id)});
      if (suffix === "deliveries") return route.fulfill({json: {workspaceId: id, sourceId: workspace(id).sourceId, contextVersion: `context-${id}`, items: [], page: {nextCursor: null}}});
      if (suffix === "viewer" || suffix.startsWith("viewer/")) { const handled = viewer(route, call, id); if (handled) return handled; }
    }
    if (call.path === "/api/client/notification-history") return route.fulfill({json: {scope: {sourceId: "project-alpha:coastal", workspaceId: "workspace-b", rootType: "organization", rootPublicId: "org-shared"}, asOf: date,
      coverage: {requests: "included", feedback: "included", authenticatedDelivery: "omitted_feature_disabled", delivery: "omitted_no_explicit_grant_authority"}, items: [], nextCursor: null}});
    return route.fulfill({status: 404, json: {error: "Unsupported fixture endpoint"}});
  });
  return calls;
}
const card = (page: Page) => page.locator(".shared-viewer-work");
const rows = (page: Page) => card(page).locator(".shared-viewer-work-list > li");
async function noHorizontalOverflow(page: Page) {
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", await page.locator("body").evaluate(element => element.clientWidth));
}

test("a project and an exact task grant for the same task show one row that opens with the task grant", async ({page}) => {
  const calls = await mock(page, [allWorkspaces[0]!], (route, call, id) => call.path.endsWith("/viewer") ? route.fulfill({json: viewerPage(id, [
    {grantId: "grant-project", taskId: "task-1", scopeType: "project", title: "North elevation scan", projectName: "Harbor bridge", businessName: "Harbor Engineering", updatedAt: "2026-08-20T12:00:00Z"},
    {grantId: "grant-task", taskId: "task-1", scopeType: "task", title: "North elevation scan", projectName: "Harbor bridge", businessName: "Harbor Engineering", updatedAt: "2026-08-10T12:00:00Z", expiresAt: "2026-12-31T12:00:00Z"},
    {grantId: "grant-project", taskId: "task-2", scopeType: "project", title: "Deck survey", projectName: "Harbor bridge", businessName: "Harbor Engineering", updatedAt: "2026-08-22T12:00:00Z"},
  ])}) : undefined);
  await page.goto("/portal/dashboard?workspace=workspace-b");
  await expect(card(page).getByRole("heading", {name: "Shared 3D work"})).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(0)).toContainText("Deck survey");
  await expect(rows(page).nth(1)).toContainText("North elevation scan");
  await expect(rows(page).nth(1)).toContainText("Harbor bridge");
  await expect(rows(page).nth(1)).toContainText("Available until");
  // Business and account names are never shown.
  await expect(card(page)).not.toContainText("Harbor Engineering");
  await expect(card(page)).not.toContainText("QA internal label");
  const open = rows(page).nth(1).getByRole("link", {name: /^Open 3D model\s*: North elevation scan$/});
  await expect(open).toHaveAttribute("href", "/portal/viewer/grant-task/tasks/task-1?workspace=workspace-b");
  await expect(open).toHaveCSS("min-height", "44px");
  await noHorizontalOverflow(page);
  expect(calls.filter(call => call.path.endsWith("/viewer")).map(call => call.path)).toEqual(["/api/client/v2/workspaces/workspace-b/viewer"]);
});

test("work from two accounts is one flat list without business names, and one failing account does not hide the other", async ({page}) => {
  let failC = true;
  const calls = await mock(page, allWorkspaces, (route, call, id) => {
    if (!call.path.endsWith("/viewer")) return undefined;
    if (id === "workspace-c" && failC) return route.fulfill({status: 503, json: {error: "Temporarily unavailable"}});
    if (id === "workspace-b" && !call.query.get("cursor")) return route.fulfill({json: viewerPage(id, [
      {grantId: "grant-b", taskId: "task-b1", scopeType: "task", title: "Seawall scan", projectName: "Harbor bridge", businessName: "Harbor Engineering", updatedAt: "2026-08-20T12:00:00Z"},
    ], "cursor-b")});
    // An empty page may still have more; the cursor goes back only to its own account.
    if (id === "workspace-b" && call.query.get("cursor") === "cursor-b") return route.fulfill({json: viewerPage(id, [], "cursor-b2")});
    if (id === "workspace-b" && call.query.get("cursor") === "cursor-b2") return route.fulfill({json: viewerPage(id, [
      {grantId: "grant-b", taskId: "task-b0", scopeType: "project", title: "Pier inspection", projectName: "Harbor bridge", businessName: "Harbor Engineering", updatedAt: "2026-07-01T12:00:00Z"},
    ])});
    return route.fulfill({json: viewerPage(id, [
      {grantId: "grant-c", taskId: "task-c1", scopeType: "project", title: "Ridge roof model", projectName: "Summit lodge", businessName: "Summit Builders", updatedAt: "2026-08-24T12:00:00Z"},
    ])});
  });
  await page.goto("/portal/dashboard");
  await expect(page.getByRole("heading", {level: 1, name: "Welcome back"})).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Seawall scan");
  await expect(card(page).getByRole("alert")).toContainText("Some shared 3D work couldn’t be loaded.");
  await noHorizontalOverflow(page);

  failC = false;
  await card(page).getByRole("button", {name: "Try again"}).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(0)).toContainText("Ridge roof model");
  await expect(rows(page).nth(0)).toContainText("Summit lodge");
  await expect(rows(page).nth(1)).toContainText("Harbor bridge");
  await expect(card(page)).not.toContainText(/Summit Builders|Harbor Engineering/);
  await expect(card(page)).not.toContainText("QA internal label");

  await card(page).getByRole("button", {name: "Load more 3D work"}).click();
  await expect(card(page).getByRole("button", {name: "Load more 3D work"})).toBeEnabled();
  await card(page).getByRole("button", {name: "Load more 3D work"}).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).nth(2)).toContainText("Pier inspection");
  await expect(card(page).getByRole("button", {name: "Load more 3D work"})).toHaveCount(0);
  // No account was switched to show any of this.
  expect(new URL(page.url()).searchParams.has("workspace")).toBe(false);
  expect(calls.filter(call => call.query.has("cursor")).map(call => `${call.path}?${call.query.get("cursor")}`)).toEqual([
    "/api/client/v2/workspaces/workspace-b/viewer?cursor-b", "/api/client/v2/workspaces/workspace-b/viewer?cursor-b2",
  ]);
  await noHorizontalOverflow(page);
});

test("an account whose sharing can't be checked says so instead of claiming nothing is shared", async ({page}) => {
  await mock(page, allWorkspaces, (route, call, id) => !call.path.endsWith("/viewer") ? undefined
    : id === "workspace-c" ? route.fulfill({status: 404, json: {error: "Not found"}}) : route.fulfill({json: viewerPage(id, [])}));
  await page.goto("/portal/dashboard");
  await expect(card(page).getByText("Some shared 3D work isn’t available here yet.")).toBeVisible();
  await expect(card(page).getByText("No 3D work has been shared with you yet.")).toHaveCount(0);
  await expect(card(page).getByRole("alert")).toHaveCount(0);
});

test("only verified empty lists say nothing is shared; all unchecked says it isn't available", async ({page}) => {
  await mock(page, allWorkspaces, (route, call) => call.path.endsWith("/viewer") ? route.fulfill({status: 403, json: {error: "Forbidden"}}) : undefined);
  await page.goto("/portal/dashboard");
  await expect(card(page).getByText("Shared 3D work isn’t available here yet.")).toBeVisible();
  await expect(card(page).getByText("No 3D work has been shared with you yet.")).toHaveCount(0);
});

for (const [label, answer] of [["missing (404)", {status: 404, json: {error: "Not found"}}], ["refused (403)", {status: 403, json: {error: "Forbidden"}}],
  ["malformed", {status: 200, json: {workspaceId: "workspace-b", items: "nope"}}], ["for another account", {status: 200, json: {workspaceId: "workspace-c", contextVersion: "x", items: [], nextCursor: null}}]] as const)
  test(`a direct 3D link whose sharing list is ${label} never requests a session`, async ({page}) => {
    const calls = await mock(page, [allWorkspaces[0]!], (route, call) => call.path.endsWith("/viewer") ? route.fulfill(answer) : undefined);
    await page.goto("/portal/viewer/grant-task/tasks/task-1?workspace=workspace-b");
    expect(calls.filter(call => call.path.endsWith("/viewer"))).toEqual([]); // Deep links never issue checks or sessions on load.
    await page.getByRole("button", {name: "Open secure 3D Viewer"}).click();
    await expect(page.getByRole("status")).not.toBeEmpty();
    await page.getByRole("button", {name: "Open secure 3D Viewer"}).click();
    await expect(page.getByRole("status")).not.toBeEmpty();
    expect(calls.filter(call => call.method === "POST")).toEqual([]);
  });

test("opening shared work opens a full-page Viewer and renews through the preserved opener", async ({page}) => {
  let viewerLoads = 0;
  await page.context().route(`${viewerOrigin}/**`, async route => {
    if (!new URL(route.request().url()).pathname.startsWith("/session/")) return route.fulfill({status: 404, body: "not found"});
    viewerLoads += 1;
    await route.fulfill({contentType: "text/html", body: `<!doctype html><body><div id="loaded">direct model</div><script>
      const expiresAt = new Date(Date.now() + 10000).toISOString();
      addEventListener("message", event => {
        if (event.data?.type !== "ltds-viewer:renew-session") return;
        document.body.dataset.renewedGrant = event.data.grant;
        opener.postMessage({version:1,type:"ltds-viewer:session-renewed",modelId:"model-direct",expiresAt:new Date(Date.now()+60000).toISOString()}, "*");
      });
      setTimeout(() => opener.postMessage({version:1,type:"ltds-viewer:ready",modelId:"model-direct",expiresAt}, "*"), 50);
      setTimeout(() => opener.postMessage({version:1,type:"ltds-viewer:session-expiring",modelId:"model-direct",expiresAt}, "*"), 100);
    </script></body>`});
  });
  let sessions = 0;
  const calls = await mock(page, allWorkspaces, (route, call, id) => {
    if (call.path.endsWith("/viewer")) return route.fulfill({json: id === "workspace-c" ? viewerPage(id, [
      {grantId: "grant-task", taskId: "task-1", scopeType: "task", title: "Ridge roof model", projectName: "Summit lodge", businessName: "Summit Builders", updatedAt: "2026-08-24T12:00:00Z"},
    ]) : viewerPage(id, [])});
    if (call.method === "POST" && call.path.endsWith("/session")) {
      sessions += 1;
      const grant = sessions === 1 ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222";
      return route.fulfill({status: 201, json: {modelId: "model-direct", grant, grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800,
        redeemUrl: `${viewerOrigin}/api/v1/sessions/redeem`, embedUrl: `${viewerOrigin}/session/${grant}`}});
    }
    return undefined;
  });
  await page.goto("/portal/dashboard");
  await expect(rows(page)).toHaveCount(1);
  const beforeOpen = calls.length;
  const popupWait = page.waitForEvent("popup");
  await rows(page).first().getByRole("link", {name: /^Open 3D model/}).click();
  const popup = await popupWait;
  await expect(popup).toHaveURL(`${viewerOrigin}/session/11111111-1111-4111-8111-111111111111`);
  await expect(popup.locator("#loaded")).toHaveText("direct model");
  await expect(popup.locator("body")).toHaveAttribute("data-renewed-grant", "22222222-2222-4222-8222-222222222222", {timeout: 5_000});
  expect(await popup.evaluate(() => Boolean(window.opener))).toBe(true);
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(viewerLoads).toBe(1);
  await expect(page.locator(".client-portal-header")).toBeVisible();
  const posts = calls.filter(call => call.method === "POST");
  expect(posts.map(call => call.path)).toEqual([
    "/api/client/v2/workspaces/workspace-c/viewer/grant-task/tasks/task-1/session",
    "/api/client/v2/workspaces/workspace-c/viewer/grant-task/tasks/task-1/session",
  ]);
  expect(posts.every(call => /^[0-9a-f-]{36}$/.test(call.key ?? ""))).toBe(true);
  expect(posts[0]!.key).not.toBe(posts[1]!.key);
  expect(posts[0]!.body).toEqual({displayUnits: expect.stringMatching(/^(imperial|metric)$/)});
  // The direct task route posts only to the exact account/grant/task endpoint; it does not need a broad context read.
  const afterOpen = calls.slice(beforeOpen);
  expect(afterOpen.some(call => call.path === "/api/client/v2/workspaces/workspace-b/context")).toBe(false);
  expect(afterOpen.some(call => call.path === "/api/client/v2/workspaces/workspace-c/context")).toBe(false);
});

test("a refreshed task grant gets a new issuer while ambiguous retries for the old grant stay isolated", async ({page}) => {
  await page.context().route(`${viewerOrigin}/**`, route => route.fulfill({contentType: "text/html", body: "<!doctype html><title>Viewer</title>"}));
  let cursorRequests = 0, sessionRequests = 0;
  const calls = await mock(page, [allWorkspaces[0]!], (route, call, id) => {
    if (call.method === "GET" && call.path.endsWith("/viewer")) {
      if (call.query.has("cursor")) {
        cursorRequests += 1;
        return route.fulfill({status: 409, json: {error: "Cursor expired"}});
      }
      const item = cursorRequests
        ? {grantId: "grant-new", taskId: "task-1", scopeType: "task" as const, title: "Fresh share", projectName: "Harbor bridge", businessName: "Harbor Engineering", updatedAt: "2026-08-25T12:00:00Z"}
        : {grantId: "grant-old", taskId: "task-1", scopeType: "task" as const, title: "Original share", projectName: "Harbor bridge", businessName: "Harbor Engineering", updatedAt: "2026-08-20T12:00:00Z"};
      return route.fulfill({json: viewerPage(id, [item], cursorRequests ? null : "stale-cursor")});
    }
    if (call.method !== "POST" || !call.path.endsWith("/session")) return undefined;
    sessionRequests += 1;
    if (sessionRequests === 1) return route.fulfill({status: 503, json: {error: "Unclear session result"}});
    const grant = "33333333-3333-4333-8333-333333333333";
    return route.fulfill({status: 201, json: {modelId: "model-direct", grant, grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800,
      redeemUrl: `${viewerOrigin}/api/v1/sessions/redeem`, embedUrl: `${viewerOrigin}/session/${grant}`}});
  });

  await page.goto("/portal/dashboard?workspace=workspace-b");
  await expect(rows(page).first()).toContainText("Original share");
  await rows(page).first().getByRole("link", {name: /^Open 3D model/}).click();
  await expect.poll(() => calls.filter(call => call.method === "POST").length).toBe(1);
  await expect.poll(() => page.context().pages().length).toBe(1);

  await card(page).getByRole("button", {name: "Load more 3D work"}).click();
  await expect(rows(page).first()).toContainText("Fresh share");
  const popupWait = page.waitForEvent("popup");
  await rows(page).first().getByRole("link", {name: /^Open 3D model/}).click();
  const popup = await popupWait;
  await expect(popup).toHaveURL(`${viewerOrigin}/session/33333333-3333-4333-8333-333333333333`);
  const sessions = calls.filter(call => call.method === "POST" && call.path.endsWith("/session"));
  expect(sessions).toHaveLength(2);
  expect(sessions.map(call => call.path)).toEqual([
    "/api/client/v2/workspaces/workspace-b/viewer/grant-old/tasks/task-1/session",
    "/api/client/v2/workspaces/workspace-b/viewer/grant-new/tasks/task-1/session",
  ]);
  expect(sessions[0]!.key).not.toBe(sessions[1]!.key);
});

for (const [label, workspaces] of [["one account", [allWorkspaces[0]!]], ["two accounts", allWorkspaces]] as const) test(`Deliveries lists shared 3D work next to delivery folders (${label})`, async ({page}) => {
  await mock(page, [...workspaces], (route, call, id) => call.path.endsWith("/viewer") ? route.fulfill({json: viewerPage(id, [
    {grantId: `grant-${id}`, taskId: `task-${id}`, scopeType: "task", title: `Scan ${id}`, projectName: "Harbor bridge", businessName: "Harbor Engineering", updatedAt: "2026-08-20T12:00:00Z"},
  ])}) : undefined);
  await page.goto("/portal/deliveries?workspace=workspace-b");
  await expect(card(page).getByRole("heading", {name: "Shared 3D work"})).toBeVisible();
  await expect(rows(page)).toHaveCount(workspaces.length);
  await expect(page.locator("body")).not.toContainText("QA internal label");
  await noHorizontalOverflow(page);
});

for (const [label, status, sameKey] of [["an unclear failure retries the same request", 503, true], ["a success that fails verification retries the same request", 200, true], ["a refused request retries as a new request", 409, false]] as const) test(`opening shared work: ${label}`, async ({page}) => {
  let sessions = 0;
  const calls = await mock(page, [allWorkspaces[0]!], (route, call, id) => {
    if (call.method === "GET" && call.path.endsWith("/viewer")) return route.fulfill({json: viewerPage(id, [])});
    if (call.method !== "POST" || !call.path.endsWith("/session")) return undefined;
    sessions += 1;
    if (sessions === 1) return route.fulfill(status === 200 ? {status, json: {modelId: "model-direct"}} : {status, json: {error: "Not available right now"}});
    const grant = "33333333-3333-4333-8333-333333333333";
    return route.fulfill({status: 201, json: {modelId: "model-direct", grant, grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800,
      redeemUrl: `${viewerOrigin}/api/v1/sessions/redeem`, embedUrl: `${viewerOrigin}/session/${grant}`}});
  });
  await page.goto("/portal/viewer/grant-task/tasks/task-1?workspace=workspace-b");
  await expect.poll(() => calls.length).toBe(0);
  await page.getByRole("button", {name: "Open secure 3D Viewer"}).click();
  await expect.poll(() => calls.filter(call => call.method === "POST").length).toBe(1);
  await expect(page.getByRole("status")).not.toContainText("Opening");
  const popupWait = page.waitForEvent("popup");
  await page.getByRole("button", {name: "Open secure 3D Viewer"}).click();
  const popup = await popupWait;
  await expect(popup).toHaveURL(`${viewerOrigin}/session/33333333-3333-4333-8333-333333333333`);
  await expect(page.locator("iframe")).toHaveCount(0);
  const keys = calls.filter(call => call.method === "POST").map(call => call.key);
  expect(keys).toHaveLength(2);
  expect(keys[0] === keys[1]).toBe(sameKey);
});

test("Deliveries shows shared 3D work even when delivery folders are not in access, without probing folders", async ({page}) => {
  const calls = await mock(page, [allWorkspaces[0]!], (route, call, id) => {
    if (call.path.endsWith("/context")) return route.fulfill({json: {...context(id), features: {...features(), deliveries: {state: "temporarily_unavailable", reason: "backend_unavailable"}}, capabilities: {...context(id).capabilities, deliveryView: false}}});
    return call.path.endsWith("/viewer") ? route.fulfill({json: viewerPage(id, [
      {grantId: "grant-task", taskId: "task-1", scopeType: "task", title: "North elevation scan", projectName: "Harbor bridge", businessName: "Harbor Engineering", updatedAt: "2026-08-20T12:00:00Z"},
    ])}) : undefined;
  });
  await page.goto("/portal/deliveries?workspace=workspace-b");
  await expect(page.getByText("Delivery folders are not included in your current access.")).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await expect(card(page)).toHaveCount(1);
  expect(calls.some(call => /\/(deliveries|folders)/.test(call.path))).toBe(false);
});

test("a Viewer that never reports ready stops waiting and retries with a freshly issued session", async ({page}) => {
  await page.context().route(`${viewerOrigin}/**`, route => route.fulfill({contentType: "text/html", body: "<!doctype html><title>Full-page Viewer</title>"}));
  let sessions = 0;
  const calls = await mock(page, [allWorkspaces[0]!], (route, call, id) => {
    if (call.method === "GET" && call.path.endsWith("/viewer")) return route.fulfill({json: viewerPage(id, [])});
    if (call.method !== "POST" || !call.path.endsWith("/session")) return undefined;
    sessions += 1;
    const grant = "55555555-5555-4555-8555-555555555555";
    return route.fulfill({status: 201, json: {modelId: "model-direct", grant, grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800,
      redeemUrl: `${viewerOrigin}/api/v1/sessions/redeem`, embedUrl: `${viewerOrigin}/session/${grant}`}});
  });
  await page.goto("/portal/viewer/grant-task/tasks/task-1?workspace=workspace-b");
  await expect(page.getByRole("button", {name: "Open secure 3D Viewer"})).toBeVisible();
  expect(calls.filter(call => call.method === "POST")).toHaveLength(0);
  expect(page.context().pages()).toHaveLength(1); // No popup or authorization request on route load.
  const popupWait = page.waitForEvent("popup");
  await page.getByRole("button", {name: "Open secure 3D Viewer"}).click();
  const popup = await popupWait;
  await expect(popup).toHaveURL(`${viewerOrigin}/session/55555555-5555-4555-8555-555555555555`);
  await expect(popup.locator("iframe")).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(sessions).toBe(1);
});
