import { expect, test, type Page, type Route } from "@playwright/test";

const capabilities = { directory: true, requests: true, delivery: false, viewer: false };
function client(id: string, name: string, kind: "organization" | "standalone_client" = "organization", source = "project-alpha:primary",
  rootNamespace: "business" | "portal" | "account" = source === "delivery:local" ? "account" : "business") {
  const routeKind = kind === "organization" ? "organizations" : "standalone";
  return { workspace_id: rootNamespace === "portal" ? id : null, public_id: id, display_name: name, kind, route_kind: routeKind,
    root_namespace: rootNamespace, pa_public_id: rootNamespace === "portal" ? "a".repeat(32) : null,
    source_id: source, source_name: source === "delivery:local" ? "Delivery" : source === "project-alpha:primary" ? "Project Alpha" : source,
    detail_path: `/clients/sources/${encodeURIComponent(source)}/${rootNamespace}/${routeKind}/${encodeURIComponent(id)}`,
    status: "active", portal_status: rootNamespace === "portal" ? "active" : "not_provisioned", account_count: 0, project_count: 3,
    request_count: 1, contact_count: 2 };
}
type DirectoryHandler = (route: Route, url: URL) => Promise<unknown>;
async function mock(page: Page, directory: DirectoryHandler, permissions = ["team.view", "operations.manage"]) {
  const requested: URL[] = [];
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    requested.push(url);
    if (url.pathname === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-a", email: "staff@example.test", displayName: "Staff", status: "Active",
        profileType: "Employee", isAdministrator: false, permissions, divisions: [] },
      csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
    } });
    if (url.pathname === "/api/client-service-requests") return route.fulfill({ json: { requests: [{
      id: "request-one", title: "First request", account_name: "Acme", project_name: null,
      request_type: "service", details: "Please review the site.", status: "submitted", created_at: "2026-08-01T12:00:00Z",
    }] } });
    if (url.pathname === "/api/client-hub") return directory(route, url);
    if (/^\/api\/client-hub\/(sources|organizations|standalone)\//.test(url.pathname)) {
      const parts = url.pathname.split("/").filter(Boolean);
      const source = parts[2] === "sources" ? decodeURIComponent(parts[3]!) : "project-alpha:primary";
      const rootNamespace = parts.length === 7 ? parts[4] as "business" | "portal" | "account" : "business";
      const kind = parts.at(-2) === "standalone" ? "standalone_client" : "organization";
      return route.fulfill({ json: { client: client(decodeURIComponent(parts.at(-1)!), "Hidden customer", kind, source, rootNamespace), contacts: [], accounts: [],
        projects: [], requests: [], deliveryGrants: [], authenticatedDeliveryGrants: [], viewerGrants: [],
        contextVersion: "directory-detail", portalIdentities: { items: [], page: { available: rootNamespace === "portal", reason: rootNamespace === "portal" ? null : "workspace_unavailable",
          nextCursor: null, hasMore: false, returned: 0, limit: 5 }, contextVersion: "directory-detail", refreshedAt: "2026-08-25T12:00:00Z",
          capabilities: { canManageEligibilityBlocks: false, canManagePortal: false } }, capabilities,
      } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return requested;
}

test("matching business IDs from two producers retain source labels, contacts and project navigation without borrowing portal access", async ({ page }, testInfo) => {
  const errors: string[] = [], reads: URL[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && /same key/i.test(message.text())) errors.push(message.text()); });
  const roots = [client("42", "Primary business"), client("42", "Secondary business", "organization", "project-alpha:secondary")]
    .map(row => ({ ...row, pa_public_id: "a".repeat(32), account_count: 0, project_count: 0, request_count: 0,
      contact_count: 1, portal_status: row.source_id === "project-alpha:primary" ? "not_provisioned" : "not_supported" }));
  await mock(page, route => route.fulfill({ json: { clients: roots, nextCursor: null, capabilities } }));
  await page.route("**/api/client-hub/sources/**", route => {
    const url = new URL(route.request().url()); reads.push(url);
    const source = decodeURIComponent(url.pathname.split("/")[4]!);
    const root = roots.find(row => row.source_id === source);
    if (!root) return route.fulfill({ status: 404, json: { error: "Unknown source" } });
    const label = source === "project-alpha:primary" ? "Primary" : "Secondary";
    const project = { id: "9", row_key: `${source}:project:9`, name: `${label} project`, status: "active",
      start_date: null, end_date: null, created_at: null, manager: null, manager_name: null, manager_user_id: null, description: null };
    const contact = { id: "7", public_id: "7", contact_key: `${source}:7`, row_key: `${source}:contact:7`,
      record_type: "business_contact", organization_id: "42", display_name: `${label} contact`,
      email: `${label.toLowerCase()}@example.test`, phone: null, sourceField: "project.client_id" };
    if (url.pathname.endsWith("/business-projects/9")) return route.fulfill({ json: {
      canonicalRoot: { sourceId: source, rootNamespace: "business", kind: "organization", publicId: "42" },
      client: { display_name: root.display_name, detail_path: root.detail_path }, contextVersion: source, refreshedAt: "2026-08-25T12:00:00Z",
      project, linkedContact: contact,
      availability: { linkedContact: "available", siteContacts: "not_projected", billingContacts: "not_projected", projectMemory: "not_projected" },
    } });
    return route.fulfill({ json: { client: root, contacts: [contact], businessProjects: [project],
      accounts: [], projects: [], requests: [], deliveryGrants: [], authenticatedDeliveryGrants: [], viewerGrants: [],
      pages: { businessProjects: { available: true, reason: null, nextCursor: null, hasMore: false, returned: 1, limit: 5 } },
      portalIdentities: { items: [], page: { available: false, reason: "workspace_unavailable", nextCursor: null, hasMore: false, returned: 0, limit: 5 },
        contextVersion: source, refreshedAt: "2026-08-25T12:00:00Z", capabilities: { canManagePortal: false, canManageEligibilityBlocks: false } },
      contextVersion: source, capabilities,
    } });
  });
  await page.goto("/clients");
  await expect(page.locator(".client-directory-card")).toHaveCount(2);
  await expect(page.getByRole("link", { name: "Open Primary business client workspace" })).toContainText("Project Alpha");
  await expect(page.getByRole("link", { name: "Open Secondary business client workspace" })).toContainText("project-alpha:secondary");
  await expect(page.getByRole("link", { name: "Open Secondary business client workspace" })).toContainText("Portal unavailable for this source");
  await page.getByRole("link", { name: "Open Primary business client workspace" }).click();
  await expect(page.getByText("Primary contact", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Primary project", exact: true })).toHaveAttribute("href", roots[0]!.detail_path + "/projects/9");
  await page.goBack();
  await page.getByRole("link", { name: "Open Secondary business client workspace" }).click();
  await expect(page.getByText("Secondary contact", { exact: true })).toBeVisible();
  await expect(page.getByText("Primary contact", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Block portal sign-in|Invite|Grant access/ })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Secondary contact", { exact: true })).toBeVisible();
  const link = page.getByRole("link", { name: "Secondary project", exact: true });
  await expect(link).toHaveAttribute("href", roots[1]!.detail_path + "/projects/9");
  await link.click();
  await expect(page.getByRole("region", { name: "Business project workspace", exact: true }).getByRole("heading", { name: "Secondary project", exact: true })).toBeVisible();
  await expect(page.getByText("secondary@example.test", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Secondary contact", { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Secondary business", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.locator(".client-directory-card")).toHaveCount(2);
  await page.goForward();
  await expect(page.getByText("Secondary contact", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("secondary-client-source.png"), fullPage: true });
  expect(reads.some(url => url.pathname.includes("project-alpha%3Asecondary") && url.pathname.endsWith("/business-projects/9"))).toBe(true);
  expect(reads.some(url => /\/identities\/|\/grants\//.test(url.pathname))).toBe(false);
  expect(errors).toEqual([]);
});

test("directory loads bounded direct-link cards and appends pages without losing source or namespace identity", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && /same key/i.test(message.text())) errors.push(message.text()); });
  const first = [client("org-a", "Acme"), client("same", "Alpha individual", "standalone_client"),
    client("same", "Delivery individual", "standalone_client", "delivery:local"),
    client("same", "Portal individual", "standalone_client", "project-alpha:primary", "portal")];
  const requested = await mock(page, (route, url) => route.fulfill({ json: {
    clients: url.searchParams.has("cursor") ? [first[0], { ...client("org-b", "Birch"), portal_status: "mapping_conflict" }] : first,
    nextCursor: url.searchParams.has("cursor") ? null : "cursor-page-2", capabilities,
    indexUpdatedAt: "2026-08-25T12:00:00Z",
  } }));
  await page.goto("/clients");
  await expect(page.getByRole("heading", { name: "Pending review" })).toBeVisible();
  const requestSummary = page.locator(".client-hub-queue .client-request-review-list > article > div").first();
  await expect(requestSummary).toHaveCSS("display", "grid");
  const titleBounds = await requestSummary.locator("strong").boundingBox();
  const metadataBounds = await requestSummary.locator("small").first().boundingBox();
  expect(metadataBounds!.y).toBeGreaterThan(titleBounds!.y + titleBounds!.height);
  await expect(page.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".client-directory-card")).toHaveCount(4);
  await expect(page.locator(".client-directory-workspace time")).toHaveAttribute("datetime", "2026-08-25T12:00:00.000Z");
  await expect(page.getByText("This reflects directory synchronization, not client activity.", { exact: false })).toBeVisible();
  await expect(page.locator(".client-directory-workspace details")).toHaveCount(0);
  await expect(page.getByText("Shared projects", { exact: true })).toHaveCount(4);
  await expect(page.getByText("Contact records", { exact: true })).toHaveCount(4);
  await expect(page.getByText("Portal workspace · business link pending", { exact: true })).toBeVisible();
  await expect(page.getByText("Portal link not verified", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("link", { name: "Open Alpha individual client workspace" })).toHaveAttribute("href", first[1]!.detail_path);
  await expect(page.getByRole("link", { name: "Open Portal individual client workspace" })).toHaveAttribute("href", first[3]!.detail_path);
  await expect(page.getByRole("link", { name: "Open Acme client workspace" })).toHaveAttribute("href", first[0]!.detail_path);
  const queueBottom = await page.locator(".client-hub-queue").evaluate(node => node.getBoundingClientRect().bottom);
  const directoryTop = await page.getByRole("region", { name: "Client directory" }).evaluate(node => node.getBoundingClientRect().top);
  expect(directoryTop).toBeGreaterThan(queueBottom);
  await page.getByRole("button", { name: "Load more clients" }).click();
  await expect(page.locator(".client-directory-card")).toHaveCount(5);
  await expect(page.getByText("Portal link needs review", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more clients" })).toHaveCount(0);
  const calls = requested.filter(url => url.pathname === "/api/client-hub");
  expect(calls.map(url => url.searchParams.get("limit"))).toEqual(["24", "24"]);
  expect(calls[0]!.searchParams.has("kind")).toBe(false);
  expect(calls[1]!.searchParams.get("cursor")).toBe("cursor-page-2");
  expect(errors).toEqual([]);
});

test("server search finds unloaded clients and preserves query and kind through detail, refresh, and history", async ({ page }) => {
  const target = client("client/one%", "Hidden customer");
  const requested = await mock(page, (route, url) => route.fulfill({ json: {
    clients: url.searchParams.get("q") === "unloaded@example.test" ? [target] : [client("initial", "Initial customer")], capabilities,
  } }));
  await page.goto("/clients");
  await expect(page.getByText("Directory refreshed periodically.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Organizations", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search clients" }).fill("unloaded@example.test");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open Hidden customer client workspace" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Initial customer client workspace" })).toHaveCount(0);
  expect(requested.some(url => url.searchParams.get("q") === "unloaded@example.test" && url.searchParams.get("kind") === "organization")).toBe(true);
  const selectedUrl = page.url();
  await page.reload();
  await expect(page.getByRole("searchbox", { name: "Search clients" })).toHaveValue("unloaded@example.test");
  await expect(page.getByRole("button", { name: "Organizations", exact: true })).toHaveAttribute("aria-pressed", "true");
  const link = page.getByRole("link", { name: "Open Hidden customer client workspace" });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Hidden customer" })).toBeVisible();
  expect(requested.some(url => url.pathname === "/api/client-hub/sources/project-alpha%3Aprimary/business/organizations/client%2Fone%25")).toBe(true);
  expect(requested.some(url => url.pathname.includes("%252F"))).toBe(false);
  await expect(page.getByRole("link", { name: "← Client Hub" })).toHaveAttribute("href", new URL(selectedUrl).pathname + new URL(selectedUrl).search);
  await page.goBack();
  await expect(page).toHaveURL(selectedUrl);
  await expect(link).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("searchbox", { name: "Search clients" })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Organizations", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.goForward();
  await expect(page.getByRole("searchbox", { name: "Search clients" })).toHaveValue("unloaded@example.test");
  await link.click();
  await page.getByRole("link", { name: "← Client Hub" }).click();
  await expect(page).toHaveURL(selectedUrl);
  await link.click();
  await expect(page.getByRole("heading", { name: "Hidden customer" })).toBeVisible();
  if ((page.viewportSize()?.width || 0) <= 960)
    await page.getByRole("button", { name: "Open navigation" }).click();
  const navigation = page.getByRole("navigation", { name: (page.viewportSize()?.width || 0) <= 960 ? "Mobile primary navigation" : "Primary navigation", exact: true });
  await navigation.getByRole("link", { name: "Client Hub", exact: true }).click();
  await expect(page).toHaveURL(/\/clients$/);
  await expect(page.getByRole("searchbox", { name: "Search clients" })).toHaveValue("");
});

test("namespace routes stay explicit and older detail links remain refresh-safe", async ({ page }) => {
  const requested = await mock(page, route => route.fulfill({ json: { clients: [], capabilities } }));
  for (const path of [
    "/clients/sources/project-alpha%3Aprimary/portal/standalone/workspace%2Fone",
    "/clients/sources/delivery%3Alocal/account/standalone/account-one",
    "/clients/sources/project-alpha%3Aprimary/organizations/17",
    "/clients/standalone/23",
  ]) {
    await page.goto(`${path}?q=Acme&kind=organization`);
    await expect(page.getByRole("heading", { name: "Hidden customer" })).toBeVisible();
    expect(requested.some(url => url.pathname === path.replace("/clients/", "/api/client-hub/"))).toBe(true);
    await expect(page.getByRole("link", { name: "← Client Hub" })).toHaveAttribute("href", "/clients?q=Acme&kind=organization");
    if (path.includes("/portal/"))
      await expect(page.getByText("Portal workspace · business link pending", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Hidden customer" })).toBeVisible();
  }
});

test("search scope and verified legacy portal connections are represented honestly", async ({ page }) => {
  const legacy = { ...client("17", "Verified legacy client"), workspace_id: "legacy-workspace", portal_status: "active" };
  const unmapped = client("18", "Unmapped client");
  const portal = client("workspace-only", "Portal-only client", "standalone_client", "project-alpha:primary", "portal");
  await mock(page, route => route.fulfill({ json: { clients: [legacy, unmapped, portal], capabilities,
    searchCapabilities: { businessContacts: true, portalContacts: false }, nextCursor: null } }));
  await page.goto("/clients");
  const help = page.locator("#client-directory-search-help");
  await expect(help).toContainText("business contacts (name, email, phone)");
  await expect(help).toContainText("permitted project names");
  await expect(help).toContainText("Portal-only contact and login search is not available.");
  await expect(page.getByRole("searchbox", { name: "Search clients" })).toHaveAttribute("aria-describedby", "client-directory-search-help");
  const legacyCard = page.getByRole("link", { name: "Open Verified legacy client client workspace" });
  await expect(legacyCard.getByText("active", { exact: true })).toBeVisible();
  await expect(legacyCard.getByText("Portal link not verified")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open Unmapped client client workspace" }).getByText("Portal link not verified")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Portal-only client client workspace" }).getByText("Portal workspace · business link pending")).toBeVisible();
});

test("ambiguous legacy links surface the server conflict instead of guessing a namespace", async ({ page }) => {
  const requested = await mock(page, route => route.fulfill({ json: { clients: [], capabilities } }));
  await page.route(/\/api\/client-hub\/organizations\/ambiguous(?:\?|$)/, route => route.fulfill({ status: 409,
    json: { error: "This client link is ambiguous. Open the client from Client Hub." } }));
  await page.goto("/clients/organizations/ambiguous?q=Acme");
  await expect(page.getByText("This client link is ambiguous. Open the client from Client Hub.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Client Hub" })).toHaveAttribute("href", "/clients?q=Acme");
  expect(requested.some(url => url.pathname.startsWith("/api/client-hub/sources/"))).toBe(false);
});

test("a superseded server search cannot replace newer results", async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let slowStarted = false;
  await mock(page, async (route, url) => {
    const q = url.searchParams.get("q") || "Initial";
    if (q === "Slow") { slowStarted = true; await delayed; }
    await route.fulfill({ json: { clients: [client(q, `${q} customer`)], nextCursor: null, capabilities } }).catch(() => undefined);
  });
  await page.goto("/clients");
  await page.getByRole("searchbox", { name: "Search clients" }).fill("Slow");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect.poll(() => slowStarted).toBe(true);
  await page.getByRole("searchbox", { name: "Search clients" }).fill("Fast");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open Fast customer client workspace" })).toBeVisible();
  release();
  await expect(page.getByRole("link", { name: "Open Slow customer client workspace" })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "client" })).toContainText("Fast");
});

test("initial failures, stale continuations, and empty searches have recoverable states", async ({ page }) => {
  let initial = 0;
  const requested = await mock(page, (route, url) => {
    if (url.searchParams.get("q")) return route.fulfill({ json: { clients: [], nextCursor: null, capabilities } });
    if (url.searchParams.has("cursor")) return route.fulfill({ status: 409, json: { error: "Client directory changed. Refresh to load current clients." } });
    initial += 1;
    if (initial === 1) return route.fulfill({ status: 503, json: { error: "Directory is preparing. Retry shortly." } });
    return route.fulfill({ json: { clients: [client("org-a", "Acme")], nextCursor: initial === 2 ? "old-cursor" : null, capabilities } });
  });
  await page.goto("/clients");
  await expect(page.getByRole("alert")).toContainText("Directory is preparing");
  await expect(page.getByText("No clients yet")).toHaveCount(0);
  await page.getByRole("button", { name: "Retry clients" }).click();
  await expect(page.getByRole("link", { name: "Open Acme client workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Load more clients" }).click();
  await expect(page.getByRole("alert")).toContainText("Client directory changed");
  await expect(page.getByRole("link", { name: "Open Acme client workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Refresh clients" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(requested.filter(url => url.searchParams.get("cursor") === "old-cursor")).toHaveLength(1);
  await page.getByRole("searchbox", { name: "Search clients" }).fill("No match");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("No matching clients", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(page).toHaveURL(/\/clients$/);
  await expect(page.getByRole("link", { name: "Open Acme client workspace" })).toBeVisible();
});

test("directory cards fit mobile, laptop, and ultrawide layouts without fixed column counts", async ({ page }, testInfo) => {
  const clients = Array.from({ length: 12 }, (_, index) => client(`client-${index}`, `Organization ${index} ${"LongName".repeat(8)}`));
  await mock(page, route => route.fulfill({ json: { clients, nextCursor: null, capabilities } }));
  await page.goto("/clients");
  await expect(page.locator(".client-directory-card")).toHaveCount(12);
  let previousColumns = 0;
  for (const width of [375, 1280, 3440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const columns = await page.locator(".client-directory-grid").evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").length);
    expect(columns).toBeGreaterThanOrEqual(previousColumns);
    if (width === 375) expect(columns).toBe(1);
    if (width === 1280) expect(columns).toBeGreaterThan(1);
    previousColumns = columns;
    const card = page.locator(".client-directory-card").first();
    await card.focus();
    await expect(card).toBeFocused();
    const bounds = await card.boundingBox();
    expect(bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    await expect(page.getByRole("button", { name: "Individual Clients" })).toHaveCSS("min-height", "44px");
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`client-directory-${width}.png`) });
    await page.screenshot({ path: testInfo.outputPath(`client-directory-${width}-full.png`), fullPage: true });
  }
});

for (const status of [401, 403]) {
  test(`a ${status} continuation clears previously loaded client data`, async ({ page }) => {
    await mock(page, (route, url) => url.searchParams.has("cursor")
      ? route.fulfill({ status, json: { error: "Client-directory access is no longer available." } })
      : route.fulfill({ json: { clients: [client("org-a", "Acme")], nextCursor: "page-2", capabilities,
        indexUpdatedAt: "2026-08-25T12:00:00Z" } }));
    await page.goto("/clients");
    await expect(page.getByRole("link", { name: "Open Acme client workspace" })).toBeVisible();
    await page.getByRole("button", { name: "Load more clients" }).click();
    await expect(page.getByRole("alert")).toContainText("Client-directory access is no longer available.");
    await expect(page.locator(".client-directory-card")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Load more clients" })).toHaveCount(0);
    await expect(page.locator(".client-directory-workspace time")).toHaveCount(0);
  });
}

test("request-only staff do not fetch or render the client directory", async ({ page }) => {
  let calls = 0;
  await mock(page, route => { calls += 1; return route.fulfill({ json: { clients: [], capabilities } }); }, ["operations.manage"]);
  await page.goto("/clients");
  await expect(page.getByRole("heading", { name: "Pending review" })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search clients" })).toHaveCount(0);
  expect(calls).toBe(0);
});

test("malformed client identifiers show an error instead of crashing or double-decoding", async ({ page }) => {
  const requested = await mock(page, route => route.fulfill({ json: { clients: [], capabilities } }));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const path of [
    "/clients/sources/project-alpha%3Aprimary/business/organizations/bad%ZZ",
    "/clients/sources/project-alpha%3Aprimary/organizations/bad%ZZ",
    "/clients/sources/project-alpha%3Aprimary/unknown/organizations/17",
  ]) {
    await page.goto(path);
    await expect(page.getByText("This client link is invalid.")).toBeVisible();
  }
  expect(requested.some(url => url.pathname.startsWith("/api/client-hub/"))).toBe(false);
  expect(errors).toEqual([]);
});
