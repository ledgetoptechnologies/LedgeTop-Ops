import { expect, test, type Page, type Route } from "@playwright/test";

const sourceId = "project-alpha:primary";
const canonicalPath = "/clients/sources/project-alpha%3Aprimary/business/organizations/42";
const canonicalApi = `/api${canonicalPath.replace("/clients/", "/client-hub/")}`;
const collections = ["businessContacts", "accounts", "projects", "requests", "deliveryGrants", "authenticatedDeliveryGrants", "viewerGrants"] as const;
type Collection = typeof collections[number];
const labels: Record<Collection, string> = { businessContacts: "Business contacts", accounts: "Accounts", projects: "Shared projects",
  requests: "Requests", deliveryGrants: "Delivery links", authenticatedDeliveryGrants: "Client portal deliveries", viewerGrants: "Shared models" };
const capabilities = { directory: true, requests: true, delivery: true, viewer: true };
const canonicalRoot = { sourceId, rootNamespace: "business", kind: "organization", publicId: "42" };

function contact(id: string, name: string) {
  return { row_key: `portal:${id}`, contact_key: id, record_type: "portal_principal",
    workspace_id: "workspace-one", public_id: id, display_name: name, email_hint: `${id}@example.test`, status: "active",
    identity_id: "identity-one", has_workspace_access: 1, blocked: 0, access: [], invitation: null };
}
function businessContact(id: string, name: string) {
  return { row_key: `business:${id}`, contact_key: id, record_type: "business_contact", public_id: id, organization_id: "42",
    display_name: name, email: `${id}@example.test` as string | null, phone: "+1 (920) 555-0101 ext. 4" as string | null };
}
function item(collection: Collection, index: number): Record<string, unknown> {
  const id = `${collection}-${index}`, row_key = `${collection}:account-one:${id}`;
  if (collection === "businessContacts") return businessContact(id, `Business contact ${index}`);
  if (collection === "accounts") return { row_key, id, display_name: `Account ${index}`, status: "active" };
  if (collection === "projects") return { row_key, id, account_id: "account-one", project_name: `Shared project ${index}`, client_name: "Acme", active: 1, can_request_service: 1 };
  if (collection === "requests") return { row_key, id, title: `Service request ${index}`, status: "submitted", project_name: "Acme site", created_at: "2026-08-25T12:00:00Z" };
  if (collection === "deliveryGrants") return { row_key, share_id: id, account_id: "account-one", label: `Delivery link ${index}`, r2_prefix: `clients/acme/delivery-${index}/`, project_name: "Acme site", revoked_at: null, expires_at: null };
  if (collection === "authenticatedDeliveryGrants") return { row_key, id, status: "active", r2_prefix: `clients/acme/portal-${index}/`, audience_type: "workspace", expires_at: null };
  return { row_key, id, status: "active", scope_type: "model", project_name: "Acme site", model_title: `Shared model ${index}`, authorization_expires_at: null };
}
function metadata(collection: Collection, more = true, limit = 25) {
  return { available: true, reason: null as string | null, nextCursor: more ? `${collection}-page-2` : null, hasMore: more, returned: 1, limit };
}
function detail(revision = 1) {
  return {
    client: { workspace_id: "workspace-one", public_id: "42", kind: "organization", route_kind: "organizations", source_id: sourceId,
      root_namespace: "business", pa_public_id: "a".repeat(32), detail_path: canonicalPath, display_name: revision === 1 ? "Acme Construction" : "Acme refreshed",
      status: "active", portal_status: "active", account_count: 1, project_count: 1, request_count: 1, contact_count: 2 },
    contextVersion: `context-${revision}`, pages: Object.fromEntries(collections.map(collection => [collection, metadata(collection, true, 5)])),
    contacts: [businessContact("business-one", "Business Bailey")],
    accounts: [item("accounts", 1)], projects: [item("projects", 1)], requests: [item("requests", 1)],
    deliveryGrants: [item("deliveryGrants", 1)], authenticatedDeliveryGrants: [item("authenticatedDeliveryGrants", 1)], viewerGrants: [item("viewerGrants", 1)],
    portalIdentities: { items: [{ ...contact("portal-one", "Portal Alex"), binding_status: "linked", principalContextVersion: `principal-${revision}`,
      hasExplicitAccess: false, accessLoaded: false, effectiveEmailBlockCount: 0, effectiveSubjectBlock: false, removableEmailBlockId: null,
      actions: { canRetryInvitation: false, canCreateEmailBlock: true, canReviewEligibilityBlocks: true } }],
      page: { available: true, reason: null, nextCursor: null, hasMore: false, returned: 1, limit: 5 }, contextVersion: `context-${revision}`,
      refreshedAt: "2026-08-25T12:00:00Z", capabilities: { canManageEligibilityBlocks: true, canManagePortal: true } }, capabilities,
  };
}
function reply(collection: Collection, items = [item(collection, 2)], more = false, contextVersion = "context-1") {
  return { items, page: metadata(collection, more), canonicalRoot, contextVersion };
}
function contactRole(name: string, role = "project_contact") {
  return { contactDisplayName: name, clientDisplayName: "Craig Client", scopeType: "department", scopeDisplayName: "Athletics",
    role, primary: false, primaryBilling: false, sendProjectInvoices: false, canViewInvoiceLinks: false };
}
function contactRolePage(items: ReturnType<typeof contactRole>[], more = false, cursor: string | null = null, contextVersion = "context-1") {
  return { state: items.length ? "populated" : "verified_empty", reason: null, items, nextCursor: more ? cursor : null,
    hasMore: more, returned: items.length, limit: 5, canonicalRoot, contextVersion };
}
function detailWithContactRoles(items = [contactRole("Craig Contact")], more = false) {
  const response = detail() as ReturnType<typeof detail> & { projectAlphaContactRolesAvailable: boolean; projectAlphaContactRoles: unknown };
  response.projectAlphaContactRolesAvailable = true;
  response.projectAlphaContactRoles = contactRolePage(items, more, more ? "roles-page-2" : null);
  return response;
}
type Handler = (route: Route, collection: Collection, url: URL) => Promise<unknown>;
type ContactRoleHandler = (route: Route, url: URL) => Promise<unknown>;
async function mock(page: Page, collectionHandler: Handler, detailFactory: (count: number) => unknown = () => detail(),
  contactRoleHandler?: ContactRoleHandler) {
  const requests: URL[] = [];
  let detailCalls = 0;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()); requests.push(url);
    if (url.pathname === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-one", email: "staff@example.test", displayName: "Staff", status: "Active", profileType: "Administrator",
        isAdministrator: true, permissions: ["team.view"], divisions: [] },
      csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
    } });
    if (url.pathname.includes("/collections/")) return collectionHandler(route, url.pathname.split("/").at(-1) as Collection, url);
    if (url.pathname.endsWith("/project-alpha-contact-roles") && contactRoleHandler) return contactRoleHandler(route, url);
    if (url.pathname.startsWith("/api/client-hub/") && !url.pathname.includes("/collections/")) return route.fulfill({ json: detailFactory(++detailCalls) });
    if (url.pathname === "/api/team/clients/eligibility-blocks") return route.fulfill({ status: 201, json: { id: "new-block" } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return { requests, detailCalls: () => detailCalls };
}
function region(page: Page, collection: Collection) { return page.getByRole("region", { name: labels[collection], exact: true }); }
function loadButton(page: Page, collection: Collection) { return region(page, collection).getByRole("button", { name: `Load more ${labels[collection].toLowerCase()}`, exact: true }); }
async function open(page: Page, path = canonicalPath) {
  await page.goto(path);
  await expect(page.getByRole("heading", { name: "Acme Construction", exact: true })).toBeVisible();
}
async function lateFulfill(route: Route, json: unknown) { await route.fulfill({ json }).catch(() => undefined); }

test("Project Alpha contact roles stay separate, informational and responsive", async ({ page }) => {
  const response = detailWithContactRoles([
      { contactDisplayName: "Craig Contact", clientDisplayName: "Craig Client", scopeType: "department", scopeDisplayName: "Athletics",
        role: "athletic_director", primary: true, primaryBilling: false, sendProjectInvoices: false, canViewInvoiceLinks: false },
      { contactDisplayName: "Billing Contact With A Long Display Name", clientDisplayName: "Regional Facilities Department",
        scopeType: "organization", scopeDisplayName: "Acme Construction Services Regional Organization", role: "billing_contact",
        primary: false, primaryBilling: true, sendProjectInvoices: true, canViewInvoiceLinks: true },
    ]);
  await mock(page, (route, collection) => route.fulfill({ json: reply(collection) }), () => response);
  await page.setViewportSize({ width: 375, height: 900 });
  await open(page);
  const roles = page.getByRole("region", { name: "Project Alpha contact roles", exact: true });
  await expect(roles).toContainText("These roles do not grant portal or Operations access.");
  await expect(roles).toContainText("Craig Contact");
  await expect(roles).toContainText("Primary billing");
  await expect(roles).not.toContainText("Source version");
  await expect(roles.getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Business contacts", exact: true })).toContainText("Business Bailey");
  await expect(page.getByRole("heading", { name: "Portal logins", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("contact-role continuation preserves rows across transient and malformed failures and retries the same cursor", async ({ page }) => {
  let attempts = 0;
  const calls: URL[] = [];
  await mock(page, (route, collection) => route.fulfill({ json: reply(collection) }), () => detailWithContactRoles([
    contactRole("Craig Contact", "athletic_director")], true), async (route, url) => {
      calls.push(url); attempts += 1;
      if (attempts === 1) return route.fulfill({ status: 503, json: { error: "Contact roles temporarily unavailable" } });
      if (attempts === 2) return route.fulfill({ json: contactRolePage([contactRole("Unverified Contact")], true, "roles-page-2") });
      return route.fulfill({ json: contactRolePage([contactRole("Steve Contact", "head_coach")]) });
    });
  await open(page);
  const roles = page.getByRole("region", { name: "Project Alpha contact roles", exact: true });
  await roles.getByRole("button", { name: "Load more contact roles", exact: true }).click();
  await expect(roles.getByRole("alert")).toContainText("Contact roles temporarily unavailable");
  await expect(roles).toContainText("Craig Contact");
  await roles.getByRole("button", { name: "Retry contact roles", exact: true }).click();
  await expect(roles.getByRole("alert")).toContainText("could not be verified");
  await expect(roles).not.toContainText("Unverified Contact");
  await roles.getByRole("button", { name: "Retry contact roles", exact: true }).click();
  await expect(roles).toContainText("Steve Contact");
  await expect(roles.getByRole("status")).toHaveText("2 role assignments shown");
  await expect(roles.getByRole("button")).toHaveCount(0);
  expect(calls.map(url => [url.searchParams.get("cursor"), url.searchParams.get("limit"), url.searchParams.get("expectedContextVersion")]))
    .toEqual(Array.from({ length: 3 }, () => ["roles-page-2", "25", "context-1"]));
});

for (const status of [401, 403, 404, 409]) {
  test(`contact-role continuation ${status} invalidates the complete client workspace`, async ({ page }) => {
    await mock(page, (route, collection) => route.fulfill({ json: reply(collection) }),
      () => detailWithContactRoles([contactRole("Protected Contact")], true),
      route => route.fulfill({ status, json: { error: "Contact-role authority changed" } }));
    await open(page);
    const roles = page.getByRole("region", { name: "Project Alpha contact roles", exact: true });
    await roles.getByRole("button", { name: "Load more contact roles", exact: true }).click();
    await expect(page.getByRole("button", { name: "Refresh client workspace", exact: true })).toBeVisible();
    await expect(page.locator(".client-hub-detail-grid")).toHaveCount(0);
    await expect(page.getByText("Protected Contact", { exact: true })).toHaveCount(0);
  });
}

test("client navigation aborts a pending contact-role page and fences its late response", async ({ page }) => {
  let pending: Route | undefined;
  await mock(page, (route, collection) => route.fulfill({ json: reply(collection) }), count => {
    if (count === 1) return detailWithContactRoles([contactRole("Previous Contact")], true);
    const response = detail(2) as ReturnType<typeof detail> & { projectAlphaContactRolesAvailable: boolean; projectAlphaContactRoles: unknown };
    response.client.public_id = "43"; response.client.detail_path = canonicalPath.replace("/42", "/43");
    response.projectAlphaContactRolesAvailable = true;
    response.projectAlphaContactRoles = { ...contactRolePage([contactRole("Current Contact")], false, null, "context-2"),
      canonicalRoot: { ...canonicalRoot, publicId: "43" } };
    return response;
  }, async route => { pending = route; });
  await open(page);
  await page.getByRole("region", { name: "Project Alpha contact roles", exact: true })
    .getByRole("button", { name: "Load more contact roles", exact: true }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.evaluate(path => { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")); }, canonicalPath.replace("/42", "/43"));
  await expect(page.getByRole("heading", { name: "Acme refreshed" })).toBeVisible();
  const current = page.getByRole("region", { name: "Project Alpha contact roles", exact: true });
  await expect(current).toContainText("Current Contact");
  await lateFulfill(pending!, contactRolePage([contactRole("Stale Contact")]));
  await expect(current).not.toContainText("Stale Contact");
  await expect(current.getByRole("status")).toHaveText("1 role assignment shown");
});

test("detail pages each non-identity collection independently using the canonical response root", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const state = await mock(page, (route, collection) => route.fulfill({ json: reply(collection) }));
  await open(page, "/clients/organizations/42?q=acme&kind=organization");
  await expect(page.getByRole("link", { name: "← Client Hub" })).toHaveAttribute("href", "/clients?q=acme&kind=organization");
  await expect(page.getByRole("heading", { name: "Business contacts", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Portal logins", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Block portal sign-in" })).toHaveCount(1);
  await expect(page.getByText("These sections show work shared with this client. Full business project history is separate.")).toBeVisible();
  for (const collection of collections) {
    await loadButton(page, collection).click();
    await expect(region(page, collection).getByRole("status")).toHaveText("2 shown");
    await expect(region(page, collection).getByRole("button", { name: `All ${labels[collection].toLowerCase()} loaded` })).toHaveAttribute("aria-disabled", "true");
  }
  await expect(page.getByRole("button", { name: "Block portal sign-in" })).toHaveCount(1);
  expect(state.detailCalls()).toBe(1);
  const continuations = state.requests.filter(url => url.pathname.includes("/collections/"));
  expect(continuations).toHaveLength(7);
  for (const url of continuations) {
    expect(url.pathname).toMatch(new RegExp(`^${canonicalApi}/collections/`));
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("cursor")).toMatch(/-page-2$/);
  }
  expect(errors).toEqual([]);
});

test("overlapping pages deduplicate records without merging distinct account grants", async ({ page }) => {
  const first = detail();
  const project = { ...item("projects", 1), row_key: "", account_id: "account-one" };
  const delivery = { ...item("deliveryGrants", 1), row_key: "", account_id: "account-one" };
  first.projects = [project]; first.deliveryGrants = [delivery];
  const errors: string[] = [];
  page.on("console", message => { if (/same key/i.test(message.text())) errors.push(message.text()); });
  await mock(page, (route, collection) => {
    const initial = collection === "projects" ? project : delivery;
    return route.fulfill({ json: reply(collection, [initial, { ...initial, account_id: "account-two" }]) });
  }, () => first);
  await open(page);
  await loadButton(page, "projects").click();
  await expect(region(page, "projects").getByText("Shared project 1", { exact: true })).toHaveCount(2);
  await expect(region(page, "projects").getByRole("status")).toHaveText("2 shown");
  await loadButton(page, "deliveryGrants").click();
  await expect(region(page, "deliveryGrants").getByText("Delivery link 1", { exact: true })).toHaveCount(2);
  await expect(region(page, "deliveryGrants").getByRole("status")).toHaveText("2 shown");
  expect(errors).toEqual([]);
});

test("business contact channels display separately from portal logins on initial and continued pages", async ({ page }) => {
  const first = detail();
  first.contacts = [businessContact("business-one", "Business Bailey"),
    { ...businessContact("missing-details", "Missing details"), email: null, phone: null }];
  const state = await mock(page, (route, collection) => route.fulfill({ json: reply(collection) }), () => first);
  await open(page);
  const contacts = region(page, "businessContacts");
  await expect(contacts).toContainText("Email: business-one@example.test");
  await expect(contacts).toContainText("Phone: +1 (920) 555-0101 ext. 4");
  await expect(contacts).toContainText("No contact details provided by Project Alpha");
  await expect(contacts).toContainText("Contact records do not grant portal access");
  await expect(contacts.getByRole("button", { name: /block|invite|grant/i })).toHaveCount(0);
  await loadButton(page, "businessContacts").click();
  await expect(contacts).toContainText("Email: businessContacts-2@example.test");
  await expect(page.getByRole("button", { name: "Block portal sign-in" })).toHaveCount(1);
  expect(state.requests.filter(url => url.pathname.includes("/eligibility-blocks"))).toEqual([]);
});

test("a transient section failure preserves other pages and retries the same cursor", async ({ page }) => {
  let tries = 0;
  const state = await mock(page, (route, collection) => {
    if (collection === "requests" && ++tries === 1) return route.fulfill({ status: 503, json: { error: "Requests temporarily unavailable" } });
    return route.fulfill({ json: reply(collection) });
  });
  await open(page);
  await loadButton(page, "projects").click();
  await expect(region(page, "projects").getByText("Shared project 2")).toBeVisible();
  await loadButton(page, "requests").click();
  await expect(region(page, "requests").getByRole("alert")).toContainText("Requests temporarily unavailable");
  await expect(region(page, "projects").getByText("Shared project 2")).toBeVisible();
  await expect(region(page, "requests").getByText("Service request 1")).toBeVisible();
  await region(page, "requests").getByRole("button", { name: "Retry requests", exact: true }).click();
  await expect(region(page, "requests").getByText("Service request 2")).toBeVisible();
  expect(state.detailCalls()).toBe(1);
  expect(state.requests.filter(url => url.pathname.endsWith("/collections/requests")).map(url => url.searchParams.get("cursor"))).toEqual(["requests-page-2", "requests-page-2"]);
});

test("rapid clicks claim one continuation and keyboard focus stays on its action", async ({ page }) => {
  let pending: Route | undefined;
  let calls = 0;
  await mock(page, async route => { calls += 1; pending = route; });
  await open(page);
  const button = loadButton(page, "projects");
  await button.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => calls).toBe(1);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  expect(calls).toBe(1);
  const busy = region(page, "projects").getByRole("button", { name: "Loading shared projects…" });
  await expect(busy).toBeFocused();
  await lateFulfill(pending!, reply("projects"));
  const complete = region(page, "projects").getByRole("button", { name: "All shared projects loaded" });
  await expect(complete).toBeFocused();
  await expect(complete).toHaveAttribute("aria-disabled", "true");
});

for (const failure of [401, 403, 404, 409, "context", "root", "permission"] as const) {
  test(`continuation ${failure} clears the entire workspace and fences other late responses`, async ({ page }) => {
    let pending: Route | undefined;
    const state = await mock(page, async (route, collection) => {
      if (collection === "projects") { pending = route; return; }
      if (typeof failure === "number") return route.fulfill({ status: failure, json: { error: "Client access changed" } });
      const response = reply(collection);
      if (failure === "context") response.contextVersion = "another-context";
      if (failure === "root") response.canonicalRoot = { ...canonicalRoot, publicId: "another-root" };
      if (failure === "permission") response.page = { ...response.page, available: false, reason: "permission_required" };
      return route.fulfill({ json: response });
    }, count => detail(count));
    await open(page);
    await loadButton(page, "projects").click();
    await expect.poll(() => Boolean(pending)).toBe(true);
    await loadButton(page, "requests").click();
    await expect(page.getByRole("button", { name: "Refresh client workspace", exact: true })).toBeVisible();
    await expect(page.locator(".client-hub-detail-grid")).toHaveCount(0);
    await expect(page.getByText("Business Bailey", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Portal logins" })).toHaveCount(0);
    await lateFulfill(pending!, reply("projects"));
    await expect(page.getByText("Shared project 2", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Refresh client workspace", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Acme refreshed" })).toBeVisible();
    await expect(region(page, "projects").getByRole("status")).toHaveText("1 shown");
    expect(state.detailCalls()).toBe(2);
  });
}

test("navigating to another client aborts pending sections and never appends old client data", async ({ page }) => {
  let pending: Route | undefined;
  await mock(page, async route => { pending = route; }, count => {
    const response = detail(count);
    if (count > 1) { response.client.public_id = "43"; response.client.detail_path = canonicalPath.replace("/42", "/43"); }
    return response;
  });
  await open(page);
  await loadButton(page, "projects").click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.evaluate(path => { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")); }, canonicalPath.replace("/42", "/43"));
  await expect(page.getByRole("heading", { name: "Acme refreshed" })).toBeVisible();
  await lateFulfill(pending!, reply("projects"));
  await expect(region(page, "projects").getByText("Shared project 2", { exact: true })).toHaveCount(0);
  await expect(region(page, "projects").getByRole("status")).toHaveText("1 shown");
});

test("an identity mutation refreshes all loaded sections and aborts pending old-context pages", async ({ page }) => {
  page.on("dialog", dialog => dialog.accept());
  let pending: Route | undefined;
  const state = await mock(page, async (route, collection) => {
    if (collection === "projects") { pending = route; return; }
    return route.fulfill({ json: reply(collection) });
  }, count => detail(count));
  await open(page);
  await loadButton(page, "accounts").click();
  await expect(region(page, "accounts").getByText("Account 2")).toBeVisible();
  await loadButton(page, "projects").click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByRole("button", { name: "Block portal sign-in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Acme refreshed" })).toBeVisible();
  await lateFulfill(pending!, reply("projects"));
  await expect(region(page, "accounts").getByText("Account 2", { exact: true })).toHaveCount(0);
  await expect(region(page, "projects").getByText("Shared project 2", { exact: true })).toHaveCount(0);
  expect(state.detailCalls()).toBe(2);
});

test("unavailable or missing collection metadata never invents continuation", async ({ page }) => {
  let collectionCalls = 0;
  const first = detail();
  first.pages.businessContacts = { ...metadata("businessContacts", false), available: false, reason: "not_applicable" };
  first.pages.authenticatedDeliveryGrants = { ...metadata("authenticatedDeliveryGrants", false), available: false, reason: "workspace_unavailable" };
  first.pages.requests = { ...metadata("requests", false), available: false, reason: "permission_required" };
  await mock(page, async route => { collectionCalls += 1; return route.fulfill({ status: 500 }); }, count => {
    if (count === 1) return first;
    const { pages: _pages, contextVersion: _contextVersion, ...legacy } = detail(count);
    return legacy;
  });
  await open(page);
  await expect(region(page, "businessContacts")).toContainText("does not apply");
  await expect(region(page, "authenticatedDeliveryGrants")).toContainText("verified portal workspace");
  await expect(region(page, "requests")).toContainText("Permission is required");
  for (const collection of ["businessContacts", "authenticatedDeliveryGrants", "requests"] as const) await expect(region(page, collection).getByRole("button")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Acme refreshed" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Load more / })).toHaveCount(0);
  await expect(region(page, "projects").getByText("Shared project 1")).toBeVisible();
  expect(collectionCalls).toBe(0);
});

test("populated detail remains readable on mobile, narrow, laptop and ultrawide layouts", async ({ page }, testInfo) => {
  const response = detail();
  response.client.display_name = "Acme Construction Services — Regional Property Management";
  response.contacts[0]!.email = "long-business-contact-address@construction-services.example.test";
  response.contacts = [response.contacts[0]!, ...[2, 3, 4, 5].map(index => businessContact(`business-${index}`, `Business contact ${index}`))];
  for (const collection of collections) {
    response.pages[collection]!.returned = 5;
    if (collection !== "businessContacts") response[collection] = [1, 2, 3, 4, 5].map(index => item(collection, index));
  }
  const longGrant = item("deliveryGrants", 1) as ReturnType<typeof item> & { r2_prefix: string };
  longGrant.r2_prefix = "clients/acme-construction-services/municipal-projects/2026/edited-originals/final-approved-delivery/";
  response.deliveryGrants[0] = longGrant;
  await mock(page, (route, collection) => route.fulfill({ json: reply(collection) }), () => response);
  await page.goto(canonicalPath);
  await expect(page.getByRole("heading", { name: response.client.display_name })).toBeVisible();
  for (const width of [375, 640, 1280, 3440]) {
    await page.setViewportSize({ width, height: 960 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect.poll(() => page.locator(".client-hub-detail-grid").evaluate(element =>
      getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length)).toBe(1);
    for (const collection of collections) {
      const button = loadButton(page, collection);
      await button.scrollIntoViewIfNeeded();
      const bounds = await button.boundingBox();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    }
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`client-detail-${width}.png`) });
    await page.screenshot({ path: testInfo.outputPath(`client-detail-${width}-full.png`), fullPage: true });
  }
});

test("grant badges respect UTC expiry while preserving revoked or inactive status", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-08-25T12:00:00Z"));
  const value = detail();
  const cases = [
    { label: "past", expiry: "2026-08-25 11:59:59", status: "active", expected: "expired" },
    { label: "boundary", expiry: "2026-08-25T12:00:00Z", status: "active", expected: "expired" },
    { label: "future", expiry: "2026-08-25 12:00:01", status: "active", expected: "active" },
    { label: "no-expiry", expiry: null, status: "active", expected: "active" },
    { label: "revoked", expiry: "2020-01-01T00:00:00Z", status: "revoked", expected: "revoked" },
    { label: "invalid", expiry: "not-a-timestamp", status: "active", expected: "Expiry not verified" },
    { label: "blank", expiry: "", status: "active", expected: "Expiry not verified" },
  ];
  for (const collection of ["deliveryGrants", "authenticatedDeliveryGrants", "viewerGrants"] as const) {
    value[collection] = cases.map((entry, index) => ({ ...item(collection, index), label: entry.label, model_title: entry.label, r2_prefix: entry.label,
      status: entry.status, expires_at: entry.expiry, authorization_expires_at: entry.expiry, revoked_at: entry.status === "revoked" ? "2026-08-01T12:00:00Z" : null }));
    value.pages[collection] = { ...metadata(collection, false), returned: cases.length };
  }
  value.authenticatedDeliveryGrants.push({ ...item("authenticatedDeliveryGrants", 99), r2_prefix: "inactive", status: "inactive", expires_at: "2020-01-01T00:00:00Z" });
  value.viewerGrants.push({ ...item("viewerGrants", 99), model_title: "inactive", status: "inactive", authorization_expires_at: "2020-01-01T00:00:00Z" });
  await mock(page, route => route.fulfill({ status: 500 }), () => value);
  await open(page);
  for (const collection of ["deliveryGrants", "authenticatedDeliveryGrants", "viewerGrants"] as const) {
    for (const entry of cases) {
      const row = region(page, collection).locator(".simple-rows > div").filter({ has: page.locator("strong", { hasText: new RegExp(`^${entry.label}$`) }) });
      await expect(row.locator(".status-pill")).toHaveText(entry.expected);
      if (entry.label === "invalid" || entry.label === "blank") await expect(row.getByText(/No expiry/)).toHaveCount(0);
    }
    if (collection !== "deliveryGrants") await expect(region(page, collection).locator(".simple-rows > div").filter({ has: page.locator("strong", { hasText: /^inactive$/ }) }).locator(".status-pill")).toHaveText("inactive");
  }
});
