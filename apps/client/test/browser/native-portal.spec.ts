import { expect, test, type Page, type Route } from "@playwright/test";

const date = "2026-08-26T12:00:00Z";
const workspaces = [
  { id: "workspace-a", rootType: "organization", rootPublicId: "org-shared", displayName: "Primary customer" },
  { id: "workspace-b", rootType: "organization", rootPublicId: "org-shared", displayName: "Coastal Surveying and Infrastructure Development", resourceMode: "native", sourceId: "project-alpha:coastal" },
  { id: "workspace-c", rootType: "organization", rootPublicId: "org-shared", displayName: "Mountain Engineering", resourceMode: "native", sourceId: "project-alpha:mountain" },
];
function workspace(id: string) { return workspaces.find(item => item.id === id)!; }
function envelope(id = "workspace-b") { return {workspaceId: id, sourceId: workspace(id).sourceId, contextVersion: `context-${id}`}; }
function features() { return {directory: {state: "available", reason: "authorized_capability"}, deliveries: {state: "available", reason: "resource_authorization_required"},
  serviceRequests: {state: "not_supported", reason: "source_not_supported"}, feedback: {state: "not_supported", reason: "source_not_supported"},
  models: {state: "not_supported", reason: "source_not_supported"}, team: {state: "not_supported", reason: "source_not_supported"},
  billing: {state: "not_supported", reason: "source_not_supported"}}; }
function context(id = "workspace-b") { return {workspace: workspace(id), contextVersion: `context-${id}`, features: features(), capabilities: {directoryRead: true, deliveryView: true, requestV2: false, requestAttachments: false, feedback: false, manageTeam: false, workspaceMembershipManagement: false, delegatedShares: false, viewer: false, viewerShares: false, viewBilling: false}}; }
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
  await expect(page.getByRole("heading", {name: "Workspace features"})).toBeVisible();
  await expect(page.getByText("They are not services purchased or assigned to your organization.", {exact: false})).toBeVisible();
  nativeCallsOnly(calls); await expect(page.getByRole("button", {name: /New request|Leave Feedback|Invite/i})).toHaveCount(0);
});

test("capabilities absent from native context do not produce optimistic directory or delivery probes", async ({page}) => {
  const calls = await mock(page, (route, call) => call.path.endsWith("workspace-b/context") ? route.fulfill({json: {...context(), features: {...features(), directory: {state: "not_in_access", reason: "capability_not_granted"}, deliveries: {state: "temporarily_unavailable", reason: "backend_unavailable"}}, capabilities: {...context().capabilities, directoryRead: false, deliveryView: false}}}) : undefined);
  await page.goto("/portal?workspace=workspace-b"); await expect(page.getByText("The directory is not included in your current workspace access.")).toBeVisible();
  await expect(page.getByText("Not in access", {exact: true})).toBeVisible();
  await page.goto("/portal/deliveries?workspace=workspace-b"); await expect(page.getByText("Delivery viewing is not included in your current workspace access.")).toBeVisible();
  expect(calls.some(call => /\/(hierarchy|deliveries)$/.test(call.path))).toBe(false);
});

test("native feature readiness is operational status, not purchased services or optimistic secondary features", async ({page}) => {
  const calls = await mock(page); await page.goto("/portal?workspace=workspace-b");
  const surface = page.locator(".ltds-card").filter({has: page.getByRole("heading", {name: "Workspace features"})});
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
  await expect(page.getByRole("alert")).toContainText("workspace source could not be verified");
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
  await expect(page.getByText("Workspace member management is not included in your current verified access.", {exact: false})).toBeVisible();
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
  await expect(page.getByRole("heading", {name: "Invite a collaborator"})).toHaveCount(0);
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
  await expect(page.getByText("No workspace members are available.", {exact: true})).toBeVisible();
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
  await expect(page.getByText("Workspace member management is not included in your current verified access.", {exact: false})).toBeVisible();
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
