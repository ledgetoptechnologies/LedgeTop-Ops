import { expect, test, type Page, type Route } from "@playwright/test";
import type { PortalInvitationRequest } from "../../src/client/invitation-request-api";

const sourceId = "project-alpha:primary";
const workspaces = [{id: "workspace-a", rootType: "organization", rootPublicId: "org-a", displayName: "Acme Construction"}, {id: "workspace-b", rootType: "organization", rootPublicId: "org-b", displayName: "Mountain Engineering"}];
const terms = {id: "terms-one", kind: "collaborator" as const, mode: "project_end" as const, expiresAt: null, effectiveExpiresAt: null, completionPending: true, expired: false};
function row(overrides: Partial<PortalInvitationRequest> = {}): PortalInvitationRequest {return {id: "request-one", sourceId, sourceName: "Project Alpha", workspaceId: "workspace-a", workspaceName: "Acme Construction", requesterIdentityId: "identity-one", requesterEmail: "manager@example.test", version: 1, status: "pending", email: "collaborator@example.test", scope: {type: "project", publicId: "project-workspace-a"}, capabilities: ["workspace.view", "delivery.view"], accessTerms: terms, policyVersion: 2, createdAt: "2026-08-26T12:00:00Z", updatedAt: "2026-08-26T12:00:00Z", invitationId: null, reasonCode: null, canCancel: true, ...overrides};}
function access(id = "workspace-a", overrides: Record<string, unknown> = {}) {return {sourceId, sourceName: "Project Alpha", workspaceName: workspaces.find(value => value.id === id)!.displayName, canManageMembers: false, members: [], invitations: [], invitationRequestsSupported: true, invitationPolicy: {mode: "require_approval", version: 2}, projectAccessTermsSupported: true, projectAccessOptions: [{projectPublicId: `project-${id}`, projectEndSupported: true}], inviteScopes: [{type: "project", publicId: `project-${id}`, displayName: id === "workspace-a" ? "North seawall construction documentation" : "Mountain bridge inspection", capabilities: ["delivery.view", "request.create"], projectEndSupported: true}], ...overrides};}
type Call = {path: string; query: URLSearchParams; method: string; body: any; key?: string};
type Handler = (route: Route, call: Call) => Promise<unknown> | undefined;
async function fixture(page: Page, handler?: Handler) {
  const calls: Call[] = []; let saved: PortalInvitationRequest[] = [];
  await page.route("**/api/client/**", async route => {
    const request = route.request(), url = new URL(request.url()), call: Call = {path: url.pathname, query: url.searchParams, method: request.method(), body: request.postData() ? request.postDataJSON() : null, key: request.headers()["idempotency-key"]}; calls.push(call);
    const handled = handler?.(route, call); if (handled) return handled;
    if (call.path === "/api/client/session") return route.fulfill({json: {account: {id: "account-a", displayName: "Acme Construction"}, capabilities: {workspaceHierarchyV2: true, workspaceMembershipManagement: true, hierarchyScopedInvitations: true, invitationEmailDelivery: false}}});
    if (call.path === "/api/client/v2/workspaces") return route.fulfill({json: {workspaces}});
    if (call.path === "/api/client/projects") return route.fulfill({json: {projects: []}});
    if (call.path === "/api/client/service-requests") return route.fulfill({json: {requests: []}});
    if (call.path === "/api/client/map-config") return route.fulfill({json: {mapboxPublicToken: null}});
    if (call.path === "/api/client/notifications") return route.fulfill({json: {notifications: [], unreadCount: 0, cursor: null}});
    if (call.path === "/api/client/request-readiness") return route.fulfill({json: {mode: "legacy", workspaceId: request.headers()["x-ltds-workspace-id"] || "workspace-a", target: {kind: "root", projectId: null}, canStartRequest: false, reason: "request_not_permitted", root: {canStartRequest: false, reason: "request_not_permitted"}, projectRequestsSupported: false, refreshedAt: "2026-08-26T12:00:00Z"}});
    const match = call.path.match(/^\/api\/client\/v2\/workspaces\/(workspace-[ab])\/(access|invitation-requests|invitations)(?:\/(request-one)\/cancel)?$/);
    if (match) {
      const workspaceId = match[1]!;
      if (match[2] === "access") return route.fulfill({json: access(workspaceId)});
      if (call.method === "GET" && match[2] === "invitation-requests") return route.fulfill({json: {items: saved.filter(value => value.workspaceId === workspaceId), nextCursor: null}});
      if (call.method === "POST" && match[2] === "invitations") {
        saved = [row({workspaceId, workspaceName: workspaces.find(value => value.id === workspaceId)!.displayName, email: call.body.email, scope: call.body.organizationWide ? {type: "workspace", publicId: workspaceId} : call.body.targetScope, capabilities: ["workspace.view", ...call.body.capabilities], accessTerms: call.body.accessTerms ? {...terms, ...call.body.accessTerms} : null})];
        return route.fulfill({status: 201, json: {outcome: "approval_requested", request: saved[0], deliveryQueued: false}});
      }
      if (call.method === "POST" && match[3]) {saved = saved.map(value => ({...value, status: "cancelled", version: value.version + 1, canCancel: false})); return route.fulfill({json: {request: saved[0], replayed: false}});}
    }
    return route.fulfill({status: 404, json: {error: "Unsupported fixture endpoint"}});
  });
  return calls;
}
const historyRegion = (page: Page) => page.getByRole("region", {name: "Your invitation requests", exact: true});
const posts = (calls: Call[]) => calls.filter(call => call.method === "POST");
async function open(page: Page) {await page.goto("/portal/account?workspace=workspace-a"); await expect(page.getByRole("button", {name: "Review approval request", exact: true})).toBeEnabled();}
async function review(page: Page) {await page.getByLabel("Email address", {exact: true}).fill("collaborator@example.test"); await page.getByRole("button", {name: "Review approval request", exact: true}).click();}
async function submit(page: Page) {await review(page); await page.getByRole("button", {name: "Request approval", exact: true}).click(); await expect(historyRegion(page)).toContainText("Pending approval");}
async function late(route: Route, json: unknown) {await route.fulfill({json}).catch(() => undefined);}

test("project-only manager uses filtered invite scopes without enumerating the workspace directory", async ({page}) => {
  const calls = await fixture(page); await open(page);
  await expect(page.getByRole("radio", {name: /North seawall/})).toBeChecked();
  await expect(page.getByText("Workspace member records are not available", {exact: false})).toBeVisible();
  await expect(page.getByRole("heading", {name: "People", exact: true})).toHaveCount(0);
  await expect(page.getByLabel("Give access across this entire organization workspace")).toHaveCount(0);
  expect(calls.some(call => /\/(hierarchy|members)$/.test(call.path))).toBe(false);
});

test("approval request is explicitly reviewed and works without email configuration", async ({page}) => {
  const calls = await fixture(page); await open(page); await review(page);
  const confirmation = page.getByRole("region", {name: "Review approval request", exact: true});
  await expect(confirmation).toContainText("sends no invitation email and grants no access");
  await expect(confirmation).toContainText("Reopening does not renew expired access");
  expect(posts(calls)).toHaveLength(0); await page.getByRole("button", {name: "Cancel review"}).click(); expect(posts(calls)).toHaveLength(0);
  await submit(page); expect(posts(calls)).toHaveLength(1);
  expect(posts(calls)[0]?.body).toEqual({email: "collaborator@example.test", targetScope: {type: "project", publicId: "project-workspace-a"}, capabilities: ["delivery.view"], accessTerms: {kind: "collaborator", mode: "project_end", expiresAt: null}, expectedInvitationPolicyVersion: 2});
  await expect(page.getByRole("button", {name: "Send invitation", exact: true})).toHaveCount(0);
  await expect(historyRegion(page)).toContainText("No invitation or usable access has been published");
});

test("request-only delegatable scopes remain usable without synthesizing delivery viewing", async ({page}) => {
  const calls = await fixture(page, (route, call) => call.path.endsWith("/access") ? route.fulfill({json: access("workspace-a", {inviteScopes: [{type: "project", publicId: "project-workspace-a", displayName: "Request-only project", capabilities: ["request.create"], projectEndSupported: true}]})}) : undefined);
  await open(page); await expect(page.getByRole("radio", {name: /Request-only project/})).toBeChecked(); const permission = page.getByLabel("Allow this person to submit service requests for the selected scope"); await expect(permission).toBeChecked(); await expect(permission).toBeDisabled(); await submit(page);
  expect(posts(calls)[0]?.body.capabilities).toEqual(["request.create"]); await expect(historyRegion(page)).toContainText("Service requests"); await expect(historyRegion(page)).not.toContainText("Delivery viewing"); expect(calls.some(call => /\/(deliveries|files|members|hierarchy)(\/|$)/.test(call.path))).toBe(false);
});

test("organization-wide review uses advertised root capabilities instead of the selected project", async ({page}) => {
  const scopes = [{type: "project", publicId: "project-workspace-a", displayName: "Delivery project", capabilities: ["delivery.view"], projectEndSupported: true}, {type: "organization", publicId: "org-a", displayName: "Acme Construction", capabilities: ["request.create"], projectEndSupported: false}];
  const calls = await fixture(page, (route, call) => call.path.endsWith("/access") ? route.fulfill({json: access("workspace-a", {canManageMembers: true, inviteScopes: scopes})}) : undefined);
  await open(page); await page.getByLabel("Give access across this entire organization workspace").check(); await page.getByLabel("I understand and want to grant workspace-wide access.").check(); await submit(page);
  expect(posts(calls)[0]?.body).toEqual({email: "collaborator@example.test", organizationWide: true, confirmOrganizationWide: true, capabilities: ["request.create"], expectedInvitationPolicyVersion: 2}); await expect(historyRegion(page)).not.toContainText("Delivery viewing");
});

test("workspace-wide membership administration alone never fabricates a broader invitation offer", async ({page}) => {
  await fixture(page, (route, call) => call.path.endsWith("/access") ? route.fulfill({json: access("workspace-a", {canManageMembers: true})}) : undefined);
  await open(page); await expect(page.getByLabel("Give access across this entire organization workspace")).toHaveCount(0); await expect(page.getByRole("radio", {name: /North seawall/})).toBeVisible();
});

test("uncertain request retries exactly the original body and key", async ({page}) => {
  let attempts = 0; const calls = await fixture(page, (route, call) => call.path.endsWith("/invitations") && ++attempts === 1 ? route.fulfill({status: 503, json: {error: "Uncertain save"}}) : undefined);
  await open(page); await review(page); await page.getByRole("button", {name: "Request approval", exact: true}).click();
  await expect(page.getByRole("alert")).toContainText("not confirmed"); await expect(page.getByLabel("Manage team workspace")).toBeDisabled();
  await page.getByRole("button", {name: "Refresh team access"}).click(); await page.getByRole("button", {name: "Retry same invitation"}).click();
  await expect(historyRegion(page)).toContainText("Pending approval"); expect(posts(calls)).toHaveLength(2); expect(posts(calls)[1]?.body).toEqual(posts(calls)[0]?.body); expect(posts(calls)[1]?.key).toBe(posts(calls)[0]?.key);
});

test("raced policy rejects the reviewed request without issuing or silently retrying", async ({page}) => {
  const calls = await fixture(page, (route, call) => call.path.endsWith("/invitations") ? route.fulfill({status: 409, json: {error: "invitation_policy_changed"}}) : undefined);
  await open(page); await review(page); await page.getByRole("button", {name: "Request approval", exact: true}).click();
  await expect(page.getByRole("alert")).toContainText("Invitation policy changed"); await expect(historyRegion(page)).toHaveCount(0); expect(posts(calls)).toHaveLength(1); expect(posts(calls)[0]?.body.expectedInvitationPolicyVersion).toBe(2);
});

test("cancellation is separately confirmed and uses the current request version", async ({page}) => {
  const calls = await fixture(page); await open(page); await submit(page); await historyRegion(page).getByRole("button", {name: "Cancel request", exact: true}).click();
  await expect(page.getByLabel("Manage team workspace")).toBeDisabled(); await page.getByRole("button", {name: "Keep request"}).click(); expect(posts(calls)).toHaveLength(1);
  await historyRegion(page).getByRole("button", {name: "Cancel request", exact: true}).click(); await page.getByRole("button", {name: "Confirm cancellation"}).click();
  await expect(historyRegion(page).getByText("Cancelled", {exact: true})).toBeVisible(); expect(posts(calls)[1]?.body).toEqual({expectedVersion: 1});
});

test("uncertain cancellation keeps its key and never resubmits an invitation", async ({page}) => {
  let attempts = 0; const calls = await fixture(page, (route, call) => call.path.endsWith("/cancel") && ++attempts === 1 ? route.fulfill({status: 503, json: {error: "Uncertain cancellation"}}) : undefined);
  await open(page); await submit(page); await historyRegion(page).getByRole("button", {name: "Cancel request", exact: true}).click(); await page.getByRole("button", {name: "Confirm cancellation"}).click();
  await expect(historyRegion(page).getByRole("alert")).toContainText("Cancellation is not confirmed"); await expect(page.getByRole("button", {name: "Keep request"})).toBeDisabled(); await page.getByRole("button", {name: "Retry cancellation"}).click();
  await expect(historyRegion(page).getByText("Cancelled", {exact: true})).toBeVisible(); const cancels = posts(calls).filter(call => call.path.endsWith("/cancel")); expect(cancels).toHaveLength(2); expect(cancels[1]?.key).toBe(cancels[0]?.key); expect(cancels[1]?.body).toEqual(cancels[0]?.body); expect(posts(calls).filter(call => call.path.endsWith("/invitations"))).toHaveLength(1);
});

test("empty intermediate history pages retain Load more and approval is not email delivery", async ({page}) => {
  await fixture(page, (route, call) => call.method === "GET" && call.path.endsWith("/invitation-requests") ? route.fulfill({json: call.query.has("cursor") ? {items: [row({status: "approved", version: 3, invitationId: "invitation-one", canCancel: false})], nextCursor: null} : {items: [], nextCursor: "page-two"}}) : undefined);
  await open(page); await expect(historyRegion(page)).toContainText("No requests in this page"); await historyRegion(page).getByRole("button", {name: "Load more invitation requests"}).click();
  await expect(historyRegion(page)).toContainText("Email delivery and acceptance are separate"); await expect(historyRegion(page).getByRole("button", {name: "Cancel request", exact: true})).toHaveCount(0);
});

for (const status of [403, 409]) test(`history ${status} clears all old protected rows`, async ({page}) => {
  await fixture(page, (route, call) => call.method === "GET" && call.path.endsWith("/invitation-requests") ? call.query.has("cursor") ? route.fulfill({status, json: {error: "Changed authority"}}) : route.fulfill({json: {items: [row()], nextCursor: "page-two"}}) : undefined);
  await open(page); await historyRegion(page).getByRole("button", {name: "Load more invitation requests"}).click(); await expect(page.getByRole("alert")).toContainText("your access changed"); await expect(historyRegion(page)).toHaveCount(0); await expect(page.getByText("collaborator@example.test", {exact: true})).toHaveCount(0);
});

test("unavailable history is not empty and does not probe the unsupported endpoint", async ({page}) => {
  const calls = await fixture(page, (route, call) => call.path.endsWith("/access") ? route.fulfill({json: access("workspace-a", {invitationRequestsSupported: false})}) : undefined);
  await page.goto("/portal/account?workspace=workspace-a"); await expect(historyRegion(page)).toContainText("unavailable until its database update"); await expect(page.getByRole("button", {name: "Review approval request", exact: true})).toBeDisabled(); expect(calls.some(call => call.path.endsWith("/invitation-requests"))).toBe(false);
});

test("late own-history response cannot populate another selected management workspace", async ({page}) => {
  let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;}); let started = false;
  await fixture(page, (route, call) => call.path === "/api/client/v2/workspaces/workspace-a/invitation-requests" ? (started = true, wait.then(() => late(route, {items: [row()], nextCursor: null}))) : undefined);
  await open(page); await expect.poll(() => started).toBe(true); await page.getByLabel("Manage team workspace").selectOption("workspace-b"); await expect(page.getByRole("radio", {name: /Mountain bridge/})).toBeChecked(); release();
  await expect(historyRegion(page)).toContainText("No invitation requests yet"); await expect(historyRegion(page)).not.toContainText("collaborator@example.test");
});

test("wrong-workspace history fails closed without displaying another request", async ({page}) => {
  await fixture(page, (route, call) => call.path.endsWith("/invitation-requests") ? route.fulfill({json: {items: [row({workspaceId: "workspace-b"})], nextCursor: null}}) : undefined);
  await page.goto("/portal/account?workspace=workspace-a"); await expect(page.getByRole("alert")).toContainText("your access changed"); await expect(page.getByText("collaborator@example.test", {exact: true})).toHaveCount(0);
});

for (const width of [375, 1280]) test(`approval request review and own history fit ${width}px`, async ({page}, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message)); await fixture(page); await page.setViewportSize({width, height: 900}); await open(page); await review(page);
  const confirmation = page.getByRole("region", {name: "Review approval request", exact: true}); await confirmation.scrollIntoViewIfNeeded();
  const button = confirmation.getByRole("button", {name: "Request approval", exact: true}); await expect(button).toBeEnabled(); const box = await button.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({path: testInfo.outputPath(`client-invitation-approval-${width}.png`), fullPage: true});
  await button.scrollIntoViewIfNeeded(); await expect(button).toBeInViewport(); await page.screenshot({path: testInfo.outputPath(`client-invitation-approval-${width}-viewport.png`)});
  await page.evaluate(() => window.scrollTo({top: 0, behavior: "instant"})); await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await page.screenshot({path: testInfo.outputPath(`client-invitation-approval-${width}-top.png`)});
  await page.screenshot({path: testInfo.outputPath(`client-invitation-approval-${width}-full-top.png`), fullPage: true});
  await button.click(); await expect(historyRegion(page)).toContainText("Pending approval"); await historyRegion(page).scrollIntoViewIfNeeded(); await page.screenshot({path: testInfo.outputPath(`client-invitation-history-${width}.png`), fullPage: true}); expect(errors).toEqual([]);
  const cancel = historyRegion(page).getByRole("button", {name: "Cancel request", exact: true}); await cancel.scrollIntoViewIfNeeded(); await expect(cancel).toBeInViewport();
  await page.screenshot({path: testInfo.outputPath(`client-invitation-history-${width}-viewport.png`)});
  await page.evaluate(() => window.scrollTo({top: 0, behavior: "instant"})); await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await page.screenshot({path: testInfo.outputPath(`client-invitation-history-${width}-top.png`)});
  await page.screenshot({path: testInfo.outputPath(`client-invitation-history-${width}-full-top.png`), fullPage: true});
});
