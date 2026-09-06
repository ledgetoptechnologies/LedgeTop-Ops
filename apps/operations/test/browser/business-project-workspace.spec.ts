import { expect, test, type Page, type Route } from "@playwright/test";
import type { BusinessProjectDetail } from "../../src/client/BusinessProjectWorkspace";

const clientPath = "/clients/sources/project-alpha%3Aprimary/business/organizations/42";
const apiBase = `/api${clientPath.replace("/clients/", "/client-hub/")}`;
const projectPath = `${clientPath}/projects/project-one`;
const apiPath = `${apiBase}/business-projects/project-one`;
const filters = "?q=acme&kind=organization&business_status=completed&login_q=alex&login_link=unlinked&login_blocked=no&login_status=all";
function detail(id = "project-one", name = "Church survey"): BusinessProjectDetail {
  return { canonicalRoot: { sourceId: "project-alpha:primary", rootNamespace: "business", kind: "organization", publicId: "42" },
    client: { display_name: "Acme Construction", detail_path: clientPath }, contextVersion: "project-context", refreshedAt: "2026-08-25T12:00:00Z",
    project: { id, name, status: "completed", description: "Roof survey and site documentation.\nDeliver annotated inspection photos.", start_date: "2026-08-01", end_date: "2026-08-20",
      created_at: "2026-07-15T12:00:00Z", manager: { id: "manager-one", display_name: "Morgan Manager" } },
    linkedContact: { id: "contact-one", display_name: "Bailey Contact", email: "bailey@example.test", phone: "+1 920 555 0123", sourceField: "project.client_id" },
    operationalWorkspaceAvailable: true, businessActivityAvailable: true, auditTimelineAvailable: true, feedbackHistoryAvailable: true,
    availability: { linkedContact: "available", siteContacts: "not_projected", billingContacts: "not_projected", projectMemory: "not_projected" } };
}
function clientDetail() {
  return { client: { workspace_id: null, public_id: "42", kind: "organization", route_kind: "organizations", source_id: "project-alpha:primary", root_namespace: "business",
    pa_public_id: null, detail_path: clientPath, display_name: "Acme Construction", status: "active", portal_status: "mapping_unavailable", account_count: 0, project_count: 0, request_count: 0, contact_count: 0 },
    contacts: [], accounts: [], projects: [], requests: [], deliveryGrants: [], authenticatedDeliveryGrants: [], viewerGrants: [],
    contextVersion: "client-context", businessProjects: [{ ...detail().project, manager_name: "Morgan Manager", manager_user_id: "manager-one", row_key: "business:project-one" }],
    organizationOperationalContactsAvailable: true, projectManagementAvailable: true,
    pages: { businessProjects: { available: true, reason: null, nextCursor: null, hasMore: false, returned: 1, limit: 5 } },
    portalIdentities: { items: [], page: { available: false, reason: "workspace_unavailable", nextCursor: null, hasMore: false, returned: 0, limit: 5 },
      contextVersion: "client-context", refreshedAt: "2026-08-25T12:00:00Z", capabilities: { canManagePortal: false, canManageEligibilityBlocks: false } },
    capabilities: { directory: true, requests: false, delivery: false, viewer: false } };
}
function operational(status = "completed", projectId = "project-one") {
  return { canonicalRoot: detail().canonicalRoot, contextVersion: "project-context", project: { id: projectId, sourceId: "project-alpha:primary", status, revision: `${projectId}-revision` },
    contacts: { version: 1, assignments: [{ id: "assignment-one", role: "project_contact", preferredContactMethod: "email", instructions: "Confirm the arrival window.", sortOrder: 0,
      availability: "available", contact: { id: "contact-one", displayName: "Bailey Contact", email: "bailey@example.test" as string | null, phone: "+1 920 555 0123" as string | null } }],
      revisions: [{ version: 1, createdAt: "2026-08-26T12:00:00Z" }] },
    memory: { version: 1, snapshot: { plan: "Photograph the roof.", actualOutcome: "Roof captured.", deviationsAndReasons: "", observations: "", problems: "",
      successes: "Good coverage.", recommendations: "Return in spring.", nextTimeRequests: "Call before arrival." },
      attachments: [] as unknown[],
      revisions: [{ version: 1, changeKind: "saved", amendmentReason: null, createdAt: "2026-08-26T12:05:00Z" }] },
    capabilities: { canManageContacts: true, canManageMemory: true },
    contactOptions: [{ public_id: "contact-one", display_name: "Bailey Contact", email: "bailey@example.test" as string | null, phone: "+1 920 555 0123" as string | null, record_type: "business_contact" as const },
      { public_id: "site-one", display_name: "Site Supervisor", email: null as string | null, phone: "+1 920 555 0100" as string | null, record_type: "business_contact" as const }],
    contactPage: { available: true, reason: null as "permission_required" | "workspace_unavailable" | "not_applicable" | null,
      nextCursor: null as string | null, hasMore: false, returned: 2, limit: 25 } };
}
async function mock(page: Page, handler: (route: Route, url: URL) => Promise<unknown>, permissions = ["team.view", "projects.view"],
  operationalHandler?: (route: Route, url: URL) => Promise<unknown>,
  projectItems: Array<{ id: string; name: string; status: string | null; row_key: string; [key: string]: unknown }> = clientDetail().businessProjects) {
  const requests: Array<{ url: URL; method: string }> = [];
  await page.route("**/api/**", route => {
    const request = route.request(), url = new URL(request.url()); requests.push({ url, method: request.method() });
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: "staff-one", email: "staff@example.test", displayName: "Staff", status: "Active", profileType: "Employee",
      isAdministrator: false, permissions, divisions: [] }, csrfToken: "test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    if (url.pathname === `${apiBase}/organization-operational-contacts`) return route.fulfill({ json: {
      canonicalRoot: detail().canonicalRoot, contextVersion: "client-context",
      organization: { id: "42", sourceId: "project-alpha:primary", revision: "organization-revision" },
      contacts: { version: 0, assignments: [], revisions: [] },
      capabilities: { canManageOrganizationContacts: false },
      contactOptions: [],
      contactPage: { available: true, reason: null, nextCursor: null, hasMore: false, returned: 0, limit: 25 },
    } });
    if (url.pathname === `${apiBase}/project-management`) return route.fulfill({ json: {
      canonicalRoot: detail().canonicalRoot, contextVersion: "client-context",
      source: { sourceId: "project-alpha:primary", displayName: "Project Alpha", state: "active" },
      availability: { available: false, reason: "not_configured", explanation: "Project creation is not configured in this fixture." },
      action: null,
      sync: { status: "healthy", lastAttemptAt: null, lastSuccessAt: null, explanation: "Synchronization is healthy.",
        refresh: { label: "Refresh synchronization status", href: `${apiBase}/project-management`, method: "GET" },
        requestSync: null },
    } });
    if (url.pathname === apiBase) return route.fulfill({ json: clientDetail() });
    if (url.pathname === `${apiBase}/collections/businessProjects`) return route.fulfill({ json: { items: projectItems,
      page: { ...clientDetail().pages.businessProjects, returned: projectItems.length, limit: Number(url.searchParams.get("limit") || 5) },
      canonicalRoot: detail().canonicalRoot, contextVersion: url.searchParams.get("expectedContextVersion") || "client-context" } });
    if (url.pathname.endsWith("/operational-workspace")) return operationalHandler ? operationalHandler(route, url)
      : route.fulfill({ json: operational("completed", decodeURIComponent(url.pathname.split("/").at(-2)!)) });
    if (/\/operational-memory\/revisions\/\d+$/.test(url.pathname)) return operationalHandler ? operationalHandler(route, url)
      : route.fulfill({ json: { canonicalRoot: detail().canonicalRoot, contextVersion: "project-context",
        project: { id: "project-one", sourceId: "project-alpha:primary", revision: "project-one-revision" },
        revision: { version: 1, changeKind: "saved", amendmentReason: null, createdAt: "2026-08-26T12:05:00Z", snapshot: operational().memory.snapshot } } });
    if (url.pathname.endsWith("/operational-contacts") || url.pathname.endsWith("/operational-memory")
      || url.pathname.endsWith("/operational-memory/attachments/upload"))
      return operationalHandler ? operationalHandler(route, url) : route.fulfill({ status: 500, json: { error: "Unexpected operational write" } });
    if (url.pathname.endsWith("/recurring-copy/preview") || url.pathname.endsWith("/recurring-copy/commit"))
      return operationalHandler ? operationalHandler(route, url) : route.fulfill({ status: 500, json: { error: "Unexpected recurring-project copy" } });
    return handler(route, url);
  });
  return requests;
}
const workspace = (page: Page) => page.getByRole("region", { name: "Business project workspace", exact: true });
async function open(page: Page, suffix = "") {
  await page.goto(`${projectPath}${suffix}`);
  await expect(workspace(page).getByRole("heading", { name: "Church survey", exact: true })).toBeVisible();
}

test("project role metadata is a separate responsive read-only card", async ({ page }) => {
  const value = detail();
  value.projectAlphaContactRolesAvailable = true;
  value.projectAlphaContactRoles = { state: "populated", reason: null, nextCursor: null, hasMore: false, returned: 1, limit: 5,
    canonicalRoot: value.canonicalRoot, contextVersion: value.contextVersion, items: [{ contactDisplayName: "Bailey Billing",
      clientDisplayName: "Bailey Contact", scopeType: "project", scopeDisplayName: "Church survey", role: "billing_contact",
      primary: true, primaryBilling: true, sendProjectInvoices: true, canViewInvoiceLinks: true }] };
  await page.setViewportSize({ width: 375, height: 900 });
  await mock(page, route => route.fulfill({ json: value }));
  await open(page);
  const roles = workspace(page).getByRole("region", { name: "Project Alpha contact roles", exact: true });
  await expect(roles).toContainText("Bailey Billing");
  await expect(roles).toContainText("billing contact");
  await expect(roles).toContainText("These roles do not grant portal or Operations access.");
  await expect(roles.getByRole("button")).toHaveCount(0);
  await expect(workspace(page).getByRole("heading", { name: "Project Alpha linked contact", exact: true })).toBeVisible();
  await expect(workspace(page).getByRole("heading", { name: "Operational contacts", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("reassigned project shows a responsive contact-admin state to non-administrators", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await mock(page, route => route.fulfill({ json: detail() }), undefined,
    route => route.fulfill({ status: 409, json: { error: "Project ownership changed.",
      code: "project_operational_recovery_required", canRecover: false } }));
  await open(page);
  const operations = workspace(page).getByRole("region", { name: "Operational project details", exact: true });
  await expect(operations.getByRole("heading", { name: "Operational details awaiting review" })).toBeVisible();
  await expect(operations).toContainText("Contact an Operations administrator");
  await expect(operations.getByRole("button", { name: /recovery/i })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("administrator recovery requires preview and rejects an unverified commit response", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mock(page, async (route, url) => {
    if (url.pathname.endsWith("/operational-recovery/preview")) return route.fulfill({ json: { fingerprint: "a".repeat(64), action: "reset",
      sourceId: "project-alpha:primary", project: { id: "project-one", revision: "project-one-revision" },
      currentRoot: { kind: "organization", id: "42" }, previousRoot: { kind: "organization", id: "41" },
      changes: { contactsCleared: 1, memoryTransferred: false, memoryReset: true, attachmentsExcluded: 2 } } });
    if (url.pathname.endsWith("/operational-recovery/commit")) return route.fulfill({ json: { fingerprint: "a".repeat(64), replayed: false } });
    return route.fulfill({ json: detail() });
  }, undefined, route => route.fulfill({ status: 409, json: { error: "Project ownership changed.",
    code: "project_operational_recovery_required", canRecover: true } }));
  await open(page);
  const operations = workspace(page).getByRole("region", { name: "Operational project details", exact: true });
  await operations.getByLabel("Required audit reason").fill("Verified client reassignment");
  await operations.getByRole("button", { name: "Preview recovery" }).click();
  await expect(operations).toContainText("2 historical attachment(s) remain preserved and excluded");
  await operations.getByLabel(/Type RESET PROJECT MEMORY/).fill("RESET PROJECT MEMORY");
  await operations.getByRole("button", { name: "Apply recovery" }).click();
  await expect(operations.getByText(/recovery result could not be verified/i)).toBeVisible();
  await expect(operations.getByRole("heading", { name: "Review before applying" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("business project links open a scoped workspace and preserve client filters through breadcrumbs, Back and refresh", async ({ page }) => {
  test.slow();
  const requests = await mock(page, route => route.fulfill({ json: detail() }));
  await page.goto(`${clientPath}${filters}`);
  const link = page.getByRole("region", { name: "Business projects", exact: true }).getByRole("link", { name: "Church survey", exact: true });
  await link.focus(); await page.keyboard.press("Enter");
  await expect(workspace(page).getByRole("heading", { name: "Church survey", exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(projectPath);
  await expect(workspace(page).getByRole("heading", { name: "Project Alpha linked contact", exact: true })).toBeVisible();
  await expect(workspace(page).getByRole("definition").filter({ hasText: /^Bailey Contact$/ })).toBeVisible();
  await expect(workspace(page).getByRole("definition").filter({ hasText: /^bailey@example\.test$/ })).toBeVisible();
  await expect(workspace(page).getByRole("definition").filter({ hasText: /^\+1 920 555 0123$/ })).toBeVisible();
  await expect(workspace(page).getByText("Morgan Manager", { exact: true })).toBeVisible();
  await expect(workspace(page).getByText(/Specific site and billing roles are not verified/)).toBeVisible();
  await expect(workspace(page).getByRole("region", { name: "Operational project details", exact: true })).toContainText("Confirm the arrival window.");
  await expect(workspace(page).getByText("Photograph the roof.", { exact: true })).toBeVisible();
  await expect(workspace(page).getByText("hidden-staff-id", { exact: true })).toHaveCount(0);
  const breadcrumb = workspace(page).getByRole("navigation", { name: "Project breadcrumbs" }).getByRole("link", { name: "Acme Construction", exact: true });
  const backUrl = new URL(await breadcrumb.getAttribute("href") || "", page.url());
  expect(backUrl.pathname).toBe(clientPath);
  for (const [key, value] of new URLSearchParams(filters)) expect(backUrl.searchParams.get(key)).toBe(value);
  await page.reload();
  await expect(workspace(page).getByRole("definition").filter({ hasText: /^Bailey Contact$/ })).toBeVisible();
  await breadcrumb.click();
  await expect(page.getByRole("combobox", { name: "Project status", exact: true })).toHaveValue("completed");
  await page.goBack();
  await expect(workspace(page).getByRole("heading", { name: "Church survey", exact: true })).toBeVisible();
  expect(requests.every(request => request.method === "GET")).toBe(true);
  expect(requests.some(request => /\/team\/|\/identities|\/grants|\/viewer|\/notes/.test(request.url.pathname))).toBe(false);
});

for (const code of [403, 404, 409, 503]) {
  test(`project ${code} has an honest error and recoverable read without stale content`, async ({ page }) => {
    let calls = 0;
    await mock(page, route => ++calls === 1 ? route.fulfill({ status: code, json: { error: "Project record unavailable for this request" } }) : route.fulfill({ json: detail() }));
    await page.goto(projectPath);
    await expect(workspace(page).getByRole("alert")).toContainText("Project record unavailable for this request");
    await expect(workspace(page).getByText("Bailey Contact", { exact: true })).toHaveCount(0);
    await workspace(page).getByRole("button", { name: code === 409 ? "Reload project workspace" : "Retry project", exact: true }).click();
    await expect(workspace(page).getByRole("definition").filter({ hasText: /^Bailey Contact$/ })).toBeVisible();
  });
}

test("refresh clears old project details, ignores repeated clicks, and pending old routes cannot replace a newer project", async ({ page }) => {
  let pending: Route | undefined, calls = 0;
  await mock(page, async (route, url) => {
    if (url.pathname.endsWith("/project-two")) return route.fulfill({ json: detail("project-two", "Warehouse survey") });
    if (++calls === 1) return route.fulfill({ json: detail() });
    pending = route;
  });
  await open(page);
  const refresh = workspace(page).getByRole("button", { name: "Refresh project", exact: true });
  await refresh.focus(); await page.keyboard.press("Enter");
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.keyboard.press("Enter"); await page.keyboard.press("Space");
  expect(calls).toBe(2);
  await expect(workspace(page).getByRole("button", { name: "Loading project…", exact: true })).toBeFocused();
  await expect(page.getByText("Bailey Contact", { exact: true })).toHaveCount(0);
  await page.evaluate(path => { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")); }, projectPath.replace("project-one", "project-two"));
  await expect(workspace(page).getByRole("heading", { name: "Warehouse survey", exact: true })).toBeVisible();
  await pending!.fulfill({ json: detail("project-one", "Stale project") }).catch(() => undefined);
  await expect(page.getByRole("heading", { name: "Stale project", exact: true })).toHaveCount(0);
  await expect(workspace(page).getByRole("heading", { name: "Warehouse survey", exact: true })).toBeVisible();
});

for (const field of ["root", "project", "contact", "description", "manager"] as const) {
  test(`mismatched or malformed project ${field} fails safely without rendering protected data`, async ({ page }) => {
    const value = detail() as unknown as Record<string, Record<string, unknown>>;
    if (field === "root") value.canonicalRoot!.publicId = "unrelated-client";
    if (field === "project") value.project!.id = "another-project";
    if (field === "contact") value.linkedContact!.email = { unsafe: "not a scalar" };
    if (field === "description") value.project!.description = { unsafe: "not text" };
    if (field === "manager") value.project!.manager = { id: "manager-one", display_name: [] };
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await mock(page, route => route.fulfill({ json: value }));
    await page.goto(projectPath);
    await expect(workspace(page).getByRole("alert")).toContainText("context changed");
    await expect(workspace(page).getByRole("heading", { name: "Project overview", exact: true })).toHaveCount(0);
    await expect(page.getByText("Bailey Contact", { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("missing source data is not represented as missing login, site or billing roles", async ({ page }) => {
  const value = detail();
  value.project.status = null; value.project.description = null; value.project.created_at = null; value.project.manager = null;
  value.linkedContact = null; value.availability.linkedContact = "not_projected";
  await mock(page, route => route.fulfill({ json: value }));
  await open(page);
  await expect(workspace(page).getByText("Status not recorded", { exact: true })).toBeVisible();
  await expect(workspace(page).getByText("A linked-contact reference was not included in the synchronized project record.")).toBeVisible();
  await expect(workspace(page).getByRole("heading", { name: "Operational contacts", exact: true })).toBeVisible();
  await expect(workspace(page).getByText(/No portal login|No site contacts|No billing contacts/)).toHaveCount(0);
});

test("explicit contact and memory saves preserve expected versions and never send access authority fields", async ({ page }) => {
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  let version = 1;
  await mock(page, route => route.fulfill({ json: detail() }), ["team.view", "projects.view", "project.contacts.manage", "project.memory.manage"], async (route, url) => {
    if (url.pathname.endsWith("/operational-workspace")) {
      const value = operational(); value.contacts.version = version; value.memory.version = version;
      return route.fulfill({ json: value });
    }
    const body = route.request().postDataJSON() as Record<string, unknown>; writes.push({ path: url.pathname, body }); version += 1;
    return route.fulfill({ json: { sourceId: "project-alpha:primary", projectId: "project-one", version, replayed: false } });
  });
  await open(page);
  const operations = workspace(page).getByRole("region", { name: "Operational project details", exact: true });
  await operations.getByRole("button", { name: "Edit operational contacts", exact: true }).click();
  await operations.getByRole("button", { name: "Add contact assignment", exact: true }).click();
  await operations.getByRole("combobox", { name: "Contact for assignment 2", exact: true }).selectOption("site-one");
  await operations.getByRole("combobox", { name: "Role for assignment 2", exact: true }).selectOption("site_contact");
  await operations.getByRole("textbox", { name: "Instructions for assignment 2", exact: true }).fill("Use the east entrance.");
  await operations.getByRole("button", { name: "Save contacts", exact: true }).click();
  await expect(operations.getByText("Operational contacts saved.", { exact: true })).toBeVisible();
  await operations.getByRole("button", { name: "Edit project memory", exact: true }).click();
  await operations.getByRole("textbox", { name: "Plan", exact: true }).fill("Capture the roof and west elevation.");
  await operations.getByRole("button", { name: "Save project memory", exact: true }).click();
  await expect(operations.getByRole("alert")).toContainText("Explain why");
  await operations.getByRole("textbox", { name: "Amendment reason", exact: true }).fill("Added the final field note after closeout.");
  await operations.getByRole("button", { name: "Save project memory", exact: true }).click();
  await expect(operations.getByText("Project-memory amendment saved.", { exact: true })).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[0]!.body).toMatchObject({ expectedContextVersion: "project-context", expectedVersion: 1,
    assignments: expect.arrayContaining([expect.objectContaining({ contactId: "site-one", role: "site_contact", instructions: "Use the east entrance." })]) });
  expect(writes[1]!.body).toMatchObject({ expectedContextVersion: "project-context", expectedVersion: 2,
    memory: expect.objectContaining({ plan: "Capture the roof and west elevation." }), amendmentReason: "Added the final field note after closeout." });
  for (const { body } of writes) {
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.stringify(body)).not.toMatch(/portal|grant|billing|notification|recipient/i);
  }
});

test("manager attachment upload encodes Unicode filenames and preserves an unsaved memory draft through refresh", async ({ page }) => {
  const writes: Array<{ headers: Record<string, string>; body: Buffer }> = [];
  let memoryVersion = 1;
  const attachment = { id: "attachment-one", name: "屋根 📷.jpg", contentType: "image/jpeg", size: 4,
    sha256: "a".repeat(64), sourceKind: "staff_upload", versionAdded: 2, createdAt: "2026-08-28T12:00:00Z",
    downloadPath: `${apiPath}/operational-memory/attachments/attachment-one/download` };
  await mock(page, route => route.fulfill({ json: detail() }), ["team.view", "projects.view", "project.memory.manage"], async (route, url) => {
    if (url.pathname.endsWith("/operational-workspace")) {
      const value = operational("active"); value.memory.version = memoryVersion;
      value.memory.attachments = memoryVersion === 2 ? [attachment] : [];
      return route.fulfill({ json: value });
    }
    if (url.pathname.endsWith("/operational-memory/attachments/upload")) {
      writes.push({ headers: await route.request().allHeaders(), body: route.request().postDataBuffer()! }); memoryVersion = 2;
      return route.fulfill({ json: { sourceId: "project-alpha:primary", projectId: "project-one", version: 2, attachment, replayed: false } });
    }
    return route.fulfill({ status: 500, json: { error: "Unexpected attachment request" } });
  });
  await open(page);
  const operations = workspace(page).getByRole("region", { name: "Operational project details", exact: true });
  await operations.getByRole("button", { name: "Edit project memory", exact: true }).click();
  const plan = operations.getByRole("textbox", { name: "Plan", exact: true });
  await plan.fill("Keep this unsaved field note while the attachment list refreshes.");
  await operations.getByLabel("Choose an image or PDF").setInputFiles({ name: "屋根 📷.jpg", mimeType: "image/jpeg", buffer: Buffer.from("roof") });
  await operations.getByRole("button", { name: "Upload attachment", exact: true }).click();
  await expect(operations.getByText("屋根 📷.jpg attached. Project memory is refreshing.", { exact: true })).toBeVisible();
  await expect(operations.getByRole("link", { name: "Download", exact: true })).toHaveAttribute("href", attachment.downloadPath);
  await expect(plan).toHaveValue("Keep this unsaved field note while the attachment list refreshes.");
  await expect(operations.getByText(attachment.sha256, { exact: true })).toHaveCount(0);
  expect(writes).toHaveLength(1);
  expect(writes[0]!.headers).toMatchObject({ "content-type": "image/jpeg", "x-expected-context-version": "project-context",
    "x-expected-version": "1", "x-file-name": encodeURIComponent("屋根 📷.jpg") });
  expect(writes[0]!.headers["x-idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/i);
  expect(writes[0]!.headers["x-amendment-reason"]).toBeUndefined();
  expect(writes[0]!.body.toString()).toBe("roof");
});

test("terminal attachment upload requires an amendment reason and retries with one idempotency key", async ({ page }) => {
  const attempts: Record<string, string>[] = []; let completed = false;
  const attachment = { id: "attachment-pdf", name: "closeout.pdf", contentType: "application/pdf", size: 5,
    sourceKind: "staff_upload", versionAdded: 2, createdAt: "2026-08-28T12:00:00Z",
    downloadPath: `${apiPath}/operational-memory/attachments/attachment-pdf/download` };
  await mock(page, route => route.fulfill({ json: detail() }), ["team.view", "projects.view", "project.memory.manage"], async (route, url) => {
    if (url.pathname.endsWith("/operational-workspace")) {
      const value = operational("completed"); if (completed) { value.memory.version = 2; value.memory.attachments = [attachment]; }
      return route.fulfill({ json: value });
    }
    attempts.push(await route.request().allHeaders());
    if (attempts.length === 1) return route.fulfill({ status: 503, json: { error: "Temporary attachment storage interruption" } });
    completed = true;
    return route.fulfill({ json: { sourceId: "project-alpha:primary", projectId: "project-one", version: 2, attachment, replayed: true } });
  });
  await open(page);
  const operations = workspace(page).getByRole("region", { name: "Operational project details", exact: true });
  await operations.getByLabel("Choose an image or PDF").setInputFiles({ name: "closeout.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-") });
  await operations.getByRole("button", { name: "Upload attachment", exact: true }).click();
  await expect(operations.getByRole("alert")).toContainText("Explain why"); expect(attempts).toHaveLength(0);
  await operations.getByRole("textbox", { name: "Attachment amendment reason", exact: true }).fill("Added the signed closeout after completion.");
  await operations.getByRole("button", { name: "Upload attachment", exact: true }).click();
  await expect(operations.getByRole("alert")).toContainText("Temporary attachment storage interruption");
  await operations.getByRole("button", { name: "Retry attachment upload", exact: true }).click();
  await expect(operations.getByText("closeout.pdf was already attached. Project memory is refreshing.", { exact: true })).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[0]!["x-idempotency-key"]).toBe(attempts[1]!["x-idempotency-key"]);
  expect(attempts[0]!["x-amendment-reason"]).toBe("Added the signed closeout after completion.");
});

test("authorized readers can download attachments but cannot see manager upload controls", async ({ page }) => {
  const attachment = { id: "reader-attachment", name: "site-map.png", contentType: "image/png", size: 2048,
    sourceKind: "staff_upload", versionAdded: 1, createdAt: "2026-08-28T12:00:00Z",
    downloadPath: `${apiPath}/operational-memory/attachments/reader-attachment/download` };
  await mock(page, route => route.fulfill({ json: detail() }), ["team.view", "projects.view"], async (route, url) => {
    const value = operational("active"); value.capabilities.canManageMemory = false; value.memory.attachments = [attachment];
    return route.fulfill({ json: value });
  });
  await open(page);
  const operations = workspace(page).getByRole("region", { name: "Operational project details", exact: true });
  await expect(operations.getByText("site-map.png", { exact: true })).toBeVisible();
  await expect(operations.getByRole("link", { name: "Download", exact: true })).toHaveAttribute("href", attachment.downloadPath);
  await expect(operations.getByLabel("Choose an image or PDF")).toHaveCount(0);
  await expect(operations.getByRole("button", { name: /Upload attachment/ })).toHaveCount(0);
});

test("manager upload rejects unsupported image MIME types before sending data", async ({ page }) => {
  let writes = 0;
  await mock(page, route => route.fulfill({ json: detail() }), ["team.view", "projects.view", "project.memory.manage"], async (route, url) => {
    if (url.pathname.endsWith("/operational-workspace")) return route.fulfill({ json: operational("active") });
    writes += 1; return route.fulfill({ status: 500, json: { error: "Unsupported upload should not reach the server" } });
  });
  await open(page);
  const operations = workspace(page).getByRole("region", { name: "Operational project details", exact: true });
  const picker = operations.getByLabel("Choose an image or PDF");
  await expect(picker).toHaveAttribute("accept", "image/jpeg,image/png,image/webp,image/gif,image/tiff,application/pdf");
  await picker.setInputFiles({ name: "unsafe.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
  await operations.getByRole("button", { name: "Upload attachment", exact: true }).click();
  await expect(operations.getByRole("alert")).toContainText("Choose a JPEG, PNG, WebP, GIF, TIFF, or PDF attachment.");
  expect(writes).toBe(0);
});

test("transient contact-save errors preserve edits and retry with the same idempotency key", async ({ page }) => {
  const attempts: Array<Record<string, unknown>> = [];
  await mock(page, route => route.fulfill({ json: detail() }), undefined, async (route, url) => {
    if (url.pathname.endsWith("/operational-workspace")) return route.fulfill({ json: operational("active") });
    const body = route.request().postDataJSON() as Record<string, unknown>; attempts.push(body);
    return attempts.length === 1 ? route.fulfill({ status: 503, json: { error: "Temporary database interruption" } })
      : route.fulfill({ json: { sourceId: "project-alpha:primary", projectId: "project-one", version: 2, replayed: true } });
  });
  await open(page);
  const operations = workspace(page).getByRole("region", { name: "Operational project details", exact: true });
  await operations.getByRole("button", { name: "Edit operational contacts", exact: true }).click();
  const instructions = operations.getByRole("textbox", { name: "Instructions for assignment 1", exact: true });
  await instructions.fill("Keep this edit through a retry.");
  await operations.getByRole("button", { name: "Save contacts", exact: true }).click();
  await expect(operations.getByRole("alert")).toContainText("Temporary database interruption");
  await expect(instructions).toHaveValue("Keep this edit through a retry.");
  await operations.getByRole("button", { name: "Save contacts", exact: true }).click();
  await expect(operations.getByText("Operational contacts saved.", { exact: true })).toBeVisible();
  expect(attempts).toHaveLength(2); expect(attempts[0]!.idempotencyKey).toBe(attempts[1]!.idempotencyKey);
});

test("an ownership-change conflict clears the entire protected project workspace", async ({ page }) => {
  test.slow();
  await mock(page, route => route.fulfill({ json: detail() }), undefined, async (route, url) => url.pathname.endsWith("/operational-workspace")
    ? route.fulfill({ json: operational("active") }) : route.fulfill({ status: 409, json: { error: "Project ownership changed. Refresh before continuing." } }));
  await open(page);
  const operations = workspace(page).getByRole("region", { name: "Operational project details", exact: true });
  await operations.getByRole("button", { name: "Edit operational contacts", exact: true }).click();
  await operations.getByRole("button", { name: "Save contacts", exact: true }).click();
  await expect(workspace(page).getByRole("button", { name: "Reload project workspace", exact: true })).toBeVisible();
  await expect(page.getByText("Bailey Contact", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Photograph the roof.", { exact: true })).toHaveCount(0);
});

test("project-memory revision snapshots load only when expanded and support a transient retry", async ({ page }) => {
  let revisionReads = 0;
  await mock(page, route => route.fulfill({ json: detail() }), undefined, async (route, url) => {
    if (url.pathname.endsWith("/operational-workspace")) return route.fulfill({ json: operational("active") });
    if (/\/operational-memory\/revisions\/1$/.test(url.pathname)) {
      revisionReads += 1;
      if (revisionReads === 1) return route.fulfill({ status: 503, json: { error: "Revision storage is temporarily unavailable" } });
      return route.fulfill({ json: { canonicalRoot: detail().canonicalRoot, contextVersion: "project-context",
        project: { id: "project-one", sourceId: "project-alpha:primary", revision: "project-one-revision" },
        revision: { version: 1, changeKind: "saved", amendmentReason: null, createdAt: "2026-08-26T12:05:00Z",
          snapshot: { ...operational().memory.snapshot, plan: "Historical roof plan." } } } });
    }
    return route.fulfill({ status: 500, json: { error: "Unexpected operation" } });
  });
  await open(page);
  const operations = workspace(page).getByRole("region", { name: "Operational project details", exact: true });
  expect(revisionReads).toBe(0);
  await operations.getByText("Project-memory history", { exact: true }).click();
  expect(revisionReads).toBe(0);
  await operations.getByText(/Version 1 · Saved/).click();
  await expect(operations.getByRole("alert")).toContainText("Revision storage is temporarily unavailable");
  await operations.getByRole("button", { name: "Retry version 1", exact: true }).click();
  await expect(operations.getByText("Historical roof plan.", { exact: true })).toBeVisible();
  expect(revisionReads).toBe(2); await expect(operations.getByText("hidden-staff-id", { exact: true })).toHaveCount(0);
});

test("a revision context conflict invalidates the protected workspace", async ({ page }) => {
  await mock(page, route => route.fulfill({ json: detail() }), undefined, async (route, url) => {
    if (url.pathname.endsWith("/operational-workspace")) return route.fulfill({ json: operational("active") });
    return route.fulfill({ status: 409, json: { error: "Project ownership changed while reading history." } });
  });
  await open(page);
  const operations = workspace(page).getByRole("region", { name: "Operational project details", exact: true });
  await operations.getByText("Project-memory history", { exact: true }).click();
  await operations.getByText(/Version 1 · Saved/).click();
  await expect(workspace(page).getByRole("button", { name: "Reload project workspace", exact: true })).toBeVisible();
  await expect(page.getByText("Photograph the roof.", { exact: true })).toHaveCount(0);
});

test("switching projects clears cached memory revisions before the new exact project is loaded", async ({ page }) => {
  const revisionReads: string[] = [];
  await mock(page, (route, url) => route.fulfill({ json: url.pathname.endsWith("/project-two")
    ? detail("project-two", "Warehouse survey") : detail() }), undefined, async (route, url) => {
    const projectId = url.pathname.includes("/project-two/") ? "project-two" : "project-one";
    if (url.pathname.endsWith("/operational-workspace")) return route.fulfill({ json: operational("active", projectId) });
    if (/\/operational-memory\/revisions\/1$/.test(url.pathname)) {
      revisionReads.push(projectId);
      return route.fulfill({ json: { canonicalRoot: detail().canonicalRoot, contextVersion: "project-context",
        project: { id: projectId, sourceId: "project-alpha:primary", revision: `${projectId}-revision` },
        revision: { version: 1, changeKind: "saved", amendmentReason: null, createdAt: "2026-08-26T12:05:00Z",
          snapshot: { ...operational().memory.snapshot, plan: projectId === "project-one" ? "Project one history." : "Project two history." } } } });
    }
    return route.fulfill({ status: 500, json: { error: "Unexpected operation" } });
  });
  await open(page);
  let operations = workspace(page).getByRole("region", { name: "Operational project details", exact: true });
  await operations.getByText("Project-memory history", { exact: true }).click();
  await operations.getByText(/Version 1 · Saved/).click();
  await expect(operations.getByText("Project one history.", { exact: true })).toBeVisible();
  await page.evaluate(path => { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")); }, projectPath.replace("project-one", "project-two"));
  await expect(workspace(page).getByRole("heading", { name: "Warehouse survey", exact: true })).toBeVisible();
  operations = workspace(page).getByRole("region", { name: "Operational project details", exact: true });
  await expect(operations.getByText("Project one history.", { exact: true })).toHaveCount(0);
  await operations.getByText("Project-memory history", { exact: true }).click();
  await operations.getByText(/Version 1 · Saved/).click();
  await expect(operations.getByText("Project two history.", { exact: true })).toBeVisible();
  expect(revisionReads).toEqual(["project-one", "project-two"]);
});

test("project-memory history remains keyboard accessible without mobile overflow", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 });
  await mock(page, route => route.fulfill({ json: detail() })); await open(page);
  const operations = workspace(page).getByRole("region", { name: "Operational project details", exact: true });
  const history = operations.getByText("Project-memory history", { exact: true });
  await history.focus(); await page.keyboard.press("Enter");
  const revision = operations.locator("summary").filter({ hasText: /Version 1 · Saved/ }); await revision.focus(); await page.keyboard.press("Enter");
  await expect(operations.getByRole("region", { name: "Project memory version 1", exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(await history.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  expect(await revision.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
});

test("an assigned exact-root contact beyond the first 25 is selected and saves without paging", async ({ page }) => {
  const writes: Record<string, unknown>[] = []; let workspaceReads = 0;
  await mock(page, route => route.fulfill({ json: detail() }), undefined, async (route, url) => {
    if (url.pathname.endsWith("/operational-workspace")) {
      workspaceReads += 1;
      const value = operational("active");
      value.contacts.assignments[0]!.contact = { id: "assigned-26", displayName: "Assigned Beyond First Page", email: "assigned@example.test", phone: null };
      value.contactOptions = Array.from({ length: 25 }, (_, index) => ({ public_id: `contact-${index}`, display_name: `Contact ${index}`,
        email: null, phone: null, record_type: "business_contact" as const }));
      value.contactPage = { available: true, reason: null, nextCursor: "page-two", hasMore: true, returned: 25, limit: 25 };
      return route.fulfill({ json: value });
    }
    const body = route.request().postDataJSON() as Record<string, unknown>; writes.push(body);
    return route.fulfill({ json: { sourceId: "project-alpha:primary", projectId: "project-one", version: 2, replayed: false } });
  });
  await open(page);
  const operations = workspace(page).getByRole("region", { name: "Operational project details", exact: true });
  await operations.getByRole("button", { name: "Edit operational contacts", exact: true }).click();
  await expect(operations.getByRole("combobox", { name: "Contact for assignment 1", exact: true })).toHaveValue("assigned-26");
  await operations.getByRole("button", { name: "Save contacts", exact: true }).click();
  await expect(operations.getByText("Operational contacts saved.", { exact: true })).toBeVisible();
  expect(writes[0]).toMatchObject({ assignments: [expect.objectContaining({ contactId: "assigned-26" })] });
  expect(workspaceReads).toBe(2); // Initial read plus the post-save refresh; no contact-page request.
});

test("malformed contact-page metadata fails closed without rendering project data", async ({ page }) => {
  await mock(page, route => route.fulfill({ json: detail() }), undefined, (route, url) => {
    const value = operational("active"); value.contactPage.returned = 1; // Two options were returned.
    return route.fulfill({ json: value });
  });
  await page.goto(projectPath);
  await expect(workspace(page).getByRole("button", { name: "Reload project workspace", exact: true })).toBeVisible();
  await expect(page.getByText("Photograph the roof.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Bailey Contact", { exact: true })).toHaveCount(0);
});

test("malformed mutation responses preserve the editor and never claim success", async ({ page }) => {
  await mock(page, route => route.fulfill({ json: detail() }), undefined, (route, url) => url.pathname.endsWith("/operational-workspace")
    ? route.fulfill({ json: operational("active") })
    : route.fulfill({ json: { sourceId: "unrelated-source", projectId: "project-one", version: 99, replayed: "no" } }));
  await open(page);
  const operations = workspace(page).getByRole("region", { name: "Operational project details", exact: true });
  await operations.getByRole("button", { name: "Edit operational contacts", exact: true }).click();
  const instructions = operations.getByRole("textbox", { name: "Instructions for assignment 1", exact: true });
  await instructions.fill("Preserve this draft after an unverifiable response.");
  await operations.getByRole("button", { name: "Save contacts", exact: true }).click();
  await expect(operations.getByRole("alert")).toContainText("could not be verified");
  await expect(instructions).toHaveValue("Preserve this draft after an unverifiable response.");
  await expect(operations.getByText("Operational contacts saved.", { exact: true })).toHaveCount(0);
});

for (const code of [403, 404]) {
  test(`operational read ${code} invalidates the whole protected project workspace`, async ({ page }) => {
    await mock(page, route => route.fulfill({ json: detail() }), undefined,
      route => route.fulfill({ status: code, json: { error: code === 404 ? "Project was deleted" : "Project access was revoked" } }));
    await page.goto(projectPath);
    await expect(workspace(page).getByRole("alert")).toContainText(code === 404 ? "Project was deleted" : "Project access was revoked");
    await expect(page.getByText("Bailey Contact", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Photograph the roof.", { exact: true })).toHaveCount(0);
  });
}

test("authorization loss while loading more contacts invalidates the whole workspace", async ({ page }) => {
  let reads = 0;
  await mock(page, route => route.fulfill({ json: detail() }), undefined, (route, url) => {
    if (++reads > 1) return route.fulfill({ status: 401, json: { error: "Staff session expired" } });
    const value = operational("active"); value.contactPage = { available: true, reason: null, nextCursor: "page-two", hasMore: true, returned: 2, limit: 25 };
    return route.fulfill({ json: value });
  });
  await open(page);
  const operations = workspace(page).getByRole("region", { name: "Operational project details", exact: true });
  await operations.getByRole("button", { name: "Edit operational contacts", exact: true }).click();
  await operations.getByRole("button", { name: "Load more available contacts", exact: true }).click();
  await expect(workspace(page).getByRole("alert")).toContainText("Staff session expired");
  await expect(page.getByText("Bailey Contact", { exact: true })).toHaveCount(0);
});

for (const { endpoint, button, code } of [
  { endpoint: "operational-contacts", button: "Save contacts", code: 403 },
  { endpoint: "operational-memory", button: "Save project memory", code: 404 },
] as const) {
  test(`${endpoint} ${code} invalidates protected data rather than preserving a stale editor`, async ({ page }) => {
    await mock(page, route => route.fulfill({ json: detail() }), undefined, (route, url) => url.pathname.endsWith("/operational-workspace")
      ? route.fulfill({ json: operational("active") }) : route.fulfill({ status: code, json: { error: code === 404 ? "Project was deleted" : "Project access was revoked" } }));
    await open(page);
    const operations = workspace(page).getByRole("region", { name: "Operational project details", exact: true });
    if (endpoint === "operational-contacts") await operations.getByRole("button", { name: "Edit operational contacts", exact: true }).click();
    else await operations.getByRole("button", { name: "Edit project memory", exact: true }).click();
    await operations.getByRole("button", { name: button, exact: true }).click();
    await expect(workspace(page).getByRole("alert")).toContainText(code === 404 ? "Project was deleted" : "Project access was revoked");
    await expect(page.getByText("Bailey Contact", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Photograph the roof.", { exact: true })).toHaveCount(0);
  });
}

test("project identifiers decode once and unsupported or malformed project URLs do not fetch records", async ({ page }) => {
  const requests = await mock(page, route => route.fulfill({ json: detail("project%2Fone") }));
  await page.goto(`${clientPath}/projects/project%252Fone?return_to=https%3A%2F%2Fevil.example&token=hidden`);
  await expect(workspace(page).getByRole("heading", { name: "Church survey", exact: true })).toBeVisible();
  expect(requests.some(request => request.url.pathname.endsWith("/business-projects/project%252Fone"))).toBe(true);
  await expect(workspace(page).getByRole("link", { name: "Acme Construction", exact: true })).toHaveAttribute("href", clientPath);
  const count = requests.filter(request => request.url.pathname.includes("/business-projects/")).length;
  for (const invalid of [`${clientPath}/projects/%E0%A4%A`, `${clientPath.replace("/business/", "/portal/")}/projects/project-one`, `${clientPath}/projects/`]) {
    await page.goto(invalid);
    await expect(page.getByText("This project link is invalid.", { exact: true })).toBeVisible();
  }
  expect(requests.filter(request => request.url.pathname.includes("/business-projects/")).length).toBe(count);
});

test("request-only staff cannot fetch a business project workspace", async ({ page }) => {
  const requests = await mock(page, route => route.fulfill({ status: 500 }), ["operations.manage"]);
  await page.goto(projectPath);
  await expect(page.getByText("Client-directory access is required.", { exact: true })).toBeVisible();
  expect(requests.some(request => request.url.pathname.includes("/business-projects/"))).toBe(false);
});

test("project workspace layout supports mobile, narrow, laptop and ultrawide with usable keyboard controls", async ({ page }, testInfo) => {
  test.slow();
  const value = detail(); value.project.name = "Acme Construction Services — Long Regional Church Survey Project";
  value.linkedContact!.email = "long-project-contact-name@regional-construction-services.example.test";
  value.project.description = "First line with context.\nSecond line with a practical delivery requirement.";
  await mock(page, route => route.fulfill({ json: value }));
  await page.goto(projectPath);
  await expect(workspace(page).getByRole("heading", { name: value.project.name, exact: true })).toBeVisible();
  const operations = workspace(page).getByRole("region", { name: "Operational project details", exact: true });
  await operations.getByRole("button", { name: "Edit operational contacts", exact: true }).click();
  await operations.getByRole("button", { name: "Edit project memory", exact: true }).click();
  for (const width of [375, 640, 1280, 3440]) {
    await page.setViewportSize({ width, height: 960 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const name = workspace(page).locator(".business-project-facts > div").filter({ has: page.locator("dt", { hasText: /^Name$/ }) });
    const label = await name.locator("dt").boundingBox(), value = await name.locator("dd").boundingBox();
    expect(value!.y - (label!.y + label!.height)).toBeLessThanOrEqual(12);
    for (const action of await workspace(page).getByRole("link").all()) {
      const bounds = await action.boundingBox(); expect(bounds!.height).toBeGreaterThanOrEqual(44); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    }
    for (const control of await operations.locator("button, select, textarea, input[type=file], summary").all()) {
      const bounds = await control.boundingBox(); expect(bounds!.height).toBeGreaterThanOrEqual(44); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    }
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`business-project-${width}.png`) });
    await page.screenshot({ path: testInfo.outputPath(`business-project-${width}-full.png`), fullPage: true });
  }
  const refresh = workspace(page).getByRole("button", { name: "Refresh project", exact: true });
  await refresh.focus(); await page.keyboard.press("Enter");
  await expect(workspace(page).getByRole("button", { name: "Refresh project", exact: true })).toBeFocused();
});

test("recurring project copy previews explicit selections and retries commit with one stable operation key", async ({ page }) => {
  const writes: Array<{ action: string; body: Record<string, unknown> }> = []; let commits = 0, previews = 0;
  const projects = [
    { ...detail().project, row_key: "destination", manager_name: "Morgan Manager" },
    { ...detail("project-zero", "Previous church survey").project, status: "completed", row_key: "source", manager_name: "Morgan Manager" },
  ];
  await mock(page, (route, url) => {
    const value = detail(); value.project.status = "active"; return route.fulfill({ json: value });
  }, ["team.view", "projects.view", "project.contacts.manage", "project.memory.manage"], async (route, url) => {
    if (url.pathname.endsWith("/operational-workspace")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-2)!);
      return route.fulfill({ json: operational(id === "project-one" ? "active" : "completed", id) });
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (url.pathname.endsWith("/recurring-copy/preview")) {
      writes.push({ action: "preview", body });
      previews += 1;
      if (previews === 2) return route.fulfill({ status: 503, json: { error: "Temporary preview interruption" } });
      return route.fulfill({ json: { fingerprint: "f".repeat(64),
        source: { projectId: "project-zero", projectRevision: "project-zero-revision", contactsVersion: 1, memoryVersion: 1 },
        destination: { projectId: "project-one", projectRevision: "project-one-revision", contactsVersion: 1, memoryVersion: 1 },
        selection: { contactRoles: ["project_contact"], memorySections: ["plan"], conflictPolicy: "keep_destination" },
        changes: { contactsChanged: true, memoryChanged: true, copiedContacts: 1, copiedMemorySections: ["plan"], contactConflicts: 1, memoryConflicts: ["plan"] } } });
    }
    if (url.pathname.endsWith("/recurring-copy/commit")) {
      writes.push({ action: "commit", body }); commits += 1;
      if (commits === 1) return route.fulfill({ status: 503, json: { error: "Temporary copy interruption" } });
      return route.fulfill({ json: { replayed: false, fingerprint: "f".repeat(64),
        source: { projectId: "project-zero", projectRevision: "project-zero-revision", contactsVersion: 1, memoryVersion: 1 },
        destination: { projectId: "project-one", projectRevision: "project-one-revision", contactsVersion: 1, memoryVersion: 1,
          contactsVersionAfter: 2, memoryVersionAfter: 2 },
        selection: { contactRoles: ["project_contact"], memorySections: ["plan"], conflictPolicy: "keep_destination" },
        changes: { contactsChanged: true, memoryChanged: true, copiedContacts: 1, copiedMemorySections: ["plan"], contactConflicts: 1, memoryConflicts: ["plan"] } } });
    }
    return route.fulfill({ status: 500, json: { error: "Unexpected operational request" } });
  }, projects);
  await open(page);
  const copy = workspace(page).getByRole("region", { name: "Copy from a previous project", exact: true });
  await copy.getByRole("combobox", { name: "Previous project", exact: true }).selectOption("project-zero");
  await copy.getByRole("checkbox", { name: "Project contacts", exact: true }).check();
  await copy.getByRole("checkbox", { name: "Plan", exact: true }).check();
  await copy.getByRole("button", { name: "Preview copy", exact: true }).click();
  await expect(copy.getByRole("region", { name: "Copy preview", exact: true })).toContainText("1 contact assignment will be added or updated");
  await expect(copy.getByRole("button", { name: "Apply copy to this project", exact: true })).toBeDisabled();
  await copy.getByRole("checkbox", { name: /I reviewed this preview/ }).check();
  await copy.getByRole("button", { name: "Preview copy", exact: true }).click();
  await expect(copy.getByRole("alert")).toContainText("Temporary preview interruption");
  await expect(copy.getByRole("button", { name: "Apply copy to this project", exact: true })).toHaveCount(0);
  await expect(copy.getByRole("checkbox", { name: "Plan", exact: true })).toBeChecked();
  await expect(copy.getByRole("combobox", { name: "Previous project", exact: true })).toHaveValue("project-zero");
  await copy.getByRole("button", { name: "Preview copy", exact: true }).click();
  await expect(copy.getByRole("button", { name: "Apply copy to this project", exact: true })).toBeDisabled();
  await copy.getByRole("checkbox", { name: /I reviewed this preview/ }).check();
  await copy.getByRole("button", { name: "Apply copy to this project", exact: true }).click();
  await expect(copy.getByRole("alert")).toContainText("Temporary copy interruption");
  await copy.getByRole("button", { name: "Apply copy to this project", exact: true }).click();
  await expect(copy.getByText("Selected operational details copied. Operational details are refreshing.", { exact: true })).toBeVisible();
  expect(writes.map(item => item.action)).toEqual(["preview", "preview", "preview", "commit", "commit"]);
  expect(writes[0]!.body).toMatchObject({ expectedContextVersion: "project-context", sourceProjectId: "project-zero", destinationProjectId: "project-one",
    selectedContactRoles: ["project_contact"], selectedMemorySections: ["plan"], conflictPolicy: "keep_destination",
    expected: { sourceProjectRevision: "project-zero-revision", destinationProjectRevision: "project-one-revision",
      sourceContactsVersion: 1, destinationContactsVersion: 1, sourceMemoryVersion: 1, destinationMemoryVersion: 1 } });
  expect(writes[3]!.body.idempotencyKey).toBe(writes[4]!.body.idempotencyKey);
  expect(writes[3]!.body.previewFingerprint).toBe("f".repeat(64));
  for (const item of writes) expect(JSON.stringify(item.body)).not.toMatch(/portal|grant|billing|invitation|notification|attachment/i);
});

test("recurring copy retries a failed previous-project list without losing selections", async ({ page }) => {
  const projects = [{ ...detail("project-zero", "Previous project").project, row_key: "source" }];
  const requests = await mock(page, route => { const value = detail(); value.project.status = "active"; return route.fulfill({ json: value }); },
    ["team.view", "projects.view", "project.memory.manage"],
    route => route.fulfill({ json: operational("active") }), projects);
  let attempts = 0;
  await page.route("**/collections/businessProjects?**", route => {
    attempts += 1;
    if (attempts === 1) return route.fulfill({ status: 503, json: { error: "Previous projects temporarily unavailable" } });
    return route.fallback();
  });
  await open(page);
  const copy = workspace(page).getByRole("region", { name: "Copy from a previous project", exact: true });
  await expect(copy.getByRole("alert")).toContainText("Previous projects temporarily unavailable");
  await copy.getByRole("checkbox", { name: "Recommendations", exact: true }).check();
  await copy.getByRole("button", { name: "Retry loading previous projects" }).click();
  await expect(copy.getByRole("combobox").getByRole("option", { name: "Previous project · completed" })).toHaveCount(1);
  await expect(copy.getByRole("checkbox", { name: "Recommendations", exact: true })).toBeChecked();
  await expect(copy.getByRole("button", { name: "Retry loading previous projects" })).toHaveCount(0);
  await expect(copy.getByRole("alert")).toHaveCount(0);
  expect(attempts).toBe(2);
  expect(requests.filter(request => request.method !== "GET")).toEqual([]);
});

test("recurring copy renders a non-actionable empty state when no previous project exists", async ({ page }) => {
  const destination = { ...detail().project, status: "active", row_key: "destination" };
  await mock(page, route => { const value = detail(); value.project.status = "active"; return route.fulfill({ json: value }); },
    ["team.view", "projects.view", "project.contacts.manage", "project.memory.manage"],
    (route, url) => url.pathname.endsWith("/operational-workspace")
      ? route.fulfill({ json: operational("active", "project-one") })
      : route.fulfill({ status: 500, json: { error: "Unexpected operational request" } }), [destination]);
  await open(page);
  const copyCard = workspace(page).locator(".ltds-card").filter({ has: page.getByRole("heading", { name: "Copy from a previous project", exact: true }) });
  await expect(copyCard.getByText("No previous project to copy", { exact: true })).toBeVisible();
  await expect(copyCard.getByRole("combobox")).toHaveCount(0);
  await expect(copyCard.getByRole("checkbox")).toHaveCount(0);
  await expect(copyCard.getByRole("button", { name: "Preview copy", exact: true })).toHaveCount(0);
});

test("recurring copy clears protected project data when preview authorization or context changes", async ({ page }) => {
  const projects = [{ ...detail().project, status: "active", row_key: "destination" },
    { ...detail("project-zero", "Previous project").project, row_key: "source" }];
  await mock(page, (route, url) => { const value = detail(); value.project.status = "active"; return route.fulfill({ json: value }); },
    ["team.view", "projects.view", "project.contacts.manage"], async (route, url) => {
      if (url.pathname.endsWith("/operational-workspace")) {
        const id = decodeURIComponent(url.pathname.split("/").at(-2)!); return route.fulfill({ json: operational("active", id) });
      }
      return route.fulfill({ status: 409, json: { error: "Project ownership changed before preview" } });
    }, projects);
  await open(page);
  const copy = workspace(page).getByRole("region", { name: "Copy from a previous project", exact: true });
  await copy.getByRole("combobox", { name: "Previous project", exact: true }).selectOption("project-zero");
  await copy.getByRole("checkbox", { name: "Project contacts", exact: true }).check();
  await copy.getByRole("button", { name: "Preview copy", exact: true }).click();
  await expect(workspace(page).getByRole("alert")).toContainText("Project ownership changed before preview");
  await expect(page.getByText("Bailey Contact", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Photograph the roof.", { exact: true })).toHaveCount(0);
});

test("recurring copy stays usable without horizontal overflow on mobile", async ({ page }) => {
  const projects = [{ ...detail().project, status: "active", row_key: "destination" },
    { ...detail("project-zero", "A very long previous project name for a regional construction client").project, row_key: "source" }];
  await page.setViewportSize({ width: 375, height: 900 });
  await mock(page, (route, url) => { const value = detail(); value.project.status = "active"; return route.fulfill({ json: value }); },
    ["team.view", "projects.view", "project.contacts.manage", "project.memory.manage"], undefined, projects);
  await open(page);
  const copy = workspace(page).getByRole("region", { name: "Copy from a previous project", exact: true });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const control of await copy.locator("button, select, input[type=checkbox], input[type=radio]").all()) {
    const bounds = await control.boundingBox();
    if (await control.getAttribute("type") === "checkbox" || await control.getAttribute("type") === "radio") continue;
    expect(bounds!.height).toBeGreaterThanOrEqual(44); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(376);
  }
});
