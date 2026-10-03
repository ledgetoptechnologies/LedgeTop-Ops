import { expect, test, type Page, type Route } from "@playwright/test";

const endpoint = "/api/admin/integrations/project-alpha/connectors";
const apiV2SourcesEndpoint = "/api/admin/integrations/project-alpha/api-v2/sources";
const inventoryEndpoint = "/api/admin/integrations/project-alpha/api-v2/sync-page";
const adoptionEndpoint = "/api/admin/integrations/project-alpha/api-v2/directory/read-adoptions";
const adoptionCandidatesEndpoint = `${adoptionEndpoint}/candidates`;
const primary = "project-alpha:primary", secondary = "project-alpha:secondary";
type Connector = { sourceId: string; displayName: string; producerBindingId: string; snapshotOrigin: string; snapshotBasePath: string;
  applicationKey: string; profile: "primary_legacy" | "business_data"; state: "pending" | "active" | "suspended" | "retired";
  readVisible: boolean; activeRevision: number; version: number };
type Directory = { connectors: Connector[]; legacyPrimary: boolean; health: Array<{ sourceId: string; status: string; lastAttemptAt: string | null; lastSuccessAt: string | null; lastErrorCode: string | null }>;
  recovery?: Array<{ sourceId: string; lastAttemptAt: string | null; lastSuccessAt: string | null; nextAttemptAt: string | null; status: "never" | "running" | "success" | "failed" | "deferred"; errorCode: string | null; failureCount: number }>;
  portal?: { available: boolean; authorities: Array<{ sourceId: string; state: Connector["state"]; connectorRevision: number }>; recovery: null };
  projectManagement?: Array<{ sourceId: string; version: number; revision: number; enabled: boolean; reviewedUrlTemplate: string | null }> };
const connector = (sourceId = secondary): Connector => ({ sourceId, displayName: sourceId === primary ? "LTDS Project Alpha" : "LTT Project Alpha", producerBindingId: sourceId === primary ? "ltds" : "ltt", snapshotOrigin: sourceId === primary ? "https://alpha.example.test" : "https://alpha-secondary.example.test", snapshotBasePath: "/", applicationKey: "ltds_ops", profile: sourceId === primary ? "primary_legacy" : "business_data", state: "active", readVisible: true, activeRevision: 1, version: 2 });
type OperatorResponse = Record<string, unknown>;
type OperatorResponses = { inventory?: OperatorResponse | ((body: Record<string, unknown> | null, requestIndex: number) => OperatorResponse); candidates?: unknown; reserve?: unknown; compare?: unknown; seal?: unknown; finalize?: unknown };
async function fixture(page: Page, data: Directory, operator: OperatorResponses = {}) {
  const requests: Array<{ path: string; method: string; body: Record<string, unknown> | null; query?: string }> = [];
  let inventoryRequestIndex = 0;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: { user: { id: "admin", email: "admin@example.test", displayName: "Admin", status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["administration.view", "integrations.manage"], divisions: [] }, csrfToken: "csrf", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    if (path === "/api/admin/audit") return route.fulfill({ json: { events: [] } });
    if (path === "/api/admin/portal-workflow-readiness") return route.fulfill({ json: { ready: false, workflows: {} } });
    if (path === apiV2SourcesEndpoint && route.request().method() === "GET")
      return route.fulfill({ json: { sources: [secondary] } });
    const body = route.request().postData() ? route.request().postDataJSON() as Record<string, unknown> : null;
    if (path === inventoryEndpoint && route.request().method() === "POST") {
      requests.push({ path, method: route.request().method(), body });
      if (!operator.inventory) return route.fulfill({ status: 404, json: { error: "Not found" } });
      const response = typeof operator.inventory === "function" ? operator.inventory(body, inventoryRequestIndex++) : operator.inventory;
      return route.fulfill({ json: response });
    }
    if (path === adoptionCandidatesEndpoint && route.request().method() === "GET") {
      requests.push({ path, method: route.request().method(), body: null, query: new URL(route.request().url()).search.slice(1) });
      return operator.candidates ? route.fulfill({ json: operator.candidates }) : route.fulfill({ status: 404, json: { error: "Not found" } });
    }
    if (path === adoptionEndpoint && route.request().method() === "POST") {
      requests.push({ path, method: route.request().method(), body });
      return operator.reserve ? route.fulfill({ json: operator.reserve }) : route.fulfill({ status: 404, json: { error: "Not found" } });
    }
    if (path.startsWith(`${adoptionEndpoint}/`) && path.endsWith("/field-comparison") && route.request().method() === "POST") {
      requests.push({ path, method: route.request().method(), body });
      return operator.compare ? route.fulfill({ json: operator.compare }) : route.fulfill({ status: 404, json: { error: "Not found" } });
    }
    if (path.startsWith(`${adoptionEndpoint}/`) && path.endsWith("/field-review") && route.request().method() === "POST") {
      requests.push({ path, method: route.request().method(), body });
      return operator.seal ? route.fulfill({ json: operator.seal }) : route.fulfill({ status: 404, json: { error: "Not found" } });
    }
    if (path.startsWith(`${adoptionEndpoint}/field-reviews/`) && path.endsWith("/finalize") && route.request().method() === "POST") {
      requests.push({ path, method: route.request().method(), body });
      return operator.finalize ? route.fulfill({ json: operator.finalize }) : route.fulfill({ status: 404, json: { error: "Not found" } });
    }
    if (!path.startsWith(endpoint)) return route.fulfill({ status: 404, json: { error: "Unexpected endpoint" } });
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
  await expect(page.getByRole("button", { name: /Activate connection|Suspend sync|Retire connection/i })).toHaveCount(0);
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
  await expect(page.getByRole("status").filter({ hasText: "Primary connection synchronization finished." })).toBeVisible();
  expect(requests.filter(request => request.method !== "GET")).toEqual([{ path: `${endpoint}/project-alpha%3Aprimary/sync`, method: "POST", body: {} }]);
});

test("requests only one explicit bounded API-v2 inventory page and stops on a stale binding", async ({ page }) => {
  const requests = await fixture(page, { connectors: [connector()], legacyPrimary: false, health: [], recovery: [], portal: { available: true, authorities: [], recovery: null }, projectManagement: [] }, {
    inventory: { status: "partial", directory: { status: "persisted", itemCount: 2, conflictCount: 0, hasMore: true, continuationToken: "opaque-directory-1" },
      projects: { status: "blocked", reason: "binding_stale" } },
  });
  await page.goto("/administration");
  await page.getByText("Staging API-v2 operator review").click();
  const inventory = page.getByRole("region", { name: "Bounded API-v2 inventory" });
  await inventory.getByRole("button", { name: "Read one bounded inventory page" }).click();
  await expect(inventory).toContainText("Directory: 2 observed · 0 conflicts · more pages remain");
  await expect(inventory).toContainText("Projects: stopped because the exact binding is stale");
  await expect(inventory.getByRole("button", { name: "Continue Directory" })).toBeVisible();
  await expect(inventory.getByRole("button", { name: "Continue Projects" })).toHaveCount(0);
  await expect(inventory).not.toContainText("opaque-directory-1");
  expect(requests.filter(request => request.path === inventoryEndpoint)).toEqual([{
    path: inventoryEndpoint, method: "POST", body: { sourceId: secondary, limit: 100 },
  }]);
});

test("continues Directory and Projects independently with exactly one page per explicit click", async ({ page }) => {
  const responses = [
    { status: "completed", directory: { status: "persisted", itemCount: 2, conflictCount: 0, hasMore: true, continuationToken: "opaque-directory-1" },
      projects: { status: "persisted", itemCount: 3, conflictCount: 0, hasMore: true, continuationToken: "opaque-project-1" } },
    { status: "completed", directory: { status: "persisted", itemCount: 4, conflictCount: 0, hasMore: true, continuationToken: "opaque-directory-2" },
      projects: { status: "not_requested" } },
    { status: "partial", directory: { status: "not_requested" },
      projects: { status: "conflicted", itemCount: 1, conflictCount: 1, hasMore: false } },
    { status: "completed", directory: { status: "persisted", itemCount: 1, conflictCount: 0, hasMore: false },
      projects: { status: "not_requested" } },
  ];
  const requests = await fixture(page, { connectors: [connector()], legacyPrimary: false, health: [], recovery: [], portal: { available: true, authorities: [], recovery: null }, projectManagement: [] }, {
    inventory: (_body, index) => responses[index]!,
  });
  await page.goto("/administration");
  await page.getByText("Staging API-v2 operator review").click();
  const inventory = page.getByRole("region", { name: "Bounded API-v2 inventory" });
  await inventory.getByRole("button", { name: "Read one bounded inventory page" }).click();
  await expect(inventory.getByRole("button", { name: "Continue Directory" })).toBeVisible();
  await expect(inventory.getByRole("button", { name: "Continue Projects" })).toBeVisible();
  expect(requests.filter(request => request.path === inventoryEndpoint)).toHaveLength(1);

  await inventory.getByRole("button", { name: "Continue Directory" }).click();
  await expect(inventory).toContainText("Directory: 4 observed");
  await expect(inventory).toContainText("Projects: 3 observed");
  expect(requests.filter(request => request.path === inventoryEndpoint)).toHaveLength(2);

  await inventory.getByRole("button", { name: "Continue Projects" }).click();
  await expect(inventory).toContainText("Projects: 1 observed · 1 conflicts · page complete");
  await expect(inventory.getByRole("button", { name: "Continue Projects" })).toHaveCount(0);
  await expect(inventory.getByRole("button", { name: "Continue Directory" })).toBeVisible();
  expect(requests.filter(request => request.path === inventoryEndpoint)).toHaveLength(3);

  await inventory.getByRole("button", { name: "Continue Directory" }).click();
  await expect(inventory).toContainText("Directory: 1 observed · 0 conflicts · page complete");
  await expect(inventory.getByRole("button", { name: /Continue Directory|Continue Projects/ })).toHaveCount(0);
  await expect(inventory).not.toContainText(/opaque-directory|opaque-project/);
  expect(requests.filter(request => request.path === inventoryEndpoint)).toEqual([
    { path: inventoryEndpoint, method: "POST", body: { sourceId: secondary, limit: 100 } },
    { path: inventoryEndpoint, method: "POST", body: { sourceId: secondary, limit: 100, directoryContinuationToken: "opaque-directory-1" } },
    { path: inventoryEndpoint, method: "POST", body: { sourceId: secondary, limit: 100, projectContinuationToken: "opaque-project-1" } },
    { path: inventoryEndpoint, method: "POST", body: { sourceId: secondary, limit: 100, directoryContinuationToken: "opaque-directory-2" } },
  ]);
});

test("keeps the staging operator actions default-off when the route is unavailable", async ({ page }) => {
  const requests = await fixture(page, { connectors: [connector()], legacyPrimary: false, health: [], recovery: [], portal: { available: true, authorities: [], recovery: null }, projectManagement: [] });
  await page.goto("/administration");
  await page.getByText("Staging API-v2 operator review").click();
  const inventory = page.getByRole("region", { name: "Bounded API-v2 inventory" });
  await inventory.getByRole("button", { name: "Read one bounded inventory page" }).click();
  await expect(inventory.getByRole("alert")).toContainText("staging-only operation is disabled");
  expect(requests.filter(request => request.path === inventoryEndpoint)).toHaveLength(1);
});

test("reveals exact-record values only after explicit compare and seals enum-only field dispositions", async ({ page }) => {
  const reviewId = "80000000-0000-4000-8000-000000000008", receiptId = "90000000-0000-4000-8000-000000000009";
  const comparedFields = [
    { field: "name", localValue: "Private local value", projectAlphaValue: "Private Project Alpha value", equal: false },
    { field: "email", localValue: "same@example.test", projectAlphaValue: "same@example.test", equal: true },
    { field: "phone", localValue: null, projectAlphaValue: null, equal: true },
    { field: "address_line1", localValue: "One Main", projectAlphaValue: "One Main", equal: true },
    { field: "address_line2", localValue: "", projectAlphaValue: "", equal: true },
    { field: "city", localValue: "Example", projectAlphaValue: "Example", equal: true },
    { field: "state", localValue: "TX", projectAlphaValue: "TX", equal: true },
    { field: "postal_code", localValue: "75001", projectAlphaValue: "75001", equal: true },
    { field: "country", localValue: "US", projectAlphaValue: "US", equal: true },
    { field: "client_type", localValue: "business", projectAlphaValue: "business", equal: true },
    { field: "organization_public_id", localValue: null, projectAlphaValue: null, equal: true },
  ];
  const requests = await fixture(page, { connectors: [connector()], legacyPrimary: false, health: [], recovery: [], portal: { available: true, authorities: [], recovery: null }, projectManagement: [] }, {
    candidates: { items: [{ source: { sourceId: secondary, sourceInstanceId: "10000000-0000-4000-8000-000000000001",
      applicationId: "20000000-0000-4000-8000-000000000002", historyEpoch: "30000000-0000-4000-8000-000000000003" },
      resourceType: "client", projectAlphaPublicId: "a".repeat(32), resourceRevision: "3", authorizationGeneration: "7",
      binding: { externalId: "pa-client-77", status: "active", resourceRevision: "3" }, conflictState: "clear" }], nextCursor: null },
    reserve: { outcome: { status: "reserved", reviewId, claimId: "claim", state: "inactive" } },
    compare: { outcome: { status: "compared", reviewId, resourceType: "client", fields: comparedFields } },
    seal: { outcome: { status: "sealed", receiptId } },
    finalize: { outcome: { status: "finalized", finalizationId: "90000000-0000-4000-8000-000000000009",
      activationId: "a0000000-0000-4000-8000-00000000000a", recordId: "local-record-7", resourceType: "client", adoptedFields: [] } },
  });
  await page.goto("/administration");
  await page.getByText("Staging API-v2 operator review").click();
  const review = page.getByRole("region", { name: "Exact-record field review" });
  await review.getByRole("button", { name: "Refresh eligible Project Alpha records" }).click();
  await review.getByRole("radio", { name: `client · ${"a".repeat(32)} · revision 3 · binding pa-client-77` }).check();
  await review.getByLabel("Exact local record ID").fill("local-record-7");
  await review.getByLabel("Expected local record version").fill("3");
  await review.getByRole("button", { name: "Reserve selected exact pair" }).click();
  await expect(review).toContainText("Field values remain hidden until you explicitly compare them");
  await expect(page.getByText("Private local value")).toHaveCount(0);
  expect(requests.filter(request => request.path.includes("field-comparison"))).toEqual([]);

  await review.getByRole("button", { name: "Compare authorized fields" }).click();
  await expect(review.getByText("Private local value")).toBeVisible();
  await expect(review.getByText("Private Project Alpha value")).toBeVisible();
  await expect(review.getByRole("button", { name: "Seal field review" })).toBeDisabled();
  await review.getByLabel("Name disposition").selectOption("retain_local");
  page.once("dialog", dialog => void dialog.accept());
  await review.getByRole("button", { name: "Seal field review" }).click();
  await expect(review).toContainText("Field review sealed. Review the finalization warning");
  await expect(page.getByText("Private local value")).toHaveCount(0);
  await expect(review).toContainText("Client portal, Delivery, workspace, folder, and public-link access remain unchanged.");
  page.once("dialog", dialog => void dialog.accept());
  await review.getByRole("button", { name: "Finalize sealed review" }).click();
  await expect(review).toContainText("No client portal, Delivery, workspace, folder, or public-link access was granted.");

  expect(requests.filter(request => request.path.startsWith(adoptionEndpoint))).toEqual([
    { path: adoptionCandidatesEndpoint, method: "GET", body: null, query: `sourceId=${encodeURIComponent(secondary)}&limit=50` },
    { path: adoptionEndpoint, method: "POST", body: { sourceId: secondary, resourceType: "client", recordId: "local-record-7", expectedLocalRecordVersion: 3,
      sourceInstanceId: "10000000-0000-4000-8000-000000000001", applicationId: "20000000-0000-4000-8000-000000000002",
      historyEpoch: "30000000-0000-4000-8000-000000000003", projectAlphaPublicId: "a".repeat(32), resourceRevision: "3",
      authorizationGeneration: "7", bindingExternalId: "pa-client-77", bindingResourceRevision: "3" } },
    { path: `${adoptionEndpoint}/${reviewId}/field-comparison`, method: "POST", body: {} },
    { path: `${adoptionEndpoint}/${reviewId}/field-review`, method: "POST", body: { decisions: {
      name: "retain_local", email: "unchanged", phone: "unchanged", address_line1: "unchanged", address_line2: "unchanged",
      city: "unchanged", state: "unchanged", postal_code: "unchanged", country: "unchanged", client_type: "unchanged",
      organization_public_id: "unchanged",
    } } },
    { path: `${adoptionEndpoint}/field-reviews/${receiptId}/finalize`, method: "POST", body: {} },
  ]);
});
