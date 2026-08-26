import { expect, test, type Page, type Route } from "@playwright/test";

const user = {id: "grant-admin", email: "admin@example.test", displayName: "Grant Admin", status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["delivery.browse", "delivery.share.create", "delivery.share.revoke", "delivery.share.audit", "projects.view", "administration.view"], divisions: []};
const previewContext = "a".repeat(64);
const grantId = "adac7f04-53fa-4cd6-86ea-68b229076cfa";
const targetB = {sourceId: "project-alpha:coastal", sourceName: "Coastal Survey Services", workspaceId: "workspace-b", workspaceName: "Coastal Construction", projectId: "ops-project-b", projectName: "Seawall construction documentation", projectEndSupported: true};
const targetC = {sourceId: "project-alpha:mountain", sourceName: "Mountain Survey Services", workspaceId: "workspace-c", workspaceName: "Mountain Engineering", projectId: "ops-project-c", projectName: "Bridge inspection", projectEndSupported: false};
const recipientB = {principalPublicId: "principal-shared", displayName: "Casey Coastal", email: "casey@example.test"};
const recipientC = {principalPublicId: "principal-shared", displayName: "Morgan Mountain", email: "morgan@example.test"};
const collaboratorTerms = {kind: "collaborator", mode: "project_end", expiresAt: null};
function grant(overrides: Record<string, unknown> = {}) {return {...targetB, id: grantId, grantId, version: 1, principalPublicId: recipientB.principalPublicId, recipientName: recipientB.displayName, recipientEmail: recipientB.email, status: "active", publicationState: "active", expiresAt: null, accessTerms: collaboratorTerms, effectiveAccessExpiresAt: null, createdAt: "2026-08-26T12:00:00Z", canRevoke: true, ...overrides};}
function preview(operation: Record<string, any>) {const target = operation.sourceId === targetC.sourceId ? targetC : targetB, recipient = operation.sourceId === targetC.sourceId ? recipientC : recipientB; return {operation, contextVersion: previewContext, sourceName: target.sourceName, workspaceName: target.workspaceName, projectName: target.projectName, recipientName: recipient.displayName, recipientEmail: recipient.email, folderName: "Acme deliverables", expiresAt: operation.expiresAt, accessTerms: operation.accessTerms, effectiveAccessExpiresAt: operation.accessTerms?.expiresAt ?? null, projectEndSupported: target.projectEndSupported};}
type Call = {path: string; query: URLSearchParams; method: string; body: any; key?: string};
async function mock(page: Page, override?: (route: Route, call: Call) => Promise<unknown> | undefined, enabled = true) {
  const calls: Call[] = []; let saved: ReturnType<typeof grant> | null = null;
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), call = {path: url.pathname, query: url.searchParams, method: request.method(), body: request.postData() ? request.postDataJSON() : null, key: request.headers()["idempotency-key"]}; calls.push(call);
    const handled = override?.(route, call); if (handled) return handled;
    if (call.path === "/api/session") return route.fulfill({json: {user, csrfToken: "csrf-native", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {deliveryJobsRoot: {enabled: true}, authenticatedDeliveryGrants: {enabled}}}});
    if (call.path === "/api/delivery/folders") return route.fulfill({json: {prefix: call.query.get("prefix") || "Jobs/Clients/", folders: [{id: "folder-acme", prefix: "Jobs/Clients/Acme/", name: "Acme", displayName: "Acme", kind: "folder"}], files: [], nextCursor: null}});
    if (call.path === "/api/delivery/folders/locations") return route.fulfill({json: {points: [], imageCount: 0, truncated: false}});
    if (call.path === "/api/delivery/shares/active") return route.fulfill({json: {share: null}});
    if (call.path === "/api/delivery/shares") return route.fulfill({json: {shares: []}});
    if (call.path === "/api/delivery/authenticated-grants") return route.fulfill({json: {folderBindingId: "binding-primary", sourceId: "project-alpha:primary", projectName: null, accessTermsSupported: false, projectEndSupported: false, grants: []}});
    if (call.path === "/api/delivery/native-grants/targets") return route.fulfill({json: {targets: [targetB, targetC], truncated: false}});
    if (call.path === "/api/delivery/native-grants/recipients") return route.fulfill({json: {recipients: [call.query.get("sourceId") === targetC.sourceId ? recipientC : recipientB], truncated: false}});
    if (call.path === "/api/delivery/native-grants/preview") return route.fulfill({json: {preview: preview(call.body)}});
    if (call.path === "/api/delivery/native-grants" && call.method === "POST") {saved = grant({accessTerms: call.body.accessTerms, expiresAt: call.body.expiresAt, effectiveAccessExpiresAt: call.body.accessTerms?.expiresAt ?? null}); return route.fulfill({json: {grant: saved, replayed: false}});}
    if (call.path === `/api/delivery/native-grants/${grantId}/revoke`) {saved = grant({status: "revoked", publicationState: "revoked", canRevoke: false}); return route.fulfill({json: {grant: saved, replayed: false}});}
    if (call.path === "/api/delivery/native-grants") return route.fulfill({json: {grants: saved ? [saved] : []}});
    return route.fulfill({status: 404, json: {error: "Not found"}});
  });
  return calls;
}
async function openPanel(page: Page) {
  await page.goto("/delivery"); await page.getByRole("button", {name: "Actions for Acme"}).click(); await page.getByRole("menuitem", {name: "Share", exact: true}).click();
  await page.getByRole("button", {name: "Grant to Client Portal"}).click(); await page.getByRole("combobox", {name: "Portal connection"}).selectOption("native");
  await expect(page.getByRole("region", {name: "Connected workspace folder access"})).toBeVisible();
}
async function selectProject(page: Page) {
  await page.getByRole("searchbox", {name: "Find a connected project"}).fill("survey"); await page.getByRole("button", {name: "Search connected projects"}).click();
  await page.getByRole("radio", {name: /Seawall construction documentation/}).check();
}
async function selectRecipient(page: Page) {
  await page.getByRole("searchbox", {name: "Find a verified recipient"}).fill("casey"); await page.getByRole("button", {name: "Search verified recipients"}).click();
  await page.getByRole("radio", {name: /Casey Coastal/}).check();
  await page.getByRole("combobox", {name: "Recipient role"}).selectOption("collaborator");
}
async function review(page: Page) {await selectProject(page); await selectRecipient(page); await page.getByRole("button", {name: "Review connected workspace access"}).click(); await expect(page.getByRole("region", {name: "Review connected workspace access"})).toBeVisible();}
async function late(route: Route, json: unknown) {try {await route.fulfill({json});} catch { /* Request was aborted by a source/context change. */ }}

test("same folder panel reviews exact native source/workspace/project/person then creates and revokes access", async ({page}) => {
  const calls = await mock(page); await openPanel(page); await review(page);
  const confirmation = page.getByRole("region", {name: "Review connected workspace access"});
  await expect(confirmation).toContainText(targetB.sourceName); await expect(confirmation).toContainText(targetB.workspaceName); await expect(confirmation).toContainText(targetB.projectName); await expect(confirmation).toContainText(recipientB.email); await expect(confirmation).toContainText("Acme deliverables");
  await expect(page.getByRole("heading", {name: "Confirm exact folder access"})).toBeFocused();
  await page.getByRole("button", {name: "Grant connected workspace access"}).click();
  await expect(page.getByRole("status").filter({hasText: "Connected workspace access granted"})).toBeVisible();
  const create = calls.find(call => call.path === "/api/delivery/native-grants" && call.method === "POST")!;
  expect(create.body).toEqual({folderRef: "folder-acme", sourceId: targetB.sourceId, workspaceId: targetB.workspaceId, projectId: targetB.projectId, principalPublicId: recipientB.principalPublicId, reasonCode: "client_delivery_access", expiresAt: null, accessTerms: collaboratorTerms, expectedContextVersion: previewContext});
  expect(create.body).not.toHaveProperty("r2Prefix"); expect(create.body).not.toHaveProperty("accountId"); expect(create.key).toMatch(/^[a-f0-9-]{36}$/);
  page.once("dialog", dialog => {expect(dialog.message()).toContain(targetB.workspaceName); return dialog.accept();});
  await page.getByRole("button", {name: /^Revoke connected access\s*: Casey Coastal$/}).click();
  await expect(page.getByRole("status").filter({hasText: "Connected workspace access revoked"})).toBeVisible();
  expect(calls.find(call => call.path.endsWith("/revoke"))?.body).toEqual({folderRef: "folder-acme", expectedVersion: 1, reasonCode: "client_delivery_access"});
  await expect(page.getByRole("button", {name: /^Revoke connected access\s*:/})).toHaveCount(0);
});

test("a customer role is explicitly chosen and retains completed history only for the reviewed grant", async ({page}) => {
  const calls = await mock(page); await openPanel(page); await selectProject(page);
  await page.getByRole("searchbox", {name: "Find a verified recipient"}).fill("casey"); await page.getByRole("button", {name: "Search verified recipients"}).click(); await page.getByRole("radio", {name: /Casey Coastal/}).check();
  await expect(page.getByRole("combobox", {name: "Recipient role"})).toHaveValue(""); await expect(page.getByRole("button", {name: "Review connected workspace access"})).toBeDisabled();
  await page.getByRole("combobox", {name: "Recipient role"}).selectOption("customer"); await expect(page.getByText(/Customers keep access to this folder's completed project history/)).toBeVisible();
  await expect(page.getByRole("combobox", {name: "Collaborator access duration"})).toHaveCount(0);
  await page.getByRole("button", {name: "Review connected workspace access"}).click(); await expect(page.getByRole("region", {name: "Review connected workspace access"})).toContainText("Customer — retained project history until revoked");
  await page.getByRole("button", {name: "Grant connected workspace access"}).click(); await expect(page.getByRole("status").filter({hasText: "access granted"})).toBeVisible();
  expect(calls.find(call => call.path === "/api/delivery/native-grants" && call.method === "POST")?.body.accessTerms).toEqual({kind: "customer", mode: "until_revoked", expiresAt: null});
});

test("supported collaborator completion terms are defaulted and reviewed without promising renewal", async ({page}) => {
  await mock(page); await openPanel(page); await review(page);
  await expect(page.getByRole("combobox", {name: "Collaborator access duration"})).toHaveValue("project_end");
  const confirmation = page.getByRole("region", {name: "Review connected workspace access"});
  await expect(confirmation).toContainText("Awaiting verified project completion, then 7 days"); await expect(confirmation).toContainText("Reopening does not renew expired access.");
});

test("specific dates are required and changing the terms discards the prior review", async ({page}) => {
  const calls = await mock(page); await openPanel(page); await review(page);
  await page.getByRole("combobox", {name: "Collaborator access duration"}).selectOption("specific_date"); await expect(page.getByRole("region", {name: "Review connected workspace access"})).toHaveCount(0);
  await page.getByRole("button", {name: "Review connected workspace access"}).click(); await expect(page.getByRole("alert")).toContainText("valid future expiry date");
  const date = new Date(Date.now() + 7 * 86400000); date.setSeconds(0, 0); const local = new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await page.getByLabel("Connected access expires", {exact: true}).fill(local); await page.getByRole("button", {name: "Review connected workspace access"}).click();
  const last = calls.filter(call => call.path.endsWith("/preview")).at(-1)!;
  expect(last.body.accessTerms).toEqual({kind: "collaborator", mode: "specific_date", expiresAt: date.toISOString()}); expect(last.body.expiresAt).toBe(date.toISOString());
});

test("missing signed completion requires an explicit duration and never guesses until revoked", async ({page}) => {
  await mock(page, (route, call) => call.path.endsWith("/targets") ? route.fulfill({json: {targets: [{...targetB, projectEndSupported: false}], truncated: false}}) : undefined);
  await openPanel(page); await selectProject(page); await selectRecipient(page);
  const duration = page.getByRole("combobox", {name: "Collaborator access duration"}); await expect(duration).toHaveValue(""); await expect(duration.getByRole("option", {name: "Project completion + 7 days"})).toHaveJSProperty("disabled", true);
  await expect(page.getByText(/Verified project completion is not available/)).toBeVisible(); await expect(page.getByRole("button", {name: "Review connected workspace access"})).toBeDisabled();
  await duration.selectOption("until_revoked"); await expect(page.getByText(/will not end automatically/)).toBeVisible(); await expect(page.getByRole("button", {name: "Review connected workspace access"})).toBeEnabled();
});

test("different preview access terms cannot be confirmed and legacy grants stay unclassified", async ({page}) => {
  const calls = await mock(page, (route, call) => {
    if (call.path === "/api/delivery/native-grants" && call.method === "GET") return route.fulfill({json: {grants: [grant({accessTerms: null})]}});
    if (call.path.endsWith("/preview")) return route.fulfill({json: {preview: {...preview(call.body), accessTerms: {kind: "customer", mode: "until_revoked", expiresAt: null}}}});
    return undefined;
  });
  await openPanel(page); await expect(page.getByRole("region", {name: "Connected workspace grant history"})).toContainText("Existing access — unclassified");
  await selectProject(page); await selectRecipient(page); await page.getByRole("button", {name: "Review connected workspace access"}).click();
  await expect(page.getByRole("alert")).toContainText("could not be verified"); await expect(page.getByRole("button", {name: "Grant connected workspace access"})).toHaveCount(0);
  expect(calls.some(call => call.path === "/api/delivery/native-grants" && call.method === "POST")).toBe(false);
});

test("cancelling review writes no native grant", async ({page}) => {
  const calls = await mock(page); await openPanel(page); await review(page); await page.getByRole("button", {name: "Cancel review"}).click();
  await expect(page.getByRole("region", {name: "Review connected workspace access"})).toHaveCount(0);
  expect(calls.filter(call => call.path === "/api/delivery/native-grants" && call.method === "POST")).toHaveLength(0);
});

test("duplicate confirmation clicks issue one grant and lock context selection until it settles", async ({page}) => {
  let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
  const calls = await mock(page, (route, call) => call.path === "/api/delivery/native-grants" && call.method === "POST" ? wait.then(() => late(route, {grant: grant(), replayed: false})) : undefined);
  await openPanel(page); await review(page); await page.getByRole("button", {name: "Grant connected workspace access"}).dblclick();
  expect(calls.filter(call => call.path === "/api/delivery/native-grants" && call.method === "POST")).toHaveLength(1);
  await expect(page.getByRole("combobox", {name: "Portal connection"})).toBeDisabled(); release();
  await expect(page.getByRole("status").filter({hasText: "access granted"})).toBeVisible();
  await expect(page.getByRole("combobox", {name: "Portal connection"})).toBeEnabled();
});

test("source selection change clears an earlier recipient and rejects its late lookup response", async ({page}) => {
  let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
  const calls = await mock(page, (route, call) => call.path.endsWith("/recipients") && call.query.get("sourceId") === targetB.sourceId ? wait.then(() => late(route, {recipients: [recipientB], truncated: false})) : undefined);
  await openPanel(page); await selectProject(page); await page.getByRole("searchbox", {name: "Find a verified recipient"}).fill("casey"); await page.getByRole("button", {name: "Search verified recipients"}).click();
  await expect.poll(() => calls.some(call => call.path.endsWith("/recipients"))).toBe(true);
  await page.getByRole("radio", {name: /Bridge inspection/}).check(); release();
  await expect(page.getByRole("radio", {name: /Casey Coastal/})).toHaveCount(0); await expect(page.getByRole("button", {name: "Review connected workspace access"})).toBeDisabled();
  await page.getByRole("searchbox", {name: "Find a verified recipient"}).fill("morgan"); await page.getByRole("button", {name: "Search verified recipients"}).click(); await expect(page.getByRole("radio", {name: /Morgan Mountain/})).toBeVisible();
  expect(calls.filter(call => call.path.endsWith("/recipients")).at(-1)?.query.get("projectId")).toBe(targetC.projectId);
});

test("mode switching aborts stale native history and preserves the existing primary workflow", async ({page}, testInfo) => {
  let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
  await mock(page, (route, call) => call.path === "/api/delivery/native-grants" && call.method === "GET" ? wait.then(() => late(route, {grants: [grant()]})) : undefined);
  await openPanel(page); await page.getByRole("combobox", {name: "Portal connection"}).selectOption("primary"); release();
  await expect(page.getByRole("combobox", {name: /Organization, department, client, project, or person/})).toBeVisible();
  await expect(page.getByRole("region", {name: "Connected workspace folder access"})).toHaveCount(0); await expect(page.getByText("Casey Coastal", {exact: true})).toHaveCount(0);
  await page.getByRole("combobox", {name: "Portal connection"}).scrollIntoViewIfNeeded();
  await page.screenshot({path: testInfo.outputPath("primary-grant-panel-after-native-switch.png")});
});

test("empty and truncated target searches are explicit and never select recipients automatically", async ({page}) => {
  let empty = true;
  await mock(page, (route, call) => call.path.endsWith("/targets") ? route.fulfill({json: {targets: empty ? [] : [targetB], truncated: !empty}}) : undefined);
  await openPanel(page); await page.getByRole("searchbox", {name: "Find a connected project"}).fill("survey"); await page.getByRole("button", {name: "Search connected projects"}).click();
  await expect(page.getByText("No authorized connected workspace projects match this search.")).toBeVisible();
  empty = false; await page.getByRole("button", {name: "Search connected projects"}).click(); await expect(page.getByText(/More projects match/)).toBeVisible();
  await expect(page.getByRole("radio", {name: /Seawall/})).not.toBeChecked(); await expect(page.getByRole("searchbox", {name: "Find a verified recipient"})).toHaveCount(0);
});

test("native registration unavailable stays an error until explicit refresh succeeds", async ({page}) => {
  let unavailable = true;
  await mock(page, (route, call) => call.path === "/api/delivery/native-grants" && call.method === "GET" && unavailable ? route.fulfill({status: 503, json: {error: "native_delivery_unavailable"}}) : undefined);
  await openPanel(page); await expect(page.getByRole("alert")).toContainText("database update or portal registration may not be ready"); await expect(page.getByText("No connected workspace grants are recorded for this folder.")).toHaveCount(0);
  unavailable = false; await page.getByRole("button", {name: "Refresh folder access"}).click(); await expect(page.getByText("No connected workspace grants are recorded for this folder.")).toBeVisible();
});

for (const status of [401, 403, 409]) test(`native preview ${status} clears selected targets and requires a fresh review`, async ({page}) => {
  await mock(page, (route, call) => call.path.endsWith("/preview") ? route.fulfill({status, json: {error: "Access changed"}}) : undefined);
  await openPanel(page); await selectProject(page); await selectRecipient(page); await page.getByRole("button", {name: "Review connected workspace access"}).click();
  await expect(page.getByRole("alert")).toContainText(status === 401 ? "session expired" : "workspace changed");
  await expect(page.getByRole("button", {name: "Refresh folder access"})).toBeEnabled();
  await expect(page.getByRole("region", {name: "Review connected workspace access"})).toHaveCount(0); await expect(page.getByRole("radio")).toHaveCount(0);
});

test("wrong preview source cannot be confirmed", async ({page}) => {
  const calls = await mock(page, (route, call) => call.path.endsWith("/preview") ? route.fulfill({json: {preview: preview({...call.body, sourceId: targetC.sourceId})}}) : undefined);
  await openPanel(page); await selectProject(page); await selectRecipient(page); await page.getByRole("button", {name: "Review connected workspace access"}).click();
  await expect(page.getByRole("alert")).toContainText("could not be verified"); await expect(page.getByRole("button", {name: "Grant connected workspace access"})).toHaveCount(0);
  expect(calls.filter(call => call.path === "/api/delivery/native-grants" && call.method === "POST")).toHaveLength(0);
});

test("malformed preview proof cannot be used to create a grant", async ({page}) => {
  const calls = await mock(page, (route, call) => call.path.endsWith("/preview") ? route.fulfill({json: {preview: {...preview(call.body), contextVersion: "not-a-context-digest"}}}) : undefined);
  await openPanel(page); await selectProject(page); await selectRecipient(page); await page.getByRole("button", {name: "Review connected workspace access"}).click();
  await expect(page.getByRole("alert")).toContainText("could not be verified"); await expect(page.getByRole("button", {name: "Grant connected workspace access"})).toHaveCount(0);
  expect(calls.filter(call => call.path === "/api/delivery/native-grants" && call.method === "POST")).toHaveLength(0);
});

test("reason validation matches the server and normalizes create and revoke operations", async ({page}) => {
  const calls = await mock(page); await openPanel(page); await selectProject(page); await selectRecipient(page);
  await page.getByRole("textbox", {name: "Connected access reason"}).fill("unsupported:reason");
  await page.getByRole("button", {name: "Review connected workspace access"}).click();
  await expect(page.getByRole("alert")).toContainText("letters, numbers, spaces"); expect(calls.some(call => call.path.endsWith("/preview"))).toBe(false);
  await page.getByRole("textbox", {name: "Connected access reason"}).fill("  Project review - approved.  ");
  await page.getByRole("button", {name: "Review connected workspace access"}).click();
  await expect(page.getByRole("region", {name: "Review connected workspace access"})).toBeVisible();
  expect(calls.find(call => call.path.endsWith("/preview"))?.body.reasonCode).toBe("Project review - approved.");
  await page.getByRole("button", {name: "Grant connected workspace access"}).click();
  await expect(page.getByRole("status").filter({hasText: "access granted"})).toBeVisible();
  page.once("dialog", dialog => dialog.accept()); await page.getByRole("button", {name: /^Revoke connected access\s*: Casey Coastal$/}).click();
  await expect(page.getByRole("status").filter({hasText: "access revoked"})).toBeVisible();
  expect(calls.find(call => call.path.endsWith("/revoke"))?.body).toEqual({folderRef: "folder-acme", expectedVersion: 1, reasonCode: "Project review - approved."});
});

test("uncertain create retry retains the exact idempotency key and body", async ({page}) => {
  let attempt = 0;
  const calls = await mock(page, (route, call) => call.path === "/api/delivery/native-grants" && call.method === "POST" ? ++attempt === 1 ? route.fulfill({status: 503, json: {error: "Temporary uncertainty"}}) : route.fulfill({json: {grant: grant(), replayed: true}}) : undefined);
  await openPanel(page); await review(page); await page.getByRole("button", {name: "Grant connected workspace access"}).click();
  await expect(page.getByRole("alert")).toContainText("result is not confirmed"); await expect(page.getByRole("searchbox", {name: "Find a connected project"})).toBeDisabled();
  await page.getByRole("button", {name: "Refresh folder access"}).click(); await expect(page.getByRole("button", {name: "Retry same operation"})).toBeEnabled();
  await page.getByRole("button", {name: "Retry same operation"}).click(); await expect(page.getByRole("status").filter({hasText: "access granted"})).toBeVisible();
  const writes = calls.filter(call => call.path === "/api/delivery/native-grants" && call.method === "POST"); expect(writes).toHaveLength(2); expect(writes[0]?.key).toBe(writes[1]?.key); expect(writes[0]?.body).toEqual(writes[1]?.body);
});

test("unconfirmed publication requires administrator review rather than another grant", async ({page}) => {
  const calls = await mock(page, (route, call) => call.path === "/api/delivery/native-grants" && call.method === "POST" ? route.fulfill({status: 409, json: {error: "native_delivery_reconciliation_required"}}) : undefined);
  await openPanel(page); await review(page); await page.getByRole("button", {name: "Grant connected workspace access"}).click();
  await expect(page.getByRole("alert")).toContainText("Do not create another grant");
  await expect(page.getByRole("button", {name: "Grant connected workspace access"})).toHaveCount(0);
  await expect(page.getByRole("region", {name: "Connected workspace grant history"})).toHaveCount(0);
  expect(calls.filter(call => call.path === "/api/delivery/native-grants" && call.method === "POST")).toHaveLength(1);
});

test("a reopened panel can cancel unpublished access without activating it", async ({page}) => {
  let cancelled = false;
  const calls = await mock(page, (route, call) => {
    if (call.path === "/api/delivery/native-grants" && call.method === "GET") return route.fulfill({json: {grants: [grant({status: cancelled ? "revoked" : "active", publicationState: cancelled ? "revoked" : "pending", canRevoke: !cancelled})]}});
    if (call.path.endsWith("/revoke")) {cancelled = true; return route.fulfill({json: {grant: grant({status: "revoked", publicationState: "revoked", canRevoke: false}), replayed: false}});}
    return undefined;
  });
  await openPanel(page); const history = page.getByRole("region", {name: "Connected workspace grant history"});
  await expect(history).toContainText("Not published — access is not available"); await expect(history).not.toContainText("active · no expiry");
  page.once("dialog", dialog => {expect(dialog.message()).toContain("does not publish access"); return dialog.accept();});
  await page.getByRole("button", {name: /^Cancel unpublished access\s*: Casey Coastal$/}).click();
  await expect(page.getByRole("status").filter({hasText: "Unpublished access cancelled"})).toBeVisible();
  expect(calls.find(call => call.path.endsWith("/revoke"))?.body).toEqual({folderRef: "folder-acme", expectedVersion: 1, reasonCode: "client_delivery_access"});
  expect(calls.filter(call => call.path === "/api/delivery/native-grants" && call.method === "POST")).toHaveLength(0);
  await expect(history.getByRole("button")).toHaveCount(0);
});

test("uncertain create refresh supports cancellation and uncertain cancel retries only its exact revoke", async ({page}) => {
  let createAttempted = false, cancelAttempts = 0;
  const calls = await mock(page, (route, call) => {
    if (call.path === "/api/delivery/native-grants" && call.method === "POST") {createAttempted = true; return route.fulfill({status: 503, json: {error: "Unconfirmed save"}});}
    if (call.path === "/api/delivery/native-grants" && call.method === "GET") return route.fulfill({json: {grants: createAttempted ? [grant({status: cancelAttempts > 1 ? "revoked" : "active", publicationState: cancelAttempts > 1 ? "revoked" : "pending", canRevoke: cancelAttempts < 2})] : []}});
    if (call.path.endsWith("/revoke")) return ++cancelAttempts === 1 ? route.fulfill({status: 503, json: {error: "Unconfirmed cancellation"}}) : route.fulfill({json: {grant: grant({status: "revoked", publicationState: "revoked", canRevoke: false}), replayed: true}});
    return undefined;
  });
  await openPanel(page); await review(page); await page.getByRole("button", {name: "Grant connected workspace access"}).click();
  await expect(page.getByRole("alert")).toContainText("result is not confirmed");
  await page.getByRole("button", {name: "Refresh folder access"}).click();
  await expect(page.getByText("Not published — access is not available", {exact: false})).toBeVisible();
  await expect(page.getByRole("button", {name: "Grant connected workspace access"})).toBeDisabled();
  page.once("dialog", dialog => {expect(dialog.message()).toContain("will no longer be retried"); return dialog.accept();});
  const cancel = page.getByRole("button", {name: /^Cancel unpublished access\s*: Casey Coastal$/}); await cancel.click();
  await expect(page.getByRole("button", {name: "Retry same operation"})).toBeEnabled(); await expect(cancel).toBeDisabled();
  await page.getByRole("button", {name: "Retry same operation"}).click();
  await expect(page.getByRole("status").filter({hasText: "Unpublished access cancelled"})).toBeVisible();
  const revokes = calls.filter(call => call.path.endsWith("/revoke")); expect(revokes).toHaveLength(2); expect(revokes[0]?.key).toBe(revokes[1]?.key); expect(revokes[0]?.body).toEqual(revokes[1]?.body);
  const creates = calls.filter(call => call.path === "/api/delivery/native-grants" && call.method === "POST"); expect(creates).toHaveLength(1); expect(revokes[0]?.key).not.toBe(creates[0]?.key);
  await expect(page.getByRole("button", {name: "Retry same operation"})).toHaveCount(0);
});

test("grant feature flag off does not probe native endpoints", async ({page}) => {
  const calls = await mock(page, undefined, false); await page.goto("/delivery"); await page.getByRole("button", {name: "Actions for Acme"}).click(); await page.getByRole("menuitem", {name: "Share", exact: true}).click();
  await expect(page.getByRole("button", {name: "Grant to Client Portal"})).toHaveCount(0); expect(calls.some(call => call.path.startsWith("/api/delivery/native-grants"))).toBe(false);
});

for (const width of [375, 640, 1280, 3440]) test(`connected folder grant review is readable at ${width}px`, async ({page}, testInfo) => {
  await page.setViewportSize({width, height: 960}); await mock(page); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await openPanel(page);
  for (const input of [page.getByRole("combobox", {name: "Portal connection"}), page.getByRole("searchbox", {name: "Find a connected project"})]) {await expect(input).toBeVisible(); expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(44); await expect(input).toHaveCSS("border-radius", "8px");}
  await page.getByRole("combobox", {name: "Portal connection"}).scrollIntoViewIfNeeded(); await page.screenshot({path: testInfo.outputPath(`native-grant-inputs-${width}.png`)});
  await review(page); const reviewPanel = page.getByRole("region", {name: "Review connected workspace access"}); await reviewPanel.scrollIntoViewIfNeeded();
  expect(await page.locator("body").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(reviewPanel.getByRole("button", {name: "Grant connected workspace access"})).toBeVisible();
  await page.screenshot({path: testInfo.outputPath(`native-grant-review-${width}.png`)}); expect(errors).toEqual([]);
});
