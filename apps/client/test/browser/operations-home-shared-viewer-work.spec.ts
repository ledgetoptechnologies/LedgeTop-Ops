import { expect, test, type Page } from "@playwright/test";

/** Direct 3D shares on Operations service homes appear in the same flat list as client accounts, and only while the home is current. */
const viewerOrigin = "https://viewer.ledgetopdroneservices.com";
const native = [
  { id: "workspace-b", rootType: "organization", rootPublicId: "org-shared", displayName: "QA internal label B", resourceMode: "native", sourceId: "project-alpha:coastal" },
  { id: "workspace-c", rootType: "organization", rootPublicId: "org-shared", displayName: "QA internal label C", resourceMode: "native", sourceId: "project-alpha:mountain" },
];
const aerial = { serviceId: "service-aerial", providerId: "provider-a", displayLabel: "Aerial operations", revision: 1 };
const home = (workspaceId: string, authorityId: string, services = [aerial]) => ({ authorityId, workspaceId, ownershipEpoch: 1, grantRevision: 1, services });
const opsHome = home("workspace-ops", "12345678-1234-4123-8123-123456789abc");
// The same account can be both a client account and an Operations home; it is asked once. Its home also
// reaches the same service, and a different service that happens to share the label.
const duplicateHome = home("workspace-b", "12345678-1234-4123-8123-123456789abd", [aerial, { ...aerial, serviceId: "service-aerial-west" }, { ...aerial, serviceId: "service-mapping", displayLabel: "Mapping" }]);
const features = () => ({directory: {state: "available", reason: "authorized_capability"}, deliveries: {state: "available", reason: "resource_authorization_required"},
  serviceRequests: {state: "not_supported", reason: "source_not_supported"}, feedback: {state: "temporarily_unavailable", reason: "backend_unavailable"},
  models: {state: "not_supported", reason: "source_not_supported"}, team: {state: "not_supported", reason: "source_not_supported"},
  billing: {state: "not_supported", reason: "source_not_supported"}});
const context = (id: string) => ({workspace: native.find(item => item.id === id)!, contextVersion: `context-${id}`, features: features(), capabilities: {directoryRead: true, deliveryView: true,
  requestV2: false, requestAttachments: false, feedback: false, manageTeam: false, workspaceMembershipManagement: false, delegatedShares: false, viewer: false, viewerShares: false, viewBilling: false}});
const viewerPage = (workspaceId: string, title: string) => ({workspaceId, contextVersion: `viewer-${workspaceId}`, nextCursor: null, items: [{workspaceId, grantId: `grant-${workspaceId}`,
  taskId: `task-${workspaceId}`, scopeType: "task", title, projectName: "Harbor bridge", businessName: null, sharedAt: "2026-08-01T12:00:00Z", updatedAt: "2026-08-20T12:00:00Z",
  expiresAt: null, permissions: {measure: true, cameras: false, download: false}}]});
const titles: Record<string, string> = {"workspace-b": "Seawall scan", "workspace-c": "Ridge roof model", "workspace-ops": "Quarry survey"};

type Call = {path: string; method: string; key?: string};
async function mock(page: Page, setup: {clientAccounts: typeof native | null; homes: () => unknown[]}) {
  const calls: Call[] = [];
  await page.context().route("**/api/client/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    calls.push({path, method: request.method(), key: request.headers()["idempotency-key"]});
    if (path === "/api/client/v2/operations/home") return route.fulfill({json: {resourceMode: "operations_home", homes: setup.homes()}});
    if (path.startsWith("/api/client/v2/operations/home/")) return route.fulfill({status: 403, json: {error: "Client access is not provisioned"}});
    if (path === "/api/client/session") return setup.clientAccounts
      ? route.fulfill({json: {account: {id: "", displayName: "Client portal"}, capabilities: {workspaceHierarchyV2: true}}})
      : route.fulfill({status: 401, json: {error: "Sign in required"}});
    if (path === "/api/client/v2/workspaces" && setup.clientAccounts) return route.fulfill({json: {workspaces: setup.clientAccounts}});
    const match = path.match(/^\/api\/client\/v2\/workspaces\/(workspace-[a-z]+)\/(.+)$/);
    if (match) {
      const [, id, suffix] = match as unknown as [string, string, string];
      const current = setup.homes().some(item => (item as {workspaceId: string}).workspaceId === id) || setup.clientAccounts?.some(item => item.id === id);
      if (suffix === "viewer") return current ? route.fulfill({json: viewerPage(id, titles[id]!)}) : route.fulfill({status: 403, json: {error: "Forbidden"}});
      if (suffix === `viewer/grant-${id}/tasks/task-${id}/session` && request.method() === "POST") {
        const grant = "11111111-1111-4111-8111-111111111111";
        return route.fulfill({status: 201, json: {modelId: "model-direct", grant, grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 1800,
          redeemUrl: `${viewerOrigin}/api/v1/sessions/redeem`, embedUrl: `${viewerOrigin}/session/${grant}`}});
      }
      if (setup.clientAccounts?.some(item => item.id === id)) {
        if (suffix === "context") return route.fulfill({json: context(id)});
        if (suffix === "hierarchy") return route.fulfill({json: {workspaceId: id, sourceId: context(id).workspace.sourceId, contextVersion: `context-${id}`, page: {nextCursor: null}, entries: []}});
        if (suffix === "deliveries") return route.fulfill({json: {workspaceId: id, sourceId: context(id).workspace.sourceId, contextVersion: `context-${id}`, items: [], page: {nextCursor: null}}});
      }
    }
    return route.fulfill({status: 404, json: {error: "Unsupported fixture endpoint"}});
  });
  return calls;
}
const card = (page: Page) => page.locator(".shared-viewer-work");
const rows = (page: Page) => card(page).locator(".shared-viewer-work-list > li");
const viewerReads = (calls: Call[]) => calls.filter(call => call.method === "GET" && call.path.endsWith("/viewer")).map(call => call.path);
/** Revalidation is throttled to once a second; a focus event after that starts one. */
async function revalidateHomes(page: Page) {
  await page.waitForTimeout(1_100);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

test("client accounts and Operations homes share one flat list, each account asked once, without adding a selectable account", async ({page}) => {
  const calls = await mock(page, {clientAccounts: native, homes: () => [opsHome, duplicateHome]});
  await page.goto("/portal");
  await expect(rows(page)).toHaveCount(3);
  await expect(card(page)).toContainText("Seawall scan");
  await expect(card(page)).toContainText("Ridge roof model");
  await expect(card(page)).toContainText("Quarry survey");
  await expect(card(page)).not.toContainText("QA internal label");
  await expect(rows(page).filter({hasText: "Quarry survey"}).getByRole("link", {name: /^Open 3D model/}))
    .toHaveAttribute("href", "/portal/viewer/grant-workspace-ops/tasks/task-workspace-ops?workspace=workspace-ops");
  expect(viewerReads(calls).sort()).toEqual([
    "/api/client/v2/workspaces/workspace-b/viewer", "/api/client/v2/workspaces/workspace-c/viewer", "/api/client/v2/workspaces/workspace-ops/viewer",
  ]);
  // The Operations home is never opened as a client account.
  expect(calls.some(call => call.path.startsWith("/api/client/v2/workspaces/workspace-ops/") && !call.path.endsWith("/viewer"))).toBe(false);
  expect(new URL(page.url()).searchParams.has("workspace")).toBe(false);
  // Shared work with something in it comes before the (empty) projects card.
  const sharedTop = (await card(page).boundingBox())!.y, projectsTop = (await page.locator(".portal-home-projects").boundingBox())!.y;
  expect(sharedTop).toBeLessThan(projectsTop);
  // One service reached through two homes is listed once; a different service with the same label is not merged.
  const services = page.getByRole("region", {name: "Independent operations service summary"}).getByRole("listitem");
  await expect(services).toHaveText(["Aerial operations", "Aerial operations", "Mapping"]);
});

test("an Operations home that is removed on revalidation drops its shared work; client accounts stay", async ({page}) => {
  let homes: unknown[] = [opsHome];
  await mock(page, {clientAccounts: native, homes: () => homes});
  await page.goto("/portal");
  await expect(rows(page)).toHaveCount(3);
  homes = [];
  await revalidateHomes(page);
  await expect(rows(page)).toHaveCount(2);
  await expect(card(page)).not.toContainText("Quarry survey");
  await expect(card(page)).toContainText("Seawall scan");
});

test("a client with only an Operations home sees its shared 3D work and opens it with that exact account", async ({page}) => {
  await page.context().route(`${viewerOrigin}/**`, route => route.fulfill({contentType: "text/html", body: "<!doctype html><body><div id=\"loaded\">direct model</div></body>"}));
  const calls = await mock(page, {clientAccounts: null, homes: () => [opsHome]});
  await page.goto("/portal");
  await expect(page.getByRole("heading", {level: 1, name: "Your services"})).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Quarry survey");
  await rows(page).first().getByRole("link", {name: /^Open 3D model/}).click();
  await expect(page).toHaveURL(/\/portal\/viewer\/grant-workspace-ops\/tasks\/task-workspace-ops\?workspace=workspace-ops$/);
  await expect(page.frameLocator("iframe").locator("#loaded")).toHaveText("direct model");
  const posts = calls.filter(call => call.method === "POST");
  expect(posts.map(call => call.path)).toEqual(["/api/client/v2/workspaces/workspace-ops/viewer/grant-workspace-ops/tasks/task-workspace-ops/session"]);
  expect(posts[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
});

test("an Operations-only client's shared work disappears when the home is no longer current", async ({page}) => {
  let homes: unknown[] = [opsHome];
  await mock(page, {clientAccounts: null, homes: () => homes});
  await page.goto("/portal");
  await expect(rows(page)).toHaveCount(1);
  homes = [];
  await revalidateHomes(page);
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByText("Quarry survey")).toHaveCount(0);
});

test("a direct link to an Operations home's task whose access was removed never requests a session", async ({page}) => {
  const calls = await mock(page, {clientAccounts: null, homes: () => []});
  await page.goto("/portal/viewer/grant-workspace-ops/tasks/task-workspace-ops?workspace=workspace-ops");
  await expect(page.getByRole("alert")).toContainText("This shared 3D model isn’t available here yet.");
  expect(calls.filter(call => call.method === "POST")).toEqual([]);
});
