import { expect, test, type Page, type Route } from "@playwright/test";
import { OPERATIONS_DIRECT_FOLDER_API, OPERATIONS_DIRECT_FOLDER_CAPABILITY_API } from "../../src/client/direct-folder-api";
import type { PortalOperationsHomeResponse } from "../../src/client/portal-api";

// Synthetic native-only homes; these intentionally do not describe PA-v2 client workspaces.
const response: PortalOperationsHomeResponse = {resourceMode: "operations_home", homes: [
  {authorityId: "12345678-1234-4123-8123-123456789abc", workspaceId: "workspace-one", ownershipEpoch: 2, grantRevision: 4, services: []},
  {authorityId: "22345678-1234-4123-8123-123456789abc", workspaceId: "workspace-two", ownershipEpoch: 1, grantRevision: 2, services: []},
]};
const folderOne = "df1_c2hhcmVkLWZvbGRlci0x", folderTwo = "df1_c2hhcmVkLWZvbGRlci0y", fileHandle = "df1_c2hhcmVkLWZpbGUtMQ";
const date = "2026-11-15T12:00:00.000Z";
const file = {id: fileHandle, name: "synthetic-plan.pdf", size: 12, uploadedAt: date, contentType: "application/pdf", kind: "pdf",
  previewPath: `${OPERATIONS_DIRECT_FOLDER_API}/preview?file=${fileHandle}`, thumbnailPath: null,
  downloadPath: `${OPERATIONS_DIRECT_FOLDER_API}/download?file=${fileHandle}`};
const videoHandle = "df1_c3ludGhldGljLXZpZGVvLTAx";
const video = {id: videoHandle, name: "synthetic-walkthrough.mp4", size: 16, uploadedAt: date, contentType: "video/mp4", kind: "video",
  previewPath: `${OPERATIONS_DIRECT_FOLDER_API}/preview?file=${videoHandle}`, thumbnailPath: null,
  downloadPath: `${OPERATIONS_DIRECT_FOLDER_API}/download?file=${videoHandle}`};
const folders = {
  "workspace-one": {resourceMode: "direct_workspace_folders", items: [{id: folderOne, name: "Synthetic shared set one", expiresAt: null}]},
  "workspace-two": {resourceMode: "direct_workspace_folders", items: [{id: folderTwo, name: "Synthetic shared set two", expiresAt: null}]},
} as const;
const folderPage = {files: [file, video], folders: [], breadcrumbs: [{id: folderOne, name: "Synthetic shared set one"}], folderId: folderOne, prefix: "", cursor: null};
const paginatedFolderPage = {...folderPage, cursor: "df1_synthetic-next-page"};
type Call = {path: string; method: string; workspace?: string; query: URLSearchParams};
type Fixture = {capability: () => {status?: number; body?: unknown}; list: (workspace: string) => {status?: number; body?: unknown};
  files?: (cursor: string | null) => {status?: number; body?: unknown}};

async function mock(page: Page, fixture: Fixture) {
  const calls: Call[] = [];
  await page.context().route("**/api/client/**", async route => {
    const request = route.request(), url = new URL(request.url());
    const call: Call = {path: url.pathname, method: request.method(), workspace: request.headers()["x-ltds-workspace-id"], query: url.searchParams};
    calls.push(call);
    if (call.path === "/api/client/v2/operations/home") return route.fulfill({json: response});
    if (call.path === "/api/client/session") return route.fulfill({status: 403, json: {error: "Client access is not provisioned"}});
    if (call.path === OPERATIONS_DIRECT_FOLDER_CAPABILITY_API) {
      const result = fixture.capability(); return route.fulfill({status: result.status ?? 200, json: result.body});
    }
    if (call.path === OPERATIONS_DIRECT_FOLDER_API) {
      const result = fixture.list(call.workspace ?? ""); return route.fulfill({status: result.status ?? 200, json: result.body});
    }
    if (call.path === `${OPERATIONS_DIRECT_FOLDER_API}/${folderOne}/files`) {
      const result = fixture.files?.(call.query.get("cursor")) ?? {body: folderPage};
      return route.fulfill({status: result.status ?? 200, json: result.body});
    }
    if (call.path === `${OPERATIONS_DIRECT_FOLDER_API}/preview`) return call.query.get("file") === videoHandle
      ? route.fulfill({contentType: "video/mp4", body: "synthetic video bytes; mocked route only"})
      : route.fulfill({contentType: "application/pdf", body: "%PDF-1.4\n%%EOF"});
    if (call.path === `${OPERATIONS_DIRECT_FOLDER_API}/download`) return route.fulfill({
      headers: {"Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="synthetic-plan.pdf"'}, body: "%PDF-1.4\n%%EOF",
    });
    if (call.path.endsWith("/financial")) return route.fulfill({status: 403, json: {error: "Client access is not provisioned"}});
    if (call.path.startsWith("/api/client/v2/workspaces/") && call.path.endsWith("/viewer")) return route.fulfill({status: 403, json: {error: "Client access is not provisioned"}});
    return route.fulfill({status: 404, json: {error: "not found"}});
  });
  return calls;
}

const enabled = () => ({body: {protocolVersion: 1, enabled: true}});
const disabled = () => ({body: {protocolVersion: 1, enabled: false}});

test("an explicit disabled capability hides direct folders and never lists them", async ({page}) => {
  const calls = await mock(page, {capability: disabled, list: workspace => ({body: folders[workspace as keyof typeof folders]})});
  await page.goto("/portal");
  await expect(page.locator("#operations-direct-folders-heading")).toHaveCount(0);
  await expect.poll(() => calls.some(call => call.path === OPERATIONS_DIRECT_FOLDER_CAPABILITY_API && call.workspace === undefined)).toBe(true);
  expect(calls.some(call => call.path === OPERATIONS_DIRECT_FOLDER_API)).toBe(false);
});

test("a failed capability check stays unavailable and can be retried without implying an empty list", async ({page}) => {
  let checks = 0;
  const calls = await mock(page, {capability: () => ++checks === 1 ? {status: 503, body: {error: "Unavailable"}} : enabled(),
    list: workspace => ({body: folders[workspace as keyof typeof folders]})});
  await page.goto("/portal");
  const panel = page.locator(".portal-card").filter({has: page.getByRole("heading", {name: "Shared folders", exact: true})});
  await expect(panel.getByRole("alert")).toContainText("availability could not be checked");
  await expect(panel).not.toContainText("No folders are currently shared with you.");
  await panel.getByRole("button", {name: "Retry availability check"}).click();
  await expect(panel.getByRole("button", {name: "Browse shared folders"})).toBeVisible();
  expect(calls.some(call => call.path === OPERATIONS_DIRECT_FOLDER_API)).toBe(false);
});

test("a denied later page clears previously displayed private files and controls", async ({page}) => {
  const calls = await mock(page, {capability: enabled,
    list: workspace => ({body: folders[workspace as keyof typeof folders]}),
    files: cursor => cursor ? {status: 403, body: {error: "Access changed"}} : {body: paginatedFolderPage}});
  await page.goto("/portal");
  const panel = page.locator(".portal-card").filter({has: page.getByRole("heading", {name: "Shared folders", exact: true})});
  await panel.getByRole("button", {name: "Browse shared folders"}).click();
  await panel.getByRole("button", {name: /Synthetic shared set one/}).click();
  await expect(panel.getByText("synthetic-plan.pdf", {exact: true})).toBeVisible();
  await panel.getByRole("button", {name: "Load more files"}).click();
  await expect(panel.getByRole("alert")).toContainText("could not be verified");
  await expect(panel.getByText("synthetic-plan.pdf", {exact: true})).toHaveCount(0);
  await expect(panel.getByText("synthetic-walkthrough.mp4", {exact: true})).toHaveCount(0);
  await expect(panel.getByRole("link", {name: "Download"})).toHaveCount(0);
  await expect(panel.getByRole("button", {name: "Load more files"})).toHaveCount(0);
  expect(calls.some(call => call.path === `${OPERATIONS_DIRECT_FOLDER_API}/${folderOne}/files` && call.query.has("cursor"))).toBe(true);
});

test("enabled native homes list one flat set, open files and clear old data on visibility revalidation failure", async ({page}) => {
  let listPass = 0;
  const calls = await mock(page, {capability: enabled, list: workspace => {
    if (workspace === "workspace-two" && listPass++ > 0) return {status: 503, body: {error: "Unavailable"}};
    return {body: folders[workspace as keyof typeof folders]};
  }});
  await page.goto("/portal");
  const panel = page.locator(".portal-card").filter({has: page.getByRole("heading", {name: "Shared folders", exact: true})});
  await expect(panel.getByRole("button", {name: "Browse shared folders"})).toBeVisible();
  expect(calls.some(call => call.path === OPERATIONS_DIRECT_FOLDER_API)).toBe(false);
  await panel.getByRole("button", {name: "Browse shared folders"}).click();
  await expect(panel.getByRole("button", {name: /Synthetic shared set one/})).toBeVisible();
  await expect(panel.getByRole("button", {name: /Synthetic shared set two/})).toBeVisible();
  await expect(panel.getByRole("combobox")).toHaveCount(0);
  await expect(panel).not.toContainText(/workspace-one|workspace-two|business/i);
  expect(calls.filter(call => call.path === OPERATIONS_DIRECT_FOLDER_API).map(call => call.workspace).sort()).toEqual(["workspace-one", "workspace-two"]);
  expect(calls.find(call => call.path === OPERATIONS_DIRECT_FOLDER_CAPABILITY_API)?.workspace).toBeUndefined();

  await panel.getByRole("button", {name: /Synthetic shared set one/}).click();
  await expect(panel.getByText("synthetic-plan.pdf", {exact: true})).toBeVisible();
  const previewLink = panel.getByRole("link", {name: "Preview"});
  await expect(previewLink).toHaveAttribute("href", file.previewPath);
  const [preview] = await Promise.all([page.waitForEvent("popup"), previewLink.click()]);
  await expect(preview).toHaveURL(file.previewPath);
  await preview.close();
  const downloadLink = panel.locator(".portal-file-row").filter({hasText:"synthetic-plan.pdf"}).getByRole("link", {name: "Download"});
  await expect(downloadLink).toHaveAttribute("href", file.downloadPath);
  await expect(downloadLink).toHaveAttribute("download", "");

  // This verifies the persistent player controls are mounted, not real media decoding.
  await panel.getByRole("button", {name: "Preview", exact: true}).click();
  const videoDialog = page.getByRole("dialog", {name: "synthetic-walkthrough.mp4"});
  await expect(videoDialog).toBeVisible();
  await expect(videoDialog.getByRole("button", {name: /Play video|Pause video/})).toBeVisible();
  await expect(videoDialog.getByRole("slider", {name: "Seek video"})).toBeVisible();
  await expect(videoDialog.getByRole("button", {name: "Fullscreen"})).toBeVisible();
  await expect(videoDialog.getByRole("link", {name: "Download"})).toHaveAttribute("href", video.downloadPath);
  await videoDialog.getByRole("button", {name: "Close"}).click();

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {configurable: true, value: "hidden"});
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(panel.getByText("synthetic-plan.pdf", {exact: true})).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {configurable: true, value: "visible"});
    document.dispatchEvent(new Event("visibilitychange"));
  });
  // The parent portal discards and re-admits its entire native home subtree on
  // foreground return. Reopen browsing on the freshly admitted component;
  // no prior file metadata may survive that rebootstrap.
  await expect(panel.getByRole("button", {name: "Browse shared folders"})).toBeVisible();
  await expect(panel.getByText("synthetic-plan.pdf", {exact: true})).toHaveCount(0);
  await panel.getByRole("button", {name: "Browse shared folders"}).click();
  await expect(panel.getByRole("alert")).toContainText("temporarily unavailable");
  await expect(panel.getByText("synthetic-plan.pdf", {exact: true})).toHaveCount(0);
  await expect(panel.getByText("Synthetic shared set one", {exact: true})).toHaveCount(0);
  expect(calls.filter(call => call.path === OPERATIONS_DIRECT_FOLDER_API).length).toBeGreaterThanOrEqual(4);
});
