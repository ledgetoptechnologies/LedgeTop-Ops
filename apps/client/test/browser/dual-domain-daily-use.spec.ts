import { expect, test, type Page, type Route } from "@playwright/test";

const workspace = { id: "workspace-one", rootType: "organization", rootPublicId: "org-one", displayName: "Acme Surveying", resourceMode: "native", sourceId: "project-alpha:acme" };
const context = {
  workspace,
  contextVersion: "context-one",
  features: {
    directory: { state: "available", reason: "authorized_capability" },
    deliveries: { state: "available", reason: "resource_authorization_required" },
    serviceRequests: { state: "not_supported", reason: "source_not_supported" },
    feedback: { state: "temporarily_unavailable", reason: "backend_unavailable" },
    models: { state: "not_supported", reason: "source_not_supported" },
    team: { state: "not_supported", reason: "source_not_supported" },
    billing: { state: "not_supported", reason: "source_not_supported" },
  },
  capabilities: { directoryRead: true, deliveryView: true, requestV2: false, requestAttachments: false, feedback: false, manageTeam: false, workspaceMembershipManagement: false, delegatedShares: false, viewer: false, viewerShares: false, viewBilling: false },
};
const envelope = { workspaceId: workspace.id, sourceId: workspace.sourceId, contextVersion: context.contextVersion };
const hierarchy = { ...envelope, page: { nextCursor: null }, entries: [
  { type: "organization", publicId: "org-one", parentType: null, parentPublicId: null, displayName: workspace.displayName, sourceVersion: "1" },
  { type: "project", publicId: "project-one", parentType: "organization", parentPublicId: "org-one", displayName: "North site survey", sourceVersion: "1" },
] };
const deliveries = { ...envelope, items: [{ id: "folder-one", displayName: "Final deliverables", owner: { type: "project", publicId: "project-one" } }], page: { nextCursor: null } };

type State = { session: 200 | 401 | 403; workspaces?: typeof workspace[]; delayDeliveries?: boolean };
type Call = { path: string; workspace?: string };

async function installFixture(page: Page, state: State) {
  const calls: Call[] = [];
  let releaseDeliveries: (() => void) | undefined;
  const deliveryGate = new Promise<void>(resolve => { releaseDeliveries = resolve; });
  await page.route("**/api/client/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    calls.push({ path, workspace: request.headers()["x-ltds-workspace-id"] });
    if (path === "/api/client/session") {
      if (state.session !== 200) return route.fulfill({ status: state.session, json: { error: state.session === 401 ? "Session expired" : "Not provisioned" } });
      return route.fulfill({ json: { account: { id: "account-one", displayName: "Acme Surveying" }, capabilities: { workspaceHierarchyV2: true } } });
    }
    if (path === "/api/client/v2/workspaces") return route.fulfill({ json: { workspaces: state.workspaces ?? [workspace] } });
    if (path === "/api/client/v2/workspaces/workspace-one/context") return route.fulfill({ json: context });
    if (path === "/api/client/v2/workspaces/workspace-one/hierarchy") return route.fulfill({ json: hierarchy });
    if (path === "/api/client/v2/workspaces/workspace-one/deliveries") {
      if (state.delayDeliveries) await deliveryGate;
      try { return await route.fulfill({ json: deliveries }); } catch { return; }
    }
    return route.fulfill({ status: 404, json: { error: "Unsupported fixture endpoint" } });
  });
  return { calls, releaseDeliveries: () => releaseDeliveries?.() };
}

async function openNavigation(page: Page) {
  const desktop = page.getByRole("navigation", { name: "Client portal" });
  const mobile = page.getByRole("button", { name: "Open navigation" });
  await expect(desktop.or(mobile)).toBeVisible();
  if (await mobile.isVisible()) {
    await mobile.focus();
    await page.keyboard.press("Enter");
    return page.getByRole("dialog", { name: "Navigation" });
  }
  return desktop;
}

test("J7 daily-use navigation survives direct links, refresh, history, and keyboard logout", async ({ page }, testInfo) => {
  const fixture = await installFixture(page, { session: 200 });
  await page.goto("/portal?workspace=workspace-one");
  expect(new URL(page.url()).hostname).toBe(testInfo.project.name.startsWith("drone-") ? "portal.drone.test" : "portal.technology.test");
  await expect(page.getByRole("heading", { name: "Acme Surveying" })).toBeVisible();
  await expect(page.getByText("North site survey", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("North site survey", { exact: true })).toBeVisible();

  let navigation = await openNavigation(page);
  await navigation.getByRole("link", { name: "Deliveries" }).click();
  await expect(page).toHaveURL(/\/portal\/deliveries\?workspace=workspace-one$/);
  await expect(page.getByRole("button", { name: /^Open folder\s*:/ })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/portal\?workspace=workspace-one$/);
  await expect(page.getByText("North site survey", { exact: true })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/portal\/deliveries\?workspace=workspace-one$/);

  const account = page.getByRole("button", { name: "Account menu for Acme Surveying" });
  await account.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Account" });
  await expect(menu.getByRole("menuitem", { name: "Account" })).toBeFocused();
  await expect(menu.getByRole("menuitem", { name: "Logout" })).toHaveAttribute("href", "/cdn-cgi/access/logout");
  await page.keyboard.press("Escape");
  await expect(account).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(fixture.calls.filter(call => call.path === "/api/client/session").every(call => call.workspace === undefined)).toBe(true);
});

for (const invalidation of [
  { status: 401 as const, title: "Sign in required", label: "session expiry" },
  { status: 403 as const, title: "Access not provisioned", label: "access revocation" },
]) test(`J7 ${invalidation.label} removes protected content and a late active read cannot restore it`, async ({ page }) => {
  const state: State = { session: 200, delayDeliveries: true };
  const fixture = await installFixture(page, state);
  await page.goto("/portal/deliveries?workspace=workspace-one");
  await expect.poll(() => fixture.calls.some(call => call.path.endsWith("/deliveries"))).toBe(true);
  state.session = invalidation.status;
  await page.reload();
  await expect(page.getByText(invalidation.title, { exact: true })).toBeVisible();
  fixture.releaseDeliveries();
  await expect(page.getByText("Final deliverables", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Connected client workspace" })).toHaveCount(0);
});

test("J7 unauthorized identity and cross-tenant workspace hints fail closed", async ({ page }) => {
  const state: State = { session: 403 };
  const fixture = await installFixture(page, state);
  await page.goto("/portal?workspace=workspace-one");
  await expect(page.getByText("Access not provisioned", { exact: true })).toBeVisible();
  expect(fixture.calls.map(call => call.path)).toEqual(["/api/client/session"]);

  state.session = 200;
  state.workspaces = [workspace];
  await page.goto("/portal/deliveries?workspace=another-tenant");
  await expect(page.getByText("Access not provisioned", { exact: true })).toBeVisible();
  expect(fixture.calls.some(call => call.path.includes("another-tenant/context") || call.path.includes("another-tenant/deliveries"))).toBe(false);
  await expect(page.getByText("Final deliverables", { exact: true })).toHaveCount(0);
});
