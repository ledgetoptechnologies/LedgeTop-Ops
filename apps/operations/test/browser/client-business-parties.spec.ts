import { expect, test, type Page, type Route } from "@playwright/test";

const primary = "project-alpha:primary", secondary = "project-alpha:business_b", third = "project-alpha:third";
const apiBase = "/api/business-parties", partyId = "party-reviewed";
const capabilities = { directory: true, requests: false, delivery: false, viewer: false };
interface Root { sourceId: string; kind: "organization"; recordId: string }
interface Member { linkId: string | null; root: Root; displayName: string; sourceName: string; detailPath: string | null; availability: "available" | "unavailable" }
type Operation = { action: "create"; roots: Root[]; displayName: string } | { action: "add"; partyId: string; expectedVersion: number; root: Root }
  | { action: "unlink"; partyId: string; expectedVersion: number; linkId: string };
const roots: Root[] = [primary, secondary, third].map(sourceId => ({ sourceId, kind: "organization", recordId: "42" }));
const sourceName = (source: string) => source === primary ? "Drone Services" : source === secondary ? "Technologies" : "Third business";
const recordName = (source: string) => source === primary ? "Acme aerial customer" : source === secondary ? "Acme technology customer" : "Acme third record";
const sourcePath = (root: Root) => `/clients/sources/${encodeURIComponent(root.sourceId)}/business/organizations/${root.recordId}`;
const member = (root: Root, linked = true): Member => ({ root, linkId: linked ? `link-${root.sourceId}` : null,
  displayName: recordName(root.sourceId), sourceName: sourceName(root.sourceId), detailPath: sourcePath(root), availability: "available" });
const summary = (root: Root) => ({ workspace_id: null, kind: root.kind, route_kind: "organizations", public_id: root.recordId,
  display_name: recordName(root.sourceId), status: "active", portal_status: "not_supported", account_count: 1, project_count: 99,
  request_count: 17, contact_count: 21, detail_path: sourcePath(root), source_id: root.sourceId, source_name: sourceName(root.sourceId),
  root_namespace: "business", pa_public_id: null });
type Call = { path: string; query: URLSearchParams; method: string; body: Record<string, unknown> | null; csrf?: string };
type Handler = (route: Route, call: Call) => Promise<boolean>;
async function fixture(page: Page, options: { linked?: number; manage?: boolean; handler?: Handler; label?: string; rootCount?: number;
  contactsPage?: boolean; projectsUnavailableSource?: string; archived?: "source_unavailable" | "operator_closed" } = {}) {
  const state = { members: roots.slice(0, options.linked || 0).map(root => member(root)), version: 1,
    name: options.label || "Acme combined customer", status: options.archived ? "archived" : "active",
    archiveCause: options.archived ?? null as "source_unavailable" | "operator_closed" | null, calls: [] as Call[] };
  const manage = options.manage !== false, activeRoots = roots.slice(0, options.rootCount || 3);
  const party = () => ({ id: partyId, displayName: state.name, kind: "organization", version: state.version, status: state.status,
    lifecycleOrigin: "source_backed", archiveCause: state.archiveCause, archivedAt: state.status === "archived" ? "2026-08-30T12:00:00Z" : null,
    members: state.members, canManage: manage });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path === "/api/session") return route.fulfill({ json: { user: { id: "staff-a", email: "staff@example.test", displayName: "Staff", status: "Active",
      profileType: manage ? "Administrator" : "Employee", isAdministrator: manage, permissions: ["team.view", ...(manage ? ["team.manage"] : [])], divisions: [] },
      csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    const call: Call = { path, query: url.searchParams, method: request.method(), body: request.postData() ? request.postDataJSON() : null, csrf: request.headers()["x-csrf-token"] };
    state.calls.push(call);
    if (options.handler && await options.handler(route, call)) return;
    const sourceMember = state.members.find(row => row.linkId
      && path === `${apiBase}/${partyId}/sources/${encodeURIComponent(row.linkId)}`);
    if (sourceMember) {
      const base = sourcePath(sourceMember.root);
      const projectsAvailable = options.projectsUnavailableSource !== sourceMember.root.sourceId;
      return route.fulfill({ json: {
        partyId, partyVersion: state.version, member: sourceMember,
        canonicalRoot: { sourceId: sourceMember.root.sourceId, rootNamespace: "business", kind: sourceMember.root.kind, publicId: sourceMember.root.recordId },
        contextVersion: `source-${sourceMember.root.sourceId}`,
        source: { portalStatus: sourceMember.root.sourceId === primary ? "active" : "not_supported", mappingStatus: "mapped",
          workspaceAvailable: sourceMember.root.sourceId === primary, capabilities },
        projects: { items: projectsAvailable ? [{ row_key: `project:${sourceMember.root.sourceId}`, id: `project-${sourceMember.root.sourceId}`,
          name: `${sourceName(sourceMember.root.sourceId)} project`, status: "active", start_date: null, end_date: null, manager_name: null }] : [],
          page: { available: projectsAvailable, reason: projectsAvailable ? null : "permission_required",
            nextCursor: projectsAvailable ? "more-projects" : null, hasMore: projectsAvailable, returned: projectsAvailable ? 1 : 0, limit: 5 } },
        contacts: { items: [{ row_key: `contact:${sourceMember.root.sourceId}`, public_id: `contact-${sourceMember.root.sourceId}`,
          display_name: `${sourceName(sourceMember.root.sourceId)} contact`, email: `${sourceMember.root.sourceId.split(":").at(-1)}@example.test`, phone: null }],
          page: { available: true, reason: null, nextCursor: null, hasMore: false, returned: 1, limit: 5 } },
        entryPoints: { source: base, projects: `${base}#client-business-projects`, contacts: `${base}#client-business-contacts`,
          access: `${base}#client-portal-access`, delivery: `${base}#client-delivery-access`, audit: `${base}#client-audit` },
      } });
    }
    if (path === "/api/client-hub") {
      const records = activeRoots.map(root => ({ ...summary(root), ...(state.members.some(row => row.root.sourceId === root.sourceId) ? {
        business_party_id: partyId, business_party_name: state.name, business_party_member_count: state.members.length,
      } : {}) }));
      const q = (url.searchParams.get("q") || "").toLowerCase();
      let clients = records.filter(row => (!q || row.display_name.toLowerCase().includes(q))
        && (!url.searchParams.get("source") || row.source_id === url.searchParams.get("source")));
      if (url.searchParams.get("grouping") !== "records" && state.members.length) {
        const matching = clients.find(row => "business_party_id" in row);
        clients = clients.filter(row => !("business_party_id" in row));
        if (matching) clients.unshift({ ...matching, detail_path: `/clients/parties/${partyId}` });
      }
      return route.fulfill({ json: { clients, nextCursor: null, capabilities, sources: activeRoots.map(root => ({ source_id: root.sourceId, display_name: sourceName(root.sourceId) })) } });
    }
    if (path.endsWith("/organization-operational-contacts")) {
      const root = roots.find(row => `/api/client-hub${sourcePath(row).slice("/clients".length)}/organization-operational-contacts` === path);
      if (!root) return route.fulfill({ status: 404, json: { error: "Source record unavailable" } });
      return route.fulfill({ json: { canonicalRoot: { sourceId: root.sourceId, rootNamespace: "business", kind: root.kind, publicId: root.recordId },
        contextVersion: `source-${root.sourceId}`, organization: { id: root.recordId, sourceId: root.sourceId, revision: "organization-r1" },
        contacts: { version: 0, assignments: [], revisions: [] }, capabilities: { canManageOrganizationContacts: false }, contactOptions: [],
        contactPage: { available: true, reason: null, nextCursor: null, hasMore: false, returned: 0, limit: 25 } } });
    }
    if (path.startsWith("/api/client-hub/sources/")) {
      const root = roots.find(row => `/api/client-hub${sourcePath(row).slice("/clients".length)}` === path);
      if (!root) return route.fulfill({ status: 404, json: { error: "Source record unavailable" } });
      return route.fulfill({ json: { client: summary(root), contacts: [], accounts: [], projects: [], requests: [], deliveryGrants: [], authenticatedDeliveryGrants: [], viewerGrants: [],
        ...(options.contactsPage ? { pages: { businessContacts: { available: true, reason: null, nextCursor: "contacts-more", hasMore: true, returned: 0, limit: 5 } } } : {}),
        contextVersion: `source-${root.sourceId}`, businessParty: state.members.some(row => row.root.sourceId === root.sourceId)
          ? { id: partyId, displayName: state.name, version: state.version, canManage: manage } : null, canManageBusinessParties: manage,
        portalIdentities: { items: [], page: { available: false, reason: "workspace_unavailable", nextCursor: null, hasMore: false, returned: 0, limit: 5 },
          contextVersion: `source-${root.sourceId}`, refreshedAt: "2026-08-25T12:00:00Z", capabilities: { canManagePortal: false, canManageEligibilityBlocks: false } }, capabilities } });
    }
    if (path === `${apiBase}/${partyId}` && call.method === "GET") return state.status === "archived" ? (manage
      ? route.fulfill({ json: { party: party() } }) : route.fulfill({ status: 404, json: { error: "Linked customer unavailable" } })) : state.members.length
      ? route.fulfill({ json: { party: party() } }) : route.fulfill({ status: 404, json: { error: "Linked customer unavailable" } });
    if (path === `${apiBase}/preview` && call.method === "POST") {
      const operation = call.body as unknown as Operation;
      const members = operation.action === "create" ? operation.roots.map(root => member(root, false))
        : operation.action === "add" ? [...state.members, member(operation.root, false)] : state.members.filter(row => row.linkId !== operation.linkId);
      const resultStatus = operation.action === "create" || operation.action === "add" ? "active"
        : members.length === 0 ? "archived" : state.status;
      return route.fulfill({ json: { preview: { action: operation.action, partyId: operation.action === "create" ? null : partyId,
        partyVersion: operation.action === "create" ? null : state.version, displayName: operation.action === "create" ? operation.displayName : state.name,
        kind: "organization", members, removedMember: operation.action === "unlink" ? state.members.find(row => row.linkId === operation.linkId) : null,
        resultStatus, contextVersion: "a".repeat(64) } } });
    }
    if (path === apiBase && call.method === "POST") {
      const operation = call.body!.operation as Operation;
      if (operation.action === "create") { state.name = operation.displayName; state.members = operation.roots.map(root => member(root)); state.archiveCause = null; }
      else if (operation.action === "add") { state.members.push(member(operation.root)); state.archiveCause = null; }
      else { state.members = state.members.filter(row => row.linkId !== operation.linkId); state.archiveCause = state.members.length ? state.archiveCause : "operator_closed"; }
      state.version += 1; state.status = state.members.length ? "active" : "archived";
      return route.fulfill({ json: { partyId, version: state.version, status: state.status, replayed: false } });
    }
    return route.fulfill({ status: 404, json: { error: `Unsupported fixture endpoint: ${path}` } });
  });
  return state;
}
async function createPreview(page: Page) {
  await page.goto(sourcePath(roots[0]!));
  await page.getByRole("button", { name: "Link another source record", exact: true }).click();
  await page.getByRole("searchbox", { name: "Find another business record" }).fill("Acme");
  await page.getByRole("button", { name: "Search records", exact: true }).click();
  await page.getByRole("button", { name: "Choose Acme technology customer", exact: true }).click();
  await page.getByLabel("Linked customer name", { exact: false }).fill("Acme combined customer");
  await page.getByRole("button", { name: "Preview link", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review customer link", exact: true })).toBeVisible();
}
async function confirm(page: Page, unlink = false) {
  await page.getByRole("checkbox", { name: unlink ? "I reviewed the record to unlink." : "I reviewed these records and confirm they represent the same customer." }).check();
  await page.getByRole("button", { name: unlink ? "Confirm unlink" : "Confirm customer link", exact: true }).click();
}

test("reviewed linking collapses records into one directory identity without merging access or losing source URLs", async ({ page }) => {
  const state = await fixture(page, { rootCount: 2 });
  await page.goto("/clients"); await expect(page.locator(".client-directory-card")).toHaveCount(2);
  await createPreview(page);
  await expect(page.getByRole("button", { name: "Confirm customer link" })).toBeDisabled();
  await expect(page.getByText(/Only the Client Hub grouping changes/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel review" }).click();
  expect(state.calls.filter(call => call.path === apiBase && call.method === "POST")).toHaveLength(0);
  await createPreview(page); await confirm(page);
  await expect(page).toHaveURL(`/clients/parties/${partyId}`);
  await expect(page.getByRole("heading", { name: "Acme combined customer", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Organization contacts", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open Technologies workspace" })).toHaveAttribute("href", sourcePath(roots[1]!));
  await page.getByRole("link", { name: "← Client Hub" }).click();
  await expect(page.locator(".client-directory-card")).toHaveCount(1);
  const card = page.getByRole("link", { name: "Open Acme combined customer client workspace" });
  await expect(card).toContainText("Linked customer · 2 business records");
  await expect(card.getByText("Shared projects", { exact: true })).toHaveCount(0);
  await expect(card.getByText("Portal unavailable for this source")).toHaveCount(0);
  const saves = state.calls.filter(call => call.path === apiBase && call.method === "POST");
  expect(saves).toHaveLength(1); expect(saves[0]!.csrf).toBe("csrf-test");
  expect((saves[0]!.body!.operation as Operation).action).toBe("create");
  expect(state.calls.some(call => /invitation|grant|quote|notifications/.test(call.path))).toBe(false);
});

test("opening the link picker suggests same-name records from another source without linking automatically", async ({ page }) => {
  const state = await fixture(page, { rootCount: 2 });
  await page.goto(sourcePath(roots[0]!));
  await page.getByRole("button", { name: "Link another source record", exact: true }).click();

  await expect(page.getByRole("searchbox", { name: "Find another business record" })).toHaveValue("Acme aerial customer");
  await expect(page.getByRole("combobox", { name: "Business source" })).toHaveValue(secondary);
  await expect(page.getByRole("button", { name: "Preview link", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Review customer link", exact: true })).toHaveCount(0);
  await expect.poll(() => state.calls.filter(call => call.path === "/api/client-hub" && call.query.get("grouping") === "records")
    .map(call => ({ q: call.query.get("q"), source: call.query.get("source") })))
    .toEqual([
      { q: "Acme aerial customer", source: null },
      { q: "Acme aerial customer", source: secondary },
    ]);
  expect(state.calls.filter(call => call.path === `${apiBase}/preview` || (call.path === apiBase && call.method === "POST"))).toHaveLength(0);
});

test("source workspaces, party links and directory filters survive refresh and browser history", async ({ page }) => {
  await fixture(page, { linked: 2 });
  await page.goto("/clients?q=Acme&kind=organization&source=project-alpha%3Abusiness_b&sort=name");
  await page.getByRole("link", { name: "Open Acme combined customer client workspace" }).click();
  await expect(page).toHaveURL(`/clients/parties/${partyId}?q=Acme&kind=organization&source=project-alpha%3Abusiness_b&sort=name`);
  await page.reload(); await page.getByRole("link", { name: "Open Technologies workspace" }).click();
  await expect(page.getByRole("heading", { name: "Acme technology customer", exact: true })).toBeVisible();
  const manageLink = page.getByRole("link", { name: "Manage customer links" });
  // Grid/flex items blockify the shared .button inline-flex display to flex.
  await expect(manageLink).toHaveClass(/(?:^|\s)button(?:\s|$)/);
  await expect(manageLink).toHaveCSS("display", "flex");
  await expect(manageLink).toHaveCSS("justify-content", "center");
  expect((await manageLink.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole("link", { name: "Acme combined customer", exact: true })).toHaveAttribute("href", `/clients/parties/${partyId}?q=Acme&kind=organization&source=project-alpha%3Abusiness_b&sort=name`);
  await page.reload(); await page.goBack();
  await expect(page.getByRole("region", { name: "Linked customer workspace" })).toBeVisible();
  await page.goBack(); await expect(page.getByRole("searchbox", { name: "Search clients" })).toHaveValue("Acme");
  await expect(page.getByRole("combobox", { name: "Sort clients" })).toHaveValue("name");
  await page.goForward(); await expect(page.getByRole("heading", { name: "Acme combined customer", exact: true })).toBeVisible();
});

test("linked customer progressively combines exact-source projects and contacts with refresh-safe section links", async ({ page }) => {
  const state = await fixture(page, { linked: 2 });
  await page.goto(`/clients/parties/${partyId}?q=acme&kind=organization#customer-projects`);
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(page.getByText("Drone Services project", { exact: true })).toBeVisible();
  await expect(page.getByText("Technologies project", { exact: true })).toBeVisible();
  await expect(page.getByText("Drone Services contact", { exact: true })).toBeVisible();
  await expect(page.getByText("Technologies contact", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Technologies projects" })).toHaveAttribute("href",
    `${sourcePath(roots[1]!)}?q=acme&kind=organization#client-business-projects`);
  await expect(page.getByRole("link", { name: "Activity and audit" })).toHaveCount(2);
  const sourceCalls = state.calls.filter(call => call.path.includes(`${apiBase}/${partyId}/sources/`));
  expect(sourceCalls).toHaveLength(2);
  expect(sourceCalls.map(call => call.query.get("expectedVersion"))).toEqual(["1", "1"]);
  await page.getByRole("link", { name: "Contacts", exact: true }).click();
  await expect(page).toHaveURL(new RegExp("#customer-contacts$"));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp("#customer-projects$"));
});

test("an unavailable source project page is not mislabeled as an empty project history", async ({ page }) => {
  await fixture(page, { linked: 2, projectsUnavailableSource: secondary });
  await page.goto(`/clients/parties/${partyId}#customer-projects`);
  const projects = page.locator("#customer-projects");
  await expect(projects.getByText("Projects are unavailable because your current role does not grant access.", { exact: true })).toBeVisible();
  await expect(projects.getByText("No projects are visible from this source.", { exact: true })).toHaveCount(0);
  await expect(projects.getByRole("link", { name: "Open Technologies projects" })).toHaveCount(0);
  await expect(projects.getByRole("link", { name: "Open Drone Services projects" })).toBeVisible();
});

test("add and unlink each require a fresh preview while keeping all source records", async ({ page }) => {
  const state = await fixture(page, { linked: 2 });
  await page.goto(`/clients/parties/${partyId}`);
  await page.getByRole("button", { name: "Link another source record", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Business source" })).toHaveValue(third);
  await expect(page.getByRole("combobox", { name: "Business source" }).locator("option")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Choose Acme aerial customer" })).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Find another business record" }).fill("Acme");
  await page.getByRole("button", { name: "Search records", exact: true }).click();
  await page.getByRole("button", { name: "Choose Acme third record" }).click();
  await page.getByRole("button", { name: "Preview link", exact: true }).click(); await confirm(page);
  const sourceRecordCount = page.getByRole("region", { name: "Linked customer workspace" })
    .locator("dt", { hasText: /^Source records$/ }).locator("..").locator("dd");
  await expect(sourceRecordCount).toHaveText("3");
  await page.getByRole("button", { name: "Unlink Technologies record" }).click();
  await expect(page.getByRole("heading", { name: "Record to unlink" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm unlink" })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel review" }).click();
  expect(state.members).toHaveLength(3);
  await page.getByRole("button", { name: "Unlink Technologies record" }).click(); await confirm(page, true);
  await expect(sourceRecordCount).toHaveText("2");
  await page.getByRole("link", { name: "← Client Hub" }).click();
  await expect(page.locator(".client-directory-card")).toHaveCount(2);
  await expect(page.getByRole("link", { name: "Open Acme technology customer client workspace" })).toBeVisible();
});

test("unlinking the final member keeps an administrator on the archived recovery page without deleting its source record", async ({ page }) => {
  await fixture(page, { linked: 1, rootCount: 1 });
  await page.goto(`/clients/parties/${partyId}`);
  await page.getByRole("button", { name: "Unlink Drone Services record" }).click();
  await expect(page.getByText(/No records will remain/)).toBeVisible(); await confirm(page, true);
  await expect(page).toHaveURL(`/clients/parties/${partyId}`);
  await expect(page.getByText("Archived after a reviewed unlink. A source returning will not reopen it; an administrator must review a new link.")).toBeVisible();
  const sourceSummary = page.locator(".business-party-summary div").filter({ hasText: "Source records" });
  await expect(sourceSummary.locator("dd")).toHaveText("0");
  await page.getByRole("link", { name: "← Client Hub" }).click();
  await expect(page.getByRole("link", { name: "Open Acme aerial customer client workspace" })).toBeVisible();
});

test("an unprivileged reader cannot open an archived party recovery page", async ({ page }) => {
  await fixture(page, { manage: false, archived: "operator_closed" });
  await page.goto(`/clients/parties/${partyId}`);
  await expect(page.getByRole("heading", { name: "Linked customer unavailable" })).toBeVisible();
  await expect(page.getByText("Archived after a reviewed unlink.", { exact: false })).toHaveCount(0);
});

test("read-only members have source links but no management or mutation probes", async ({ page }) => {
  const state = await fixture(page, { linked: 2, manage: false });
  await page.goto(`/clients/parties/${partyId}`);
  await expect(page.getByRole("link", { name: "Open Technologies workspace" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Unlink|Link another/ })).toHaveCount(0);
  await page.getByRole("link", { name: "Open Technologies workspace" }).click();
  await expect(page.getByRole("link", { name: "Acme combined customer", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Manage customer links" })).toHaveCount(0);
  expect(state.calls.filter(call => call.method !== "GET")).toEqual([]);
});

test("a conflict clears the old party and requires refresh and another explicit review", async ({ page }) => {
  let writes = 0;
  const state = await fixture(page, { linked: 2, handler: async (route, call) => {
    if (call.path === apiBase && ++writes === 1) { await route.fulfill({ status: 409, json: { error: "Business links changed. Refresh and review the preview again." } }); return true; }
    return false;
  } });
  await page.goto(`/clients/parties/${partyId}`);
  await page.getByRole("button", { name: "Unlink Technologies record" }).click(); await confirm(page, true);
  await expect(page.getByRole("alert")).toContainText("Business links changed");
  await expect(page.getByRole("link", { name: "Open Technologies workspace" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirm unlink" })).toHaveCount(0);
  expect(state.calls.filter(call => call.path === apiBase)).toHaveLength(1);
  await page.getByRole("button", { name: "Refresh linked customer" }).click();
  await page.getByRole("button", { name: "Unlink Technologies record" }).click();
  await expect(page.getByRole("button", { name: "Confirm unlink" })).toBeDisabled();
});

test("an uncertain mutation retries the exact idempotency body and cannot be double clicked", async ({ page }) => {
  let first: Route | null = null;
  const state = await fixture(page, { handler: async (route, call) => {
    if (call.path === apiBase && !first) { first = route; return true; } return false;
  } });
  await createPreview(page); await confirm(page);
  await expect(page.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await expect.poll(() => Boolean(first)).toBe(true);
  await first!.fulfill({ status: 503, json: { error: "Result could not be confirmed." } });
  await expect(page.getByText(/The result is not confirmed/)).toBeVisible();
  await page.getByRole("button", { name: "Retry same operation" }).click();
  await expect(page.getByRole("heading", { name: "Acme combined customer", exact: true })).toBeVisible();
  const saves = state.calls.filter(call => call.path === apiBase);
  expect(saves).toHaveLength(2); expect(saves[0]!.body).toEqual(saves[1]!.body);
});

test("candidate search is server-backed, paged and refuses same-source or already-linked records", async ({ page }) => {
  const state = await fixture(page, { handler: async (route, call) => {
    if (call.path !== "/api/client-hub" || call.query.get("grouping") !== "records") return false;
    const q = call.query.get("q"), cursor = call.query.get("cursor");
    await route.fulfill({ json: { clients: q === "technology" ? [summary(roots[1]!)] : cursor ? [summary(roots[0]!), { ...summary(roots[1]!), business_party_id: "another-party" }]
      : [], nextCursor: !q && !cursor ? "records-next" : null, capabilities } }); return true;
  } });
  await page.goto(sourcePath(roots[0]!)); await page.getByRole("button", { name: "Link another source record", exact: true }).click();
  await page.getByRole("searchbox", { name: "Find another business record" }).fill("");
  await page.getByRole("button", { name: "Search records", exact: true }).click();
  await expect(page.getByText("No records on this page. Continue checking for more.")).toBeVisible();
  await page.getByRole("button", { name: "Load more records" }).click();
  await expect(page.getByText("This source is already represented")).toBeVisible();
  await expect(page.getByText("Already part of a linked customer")).toBeVisible();
  await expect(page.getByRole("button", { name: /Choose Acme/ })).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Find another business record" }).fill("technology");
  await page.getByRole("button", { name: "Search records" }).click();
  await expect(page.getByRole("button", { name: "Choose Acme technology customer" })).toBeVisible();
  expect(state.calls.some(call => call.query.get("q") === "technology" && call.query.get("kind") === "organization" && call.query.get("grouping") === "records")).toBe(true);
});

test("a cancelled pending preview cannot resurface after navigating to the directory", async ({ page }) => {
  let delayed: Route | null = null;
  await fixture(page, { handler: async (route, call) => {
    if (call.path === `${apiBase}/preview`) { delayed = route; return true; } return false;
  } });
  await page.goto(sourcePath(roots[0]!)); await page.getByRole("button", { name: "Link another source record", exact: true }).click();
  await page.getByRole("searchbox", { name: "Find another business record" }).fill("Acme");
  await page.getByRole("button", { name: "Search records", exact: true }).click();
  await page.getByRole("button", { name: "Choose Acme technology customer" }).click(); await page.getByRole("button", { name: "Preview link" }).click();
  await expect.poll(() => Boolean(delayed)).toBe(true);
  await page.getByRole("button", { name: "Cancel review" }).click(); await page.getByRole("link", { name: "← Client Hub" }).click();
  await delayed!.fulfill({ json: { preview: { action: "create", partyId: null, partyVersion: null, displayName: "Old preview", kind: "organization",
    members: roots.slice(0, 2).map(root => member(root, false)), removedMember: null, resultStatus: "active", contextVersion: "a".repeat(64) } } }).catch(() => undefined);
  await expect(page.getByRole("heading", { name: "Review customer link" })).toHaveCount(0);
  await expect(page.locator(".client-directory-card")).toHaveCount(3);
});

for (const stage of ["preview", "mutation"] as const) test(`another section's authorization loss cancels a pending link ${stage}`, async ({ page }) => {
  let pending: Route | null = null;
  const state = await fixture(page, { contactsPage: true, handler: async (route, call) => {
    if (call.path.endsWith("/collections/businessContacts")) {
      await route.fulfill({ status: 403, json: { error: "Client access changed during review." } }); return true;
    }
    if (call.path === (stage === "preview" ? `${apiBase}/preview` : apiBase)) { pending = route; return true; }
    return false;
  } });
  await createPreview(page);
  if (stage === "mutation") await confirm(page);
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByRole("button", { name: "Load more business contacts", exact: true }).click();
  await expect(page.getByText("Client workspace needs refreshing", { exact: true })).toBeVisible();
  const response = stage === "mutation" ? { partyId, version: 1, status: "active", replayed: false }
    : { preview: { action: "create", partyId: null, partyVersion: null, displayName: "Obsolete review", kind: "organization",
      members: roots.slice(0, 2).map(root => member(root, false)), removedMember: null, resultStatus: "active", contextVersion: "a".repeat(64) } };
  await pending!.fulfill({ json: response }).catch(() => undefined);
  await expect(page).toHaveURL(sourcePath(roots[0]!));
  await expect(page.getByRole("region", { name: "Review customer link" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirm customer link" })).toHaveCount(0);
  expect(state.calls.filter(call => call.path === apiBase)).toHaveLength(stage === "mutation" ? 1 : 0);
});

test("a preview for different source records cannot be confirmed", async ({ page }) => {
  const state = await fixture(page, { handler: async (route, call) => {
    if (call.path !== `${apiBase}/preview`) return false;
    await route.fulfill({ json: { preview: { action: "create", partyId: null, partyVersion: null, displayName: "Wrong preview", kind: "organization",
      members: [member(roots[0]!, false), member(roots[2]!, false)], removedMember: null, resultStatus: "active", contextVersion: "a".repeat(64) } } }); return true;
  } });
  await createPreview(page);
  await expect(page.getByRole("alert")).toContainText("The link preview could not be verified");
  await expect(page.getByRole("button", { name: "Confirm customer link" })).toHaveCount(0);
  expect(state.calls.filter(call => call.path === apiBase)).toHaveLength(0);
});

test("initial failure offers retry and an authorization loss clears the entire party", async ({ page }) => {
  let reads = 0;
  await fixture(page, { linked: 2, handler: async (route, call) => {
    if (call.path === `${apiBase}/${partyId}` && ++reads === 1) { await route.fulfill({ status: 503, json: { error: "Customer links are preparing." } }); return true; }
    if (call.path === `${apiBase}/preview`) { await route.fulfill({ status: 403, json: { error: "Source access changed." } }); return true; }
    return false;
  } });
  await page.goto(`/clients/parties/${partyId}`); await expect(page.getByRole("alert")).toContainText("Customer links are preparing");
  await page.getByRole("button", { name: "Refresh linked customer" }).click();
  await page.getByRole("button", { name: "Unlink Technologies record" }).click();
  await expect(page.getByRole("alert")).toContainText("Source access changed");
  await expect(page.getByText("Acme combined customer", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open Drone Services workspace" })).toHaveCount(0);
});

test("grouped pagination uses party identity even when the server representative changes", async ({ page }) => {
  await fixture(page, { linked: 2, handler: async (route, call) => {
    if (call.path !== "/api/client-hub") return false;
    const more = call.query.has("cursor");
    await route.fulfill({ json: { clients: [{ ...summary(roots[more ? 1 : 0]!), business_party_id: partyId, business_party_name: "Acme combined customer",
      business_party_member_count: 2, detail_path: `/clients/parties/${partyId}` }], nextCursor: more ? null : "more", capabilities } }); return true;
  } });
  await page.goto("/clients"); await page.getByRole("button", { name: "Load more clients" }).click();
  await expect(page.locator(".client-directory-card")).toHaveCount(1);
});

test("a manager can review a redacted unavailable member without opening it or adding another source", async ({ page }) => {
  const redacted = { ...member(roots[1]!), displayName: "Unavailable source record", detailPath: null, availability: "unavailable" };
  await fixture(page, { linked: 2, handler: async (route, call) => {
    if (call.path === `${apiBase}/${partyId}`) {
      await route.fulfill({ json: { party: { id: partyId, displayName: "Acme combined customer", kind: "organization", version: 1,
        status: "active", lifecycleOrigin: "source_backed", archiveCause: null, archivedAt: null,
        canManage: true, needsReview: true, members: [member(roots[0]!), redacted] } } }); return true;
    }
    if (call.path === `${apiBase}/preview`) {
      await route.fulfill({ json: { preview: { action: "unlink", partyId, partyVersion: 1, displayName: "Acme combined customer", kind: "organization",
        members: [member(roots[0]!)], removedMember: redacted, resultStatus: "active", contextVersion: "a".repeat(64) } } }); return true;
    }
    return false;
  } });
  await page.goto(`/clients/parties/${partyId}`);
  await expect(page.getByText("Unavailable source record", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Technologies workspace" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Link another source record", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Unlink Technologies record" }).click();
  await expect(page.getByText("The original record is unavailable. Only its reviewed link will be removed.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm unlink" })).toBeDisabled();
});

test("a single visible source explains why linking is unavailable without an unbounded scan", async ({ page }) => {
  const state = await fixture(page, { rootCount: 1 });
  await page.goto(sourcePath(roots[0]!)); await page.getByRole("button", { name: "Link another source record", exact: true }).click();
  await expect(page.getByText(/No other visible business source is available for linking/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Choose Acme|Load more records/ })).toHaveCount(0);
  expect(state.calls.filter(call => call.query.get("grouping") === "records")).toHaveLength(1);
});

test("two unavailable members can be repaired one explicit unlink at a time", async ({ page }) => {
  const redact = (item: Member): Member => item.root.sourceId === primary ? item
    : { ...item, availability: "unavailable", displayName: "Unavailable source record", detailPath: null };
  const state = await fixture(page, { linked: 3, handler: async (route, call) => {
    const members = state.members.map(redact);
    if (call.path === `${apiBase}/${partyId}`) {
      await route.fulfill({ json: { party: { id: partyId, displayName: state.name, kind: "organization", version: state.version,
        status: "active", lifecycleOrigin: "source_backed", archiveCause: null, archivedAt: null,
        canManage: true, needsReview: members.some(item => item.availability === "unavailable"), members } } }); return true;
    }
    if (call.path === `${apiBase}/preview`) {
      const operation = call.body as unknown as Extract<Operation, { action: "unlink" }>;
      await route.fulfill({ json: { preview: { action: "unlink", partyId, partyVersion: state.version, displayName: state.name, kind: "organization",
        members: members.filter(item => item.linkId !== operation.linkId), removedMember: members.find(item => item.linkId === operation.linkId),
        resultStatus: "active", contextVersion: "a".repeat(64) } } }); return true;
    }
    return false;
  } });
  await page.goto(`/clients/parties/${partyId}`);
  await expect(page.getByText("Unavailable source record", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Unlink Technologies record" }).click();
  await expect(page.getByText("The original record is unavailable. It remains linked until separately reviewed and unlinked.")).toBeVisible();
  await confirm(page, true);
  await expect(page.getByRole("button", { name: "Link another source record", exact: true })).toBeDisabled();
  await expect(page.getByText("Unavailable source record", { exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Unlink Third business record" }).click(); await confirm(page, true);
  await expect(page.getByRole("button", { name: "Link another source record", exact: true })).toBeEnabled();
  await expect(page.getByText("Unavailable source record", { exact: true })).toHaveCount(0);
  expect(state.members).toHaveLength(1);
});

test("a pending party read cannot paint the previous customer after a route change", async ({ page }) => {
  let old: Route | null = null;
  await fixture(page, { linked: 2, handler: async (route, call) => {
    if (call.path === `${apiBase}/old-party`) { old = route; return true; } return false;
  } });
  await page.goto("/clients/parties/old-party"); await expect.poll(() => Boolean(old)).toBe(true);
  await page.getByRole("link", { name: "← Client Hub" }).click();
  await page.getByRole("link", { name: "Open Acme combined customer client workspace" }).click();
  await expect(page.getByRole("heading", { name: "Acme combined customer", exact: true })).toBeVisible();
  await old!.fulfill({ json: { party: { id: "old-party", displayName: "Obsolete customer", kind: "organization", version: 1,
    status: "active", lifecycleOrigin: "source_backed", archiveCause: null, archivedAt: null,
    canManage: true, members: roots.slice(0, 2).map(root => member(root)) } } }).catch(() => undefined);
  await expect(page.getByText("Obsolete customer", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Acme combined customer", exact: true })).toBeVisible();
});

test("linked customer and review layouts fit mobile, narrow, laptop and ultrawide screens", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await fixture(page, { linked: 2, label: `Acme ${"Long customer name ".repeat(6)}` });
  await page.goto(`/clients/parties/${partyId}`);
  for (const width of [375, 640, 1280, 3440]) {
    await page.setViewportSize({ width, height: 900 });
    const open = page.getByRole("link", { name: "Open Technologies workspace" });
    await expect(open).toBeVisible(); await open.focus(); await expect(open).toBeFocused();
    await expect(open).toHaveClass(/(?:^|\s)button(?:\s|$)/);
    await expect(open).toHaveCSS("display", "flex");
    await expect(open).toHaveCSS("align-items", "center");
    await expect(open).toHaveCSS("justify-content", "center");
    await expect(open).toHaveCSS("text-align", "center");
    await expect(open).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(open).toHaveCSS("text-decoration-line", "none");
    const buttonStyle = await open.evaluate(node => { const style = getComputedStyle(node); return {
      radius: Number.parseFloat(style.borderRadius), padding: Number.parseFloat(style.paddingInlineStart), weight: Number.parseFloat(style.fontWeight),
    }; });
    expect(buttonStyle.radius).toBeGreaterThan(0); expect(buttonStyle.padding).toBeGreaterThanOrEqual(12); expect(buttonStyle.weight).toBeGreaterThanOrEqual(700);
    expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const back = page.getByRole("link", { name: "← Client Hub" });
    await expect(back).toHaveCSS("justify-self", "start");
    await expect(back).toHaveClass(/(?:^|\s)button(?:\s|$)/);
    await expect(back).toHaveCSS("display", "flex");
    expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await back.boundingBox())!.width).toBeLessThan((await page.getByRole("region", { name: "Linked customer workspace" }).boundingBox())!.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`business-party-${width}.png`) });
  }
  await page.getByRole("button", { name: "Unlink Technologies record" }).click();
  await expect(page.getByRole("heading", { name: "Review unlink" })).toBeFocused();
  for (const width of [375, 640, 1280, 3440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    const label = page.getByRole("checkbox", { name: "I reviewed the record to unlink." });
    await expect(label).toBeVisible();
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`business-party-review-${width}.png`) });
  }
  expect(errors).toEqual([]);
});
