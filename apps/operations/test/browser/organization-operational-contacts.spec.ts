import { expect, test, type Page, type Route } from "@playwright/test";

const clientPath = "/clients/sources/project-alpha%3Aprimary/business/organizations/42";
const detailApi = "/api/client-hub/sources/project-alpha%3Aprimary/business/organizations/42";
const endpoint = `${detailApi}/organization-operational-contacts`;
const canonicalRoot: { sourceId: string; rootNamespace: "business"; kind: "organization"; publicId: string } =
  { sourceId: "project-alpha:primary", rootNamespace: "business", kind: "organization", publicId: "42" };

function contact(id: string, name = `Contact ${id}`) {
  return { public_id: id, display_name: name, email: `${id}@example.test`, phone: "+1 920 555 0101", record_type: "business_contact" as const };
}
function assignment(id: string, contactId: string, role: "primary_operational" | "delivery", sortOrder: number) {
  return { id, role, sortOrder, availability: "available" as const,
    contact: { id: contactId, displayName: `Contact ${contactId}`, email: `${contactId}@example.test`, phone: "+1 920 555 0101" as string | null } };
}
function workspace(overrides: Record<string, unknown> = {}) {
  const value = {
    canonicalRoot, contextVersion: "context-one", organization: { id: "42", sourceId: "project-alpha:primary", revision: "organization-r1" },
    contacts: { version: 1, assignments: [assignment("primary-assignment", "primary-one", "primary_operational", 0),
      assignment("delivery-assignment", "delivery-one", "delivery", 1)],
      revisions: [{ version: 1, actorId: "staff-one", createdAt: "2026-08-28T12:00:00Z" }] },
    capabilities: { canManageOrganizationContacts: true },
    contactOptions: [contact("primary-one"), contact("delivery-one"), contact("delivery-two")],
    contactPage: { available: true, reason: null, nextCursor: null, hasMore: false, returned: 3, limit: 25 },
  };
  return { ...value, ...overrides };
}
function detail(kind: "organization" | "standalone_client" = "organization") {
  const routeKind = kind === "organization" ? "organizations" : "standalone";
  return {
    client: { workspace_id: null, public_id: "42", kind, route_kind: routeKind, source_id: "project-alpha:primary",
      root_namespace: "business", pa_public_id: "a".repeat(32), detail_path: clientPath, display_name: "Acme Construction",
      status: "active", portal_status: "not_provisioned", account_count: 0, project_count: 0, request_count: 0, contact_count: 3 },
    contextVersion: "context-one", contacts: [contact("primary-one")], accounts: [], projects: [], requests: [],
    deliveryGrants: [], authenticatedDeliveryGrants: [], viewerGrants: [], capabilities: { directory: true, requests: false, delivery: false, viewer: false },
    organizationOperationalContactsAvailable: kind === "organization",
    businessActivityAvailable: true,
    pages: { businessContacts: { available: true, reason: null, nextCursor: null, hasMore: false, returned: 1, limit: 5 } },
  };
}
type ContactHandler = (route: Route, url: URL, call: number) => Promise<unknown>;
async function mock(page: Page, handler: ContactHandler, detailFactory: () => unknown = detail) {
  let calls = 0;
  const requests: Array<{ method: string; url: URL; body: Record<string, unknown> | null }> = [];
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()), method = route.request().method();
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: "staff-one", email: "staff@example.test", displayName: "Staff",
      status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["team.view", "organization.contacts.manage"], divisions: [] },
      csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    if (url.pathname === endpoint) {
      requests.push({ method, url, body: method === "POST" ? route.request().postDataJSON() as Record<string, unknown> : null });
      return handler(route, url, ++calls);
    }
    if (url.pathname === detailApi) return route.fulfill({ json: detailFactory() });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return { requests, calls: () => calls };
}
function region(page: Page) { return page.getByRole("region", { name: "Organization operational contacts", exact: true }); }
async function open(page: Page) {
  await page.goto(clientPath);
  await expect(page.getByRole("heading", { name: "Acme Construction", exact: true })).toBeVisible();
  await expect(region(page).getByText("These contacts are operational reference roles only.", { exact: false })).toBeVisible();
}

test("organization roles are explicit reference metadata and read-only capability hides editing", async ({ page }) => {
  const value = workspace({ capabilities: { canManageOrganizationContacts: false } });
  await mock(page, route => route.fulfill({ json: value }));
  await open(page);
  const contacts = region(page);
  await expect(contacts.getByRole("heading", { name: "Primary operational contact" })).toBeVisible();
  await expect(contacts.getByRole("heading", { name: "Delivery contacts" })).toBeVisible();
  await expect(contacts).toContainText("Contact primary-one");
  await expect(contacts).toContainText("Contact delivery-one");
  await expect(contacts).toContainText("do not grant portal access, delivery access, billing authority, or notification authority");
  await expect(contacts.getByRole("button", { name: "Edit organization contacts" })).toHaveCount(0);
  await expect(contacts.getByRole("button", { name: /invite|grant|notify|bill/i })).toHaveCount(0);
});

test("manager atomically saves one primary and many delivery contacts without conflating the roles", async ({ page }) => {
  let version = 1;
  const state = await mock(page, (route, _url, call) => {
    if (route.request().method() === "POST") {
      version = 2;
      return route.fulfill({ json: { sourceId: "project-alpha:primary", organizationId: "42", version: 2, replayed: false } });
    }
    const value = workspace();
    if (version === 2) value.contacts = { ...value.contacts, version: 2 };
    return route.fulfill({ json: value });
  });
  await open(page);
  const contacts = region(page);
  await contacts.getByRole("button", { name: "Edit organization contacts" }).click();
  await contacts.getByRole("combobox", { name: "Primary operational contact" }).selectOption("delivery-two");
  await contacts.getByRole("button", { name: "Add delivery contact" }).click();
  await contacts.getByRole("combobox", { name: "Delivery contact 2" }).selectOption("delivery-two");
  await contacts.getByRole("button", { name: "Save organization contacts" }).click();
  await expect(contacts.getByText("Organization contacts saved.", { exact: true })).toBeVisible();
  const write = state.requests.find(item => item.method === "POST")!;
  expect(write.url.pathname).toBe(endpoint);
  expect(write.body).toMatchObject({ expectedContextVersion: "context-one", expectedVersion: 1,
    assignments: [{ contactId: "delivery-two", role: "primary_operational" },
      { contactId: "delivery-one", role: "delivery" }, { contactId: "delivery-two", role: "delivery" }] });
  expect(write.body!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
});

test("transient save errors preserve the draft and retry with one stable idempotency key", async ({ page }) => {
  let writes = 0, committed = false;
  const state = await mock(page, route => {
    if (route.request().method() === "GET") {
      const value = workspace();
      if (committed) value.contacts = { ...value.contacts, version: 2 };
      return route.fulfill({ json: value });
    }
    writes += 1;
    if (writes === 1) return route.fulfill({ status: 503, json: { error: "Temporary save interruption" } });
    committed = true;
    return route.fulfill({ json: { sourceId: "project-alpha:primary", organizationId: "42", version: 2, replayed: false } });
  });
  await open(page);
  const contacts = region(page);
  await contacts.getByRole("button", { name: "Edit organization contacts" }).click();
  await contacts.getByRole("combobox", { name: "Primary operational contact" }).selectOption("delivery-two");
  await contacts.getByRole("button", { name: "Save organization contacts" }).click();
  await expect(contacts.getByRole("alert")).toContainText("Temporary save interruption");
  await expect(contacts.getByRole("combobox", { name: "Primary operational contact" })).toHaveValue("delivery-two");
  await contacts.getByRole("button", { name: "Save organization contacts" }).click();
  const writesMade = state.requests.filter(item => item.method === "POST");
  expect(writesMade).toHaveLength(2);
  expect(writesMade[0]!.body!.idempotencyKey).toBe(writesMade[1]!.body!.idempotencyKey);
});

test("a delayed save cannot report success after navigation leaves the source workspace", async ({ page }) => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const postStarted = new Promise<void>(resolve => { started = resolve; });
  await mock(page, async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: workspace() });
    started(); await gate;
    return route.fulfill({ json: { sourceId: "project-alpha:primary", organizationId: "42", version: 2, replayed: false } });
  });
  await open(page);
  await region(page).getByRole("button", { name: "Edit organization contacts" }).click();
  await region(page).getByRole("button", { name: "Save organization contacts" }).click();
  await postStarted;
  await page.goto("/clients"); release();
  await expect(page).toHaveURL(/\/clients$/);
  await expect(page.getByText("Organization contacts saved.", { exact: true })).toHaveCount(0);
});

test("parent authorization invalidation aborts a delayed save without stale success", async ({ page }) => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const postStarted = new Promise<void>(resolve => { started = resolve; });
  await mock(page, async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: workspace() });
    started(); await gate;
    return route.fulfill({ json: { sourceId: "project-alpha:primary", organizationId: "42", version: 2, replayed: false } });
  });
  await open(page);
  await region(page).getByRole("button", { name: "Edit organization contacts" }).click();
  await region(page).getByRole("button", { name: "Save organization contacts" }).click();
  await postStarted;
  await page.getByRole("button", { name: "Show business updates" }).click();
  const refresh = page.getByRole("button", { name: "Refresh client workspace", exact: true });
  await expect(refresh).toBeVisible(); await refresh.click();
  await expect(region(page).getByText("These contacts are operational reference roles only.", { exact: false })).toBeVisible();
  release();
  await expect(page.getByText("Organization contacts saved.", { exact: true })).toHaveCount(0);
});

test("assigned contacts beyond the first option page remain selected and pagination deduplicates exact IDs", async ({ page }) => {
  const firstOptions = Array.from({ length: 25 }, (_, index) => contact(`contact-${index}`));
  const assigned = assignment("assigned-primary", "assigned-26", "primary_operational", 0);
  assigned.contact = { id: "assigned-26", displayName: "Assigned Beyond First Page", email: "assigned@example.test", phone: null };
  const first = workspace({ contacts: { version: 1, assignments: [assigned], revisions: [] }, contactOptions: firstOptions,
    contactPage: { available: true, reason: null, nextCursor: "page-two", hasMore: true, returned: 25, limit: 25 } });
  await mock(page, (route, url) => {
    if (!url.searchParams.has("contactCursor")) return route.fulfill({ json: first });
    return route.fulfill({ json: workspace({ contacts: first.contacts,
      contactOptions: [contact("contact-0", "Duplicate first-page contact"), contact("contact-26")],
      contactPage: { available: true, reason: null, nextCursor: null, hasMore: false, returned: 2, limit: 25 } }) });
  });
  await open(page);
  const contacts = region(page);
  await contacts.getByRole("button", { name: "Edit organization contacts" }).click();
  await expect(contacts.getByRole("combobox", { name: "Primary operational contact" })).toHaveValue("assigned-26");
  await contacts.getByRole("button", { name: "Load more available contacts" }).click();
  await expect(contacts.getByRole("combobox", { name: "Primary operational contact" }).locator("option[value='contact-26']")).toHaveCount(1);
  await expect(contacts.getByRole("combobox", { name: "Primary operational contact" }).locator("option[value='contact-0']")).toHaveCount(1);
});

test("contact management capability drift during pagination invalidates stale edit controls", async ({ page }) => {
  const first = workspace({ contactOptions: Array.from({ length: 25 }, (_, index) => contact(`contact-${index}`)),
    contactPage: { available: true, reason: null, nextCursor: "page-two", hasMore: true, returned: 25, limit: 25 } });
  await mock(page, (route, url) => route.fulfill({ json: url.searchParams.has("contactCursor")
    ? workspace({ contacts: first.contacts, capabilities: { canManageOrganizationContacts: false }, contactOptions: [],
      contactPage: { available: false, reason: "permission_required", nextCursor: null, hasMore: false, returned: 0, limit: 25 } })
    : first }));
  await open(page);
  await region(page).getByRole("button", { name: "Edit organization contacts" }).click();
  await region(page).getByRole("button", { name: "Load more available contacts" }).click();
  await expect(page.getByRole("button", { name: "Refresh client workspace", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save organization contacts" })).toHaveCount(0);
});

test("unavailable synchronized assignments remain visible and must be replaced or removed", async ({ page }) => {
  const unavailable = { id: "old-delivery", role: "delivery" as const, sortOrder: 0, availability: "unavailable" as const, contact: null };
  await mock(page, route => route.fulfill({ json: workspace({ contacts: { version: 1, assignments: [unavailable], revisions: [] } }) }));
  await open(page);
  const contacts = region(page);
  await expect(contacts).toContainText("Unavailable synchronized contact");
  await contacts.getByRole("button", { name: "Edit organization contacts" }).click();
  await contacts.getByRole("button", { name: "Save organization contacts" }).click();
  await expect(contacts.getByRole("alert").last()).toContainText("Replace or remove unavailable assignments");
  await contacts.getByRole("button", { name: "Remove delivery contact 1" }).click();
  await expect(contacts.getByRole("button", { name: "Save organization contacts" })).toBeEnabled();
});

test("duplicate delivery assignments are rejected locally while one person may hold both distinct roles", async ({ page }) => {
  await mock(page, route => route.fulfill({ json: workspace() }));
  await open(page);
  const contacts = region(page);
  await contacts.getByRole("button", { name: "Edit organization contacts" }).click();
  await contacts.getByRole("button", { name: "Add delivery contact" }).click();
  await contacts.getByRole("combobox", { name: "Delivery contact 2" }).selectOption("delivery-one");
  await contacts.getByRole("button", { name: "Save organization contacts" }).click();
  await expect(contacts.getByRole("alert")).toContainText("same contact cannot be assigned to the same role twice");
});

for (const failure of [401, 403, 404, 409, "root", "context"] as const) {
  test(`protected organization contact ${failure} invalidates the complete client workspace`, async ({ page }) => {
    await mock(page, route => {
      if (typeof failure === "number") return route.fulfill({ status: failure, json: { error: "Organization contact authority changed" } });
      const value = workspace();
      if (failure === "root") value.canonicalRoot = { ...canonicalRoot, publicId: "43" };
      else value.contextVersion = "other-context";
      return route.fulfill({ json: value });
    });
    await page.goto(clientPath);
    await expect(page.getByRole("button", { name: "Refresh client workspace", exact: true })).toBeVisible();
    await expect(page.locator(".client-hub-detail-grid")).toHaveCount(0);
    await expect(page.getByText("Contact primary-one", { exact: true })).toHaveCount(0);
  });
}

test("transient initial failures preserve the client workspace and retry only the contact card", async ({ page }) => {
  let reads = 0;
  const state = await mock(page, route => ++reads === 1
    ? route.fulfill({ status: 503, json: { error: "Contact service temporarily unavailable" } })
    : route.fulfill({ json: workspace() }));
  await open(page);
  await expect(page.getByRole("heading", { name: "Acme Construction", exact: true })).toBeVisible();
  await expect(region(page).getByRole("alert")).toContainText("Contact service temporarily unavailable");
  await region(page).getByRole("button", { name: "Retry organization contacts" }).click();
  await expect(region(page).getByText("Contact primary-one", { exact: true })).toBeVisible();
  expect(state.calls()).toBe(2);
});

test("organization contact editor is usable without overflow from mobile through ultrawide", async ({ page }, testInfo) => {
  const long = assignment("long-primary", "long-primary", "primary_operational", 0);
  long.contact = { id: "long-primary", displayName: "A very long operational contact name for regional construction coordination",
    email: "long-operational-contact-address@regional-construction-services.example.test", phone: "+1 920 555 0101" };
  const value = workspace({ contacts: { version: 1, assignments: [long, assignment("delivery", "delivery-one", "delivery", 1)], revisions: [] },
    contactOptions: [contact("long-primary", long.contact.displayName), contact("delivery-one"), contact("delivery-two")],
    contactPage: { available: true, reason: null, nextCursor: null, hasMore: false, returned: 3, limit: 25 } });
  await mock(page, route => route.fulfill({ json: value }));
  await open(page);
  await region(page).getByRole("button", { name: "Edit organization contacts" }).click();
  for (const width of [375, 640, 1280, 3440]) {
    await page.setViewportSize({ width, height: 960 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const control of await region(page).locator("button, select, summary").all()) {
      const bounds = await control.boundingBox();
      expect(bounds!.height).toBeGreaterThanOrEqual(44); expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    }
    await region(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`organization-contacts-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 960 });
  const editor = region(page).locator(".organization-operational-editor");
  const [primaryFieldset, deliveryFieldset] = await editor.locator("fieldset").all();
  const [primaryBounds, deliveryBounds, primarySelectBounds, deliverySelectBounds] = await Promise.all([
    primaryFieldset!.boundingBox(), deliveryFieldset!.boundingBox(),
    region(page).getByRole("combobox", { name: "Primary operational contact" }).boundingBox(),
    region(page).getByRole("combobox", { name: "Delivery contact 1" }).boundingBox(),
  ]);
  expect(primaryBounds!.width).toBeLessThan(560);
  expect(deliveryBounds!.x).toBeCloseTo(primaryBounds!.x, 0);
  expect(deliveryBounds!.y).toBeGreaterThan(primaryBounds!.y + primaryBounds!.height - 1);
  expect(primarySelectBounds!.width).toBeGreaterThan(300);
  expect(deliverySelectBounds!.width).toBeGreaterThan(300);
  const cancel = region(page).getByRole("button", { name: "Cancel contact changes" });
  await cancel.focus(); await page.keyboard.press("Enter");
  await expect(region(page).getByText("Changes cancelled.", { exact: true })).toBeVisible();
});

test("standalone source workspaces never request or render organization role assignments", async ({ page }) => {
  let contactCalls = 0;
  const standalonePath = clientPath.replace("/organizations/", "/standalone/");
  const standaloneApi = detailApi.replace("/organizations/", "/standalone/");
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: "staff-one", email: "staff@example.test", displayName: "Staff",
      status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["team.view", "organization.contacts.manage"], divisions: [] },
      csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    if (url.pathname.includes("organization-operational-contacts")) { contactCalls += 1; return route.fulfill({ status: 500 }); }
    if (url.pathname === standaloneApi) return route.fulfill({ json: detail("standalone_client") });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto(standalonePath);
  await expect(page.getByRole("heading", { name: "Acme Construction", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Organization contacts", exact: true })).toHaveCount(0);
  expect(contactCalls).toBe(0);
});
