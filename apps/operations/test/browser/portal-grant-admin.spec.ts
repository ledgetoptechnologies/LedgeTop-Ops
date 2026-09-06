import { expect, test, type Page, type Route } from "@playwright/test";

const user = {
  id: "staff-grant-admin", email: "admin@example.test", displayName: "Grant Admin",
  status: "Active", profileType: "Administrator", isAdministrator: true,
  permissions: ["administration.view", "delivery.browse", "delivery.share.create", "delivery.share.revoke"], divisions: [],
};

const primaryContext = {folderBindingId: "binding-acme", sourceId: "project-alpha:primary", projectName: "Hilly Haven construction documentation", accessTermsSupported: true, projectEndSupported: true};
const collaboratorTerms = {kind: "collaborator", mode: "project_end", expiresAt: null};
function primaryGrant(overrides: Record<string, unknown> = {}) {return {id: "grant-v1", grantId: "grant-logical", version: 1, folderBindingId: "binding-acme", workspaceId: "workspace-acme", audience: {type: "organization", publicId: "org-acme"}, audienceLabel: "Acme Organization", workspaceLabel: "Acme Workspace", status: "active", expiresAt: null, accessTerms: collaboratorTerms, effectiveAccessExpiresAt: null, recipientCount: 0, dynamicAudience: true, updatedAt: "2026-08-26T12:00:00Z", ...overrides};}
function primaryPreview(input: Record<string, any>, context = primaryContext) {const exact=input.audienceType==="principal";return {...context, operation: {...input, accessTerms: input.accessTerms ?? null}, contextVersion: "a".repeat(64), workspaceId: "workspace-acme", workspaceLabel: "Acme Workspace", audienceLabel: exact?"Exact Client":"Acme Organization", recipientCount: exact?1:0, dynamicAudience:!exact, recipientPreview:{mode:exact?"exact":"dynamic",currentAuthorizedCount:exact?1:null,truncated:false}, accessTerms: input.accessTerms ?? null, effectiveAccessExpiresAt: input.expiresAt};}
type GrantCall = {path: string; method: string; body: any; key?: string};
async function mockPrimary(page: Page, override?: (route: Route, call: GrantCall) => Promise<unknown> | undefined) {
  const calls: GrantCall[] = []; let grants: ReturnType<typeof primaryGrant>[] = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), call = {path: url.pathname, method: request.method(), body: request.postData() ? request.postDataJSON() : null, key: request.headers()["idempotency-key"]}; calls.push(call); const handled = override?.(route, call); if (handled) return handled;
    if (call.path === "/api/session") return route.fulfill({json: {user, csrfToken: "csrf-primary", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {deliveryJobsRoot: {enabled: true}, authenticatedDeliveryGrants: {enabled: true, creationEnabled: true}}}});
    if (call.path === "/api/delivery/folders") return route.fulfill({json: {prefix: url.searchParams.get("prefix") || "Jobs/Clients/", folders: [{id: "folder-acme", prefix: "Jobs/Clients/Acme/", name: "Acme", displayName: "Acme", kind: "folder"}], files: [], nextCursor: null}});
    if (call.path === "/api/delivery/folders/locations") return route.fulfill({json: {points: [], imageCount: 0, truncated: false}});
    if (call.path === "/api/delivery/shares/active") return route.fulfill({json: {share: null}});
    if (call.path === "/api/delivery/shares") return route.fulfill({json: {shares: []}});
    if (call.path.endsWith("/authenticated-grants/audiences")) return route.fulfill({json: {folderBindingId:"binding-acme",workspaceId:"workspace-acme",workspaceLabel:"Acme Workspace",scopeTypeFilter:"organization",audiences: [{type: "organization", publicId: "org-acme", displayName: "Acme Organization"}]}});
    if (call.path.endsWith("/authenticated-grants/preview")) return route.fulfill({json: primaryPreview(call.body)});
    if (call.path === "/api/delivery/authenticated-grants" && call.method === "POST") {const grant = primaryGrant({accessTerms: call.body.accessTerms ?? null, expiresAt: call.body.expiresAt, effectiveAccessExpiresAt: call.body.accessTerms?.expiresAt ?? call.body.expiresAt}); grants = [grant]; return route.fulfill({status: 201, json: {grant, replayed: false}});}
    if (call.path.endsWith("/grant-logical/revoke")) {const grant = primaryGrant({...grants[0], status: "revoked"}); grants = [grant]; return route.fulfill({json: {grant, replayed: false}});}
    if (call.path.endsWith("/grant-logical/restore")) {const grant = primaryGrant({id: "grant-v2", version: 2, accessTerms: call.body.accessTerms ?? null, expiresAt: call.body.expiresAt, effectiveAccessExpiresAt: call.body.accessTerms?.expiresAt ?? call.body.expiresAt}); grants = [grant]; return route.fulfill({status: 201, json: {grant, replayed: false}});}
    if (call.path === "/api/delivery/authenticated-grants") return route.fulfill({json: {...primaryContext, grants}});
    return route.fulfill({status: 404, json: {error: "Not found"}});
  });
  return calls;
}
async function openPrimary(page: Page) {await page.goto("/delivery"); await page.getByRole("button", {name: "Actions for Acme"}).click(); await page.getByRole("menuitem", {name: "Share", exact: true}).click(); await page.getByRole("tab", {name: "Client Workspace"}).click(); await expect(page.getByRole("button", {name: "Refresh authenticated access"})).toBeEnabled();}
async function selectPrimary(page: Page) {await page.getByRole("button", {name: "Organization", exact: true}).click(); const input = page.getByRole("combobox", {name: "Search organizations"}); await input.fill("Acme"); await expect(page.getByRole("option", {name: /Acme Organization/})).toBeVisible(); await input.press("ArrowDown"); await page.keyboard.press("Enter");}
async function reviewPrimary(page: Page, kind = "collaborator") {await selectPrimary(page); await page.getByRole("combobox", {name: "Recipient role"}).selectOption(kind); await page.getByRole("button", {name: "Review authenticated access"}).click(); await expect(page.getByRole("region", {name: "Review authenticated portal access"})).toBeVisible();}
async function latePrimary(route: Route, json: unknown) {try {await route.fulfill({json});} catch {/* Aborted after context changed. */}}

test("nonadministrators retain ordinary sharing without probing authenticated grants or falling back to legacy grants", async ({page}) => {
  const calls = await mockPrimary(page, (route, call) => {
    if (call.path === "/api/session") return route.fulfill({json: {user: {...user, profileType: "Operator", isAdministrator: false, permissions: ["delivery.browse", "delivery.share.create"]}, csrfToken: "csrf-scoped-share", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {deliveryJobsRoot: {enabled: true}, authenticatedDeliveryGrants: {enabled: true, creationEnabled: true}}}});
    if (call.path === "/api/delivery/shares" && call.method === "POST") return route.fulfill({status: 201, json: {share: {id: "ordinary-share", shareUrl: "https://delivery.example.test/s/ordinary-share", passwordProtected: false, expiresAt: null}}});
    return undefined;
  });
  await page.goto("/delivery"); await page.getByRole("button", {name: "Actions for Acme"}).click(); await page.getByRole("menuitem", {name: "Share", exact: true}).click();
  await page.getByRole("tab", {name: "Client Workspace"}).click();
  await expect(page.getByRole("status").filter({hasText: "Administrator access is required to manage Client Workspace grants"})).toBeVisible();
  await page.getByRole("tab", {name: "Public link"}).click();
  await expect(page.getByRole("button", {name: "Grant to client workspace", exact: true})).toHaveCount(0);
  await expect(page.getByRole("combobox", {name: "Portal connection"})).toHaveCount(0);
  await expect(page.getByRole("button", {name: "Create link", exact: true})).toBeEnabled();
  await page.getByRole("button", {name: "Create link", exact: true}).click(); await expect(page.getByText("Already shared", {exact: true})).toBeVisible();
  expect(calls.filter(call => call.path === "/api/delivery/shares" && call.method === "POST")).toHaveLength(1);
  expect(calls.some(call => call.path.startsWith("/api/delivery/authenticated-grants") || call.path.startsWith("/api/delivery/native-grants") || call.path.startsWith("/api/client-portal/folder-grant-targets") || /\/accounts\/[^/]+\/folder-grants/.test(call.path))).toBe(false);
});

test("an unavailable workspace rollout points administrators to safe Client Hub setup without probing grants", async ({page}) => {
  const calls = await mockPrimary(page, (route, call) => {
    if (call.path === "/api/session") return route.fulfill({json: {user, csrfToken: "csrf-workspace-unavailable", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {deliveryJobsRoot: {enabled: true}, authenticatedDeliveryGrants: {enabled: false, pilotReady: false, reasons: ["unreceipted_bindings"], checks: {bindings: {unreceiptedActiveCount: 2}}}}}});
    return undefined;
  });
  await page.goto("/delivery");
  await page.getByRole("button", {name: "Actions for Acme"}).click();
  await page.getByRole("menuitem", {name: "Share", exact: true}).click();
  const workspaceTab = page.getByRole("tab", {name: "Client Workspace"});
  await expect(workspaceTab).toBeDisabled();
  const status = page.getByRole("status").filter({hasText: "2 existing folder links require migration review"});
  await expect(status).toBeVisible();
  await expect(status.getByRole("link", {name: "Open Client Hub portal setup"})).toHaveAttribute("href", "/clients#client-portal-setup");
  expect(calls.some(call => call.path.startsWith("/api/delivery/authenticated-grants") || call.path.startsWith("/api/delivery/native-grants"))).toBe(false);
});

test("a creation pause preserves grant history and revoke while disabling new access and restore", async ({page}) => {
  const active = primaryGrant(), revoked = primaryGrant({id: "grant-old-v1", grantId: "grant-old", status: "revoked", audienceLabel: "Former Client"});
  const calls = await mockPrimary(page, (route, call) => {
    if (call.path === "/api/session") return route.fulfill({json: {user, csrfToken: "csrf-creation-paused", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null,
      capabilities: {deliveryJobsRoot: {enabled: true}, authenticatedDeliveryGrants: {enabled: true, creationEnabled: false, reasons: ["creation_disabled"]}}}});
    if (call.path === "/api/delivery/authenticated-grants" && call.method === "GET") return route.fulfill({json: {...primaryContext, grants: [active, revoked]}});
    return undefined;
  });
  await openPrimary(page);
  await expect(page.getByRole("status").filter({hasText: "New Client Workspace access and restores are paused"})).toBeVisible();
  await expect(page.getByRole("button", {name: "Organization", exact: true})).toBeDisabled();
  await expect(page.getByRole("button", {name: "Restore as new version"})).toBeDisabled();
  await expect(page.getByRole("button", {name: "Revoke", exact: true})).toBeEnabled();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", {name: "Revoke", exact: true}).click();
  await expect(page.getByRole("status").filter({hasText: "Authenticated portal access revoked"})).toBeVisible();
  expect(calls.some(call => call.path.endsWith("/grant-logical/revoke") && call.method === "POST")).toBe(true);
  expect(calls.some(call => call.path === "/api/delivery/authenticated-grants" && call.method === "POST")).toBe(false);
});

test("an unbound folder can be linked only to its exact signed primary workspace without creating access or a public link", async ({page}) => {
  let bound = false;
  const calls = await mockPrimary(page, (route, call) => {
    if (call.path === "/api/delivery/authenticated-grants" && call.method === "GET") {
      return bound
        ? route.fulfill({json: {...primaryContext, grants: []}})
        : route.fulfill({status: 404, json: {error: "Folder is not linked"}});
    }
    if (call.path === "/api/delivery/authenticated-grants/binding-targets" && call.method === "GET") return route.fulfill({json: {targets: [{
      workspaceId: "workspace-acme", workspaceLabel: "Acme Client Workspace", rootType: "organization", rootPublicId: "org-acme",
      rootLabel: "Acme Organization", ownerScopeType: "project", ownerPublicId: "project-hilly", ownerName: "Hilly Haven",
      projectPublicId: "project-hilly", projectName: "Hilly Haven", sourceId: "project-alpha:primary", contextVersion: "b".repeat(64),
    }]}});
    if (call.path === "/api/delivery/authenticated-grants/bindings" && call.method === "POST") {
      bound = true;
      return route.fulfill({status: 201, json: {binding: {
        bindingId: "binding-acme", workspaceId: "workspace-acme", workspaceLabel: "Acme Client Workspace", state: "active", version: 1,
        rootType: "organization", rootPublicId: "org-acme", rootLabel: "Acme Organization", ownerScopeType: "project",
        ownerPublicId: "project-hilly", ownerName: "Hilly Haven", projectPublicId: "project-hilly", projectName: "Hilly Haven",
        sourceId: "project-alpha:primary", contextVersion: "b".repeat(64), folderPrefix: "Jobs/Clients/Acme/",
      }, replayed: false}});
    }
    return undefined;
  });

  await page.goto("/delivery");
  await page.getByRole("button", {name: "Actions for Acme"}).click();
  await page.getByRole("menuitem", {name: "Share", exact: true}).click();
  await expect(page.getByRole("tab", {name: "Public link"})).toHaveAttribute("aria-selected", "true");
  expect(calls.some(call => call.path.includes("authenticated-grants/binding"))).toBe(false);

  await page.getByRole("tab", {name: "Client Workspace"}).click();
  await expect(page.getByRole("region", {name: "Link folder to a Client Workspace"})).toBeVisible();
  await expect(page.getByText("Linking grants no access", {exact: false})).toBeVisible();
  const workspaceSearch = page.getByRole("combobox", {name: "Projected workspace or project"});
  await expect(page.getByRole("option", {name: /Acme Client Workspace/})).toBeVisible();
  await workspaceSearch.press("ArrowDown");
  await expect(page.getByRole("option", {name: /Acme Client Workspace/})).toBeFocused();
  await page.keyboard.press("Enter");
  await page.getByRole("button", {name: "Review workspace link"}).click();
  const review = page.getByRole("region", {name: "Review Client Workspace folder link"});
  await expect(page.getByRole("heading", {name: "Confirm folder link"})).toBeFocused();
  await expect(review).toContainText("Access created");
  await expect(review).toContainText("None");
  await page.getByRole("button", {name: "Link folder to workspace"}).click();
  await expect(page.getByRole("button", {name: "Refresh authenticated access"})).toBeEnabled();

  const bind = calls.find(call => call.path === "/api/delivery/authenticated-grants/bindings" && call.method === "POST");
  expect(bind?.body).toEqual({folderRef: "folder-acme", workspaceId: "workspace-acme", reasonCode: "client_workspace_link", expectedContextVersion: "b".repeat(64)});
  expect(bind?.key).toBeTruthy();
  expect(calls.some(call => call.path === "/api/delivery/shares" && call.method === "POST")).toBe(false);
  expect(calls.some(call => call.path === "/api/delivery/authenticated-grants" && call.method === "POST")).toBe(false);
});

test("an administrator without revoke permission can review primary grants but has no forbidden revoke action", async ({page}) => {
  const calls = await mockPrimary(page, (route, call) => {
    // Session permission keys omit a permission when a global explicit deny applies.
    if (call.path === "/api/session") return route.fulfill({json: {user: {...user, permissions: user.permissions.filter(permission => permission !== "delivery.share.revoke")}, csrfToken: "csrf-revoke-denied", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {deliveryJobsRoot: {enabled: true}, authenticatedDeliveryGrants: {enabled: true, creationEnabled: true}}}});
    if (call.path === "/api/delivery/authenticated-grants" && call.method === "GET") return route.fulfill({json: {...primaryContext, grants: [primaryGrant()]}});
    return undefined;
  });
  await openPrimary(page); const history = page.getByLabel("Authenticated portal grant history"); await expect(history).toContainText("Acme Organization");
  await expect(history.getByRole("button", {name: "Revoke", exact: true})).toHaveCount(0);
  await reviewPrimary(page); await expect(page.getByRole("button", {name: "Grant authenticated access", exact: true})).toBeEnabled();
  expect(calls.some(call => call.path.endsWith("/revoke"))).toBe(false);
});

test("exact-person grants keep change notices default-off and retry the same optimistic policy save", async ({page}) => {
  let attempts = 0;
  const exact = primaryGrant({audience: {type: "principal", publicId: "principal-alex"}, audienceLabel: "Alex Client",
    recipientCount: 1, dynamicAudience: false});
  const calls = await mockPrimary(page, (route, call) => {
    if (call.path === "/api/delivery/authenticated-grants" && call.method === "GET") return route.fulfill({json: {...primaryContext, grants: [exact]}});
    if (call.path === "/api/delivery/authenticated-grants/grant-v1/notification-policy" && call.method === "GET") return route.fulfill({json: {policy: null, available: true}});
    if (call.path === "/api/delivery/authenticated-grants/grant-v1/notification-policy" && call.method === "PUT") {
      attempts += 1;
      if (attempts === 1) return route.fulfill({status: 503, json: {error: "Unconfirmed policy save"}});
      return route.fulfill({json: {available: true, policy: {accessNoticeEnabled: true, changeMode: "removed", version: 1}}});
    }
    return undefined;
  });
  await openPrimary(page);
  const policy = page.getByRole("group", {name: "Change notifications for Alex Client"});
  await expect(policy).toContainText("Optional and off by default");
  await expect(policy).toContainText("It does not change access. Legacy folder subscriptions are separate.");
  const enabled = policy.getByRole("checkbox", {name: "Send folder change summaries"});
  await expect(enabled).not.toBeChecked();
  await expect(policy.getByRole("combobox", {name: "Changes included for Alex Client"})).toBeDisabled();
  await enabled.check();
  await policy.getByRole("combobox", {name: "Changes included for Alex Client"}).selectOption("removed");
  await policy.getByRole("button", {name: "Save notification setting"}).click();
  await expect(policy.getByRole("alert")).toContainText("not confirmed");
  await policy.getByRole("button", {name: "Retry same notification setting"}).click();
  await expect(policy.getByRole("status")).toContainText("Portal access was not changed");
  const writes = calls.filter(call => call.path.endsWith("/grant-v1/notification-policy") && call.method === "PUT");
  expect(writes).toHaveLength(2);
  expect(writes[0]?.key).toBe(writes[1]?.key);
  expect(writes[0]?.body).toEqual({accessNoticeEnabled: true, changeMode: "removed", expectedVersion: null});
  expect(writes[1]?.body).toEqual(writes[0]?.body);
});

test("primary collaborators default only to supported completion terms and confirm before creation", async ({page}) => {
  const calls = await mockPrimary(page); await openPrimary(page); await selectPrimary(page); await expect(page.getByRole("combobox", {name: "Recipient role"})).toHaveValue(""); await expect(page.getByRole("button", {name: "Review authenticated access"})).toBeDisabled();
  await page.getByRole("combobox", {name: "Recipient role"}).selectOption("collaborator"); await expect(page.getByRole("combobox", {name: "Collaborator access duration"})).toHaveValue("project_end"); await page.getByRole("button", {name: "Review authenticated access"}).click();
  const confirmation = page.getByRole("region", {name: "Review authenticated portal access"}); await expect(confirmation).toContainText(primaryContext.projectName); await expect(confirmation).toContainText("Awaiting verified project completion, then 7 days"); await expect(confirmation).toContainText("Reopening does not renew expired access."); await expect(page.getByRole("heading", {name: "Confirm authenticated access"})).toBeFocused(); expect(calls.some(call => call.path === "/api/delivery/authenticated-grants" && call.method === "POST")).toBe(false);
  await page.getByRole("button", {name: "Grant authenticated access", exact: true}).click(); await expect(page.getByRole("status").filter({hasText: "Authenticated portal access granted"})).toBeVisible(); expect(calls.find(call => call.path === "/api/delivery/authenticated-grants" && call.method === "POST")?.body.accessTerms).toEqual(collaboratorTerms);
});

test("primary specific dates are explicit and terms edits discard an earlier preview", async ({page}) => {
  const calls = await mockPrimary(page); await openPrimary(page); await reviewPrimary(page); await page.getByRole("combobox", {name: "Collaborator access duration"}).selectOption("specific_date"); await expect(page.getByRole("region", {name: "Review authenticated portal access"})).toHaveCount(0); await page.getByRole("button", {name: "Review authenticated access"}).click(); await expect(page.getByRole("alert")).toContainText("valid future collaborator expiry");
  const future = new Date(Date.now() + 2 * 365 * 86400000); future.setSeconds(0, 0); const local = new Date(future.valueOf() - future.getTimezoneOffset() * 60000).toISOString().slice(0, 16); await page.getByLabel("Collaborator access expires", {exact: true}).fill(local); await page.getByRole("button", {name: "Review authenticated access"}).click(); await expect(page.getByRole("region", {name: "Review authenticated portal access"})).toBeVisible();
  expect(calls.filter(call => call.path.endsWith("/preview")).at(-1)?.body.accessTerms).toEqual({kind: "collaborator", mode: "specific_date", expiresAt: future.toISOString()});
});

test("primary unsupported completion requires an explicit choice and nonproject folders retain existing reviewed rules", async ({page}) => {
  let nonproject = false;
  const calls = await mockPrimary(page, (route, call) => {
    const context = {...primaryContext, projectName: nonproject ? null : primaryContext.projectName, projectEndSupported: false, accessTermsSupported: !nonproject};
    if (call.path === "/api/delivery/authenticated-grants" && call.method === "GET") return route.fulfill({json: {...context, grants: []}});
    if (call.path.endsWith("/preview")) return route.fulfill({json: primaryPreview(call.body, context as typeof primaryContext)});
    return undefined;
  });
  await openPrimary(page); await selectPrimary(page); await page.getByRole("combobox", {name: "Recipient role"}).selectOption("collaborator"); const duration = page.getByRole("combobox", {name: "Collaborator access duration"}); await expect(duration).toHaveValue(""); await expect(duration.getByRole("option", {name: "Project completion + 7 days"})).toHaveJSProperty("disabled", true); await expect(page.getByRole("button", {name: "Review authenticated access"})).toBeDisabled(); await duration.selectOption("until_revoked"); await page.getByRole("button", {name: "Review authenticated access"}).click(); await expect(page.getByRole("region", {name: "Review authenticated portal access"})).toContainText("Collaborator — until revoked");
  nonproject = true; await page.getByRole("button", {name: "Refresh authenticated access"}).click(); await expect(page.getByText(/Project-specific access terms require a folder linked to one project/)).toBeVisible(); await expect(page.getByRole("combobox", {name: "Recipient role"})).toHaveCount(0); await selectPrimary(page); await page.getByRole("button", {name: "Review authenticated access"}).click(); await expect(page.getByRole("region", {name: "Review authenticated portal access"})).toContainText("Existing access rules — unclassified"); await page.getByRole("button", {name: "Grant authenticated access", exact: true}).click(); await expect(page.getByRole("status").filter({hasText: "Authenticated portal access granted"})).toBeVisible(); expect(calls.find(call => call.path === "/api/delivery/authenticated-grants" && call.method === "POST")?.body).not.toHaveProperty("accessTerms");
});

test("primary project-term upgrade unavailable does not silently issue an unclassified grant", async ({page}) => {
  const calls = await mockPrimary(page, (route, call) => call.path === "/api/delivery/authenticated-grants" && call.method === "GET" ? route.fulfill({json: {...primaryContext, accessTermsSupported: false, projectEndSupported: false, grants: []}}) : undefined); await openPrimary(page); await expect(page.getByRole("status").filter({hasText: "database update"})).toBeVisible(); await selectPrimary(page); await expect(page.getByRole("combobox", {name: "Recipient role"})).toBeDisabled(); await expect(page.getByRole("button", {name: "Review authenticated access"})).toBeDisabled(); expect(calls.some(call => call.method === "POST")).toBe(false);
});

test("primary preview rejects a changed audience or access classification", async ({page}) => {
  const calls = await mockPrimary(page, (route, call) => call.path.endsWith("/preview") ? route.fulfill({json: {...primaryPreview(call.body), operation: {...call.body, audiencePublicId: "other-org"}}}) : undefined); await openPrimary(page); await selectPrimary(page); await page.getByRole("combobox", {name: "Recipient role"}).selectOption("customer"); await page.getByRole("button", {name: "Review authenticated access"}).click(); await expect(page.getByRole("alert")).toContainText("could not be verified"); await expect(page.getByRole("button", {name: "Grant authenticated access", exact: true})).toHaveCount(0); expect(calls.some(call => call.path === "/api/delivery/authenticated-grants" && call.method === "POST")).toBe(false);
});

test("uncertain primary creation retries the same reviewed terms and key while connection selection is locked", async ({page}) => {
  let attempts = 0; const calls = await mockPrimary(page, (route, call) => call.path === "/api/delivery/authenticated-grants" && call.method === "POST" && ++attempts === 1 ? route.fulfill({status: 503, json: {error: "Unconfirmed save"}}) : undefined); await openPrimary(page); await reviewPrimary(page); await page.getByRole("button", {name: "Grant authenticated access", exact: true}).dblclick(); await expect(page.getByRole("alert")).toContainText("not confirmed"); await expect(page.getByRole("combobox", {name: "Portal connection"})).toBeDisabled(); await expect(page.getByRole("combobox", {name: "Recipient role"})).toBeDisabled(); await page.getByRole("button", {name: "Retry same access operation"}).click(); await expect(page.getByRole("status").filter({hasText: "Authenticated portal access granted"})).toBeVisible(); const writes = calls.filter(call => call.path === "/api/delivery/authenticated-grants" && call.method === "POST"); expect(writes).toHaveLength(2); expect(writes[0]?.body).toEqual(writes[1]?.body); expect(writes[0]?.key).toBe(writes[1]?.key);
});

test("restoring a primary legacy grant requires a fresh classified review and preserves its logical version", async ({page}) => {
  let restored = false; const calls = await mockPrimary(page, (route, call) => {
    if (call.path === "/api/delivery/authenticated-grants" && call.method === "GET" && !restored) return route.fulfill({json: {...primaryContext, grants: [primaryGrant({status: "revoked", accessTerms: null})]}});
    if (call.path.endsWith("/restore")) restored = true;
    return undefined;
  }); await openPrimary(page); await expect(page.getByText("Existing access rules — unclassified", {exact: true})).toBeVisible(); await page.getByRole("button", {name: "Restore as new version"}).click(); await expect(page.getByRole("combobox", {name: "Recipient role"})).toHaveValue(""); expect(calls.some(call => call.path.endsWith("/restore"))).toBe(false); await page.getByRole("combobox", {name: "Recipient role"}).selectOption("customer"); await page.getByRole("button", {name: "Review authenticated access"}).click(); await page.getByRole("button", {name: "Restore authenticated access"}).click(); await expect(page.getByRole("status").filter({hasText: "restored as a new version"})).toBeVisible(); expect(calls.find(call => call.path.endsWith("/restore"))?.body).toMatchObject({expectedVersion: 1, expectedContextVersion: "a".repeat(64), accessTerms: {kind: "customer", mode: "until_revoked", expiresAt: null}});
});

test("editing a historical project restore returns to a visible creation audience mode", async ({page}) => {
  const project = primaryGrant({audience: {type: "project", publicId: "project-hilly"}, audienceLabel: "Hilly Haven", status: "revoked"});
  const calls = await mockPrimary(page, (route, call) => {
    if (call.path === "/api/delivery/authenticated-grants" && call.method === "GET") return route.fulfill({json: {...primaryContext, grants: [project]}});
    if (call.path.endsWith("/authenticated-grants/audiences")) {
      const url = new URL(route.request().url());
      expect(url.searchParams.get("audienceType")).toBe("principal");
      return route.fulfill({json: {folderBindingId: "binding-acme", workspaceId: "workspace-acme", workspaceLabel: "Acme Workspace", scopeTypeFilter: "principal",
        audiences: [{type: "principal", publicId: "principal-craig", displayName: "Craig Director", email: "craig@example.test"}]}});
    }
    return undefined;
  });
  await openPrimary(page);
  await expect(page.getByLabel("Authenticated portal grant history")).toContainText("Acme Workspace · Project · revoked · version 1");
  await page.getByRole("button", {name: "Restore as new version"}).click();
  const projectSearch = page.getByRole("combobox", {name: "Search projects"});
  await expect(projectSearch).toHaveValue("Hilly Haven");
  await projectSearch.fill("Craig");
  await expect(page.getByRole("button", {name: "Individual", exact: true})).toHaveAttribute("aria-pressed", "true");
  const individualSearch = page.getByRole("combobox", {name: "Search individuals"});
  await expect(page.getByRole("option", {name: /Craig Director/})).toBeVisible();
  await individualSearch.press("ArrowDown"); await page.keyboard.press("Enter");
  await page.getByRole("combobox", {name: "Recipient role"}).selectOption("customer");
  await page.getByRole("button", {name: "Review authenticated access"}).click();
  await expect(page.getByRole("button", {name: "Grant authenticated access", exact: true})).toBeVisible();
  await expect(page.getByRole("button", {name: "Restore authenticated access"})).toHaveCount(0);
  expect(calls.filter(call => call.path.endsWith("/authenticated-grants/audiences"))).toHaveLength(1);
});

for (const status of [403, 409]) test(`primary preview ${status} clears old grant context before refresh`, async ({page}) => {
  await mockPrimary(page, (route, call) => {
    if (call.path === "/api/delivery/authenticated-grants" && call.method === "GET") return route.fulfill({json: {...primaryContext, grants: [primaryGrant()]}});
    if (call.path.endsWith("/preview")) return route.fulfill({status, json: {error: "Project access changed"}});
    return undefined;
  }); await openPrimary(page); await selectPrimary(page); await page.getByRole("combobox", {name: "Recipient role"}).selectOption("customer"); await page.getByRole("button", {name: "Review authenticated access"}).click(); await expect(page.getByRole("alert")).toContainText("Project access changed"); await expect(page.getByLabel("Authenticated portal grant history")).toHaveCount(0); await expect(page.getByRole("button", {name: "Grant authenticated access", exact: true})).toHaveCount(0); await expect(page.getByRole("button", {name: "Refresh authenticated access"})).toBeEnabled();
});

test("late primary history cannot populate the connected workspace panel", async ({page}) => {
  let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
  await mockPrimary(page, (route, call) => {
    if (call.path === "/api/delivery/authenticated-grants" && call.method === "GET") return wait.then(() => latePrimary(route, {...primaryContext, grants: [primaryGrant()]}));
    if (call.path === "/api/delivery/native-grants") return route.fulfill({json: {grants: []}});
    return undefined;
  }); await page.goto("/delivery"); await page.getByRole("button", {name: "Actions for Acme"}).click(); await page.getByRole("menuitem", {name: "Share", exact: true}).click(); await page.getByRole("tab", {name: "Client Workspace"}).click(); await page.getByRole("combobox", {name: "Portal connection"}).selectOption("native"); release(); await expect(page.getByRole("region", {name: "Connected workspace folder access"})).toBeVisible(); await expect(page.getByLabel("Authenticated portal grant history")).toHaveCount(0);
});

for (const width of [375, 1280]) test(`primary project access review stays readable at ${width}px`, async ({page}, info) => {
  await page.setViewportSize({width, height: 960}); await mockPrimary(page); await openPrimary(page);
  await page.getByRole("button", {name: "Organization", exact: true}).click();
  const audience = page.getByRole("combobox", {name: "Search organizations"});
  for (const control of [page.getByRole("button", {name: "Refresh authenticated access"}), audience]) {
    await control.scrollIntoViewIfNeeded(); await expect(control).toBeInViewport(); const bounds = (await control.boundingBox())!;
    expect(bounds.height).toBeGreaterThanOrEqual(44); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  }
  await expect(audience).toHaveCSS("border-radius", "8px");
  await page.screenshot({path: info.outputPath(`primary-access-controls-${width}.png`)});
  await audience.fill("Acme"); await expect(page.getByRole("option", {name: /Acme Organization/})).toBeVisible();
  const candidates = page.getByRole("listbox"); await candidates.scrollIntoViewIfNeeded(); await expect(candidates).toBeInViewport();
  const inputBounds = (await audience.boundingBox())!, listBounds = (await candidates.boundingBox())!;
  expect(listBounds.y).toBeGreaterThanOrEqual(inputBounds.y + inputBounds.height); expect(listBounds.x).toBeGreaterThanOrEqual(0); expect(listBounds.x + listBounds.width).toBeLessThanOrEqual(width);
  const candidate = page.getByRole("option", {name: /Acme Organization/});
  const readableCandidate = async (background: string) => {
    await expect(candidate).toHaveCSS("color", "rgb(21, 27, 34)"); await expect(candidate).toHaveCSS("background-color", background);
    await expect(candidate.locator("strong")).toHaveCSS("color", "rgb(21, 27, 34)"); await expect(candidate.locator("small")).toHaveCSS("color", "rgb(21, 27, 34)");
  };
  await readableCandidate("rgb(255, 255, 255)"); await candidate.hover(); await readableCandidate("rgb(255, 244, 237)");
  await audience.hover(); await audience.press("ArrowDown"); await expect(candidate).toBeFocused(); await readableCandidate("rgb(255, 244, 237)");
  await page.screenshot({path: info.outputPath(`primary-access-audience-${width}.png`)});
  await page.keyboard.press("Enter"); await page.getByRole("combobox", {name: "Recipient role"}).selectOption("collaborator"); await page.getByRole("button", {name: "Review authenticated access"}).click();
  const review = page.getByRole("region", {name: "Review authenticated portal access"}); await expect(review).toBeVisible(); await review.scrollIntoViewIfNeeded(); await expect(review.getByRole("button", {name: "Grant authenticated access", exact: true})).toBeVisible(); expect(await page.locator("body").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true); await page.screenshot({path: info.outputPath(`primary-access-terms-${width}.png`)});
});

test("creates a distinct authenticated Client Portal grant with keyboard typeahead", async ({ page }) => {
  let posted: Record<string, unknown> | null = null;
  let created = false;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: { user, csrfToken: "csrf-grants", timezone: "America/Chicago",
      mapStyleUrl: null, mapboxPublicToken: null, capabilities: { deliveryJobsRoot: { enabled: true }, authenticatedDeliveryGrants: { enabled: true, creationEnabled: true } } } });
    if (url.pathname === "/api/delivery/folders") return route.fulfill({ json: { prefix: url.searchParams.get("prefix") || "Jobs/Clients/",
      folders: [{ id: "folder-acme", prefix: "Jobs/Clients/Acme/", name: "Acme", displayName: "Acme", kind: "folder" }], files: [], nextCursor: null } });
    if (url.pathname === "/api/delivery/folders/locations") return route.fulfill({ json: { points: [], imageCount: 0, truncated: false } });
    if (url.pathname === "/api/delivery/shares/active") return route.fulfill({ json: { share: null } });
    if (url.pathname === "/api/delivery/shares") return route.fulfill({ json: { shares: [] } });
    if (url.pathname === "/api/delivery/authenticated-grants/audiences") return route.fulfill({ json: {folderBindingId:"binding-acme",workspaceId:"workspace-acme",workspaceLabel:"Acme Workspace",scopeTypeFilter:"organization", audiences: [
      { type: "organization", publicId: "org-acme", displayName: "Acme Organization" },
    ] } });
    if (url.pathname === "/api/delivery/authenticated-grants/preview") {const input = route.request().postDataJSON(); return route.fulfill({json: {operation: input, contextVersion: "a".repeat(64), folderBindingId: "binding-acme", sourceId: "project-alpha:primary", workspaceId: "workspace-acme", workspaceLabel: "Acme Workspace", projectName: "Hilly Haven", accessTermsSupported: true, projectEndSupported: true, accessTerms: input.accessTerms, effectiveAccessExpiresAt: input.expiresAt, audienceLabel: "Acme Organization", recipientCount: 0,dynamicAudience:true,recipientPreview:{mode:"dynamic",currentAuthorizedCount:null,truncated:false}}});}
    if (url.pathname === "/api/delivery/authenticated-grants" && route.request().method() === "POST") {
      posted = route.request().postDataJSON(); created = true;
      return route.fulfill({ status: 201, json: { grant: { id: "grant-v1", grantId: "grant-logical", version: 1, status: "active", folderBindingId: "binding-acme", audience: {type: "organization", publicId: "org-acme"}, accessTerms: posted?.accessTerms, effectiveAccessExpiresAt: null }, replayed: false } });
    }
    if (url.pathname === "/api/delivery/authenticated-grants") return route.fulfill({ json: {
      folderBindingId: "binding-acme", sourceId: "project-alpha:primary", projectName: "Hilly Haven", accessTermsSupported: true, projectEndSupported: true, grants: created ? [{ id: "grant-v1", grantId: "grant-logical", version: 1,
        audience: { type: "organization", publicId: "org-acme" }, audienceLabel: "Acme Organization",
        workspaceLabel: "Acme Workspace", status: "active", expiresAt: null, recipientCount: 0,
        dynamicAudience: true, updatedAt: "2026-08-15T12:00:00Z", accessTerms: posted?.accessTerms, effectiveAccessExpiresAt: null }] : [],
    } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/delivery");
  await page.getByRole("button", { name: "Actions for Acme" }).click();
  await page.getByRole("menuitem", { name: "Share" }).click();
  await expect(page.getByText("Authenticated Client Portal access")).toHaveCount(0);
  await page.getByRole("tab", { name: "Client Workspace" }).click();
  await expect(page.getByText(/never creates a bearer link/i)).toBeVisible();
  await page.getByRole("button", {name: "Organization", exact: true}).click();
  const audience = page.getByRole("combobox", { name: "Search organizations" });
  await audience.fill("Acme");
  await expect(page.getByRole("option", { name: /Acme Organization/ })).toBeVisible();
  await audience.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(audience).toHaveValue("Acme Organization");
  await expect(page.getByText(/All currently authorized members of this organization/i).first()).toBeVisible();
  await page.getByRole("combobox", {name: "Recipient role"}).selectOption("customer"); await page.getByRole("button", {name: "Review authenticated access"}).click();
  await expect(page.getByRole("region", {name: "Review authenticated portal access"})).toContainText("Customer — retained project history until revoked");
  await page.getByRole("button", { name: "Grant authenticated access" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Authenticated portal access granted" })).toBeVisible();
  expect(posted).toMatchObject({ folderBindingId: "binding-acme", audienceType: "organization",
    audiencePublicId: "org-acme", reasonCode: "client_delivery_access", expiresAt: null, accessTerms: {kind: "customer", mode: "until_revoked", expiresAt: null}, expectedContextVersion: "a".repeat(64) });
  await expect(page.getByText("Dynamic current authorized members")).toBeVisible();
  await expect(page.getByRole("button", { name: "Revoke" })).toBeVisible();
});

test("client audiences can be searched, reviewed, granted, revoked, and restored with the correct label", async ({page}) => {
  const clientAudience = {type: "client" as const, publicId: "client-acme"};
  let grants: ReturnType<typeof primaryGrant>[] = [];
  const calls = await mockPrimary(page, (route, call) => {
    if (call.path === "/api/delivery/authenticated-grants" && call.method === "GET") {
      return route.fulfill({json: {...primaryContext, grants}});
    }
    if (call.path.endsWith("/authenticated-grants/audiences")) {
      const url = new URL(route.request().url());
      expect(url.searchParams.get("audienceType")).toBe("client");
      return route.fulfill({json: {
        folderBindingId: "binding-acme", workspaceId: "workspace-acme", workspaceLabel: "Acme Workspace", scopeTypeFilter: "client",
        audiences: [
          {type: "organization", publicId: "org-acme", displayName: "Acme Organization"},
          {...clientAudience, displayName: "Acme Client"},
        ],
      }});
    }
    if (call.path.endsWith("/authenticated-grants/preview")) {
      return route.fulfill({json: {...primaryPreview(call.body), audienceLabel: "Acme Client"}});
    }
    if (call.path === "/api/delivery/authenticated-grants" && call.method === "POST") {
      const grant = primaryGrant({audience: clientAudience, audienceLabel: "Acme Client", accessTerms: call.body.accessTerms ?? null});
      grants = [grant];
      return route.fulfill({status: 201, json: {grant, replayed: false}});
    }
    if (call.path.endsWith("/grant-logical/revoke")) {
      const grant = primaryGrant({...grants[0], audience: clientAudience, audienceLabel: "Acme Client", status: "revoked"});
      grants = [grant];
      return route.fulfill({json: {grant, replayed: false}});
    }
    if (call.path.endsWith("/grant-logical/restore")) {
      const grant = primaryGrant({id: "grant-v2", version: 2, audience: clientAudience, audienceLabel: "Acme Client", accessTerms: call.body.accessTerms ?? null});
      grants = [grant];
      return route.fulfill({status: 201, json: {grant, replayed: false}});
    }
    return undefined;
  });

  await openPrimary(page);
  await expect(page.getByRole("button", {name: "Client", exact: true})).toBeVisible();
  await expect(page.getByRole("button", {name: "Project", exact: true})).toHaveCount(0);
  await page.getByRole("button", {name: "Client", exact: true}).click();
  const search = page.getByRole("combobox", {name: "Search clients"});
  await search.fill("Acme");
  await expect(page.getByRole("option", {name: /Acme Client/})).toBeVisible();
  await expect(page.getByRole("option", {name: /Acme Organization/})).toHaveCount(0);
  await search.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/All currently authorized members of this client/i)).toBeVisible();
  await page.getByRole("combobox", {name: "Recipient role"}).selectOption("customer");
  await page.getByRole("button", {name: "Review authenticated access"}).click();
  let review = page.getByRole("region", {name: "Review authenticated portal access"});
  await expect(review.locator("dt", {hasText: "Target type"}).locator("..").locator("dd")).toHaveText("Client");
  await expect(review).toContainText("Acme Client");
  await page.getByRole("button", {name: "Grant authenticated access", exact: true}).click();
  await expect(page.getByRole("status").filter({hasText: "Authenticated portal access granted"})).toBeVisible();
  await expect(page.getByLabel("Authenticated portal grant history")).toContainText("Acme Workspace · Client · active · version 1");

  const created = calls.find(call => call.path === "/api/delivery/authenticated-grants" && call.method === "POST");
  expect(created?.body).toMatchObject({audienceType: "client", audiencePublicId: "client-acme",
    accessTerms: {kind: "customer", mode: "until_revoked", expiresAt: null}});

  page.once("dialog", async dialog => {
    expect(dialog.message()).toContain("Revoke authenticated portal access for Acme Client?");
    await dialog.accept();
  });
  await page.getByRole("button", {name: "Revoke", exact: true}).click();
  await expect(page.getByRole("status").filter({hasText: "Authenticated portal access revoked"})).toBeVisible();
  await expect(page.getByLabel("Authenticated portal grant history")).toContainText("Acme Workspace · Client · revoked · version 1");
  expect(calls.find(call => call.path.endsWith("/grant-logical/revoke"))?.body).toEqual({expectedVersion: 1, reasonCode: "client_delivery_access"});

  await page.getByRole("button", {name: "Restore as new version"}).click();
  await expect(page.getByRole("button", {name: "Client", exact: true})).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("combobox", {name: "Search clients"})).toHaveValue("Acme Client");
  await page.getByRole("combobox", {name: "Recipient role"}).selectOption("customer");
  await page.getByRole("button", {name: "Review authenticated access"}).click();
  review = page.getByRole("region", {name: "Review authenticated portal access"});
  await expect(review.locator("dt", {hasText: "Target type"}).locator("..").locator("dd")).toHaveText("Client");
  await page.getByRole("button", {name: "Restore authenticated access"}).click();
  await expect(page.getByRole("status").filter({hasText: "restored as a new version"})).toBeVisible();
  await expect(page.getByLabel("Authenticated portal grant history")).toContainText("Acme Workspace · Client · active · version 2");
  expect(calls.find(call => call.path.endsWith("/grant-logical/restore"))?.body).toMatchObject({expectedVersion: 1,
    expectedContextVersion: "a".repeat(64), accessTerms: {kind: "customer", mode: "until_revoked", expiresAt: null}});
});

test("department audiences require an explicit reviewed grant and reviewed restore", async ({page}) => {
  const departmentAudience = {type: "department" as const, publicId: "dept-athletics"};
  let grants: ReturnType<typeof primaryGrant>[] = [];
  const calls = await mockPrimary(page, (route, call) => {
    if (call.path === "/api/delivery/authenticated-grants" && call.method === "GET") {
      return route.fulfill({json: {...primaryContext, grants}});
    }
    if (call.path.endsWith("/authenticated-grants/audiences")) {
      const url = new URL(route.request().url());
      expect(url.searchParams.get("audienceType")).toBe("department");
      return route.fulfill({json: {
        folderBindingId: "binding-acme", workspaceId: "workspace-acme", workspaceLabel: "Acme Workspace", scopeTypeFilter: "department",
        audiences: [{...departmentAudience, displayName: "Athletics"}],
      }});
    }
    if (call.path.endsWith("/authenticated-grants/preview")) {
      return route.fulfill({json: {
        ...primaryPreview(call.body), audienceLabel: "Athletics", recipientCount: 0, dynamicAudience: true,
        recipientPreview: {mode: "dynamic", currentAuthorizedCount: null, truncated: false},
      }});
    }
    if (call.path === "/api/delivery/authenticated-grants" && call.method === "POST") {
      const grant = primaryGrant({audience: departmentAudience, audienceLabel: "Athletics", accessTerms: call.body.accessTerms ?? null});
      grants = [grant];
      return route.fulfill({status: 201, json: {grant, replayed: false}});
    }
    if (call.path.endsWith("/grant-logical/revoke")) {
      const grant = primaryGrant({...grants[0], audience: departmentAudience, audienceLabel: "Athletics", status: "revoked"});
      grants = [grant];
      return route.fulfill({json: {grant, replayed: false}});
    }
    if (call.path.endsWith("/grant-logical/restore")) {
      const prior = grants[0]!;
      const grant = primaryGrant({id: "grant-v2", version: 2, audience: departmentAudience, audienceLabel: "Athletics", accessTerms: call.body.accessTerms ?? null});
      grants = [grant, prior];
      return route.fulfill({status: 201, json: {grant, replayed: false}});
    }
    return undefined;
  });

  await openPrimary(page);
  await page.getByRole("button", {name: "Department", exact: true}).click();
  const search = page.getByRole("combobox", {name: "Search departments"});
  await search.fill("Athletics");
  await expect(page.getByRole("option", {name: /Athletics/})).toBeVisible();
  await search.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/All currently authorized members of this department/i)).toBeVisible();
  await page.getByRole("combobox", {name: "Recipient role"}).selectOption("customer");
  await page.getByRole("button", {name: "Review authenticated access"}).click();
  let review = page.getByRole("region", {name: "Review authenticated portal access"});
  await expect(review.locator("dt", {hasText: "Target type"}).locator("..").locator("dd")).toHaveText("Department");
  await expect(review).toContainText("Athletics");
  await page.getByRole("button", {name: "Grant authenticated access", exact: true}).click();
  await expect(page.getByRole("status").filter({hasText: "Authenticated portal access granted"})).toBeVisible();
  expect(calls.find(call => call.path === "/api/delivery/authenticated-grants" && call.method === "POST")?.body).toMatchObject({
    audienceType: "department", audiencePublicId: "dept-athletics", expectedContextVersion: "a".repeat(64),
    accessTerms: {kind: "customer", mode: "until_revoked", expiresAt: null},
  });

  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", {name: "Revoke", exact: true}).click();
  await expect(page.getByRole("status").filter({hasText: "Authenticated portal access revoked"})).toBeVisible();
  expect(calls.find(call => call.path.endsWith("/grant-logical/revoke"))?.body).toEqual({expectedVersion: 1, reasonCode: "client_delivery_access"});

  await page.getByRole("button", {name: "Restore as new version"}).click();
  await expect(page.getByRole("button", {name: "Department", exact: true})).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("combobox", {name: "Search departments"})).toHaveValue("Athletics");
  await expect(page.getByRole("button", {name: "Restore authenticated access"})).toHaveCount(0);
  await page.getByRole("combobox", {name: "Recipient role"}).selectOption("customer");
  await page.getByRole("button", {name: "Review authenticated access"}).click();
  review = page.getByRole("region", {name: "Review authenticated portal access"});
  await expect(review).toContainText("Department");
  await expect(review).toContainText("Athletics");
  await page.getByRole("button", {name: "Restore authenticated access"}).click();
  await expect(page.getByRole("status").filter({hasText: "restored as a new version"})).toBeVisible();
  const history = page.getByLabel("Authenticated portal grant history");
  await expect(history).toContainText("Acme Workspace · Department · active · version 2");
  await expect(history).toContainText("Acme Workspace · Department · revoked · version 1");
  expect(calls.find(call => call.path.endsWith("/grant-logical/restore"))?.body).toMatchObject({
    expectedVersion: 1, expectedContextVersion: "a".repeat(64),
    accessTerms: {kind: "customer", mode: "until_revoked", expiresAt: null},
  });
});

test("workspace targeting keeps an individual exact and makes broader scopes an explicit choice", async ({page}) => {
  const calls = await mockPrimary(page, (route, call) => {
    if (call.path.endsWith("/authenticated-grants/audiences")) {
      const url = new URL(route.request().url());
      expect(url.searchParams.get("audienceType")).toBe("principal");
      return route.fulfill({json: {folderBindingId:"binding-acme",workspaceId:"workspace-acme",workspaceLabel:"Acme Workspace",scopeTypeFilter:"principal",audiences: [
        {type: "organization", publicId: "org-red-town", displayName: "Red Town School District"},
        {type: "department", publicId: "dept-athletics", displayName: "Athletics"},
        {type: "principal", publicId: "principal-craig", displayName: "Craig Director", email: "craig@example.test"},
      ]}});
    }
    if (call.path.endsWith("/authenticated-grants/preview")) return route.fulfill({json: {
      ...primaryPreview(call.body), audienceLabel: "Craig Director", recipientCount: 1, dynamicAudience: false,
      recipientPreview: {mode: "exact", currentAuthorizedCount: 1, truncated: false},
    }});
    return undefined;
  });
  await openPrimary(page);
  await expect(page.getByRole("button", {name: "Individual", exact: true})).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", {name: "Department", exact: true})).toBeVisible();
  await expect(page.getByRole("button", {name: "Organization", exact: true})).toBeVisible();
  await expect(page.getByRole("button", {name: "Client", exact: true})).toBeVisible();
  const input = page.getByRole("combobox", {name: "Search individuals"});
  await input.fill("Craig");
  await expect(page.getByRole("option", {name: /Craig Director/})).toBeVisible();
  await expect(page.getByRole("option", {name: /Red Town School District/})).toHaveCount(0);
  await page.getByRole("option", {name: /Craig Director/}).click();
  await expect(page.getByText(/Exact verified person only/)).toBeVisible();
  await expect(page.getByText(/covers this folder and everything underneath it/i)).toBeVisible();
  await page.getByRole("combobox", {name: "Recipient role"}).selectOption("customer");
  await page.getByRole("button", {name: "Review authenticated access"}).click();
  const review = page.getByRole("region", {name: "Review authenticated portal access"});
  await expect(review).toContainText("Craig Director");
  await expect(review).toContainText("Individual");
  await expect(review).toContainText("This exact verified person only");
  await expect(review).toContainText("1 exact verified person");
  await expect(review).toContainText("never widens an individual to their organization");
  expect(calls.find(call => call.path.endsWith("/authenticated-grants/preview"))?.body).toMatchObject({audienceType: "principal", audiencePublicId: "principal-craig"});
  expect(calls.some(call => call.path === "/api/delivery/authenticated-grants" && call.method === "POST")).toBe(false);
});

test("workspace autocomplete rejects a response for a different folder or audience scope", async ({page}) => {
  const calls = await mockPrimary(page, (route, call) => {
    if (call.path.endsWith("/authenticated-grants/audiences")) return route.fulfill({json: {
      folderBindingId: "binding-other", workspaceId: "workspace-acme", workspaceLabel: "Acme Workspace",
      scopeTypeFilter: "organization", audiences: [{type: "organization", publicId: "org-acme", displayName: "Acme Organization"}],
    }});
    return undefined;
  });
  await openPrimary(page);
  await page.getByRole("button", {name: "Organization", exact: true}).click();
  await page.getByRole("combobox", {name: "Search organizations"}).fill("Acme");
  await expect(page.getByRole("alert")).toContainText("could not be verified");
  await expect(page.getByRole("option", {name: /Acme Organization/})).toHaveCount(0);
  expect(calls.some(call => call.path.endsWith("/authenticated-grants/preview"))).toBe(false);
});

test("Administration creates a scoped exact-identity denial without raw ID entry", async ({ page }) => {
  let posted: Record<string, unknown> | null = null;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: { user, csrfToken: "csrf-denials", timezone: "America/Chicago",
      mapStyleUrl: null, mapboxPublicToken: null, capabilities: { portalIdentityDenials: { enabled: true } } } });
    if (url.pathname === "/api/client-portal/identity-denials/identities") return route.fulfill({ json: { identities: [
      { identityId: "identity-alex", displayName: "Alex Client", email: "alex@example.test" },
    ] } });
    if (url.pathname === "/api/client-portal/identity-denials/scopes") return route.fulfill({ json: { scopes: [
      { scopeType: "project", workspaceId: "workspace-acme", publicId: "project-hilly", displayName: "Hilly Haven",
        workspaceLabel: "Acme Workspace", breadcrumb: "Acme Workspace › Acme Organization › Hilly Haven" },
    ] } });
    if (url.pathname === "/api/client-portal/identity-denials" && route.request().method() === "POST") {
      posted = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: { denial: { id: "denial-new" }, replayed: false } });
    }
    if (url.pathname === "/api/client-portal/identity-denials") return route.fulfill({ json: { denials: [] } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/administration");
  await expect(page.getByRole("heading", { name: "Client Portal identity denylist" })).toBeVisible();
  const identity = page.getByRole("combobox", { name: "Verified identity" });
  await identity.fill("Alex"); await expect(page.getByRole("option", { name: /Alex Client/ })).toBeVisible();
  await identity.press("ArrowDown"); await page.keyboard.press("Enter");
  await expect(identity).toHaveValue("Alex Client (alex@example.test)");
  await page.getByRole("combobox", { name: "Scope", exact: true }).selectOption("project");
  const scope = page.getByRole("combobox", { name: "Project" });
  await scope.fill("Hilly"); await expect(page.getByRole("option", { name: /Hilly Haven/ })).toBeVisible();
  await scope.press("ArrowDown"); await page.keyboard.press("Enter");
  await expect(scope).toHaveValue("Acme Workspace › Acme Organization › Hilly Haven");
  await expect(page.getByPlaceholder(/Opaque/)).toHaveCount(0);
  await page.getByRole("button", { name: "Create identity denial" }).click();
  await expect(page.getByRole("status")).toContainText("Portal identity denial created");
  expect(posted).toMatchObject({ identityId: "identity-alex", scopeType: "project",
    workspaceId: "workspace-acme", scopePublicId: "project-hilly", reasonCode: "security_response", expiresAt: null });
});

test("denylist controls remain hidden while the default-off capability is false", async ({ page }) => {
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: { user, csrfToken: "csrf-off", timezone: "America/Chicago",
      mapStyleUrl: null, mapboxPublicToken: null, capabilities: { portalIdentityDenials: { enabled: false } } } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/administration");
  await expect(page.getByText("Client Portal identity denylist")).toHaveCount(0);
});
