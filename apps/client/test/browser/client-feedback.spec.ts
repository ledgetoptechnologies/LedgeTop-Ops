import { expect, test, type Page, type Route } from "@playwright/test";
const date = "2026-08-25T12:00:00Z";
const project = {id: "project-one", externalRef: "ALPHA-1", clientName: "Acme", projectName: "Church survey", canRequestService: false, status: "active", summary: "Progress documentation", siteAddress: null, serviceAddress: null, projectContactName: null, projectContactEmail: null, projectContactPhone: null, nextMilestone: null, lastUpdateAt: null};
function file(id = "cf1_photo") { return {id, name: `${id}.jpg`, size: 2048, uploadedAt: date, contentType: "image/jpeg", kind: "image", previewPath: `/api/client/files/${id}/preview?projectId=project-one`, thumbnailPath: null, downloadPath: `/api/client/files/${id}/download?projectId=project-one`}; }
function item(overrides: Record<string, unknown> = {}) {return {id: "feedback-one", revision: 1, status: "new", message: "Please check the north edge.", completionNote: null, target: {kind: "file", projectId: "project-one", label: "North edge photo.jpg", projectName: "Church survey", available: true, actionPath: "/portal/projects/project-one?tab=files&folder=pf2_edited&file=cf1_photo"}, createdAt: date, updatedAt: date, completedAt: null, ...overrides};}
function detail(overrides: Record<string, unknown> = {}) {return {feedback: item(overrides), events: [{revision: 1, actor: "client", status: "new", note: null, createdAt: date}]};}
function history(workspaceId:string|null=null,overrides:Record<string,unknown>={}){return {scope:{sourceId:"project-alpha:primary",workspaceId,rootType:"organization",rootPublicId:"org-one"},asOf:"2026-08-25T13:00:00Z",items:[{feedbackId:"feedback-one",createdAt:date,status:"new",events:[{revision:1,action:"submitted",occurredAt:date}],detailPath:`/portal/feedback/feedback-one${workspaceId?`?workspace=${workspaceId}`:""}`,target:{kind:"file",label:"North edge photo.jpg",projectName:"Church survey"}}],nextCursor:null,...overrides};}
type Call = {path: string; method: string; query: URLSearchParams; workspace?: string; body: any; key?: string};
async function mock(page: Page, custom?: (route: Route, url: URL, call: Call) => Promise<unknown> | undefined, options: {workspace?: boolean; enabled?: boolean} = {}) {
  const calls: Call[] = [];
  await page.route("**/api/client/**", async route => {
    const req = route.request(), url = new URL(req.url()), call = {path: url.pathname, method: req.method(), query: url.searchParams, workspace: req.headers()["x-ltds-workspace-id"], body: req.postData() ? req.postDataJSON() : null, key: req.headers()["idempotency-key"]}; calls.push(call);
    const handled = custom?.(route, url, call); if (handled) return handled;
    if (call.path === "/api/client/session") return route.fulfill({json: {account: {id: "account-one", displayName: "Acme Construction"}, capabilities: {feedback: options.enabled !== false, workspaceHierarchyV2: options.workspace === true}}});
    if (call.path === "/api/client/v2/workspaces") return route.fulfill({json: {workspaces: [{id: "workspace-a", displayName: "Workspace A", kind: "organization"}, {id: "workspace-b", displayName: "Workspace B", kind: "organization"}]}});
    if (call.path === "/api/client/projects") return route.fulfill({json: {projects: [project]}});
    if (call.path === "/api/client/service-requests") return route.fulfill({json: {requests: []}});
    if (call.path === "/api/client/map-config") return route.fulfill({json: {mapboxPublicToken: null}});
    if (call.path === "/api/client/request-readiness") return route.fulfill({json: {mode: "legacy", workspaceId: call.workspace || null, target: {kind: "root", projectId: null}, canStartRequest: false, reason: "request_not_permitted", root: {canStartRequest: false, reason: "request_not_permitted"}, projectRequestsSupported: false, refreshedAt: date}});
    if (call.path === "/api/client/notifications") return route.fulfill({json: {notifications: [], unreadCount: 0, cursor: null}});
    if (call.path === "/api/client/feedback-notifications") return route.fulfill({json: {notifications: [], nextCursor: null}});
    if (call.path.endsWith("file-locations") || call.path.endsWith("past-delivery-locations")) return route.fulfill({json: {points: [], imageCount: 0, truncated: false}});
    if (call.path === "/api/client/projects/project-one/files" || call.path === "/api/client/past-deliveries") return route.fulfill({json: {files: [file()], folders: [], breadcrumbs: [{id: null, name: "Project files"}, ...(call.query.get("folder") ? [{id: "pf2_edited", name: "Edited"}] : [])], folderId: call.query.get("folder"), prefix: "", cursor: null}});
    if (/\/files\/[^/]+\/metadata$/.test(call.path)) return route.fulfill({json: {file: file(call.path.split("/").at(-2)), projectId: call.query.get("projectId"), workspaceId: call.workspace || null}});
    if (call.path.endsWith("/preview")) return route.fulfill({contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#ddd"/></svg>'});
    if (call.path === "/api/client/feedback" && call.method === "GET") return route.fulfill({json: history(call.workspace??null)});
    if (call.path === "/api/client/feedback" && call.method === "POST") return route.fulfill({json: detail({message: call.body.message})});
    if (call.path === "/api/client/feedback/feedback-one") return route.fulfill({json: detail()});
    return route.fulfill({status: 404, json: {error: "Not found"}});
  });
  return calls;
}
async function late(route: Route, json: unknown) {try {await route.fulfill({json});} catch {/* aborted request */}}

test("project feedback is generic and duplicate clicks create one idempotent submission", async ({page}) => {
  let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
  const calls = await mock(page, (route, _url, call) => call.path === "/api/client/feedback" && call.method === "POST" ? wait.then(() => late(route, detail())) : undefined);
  await page.goto("/portal/projects/project-one"); await page.getByRole("button", {name: "Leave Feedback", exact: true}).click();
  const composer = page.getByRole("region", {name: "Feedback about Church survey"});
  await expect(composer.getByLabel("Your feedback")).toBeFocused(); await composer.getByLabel("Your feedback").fill("Please check the north edge.");
  await expect(composer.locator("select")).toHaveCount(0);
  await composer.getByRole("button", {name: "Send feedback"}).dblclick();
  expect(calls.filter(call => call.method === "POST")).toHaveLength(1); release();
  await expect(page.getByText("Feedback sent.")).toBeVisible();
  expect(calls.find(call => call.method === "POST")?.body).toEqual({target: {kind: "project", projectId: "project-one"}, message: "Please check the north edge."});
  expect(calls.find(call => call.method === "POST")?.key).toMatch(/^[a-f0-9-]{36}$/);
});

test("folder feedback uses the authorized opaque folder and keeps the file list in place", async ({page}) => {
  const calls = await mock(page); await page.goto("/portal/projects/project-one?tab=files&folder=pf2_edited");
  await expect(page.getByRole("navigation", {name: "Project file folders"})).toContainText("Edited");
  await page.getByRole("button", {name: "Leave Feedback", exact: true}).nth(1).click();
  const composer = page.getByRole("region", {name: "Feedback about Edited"}); await composer.getByLabel("Your feedback").fill("Please review this folder."); await composer.getByRole("button", {name: "Send feedback"}).click();
  await expect(page.getByText("Feedback sent.")).toBeVisible(); expect(calls.find(call => call.method === "POST")?.body.target).toEqual({kind: "folder", projectId: "project-one", folderId: "pf2_edited"});
  await expect(page.locator(".portal-file-row")).toHaveCount(1);
});

test("exact file deep link resolves metadata without scanning file pages and survives refresh", async ({page}) => {
  const calls = await mock(page); await page.goto("/portal/projects/project-one?tab=files&folder=pf2_edited&file=cf1_unloaded");
  const preview = page.getByRole("dialog", {name: "Preview cf1_unloaded.jpg"}); await expect(preview).toBeVisible();
  expect(calls.filter(call => call.path.endsWith("/files"))).toHaveLength(1);
  expect(calls.find(call => call.path.endsWith("/metadata"))?.query.get("projectId")).toBe("project-one");
  await expect(preview.locator("img")).toHaveCount(1); await page.reload(); await expect(preview).toBeVisible();
  await preview.getByRole("button", {name: "Leave Feedback"}).click(); await preview.getByLabel("Your feedback").fill("Please adjust this photo.");
  await preview.getByRole("button", {name: "Send feedback"}).click(); await expect(preview.getByText("Feedback sent.")).toBeVisible();
  expect(calls.find(call => call.method === "POST")?.body.target).toEqual({kind: "file", projectId: "project-one", fileId: "cf1_unloaded"});
  await preview.getByRole("button", {name: "Close preview"}).click(); await expect(page).not.toHaveURL(/file=/); await page.goBack(); await expect(preview).toBeVisible();
});

test("metadata with a wrong project or workspace never loads protected media", async ({page}) => {
  const calls = await mock(page, (route, _url, call) => call.path.endsWith("/metadata") ? route.fulfill({json: {file: file(), projectId: "wrong-project", workspaceId: null}}) : undefined);
  await page.goto("/portal/projects/project-one?tab=files&file=cf1_photo"); await expect(page.getByText(/This file could not be opened/)).toBeVisible(); await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(calls.filter(call => call.path.endsWith("/preview"))).toHaveLength(0);
});

test("validated workspace hint selects the authorized workspace before feedback and metadata reads", async ({page}) => {
  const calls = await mock(page, undefined, {workspace: true}); await page.goto("/portal/projects/project-one?tab=files&file=cf1_photo&workspace=workspace-b");
  await expect(page.getByRole("dialog", {name: "Preview cf1_photo.jpg"})).toBeVisible();
  expect(calls.filter(call => ["/api/client/projects", "/api/client/feedback-notifications"].includes(call.path) || call.path.endsWith("/metadata")).every(call => call.workspace === "workspace-b")).toBe(true);
});

test("unavailable workspace hints stop all downstream resource probes", async ({page}) => {
  const calls = await mock(page, undefined, {workspace: true}); await page.goto("/portal/feedback/feedback-one?workspace=not-allowed");
  await expect(page.getByText("Access not provisioned", {exact: true})).toBeVisible();
  expect(calls.every(call => ["/api/client/session", "/api/client/v2/workspaces"].includes(call.path))).toBe(true);
});

test("uncertain create retries the exact key and message", async ({page}) => {
  let attempts = 0; const calls = await mock(page, (route, _url, call) => call.path === "/api/client/feedback" && call.method === "POST" ? (++attempts === 1 ? route.fulfill({status: 503, json: {error: "Transient"}}) : route.fulfill({json: detail()})) : undefined);
  await page.goto("/portal/projects/project-one"); await page.getByRole("button", {name: "Leave Feedback"}).click(); await page.getByLabel("Your feedback").fill("Check north edge."); await page.getByRole("button", {name: "Send feedback"}).click();
  await expect(page.getByLabel("Your feedback")).toHaveAttribute("readonly", ""); await page.getByRole("button", {name: "Retry submission"}).click(); await expect(page.getByText("Feedback sent.")).toBeVisible();
  const posts = calls.filter(call => call.method === "POST"); expect(posts).toHaveLength(2); expect(posts[0]?.key).toBe(posts[1]?.key); expect(posts[0]?.body).toEqual(posts[1]?.body);
});

test("workspace Back and Forward validate the destination before feedback reads", async ({page}) => {
  const calls = await mock(page, undefined, {workspace: true}); await page.goto("/portal/feedback/feedback-one?workspace=workspace-a"); await expect(page.getByText("Please check the north edge.")).toBeVisible();
  await page.getByLabel("Client workspace").selectOption("workspace-b"); await expect(page).toHaveURL(/workspace=workspace-b/); const before = calls.length;
  await page.goBack(); await expect(page).toHaveURL(/feedback-one\?workspace=workspace-a/); await expect(page.getByText("Please check the north edge.")).toBeVisible();
  const after = calls.slice(before); expect(after.find(call => call.path === "/api/client/feedback/feedback-one")?.workspace).toBe("workspace-a"); expect(after.findIndex(call => call.path === "/api/client/v2/workspaces")).toBeLessThan(after.findIndex(call => call.path === "/api/client/feedback/feedback-one"));
  await page.goForward(); await expect(page.getByLabel("Client workspace")).toHaveValue("workspace-b");
});

test("a definite rate limit does not permanently lock the message", async ({page}) => {
  await mock(page, (route, _url, call) => call.path === "/api/client/feedback" && call.method === "POST" ? route.fulfill({status: 429, json: {error: "Wait"}}) : undefined);
  await page.goto("/portal/projects/project-one"); await page.getByRole("button", {name: "Leave Feedback"}).click(); await page.getByLabel("Your feedback").fill("First message."); await page.getByRole("button", {name: "Send feedback"}).click(); await expect(page.getByText(/Too many submissions/)).toBeVisible(); await expect(page.getByLabel("Your feedback")).not.toHaveAttribute("readonly", ""); await page.getByLabel("Your feedback").fill("Edited message.");
});

test("late notification continuation cannot resurrect a dismissed feedback update", async ({page}) => {
  let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
  const notice = {id: "notice-one", feedbackId: "feedback-one", title: "Feedback completed", body: "Done", actionPath: "/portal/feedback/feedback-one", readAt: null, createdAt: date};
  await mock(page, (route, _url, call) => call.path === "/api/client/feedback-notifications" ? call.query.has("cursor") ? wait.then(() => late(route, {notifications: [notice], nextCursor: null})) : route.fulfill({json: {notifications: [notice], nextCursor: "next"}}) : call.path === "/api/client/feedback-notifications/notice-one" ? route.fulfill({json: {success: true}}) : undefined);
  await page.goto("/portal"); await page.getByRole("button", {name: /^Notifications/}).click(); const group = page.getByRole("region", {name: "Feedback updates", exact: true}); await group.getByRole("button", {name: "Load more feedback updates"}).click(); await group.getByRole("button", {name: "Dismiss"}).click(); await expect(group.getByText("Feedback completed")).toHaveCount(0); release(); await expect(group.getByText("Loading notifications…")).toHaveCount(0); await expect(group.getByText("Feedback completed")).toHaveCount(0);
});

test("empty creator list pages with a continuation do not claim feedback is absent", async ({page}) => {
  await mock(page, (route, _url, call) => call.path === "/api/client/feedback" ? route.fulfill({json: call.query.has("cursor") ? history() : history(null,{items:[],nextCursor:"next"})}) : undefined);
  await page.goto("/portal/feedback"); await expect(page.getByText(/Continue to check more records/)).toBeVisible(); await page.getByRole("button", {name: "Load more feedback"}).click(); await expect(page.getByRole("heading", {name: "North edge photo.jpg"})).toBeVisible();
});

test("creator history with a replaced original preserves notes but provides no broader or replacement link", async ({page}) => {
  await mock(page, (route, _url, call) => call.path === "/api/client/feedback/feedback-one" ? route.fulfill({json: detail({status: "done", completionNote: "The original export has been replaced.", target: {...item().target, available: false, actionPath: null}})}) : undefined);
  await page.goto("/portal/feedback/feedback-one"); await expect(page.getByText("The original export has been replaced.")).toBeVisible(); await expect(page.getByRole("link", {name: /^Open /})).toHaveCount(0); await expect(page.getByText(/original item is no longer available/)).toBeVisible();
});

test("continuation authorization failure clears previously visible creator feedback", async ({page}) => {
  await mock(page, (route, _url, call) => call.path === "/api/client/feedback" ? route.fulfill(call.query.has("cursor") ? {status: 403, json: {error: "Denied"}} : {json: history(null,{nextCursor:"next"})}) : undefined);
  await page.goto("/portal/feedback"); await expect(page.getByText("North edge photo.jpg")).toBeVisible(); await expect(page.getByText("Please check the north edge.")).toHaveCount(0); await page.getByRole("button", {name: "Load more feedback"}).click(); await expect(page.getByRole("alert")).toBeVisible(); await expect(page.getByText("North edge photo.jpg")).toHaveCount(0);
});

test("feedback history rejects bodies on the redacted list contract",async({page})=>{
  await mock(page,(route,_url,call)=>call.path==="/api/client/feedback"&&call.method==="GET"?route.fulfill({json:history(null,{items:[{...history().items[0],message:"private body"}]})}):undefined);
  await page.goto("/portal/feedback");await expect(page.getByRole("alert")).toBeVisible();await expect(page.getByText("private body")).toHaveCount(0);
});

test("feedback notifications stay in one bell with separate paging and explicit read actions", async ({page}) => {
  const calls = await mock(page, (route, _url, call) => call.path === "/api/client/feedback-notifications" ? route.fulfill({json: {notifications: [{id: "notice-one", feedbackId: "feedback-one", title: "Feedback completed", body: "Your photo feedback was completed.", actionPath: "/portal/feedback/feedback-one", readAt: null, createdAt: date}], nextCursor: null}}) : call.path === "/api/client/feedback-notifications/notice-one" ? route.fulfill({json: {success: true}}) : undefined);
  await page.goto("/portal"); const bell = page.getByRole("button", {name: /^Notifications/}); await expect(bell).toHaveCount(1); await bell.click();
  const group = page.getByRole("region", {name: "Feedback updates", exact: true}); await expect(group.getByRole("link", {name: "Feedback completed"})).toHaveAttribute("href", "/portal/feedback/feedback-one");
  await group.getByRole("button", {name: "Mark read"}).click(); await expect(group.getByRole("button", {name: "Mark read"})).toHaveCount(0); expect(calls.find(call => call.method === "PATCH")?.body).toEqual({action: "read"});
});

test("disabled feedback has no affordances or feedback API probes", async ({page}) => {
  const calls = await mock(page, undefined, {enabled: false}); await page.goto("/portal/projects/project-one"); await expect(page.getByRole("heading", {name: "Church survey", exact: true})).toBeVisible(); await expect(page.getByRole("button", {name: "Leave Feedback"})).toHaveCount(0); expect(calls.some(call => call.path.includes("feedback"))).toBe(false);
});

for (const width of [375, 640, 1280, 3440]) test(`feedback composer and detail remain readable at ${width}px`, async ({page}, info) => {
  test.skip(info.project.name !== "desktop-edge", "Viewport-specific visual coverage");
  await page.setViewportSize({width, height: 1000}); await mock(page); await page.goto("/portal/projects/project-one"); await page.getByRole("button", {name: "Leave Feedback"}).click(); await page.getByLabel("Your feedback").fill("Please check the north edge and the long construction-site filename before the next delivery.");
  await expect(page.getByLabel("Your feedback")).toBeFocused(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (width > 960) expect(await page.evaluate(() => {
    const brand = document.querySelector(".client-portal-header .ltds-brand")!.getBoundingClientRect(), nav = document.querySelector(".client-portal-top-nav")!.getBoundingClientRect();
    return nav.left - brand.right;
  })).toBeGreaterThanOrEqual(8);
  await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({path: info.outputPath(`feedback-composer-${width}.png`)});
  await page.goto("/portal/feedback/feedback-one"); await expect(page.getByText("Please check the north edge.")).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); await page.screenshot({path: info.outputPath(`feedback-detail-${width}.png`)});
  expect(await page.getByRole("link", {name: "Open file"}).evaluate(link => link.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  expect(await page.getByRole("link", {name: "Open file"}).evaluate(link => parseFloat(getComputedStyle(link).paddingLeft))).toBeGreaterThanOrEqual(12);
  if (width === 375 || width === 1280) {
    await page.goto("/portal/projects/project-one?tab=files&file=cf1_photo"); const preview = page.getByRole("dialog", {name: "Preview cf1_photo.jpg"}); await preview.getByRole("button", {name: "Leave Feedback"}).click(); await preview.getByLabel("Your feedback").fill("Please check this exact image.");
    await expect(preview.locator("img")).toHaveCount(1); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); await page.screenshot({path: info.outputPath(`feedback-preview-${width}.png`)});
  }
});

for(const width of [375,1280])test(`redacted feedback history is usable at ${width}px`,async({page},info)=>{
  test.skip(info.project.name!=="desktop-edge","Explicit viewport coverage");await page.setViewportSize({width,height:900});await mock(page);await page.goto("/portal/feedback");
  await expect(page.getByRole("heading",{name:"North edge photo.jpg"})).toBeVisible();await expect(page.getByText("Please check the north edge.")).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  expect(await page.getByRole("link",{name:"View details"}).evaluate(link=>link.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
});
