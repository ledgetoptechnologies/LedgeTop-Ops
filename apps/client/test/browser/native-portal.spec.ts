import { expect, test, type Page, type Route } from "@playwright/test";

/** An in-app link to one exact client account (e.g. from a unified list or a notification); replaces the removed switcher. */
async function openAccount(page: Page, workspaceId: string, path = "/portal/dashboard") {
  await page.evaluate(([id, target]) => {
    const url = new URL(target, location.origin); url.searchParams.set("workspace", id);
    window.history.pushState({}, "", `${url.pathname}${url.search}`); window.dispatchEvent(new PopStateEvent("popstate"));
  }, [workspaceId, path] as const);
}

const date = "2026-08-26T12:00:00Z";
const workspaces = [
  { id: "workspace-a", rootType: "organization", rootPublicId: "org-shared", displayName: "Primary customer" },
  { id: "workspace-b", rootType: "organization", rootPublicId: "org-shared", displayName: "Coastal Surveying and Infrastructure Development", resourceMode: "native", sourceId: "project-alpha:coastal" },
  { id: "workspace-c", rootType: "organization", rootPublicId: "org-shared", displayName: "Mountain Engineering", resourceMode: "native", sourceId: "project-alpha:mountain" },
];
function workspace(id: string) { return workspaces.find(item => item.id === id)!; }
function envelope(id = "workspace-b") { return {workspaceId: id, sourceId: workspace(id).sourceId, contextVersion: `context-${id}`}; }
function features() { return {directory: {state: "available", reason: "authorized_capability"}, deliveries: {state: "available", reason: "resource_authorization_required"},
  serviceRequests: {state: "not_supported", reason: "source_not_supported"}, feedback: {state: "temporarily_unavailable", reason: "backend_unavailable"},
  models: {state: "not_supported", reason: "source_not_supported"}, team: {state: "not_supported", reason: "source_not_supported"},
  billing: {state: "not_supported", reason: "source_not_supported"}}; }
function context(id = "workspace-b") { return {workspace: workspace(id), contextVersion: `context-${id}`, features: features(), capabilities: {directoryRead: true, deliveryView: true, requestV2: false, requestAttachments: false, feedback: false, manageTeam: false, workspaceMembershipManagement: false, delegatedShares: false, viewer: false, viewerShares: false, viewBilling: false}}; }
function requestContext(id = "workspace-b", feedback = false) { const value = context(id); return {...value,
  features: {...value.features, serviceRequests: {state: "available", reason: "resource_authorization_required"}, ...(feedback ? {feedback: {state: "available", reason: "resource_authorization_required"}} : {})},
  capabilities: {...value.capabilities, requestV2: true, requestAttachments: false, feedback},
}; }
function notification(id: string, title: string, workspaceId = "workspace-b", readAt: string | null = null) { return {
  id, kind: "request", title, body: `${title} details`, actionPath: `/portal/requests?workspace=${workspaceId}`,
  mutationPath: `/api/client/notifications/${id}`, readAt, createdAt: date,
}; }
function feedbackNotification(id: string, feedbackId: string, title: string, readAt: string | null = null) { return {
  id, kind: "feedback", title, body: `${title} details`, actionPath: `/portal/feedback/${feedbackId}?workspace=workspace-b`,
  mutationPath: `/api/client/v2/workspaces/workspace-b/feedback-notifications/${id}`, readAt, createdAt: date,
}; }
function authenticatedDeliveryNotification(id: string, binding = "np1_opaque-folder-handle", readAt: string | null = null) { return {
  id, kind: "authenticated_delivery", title: "Files changed in your delivery", body: "2 files added · 1 file removed",
  actionPath: `/portal/deliveries?workspace=workspace-b&folder=${binding}`,
  mutationPath: `/api/client/notification-history/authenticated-delivery/${id}`, readAt, createdAt: date,
}; }
type NotificationCoverage = {requests: string; feedback: string; authenticatedDelivery: string; delivery: string};
function notificationHistory(items: unknown[] = [], coverage: Partial<NotificationCoverage> = {}, workspaceId = "workspace-b") { return {
  scope: {sourceId: workspace(workspaceId).sourceId, workspaceId, rootType: "organization", rootPublicId: "org-shared"}, asOf: date,
  coverage: {requests: "included", feedback: "included", authenticatedDelivery: "omitted_feature_disabled", delivery: "omitted_no_explicit_grant_authority", ...coverage}, items, nextCursor: null,
}; }
function hierarchy(id = "workspace-b") { return {...envelope(id), page: {nextCursor: null}, entries: [
  {type: "organization", publicId: "org-shared", parentType: null, parentPublicId: null, displayName: workspace(id).displayName, sourceVersion: "1"},
  {type: "department", publicId: "department-one", parentType: "organization", parentPublicId: "org-shared", displayName: "Engineering and field survey services", sourceVersion: "1"},
  {type: "project", publicId: "project-shared", parentType: "department", parentPublicId: "department-one", displayName: id === "workspace-b" ? "Coastal seawall construction documentation" : "Mountain bridge inspection", sourceVersion: "1"},
]}; }
function deliveries(id = "workspace-b", cursor: string | null = null) { return {...envelope(id), items: [{id: `folder-${id}`, displayName: `${workspace(id).displayName} — final deliverables and survey records`, owner: {type: "project", publicId: "project-shared"}}], page: {nextCursor: cursor}}; }
function file(id = "workspace-b", handle = `file-${id}`) { const base = `/api/client/v2/workspaces/${encodeURIComponent(id)}/files/${encodeURIComponent(handle)}`; return {id: handle, name: `${id}-orthomosaic-review.png`, size: 2048, uploadedAt: date, contentType: "image/png", kind: "image", previewPath: `${base}/preview`, thumbnailPath: null, downloadPath: `${base}/download`}; }
function folder(id = "workspace-b", folderId = `folder-${id}`) { return {...envelope(id), files: [file(id)], folders: [{id: `child-${id}`, name: "Edited photographs"}], breadcrumbs: [{id: `folder-${id}`, name: "Shared deliverables"}, ...(folderId.startsWith("child-") ? [{id: folderId, name: "Edited photographs"}] : [])], folderId, prefix: "", cursor: null}; }
type Call = {path: string; query: URLSearchParams; workspace?: string; method: string};
type Override = (route: Route, call: Call) => Promise<unknown> | undefined;
async function mock(page: Page, override?: Override) {
  const calls: Call[] = [];
  await page.route("**/api/client/**", async route => {
    const request = route.request(), url = new URL(request.url()), call = {path: url.pathname, query: url.searchParams, workspace: request.headers()["x-ltds-workspace-id"], method: request.method()}; calls.push(call);
    const handled = override?.(route, call); if (handled) return handled;
    if (call.path === "/api/client/session") return route.fulfill({json: {account: {id: call.workspace ? "account-a" : "", displayName: call.workspace ? "Primary customer" : "Client portal"}, capabilities: {workspaceHierarchyV2: true}}});
    if (call.path === "/api/client/v2/workspaces") return route.fulfill({json: {workspaces}});
    const match = call.path.match(/^\/api\/client\/v2\/workspaces\/(workspace-[bc])\/(.+)$/);
    if (match) {
      const id = match[1]!, suffix = match[2]!;
      if (suffix === "context") return route.fulfill({json: context(id)});
      if (suffix === "hierarchy") return route.fulfill({json: hierarchy(id)});
      if (suffix === "deliveries") return route.fulfill({json: deliveries(id)});
      if (suffix.startsWith("folders/")) return route.fulfill({json: folder(id, decodeURIComponent(suffix.slice(8)))});
      if (suffix.startsWith("files/")) {
        if (suffix.endsWith("/preview")) return route.fulfill({contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS94AAAAASUVORK5CYII=", "base64")});
        if (suffix.endsWith("/download")) return route.fulfill({headers: {"Content-Type": "image/png", "Content-Disposition": 'attachment; filename="survey.png"'}, body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS94AAAAASUVORK5CYII=", "base64")});
        return route.fulfill({json: {...envelope(id), file: file(id, decodeURIComponent(suffix.slice(6)))}});
      }
    }
    if (call.path === "/api/client/projects") return route.fulfill({json: {projects: [{id: "project-primary", externalRef: "PA-1", clientName: "Primary customer", projectName: "Primary-only project", canRequestService: false, status: "active", summary: null, siteAddress: null, serviceAddress: null, projectContactName: null, projectContactEmail: null, projectContactPhone: null, nextMilestone: null, lastUpdateAt: null}]}});
    if (call.path === "/api/client/service-requests") return route.fulfill({json: {requests: []}});
    if (call.path === "/api/client/map-config") return route.fulfill({json: {mapboxPublicToken: null}});
    if (call.path === "/api/client/notification-history") return route.fulfill({json: notificationHistory()});
    if (call.path === "/api/client/request-readiness") return route.fulfill({json: {mode: "legacy", workspaceId: "workspace-a", target: {kind: "root", projectId: null}, canStartRequest: false, reason: "request_not_permitted", root: {canStartRequest: false, reason: "request_not_permitted"}, projectRequestsSupported: false, refreshedAt: date}});
    return route.fulfill({status: 404, json: {error: "Unsupported fixture endpoint"}});
  });
  return calls;
}
async function late(route: Route, json: unknown) { try { await route.fulfill({json}); } catch { /* The old workspace request was cancelled. */ } }
function nativeCallsOnly(calls: Call[]) {
  expect(calls.filter(call => call.path !== "/api/client/session" && call.path !== "/api/client/notification-history" && !call.path.startsWith("/api/client/v2/"))).toEqual([]);
  expect(calls.every(call => call.method === "GET")).toBe(true);
  expect(calls.filter(call => call.path === "/api/client/session").every(call => call.workspace === undefined)).toBe(true);
}

test("native refresh discovers identity without the selected workspace header and never probes legacy resources", async ({page}) => {
  const calls = await mock(page); await page.goto("/portal?workspace=workspace-b");
  await expect(page.getByRole("heading", {level: 1, name: "Your projects"})).toBeVisible();
  // Stored account names can be internal labels; the page chrome and headings never show them (directory records keep their own names).
  for (const chrome of [...await page.locator("header").all(), page.locator(".unified-portal-context"), page.locator(".portal-welcome")]) await expect(chrome).not.toContainText(workspace("workspace-b").displayName);
  await expect(page.getByText("Coastal seawall construction documentation", {exact: true})).toBeVisible();
  await page.reload(); await expect(page.getByText("Coastal seawall construction documentation", {exact: true})).toBeVisible();
  nativeCallsOnly(calls); expect(calls.filter(call => call.path.endsWith("/hierarchy")).every(call => call.query.get("expectedContext") === "context-workspace-b")).toBe(true);
  await expect(page.getByRole("button", {name: /notifications/i})).toHaveCount(1);
});

test("primary compatibility and native workspace switching preserve independent projects and Back/Forward", async ({page}) => {
  const calls = await mock(page); await page.goto("/portal?workspace=workspace-a");
  await expect(page.getByText("Primary-only project", {exact: true})).toBeVisible();
  await expect(page.getByRole("combobox", {name: "Client account"})).toHaveCount(0);
  await expect(page.locator(".client-portal-header")).not.toContainText("project-alpha:");
  await openAccount(page, "workspace-b");
  await expect(page.getByText("Coastal seawall construction documentation", {exact: true})).toBeVisible();
  await expect(page.getByText("Primary-only project", {exact: true})).toHaveCount(0);
  await page.goBack(); await expect(page.getByText("Primary-only project", {exact: true})).toBeVisible();
  await page.goForward(); await expect(page.getByText("Coastal seawall construction documentation", {exact: true})).toBeVisible();
  expect(calls.filter(call => ["/api/client/projects", "/api/client/service-requests", "/api/client/map-config"].includes(call.path)).every(call => call.workspace === "workspace-a")).toBe(true);
});

test("same public project IDs remain source-separated and project links preserve workspace", async ({page}) => {
  await mock(page); await page.goto("/portal/projects?workspace=workspace-b");
  const project = page.getByRole("link", {name: /^Open project\s*: Coastal seawall construction documentation$/});
  await expect(project).toHaveAttribute("href", "/portal/projects/project-shared?workspace=workspace-b");
  await project.click(); await expect(page).toHaveURL(/\/portal\/projects\/project-shared\?workspace=workspace-b$/);
  await expect(page.getByRole("heading", {level: 1, name: "Coastal seawall construction documentation"})).toBeVisible();
  await openAccount(page, "workspace-c");
  await expect(page.getByText("Mountain bridge inspection", {exact: true})).toBeVisible();
  await expect(page.getByText("Coastal seawall construction documentation", {exact: true})).toHaveCount(0);
});

test("native project Models lists only the source-qualified adapter and never exposes resharing", async ({page}) => {
  const calls = await mock(page, (route, call) => {
    if (call.path.endsWith("workspace-b/context")) {
      const value = context();
      return route.fulfill({json: {...value,
        features: {...value.features, models: {state: "available", reason: "resource_authorization_required"}},
        capabilities: {...value.capabilities, viewer: true, viewerShares: false},
      }});
    }
    if (call.path.endsWith("workspace-b/projects/project-shared/models")) return route.fulfill({json: {
      ...envelope(), models: [{associationId: "association-one", title: "Seawall model", provider: "webodm",
        modelId: "model-one", modelVersionId: "version-one", updatedAt: date, canShare: false}],
    }});
    return undefined;
  });
  await page.goto("/portal/projects?workspace=workspace-b");
  await page.getByRole("link", {name: /^3D models/}).first().click();
  await expect(page).toHaveURL(/\/portal\/projects\/project-shared\?.*tab=models/);
  await expect(page.getByRole("heading", {name: "Seawall model"})).toBeVisible();
  await expect(page.getByRole("button", {name: "Open 3D model"})).toBeVisible();
  await expect(page.getByText(/Share 3D model/)).toHaveCount(0);
  expect(calls.some(call => call.path.endsWith("workspace-b/projects/project-shared/models") &&
    call.query.get("expectedContext") === "context-workspace-b")).toBe(true);
  expect(calls.some(call => call.path === "/api/client/projects/project-shared/models")).toBe(false);
});

test("native folders, exact preview and download remain scoped and preserve keyboard focus", async ({page}) => {
  const calls = await mock(page); await page.goto("/portal/deliveries?workspace=workspace-b");
  const folderButton = page.getByRole("button", {name: /^Open folder\s*:/}); await folderButton.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("navigation", {name: "Project file folders"})).toContainText("Shared deliverables");
  await page.getByRole("button", {name: /Edited photographs/}).click();
  await expect(page).toHaveURL(/folder=child-workspace-b/);
  const preview = page.getByRole("button", {name: "Preview", exact: true}); await preview.focus(); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {name: "Preview workspace-b-orthomosaic-review.png"}); await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("img")).toHaveAttribute("src", "/api/client/v2/workspaces/workspace-b/files/file-workspace-b/preview");
  await expect(dialog.getByRole("link", {name: "Download"})).toHaveAttribute("href", "/api/client/v2/workspaces/workspace-b/files/file-workspace-b/download");
  const downloaded = page.waitForEvent("download"); await dialog.getByRole("link", {name: "Download"}).click(); await downloaded;
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(preview).toBeFocused();
  await expect(page).not.toHaveURL(/file=/); nativeCallsOnly(calls);
});

test("exact native file deep links use metadata, not a folder or file pagination scan", async ({page}) => {
  const calls = await mock(page); await page.goto("/portal/deliveries?workspace=workspace-b&file=not-on-any-page");
  await expect(page.getByRole("dialog", {name: /Preview workspace-b/})).toBeVisible();
  expect(calls.some(call => call.path.endsWith("/files/not-on-any-page"))).toBe(true);
  expect(calls.some(call => call.path.includes("/folders/") || call.path.endsWith("/deliveries"))).toBe(false);
  await page.reload(); await expect(page.getByRole("dialog", {name: /Preview workspace-b/})).toBeVisible(); nativeCallsOnly(calls);
});

test("closing a file-only deep link returns to delivery folders and Back restores the exact preview", async ({page}) => {
  const calls = await mock(page); await page.goto("/portal/deliveries?workspace=workspace-b&file=file-workspace-b");
  const preview = page.getByRole("dialog", {name: "Preview workspace-b-orthomosaic-review.png"}); await expect(preview).toBeVisible();
  expect(calls.some(call => call.path.endsWith("/deliveries") || call.path.includes("/folders/"))).toBe(false);
  await preview.getByRole("button", {name: "Close preview"}).click();
  await expect(page).toHaveURL(/\/portal\/deliveries\?workspace=workspace-b$/);
  await expect(page.getByRole("button", {name: /^Open folder\s*:/})).toBeVisible();
  await expect(page.getByText("Open a delivery folder to browse its files.", {exact: true})).toHaveCount(0);
  const metadataBefore = calls.filter(call => call.path.endsWith("/files/file-workspace-b")).length;
  await page.goBack(); await expect(preview).toBeVisible();
  expect(calls.filter(call => call.path.endsWith("/files/file-workspace-b"))).toHaveLength(metadataBefore + 1);
  expect(calls.some(call => call.path.includes("/folders/"))).toBe(false);
  await page.goForward(); await expect(preview).toHaveCount(0); await expect(page.getByRole("button", {name: /^Open folder\s*:/})).toBeVisible();
});

test("native media keeps a synthetic reserved-character file handle encoded as one exact segment", async ({page}) => {
  const handle = "opaque file/with+symbols", calls = await mock(page);
  await page.goto(`/portal/deliveries?workspace=workspace-b&file=${encodeURIComponent(handle)}`);
  const preview = page.getByRole("dialog", {name: "Preview workspace-b-orthomosaic-review.png"}); await expect(preview).toBeVisible();
  const base = `/api/client/v2/workspaces/workspace-b/files/${encodeURIComponent(handle)}`;
  expect(calls.some(call => call.path === base)).toBe(true);
  await expect(preview.getByRole("img")).toHaveAttribute("src", `${base}/preview`);
  await expect(preview.getByRole("link", {name: "Download"})).toHaveAttribute("href", `${base}/download`);
});

test("an empty authorized delivery page with a cursor can continue and does not claim completion", async ({page}) => {
  await mock(page, (route, call) => call.path.endsWith("workspace-b/deliveries") ? route.fulfill({json: call.query.has("cursor") ? deliveries() : {...deliveries(), items: [], page: {nextCursor: "next-folders"}}}) : undefined);
  await page.goto("/portal/deliveries?workspace=workspace-b"); await expect(page.getByText(/Continue to check the remaining/)).toBeVisible();
  await page.getByRole("button", {name: "Load more delivery folders"}).click(); await expect(page.getByRole("button", {name: /^Open folder\s*:/})).toBeVisible();
});

test("native project browsing continues past an empty hierarchy page without declaring the project unavailable", async ({page}) => {
  await mock(page, (route, call) => call.path.endsWith("workspace-b/hierarchy") ? route.fulfill({json: call.query.has("cursor") ? hierarchy() : {...hierarchy(), entries: [], page: {nextCursor: "next-directory"}}}) : undefined);
  await page.goto("/portal/projects/project-shared?workspace=workspace-b");
  await expect(page.getByText("No matching records loaded yet", {exact: true})).toBeVisible();
  await expect(page.getByText("Project unavailable", {exact: true})).toHaveCount(0);
  await page.getByRole("button", {name: "Load more directory records"}).click();
  await expect(page.getByRole("heading", {level: 1, name: "Coastal seawall construction documentation"})).toBeVisible();
});

test("native folder file pagination preserves existing files and uses its opaque continuation", async ({page}) => {
  const calls = await mock(page, (route, call) => call.path.includes("workspace-b/folders/") ? route.fulfill({json: call.query.has("cursor") ? {...folder(), folders: [], files: [{...file("workspace-b", "file-second"), name: "Second survey.png"}]} : {...folder(), cursor: "next-files"}}) : undefined);
  await page.goto("/portal/deliveries?workspace=workspace-b&folder=folder-workspace-b");
  await expect(page.getByText("workspace-b-orthomosaic-review.png", {exact: true})).toBeVisible();
  await expect(page.getByText("Second survey.png", {exact: true})).toBeVisible();
  expect(calls.some(call => call.path.includes("/folders/") && call.query.get("cursor") === "next-files")).toBe(true);
});

test("native media paths cannot point to another workspace even when the metadata envelope matches", async ({page}) => {
  await mock(page, (route, call) => call.path.endsWith("workspace-b/files/file-workspace-b") ? route.fulfill({json: {...envelope(), file: {...file(), downloadPath: file("workspace-c").downloadPath}}}) : undefined);
  await page.goto("/portal/deliveries?workspace=workspace-b&file=file-workspace-b");
  await expect(page.getByRole("button", {name: "Retry portal"})).toBeVisible(); await expect(page.getByRole("dialog")).toHaveCount(0);
});

for (const field of ["previewPath", "downloadPath"] as const) test(`native ${field} rejects a different encoded file handle in the same workspace`, async ({page}) => {
  const calls = await mock(page, (route, call) => call.path.endsWith("workspace-b/files/file-workspace-b") ? route.fulfill({json: {...envelope(), file: {...file(), [field]: file("workspace-b", "file-workspace-b/other")[field]}}}) : undefined);
  await page.goto("/portal/deliveries?workspace=workspace-b&file=file-workspace-b");
  await expect(page.getByRole("button", {name: "Retry portal"})).toBeVisible(); await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(calls.some(call => call.path.includes("%2Fother"))).toBe(false);
});

test("delivery list duplicate clicks share one pending continuation", async ({page}) => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const calls = await mock(page, (route, call) => call.path.endsWith("workspace-b/deliveries") ? call.query.has("cursor") ? wait.then(() => late(route, {...deliveries(), items: [{...deliveries().items[0], id: "second-folder"}]})) : route.fulfill({json: deliveries("workspace-b", "next")}) : undefined);
  await page.goto("/portal/deliveries?workspace=workspace-b"); await page.getByRole("button", {name: "Load more delivery folders"}).dblclick();
  expect(calls.filter(call => call.path.endsWith("/deliveries") && call.query.has("cursor"))).toHaveLength(1); release();
  await expect(page.getByRole("button", {name: /^Open folder\s*:/})).toHaveCount(2);
});

test("native directory and folders recover from transient errors without fabricating empty success", async ({page}) => {
  let failed = true;
  await mock(page, (route, call) => call.path.endsWith("/hierarchy") && failed ? route.fulfill({status: 503, json: {error: "Temporary failure"}}) : undefined);
  await page.goto("/portal?workspace=workspace-b"); await expect(page.getByRole("alert")).toContainText("directory could not be loaded");
  failed = false; await page.getByRole("button", {name: "Retry directory"}).click(); await expect(page.getByText("Coastal seawall construction documentation", {exact: true})).toBeVisible();
});

for (const status of [401, 403, 409]) test(`native continuation ${status} clears every old workspace row`, async ({page}) => {
  await mock(page, (route, call) => call.path.endsWith("workspace-b/deliveries") ? call.query.has("cursor") ? route.fulfill({status, json: {error: "Context unavailable"}}) : route.fulfill({json: deliveries("workspace-b", "next")}) : undefined);
  await page.goto("/portal/deliveries?workspace=workspace-b"); await expect(page.getByRole("button", {name: /^Open folder\s*:/})).toBeVisible();
  await page.getByRole("button", {name: "Load more delivery folders"}).click(); await expect(page.getByRole("button", {name: "Retry portal"})).toBeVisible();
  await expect(page.getByRole("region", {name: "Connected client workspace"})).toHaveCount(0); await expect(page.getByRole("button", {name: /^Open folder\s*:/})).toHaveCount(0);
});

test("wrong workspace context and wrong metadata source are rejected before showing protected content", async ({page}) => {
  let corruptContext = true;
  await mock(page, (route, call) => call.path.endsWith("workspace-b/context") && corruptContext ? route.fulfill({json: context("workspace-c")}) : call.path.endsWith("workspace-b/files/file-workspace-b") ? route.fulfill({json: {...envelope("workspace-c"), file: file()}}) : undefined);
  await page.goto("/portal?workspace=workspace-b"); await expect(page.getByRole("button", {name: "Retry portal"})).toBeVisible();
  await expect(page.getByText("Coastal seawall construction documentation", {exact: true})).toHaveCount(0);
  corruptContext = false; await page.goto("/portal/deliveries?workspace=workspace-b&file=file-workspace-b");
  await expect(page.getByRole("button", {name: "Retry portal"})).toBeVisible(); await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("late folder responses cannot repopulate a newly selected workspace", async ({page}) => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const calls = await mock(page, (route, call) => call.path.includes("workspace-b/folders/") ? wait.then(() => late(route, folder())) : undefined);
  await page.goto("/portal/deliveries?workspace=workspace-b&folder=folder-workspace-b"); await expect.poll(() => calls.some(call => call.path.includes("workspace-b/folders/"))).toBe(true);
  await openAccount(page, "workspace-c");
  await expect(page.getByText("Mountain bridge inspection", {exact: true})).toBeVisible(); release();
  await expect(page).toHaveURL(/workspace=workspace-c$/); await expect(page.getByText("workspace-b-orthomosaic-review.png", {exact: true})).toHaveCount(0);
});

test("Back reauthorizes an earlier native workspace before its exact file request", async ({page}) => {
  let delayContext = false, metadataReads = 0, releaseContext!: () => void, releaseOldFile!: () => void;
  const contextWait = new Promise<void>(resolve => {releaseContext = resolve;}), fileWait = new Promise<void>(resolve => {releaseOldFile = resolve;});
  const calls = await mock(page, (route, call) => call.path.endsWith("workspace-b/context") && delayContext ? contextWait.then(() => late(route, context())) : call.path.endsWith("workspace-b/files/file-workspace-b") && ++metadataReads === 1 ? fileWait.then(() => late(route, {...envelope(), file: file()})) : undefined);
  await page.goto("/portal/deliveries?workspace=workspace-b&file=file-workspace-b");
  await expect.poll(() => metadataReads).toBe(1); await expect(page.getByText("Opening linked file…")).toBeVisible();
  await openAccount(page, "workspace-c"); await expect(page.getByText("Mountain bridge inspection", {exact: true})).toBeVisible();
  releaseOldFile(); await expect(page.getByRole("dialog")).toHaveCount(0);
  delayContext = true; const before = calls.filter(call => call.path.endsWith("workspace-b/context")).length; await page.goBack();
  await expect.poll(() => calls.filter(call => call.path.endsWith("workspace-b/context")).length).toBeGreaterThan(before);
  expect(metadataReads).toBe(1); await expect(page.getByRole("dialog")).toHaveCount(0); releaseContext();
  await expect(page.getByRole("dialog", {name: "Preview workspace-b-orthomosaic-review.png"})).toBeVisible(); expect(metadataReads).toBe(2);
  await expect(page).toHaveURL(/workspace=workspace-b&file=file-workspace-b$/); expect(calls.some(call => call.path.includes("/folders/"))).toBe(false);
});

test("native feedback submits only through the selected secondary workspace endpoint", async ({page}) => {
  const calls = await mock(page, (route, call) => {
    if (call.path.endsWith("workspace-b/context")) return route.fulfill({json: {...context(),
      features: {...features(), feedback: {state: "available", reason: "resource_authorization_required"}},
      capabilities: {...context().capabilities, feedback: true}}});
    if (call.path === "/api/client/v2/workspaces/workspace-b/feedback" && call.method === "POST") return route.fulfill({json: {feedback: {
      id: "native_feedback-test", status: "new", revision: 1, message: "Please verify this boundary.", completionNote: null,
      completedAt: null, createdAt: date, updatedAt: date, target: {kind: "project", projectId: "project-shared",
        label: "Coastal seawall construction documentation", projectName: "Coastal seawall construction documentation", available: true,
        actionPath: "/portal/projects/project-shared?workspace=workspace-b"},
    }}});
    return undefined;
  });
  await page.goto("/portal?workspace=workspace-b");
  await page.getByRole("button", {name: "Leave Feedback"}).click();
  await page.getByLabel("Your feedback").fill("Please verify this boundary.");
  await page.getByRole("button", {name: "Send feedback"}).click();
  await expect(page.getByRole("status")).toContainText("Feedback sent");
  expect(calls.some(call => call.method === "POST" && call.path === "/api/client/v2/workspaces/workspace-b/feedback")).toBe(true);
  expect(calls.some(call => call.path === "/api/client/feedback")).toBe(false);
});

for (const width of [375, 1280]) test(`native service requests expose the shared list and new-request workflow at ${width}px`, async ({page}) => {
  await page.setViewportSize({width, height: 900});
  const calls = await mock(page, (route, call) => {
    if (call.path === "/api/client/v2/workspaces/workspace-b/context") {
      const value = context("workspace-b");
      return route.fulfill({json: {...value,
        features: {...value.features, serviceRequests: {state: "available", reason: "resource_authorization_required"}},
        capabilities: {...value.capabilities, requestV2: true, requestAttachments: false}}});
    }
    if (call.path === "/api/client/service-requests") return route.fulfill({json: {requests: [{
      id: "native-request-1", projectId: "project-shared", requestType: "service", title: "Coastal progress mapping",
      details: "Capture the current work area.", location: null, preferredStartAt: null, serviceCategory: "Mapping",
      deliverables: null, siteContactName: null, siteContactEmail: null, siteContactPhone: null,
      desiredCompletionAt: null, latitude: null, longitude: null, areaGeoJson: null, poiPoints: [],
      projectAlphaDraftCreated: true, acceptedQuote: null, operationalEstimate: null, status: "accepted_pending_pa_linkage", createdAt: date, updatedAt: date,
    }]}});
    if (call.path === "/api/client/service-request-drafts") return route.fulfill({json: {drafts: []}});
    if (call.path === "/api/client/request-readiness") return route.fulfill({json: {
      mode: "catalog", workspaceId: "workspace-b", target: {kind: "root", projectId: null},
      canStartRequest: true, reason: "ready", root: {canStartRequest: true, reason: "ready"},
      projectRequestsSupported: true, refreshedAt: date,
    }});
  });
  await page.goto("/portal/requests?workspace=workspace-b");
  await expect(page.getByRole("heading", {name: "Service requests"})).toBeVisible();
  await expect(page.getByText("Coastal progress mapping", {exact: true})).toBeVisible();
  await expect(page.getByText("Quote in progress", {exact: true})).toBeVisible();
  await expect(page.getByText("We’ll send it for you to review. Nothing is accepted until you approve it.", {exact: true})).toBeVisible();
  await page.getByRole("button", {name: "Submit new request"}).click();
  await expect(page).toHaveURL(/\/portal\/requests\/new\?workspace=workspace-b/);
  await expect(page.getByRole("heading", {name: "Define your site and scope"})).toBeVisible();
  await page.goto("/portal/projects/project-shared?tab=requests&workspace=workspace-b");
  await expect(page.getByRole("heading", {name: "Request additional service"})).toBeVisible();
  await expect(page.getByRole("heading", {name: "Project request history"})).toBeVisible();
  await expect(page.getByText("Coastal progress mapping", {exact: true})).toBeVisible();
  await expect(page.getByRole("heading", {name: "Feature unavailable"})).toHaveCount(0);
  expect(calls.filter(call => call.path.startsWith("/api/client/service-") || call.path === "/api/client/request-readiness")
    .every(call => call.workspace === "workspace-b")).toBe(true);
});

test("native notification bell keeps request and feedback updates in the exact workspace", async ({page}) => {
  const notices = [notification("notice-new", "Coastal request accepted"), notification("notice-second", "Coastal request reviewed")];
  const feedbackNotices = [feedbackNotification("feedback-notice", "native_feedback-one", "Coastal feedback completed")];
  const mutations: Array<{kind: "request" | "feedback"; id: string; action: string; workspace?: string}> = [];
  const calls = await mock(page, (route, call) => {
    if (call.path === "/api/client/v2/workspaces/workspace-b/context") return route.fulfill({json: requestContext("workspace-b", true)});
    if (call.path === "/api/client/notification-history" && call.method === "GET") return route.fulfill({json: notificationHistory([...notices, ...feedbackNotices])});
    const match = call.path.match(/^\/api\/client\/notifications\/([^/]+)$/);
    if (match && call.method === "PATCH") {
      const action = (route.request().postDataJSON() as {action: "read" | "dismiss"}).action;
      mutations.push({kind: "request", id: match[1]!, action, workspace: call.workspace});
      const item = notices.find(value => value.id === match[1]);
      if (item && action === "read") item.readAt = date;
      if (item && action === "dismiss") notices.splice(notices.indexOf(item), 1);
      return route.fulfill({json: {success: true}});
    }
    const feedbackMatch = call.path.match(/^\/api\/client\/v2\/workspaces\/workspace-b\/feedback-notifications\/([^/]+)$/);
    if (feedbackMatch && call.method === "PATCH") {
      const action = (route.request().postDataJSON() as {action: "read" | "dismiss"}).action;
      mutations.push({kind: "feedback", id: feedbackMatch[1]!, action, workspace: call.workspace});
      const item = feedbackNotices.find(value => value.id === feedbackMatch[1]);
      if (item && action === "read") item.readAt = date;
      if (item && action === "dismiss") feedbackNotices.splice(feedbackNotices.indexOf(item), 1);
      return route.fulfill({json: {success: true}});
    }
    return undefined;
  });
  await page.goto("/portal?workspace=workspace-b");
  const bell = page.locator(".portal-notification-bell");
  await expect(bell).toHaveAccessibleName(/Notifications, 3 unread updates/); await bell.click();
  const panel = page.getByRole("region", {name: "Notifications"});
  await expect(panel).toContainText("Coastal request accepted");
  await expect(panel).toContainText("Coastal feedback completed");
  const first = panel.locator("article", {hasText: "Coastal request accepted"});
  const second = panel.locator("article", {hasText: "Coastal request reviewed"});
  const feedbackItem = panel.locator("article", {hasText: "Coastal feedback completed"});
  await expect(first.getByRole("link", {name: "Coastal request accepted"})).toHaveAttribute("href", "/portal/requests?workspace=workspace-b");
  await expect(feedbackItem.getByRole("link", {name: "Coastal feedback completed"})).toHaveAttribute("href", "/portal/feedback/native_feedback-one?workspace=workspace-b");
  await first.getByRole("button", {name: "Mark read"}).click();
  await expect(bell).toHaveAccessibleName(/Notifications, 2 unread updates/);
  await feedbackItem.getByRole("button", {name: "Dismiss"}).click();
  await expect(feedbackItem).toHaveCount(0);
  await second.getByRole("button", {name: "Dismiss"}).click();
  await expect(second).toHaveCount(0);
  await first.getByRole("link", {name: "Coastal request accepted"}).click();
  await expect(page).toHaveURL(/\/portal\/requests\?workspace=workspace-b$/);
  expect(mutations).toEqual([
    {kind: "request", id: "notice-new", action: "read", workspace: "workspace-b"},
    {kind: "feedback", id: "feedback-notice", action: "dismiss", workspace: undefined},
    {kind: "request", id: "notice-second", action: "dismiss", workspace: "workspace-b"},
    {kind: "request", id: "notice-new", action: "read", workspace: "workspace-b"},
  ]);
  // The unified bell reads every account with its own scope; each update is changed only in its own account.
  expect(calls.filter(call => call.path.startsWith("/api/client/notifications/")).every(call => call.workspace === "workspace-b")).toBe(true);
  expect(calls.filter(call => call.path === "/api/client/notification-history").every(call => ["workspace-a", "workspace-b", "workspace-c"].includes(call.workspace ?? ""))).toBe(true);
  expect(calls.filter(call => call.path.includes("feedback-notifications")).every(call => call.path.startsWith("/api/client/v2/workspaces/workspace-b/") && call.workspace === undefined)).toBe(true);
});

test("native feedback-only workspaces show the bell without probing request notifications", async ({page}) => {
  const calls = await mock(page, (route, call) => {
    if (call.path === "/api/client/v2/workspaces/workspace-b/context") {
      const value = context("workspace-b"); return route.fulfill({json: {...value,
        features: {...value.features, feedback: {state: "available", reason: "resource_authorization_required"}},
        capabilities: {...value.capabilities, feedback: true},
      }});
    }
    if (call.path === "/api/client/notification-history") return route.fulfill({json: notificationHistory([
      feedbackNotification("feedback-only-notice", "native_feedback-only", "Feedback-only update"),
    ], {requests: "omitted_feature_disabled", feedback: "included"})});
    return undefined;
  });
  await page.goto("/portal?workspace=workspace-b");
  const bell = page.getByRole("button", {name: /Notifications, 1 unread update/}); await expect(bell).toBeVisible(); await bell.click();
  const panel = page.getByRole("region", {name: "Notifications"});
  await expect(panel).toContainText("Feedback-only update");
  expect(calls.some(call => call.path === "/api/client/notification-history")).toBe(true);
  expect(calls.some(call => call.path.includes("feedback-notifications"))).toBe(false);
});

test("native delivery-only workspaces show authenticated delivery summaries with their exact mutation and folder action", async ({page}) => {
  const notice = authenticatedDeliveryNotification("delivery-change-one");
  const mutations: Array<{action: string; workspace?: string}> = [];
  const calls = await mock(page, (route, call) => {
    if (call.path === "/api/client/notification-history" && call.method === "GET") return route.fulfill({json: notificationHistory([notice], {
      requests: "omitted_feature_disabled", feedback: "omitted_feature_disabled", authenticatedDelivery: "included",
    })});
    if (call.path === "/api/client/notification-history/authenticated-delivery/delivery-change-one" && call.method === "PATCH") {
      mutations.push({action: (route.request().postDataJSON() as {action: string}).action, workspace: call.workspace});
      return route.fulfill({json: {success: true}});
    }
    return undefined;
  });
  await page.goto("/portal?workspace=workspace-b");
  const bell = page.getByRole("button", {name: /Notifications, 1 unread update/}); await expect(bell).toBeVisible(); await bell.click();
  const item = page.getByRole("region", {name: "Notifications"}).locator("article", {hasText: "Files changed in your delivery"});
  await expect(item).toContainText("2 files added · 1 file removed");
  await expect(item.getByRole("link", {name: "Files changed in your delivery"})).toHaveAttribute("href", "/portal/deliveries?workspace=workspace-b&folder=np1_opaque-folder-handle");
  await expect(item).toContainText("Delivery");
  await item.getByRole("button", {name: "Mark read"}).click();
  await item.getByRole("button", {name: "Dismiss"}).click();
  await expect(item).toHaveCount(0);
  expect(mutations).toEqual([{action: "read", workspace: "workspace-b"}, {action: "dismiss", workspace: "workspace-b"}]);
  expect(calls.some(call => call.path === "/api/client/notification-history" && call.workspace === "workspace-b")).toBe(true);
});

test("authenticated delivery summaries without an exact folder action stay visible but non-linkable", async ({page}) => {
  const notice = {...authenticatedDeliveryNotification("delivery-change-no-action"), actionPath: null};
  await mock(page, (route, call) => call.path === "/api/client/notification-history" && call.method === "GET" ? route.fulfill({json: notificationHistory([notice], {
    requests: "omitted_feature_disabled", feedback: "omitted_feature_disabled", authenticatedDelivery: "included",
  })}) : undefined);
  await page.goto("/portal?workspace=workspace-b");
  await page.getByRole("button", {name: /Notifications, 1 unread update/}).click();
  const item = page.getByRole("region", {name: "Notifications"}).locator("article", {hasText: "Files changed in your delivery"});
  await expect(item).toContainText("2 files added · 1 file removed");
  await expect(item.getByRole("link", {name: "Files changed in your delivery"})).toHaveCount(0);
});

test("an authenticated delivery link stays put when its mark-read update cannot be confirmed", async ({page}) => {
  const notice = authenticatedDeliveryNotification("delivery-change-read-failed");
  const calls = await mock(page, (route, call) => {
    if (call.path === "/api/client/notification-history") return route.fulfill({json: notificationHistory([notice], {
      requests: "omitted_feature_disabled", feedback: "omitted_feature_disabled", authenticatedDelivery: "included",
    })});
    if (call.path === "/api/client/notification-history/authenticated-delivery/delivery-change-read-failed" && call.method === "PATCH") return route.fulfill({status: 503, json: {error: "Retry"}});
    return undefined;
  });
  await page.goto("/portal?workspace=workspace-b");
  await page.getByRole("button", {name: /Notifications, 1 unread update/}).click();
  const panel = page.getByRole("region", {name: "Notifications"});
  await panel.getByRole("link", {name: "Files changed in your delivery"}).click();
  await expect(page).toHaveURL(/\/portal\?workspace=workspace-b$/);
  await expect(panel.getByRole("alert").filter({hasText: "The notification update could not be confirmed."})).toBeVisible();
  expect(calls.filter(call => call.path.endsWith("/delivery-change-read-failed") && call.method === "PATCH")).toHaveLength(1);
});

test("the unified bell keeps every account's updates, each labelled and scoped, across opening another account", async ({page}) => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const calls = await mock(page, (route, call) => {
    if (/\/api\/client\/v2\/workspaces\/workspace-[bc]\/context$/.test(call.path)) {
      const id = call.path.includes("workspace-b") ? "workspace-b" : "workspace-c";
      return route.fulfill({json: requestContext(id)});
    }
    if (call.path === "/api/client/notification-history" && call.method === "GET") {
      if (call.workspace === "workspace-b") return wait.then(() => late(route, notificationHistory([notification("coastal-late", "Coastal late update")])));
      if (call.workspace === "workspace-c") return route.fulfill({json: notificationHistory([notification("mountain-current", "Mountain current update", "workspace-c")], undefined, "workspace-c")});
      return route.fulfill({json: {...notificationHistory([], undefined, "workspace-b"), scope: {sourceId: "project-alpha:primary", workspaceId: call.workspace ?? null, rootType: "organization", rootPublicId: "org-shared"}}});
    }
    return undefined;
  });
  await page.goto("/portal?workspace=workspace-b");
  await expect.poll(() => calls.some(call => call.path === "/api/client/notification-history" && call.workspace === "workspace-b")).toBe(true);
  await openAccount(page, "workspace-c");
  const bell = page.getByRole("button", {name: /Notifications, 1 unread update/}); await expect(bell).toBeVisible(); await bell.click();
  const panel = page.getByRole("region", {name: "Notifications"});
  await expect(panel.getByText("Mountain current update", {exact: true})).toBeVisible();
  await expect(panel).toContainText("Ledge Top 2");
  await expect(panel).not.toContainText("Mountain Engineering");
  release();
  await expect(panel.getByText("Coastal late update", {exact: true})).toBeVisible();
  await expect(panel).toContainText("Ledge Top 1");
  await expect(page.getByRole("button", {name: /Notifications, 2 unread updates/})).toBeVisible();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  expect(new Set(calls.filter(call => call.path === "/api/client/notification-history").map(call => call.workspace))).toEqual(new Set(["workspace-a", "workspace-b", "workspace-c"]));
});

/** One account's notification page, scoped exactly to that account. */
function accountHistory(workspaceId: string, items: unknown[] = [], nextCursor: string | null = null) {
  return {...notificationHistory(items, undefined, workspaceId === "workspace-a" ? "workspace-b" : workspaceId),
    scope: {sourceId: workspace(workspaceId).sourceId ?? "project-alpha:primary", workspaceId, rootType: "organization", rootPublicId: "org-shared"}, nextCursor};
}
const historyCalls = (calls: Call[], workspaceId: string) => calls.filter(call => call.path === "/api/client/notification-history" && call.method === "GET" && call.workspace === workspaceId);
async function openUnifiedBell(page: Page) {
  await page.goto("/portal?workspace=workspace-b");
  await page.locator(".portal-notification-bell").click();
  return page.getByRole("region", {name: "Notifications"});
}
const revalidate = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("focus")));

test("the unified bell retries only the account that failed and keeps the others' pages", async ({page}) => {
  let mountainFails = true;
  const calls = await mock(page, (route, call) => {
    if (call.path === "/api/client/v2/workspaces/workspace-b/context") return route.fulfill({json: requestContext()});
    if (call.path !== "/api/client/notification-history" || call.method !== "GET") return undefined;
    if (call.workspace === "workspace-b") return route.fulfill({json: call.query.get("cursor")
      ? accountHistory("workspace-b", [notification("coastal-older", "Coastal older update")])
      : accountHistory("workspace-b", [notification("coastal-first", "Coastal first update")], "coastal-cursor")});
    if (call.workspace === "workspace-c") return mountainFails ? route.fulfill({status: 503, json: {error: "Retry"}})
      : route.fulfill({json: accountHistory("workspace-c", [notification("mountain-recovered", "Mountain recovered update", "workspace-c")])});
    return route.fulfill({json: accountHistory(call.workspace ?? "workspace-a")});
  });
  const panel = await openUnifiedBell(page);
  await expect(panel.getByText("Coastal first update", {exact: true})).toBeVisible();
  await expect(panel.getByRole("alert")).toContainText("Ledge Top 2");
  // Coverage is incomplete while an account is missing.
  await expect(panel).toContainText("Request history is currently unavailable.");
  mountainFails = false;
  await panel.getByRole("button", {name: "Retry notifications"}).click();
  await expect(panel.getByText("Mountain recovered update", {exact: true})).toBeVisible();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(panel).toContainText("Request history is shown.");
  expect(historyCalls(calls, "workspace-b")).toHaveLength(1);
  expect(historyCalls(calls, "workspace-c").map(call => call.query.get("cursor"))).toEqual([null, null]);
  await panel.getByRole("button", {name: "Load more updates"}).click();
  await expect(panel.getByText("Coastal older update", {exact: true})).toBeVisible();
  expect(historyCalls(calls, "workspace-b").map(call => call.query.get("cursor"))).toEqual([null, "coastal-cursor"]);
});

test("a refused read or dismiss withdraws only that account's updates and pending actions", async ({page}) => {
  let mountainRevoked = false;
  const calls = await mock(page, (route, call) => {
    if (call.path === "/api/client/v2/workspaces/workspace-b/context") return route.fulfill({json: requestContext()});
    if (call.path === "/api/client/notifications/mountain-one" && call.method === "PATCH") return route.fulfill({status: 403, json: {error: "Forbidden"}});
    if (call.path !== "/api/client/notification-history" || call.method !== "GET") return undefined;
    if (call.workspace === "workspace-b") return route.fulfill({json: accountHistory("workspace-b", [notification("coastal-one", "Coastal update")])});
    if (call.workspace === "workspace-c") return mountainRevoked ? route.fulfill({status: 403, json: {error: "Forbidden"}})
      : route.fulfill({json: accountHistory("workspace-c", [notification("mountain-one", "Mountain update", "workspace-c")])});
    return route.fulfill({json: accountHistory(call.workspace ?? "workspace-a")});
  });
  const panel = await openUnifiedBell(page);
  const mountain = panel.locator("article").filter({hasText: "Mountain update"});
  await expect(mountain).toBeVisible();
  mountainRevoked = true;
  await mountain.getByRole("button", {name: "Dismiss"}).click();
  await expect(mountain).toHaveCount(0);
  await expect(panel.getByText("Coastal update", {exact: true})).toBeVisible();
  // The refused account is rechecked straight away, and stays withdrawn.
  await expect.poll(() => historyCalls(calls, "workspace-c").length).toBe(2);
  await expect(panel.getByRole("alert").first()).toContainText(/no longer available|could not be loaded/);
  await expect(page.getByRole("button", {name: /Notifications, 1 unread update$/})).toBeVisible();
});

test("the unified bell revalidates on focus and drops an account revoked after load", async ({page}) => {
  let revoked = false;
  const calls = await mock(page, (route, call) => {
    if (call.path === "/api/client/v2/workspaces/workspace-b/context") return route.fulfill({json: requestContext()});
    if (call.path !== "/api/client/notification-history" || call.method !== "GET") return undefined;
    if (call.workspace === "workspace-c") return revoked ? route.fulfill({status: 403, json: {error: "Forbidden"}})
      : route.fulfill({json: accountHistory("workspace-c", [notification("mountain-one", "Mountain update", "workspace-c")])});
    return route.fulfill({json: accountHistory(call.workspace ?? "workspace-a", call.workspace === "workspace-b" ? [notification("coastal-one", "Coastal update")] : [])});
  });
  const panel = await openUnifiedBell(page);
  await expect(panel.getByText("Mountain update", {exact: true})).toBeVisible();
  revoked = true;
  await page.waitForTimeout(1100);
  await revalidate(page);
  await expect(panel.getByText("Mountain update", {exact: true})).toHaveCount(0);
  await expect(panel.getByText("Coastal update", {exact: true})).toBeVisible();
  await expect(panel.getByRole("alert")).toContainText("Ledge Top 2");
  expect(historyCalls(calls, "workspace-c")).toHaveLength(2);
});

test("a late reply from an earlier read never replaces the newer one", async ({page}) => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  let coastalReads = 0;
  await mock(page, (route, call) => {
    if (call.path === "/api/client/v2/workspaces/workspace-b/context") return route.fulfill({json: requestContext()});
    if (call.path !== "/api/client/notification-history" || call.method !== "GET") return undefined;
    if (call.workspace === "workspace-b" && ++coastalReads === 1) return wait.then(() => late(route, accountHistory("workspace-b", [notification("coastal-stale", "Coastal stale update")])));
    if (call.workspace === "workspace-b") return route.fulfill({json: accountHistory("workspace-b", [notification("coastal-fresh", "Coastal fresh update")])});
    return route.fulfill({json: accountHistory(call.workspace ?? "workspace-a")});
  });
  const panel = await openUnifiedBell(page);
  await expect.poll(() => coastalReads).toBe(1);
  await page.waitForTimeout(1100);
  await revalidate(page);
  await expect(panel.getByText("Coastal fresh update", {exact: true})).toBeVisible();
  release();
  await page.waitForTimeout(300);
  await expect(panel.getByText("Coastal stale update", {exact: true})).toHaveCount(0);
  await expect(panel.getByText("Coastal fresh update", {exact: true})).toBeVisible();
});

test("without request support the bell still resets on a verified context change and drops stale reads and updates", async ({page}) => {
  let releaseRead!: () => void; const heldRead = new Promise<void>(resolve => { releaseRead = resolve; });
  let releasePatch!: () => void; const heldPatch = new Promise<void>(resolve => { releasePatch = resolve; });
  let coastalReads = 0;
  const calls = await mock(page, (route, call) => {
    // The default contexts have requestV2 = false.
    if (call.path === "/api/client/notifications/coastal-one" && call.method === "PATCH") return heldPatch.then(() => late(route, {ok: true}));
    if (call.path !== "/api/client/notification-history" || call.method !== "GET") return undefined;
    if (call.workspace === "workspace-b") {
      coastalReads += 1;
      if (coastalReads === 2) return heldRead.then(() => late(route, accountHistory("workspace-b", [notification("coastal-stale", "Coastal stale update")])));
      return route.fulfill({json: accountHistory("workspace-b", [notification("coastal-one", "Coastal update")])});
    }
    return route.fulfill({json: accountHistory(call.workspace ?? "workspace-a")});
  });
  const panel = await openUnifiedBell(page);
  const coastal = panel.locator("article").filter({hasText: "Coastal update"});
  await expect(coastal).toBeVisible();
  await coastal.getByRole("button", {name: "Mark read"}).click();
  await page.waitForTimeout(1100);
  await revalidate(page);
  await expect.poll(() => coastalReads).toBe(2);
  // Same accounts, new verified context (workspace-c, context-workspace-c): both in-flight results are stale.
  await openAccount(page, "workspace-c");
  await expect.poll(() => coastalReads).toBe(3);
  releasePatch(); releaseRead();
  await page.waitForTimeout(300);
  await page.locator(".portal-notification-bell").click();
  const fresh = page.getByRole("region", {name: "Notifications"});
  await expect(fresh.locator("article").filter({hasText: "Coastal update"}).getByRole("button", {name: "Mark read"})).toBeVisible();
  await expect(fresh.getByText("Coastal stale update", {exact: true})).toHaveCount(0);
  await expect(page.getByRole("button", {name: /Notifications, 1 unread update$/})).toBeVisible();
  expect(calls.filter(call => call.path === "/api/client/notifications/coastal-one" && call.method === "PATCH")).toHaveLength(1);
});

for (const width of [390, 1280]) test(`native notification bell is accessible and contained at ${width}px`, async ({page}) => {
  await page.setViewportSize({width, height: 800});
  await mock(page, (route, call) => {
    if (call.path === "/api/client/v2/workspaces/workspace-b/context") return route.fulfill({json: requestContext()});
    if (call.path === "/api/client/notification-history") return route.fulfill({json: notificationHistory([notification("notice-responsive", "Responsive native update")])});
    return undefined;
  });
  await page.goto("/portal?workspace=workspace-b");
  const bell = page.getByRole("button", {name: /Notifications, 1 unread update/});
  await expect(bell).toBeVisible(); await bell.click();
  const panel = page.getByRole("region", {name: "Notifications"}); await expect(panel).toBeVisible();
  const box = await panel.boundingBox(); expect(box && box.x >= 0 && box.x + box.width <= width).toBeTruthy();
  await expect(panel.getByText("Responsive native update", {exact: true})).toBeVisible();
  await page.keyboard.press("Escape"); await expect(panel).toHaveCount(0); await expect(bell).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

for (const path of ["/portal/requests", "/portal/requests/new", "/portal/feedback", "/portal/account", "/portal/projects/project-shared?tab=models", "/portal/projects/project-shared?tab=requests"]) test(`native unsupported feature ${path} is explicit without legacy or Viewer probes`, async ({page}) => {
  const calls = await mock(page); await page.goto(`${path}${path.includes("?") ? "&" : "?"}workspace=workspace-b`);
  await expect(page.getByRole("heading", {name: "Available features"})).toBeVisible();
  await expect(page.getByText("They are not services purchased or assigned to your organization.", {exact: false})).toBeVisible();
  nativeCallsOnly(calls); await expect(page.getByRole("button", {name: /New request|Leave Feedback|Invite/i})).toHaveCount(0);
});

test("capabilities absent from native context do not produce optimistic directory or delivery probes", async ({page}) => {
  const calls = await mock(page, (route, call) => call.path.endsWith("workspace-b/context") ? route.fulfill({json: {...context(), features: {...features(), directory: {state: "not_in_access", reason: "capability_not_granted"}, deliveries: {state: "temporarily_unavailable", reason: "backend_unavailable"}}, capabilities: {...context().capabilities, directoryRead: false, deliveryView: false}}}) : undefined);
  await page.goto("/portal?workspace=workspace-b"); await expect(page.getByText("The directory is not included in your current access.")).toBeVisible();
  await expect(page.getByText("Not in access", {exact: true})).toBeVisible();
  await page.goto("/portal/deliveries?workspace=workspace-b"); await expect(page.getByText("Delivery viewing is not included in your current access.")).toBeVisible();
  expect(calls.some(call => /\/(hierarchy|deliveries)$/.test(call.path))).toBe(false);
});

test("native feature readiness is operational status, not purchased services or optimistic secondary features", async ({page}) => {
  const calls = await mock(page); await page.goto("/portal?workspace=workspace-b");
  const surface = page.locator(".ltds-card").filter({has: page.getByRole("heading", {name: "Available features"})});
  await expect(surface).toContainText("Ready");
  await expect(surface).toContainText("Not connected");
  await expect(surface).toContainText("Existing authorized request history remains unchanged.");
  await expect(surface).toContainText("not services purchased or assigned");
  nativeCallsOnly(calls);
});

for (const width of [1280, 390]) test(`secondary workspace member management is source-aware and responsive at ${width}px`, async ({page}) => {
  const invitations = [{id: "invitation-pending", email: "pending@example.test", status: "pending", scope: {type: "project", publicId: "project-shared"}, capabilities: ["delivery.view"], expiresAt: "2099-01-01T00:00:00Z", accessTerms: null}];
  const members = [
    {identityId: "source-manager", email: "manager@example.test", status: "active", manager: true, source: "project_alpha", managerVersion: 1, canChangeManager: false},
    {identityId: "invited-active", email: "active@example.test", status: "active", manager: false, source: "client_invitation", managerVersion: 0, canChangeManager: false},
    {identityId: "invited-suspended", email: "suspended@example.test", status: "suspended", manager: false, source: "client_invitation", managerVersion: 0, canChangeManager: false},
  ];
  const calls = await mock(page, (route, call) => {
    if (call.path === "/api/client/session") return route.fulfill({json: {account: {id: "", displayName: "Client portal"}, capabilities: {workspaceHierarchyV2: true, workspaceMembershipManagement: true, hierarchyScopedInvitations: true, invitationEmailDelivery: true}}});
    if (call.path === "/api/client/v2/workspaces/workspace-b/access") return route.fulfill({json: {
      sourceId: "project-alpha:coastal", sourceName: "Project Alpha", workspaceName: workspace("workspace-b").displayName,
      canManageMembers: true, peerAdminManagement: false, invitationRequestsSupported: false,
      addressBookAvailable: false, canManageAddressBook: false,
      inviteScopes: [{type: "project", publicId: "project-shared", displayName: "Coastal seawall construction documentation", capabilities: ["delivery.view", "request.create"], projectEndSupported: true}],
      members, invitations, invitationPolicy: {mode: "allowed", version: 4}, projectAccessTermsSupported: true,
      projectAccessOptions: [{projectPublicId: "project-shared", projectEndSupported: true}],
    }});
    if (call.path === "/api/client/v2/workspaces/workspace-b/invitations" && call.method === "POST") {
      const input = route.request().postDataJSON() as {email: string; targetScope: {type: string; publicId: string}; capabilities: string[]};
      invitations.unshift({id: "invitation-created", email: input.email, status: "pending", scope: input.targetScope, capabilities: input.capabilities, expiresAt: "2099-01-02T00:00:00Z", accessTerms: null});
      return route.fulfill({status: 201, json: {outcome: "created"}});
    }
    if (call.path === "/api/client/v2/workspaces/workspace-b/members/invited-active" && call.method === "DELETE") {
      members[1] = {...members[1]!, status: "suspended"}; return route.fulfill({status: 204});
    }
    if (call.path === "/api/client/v2/workspaces/workspace-b/invitations/invitation-pending" && call.method === "DELETE") {
      invitations.splice(invitations.findIndex(value => value.id === "invitation-pending"), 1); return route.fulfill({status: 204});
    }
    return undefined;
  });
  await page.setViewportSize({width, height: 900}); await page.goto("/portal/account?workspace=workspace-b");
  await expect(page.getByRole("heading", {name: "Invite a collaborator"})).toBeVisible();
  const source = page.locator(".portal-team-row", {hasText: "manager@example.test"});
  await expect(source).toContainText("Source-managed member"); await expect(source).toContainText("managed in this Project Alpha source");
  await expect(source.getByRole("button", {name: /Suspend|administrator/i})).toHaveCount(0);
  const active = page.locator(".portal-team-row", {hasText: "active@example.test"});
  await expect(active).toContainText("Locally invited collaborator"); await expect(active.getByRole("button", {name: "Suspend"})).toBeVisible();
  const suspended = page.locator(".portal-team-row", {hasText: "suspended@example.test"});
  await expect(suspended).toContainText("Member · suspended"); await expect(suspended.getByRole("button", {name: "Suspend"})).toHaveCount(0);
  await expect(page.locator(".portal-team-row", {hasText: "pending@example.test"})).toContainText("pending");
  await expect(page.getByRole("heading", {name: "Your invitation requests"})).toHaveCount(0);
  await page.getByLabel("Email address").fill("new@example.test");
  await page.getByRole("button", {name: "Review invitation"}).click(); await page.getByRole("button", {name: "Send invitation"}).click();
  await expect(page.locator(".portal-team-row", {hasText: "new@example.test"})).toContainText("pending");
  await active.getByRole("button", {name: "Suspend"}).click(); await expect(active).toContainText("Member · suspended");
  const pending = page.locator(".portal-team-row", {hasText: "pending@example.test"}); await pending.getByRole("button", {name: "Revoke"}).click(); await expect(pending).toHaveCount(0);
  expect(calls.filter(call => call.method === "POST" || call.method === "DELETE").map(call => `${call.method} ${call.path}`)).toEqual([
    "POST /api/client/v2/workspaces/workspace-b/invitations",
    "DELETE /api/client/v2/workspaces/workspace-b/members/invited-active",
    "DELETE /api/client/v2/workspaces/workspace-b/invitations/invitation-pending",
  ]);
  expect(calls.some(call => call.path.endsWith("workspace-b/access") && call.method === "GET")).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("native team rejects a valid access envelope from the wrong source before rendering protected controls", async ({page}) => {
  await mock(page, (route, call) => {
    if (call.path === "/api/client/session") return route.fulfill({json: {account: {id: "", displayName: "Client portal"}, capabilities: {workspaceHierarchyV2: true, workspaceMembershipManagement: true, hierarchyScopedInvitations: true, invitationEmailDelivery: true}}});
    if (call.path === "/api/client/v2/workspaces/workspace-b/access") return route.fulfill({json: {
      sourceId: "project-alpha:mountain", sourceName: "Project Alpha", workspaceName: "Wrong source",
      canManageMembers: true, peerAdminManagement: true, invitationRequestsSupported: true, addressBookAvailable: true, canManageAddressBook: true,
      inviteScopes: [], members: [{identityId: "leaked", email: "leaked@example.test", status: "active", manager: true, source: "project_alpha"}], invitations: [],
      invitationPolicy: {mode: "allowed", version: 1}, projectAccessTermsSupported: true, projectAccessOptions: [],
    }});
    return undefined;
  });
  await page.goto("/portal/account?workspace=workspace-b");
  await expect(page.getByRole("alert")).toContainText("client account could not be verified");
  await expect(page.getByText("leaked@example.test", {exact: true})).toHaveCount(0);
  await expect(page.getByRole("heading", {name: "Invite a collaborator"})).toHaveCount(0);
  await expect(page.getByRole("button", {name: /administrator|Suspend|approval/i})).toHaveCount(0);
});

test("member authority loss clears ambiguous retries and every protected team control", async ({page}) => {
  let canManage = true;
  await mock(page, (route, call) => {
    if (call.path === "/api/client/session") return route.fulfill({json: {account: {id: "", displayName: "Client portal"}, capabilities: {workspaceHierarchyV2: true, workspaceMembershipManagement: true, hierarchyScopedInvitations: true, invitationEmailDelivery: true}}});
    if (call.path === "/api/client/v2/workspaces/workspace-b/access") return route.fulfill({json: {
      sourceId: "project-alpha:coastal", sourceName: "Project Alpha", workspaceName: workspace("workspace-b").displayName,
      canManageMembers: canManage, peerAdminManagement: false, invitationRequestsSupported: false,
      inviteScopes: [{type: "project", publicId: "project-shared", displayName: "Project", capabilities: ["delivery.view"], projectEndSupported: true}],
      members: canManage ? [{identityId: "local", email: "local@example.test", status: "active", manager: false, source: "client_invitation"}] : [], invitations: [],
      invitationPolicy: {mode: "allowed", version: 1}, projectAccessTermsSupported: true, projectAccessOptions: [{projectPublicId: "project-shared", projectEndSupported: true}],
    }});
    if (call.path === "/api/client/v2/workspaces/workspace-b/invitations" && call.method === "POST") { canManage = false; return route.abort("failed"); }
    return undefined;
  });
  await page.goto("/portal/account?workspace=workspace-b"); await page.getByLabel("Email address").fill("uncertain@example.test");
  await page.getByRole("button", {name: "Review invitation"}).click(); await page.getByRole("button", {name: "Send invitation"}).click();
  await expect(page.getByRole("button", {name: "Retry same invitation"})).toBeVisible();
  await page.getByRole("button", {name: "Refresh team access"}).click();
  await expect(page.getByText("Team member records are not available in your current verified access.", {exact: false})).toBeVisible();
  await expect(page.getByRole("button", {name: "Retry same invitation"})).toHaveCount(0);
  await expect(page.getByRole("heading", {name: /Invite a collaborator|People|Invitations/})).toHaveCount(0);
  await expect(page.getByText("local@example.test", {exact: true})).toHaveCount(0);
});

test("transient access refresh preserves the exact ambiguous invitation retry", async ({page}) => {
  let accessReads = 0, invitationWrites = 0; const keys: Array<string | undefined> = [];
  await mock(page, (route, call) => {
    if (call.path === "/api/client/session") return route.fulfill({json: {account: {id: "", displayName: "Client portal"}, capabilities: {workspaceHierarchyV2: true, workspaceMembershipManagement: true, hierarchyScopedInvitations: true, invitationEmailDelivery: true}}});
    if (call.path === "/api/client/v2/workspaces/workspace-b/access") {
      accessReads++; if (accessReads === 2) return route.fulfill({status: 503, json: {error: "Temporary access failure"}});
      return route.fulfill({json: {
        sourceId: "project-alpha:coastal", sourceName: "Project Alpha", workspaceName: workspace("workspace-b").displayName,
        canManageMembers: true, peerAdminManagement: false, invitationRequestsSupported: false,
        inviteScopes: [{type: "project", publicId: "project-shared", displayName: "Project", capabilities: ["delivery.view"], projectEndSupported: true}],
        members: [], invitations: [], invitationPolicy: {mode: "allowed", version: 1}, projectAccessTermsSupported: true,
        projectAccessOptions: [{projectPublicId: "project-shared", projectEndSupported: true}],
      }});
    }
    if (call.path === "/api/client/v2/workspaces/workspace-b/invitations" && call.method === "POST") {
      invitationWrites++; keys.push(route.request().headers()["idempotency-key"]);
      return invitationWrites === 1 ? route.abort("failed") : route.fulfill({status: 200, json: {outcome: "replayed"}});
    }
    return undefined;
  });
  await page.goto("/portal/account?workspace=workspace-b"); await page.getByLabel("Email address").fill("retry@example.test");
  await page.getByRole("button", {name: "Review invitation"}).click(); await page.getByRole("button", {name: "Send invitation"}).click();
  const retry = page.getByRole("button", {name: "Retry same invitation"}); await expect(retry).toBeVisible();
  await page.getByRole("button", {name: "Refresh team access"}).click(); await expect(page.getByRole("alert")).toContainText("Temporary access failure");
  await expect(retry).toBeVisible(); await expect(retry).toBeDisabled(); expect(invitationWrites).toBe(1);
  await expect(page.getByRole("heading", {name: "Invite a collaborator"})).toHaveCount(0);
  await expect(page.getByRole("heading", {name: /People|Invitations/})).toHaveCount(0);
  await page.getByRole("button", {name: "Refresh team access"}).click(); await expect(retry).toBeEnabled();
  await expect(page.getByRole("heading", {name: "Invite a collaborator"})).toBeVisible();
  await expect(page.getByRole("heading", {name: /People|Invitations/})).toHaveCount(0);
  await expect(page.locator(".portal-team-row")).toHaveCount(0);
  await retry.click(); await expect(page.getByText("Invitation issued.", {exact: false})).toBeVisible();
  expect(invitationWrites).toBe(2); expect(keys[0]).toMatch(/^[A-Za-z0-9-]{16,}$/); expect(keys[1]).toBe(keys[0]);
});

test("secondary approval policy is explicit and exposes no broken approval workflow", async ({page}) => {
  await mock(page, (route, call) => {
    if (call.path === "/api/client/session") return route.fulfill({json: {account: {id: "", displayName: "Client portal"}, capabilities: {workspaceHierarchyV2: true, workspaceMembershipManagement: true, hierarchyScopedInvitations: true, invitationEmailDelivery: true}}});
    if (call.path === "/api/client/v2/workspaces/workspace-b/access") return route.fulfill({json: {
      sourceId: "project-alpha:coastal", sourceName: "Project Alpha", workspaceName: workspace("workspace-b").displayName,
      canManageMembers: true, peerAdminManagement: false, invitationRequestsSupported: false, addressBookAvailable: false, canManageAddressBook: false,
      inviteScopes: [], members: [], invitations: [], invitationPolicy: {mode: "require_approval", version: 7},
      projectAccessTermsSupported: true, projectAccessOptions: [],
    }});
    return undefined;
  });
  await page.goto("/portal/account?workspace=workspace-b");
  await expect(page.getByText("Invitations need a source policy change.", {exact: false})).toBeVisible();
  await expect(page.getByRole("heading", {name: "Invite a collaborator"})).toHaveCount(0);
  await expect(page.getByRole("button", {name: /approval/i})).toHaveCount(0);
  await expect(page.getByText("No team members are available.", {exact: true})).toBeVisible();
});

test("secondary member management fails closed and retries without exposing records", async ({page}) => {
  let available = false;
  await mock(page, (route, call) => {
    if (call.path === "/api/client/session") return route.fulfill({json: {account: {id: "", displayName: "Client portal"}, capabilities: {workspaceHierarchyV2: true, workspaceMembershipManagement: true, hierarchyScopedInvitations: true, invitationEmailDelivery: true}}});
    if (call.path === "/api/client/v2/workspaces/workspace-b/access") return available ? route.fulfill({json: {
      sourceId: "project-alpha:coastal", sourceName: "Project Alpha", workspaceName: workspace("workspace-b").displayName,
      canManageMembers: false, peerAdminManagement: false, invitationRequestsSupported: false, inviteScopes: [{type: "project", publicId: "project-shared", displayName: "Project", capabilities: ["delivery.view"], projectEndSupported: true}],
      members: [], invitations: [], invitationPolicy: {mode: "allowed", version: 1}, projectAccessTermsSupported: true, projectAccessOptions: [],
    }}) : route.fulfill({status: 503, json: {error: "Temporary membership failure"}});
    return undefined;
  });
  await page.goto("/portal/account?workspace=workspace-b");
  await expect(page.getByRole("alert")).toContainText("Temporary membership failure");
  await expect(page.getByRole("heading", {name: "People"})).toHaveCount(0);
  available = true; await page.getByRole("button", {name: "Refresh team access"}).click();
  await expect(page.getByText("Team member records are not available in your current verified access.", {exact: false})).toBeVisible();
  await expect(page.getByRole("heading", {name: "Invite a collaborator"})).toHaveCount(0);
  await expect(page.getByRole("heading", {name: "People"})).toHaveCount(0);
});

test("a context capability and readiness mismatch fails closed before protected probes", async ({page}) => {
  const calls = await mock(page, (route, call) => call.path.endsWith("workspace-b/context") ? route.fulfill({json: {...context(), features: {...features(), directory: {state: "not_in_access", reason: "capability_not_granted"}}}}) : undefined);
  await page.goto("/portal?workspace=workspace-b");
  await expect(page.getByRole("button", {name: "Retry portal"})).toBeVisible();
  expect(calls.some(call => /\/(hierarchy|deliveries)$/.test(call.path))).toBe(false);
});

for (const width of [375, 640, 1280, 3440]) test(`native portal directory and deliveries stay readable at ${width}px`, async ({page}, testInfo) => {
  await page.setViewportSize({width, height: 900}); await mock(page); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/portal?workspace=workspace-b"); await expect(page.getByText("Coastal seawall construction documentation", {exact: true})).toBeVisible();
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", await page.locator("body").evaluate(element => element.clientWidth));
  const project = page.getByRole("link", {name: /^Open project\s*:/}); await expect(project).toHaveCSS("min-height", "44px");
  await expect(project).toHaveAccessibleName(/^Open project\s*: Coastal seawall construction documentation$/);
  const projectContext = project.locator(".visually-hidden");
  await expect(projectContext).toHaveCSS("position", "absolute"); await expect(projectContext).toHaveCSS("width", "1px"); await expect(projectContext).toHaveCSS("height", "1px"); await expect(projectContext).toHaveCSS("clip", "rect(0px, 0px, 0px, 0px)");
  await page.screenshot({path: testInfo.outputPath(`native-directory-${width}.png`)});
  await page.getByRole("link", {name: "Browse deliveries"}).click(); await expect(page.getByRole("button", {name: /^Open folder\s*:/})).toBeVisible();
  const folderContext = page.getByRole("button", {name: /^Open folder\s*:/}).locator(".visually-hidden");
  await expect(folderContext).toHaveCSS("position", "absolute"); await expect(folderContext).toHaveCSS("width", "1px"); await expect(folderContext).toHaveCSS("height", "1px"); await expect(folderContext).toHaveCSS("clip", "rect(0px, 0px, 0px, 0px)");
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", await page.locator("body").evaluate(element => element.clientWidth));
  await page.screenshot({path: testInfo.outputPath(`native-deliveries-${width}.png`)});
  await page.getByRole("button", {name: /^Open folder\s*:/}).click(); await expect(page.getByText("workspace-b-orthomosaic-review.png", {exact: true})).toBeVisible();
  const download = page.getByRole("link", {name: "Download", exact: true});
  await expect(download).toHaveClass(/\bbutton\b/); await expect(download).toHaveCSS("text-decoration-line", "none"); await expect(download).toHaveCSS("align-items", "center"); await expect(download).toHaveCSS("justify-content", "center");
  expect(await download.evaluate(element => parseFloat(getComputedStyle(element).borderTopLeftRadius))).toBeGreaterThan(0);
  await page.screenshot({path: testInfo.outputPath(`native-files-${width}.png`)});
  await page.getByRole("button", {name: "Preview", exact: true}).click();
  const previewDownload = page.getByRole("dialog").getByRole("link", {name: "Download", exact: true});
  await expect(previewDownload).toHaveClass(/\bbutton\b/); await expect(previewDownload).toHaveCSS("text-decoration-line", "none"); await expect(previewDownload).toHaveCSS("align-items", "center"); await expect(previewDownload).toHaveCSS("justify-content", "center");
  expect(await previewDownload.evaluate(element => parseFloat(getComputedStyle(element).borderTopLeftRadius))).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test("the unified portal lists every account's projects without a switcher and opens each in its exact account", async ({page}) => {
  const calls = await mock(page); await page.goto("/portal/projects");
  await expect(page.getByRole("combobox", {name: "Client account"})).toHaveCount(0);
  const projects = page.locator(".portal-project-grid .portal-project-card");
  await expect(projects).toHaveCount(3);
  // Items name the client account (several are open) but never make the client pick or read a business.
  await expect(page.getByRole("button", {name: /Primary-only project/})).toContainText("Drone and survey");
  await expect(page.getByRole("button", {name: /Primary-only project/})).not.toContainText("Primary customer");
  await expect(page.locator(".portal-project-grid")).not.toContainText("Ledge Top Drone Services");
  await expect(page.getByRole("group", {name: "Show items from"})).toHaveCount(0);
  // Same public project ID in two accounts stays two separate items.
  await expect(page.getByRole("button", {name: /Coastal seawall construction documentation/})).toBeVisible();
  await expect(page.getByRole("button", {name: /Mountain bridge inspection/})).toBeVisible();
  // Native hierarchy authorizes discovery, but has no project lifecycle field.
  // Retained completed projects must not be labelled Active merely for existing.
  await expect(page.getByRole("button", {name: /Mountain bridge inspection/}).getByText("Active", {exact: true})).toHaveCount(0);
  await expect(page.getByRole("button", {name: /Primary-only project/}).getByText("Active", {exact: true})).toBeVisible();
  await expect(page.locator(".client-portal")).not.toContainText("project-alpha:");
  await expect(page.locator(".client-portal")).not.toContainText("Project Alpha (");
  expect(calls.filter(call => call.path === "/api/client/projects").every(call => call.workspace === "workspace-a")).toBe(true);
  expect(calls.some(call => call.path.endsWith("workspace-b/hierarchy")) && calls.some(call => call.path.endsWith("workspace-c/hierarchy"))).toBe(true);
  await page.getByRole("button", {name: /Mountain bridge inspection/}).click();
  await expect(page).toHaveURL(/\/portal\/projects\/project-shared\?workspace=workspace-c$/);
  await expect(page.getByText("Mountain bridge inspection", {exact: true}).first()).toBeVisible();
  await expect(page.getByText("Coastal seawall construction documentation", {exact: true})).toHaveCount(0);
  await expect(page.locator(".unified-portal-context")).not.toContainText("Mountain Engineering");
  const topNav = page.getByRole("navigation", {name: "Client portal"});
  if (await topNav.isVisible()) await topNav.getByRole("link", {name: "Projects"}).click();
  else { await page.getByRole("button", {name: "Open navigation"}).click(); await page.getByRole("navigation", {name: "Mobile client portal navigation"}).getByRole("link", {name: "Projects"}).click(); }
  await expect(page).toHaveURL(/\/portal\/projects$/);
  await expect(projects).toHaveCount(3);
});

test("one unavailable account is reported in place without hiding the others", async ({page}) => {
  let failing = true;
  await mock(page, (route, call) => call.path.endsWith("workspace-c/context") && failing ? route.fulfill({status: 503, json: {error: "Temporarily unavailable"}}) : undefined);
  await page.goto("/portal/projects");
  await expect(page.getByRole("alert")).toContainText("Ledge Top 2");
  await expect(page.getByRole("button", {name: /Coastal seawall construction documentation/})).toBeVisible();
  await expect(page.getByRole("button", {name: /Primary-only project/})).toBeVisible();
  failing = false; await page.getByRole("button", {name: "Try again"}).click();
  await expect(page.getByRole("button", {name: /Mountain bridge inspection/})).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a link naming an account still opens that account's own page", async ({page}) => {
  await mock(page); await page.goto("/portal/projects?workspace=workspace-b");
  await expect(page.getByRole("link", {name: /^Open project\s*: Coastal seawall construction documentation$/})).toBeVisible();
  await expect(page.getByText("Mountain bridge inspection", {exact: true})).toHaveCount(0);
  await page.getByRole("button", {name: "Back to everything"}).click();
  await expect(page).toHaveURL(/\/portal\/projects$/);
  await expect(page.getByRole("button", {name: /Mountain bridge inspection/})).toBeVisible();
});

for (const width of [375, 1280]) test(`unified projects fit ${width}px without horizontal scrolling`, async ({page}) => {
  await page.setViewportSize({width, height: 900});
  await mock(page); await page.goto("/portal/projects");
  await expect(page.locator(".portal-project-grid .portal-project-card")).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("unified focus revalidation clears a revoked account before the response and recovers independently", async ({page}) => {
  let revoked = false, release: (() => void) | undefined;
  await mock(page, (route, call) => {
    if (call.path.endsWith("workspace-c/context") && revoked) return new Promise<void>(resolve => {
      release = () => { void route.fulfill({status: 403, json: {error: "Access revoked"}}).then(() => resolve()); };
    });
    return undefined;
  });
  await page.clock.install();
  await page.goto("/portal/projects");
  await expect(page.getByRole("button", {name: /Mountain bridge inspection/})).toBeVisible();
  revoked = true;
  await page.clock.fastForward(1100);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("button", {name: /Mountain bridge inspection/})).toHaveCount(0);
  await expect.poll(() => Boolean(release)).toBe(true);
  release!();
  await expect(page.getByRole("alert")).toContainText("Access revoked");
  await expect(page.getByRole("button", {name: /Coastal seawall construction documentation/})).toBeVisible();
  await expect(page.getByRole("button", {name: /Primary-only project/})).toBeVisible();
  revoked = false;
  await page.getByRole("button", {name: "Try again"}).click();
  await expect(page.getByRole("button", {name: /Mountain bridge inspection/})).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("unified polling removes stale data after a source becomes unavailable", async ({page}) => {
  let unavailable = false;
  await mock(page, (route, call) => call.path.endsWith("workspace-c/context") && unavailable
    ? route.fulfill({status: 503, json: {error: "Source unavailable"}}) : undefined);
  await page.clock.install();
  await page.goto("/portal/projects");
  await expect(page.getByRole("button", {name: /Mountain bridge inspection/})).toBeVisible();
  unavailable = true;
  await page.clock.fastForward(60_001);
  await expect(page.getByRole("alert")).toContainText("Source unavailable");
  await expect(page.getByRole("button", {name: /Mountain bridge inspection/})).toHaveCount(0);
  await expect(page.getByRole("button", {name: /Primary-only project/})).toBeVisible();
});

test("unified projects reports hierarchy pagination limits instead of a complete partial list", async ({page}) => {
  let pages = 0;
  await mock(page, (route, call) => {
    if (call.path.endsWith("workspace-c/hierarchy")) {
      pages++;
      return route.fulfill({json: {...hierarchy("workspace-c"), page: {nextCursor: `page-${pages}`}}});
    }
    return undefined;
  });
  await page.goto("/portal/projects");
  await expect(page.getByRole("alert")).toContainText("too large to load completely");
  expect(pages).toBe(10);
  await expect(page.getByRole("button", {name: /Mountain bridge inspection/})).toHaveCount(0);
  await expect(page.getByRole("button", {name: /Primary-only project/})).toBeVisible();
});

test.describe("unified home without business switching", () => {
  // A client with drone work (primary source) and website work (secondary source), plus a legacy account.
  const sources: Record<string, string> = {"workspace-b": "project-alpha:primary", "workspace-c": "project-alpha:secondary"};
  const names: Record<string, string> = {"workspace-b": "Coastal Surveying and Infrastructure Development", "workspace-c": "Rivera Web Studio"};
  const listed = workspaces.map(item => sources[item.id] ? {...item, sourceId: sources[item.id], displayName: names[item.id]} : item);
  const request = (id: string, title: string, status: string, updatedAt: string) => ({id, projectId: null, requestType: "service", title, details: "Synthetic request",
    location: null, preferredStartAt: null, status, createdAt: "2026-08-01T12:00:00.000Z", updatedAt});
  const requestsFor: Record<string, unknown[]> = {
    "workspace-b": [request("req-b1", "Seawall progress flight", "under_review", "2026-08-20T12:00:00.000Z")],
    "workspace-c": [request("req-c1", "Homepage refresh", "completed", "2026-08-18T12:00:00.000Z"),
      request("req-c2", "Google Ads campaign", "submitted", "2026-08-22T12:00:00.000Z")],
  };
  async function mockBoth(page: Page) {
    return mock(page, (route, call) => {
      if (call.path === "/api/client/v2/workspaces") return route.fulfill({json: {workspaces: listed}});
      const match = call.path.match(/^\/api\/client\/v2\/workspaces\/(workspace-[bc])\/(context|hierarchy)$/);
      if (match) {
        const id = match[1]!, ws = listed.find(item => item.id === id)!;
        if (match[2] === "context") return route.fulfill({json: {...requestContext(id), workspace: ws}});
        const value = hierarchy(id);
        return route.fulfill({json: {...value, sourceId: sources[id], entries: value.entries.map(entry => entry.type === "project"
          ? {...entry, displayName: id === "workspace-c" ? "Website refresh" : "Coastal seawall construction documentation"} : entry.type === "organization" ? {...entry, displayName: ws.displayName} : entry)}});
      }
      if (call.path === "/api/client/service-requests" && call.workspace && requestsFor[call.workspace]) return route.fulfill({json: {requests: requestsFor[call.workspace]}});
      return undefined;
    });
  }

  test("home merges everything, shows progress at a glance and never names or splits by business", async ({page}) => {
    await mockBoth(page); await page.goto("/portal");
    await expect(page.getByRole("heading", {name: "Welcome back"})).toBeVisible();
    await expect(page.getByRole("group", {name: "Show items from"})).toHaveCount(0);
    const tile = (label: string) => page.locator(".portal-overview-tile").filter({hasText: label});
    await expect(tile("Requests in progress").locator(".portal-overview-value")).toHaveText("2");
    await expect(tile("Completed requests").locator(".portal-overview-value")).toHaveText("1");
    await expect(page.getByRole("img", {name: "1 received, 1 in review, 1 completed"})).toBeVisible();
    const activity = page.locator(".ltds-card").filter({has: page.getByRole("heading", {name: "Recent activity"})});
    await expect(activity.locator("li strong")).toHaveText(["Google Ads campaign", "Seawall progress flight", "Homepage refresh"]);
    await expect(page.getByRole("button", {name: /Website refresh/})).toBeVisible();
    await expect(page.getByRole("button", {name: /Coastal seawall construction documentation/})).toBeVisible();
    await expect(page.locator(".client-portal-main")).not.toContainText("Ledge Top Drone Services");
    await expect(page.locator(".client-portal-main")).not.toContainText("Ledge Top Technologies");
  });

  test("a new request asks what the client needs and sends it to the matching account", async ({page}) => {
    await mockBoth(page); await page.goto("/portal");
    await page.getByRole("button", {name: "New request"}).first().click();
    const chooser = page.locator(".unified-portal-chooser");
    await expect(chooser.getByRole("heading", {name: "What do you need help with?"})).toBeVisible();
    await expect(chooser.getByRole("button", {name: /Drone flight or field work/})).toBeVisible();
    await expect(chooser).not.toContainText("Ledge Top Technologies");
    await chooser.getByRole("button", {name: /Website or marketing/}).click();
    await expect(page).toHaveURL(/\/portal\/requests\/new\?workspace=workspace-c$/);
    await expect(page.locator(".unified-portal-context")).toHaveText(/^Website and marketing/);
    await expect(page.locator(".unified-portal-context")).not.toContainText("Rivera Web Studio");
  });

  test("deliveries and feedback are described by the work, not the business", async ({page}) => {
    await mockBoth(page); await page.goto("/portal/deliveries");
    // Two accounts cover drone work, so they are numbered; neither shows a stored account name or a business.
    await expect(page.getByText("Drone and survey deliveries", {exact: true})).toHaveCount(2);
    await expect(page.locator(".unified-portal-area").filter({hasText: "Drone and survey 1"})).toContainText("Drone and survey deliveries");
    await expect(page.locator(".unified-portal-area").filter({hasText: "Primary customer"})).toHaveCount(0);
    await expect(page.getByText("Website and marketing files", {exact: true})).toBeVisible();
    await expect(page.locator(".client-portal-main")).not.toContainText("Ledge Top Technologies");
    await page.goto("/portal/feedback");
    await expect(page.getByText("Website and marketing", {exact: true})).toBeVisible();
  });

  test("the redesigned home fits a phone without sideways scrolling", async ({page}) => {
    await page.setViewportSize({width: 375, height: 812});
    await mockBoth(page); await page.goto("/portal");
    await expect(page.locator(".portal-overview-tile")).toHaveCount(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

test.describe("client header matches Operations", () => {
  test("account shows the signed-in email and how long the session lasts, without seconds", async ({page}) => {
    await page.clock.install({time: new Date("2030-01-01T12:00:00Z")});
    await mock(page, (route, call) => {
      if (call.path === "/api/client/session") return route.fulfill({json: {account: {id: call.workspace ? "account-a" : "", displayName: "Primary customer", email: "jamie@example.test"}, capabilities: {workspaceHierarchyV2: true}}});
      if (call.path === "/api/client/session/status") return route.fulfill({json: {serverTime: "2030-01-01T12:00:00.000Z", expiresAt: "2030-01-03T16:13:30.000Z"}});
      return undefined;
    });
    await page.goto("/portal");
    const trigger = page.getByRole("button", {name: /^Account menu for /});
    await expect(trigger).toBeVisible();
    if (await page.getByRole("navigation", {name: "Client portal"}).isVisible()) await expect(trigger).toContainText("jamie@example.test");
    await trigger.click();
    const menu = page.getByRole("menu", {name: "Account"});
    await expect(menu.getByRole("timer")).toHaveText("2d 4h 13m");
    await expect(menu.locator("time")).toHaveText(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s?[AP]M$/);
    await expect(menu.getByRole("menuitem", {name: "Logout"})).toHaveAttribute("href", "/cdn-cgi/access/logout");
  });

  test("a native account also shows the verified sign-in email, not a workspace contact", async ({page}) => {
    test.skip((page.viewportSize()?.width ?? 0) < 961, "the account details are collapsed on phones");
    await mock(page, (route, call) => call.path === "/api/client/session"
      ? route.fulfill({json: {account: {id: "", displayName: "Client portal", email: "jamie@example.test"}, capabilities: {workspaceHierarchyV2: true}}}) : undefined);
    await page.goto("/portal?workspace=workspace-b");
    await expect(page.getByRole("button", {name: /^Account menu for /})).toContainText("jamie@example.test");
  });

  test("without session timing from the server the menu shows no made-up countdown", async ({page}) => {
    await mock(page);
    await page.goto("/portal");
    await page.getByRole("button", {name: /^Account menu for /}).click();
    const menu = page.getByRole("menu", {name: "Account"});
    await expect(menu.getByRole("menuitem", {name: "Logout"})).toBeVisible();
    await expect(menu.getByRole("timer")).toHaveCount(0);
    await expect(menu.locator(".account-session-status")).toHaveCount(0);
  });

  test("the current page is marked like Operations: orange text with an underline", async ({page}) => {
    test.skip((page.viewportSize()?.width ?? 0) < 961, "the desktop menu is hidden on phones");
    await mock(page); await page.goto("/portal");
    const current = page.getByRole("navigation", {name: "Client portal"}).getByRole("link", {name: "Home"});
    await expect(current).toHaveAttribute("aria-current", "page");
    const style = await current.evaluate(element => { const computed = getComputedStyle(element); return {color: computed.color, border: computed.borderBottomColor, width: computed.borderBottomWidth}; });
    expect(style).toEqual({color: "rgb(238, 80, 7)", border: "rgb(238, 80, 7)", width: "3px"});
  });
});

test("native model routes retain client navigation and pin bootstrap to their exact workspace", async ({ page }) => {
  const calls = await mock(page, (route, call) => {
    if (call.path.endsWith("workspace-b/context")) {
      const value = context();
      return route.fulfill({ json: { ...value, features: { ...value.features, models: { state: "available", reason: "resource_authorization_required" } }, capabilities: { ...value.capabilities, viewer: true } } });
    }
    if (call.path.endsWith("/session") && call.method === "POST")
      return route.fulfill({ status: 403, json: { error: "Model access ended" } });
    return undefined;
  });
  // A conflicting query hint must never select a different client than the model URL.
  await page.goto("/portal/viewer/native/workspace-b/project-one/association-one/model-one?workspace=workspace-c");
  await expect(page.getByRole("heading", { name: "Secure 3D Viewer" })).toBeVisible();
  await expect(page.locator(".client-portal-header")).toBeVisible();
  expect(calls.some(call => call.path.endsWith("workspace-c/context"))).toBe(false);
  const nav = page.getByRole("navigation", { name: "Client portal", exact: true });
  if (!(await nav.isVisible())) {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("navigation", { name: "Mobile client portal navigation" }).getByRole("link", { name: "Projects", exact: true }).click();
  } else await nav.getByRole("link", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Secure 3D Viewer" })).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Secure 3D Viewer" })).toBeVisible();
  const modelSessions = calls.filter(call => call.method === "POST" && call.path.endsWith("/session"));
  expect(modelSessions.length).toBeGreaterThan(0);
  expect(modelSessions.every(call => call.path.includes("/workspace-b/"))).toBe(true);
});
