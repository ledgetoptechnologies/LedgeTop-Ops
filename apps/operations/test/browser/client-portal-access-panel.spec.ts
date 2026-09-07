import { expect, test, type Page, type Route } from "@playwright/test";
import type { PortalIdentityPage, PortalIdentitySummary, PortalPageMetadata } from "../../src/client/ClientPortalAccessPanel";

const path = "/clients/sources/project-alpha%3Aprimary/business/organizations/42";
const base = "/api/client-hub/sources/project-alpha%3Aprimary/business/organizations/42";
const rootContext = "root-context-one";
function metadata(more = false, cursor = "next-page", limit = 5, returned = 1): PortalPageMetadata {
  return { available: true, reason: null, nextCursor: more ? cursor : null, hasMore: more, returned, limit };
}
function identity(id: string, name: string, overrides: Partial<PortalIdentitySummary> = {}): PortalIdentitySummary {
  return { workspace_id: "workspace-one", public_id: id, display_name: name, email_hint: `${id}@example.test`,
    row_key: `workspace-one:${id}`, contact_key: `principal:workspace-one:${id}`, status: "active", identity_id: `identity-${id}`,
    has_workspace_access: 1, blocked: 0, binding_status: "linked", principalContextVersion: `principal-context-${id}`,
    hasExplicitAccess: true, accessLoaded: false, invitation: null, effectiveEmailBlockCount: 0, effectiveSubjectBlock: false,
    removableEmailBlockId: null, workspaceAccessSuspended: false, workspaceDenialCount: 0,
    removableWorkspaceDenialId: null, removableWorkspaceDenialUpdatedAt: null,
    actions: { canRetryInvitation: false, canCreateEmailBlock: true, canReviewEligibilityBlocks: true,
      canSuspendWorkspaceAccess: true, canReactivateWorkspaceAccess: false }, ...overrides };
}
function identityPage(items: PortalIdentitySummary[] = [identity("alice", "Alice Client"), identity("bob", "Bob Client", { identity_id: null, binding_status: "unlinked", has_workspace_access: 0 }),
  identity("carol", "Carol Client"), identity("dana", "Dana Client"), identity("evan", "Evan Client")], more = true): PortalIdentityPage {
  return { items, page: metadata(more, "identity-page-2", 5, items.length), contextVersion: rootContext, refreshedAt: "2026-08-25T12:00:00Z",
    capabilities: { canManagePortal: true, canManageEligibilityBlocks: true, canManageWorkspaceAccess: true } };
}
function detail(portalIdentities = identityPage(), portalRootAccess?: Record<string, unknown>) {
  return { client: { workspace_id: "workspace-one", public_id: "42", kind: "organization", route_kind: "organizations",
    source_id: "project-alpha:primary", root_namespace: "business", pa_public_id: "a".repeat(32), detail_path: path,
    display_name: "Acme Construction", status: "active", portal_status: "active", account_count: 1, project_count: 0, request_count: 0, contact_count: 1 },
    contextVersion: rootContext, portalIdentities, portalRootAccess,
    contacts: [{ record_type: "business_contact", row_key: "business:1", contact_key: "business:1", workspace_id: null, public_id: "1",
      display_name: "Business Bailey", email_hint: "bailey@example.test" }],
    accounts: [], projects: [], requests: [], deliveryGrants: [], authenticatedDeliveryGrants: [], viewerGrants: [],
    capabilities: { directory: true, requests: false, delivery: false, viewer: false } };
}
function access(id: string, overrides: Record<string, unknown> = {}) {
  return { id, row_key: `access:${id}`, capability: "view_project", effect: "allow", scope_type: "project", scope_public_id: id,
    scope_label: `Project ${id}`, status: "active", valid_from: "2026-08-01T12:00:00Z", expires_at: null, revoked_at: null, effective_now: true, source_type: "explicit", ...overrides };
}
function block(id: string, overrides: Record<string, unknown> = {}) {
  return { id, row_key: `block:${id}`, match_type: "email", normalized_email: "alice@example.test", reason_code: "operator_opt_out", status: "active",
    valid_from: "2026-08-01T12:00:00Z", created_at: "2026-08-01T12:00:00Z", expires_at: null, revoked_at: null, effective_now: true, global_scope: true, canRevoke: true, ...overrides };
}
function nested(principalId: string, items: Record<string, unknown>[] = [], more = false) {
  return { items, page: metadata(more, "records-page-2", 5, items.length), contextVersion: rootContext,
    principalContextVersion: `principal-context-${principalId}`, refreshedAt: "2026-08-25T12:00:00Z" };
}
type Handler = (route: Route, url: URL) => Promise<unknown>;
async function mock(page: Page, handler: Handler, detailFactory: (count: number) => unknown = () => detail()) {
  let details = 0;
  const requests: Array<{ url: URL; method: string; key?: string }> = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push({ url, method: request.method(), key: request.headers()["idempotency-key"] });
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: "staff-one", email: "staff@example.test", displayName: "Staff",
      status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["team.view"], divisions: [] },
      csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    if (url.pathname === base) return route.fulfill({ json: detailFactory(++details) });
    return handler(route, url);
  });
  return { requests, details: () => details };
}
const panel = (page: Page) => page.getByRole("region", { name: "Portal logins", exact: true });
const person = (page: Page, name = "Alice Client") => panel(page).getByRole("article", { name: `Portal login for ${name}`, exact: true });
async function open(page: Page, suffix = "") { await page.goto(`${path}${suffix}`); await expect(panel(page)).toBeVisible(); }
async function late(route: Route, json: unknown) { await route.fulfill({ json }).catch(() => undefined); }

test("an administrator can revoke the whole client workspace and sees the durable blocked state", async ({ page }) => {
  const activeRoot = { available: true, state: "active", version: 0, reasonCode: null, updatedAt: null,
    canRevoke: true, canRestore: false };
  const revokedRoot = { available: true, state: "revoked", version: 1, reasonCode: "operator_root_revocation",
    updatedAt: "2026-09-05T12:00:00Z", canRevoke: false, canRestore: true };
  const state = await mock(page, (route, url) => {
    if (url.pathname === `${base}/portal-access/revoke`) return route.fulfill({ status: 201,
      json: { outcome: "root_access_revoked", version: 1, replayed: false } });
    return route.fulfill({ status: 404 });
  }, count => detail(identityPage(), count === 1 ? activeRoot : revokedRoot));
  page.on("dialog", dialog => dialog.accept());

  await open(page);
  await expect(panel(page).getByText("Portal access enabled for this client workspace", { exact: true })).toBeVisible();
  await panel(page).getByRole("button", { name: "Revoke workspace portal access", exact: true }).click();
  await expect(page.locator(".client-hub-title-status").getByText("Portal access revoked", { exact: true })).toBeVisible();
  await expect(panel(page).getByText("Portal access revoked for this client workspace", { exact: true })).toBeVisible();
  await expect(panel(page).getByText("Current and future people cannot enter this workspace.", { exact: false })).toBeVisible();
  const request = state.requests.find(item => item.url.pathname === `${base}/portal-access/revoke`)!;
  expect(request.method).toBe("POST");
  expect(request.key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(state.details()).toBe(2);
});

test("enabled eligibility does not claim sign-in readiness before a workspace is linked", async ({ page }) => {
  await mock(page, route => route.fulfill({ status: 404 }), () => {
    const identities = identityPage([], false);
    identities.page = { ...metadata(false, "", 5, 0), available: false, reason: "workspace_unavailable" };
    const value = detail(identities, { available: true, state: "active", version: 0, reasonCode: null,
      updatedAt: null, canRevoke: true, canRestore: false });
    return { ...value, client: { ...value.client, workspace_id: null, portal_status: "mapping_unavailable" } };
  });
  await open(page);
  await expect(panel(page).getByText("Portal eligibility enabled — workspace not linked", { exact: true })).toBeVisible();
  await expect(panel(page).getByText(/Eligibility alone does not confirm sign-in readiness/)).toBeVisible();
  await expect(panel(page).getByText("Portal access enabled for this client workspace", { exact: true })).toHaveCount(0);
  await expect(panel(page).getByRole("button", { name: "Revoke workspace portal access" })).toBeVisible();
});

test("portal summaries are bounded and identity records load only when opened", async ({ page }) => {
  const state = await mock(page, (route, url) => {
    if (url.pathname === `${base}/identities`) return route.fulfill({ json: identityPage([identity("frank", "Frank Client")], false) });
    if (url.pathname.endsWith("/access")) return route.fulfill({ json: nested("alice", url.searchParams.has("cursor") ? [access("one"), access("two")] : [access("one")], !url.searchParams.has("cursor")) });
    if (url.pathname.endsWith("/invitations")) return route.fulfill({ json: nested("alice", [{ id: "invitation-one", status: "pending", email_status: "failed", created_at: "2026-08-20T12:00:00Z", expires_at: "2026-08-30T12:00:00Z" }]) });
    if (url.pathname.endsWith("/eligibility-blocks")) return route.fulfill({ json: nested("alice", [block("subject-rule", { match_type: "issuer_subject", canRevoke: false })]) });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await open(page);
  await expect(panel(page).getByRole("article")).toHaveCount(5);
  expect(state.requests.filter(request => request.url.pathname.includes("/identities"))).toHaveLength(0);
  expect(state.requests.some(request => request.url.pathname === "/api/team/clients")).toBe(false);
  await expect(person(page).getByText("Portal membership active", { exact: true })).toBeVisible();
  await expect(person(page, "Bob Client").getByText("Login not linked", { exact: true })).toBeVisible();
  await expect(person(page).getByText(/No.*access/)).toHaveCount(0);
  await person(page).getByRole("button", { name: "Show access", exact: true }).click();
  await expect(person(page).getByText("Project one", { exact: true })).toBeVisible();
  const first = state.requests.find(request => request.url.pathname.endsWith("/access"))!;
  expect(first.url.searchParams.get("expectedPrincipalContext")).toBe("principal-context-alice");
  expect(first.url.searchParams.get("limit")).toBe("5");
  await person(page).getByRole("button", { name: "Load more access rules", exact: true }).click();
  await expect(person(page).getByText("Project one", { exact: true })).toHaveCount(1);
  await expect(person(page).getByText("Project two", { exact: true })).toBeVisible();
  expect(state.requests.filter(request => request.url.pathname.endsWith("/access")).at(-1)!.url.searchParams.get("limit")).toBe("25");
  await person(page).getByRole("button", { name: "Invitations to this email", exact: true }).click();
  await expect(person(page).getByText("Email delivery: failed", { exact: true })).toBeVisible();
  await person(page).getByRole("button", { name: "Sign-in blocks", exact: true }).click();
  await expect(person(page).getByText("Global identity rule", { exact: true })).toBeVisible();
  await expect(person(page).getByRole("button", { name: "Remove sign-in block", exact: true })).toHaveCount(0);
  await panel(page).getByRole("button", { name: "Load more portal logins", exact: true }).click();
  await expect(panel(page).getByRole("article")).toHaveCount(6);
  expect(state.details()).toBe(1);
});

test("server login search preserves directory context and rejects stale searches through history", async ({ page }) => {
  let old: Route | undefined;
  const state = await mock(page, async (route, url) => {
    if (url.pathname === `${base}/identities`) {
      if (url.searchParams.get("q") === "older") { old = route; return; }
      return route.fulfill({ json: identityPage([identity("found", `Found ${url.searchParams.get("q") || "default"}`)], false) });
    }
    return route.fulfill({ status: 404 });
  });
  await open(page, "?q=directory-query&kind=organization");
  await panel(page).getByRole("searchbox", { name: "Search portal logins" }).fill("older");
  await panel(page).getByRole("button", { name: "Search logins", exact: true }).click();
  await expect.poll(() => Boolean(old)).toBe(true);
  await panel(page).getByRole("searchbox", { name: "Search portal logins" }).fill("unloaded@example.test");
  await panel(page).getByRole("combobox", { name: "Login link", exact: true }).selectOption("unlinked");
  await panel(page).getByRole("combobox", { name: "Sign-in blocks", exact: true }).selectOption("no");
  await panel(page).getByRole("button", { name: "Search logins", exact: true }).click();
  await expect(person(page, "Found unloaded@example.test")).toBeVisible();
  await late(old!, identityPage([identity("stale", "Old result")], false));
  await expect(person(page, "Old result")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("q")).toBe("directory-query");
  expect(new URL(page.url()).searchParams.get("login_q")).toBe("unloaded@example.test");
  const request = state.requests.find(request => request.url.searchParams.get("q") === "unloaded@example.test")!;
  expect(request.url.searchParams.get("link")).toBe("unlinked");
  expect(request.url.searchParams.get("blocked")).toBe("no");
  await page.reload();
  await expect(person(page, "Found unloaded@example.test")).toBeVisible();
  await expect(panel(page).getByRole("combobox", { name: "Login link", exact: true })).toHaveValue("unlinked");
  await panel(page).getByRole("button", { name: "Clear login filters", exact: true }).click();
  await expect(person(page, "Found default")).toBeVisible();
  await page.goBack();
  await expect(person(page, "Found unloaded@example.test")).toBeVisible();
  await expect(page.getByRole("link", { name: "← Client Hub" })).toHaveAttribute("href", "/clients?q=directory-query&kind=organization");
});

test("nested transient errors are local and retain other loaded records", async ({ page }) => {
  let tries = 0;
  const state = await mock(page, (route, url) => {
    if (url.pathname.endsWith("/access")) return route.fulfill({ json: nested("alice", [access("one")]) });
    if (url.pathname.endsWith("/invitations") && ++tries === 1) return route.fulfill({ status: 503, json: { error: "Invitation history unavailable" } });
    return route.fulfill({ json: nested("alice", [{ id: "invite-one", status: "pending", email_status: "sent" }]) });
  });
  await open(page);
  await person(page).getByRole("button", { name: "Show access", exact: true }).click();
  await expect(person(page).getByText("Project one", { exact: true })).toBeVisible();
  await person(page).getByRole("button", { name: "Invitations to this email", exact: true }).click();
  await expect(person(page).getByRole("alert")).toContainText("Invitation history unavailable");
  await expect(person(page).getByText("Project one", { exact: true })).toBeVisible();
  await person(page).getByRole("button", { name: "Retry invitations", exact: true }).click();
  await expect(person(page).getByText("Email delivery: sent", { exact: true })).toBeVisible();
  expect(state.details()).toBe(1);
});

test("global email blocks require confirmation and uncertain retry reuses the exact operation key", async ({ page }) => {
  let mutationCount = 0, pending: Route | undefined, blocked = false;
  const state = await mock(page, async (route, url) => {
    if (url.pathname === "/api/team/clients/eligibility-blocks") {
      mutationCount += 1;
      if (mutationCount === 1) { pending = route; return; }
      blocked = true;
      expect(route.request().postDataJSON()).toMatchObject({ matchType: "email", email: "alice@example.test" });
      return route.fulfill({ status: 201, json: { id: "global-block" } });
    }
    return route.fulfill({ status: 404 });
  }, () => detail(identityPage([identity("alice", "Alice Client", { blocked: blocked ? 1 : 0, has_workspace_access: blocked ? 0 : 1 })], false)));
  await open(page);
  page.once("dialog", async dialog => { expect(dialog.message()).toContain("ALL client workspaces"); await dialog.dismiss(); });
  await person(page).getByRole("button", { name: "Block portal sign-in", exact: true }).click();
  expect(mutationCount).toBe(0);
  page.on("dialog", dialog => dialog.accept());
  await person(page).getByRole("button", { name: "Block portal sign-in", exact: true }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await expect(person(page).getByRole("button", { name: "Block portal sign-in", exact: true })).toBeDisabled();
  await pending!.fulfill({ status: 503, json: { error: "Outcome could not be confirmed" } });
  await person(page).getByRole("button", { name: "Retry action", exact: true }).click();
  await expect.poll(() => state.details()).toBe(2);
  await expect(person(page).getByText("Sign-in blocked", { exact: true })).toBeVisible();
  const mutations = state.requests.filter(request => request.method === "POST");
  expect(mutations).toHaveLength(2);
  expect(mutations[0]!.key).toBeTruthy(); expect(mutations[1]!.key).toBe(mutations[0]!.key);
});

test("workspace access pause and restore stay scoped, version-fenced and idempotent", async ({ page }) => {
  let paused = false, first: Route | undefined;
  const state = await mock(page, async (route, url) => {
    if (url.pathname.endsWith("/workspace-access/suspend")) {
      const payload = route.request().postDataJSON();
      expect(payload).toEqual({ expectedContextVersion: rootContext, expectedPrincipalContext: "principal-context-alice",
        reasonCode: "operator_workspace_pause" });
      expect(JSON.stringify(payload)).not.toContain("email");
      if (!first) { first = route; return; }
      paused = true;
      return route.fulfill({ status: 201, json: { outcome: "workspace_access_suspended", replayed: false } });
    }
    if (url.pathname.endsWith("/workspace-access/reactivate")) {
      expect(route.request().postDataJSON()).toEqual({ expectedContextVersion: rootContext,
        expectedPrincipalContext: "principal-context-alice", reasonCode: "operator_workspace_restore",
        denialId: "workspace-denial-one", expectedUpdatedAt: "2026-09-02 12:00:00" });
      paused = false;
      return route.fulfill({ json: { outcome: "workspace_access_reactivated", replayed: false } });
    }
    return route.fulfill({ status: 404 });
  }, () => detail(identityPage([identity("alice", "Alice Client", paused ? {
    has_workspace_access: 0, workspaceAccessSuspended: true, workspaceDenialCount: 1,
    removableWorkspaceDenialId: "workspace-denial-one", removableWorkspaceDenialUpdatedAt: "2026-09-02 12:00:00",
    actions: { canRetryInvitation: false, canCreateEmailBlock: true, canReviewEligibilityBlocks: true,
      canSuspendWorkspaceAccess: false, canReactivateWorkspaceAccess: true },
  } : {})], false)));
  await open(page);
  page.on("dialog", dialog => dialog.accept());
  await person(page).getByRole("button", { name: "Pause access to this workspace", exact: true }).click();
  await expect.poll(() => Boolean(first)).toBe(true);
  await first!.fulfill({ status: 503, json: { error: "Outcome could not be confirmed" } });
  await person(page).getByRole("button", { name: "Retry action", exact: true }).click();
  await expect(person(page).getByText("Access paused for this workspace", { exact: true })).toBeVisible();
  const suspendRequests = state.requests.filter(request => request.url.pathname.endsWith("/workspace-access/suspend"));
  expect(suspendRequests).toHaveLength(2);
  expect(suspendRequests[0]!.key).toBeTruthy();
  expect(suspendRequests[1]!.key).toBe(suspendRequests[0]!.key);
  await person(page).getByRole("button", { name: "Restore access to this workspace", exact: true }).click();
  await expect.poll(() => state.requests.some(request => request.url.pathname.endsWith("/workspace-access/reactivate"))).toBe(true);
  await expect(person(page).getByText("Portal membership active", { exact: true })).toBeVisible();
});

test("block actions come from exact server descriptors rather than partial or expired history", async ({ page }) => {
  let revoked = "";
  const summary = identity("alice", "Alice Client", { blocked: 1, effectiveEmailBlockCount: 2, effectiveSubjectBlock: true,
    removableEmailBlockId: null, actions: { canCreateEmailBlock: false, canReviewEligibilityBlocks: true, canRetryInvitation: false } });
  await mock(page, (route, url) => {
    if (url.pathname.endsWith("/eligibility-blocks")) return route.fulfill({ json: nested("alice", [block("expired", { effective_now: false, canRevoke: false }),
      block("future", { effective_now: false, canRevoke: false }), block("subject", { match_type: "issuer_subject", canRevoke: false }), block("exact-effective")]) });
    if (url.pathname.endsWith("/revoke")) { revoked = url.pathname; return route.fulfill({ json: { id: "exact-effective" } }); }
    return route.fulfill({ status: 404 });
  }, () => detail(identityPage([summary], false)));
  await open(page);
  await expect(person(page).getByRole("button", { name: "Remove sign-in block", exact: true })).toHaveCount(0);
  await person(page).getByRole("button", { name: "Sign-in blocks", exact: true }).click();
  await expect(person(page).getByRole("button", { name: "Remove sign-in block", exact: true })).toHaveCount(1);
  page.once("dialog", async dialog => { expect(dialog.message()).toContain("GLOBAL"); expect(dialog.message()).toContain("all client workspaces"); await dialog.accept(); });
  await person(page).getByRole("button", { name: "Remove sign-in block", exact: true }).click();
  await expect.poll(() => revoked).toBe("/api/team/clients/eligibility-blocks/exact-effective/revoke");
});

for (const failure of [401, 403, 404, 409, "principal", "root"] as const) {
  test(`nested ${failure} invalidates the entire workspace and ignores another late identity response`, async ({ page }) => {
    let pending: Route | undefined;
    await mock(page, async (route, url) => {
      if (url.pathname.endsWith("/access")) { pending = route; return; }
      if (typeof failure === "number") return route.fulfill({ status: failure, json: { error: "Portal access changed" } });
      const response = nested("bob", []);
      if (failure === "principal") response.principalContextVersion = "replacement-identity";
      else response.contextVersion = "replacement-root";
      return route.fulfill({ json: response });
    });
    await open(page);
    await person(page).getByRole("button", { name: "Show access", exact: true }).click();
    await expect.poll(() => Boolean(pending)).toBe(true);
    await person(page, "Bob Client").getByRole("button", { name: "Invitations to this email", exact: true }).click();
    await expect(page.getByRole("button", { name: "Refresh client workspace", exact: true })).toBeVisible();
    await late(pending!, nested("alice", [access("late")]));
    await expect(panel(page)).toHaveCount(0);
    await expect(page.getByText("Business Bailey", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Project late", { exact: true })).toHaveCount(0);
  });
}

test("an old mutation success cannot reopen an invalidated identity workspace", async ({ page }) => {
  let pending: Route | undefined;
  const state = await mock(page, async (route, url) => {
    if (url.pathname === "/api/team/clients/eligibility-blocks") { pending = route; return; }
    return route.fulfill({ status: 409, json: { error: "Identity binding changed" } });
  });
  await open(page);
  page.on("dialog", dialog => dialog.accept());
  await person(page).getByRole("button", { name: "Block portal sign-in", exact: true }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await person(page, "Bob Client").getByRole("button", { name: "Show access", exact: true }).click();
  await expect(page.getByRole("button", { name: "Refresh client workspace", exact: true })).toBeVisible();
  await late(pending!, { id: "possibly-committed" });
  await expect(panel(page)).toHaveCount(0);
  expect(state.details()).toBe(1);
});

test("read-only capabilities never expose mutations and unlinked access is not mistaken for no rules", async ({ page }) => {
  const initial = identityPage([identity("bob", "Bob Client", { identity_id: null, binding_status: "unlinked", has_workspace_access: 0,
    invitation: { id: "expired-invite", status: "expired", email_status: "failed" },
    actions: { canCreateEmailBlock: false, canRetryInvitation: false, canReviewEligibilityBlocks: false } })], false);
  initial.capabilities = { canManagePortal: false, canManageEligibilityBlocks: false, canManageWorkspaceAccess: false };
  const state = await mock(page, route => route.fulfill({ json: { ...nested("bob"), page: { ...metadata(), available: false, reason: "identity_unlinked" } } }), () => detail(initial));
  await open(page);
  await expect(panel(page).getByRole("button", { name: /Block portal|Remove sign-in|Retry invitation/ })).toHaveCount(0);
  await person(page, "Bob Client").getByRole("button", { name: "Show access", exact: true }).click();
  await expect(person(page, "Bob Client").getByText("This contact has no linked portal login.", { exact: false })).toBeVisible();
  await expect(person(page, "Bob Client").getByText("No matching records.", { exact: true })).toHaveCount(0);
  expect(state.requests.some(request => request.method === "POST")).toBe(false);
});

test("portal access controls reflow on mobile, narrow, laptop and ultrawide and retain keyboard focus", async ({ page }, testInfo) => {
  const initial = identityPage([identity("alice", "Alice Client with a very long family and organization name", { email_hint: "long-client-address@regional-construction-services.example.test" })]);
  await mock(page, route => route.fulfill({ json: identityPage([identity("frank", "Frank Client")], false) }), () => detail(initial));
  await open(page);
  for (const width of [375, 640, 1280, 3440]) {
    await page.setViewportSize({ width, height: 960 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const button of await panel(page).getByRole("button").all()) {
      await button.scrollIntoViewIfNeeded(); const bounds = await button.boundingBox();
      expect(bounds!.height).toBeGreaterThanOrEqual(44); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    }
    await page.getByRole("heading", { name: "Portal logins", exact: true }).evaluate(element => scrollTo(0, scrollY + element.getBoundingClientRect().top - 100));
    await page.screenshot({ path: testInfo.outputPath(`portal-access-${width}.png`) });
  }
  await panel(page).getByRole("button", { name: "Load more portal logins", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(panel(page).getByRole("button", { name: "All portal logins loaded", exact: true })).toBeFocused();
});
