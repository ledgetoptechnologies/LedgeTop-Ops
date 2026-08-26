import { expect, test, type Page, type Route } from "@playwright/test";

const date = "2026-08-26T12:00:00Z";
const workspaces = [
  { id: "workspace-a", rootType: "organization", rootPublicId: "org-shared", displayName: "Primary customer" },
  { id: "workspace-b", rootType: "organization", rootPublicId: "org-shared", displayName: "Coastal Surveying and Infrastructure Development", resourceMode: "native", sourceId: "project-alpha:coastal" },
  { id: "workspace-c", rootType: "organization", rootPublicId: "org-shared", displayName: "Mountain Engineering", resourceMode: "native", sourceId: "project-alpha:mountain" },
];
function workspace(id: string) { return workspaces.find(item => item.id === id)!; }
function envelope(id = "workspace-b") { return {workspaceId: id, sourceId: workspace(id).sourceId, contextVersion: `context-${id}`}; }
function context(id = "workspace-b") { return {workspace: workspace(id), contextVersion: `context-${id}`, capabilities: {directoryRead: true, deliveryView: true, requestV2: false, requestAttachments: false, feedback: false, manageTeam: false, workspaceMembershipManagement: false, delegatedShares: false, viewer: false, viewerShares: false, viewBilling: false}}; }
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
    if (call.path === "/api/client/notifications") return route.fulfill({json: {notifications: [], unreadCount: 0, cursor: null}});
    if (call.path === "/api/client/request-readiness") return route.fulfill({json: {mode: "legacy", workspaceId: "workspace-a", target: {kind: "root", projectId: null}, canStartRequest: false, reason: "request_not_permitted", root: {canStartRequest: false, reason: "request_not_permitted"}, projectRequestsSupported: false, refreshedAt: date}});
    return route.fulfill({status: 404, json: {error: "Unsupported fixture endpoint"}});
  });
  return calls;
}
async function late(route: Route, json: unknown) { try { await route.fulfill({json}); } catch { /* The old workspace request was cancelled. */ } }
function nativeCallsOnly(calls: Call[]) {
  expect(calls.filter(call => call.path !== "/api/client/session" && !call.path.startsWith("/api/client/v2/"))).toEqual([]);
  expect(calls.every(call => call.method === "GET")).toBe(true);
  expect(calls.filter(call => call.path === "/api/client/session").every(call => call.workspace === undefined)).toBe(true);
}

test("native refresh discovers identity without the selected workspace header and never probes legacy resources", async ({page}) => {
  const calls = await mock(page); await page.goto("/portal?workspace=workspace-b");
  await expect(page.getByRole("heading", {name: workspace("workspace-b").displayName})).toBeVisible();
  await expect(page.getByText("Coastal seawall construction documentation", {exact: true})).toBeVisible();
  await page.reload(); await expect(page.getByText("Coastal seawall construction documentation", {exact: true})).toBeVisible();
  nativeCallsOnly(calls); expect(calls.filter(call => call.path.endsWith("/hierarchy")).every(call => call.query.get("expectedContext") === "context-workspace-b")).toBe(true);
  await expect(page.getByRole("button", {name: /notifications/i})).toHaveCount(0);
});

test("primary compatibility and native workspace switching preserve independent projects and Back/Forward", async ({page}) => {
  const calls = await mock(page); await page.goto("/portal?workspace=workspace-a");
  await expect(page.getByText("Primary-only project", {exact: true})).toBeVisible();
  await page.getByRole("combobox", {name: "Client workspace"}).selectOption("workspace-b");
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
  await expect(page.getByText("Coastal seawall construction documentation", {exact: true})).toBeVisible();
  await page.getByRole("combobox", {name: "Client workspace"}).selectOption("workspace-c");
  await expect(page.getByText("Mountain bridge inspection", {exact: true})).toBeVisible();
  await expect(page.getByText("Coastal seawall construction documentation", {exact: true})).toHaveCount(0);
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
  await expect(page.getByText("Coastal seawall construction documentation", {exact: true})).toBeVisible();
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
  await page.getByRole("combobox", {name: "Client workspace"}).selectOption("workspace-c");
  await expect(page.getByText("Mountain bridge inspection", {exact: true})).toBeVisible(); release();
  await expect(page).toHaveURL(/workspace=workspace-c$/); await expect(page.getByText("workspace-b-orthomosaic-review.png", {exact: true})).toHaveCount(0);
});

test("Back reauthorizes an earlier native workspace before its exact file request", async ({page}) => {
  let delayContext = false, metadataReads = 0, releaseContext!: () => void, releaseOldFile!: () => void;
  const contextWait = new Promise<void>(resolve => {releaseContext = resolve;}), fileWait = new Promise<void>(resolve => {releaseOldFile = resolve;});
  const calls = await mock(page, (route, call) => call.path.endsWith("workspace-b/context") && delayContext ? contextWait.then(() => late(route, context())) : call.path.endsWith("workspace-b/files/file-workspace-b") && ++metadataReads === 1 ? fileWait.then(() => late(route, {...envelope(), file: file()})) : undefined);
  await page.goto("/portal/deliveries?workspace=workspace-b&file=file-workspace-b");
  await expect.poll(() => metadataReads).toBe(1); await expect(page.getByText("Opening linked file…")).toBeVisible();
  await page.getByRole("combobox", {name: "Client workspace"}).selectOption("workspace-c"); await expect(page.getByText("Mountain bridge inspection", {exact: true})).toBeVisible();
  releaseOldFile(); await expect(page.getByRole("dialog")).toHaveCount(0);
  delayContext = true; const before = calls.filter(call => call.path.endsWith("workspace-b/context")).length; await page.goBack();
  await expect.poll(() => calls.filter(call => call.path.endsWith("workspace-b/context")).length).toBeGreaterThan(before);
  expect(metadataReads).toBe(1); await expect(page.getByRole("dialog")).toHaveCount(0); releaseContext();
  await expect(page.getByRole("dialog", {name: "Preview workspace-b-orthomosaic-review.png"})).toBeVisible(); expect(metadataReads).toBe(2);
  await expect(page).toHaveURL(/workspace=workspace-b&file=file-workspace-b$/); expect(calls.some(call => call.path.includes("/folders/"))).toBe(false);
});

for (const path of ["/portal/requests", "/portal/requests/new", "/portal/feedback", "/portal/account", "/portal/projects/project-shared?tab=models", "/portal/projects/project-shared?tab=requests"]) test(`native unsupported feature ${path} is explicit without legacy or Viewer probes`, async ({page}) => {
  const calls = await mock(page); await page.goto(`${path}${path.includes("?") ? "&" : "?"}workspace=workspace-b`);
  await expect(page.getByText("Service requests, billing, member management, feedback, and 3D models are not available for this connected workspace.")).toBeVisible();
  nativeCallsOnly(calls); await expect(page.getByRole("button", {name: /New request|Leave Feedback|Invite/i})).toHaveCount(0);
});

test("capabilities absent from native context do not produce optimistic directory or delivery probes", async ({page}) => {
  const calls = await mock(page, (route, call) => call.path.endsWith("workspace-b/context") ? route.fulfill({json: {...context(), capabilities: {...context().capabilities, directoryRead: false, deliveryView: false}}}) : undefined);
  await page.goto("/portal?workspace=workspace-b"); await expect(page.getByText("The directory is not included in your current workspace access.")).toBeVisible();
  await page.goto("/portal/deliveries?workspace=workspace-b"); await expect(page.getByText("Delivery viewing is not included in your current workspace access.")).toBeVisible();
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
  await page.getByRole("link", {name: "Browse workspace deliveries"}).click(); await expect(page.getByRole("button", {name: /^Open folder\s*:/})).toBeVisible();
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
