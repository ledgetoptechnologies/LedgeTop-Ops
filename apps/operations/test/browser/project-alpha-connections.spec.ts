import { expect, test, type Page, type Route } from "@playwright/test";

const endpoint = "/api/admin/integrations/project-alpha/connectors";
const primary = "project-alpha:primary", secondary = "project-alpha:secondary";
type Connector = { sourceId: string; displayName: string; producerBindingId: string; snapshotOrigin: string; snapshotBasePath: string;
  applicationKey: string; profile: "primary_legacy" | "business_data"; state: "pending" | "active" | "suspended" | "retired";
  readVisible: boolean; activeRevision: number; version: number };
type Directory = { connectors: Connector[]; legacyPrimary: boolean; health: Array<{ sourceId: string; status: string; lastAttemptAt: string | null; lastSuccessAt: string | null; lastErrorCode: string | null }>;
  recovery?: Array<{ sourceId: string; lastAttemptAt: string | null; lastSuccessAt: string | null; nextAttemptAt: string | null; status: "never" | "running" | "success" | "failed" | "deferred"; errorCode: string | null; failureCount: number }>;
  portal?: { available: boolean; authorities: Array<{ sourceId: string; state: Connector["state"]; connectorRevision: number }>; recovery: null };
  projectManagement?: Array<{ sourceId: string; version: number; revision: number; enabled: boolean; reviewedUrlTemplate: string | null }> };
const connector = (sourceId = secondary): Connector => ({ sourceId, displayName: sourceId === primary ? "LTDS Project Alpha" : "LTT Project Alpha", producerBindingId: sourceId === primary ? "ltds" : "ltt", snapshotOrigin: sourceId === primary ? "https://alpha.example.test" : "https://alpha-secondary.example.test", snapshotBasePath: "/", applicationKey: "ltds_ops", profile: sourceId === primary ? "primary_legacy" : "business_data", state: "active", readVisible: true, activeRevision: 1, version: 2 });
async function fixture(page: Page, data: Directory) {
  const requests: Array<{ path: string; method: string; body: Record<string, unknown> | null }> = [];
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: { user: { id: "admin", email: "admin@example.test", displayName: "Admin", status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["administration.view", "integrations.manage"], divisions: [] }, csrfToken: "csrf", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    if (path === "/api/admin/audit") return route.fulfill({ json: { events: [] } });
    if (path === "/api/admin/portal-workflow-readiness") return route.fulfill({ json: { ready: false, workflows: {} } });
    if (!path.startsWith(endpoint)) return route.fulfill({ status: 404, json: { error: "Unexpected endpoint" } });
    const body = route.request().postData() ? route.request().postDataJSON() as Record<string, unknown> : null;
    requests.push({ path, method: route.request().method(), body });
    if (path === endpoint && route.request().method() === "GET") return route.fulfill({ json: data });
    if (path.endsWith("/sync") && route.request().method() === "POST") return route.fulfill({ json: { status: "success" } });
    if (path.endsWith("/project-management") && route.request().method() === "PUT") return route.fulfill({ json: { projectManagement: { sourceId: secondary, version: 1, revision: 1, enabled: true, reviewedUrlTemplate: body?.reviewedUrlTemplate } } });
    return route.fulfill({ status: 405, json: { error: "Source authority is deployment-configured" } });
  });
  return requests;
}

test("shows deployment-configured source status without registration or source-authority controls", async ({ page }) => {
  const requests = await fixture(page, { connectors: [connector(primary), connector()], legacyPrimary: false, health: [], recovery: [], portal: { available: true, authorities: [], recovery: null }, projectManagement: [] });
  await page.goto("/administration");
  const card = page.getByRole("region", { name: "LTT Project Alpha connection" });
  await expect(card).toContainText("Business data only");
  await expect(card).toContainText("Client portal · Not configured");
  await expect(page.getByText("Register a source", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Rotate credentials and producer authentication", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Activate connection|Suspend sync|Retire connection|Configure client portal/i })).toHaveCount(0);
  expect(requests.filter(request => request.method !== "GET")).toEqual([]);
});

test("syncs exactly the selected deployment source and leaves source state unchanged", async ({ page }) => {
  const requests = await fixture(page, { connectors: [connector(primary), connector()], legacyPrimary: false, health: [], recovery: [], portal: { available: true, authorities: [], recovery: null }, projectManagement: [] });
  await page.goto("/administration");
  await page.getByRole("region", { name: "LTT Project Alpha connection" }).getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "LTT Project Alpha synchronization finished." })).toBeVisible();
  expect(requests.filter(request => request.method !== "GET")).toEqual([{ path: `${endpoint}/project-alpha%3Asecondary/sync`, method: "POST", body: {} }]);
});

test("retains the separately scoped reviewed project-creation route", async ({ page }) => {
  const requests = await fixture(page, { connectors: [connector(primary), connector()], legacyPrimary: false, health: [], recovery: [], portal: { available: true, authorities: [], recovery: null }, projectManagement: [] });
  await page.goto("/administration");
  const management = page.getByRole("region", { name: "LTT Project Alpha connection" }).getByRole("group", { name: "Project management" });
  await management.getByRole("checkbox", { name: "Enable external project creation" }).check();
  await management.getByLabel("Reviewed Project Alpha URL template").fill("https://alpha-secondary.example.test/projects/{recordId}");
  page.once("dialog", dialog => void dialog.accept());
  await management.getByRole("button", { name: "Save project route" }).click();
  await expect(management.getByRole("status")).toContainText("Project creation link enabled.");
  expect(requests.filter(request => request.method === "PUT")).toEqual([expect.objectContaining({ path: `${endpoint}/project-alpha%3Asecondary/project-management`, body: expect.objectContaining({ expectedConnectorVersion: 2, expectedVersion: null, reviewedUrlTemplate: "https://alpha-secondary.example.test/projects/{recordId}" }) })]);
});

test("keeps the original primary status and manual sync available while no source manifest is deployed", async ({ page }) => {
  const requests = await fixture(page, { connectors: [], legacyPrimary: true, health: [{ sourceId: primary, status: "healthy", lastAttemptAt: "2026-09-07T00:00:00Z", lastSuccessAt: "2026-09-07T00:00:02Z", lastErrorCode: null }], recovery: [], portal: { available: false, authorities: [], recovery: null }, projectManagement: [] });
  await page.goto("/administration");
  const card = page.getByRole("region", { name: "Primary connection" });
  await expect(card).toContainText("original deployment configuration");
  await card.getByRole("button", { name: "Sync primary now" }).click();
  expect(requests.filter(request => request.method !== "GET")).toEqual([{ path: `${endpoint}/project-alpha%3Aprimary/sync`, method: "POST", body: {} }]);
});
