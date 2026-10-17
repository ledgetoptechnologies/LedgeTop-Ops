import { expect, test, type Page } from "@playwright/test";

const sourceId = "project-alpha:primary";
const clientPath = `/clients/sources/${encodeURIComponent(sourceId)}/business/organizations/42`;
const clientApi = `/api/client-hub/sources/${encodeURIComponent(sourceId)}/business/organizations/42`;
const adoptionApi = `${clientApi}/project-adoption`;
const managementApi = `${clientApi}/project-management`;
const projectId = "new-ops-project";
const projectPath = `${clientPath}/projects/canonical/${projectId}`;
const projectApi = `${clientApi}/business-projects/${projectId}`;
const inboundApi = `${projectApi}/inbound-review`;
const projectAlphaPublicId = "a".repeat(32);
const organizationPublicId = "b".repeat(32);
const reviewId = "10000000-0000-4000-8000-000000000001";
const reservationId = "20000000-0000-4000-8000-000000000002";
const commandId = "30000000-0000-4000-8000-000000000003";
const proposalId = "40000000-0000-4000-8000-000000000004";

function projectRow() {
  return { id: projectId, row_key: `project:${projectId}`, origin: "canonical", name: "Adopted roof survey",
    description: "Exact adopted project", status: "active", manager_name: null, start_date: null,
    end_date: null, created_at: "2026-10-12T12:00:00.000Z" };
}

function clientDetail(adopted: boolean) {
  const projects = adopted ? [projectRow()] : [];
  return { client: { workspace_id: null, public_id: "42", kind: "organization", route_kind: "organizations",
    source_id: sourceId, source_name: "Project Alpha", root_namespace: "business", pa_public_id: organizationPublicId,
    detail_path: clientPath, display_name: "Acme Construction", status: "active", portal_status: "mapping_unavailable",
    account_count: 0, project_count: projects.length, request_count: 0, contact_count: 0 },
    contextVersion: "client-context", contacts: [], accounts: [], projects: [], requests: [], deliveryGrants: [],
    authenticatedDeliveryGrants: [], viewerGrants: [], businessProjects: projects,
    pages: { businessProjects: { available: true, reason: null, hasMore: false, nextCursor: null, limit: 5, returned: projects.length } },
    projectManagementAvailable: true, projectAdoptionAvailable: true,
    capabilities: { directory: true, requests: false, delivery: false, viewer: false } };
}

function projectDetail() {
  return { canonicalRoot: { sourceId, rootNamespace: "business", kind: "organization", publicId: "42" },
    client: { display_name: "Acme Construction", detail_path: clientPath }, contextVersion: "project-context",
    refreshedAt: "2026-10-12T12:05:00.000Z",
    project: { id: projectId, origin: "canonical", name: "Adopted roof survey", status: "active",
      description: "Exact adopted project", start_date: null, end_date: null,
      created_at: "2026-10-12T12:00:00.000Z", manager: null }, linkedContact: null,
    availability: { linkedContact: "not_projected", siteContacts: "not_projected", billingContacts: "not_projected", projectMemory: "not_projected" },
    operationalWorkspaceAvailable: false, projectInternalNotesAvailable: false, businessActivityAvailable: false,
    auditTimelineAvailable: false, feedbackHistoryAvailable: false, projectInboundReviewAvailable: true };
}

function management() {
  return { canonicalRoot: { sourceId, rootNamespace: "business", kind: "organization", publicId: "42" },
    contextVersion: "client-context", source: { sourceId, displayName: "Project Alpha", state: "active" },
    availability: { available: true, reason: "available", explanation: "Create an authoritative Project Alpha project." },
    action: { kind: "native_create", label: "Create project", prepareHref: `${managementApi}/native-projects/prepare`,
      submitHref: `${managementApi}/native-projects/submit`, external: false, scopeOptions: [[]] },
    sync: { status: "healthy", lastAttemptAt: null, lastSuccessAt: null, explanation: "Synchronization is healthy.",
      refresh: { label: "Refresh synchronization status", href: managementApi, method: "GET" }, requestSync: null } };
}

async function fixture(page: Page) {
  let adopted = false;
  const calls: Array<{ path: string; method: string; body: unknown; csrf: string | undefined }> = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    calls.push({ path: url.pathname, method: request.method(),
      body: request.method() === "POST" ? request.postDataJSON() : null,
      csrf: request.headers()["x-csrf-token"] });
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: "owner", email: "owner@example.test",
      displayName: "Owner", status: "Active", profileType: "Administrator", isAdministrator: true,
      permissions: ["team.view", "projects.view", "integrations.manage"], divisions: [] }, csrfToken: "csrf",
      timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    if (url.pathname === clientApi) return route.fulfill({ json: clientDetail(adopted) });
    if (url.pathname === `${clientApi}/collections/businessProjects`) return route.fulfill({ json: {
      items: adopted ? [projectRow()] : [], canonicalRoot: { sourceId, rootNamespace: "business", kind: "organization", publicId: "42" },
      contextVersion: "client-context", page: { available: true, reason: null, hasMore: false, nextCursor: null,
        limit: 5, returned: adopted ? 1 : 0 } } });
    if (url.pathname === managementApi) return route.fulfill({ json: management() });
    if (url.pathname === `${adoptionApi}/candidates`) return route.fulfill({ json: { contextVersion: "client-context",
      outcome: { status: "observed", authorizationGeneration: "7", projects: [{ publicId: projectAlphaPublicId,
        revision: "4", projectionSha256: "c".repeat(64), name: "Adopted roof survey", status: "active", archived: false,
        organizationPublicId, clientPublicId: null }], nextCursor: null } } });
    if (url.pathname === `${adoptionApi}/review`) return route.fulfill({ json: { outcome: { status: "reviewed",
      reviewItemId: reviewId, requestSha256: "d".repeat(64), replayed: false } } });
    if (url.pathname === `${adoptionApi}/reserve`) return route.fulfill({ json: { status: "reserved", reservationId,
      reviewItemId: reviewId, idempotencyKey: request.headers()["idempotency-key"], replayed: false } });
    if (url.pathname === `${adoptionApi}/bind`) return route.fulfill({ json: { status: "planned", reservationId,
      commandId, bridgeId: "50000000-0000-4000-8000-000000000005", requestSha256: "e".repeat(64), replayed: false } });
    if (url.pathname === `${adoptionApi}/finalize`) {
      adopted = true;
      return route.fulfill({ json: { stage: "activate", outcome: { status: "activated",
        activationId: "60000000-0000-4000-8000-000000000006", replayed: false } } });
    }
    if (url.pathname === projectApi) return route.fulfill({ json: projectDetail() });
    if (url.pathname === `${inboundApi}/propose`) return route.fulfill({ json: { status: "proposed", proposalId } });
    if (url.pathname === `${inboundApi}/proposals/${proposalId}`) return route.fulfill({ json: { status: "available", proposal: {
      proposalId, sourceId, externalProjectId: projectId, expectedLocalVersion: 1, expiresAt: "2026-10-12T12:10:00.000Z",
      operations: { revision: "1", name: "Adopted roof survey", description: "Exact adopted project", status: "active",
        archived: false, overdueWarning: false, completedAt: null, archivedAt: null, estimatedStart: null, estimatedEnd: null,
        organizationRecordId: "42", clientRecordId: null, scopes: [] },
      projectAlpha: { revision: "5", name: "Adopted roof survey updated", description: "Exact adopted project", status: "active",
        archived: false, overdueWarning: false, completedAt: null, archivedAt: null, estimatedStart: null, estimatedEnd: null,
        organizationRecordId: "42", clientRecordId: null, scopes: [] }, changedFields: ["name"] } } });
    return route.fulfill({ status: 503, json: { error: "Unexpected combined fixture route" } });
  });
  return calls;
}

test("PA-first adoption coexists with native management and transitions to canonical inbound review", async ({ page }) => {
  const calls = await fixture(page);
  page.on("dialog", dialog => void dialog.accept());
  await page.goto(clientPath);
  const business = page.locator(".ltds-card").filter({ has: page.getByRole("heading", { name: "Business projects", exact: true }) });
  const adoption = business.getByRole("region", { name: "Adopt a Project Alpha project for this customer" });
  await expect(adoption).toBeVisible();
  const nativeManagement = business.getByRole("region", { name: "Project creation" });
  await expect(nativeManagement).toBeVisible();
  await expect(nativeManagement.getByLabel("Action")).toHaveValue("create");
  await expect(nativeManagement.getByRole("button", { name: "Prepare project", exact: true })).toBeVisible();

  await adoption.getByRole("button", { name: "Find unbound Projects for this customer" }).click();
  await adoption.getByLabel(/Adopted roof survey/).check();
  await adoption.getByLabel("New, unused Operations Project ID").fill(projectId);
  await adoption.getByRole("button", { name: "Create review evidence" }).click();
  await adoption.getByRole("button", { name: "Reserve reviewed intent" }).click();
  await adoption.getByRole("button", { name: "Create Project and queue bind command" }).click();
  await adoption.getByRole("button", { name: "Finalize and verify Project binding" }).click();
  await expect(adoption.getByRole("status")).toContainText("mapping activated");
  await adoption.getByRole("button", { name: "Refresh customer projects" }).click();

  const projectLink = business.getByRole("link", { name: "Adopted roof survey", exact: true });
  await expect(projectLink).toHaveAttribute("href", projectPath);
  await projectLink.click();
  await expect(page).toHaveURL(new RegExp(`${projectPath}$`));
  await page.waitForLoadState("domcontentloaded");
  const workspace = page.getByRole("region", { name: "Business project workspace", exact: true });
  await expect(workspace.getByRole("heading", { name: "Adopted roof survey", exact: true })).toBeVisible();
  await expect(workspace.getByRole("heading", { name: "Project Alpha inbound review", exact: true })).toBeVisible();
  await workspace.getByRole("button", { name: "Compare with Project Alpha" }).click();
  await expect(workspace).toContainText("Adopted roof survey updated");

  const paths = calls.map(call => `${call.method} ${call.path}`);
  expect(paths).toContain(`GET ${managementApi}`);
  expect(paths).toContain(`POST ${adoptionApi}/review`);
  expect(paths).toContain(`POST ${adoptionApi}/finalize`);
  expect(paths).toContain(`GET ${projectApi}`);
  expect(paths).toContain(`POST ${inboundApi}/propose`);
  expect(paths).toContain(`GET ${inboundApi}/proposals/${proposalId}`);
  expect(paths).not.toContain(`POST ${managementApi}/native-projects/submit`);
  expect(calls.filter(call => call.method === "POST").every(call => call.csrf === "csrf")).toBe(true);
});
