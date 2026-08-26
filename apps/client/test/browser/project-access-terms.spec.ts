import { expect, test, type Page, type Route } from "@playwright/test";

const workspaces = [{id: "workspace-a", rootType: "organization", rootPublicId: "org-a", displayName: "Acme Construction"}, {id: "workspace-b", rootType: "organization", rootPublicId: "org-b", displayName: "Mountain Engineering"}];
const terms = {kind: "collaborator", mode: "project_end", expiresAt: null};
function hierarchy(id = "workspace-a") {return {entries: [{type: "organization", publicId: id === "workspace-a" ? "org-a" : "org-b", parentPublicId: null, displayName: id === "workspace-a" ? "Acme Construction" : "Mountain Engineering", sourceVersion: "1"}, {type: "project", publicId: `project-${id}`, parentPublicId: id === "workspace-a" ? "org-a" : "org-b", displayName: id === "workspace-a" ? "North seawall construction documentation" : "Mountain bridge inspection", sourceVersion: "1"}]};}
function access(id = "workspace-a", overrides: Record<string, unknown> = {}) {return {sourceId: "project-alpha:primary", sourceName: "Project Alpha", workspaceName: id, canManageMembers: true, invitationRequestsSupported: false, inviteScopes: hierarchy(id).entries.map(entry => ({type: entry.type, publicId: entry.publicId, displayName: entry.displayName, capabilities: ["delivery.view", "request.create"], projectEndSupported: entry.type === "project"})), members: [{identityId: `manager-${id}`, email: `manager-${id}@example.test`, manager: true, status: "active", source: "project_alpha"}], invitations: [], invitationPolicy: {mode: "allowed", version: 1}, projectAccessTermsSupported: true, projectAccessOptions: [{projectPublicId: `project-${id}`, projectEndSupported: true}], ...overrides};}
type Call = {path: string; method: string; body: any; key?: string};
async function mock(page: Page, override?: (route: Route, call: Call) => Promise<unknown> | undefined) {
  const calls: Call[] = []; const saved = new Map<string, Record<string, unknown>[]>();
  await page.route("**/api/client/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname, call = {path, method: request.method(), body: request.postData() ? request.postDataJSON() : null, key: request.headers()["idempotency-key"]}; calls.push(call);
    const handled = override?.(route, call); if (handled) return handled;
    if (path === "/api/client/session") return route.fulfill({json: {account: {id: "account-a", displayName: "Acme Construction"}, capabilities: {workspaceHierarchyV2: true, workspaceMembershipManagement: true, hierarchyScopedInvitations: true, invitationEmailDelivery: true}}});
    if (path === "/api/client/v2/workspaces") return route.fulfill({json: {workspaces}});
    if (path === "/api/client/projects") return route.fulfill({json: {projects: []}});
    if (path === "/api/client/service-requests") return route.fulfill({json: {requests: []}});
    if (path === "/api/client/map-config") return route.fulfill({json: {mapboxPublicToken: null}});
    if (path === "/api/client/notifications") return route.fulfill({json: {notifications: [], unreadCount: 0, cursor: null}});
    if (path === "/api/client/request-readiness") return route.fulfill({json: {mode: "legacy", workspaceId: request.headers()["x-ltds-workspace-id"] || "workspace-a", target: {kind: "root", projectId: null}, canStartRequest: false, reason: "request_not_permitted", root: {canStartRequest: false, reason: "request_not_permitted"}, projectRequestsSupported: false, refreshedAt: "2026-08-26T12:00:00Z"}});
    const match = path.match(/^\/api\/client\/v2\/workspaces\/(workspace-[ab])\/(hierarchy|access|invitations)$/);
    if (match) {
      const id = match[1]!;
      if (match[2] === "hierarchy") return route.fulfill({json: hierarchy(id)});
      if (match[2] === "access") return route.fulfill({json: access(id, {invitations: saved.get(id) ?? []})});
      if (match[2] === "invitations" && call.method === "POST") {
        const input = call.body, invitation = {id: "invitation-one", email: input.email, status: "pending", scope: input.targetScope ?? {type: "project", publicId: input.projectPublicId}, capabilities: input.capabilities, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), accessTerms: input.accessTerms ? {...input.accessTerms, id: "terms-one", effectiveExpiresAt: input.accessTerms.expiresAt, completionPending: input.accessTerms.mode === "project_end", expired: false} : null};
        saved.set(id, [invitation]); return route.fulfill({status: 201, json: {outcome: "created"}});
      }
    }
    return route.fulfill({status: 404, json: {error: "Unsupported fixture endpoint"}});
  });
  return calls;
}
async function open(page: Page) {await page.goto("/portal/account?workspace=workspace-a"); await expect(page.getByRole("button", {name: "Refresh team access"})).toBeEnabled();}
async function review(page: Page) {await page.getByLabel("Email address", {exact: true}).fill("collaborator@example.test"); await page.getByRole("button", {name: "Review invitation", exact: true}).click(); await expect(page.getByRole("region", {name: "Review collaborator invitation"})).toBeVisible();}
async function late(route: Route, json: unknown) {try {await route.fulfill({json});} catch {/* Context cancelled the request. */}}

test("project invitations explicitly review collaborator completion terms separately from the seven-day link", async ({page}) => {
  const calls = await mock(page); await open(page);
  await expect(page.getByRole("combobox", {name: "Collaborator access duration"})).toHaveValue("project_end"); await review(page);
  const confirmation = page.getByRole("region", {name: "Review collaborator invitation"});
  await expect(confirmation).toContainText("project completion + 7 days"); await expect(confirmation).toContainText("Reopening does not renew expired access."); await expect(confirmation).toContainText("Invitation link: seven days. Access duration is separate.");
  await page.getByRole("button", {name: "Send invitation", exact: true}).click(); await expect(page.getByRole("status").filter({hasText: "Invitation issued"})).toBeVisible();
  expect(calls.find(call => call.method === "POST")?.body).toEqual({email: "collaborator@example.test", targetScope: {type: "project", publicId: "project-workspace-a"}, capabilities: ["delivery.view"], accessTerms: terms, expectedInvitationPolicyVersion: 1});
  await expect(page.getByText("Access awaits verified project completion, then 7 days", {exact: true})).toBeVisible();
});

test("specific-date invitation terms reject past dates and remain distinct from token expiry", async ({page}) => {
  const calls = await mock(page); await open(page); await page.getByLabel("Email address", {exact: true}).fill("dated@example.test");
  await page.getByRole("combobox", {name: "Collaborator access duration"}).selectOption("specific_date"); await page.getByLabel("Collaborator access expires", {exact: true}).fill("2000-01-01T12:00"); await page.getByRole("button", {name: "Review invitation", exact: true}).click(); await expect(page.getByRole("alert")).toContainText("valid future date");
  const date = new Date(Date.now() + 14 * 86400000); date.setSeconds(0, 0); const local = new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await page.getByLabel("Collaborator access expires", {exact: true}).fill(local); await page.getByRole("button", {name: "Review invitation", exact: true}).click(); await page.getByRole("button", {name: "Send invitation", exact: true}).click();
  await expect.poll(() => calls.filter(call => call.method === "POST").length).toBe(1); expect(calls.find(call => call.method === "POST")?.body.accessTerms).toEqual({kind: "collaborator", mode: "specific_date", expiresAt: date.toISOString()});
});

test("unsigned project completion offers no guessed default and until-revoked needs explicit choice", async ({page}) => {
  const calls = await mock(page, (route, call) => call.path.endsWith("/access") ? route.fulfill({json: access("workspace-a", {projectAccessOptions: [{projectPublicId: "project-workspace-a", projectEndSupported: false}]})}) : undefined);
  await open(page); const duration = page.getByRole("combobox", {name: "Collaborator access duration"}); await expect(duration).toHaveValue(""); await expect(duration.getByRole("option", {name: "Project completion + 7 days"})).toHaveJSProperty("disabled", true); await expect(page.getByRole("button", {name: "Review invitation", exact: true})).toBeDisabled();
  await duration.selectOption("until_revoked"); await review(page); await expect(page.getByRole("region", {name: "Review collaborator invitation"})).toContainText("Collaborator — until revoked"); await page.getByRole("button", {name: "Send invitation", exact: true}).click();
  await expect.poll(() => calls.filter(call => call.method === "POST").length).toBe(1); expect(calls.find(call => call.method === "POST")?.body.accessTerms).toEqual({kind: "collaborator", mode: "until_revoked", expiresAt: null});
});

for (const mode of ["disabled", "require_approval"]) test(`organization invitation policy ${mode} cannot be bypassed from the form`, async ({page}) => {
  const calls = await mock(page, (route, call) => call.path.endsWith("/access") ? route.fulfill({json: access("workspace-a", {invitationPolicy: {mode, version: 2}})}) : undefined); await open(page);
  await expect(page.getByRole("status").filter({hasText: mode === "disabled" ? "Invitations are disabled" : "Administrator approval is required"})).toBeVisible();
  await expect(page.getByLabel("Email address", {exact: true})).toBeDisabled(); await expect(page.getByRole("button", {name: mode === "disabled" ? "Review invitation" : "Review approval request", exact: true})).toBeDisabled(); await expect(page.getByRole("button", {name: "Send invitation", exact: true})).toHaveCount(0); expect(calls.some(call => call.method === "POST")).toBe(false);
});

for (const [status, code] of [[403, "invitation_policy_disabled"], [409, "invitation_approval_required"]] as const) test(`a raced invitation policy ${code} clears stale review and never retries silently`, async ({page}) => {
  const calls = await mock(page, (route, call) => call.method === "POST" ? route.fulfill({status, json: {error: code, code}}) : undefined); await open(page); await review(page); await page.getByRole("button", {name: "Send invitation", exact: true}).click();
  await expect(page.getByRole("alert")).toContainText(code === "invitation_policy_disabled" ? "Invitations are disabled" : "Administrator approval is required"); await expect(page.getByRole("region", {name: "Review collaborator invitation"})).toHaveCount(0); await expect(page.getByText("manager-workspace-a@example.test", {exact: true})).toHaveCount(0); expect(calls.filter(call => call.method === "POST")).toHaveLength(1); await expect(page.getByRole("button", {name: "Retry same invitation"})).toHaveCount(0);
});

test("uncertain invitations keep their original target terms and idempotency key through refresh", async ({page}) => {
  let attempts = 0; const calls = await mock(page, (route, call) => call.method === "POST" && ++attempts === 1 ? route.fulfill({status: 503, json: {error: "Unconfirmed delivery"}}) : undefined); await open(page); await review(page); await page.getByRole("button", {name: "Send invitation", exact: true}).dblclick();
  await expect(page.getByRole("alert")).toContainText("not confirmed"); await expect(page.getByRole("combobox", {name: "Manage team workspace"})).toBeDisabled(); await expect(page.getByRole("combobox", {name: "Collaborator access duration"})).toBeDisabled();
  await page.getByRole("button", {name: "Refresh team access"}).click(); await expect(page.getByRole("button", {name: "Retry same invitation"})).toBeEnabled(); await expect(page.getByRole("region", {name: "Review collaborator invitation"})).toContainText("North seawall construction documentation"); await page.getByRole("button", {name: "Retry same invitation"}).click(); await expect(page.getByRole("status").filter({hasText: "Invitation issued"})).toBeVisible();
  const posts = calls.filter(call => call.method === "POST"); expect(posts).toHaveLength(2); expect(posts[0]?.key).toBe(posts[1]?.key); expect(posts[0]?.body).toEqual(posts[1]?.body);
});

test("late settings from an earlier management workspace cannot replace the selected project", async ({page}) => {
  let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
  await mock(page, (route, call) => call.path === "/api/client/v2/workspaces/workspace-a/access" ? wait.then(() => late(route, access())) : undefined);
  await page.goto("/portal/account?workspace=workspace-a"); await page.getByRole("combobox", {name: "Manage team workspace"}).selectOption("workspace-b"); await expect(page.getByRole("radio", {name: /Mountain bridge inspection/})).toBeChecked(); release();
  await expect(page.getByRole("radio", {name: /North seawall/})).toHaveCount(0); await expect(page.getByText("manager-workspace-a@example.test", {exact: true})).toHaveCount(0); await expect(page.getByRole("radio", {name: /Mountain bridge inspection/})).toBeChecked();
});

test("missing access-term support disables new project invitations without silently using legacy grants", async ({page}) => {
  const calls = await mock(page, (route, call) => call.path.endsWith("/access") ? route.fulfill({json: access("workspace-a", {projectAccessTermsSupported: false, invitationPolicy: {mode: "allowed", version: 0}, projectAccessOptions: []})}) : undefined); await open(page);
  await expect(page.getByRole("status").filter({hasText: "New project invitations are unavailable"})).toBeVisible(); await expect(page.getByRole("button", {name: "Review invitation", exact: true})).toBeDisabled(); expect(calls.some(call => call.method === "POST")).toBe(false);
});

test("legacy invitation rows remain explicitly unclassified and unavailable policy is retryable", async ({page}) => {
  let failed = true;
  await mock(page, (route, call) => call.path.endsWith("/access") ? failed ? route.fulfill({status: 503, json: {error: "Access settings unavailable"}}) : route.fulfill({json: access("workspace-a", {invitations: [{id: "old-invite", email: "old@example.test", status: "accepted", scope: {type: "project", publicId: "project-workspace-a"}, capabilities: ["delivery.view"], expiresAt: "2026-08-01T12:00:00Z", accessTerms: null}]})}) : undefined);
  await open(page); await expect(page.getByRole("alert")).toContainText("Access settings unavailable"); await expect(page.getByText("No invitations yet.", {exact: true})).toHaveCount(0); failed = false; await page.getByRole("button", {name: "Refresh team access"}).click(); await expect(page.getByText("Existing access — unclassified", {exact: true})).toBeVisible();
});

for (const width of [375, 640, 1280, 3440]) test(`reviewed collaborator access terms remain keyboard accessible at ${width}px`, async ({page}, info) => {
  await page.setViewportSize({width, height: 1000}); await mock(page); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message)); await open(page);
  const duration = page.getByRole("combobox", {name: "Collaborator access duration"}); await duration.focus(); await expect(duration).toBeFocused(); await review(page); const confirmation = page.getByRole("region", {name: "Review collaborator invitation"}); await confirmation.scrollIntoViewIfNeeded();
  expect(await page.locator("body").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true); await expect(confirmation.getByRole("button", {name: "Send invitation", exact: true})).toBeVisible(); await page.screenshot({path: info.outputPath(`project-access-terms-${width}.png`)}); expect(errors).toEqual([]);
});
