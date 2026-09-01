import { expect, test, type Page, type Route } from "@playwright/test";
import type { InvitationRequest } from "../../src/client/invitation-administration-api";

const base = "/api/client-portal/invitation-requests", sourceId = "project-alpha:primary", workspaceId = "workspace-one";
const detailPath = `/clients/invitation-requests/request-one?sourceId=${encodeURIComponent(sourceId)}&workspaceId=${workspaceId}`;
const hubPath = "/clients/sources/project-alpha%3Aprimary/business/organizations/org-one";
const policyPath = `/api/client-portal/workspaces/${workspaceId}/invitation-policy`;
function row(overrides: Partial<InvitationRequest> = {}): InvitationRequest {return {id: "request-one", workspaceId, workspaceName: "Acme Construction — North shoreline restoration", sourceId, sourceName: "Project Alpha", requesterIdentityId: "manager-one", requesterEmail: "manager@example.test", email: "collaborator@example.test", version: 1, status: "pending", scope: {type: "project", publicId: "project-one"}, capabilities: ["workspace.view", "delivery.view", "request.create"], accessTerms: {id: "terms-one", kind: "collaborator", mode: "project_end", expiresAt: null, effectiveExpiresAt: null, completionPending: true, expired: false}, policyVersion: 2, createdAt: "2026-08-26T12:00:00Z", updatedAt: "2026-08-26T12:00:00Z", invitationId: null, reasonCode: null, canCancel: true, ...overrides};}
const detail = (request = row(), overrides: Record<string, unknown> = {}) => ({request, contextVersion: "c".repeat(64), capabilities: {canApprove: true, canReject: true}, unavailableReason: null, ...overrides});
const list = (items = [row()], nextCursor: string | null = null) => ({items, page: {hasMore: Boolean(nextCursor), nextCursor, limit: 25}, capabilities: {canReview: true}});
const policy = (overrides: Record<string, unknown> = {}) => ({workspaceId, sourceId, workspaceName: "Acme Construction — North shoreline restoration", policy: "allowed", version: 1, contextVersion: "a".repeat(64), capabilities: {canManagePolicy: true}, ...overrides});
function hub(overrides: Record<string, unknown> = {}) {return {client: {workspace_id: workspaceId, source_id: sourceId, source_name: "Project Alpha", root_namespace: "business", public_id: "org-one", kind: "organization", route_kind: "organizations", display_name: "Acme Construction", detail_path: hubPath, status: "active", portal_status: "active", account_count: 1, contact_count: 0, project_count: 0, request_count: 0, ...overrides}, contextVersion: "hub-context", contacts: [], accounts: [], projects: [], requests: [], deliveryGrants: [], authenticatedDeliveryGrants: [], viewerGrants: [], capabilities: {directory: true, requests: false, delivery: false, viewer: false}, pages: Object.fromEntries(["businessContacts", "accounts", "projects"].map(name => [name, {available: true, reason: null, nextCursor: null, hasMore: false, returned: 0, limit: 5}]))};}
interface Call {path: string; query: URLSearchParams; method: string; body: any; key?: string; csrf?: string}
type Handler = (route: Route, call: Call) => Promise<unknown> | undefined;
async function fixture(page: Page, handler?: Handler, options: {probe?: boolean; review?: boolean; policy?: boolean; permissions?: string[]} = {}) {
  const calls: Call[] = []; let currentPolicy = policy(), current = row();
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), call: Call = {path: url.pathname, query: url.searchParams, method: request.method(), body: request.postData() ? request.postDataJSON() : null, key: request.headers()["idempotency-key"], csrf: request.headers()["x-csrf-token"]}; calls.push(call);
    const handled = handler?.(route, call); if (handled) return handled;
    if (call.path === "/api/session") return route.fulfill({json: {user: {id: "staff-one", displayName: "Reviewer", email: "reviewer@example.test", status: "Active", profileType: "Employee", isAdministrator: false, permissions: options.permissions ?? ["team.view"], divisions: []}, csrfToken: "csrf-review", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {clientWorkspaceManagerRecovery: {enabled: options.probe ?? true}}}});
    if (call.path === `${base}/capabilities`) return route.fulfill({json: {enabled: true, canReview: options.review ?? true, canManagePolicy: options.policy ?? true}});
    if (call.path === base) return route.fulfill({json: list([current])});
    if (call.path === `${base}/request-one`) return route.fulfill({json: detail(current)});
    if (call.path === `${base}/request-one/decision`) {current = {...current, version: current.version + (call.body.decision === "approve" ? 2 : 1), status: call.body.decision === "approve" ? "approved" : "rejected", canCancel: false, invitationId: call.body.decision === "approve" ? "invitation-one" : null, reasonCode: call.body.reason ?? null}; return route.fulfill({json: {request: current, replayed: false}});}
    if (call.path === policyPath) {if (call.method === "PATCH") {currentPolicy = policy({policy: call.body.policy, version: 2, contextVersion: "b".repeat(64)}); return route.fulfill({json: {policy: currentPolicy, replayed: false}});} return route.fulfill({json: currentPolicy});}
    if (call.path.startsWith("/api/client-hub/sources/")) return route.fulfill({json: hub()});
    if (call.path === "/api/operations/inbox/requests") return route.fulfill({json: {items: [], nextCursor: null}});
    if (call.path === "/api/sops") return route.fulfill({json: {sops: []}});
    return route.fulfill({status: 404, json: {error: "Unsupported fixture endpoint"}});
  }); return calls;
}
const mutations = (calls: Call[]) => calls.filter(call => call.method !== "GET");
async function openReview(page: Page) {await page.goto(detailPath); await expect(page.getByRole("button", {name: "Approve request", exact: true})).toBeVisible();}
async function openPolicy(page: Page) {await page.goto(hubPath); await page.getByRole("button", {name: "Show invitation policy"}).click(); await expect(page.getByRole("combobox", {name: "Invitation policy", exact: true})).toBeVisible();}
async function late(route: Route, json: unknown) {await route.fulfill({json}).catch(() => undefined);}

test("explicit review capability admits its own Client Hub queue without inferred global permissions", async ({page}) => {
  const calls = await fixture(page, undefined, {permissions: []}); await page.goto("/"); await expect(page).toHaveURL(/\/clients\/invitation-requests$/);
  const queue = page.getByRole("region", {name: "Invitation approvals", exact: true}); await expect(queue).toContainText("collaborator@example.test");
  await expect(queue.getByRole("link", {name: "collaborator@example.test"})).toHaveAttribute("href", detailPath);
  expect(calls.find(call => call.path === base)?.query.get("status")).toBe("open"); expect(calls.some(call => /\/inbox\/requests$|\/operations\/feedback$|\/notifications\/deliveries$/.test(call.path))).toBe(false); expect(mutations(calls)).toHaveLength(0);
});

for (const probe of [true, false]) test(`unavailable review capability never probes private queues (surface ${probe})`, async ({page}) => {
  const calls = await fixture(page, undefined, {probe, review: false, policy: false}); await page.goto(detailPath); await expect(page.getByRole("heading", {name: "Invitation approvals unavailable"})).toBeVisible();
  expect(calls.some(call => call.path === base || call.path === `${base}/request-one`)).toBe(false); expect(calls.some(call => call.path.endsWith("/capabilities"))).toBe(probe);
});

test("capability failure offers retry without pretending the approval queue is empty", async ({page}) => {
  let failed = true; const calls = await fixture(page, (route, call) => failed && call.path.endsWith("/capabilities") ? route.fulfill({status: 503, json: {error: "Unavailable"}}) : undefined);
  await page.goto(detailPath); await expect(page.getByRole("alert")).toContainText("could not be checked"); expect(calls.some(call => call.path === `${base}/request-one`)).toBe(false);
  failed = false; await page.getByRole("button", {name: "Retry invitation approval access"}).click(); await expect(page.getByRole("button", {name: "Approve request", exact: true})).toBeVisible();
});

test("approval confirmation has no reason input and sends exact CAS with CSRF", async ({page}) => {
  const calls = await fixture(page); await openReview(page); await page.getByRole("button", {name: "Approve request", exact: true}).click();
  const confirmation = page.getByRole("region", {name: "Confirm invitation decision"}); await expect(confirmation.getByRole("textbox")).toHaveCount(0); expect(mutations(calls)).toHaveLength(0);
  await confirmation.getByRole("button", {name: "Cancel", exact: true}).click(); expect(mutations(calls)).toHaveLength(0); await page.getByRole("button", {name: "Approve request", exact: true}).click(); await page.getByRole("button", {name: "Confirm approval"}).click();
  await expect(page.getByRole("status")).toContainText("Invitation published"); expect(mutations(calls)[0]?.body).toEqual({sourceId, workspaceId, decision: "approve", expectedVersion: 1, contextVersion: "c".repeat(64)}); expect(mutations(calls)[0]?.csrf).toBe("csrf-review"); expect(mutations(calls)[0]?.key).toBeTruthy();
});

test("rejection reason is optional and bounded to 500 characters", async ({page}) => {
  const calls = await fixture(page); await openReview(page); await page.getByRole("button", {name: "Reject request", exact: true}).click(); await expect(page.getByLabel("Rejection reason (optional)")).toHaveAttribute("maxlength", "500"); await page.getByRole("button", {name: "Confirm rejection"}).click(); await expect(page.getByRole("status")).toContainText("request rejected"); expect(mutations(calls)[0]?.body).toEqual({sourceId, workspaceId, decision: "reject", expectedVersion: 1, contextVersion: "c".repeat(64)});
});

test("uncertain approval retries the identical intent and does not claim publication early", async ({page}) => {
  let attempts = 0; const calls = await fixture(page, (route, call) => call.path.endsWith("/decision") && ++attempts === 1 ? route.fulfill({status: 503, json: {error: "Unconfirmed publication"}}) : undefined);
  await openReview(page); await page.getByRole("button", {name: "Approve request", exact: true}).click(); await page.getByRole("button", {name: "Confirm approval"}).click(); await expect(page.getByRole("alert")).toContainText("not confirmed"); await expect(page.getByRole("button", {name: "Cancel", exact: true})).toBeDisabled();
  await page.getByRole("button", {name: "Retry same decision"}).click(); await expect(page.getByRole("status")).toContainText("Invitation published"); expect(mutations(calls)).toHaveLength(2); expect(mutations(calls)[1]?.body).toEqual(mutations(calls)[0]?.body); expect(mutations(calls)[1]?.key).toBe(mutations(calls)[0]?.key);
});

test("an approving response is not accepted as published success", async ({page}) => {
  await fixture(page, (route, call) => call.path.endsWith("/decision") ? route.fulfill({json: {request: row({status: "approving", version: 2}), replayed: false}}) : undefined);
  await openReview(page); await page.getByRole("button", {name: "Approve request", exact: true}).click(); await page.getByRole("button", {name: "Confirm approval"}).click(); await expect(page.getByRole("alert")).toContainText("not confirmed"); await expect(page.getByRole("button", {name: "Retry same decision"})).toBeVisible(); await expect(page.getByText("Invitation published.", {exact: false})).toHaveCount(0);
});

for (const status of [403, 409]) test(`decision ${status} clears stale request and never retries silently`, async ({page}) => {
  const calls = await fixture(page, (route, call) => call.path.endsWith("/decision") ? route.fulfill({status, json: {error: "Changed"}}) : undefined);
  await openReview(page); await page.getByRole("button", {name: "Approve request", exact: true}).click(); await page.getByRole("button", {name: "Confirm approval"}).click(); await expect(page.getByRole("alert")).toContainText("authorization changed"); await expect(page.getByText("collaborator@example.test", {exact: true})).toHaveCount(0); expect(mutations(calls)).toHaveLength(1);
});

test("stale requests remain independently rejectable, never approvable", async ({page}) => {
  await fixture(page, (route, call) => call.path === `${base}/request-one` ? route.fulfill({json: detail(row({status: "stale"}), {capabilities: {canApprove: false, canReject: true}, unavailableReason: "invitation_policy_changed"})}) : undefined);
  await page.goto(detailPath); await expect(page.getByRole("button", {name: "Reject request", exact: true})).toBeVisible(); await expect(page.getByRole("button", {name: "Approve request", exact: true})).toHaveCount(0); await expect(page.getByText("Needs a new request", {exact: true})).toBeVisible();
});

test("invalid exact coordinates fail without an ID-only detail probe", async ({page}) => {
  const calls = await fixture(page); await page.goto("/clients/invitation-requests/request-one?workspaceId=workspace-one"); await expect(page.getByRole("heading", {name: "Invitation request link invalid"})).toBeVisible(); expect(calls.some(call => call.path === `${base}/request-one`)).toBe(false);
});

test("list search, open filter and Back survive reload with bounded empty pages", async ({page}) => {
  const calls = await fixture(page, (route, call) => call.path === base ? route.fulfill({json: call.query.has("cursor") ? list() : list([], "page-two")}) : undefined);
  await page.goto("/clients/invitation-requests"); await expect(page.getByLabel("Request status")).toHaveValue("open"); await expect(page.getByText("No matching requests in this page.", {exact: false})).toBeVisible(); await page.getByRole("button", {name: "Load more invitation requests"}).click(); await expect(page.getByRole("link", {name: "collaborator@example.test"})).toBeVisible();
  await page.getByLabel("Search invitation requests").fill("Acme & Sons"); await page.getByRole("button", {name: "Search", exact: true}).click(); await expect(page).toHaveURL(/q=Acme\+%26\+Sons/); await page.reload(); await expect(page.getByLabel("Search invitation requests")).toHaveValue("Acme & Sons"); expect(calls.filter(call => call.path === base).at(-1)?.query.get("q")).toBe("Acme & Sons"); await page.goBack(); await expect(page.getByLabel("Search invitation requests")).toHaveValue("");
});

test("late old search cannot overwrite new results", async ({page}) => {
  let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;}); let started = false;
  await fixture(page, (route, call) => call.path === base && call.query.get("q") === "old" ? (started = true, wait.then(() => late(route, list([row({email: "old@example.test"})])))) : undefined);
  await page.goto("/clients/invitation-requests?q=old"); await expect.poll(() => started).toBe(true); await page.getByLabel("Search invitation requests").fill("new"); await page.getByRole("button", {name: "Search", exact: true}).click(); await expect(page.getByRole("link", {name: "collaborator@example.test"})).toBeVisible(); release(); await expect(page.getByText("old@example.test", {exact: true})).toHaveCount(0);
});

test("policy review is exact-workspace and cancel has no mutation", async ({page}) => {
  const calls = await fixture(page); await openPolicy(page); expect(calls.find(call => call.path === policyPath)?.query.get("sourceId")).toBe(sourceId); await page.getByRole("combobox", {name: "Invitation policy", exact: true}).selectOption("require_approval"); await page.getByRole("button", {name: "Review policy change"}).click(); await page.getByRole("button", {name: "Cancel", exact: true}).click(); expect(mutations(calls)).toHaveLength(0);
  await page.getByRole("button", {name: "Review policy change"}).click(); await page.getByRole("button", {name: "Confirm policy change"}).click(); await expect(page.getByRole("status").filter({hasText: "Invitation policy saved"})).toBeVisible(); expect(mutations(calls)[0]?.body).toEqual({sourceId, policy: "require_approval", expectedVersion: 1, contextVersion: "a".repeat(64)});
});

test("policy conflict clears the entire protected Client Hub context", async ({page}) => {
  const calls = await fixture(page, (route, call) => call.method === "PATCH" ? route.fulfill({status: 409, json: {error: "invitation_policy_changed"}}) : undefined);
  await openPolicy(page); await page.getByRole("combobox", {name: "Invitation policy", exact: true}).selectOption("disabled"); await page.getByRole("button", {name: "Review policy change"}).click(); await page.getByRole("button", {name: "Confirm policy change"}).click(); await expect(page.getByRole("alert")).toContainText("workspace needs refreshing"); await expect(page.getByRole("combobox", {name: "Invitation policy", exact: true})).toHaveCount(0); expect(mutations(calls)).toHaveLength(1);
});

test("source records without an exact portal workspace never infer a policy target", async ({page}) => {
  const calls = await fixture(page, (route, call) => call.path.startsWith("/api/client-hub/sources/") ? route.fulfill({json: hub({workspace_id: null, source_id: "project-alpha:secondary"})}) : undefined);
  await page.goto(hubPath); await expect(page.getByRole("heading", {name: "Acme Construction", exact: true})).toBeVisible(); await expect(page.getByRole("button", {name: "Show invitation policy"})).toHaveCount(0); expect(calls.some(call => call.path === policyPath)).toBe(false);
});

for (const width of [375, 1280]) test(`policy and approval confirmation are readable at ${width}px`, async ({page}, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message)); await fixture(page); await page.setViewportSize({width, height: 900}); await openPolicy(page); await page.getByRole("combobox", {name: "Invitation policy", exact: true}).selectOption("require_approval"); await page.getByRole("button", {name: "Review policy change"}).click();
  const policyReview = page.getByRole("region", {name: "Confirm invitation policy"}); await policyReview.scrollIntoViewIfNeeded(); await page.screenshot({path: testInfo.outputPath(`invitation-policy-${width}.png`), fullPage: true}); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const policyButton = policyReview.getByRole("button", {name: "Confirm policy change"}); await policyButton.scrollIntoViewIfNeeded();
  await expect(policyButton).toBeInViewport(); await expect(policyButton).toBeVisible();
  await page.screenshot({path: testInfo.outputPath(`invitation-policy-${width}-viewport.png`)});
  await page.evaluate(() => window.scrollTo({top: 0, behavior: "instant"})); await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await page.screenshot({path: testInfo.outputPath(`invitation-policy-${width}-top.png`)});
  await page.screenshot({path: testInfo.outputPath(`invitation-policy-${width}-full-top.png`), fullPage: true});
  await openReview(page); await page.getByRole("button", {name: "Approve request", exact: true}).click(); const button = page.getByRole("button", {name: "Confirm approval"}); await button.scrollIntoViewIfNeeded(); await button.focus(); await expect(button).toBeFocused(); const box = await button.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  await page.screenshot({path: testInfo.outputPath(`invitation-review-${width}.png`), fullPage: true}); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
  await expect(button).toBeInViewport(); await page.screenshot({path: testInfo.outputPath(`invitation-review-${width}-viewport.png`)});
  await page.evaluate(() => window.scrollTo({top: 0, behavior: "instant"})); await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await page.screenshot({path: testInfo.outputPath(`invitation-review-${width}-top.png`)});
  await page.screenshot({path: testInfo.outputPath(`invitation-review-${width}-full-top.png`), fullPage: true});
});
