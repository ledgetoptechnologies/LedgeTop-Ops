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
type Target = typeof targetB;
const division = (sourceId: string) => `Project Alpha (${sourceId.split(":")[1]})`;
/** A connected-workspace person as the combined client search returns them. */
function person(recipient: typeof recipientB, target: Target) {
  return {key: JSON.stringify(["native", target.sourceId, target.workspaceId, "principal", recipient.principalPublicId]), backend: "native", sourceId: target.sourceId,
    divisionLabel: division(target.sourceId), workspaceId: target.workspaceId, workspaceName: target.workspaceName, audienceType: "principal", publicId: recipient.principalPublicId,
    displayName: recipient.displayName, email: recipient.email};
}
const noneTruncated = {principal: false, organization: false, department: false, client: false, connected: false};
const found = (recipients: unknown[], extra: Record<string, unknown> = {}) => ({recipients, primary: "ready", native: "ready", truncated: noneTruncated, ...extra});
/** The per-person project lookup the panel calls once a person is chosen. */
const projectsOf = (targets: Target[], extra: Record<string, unknown> = {}) => ({projects: targets.map(item => ({projectId: item.projectId, projectName: item.projectName, projectEndSupported: item.projectEndSupported})), bound: false, complete: true, ...extra});
const primaryOrganization = {key: JSON.stringify(["primary", "project-alpha:primary", "workspace-primary", "organization", "org-acme"]), backend: "primary", sourceId: "project-alpha:primary",
  divisionLabel: "Ledge Top Drone Services", workspaceId: "workspace-primary", workspaceName: "Acme Workspace", audienceType: "organization", publicId: "org-acme",
  displayName: "Acme Organization", email: null, folderBindingId: "binding-primary"};
type Call = {path: string; query: URLSearchParams; method: string; body: any; key?: string};
async function mock(page: Page, override?: (route: Route, call: Call) => Promise<unknown> | undefined, enabled = true) {
  const calls: Call[] = []; let saved: ReturnType<typeof grant> | null = null;
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), call = {path: url.pathname, query: url.searchParams, method: request.method(), body: request.postData() ? request.postDataJSON() : null, key: request.headers()["idempotency-key"]}; calls.push(call);
    const handled = override?.(route, call); if (handled) return handled;
    if (call.path === "/api/session") return route.fulfill({json: {user, csrfToken: "csrf-native", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {deliveryJobsRoot: {enabled: true}, authenticatedDeliveryGrants: {enabled, creationEnabled: enabled}}}});
    if (call.path === "/api/delivery/folders") return route.fulfill({json: {prefix: call.query.get("prefix") || "Jobs/Clients/", folders: [{id: "folder-acme", prefix: "Jobs/Clients/Acme/", name: "Acme", displayName: "Acme", kind: "folder"}], files: [], nextCursor: null}});
    if (call.path === "/api/delivery/folders/locations") return route.fulfill({json: {points: [], imageCount: 0, truncated: false}});
    if (call.path === "/api/delivery/shares/active") return route.fulfill({json: {share: null}});
    if (call.path === "/api/delivery/shares") return route.fulfill({json: {shares: []}});
    if (call.path === "/api/delivery/authenticated-grants") return route.fulfill({json: {folderBindingId: "binding-primary", sourceId: "project-alpha:primary", projectName: null, accessTermsSupported: false, projectEndSupported: false, grants: []}});
    if (call.path === "/api/delivery/client-share-recipients") {const q = (call.query.get("q") || "").toLowerCase(); return route.fulfill({json: found([person(recipientB, targetB), person(recipientC, targetC)].filter(row => row.displayName.toLowerCase().includes(q) || row.email.includes(q)))});}
    if (call.path === "/api/delivery/client-share-recipients/projects") return route.fulfill({json: projectsOf([call.query.get("workspaceId") === targetC.workspaceId ? targetC : targetB])});
    if (call.path === "/api/delivery/native-grants/preview") return route.fulfill({json: {preview: preview(call.body)}});
    if (call.path === "/api/delivery/native-grants" && call.method === "POST") {saved = grant({accessTerms: call.body.accessTerms, expiresAt: call.body.expiresAt, effectiveAccessExpiresAt: call.body.accessTerms?.expiresAt ?? null}); return route.fulfill({json: {grant: saved, replayed: false}});}
    if (call.path === `/api/delivery/native-grants/${grantId}/revoke`) {saved = grant({status: "revoked", publicationState: "revoked", canRevoke: false}); return route.fulfill({json: {grant: saved, replayed: false}});}
    if (call.path === "/api/delivery/native-grants") return route.fulfill({json: {grants: saved ? [saved] : []}});
    return route.fulfill({status: 404, json: {error: "Not found"}});
  });
  return calls;
}
const client = (page: Page) => page.getByRole("combobox", {name: "Client", exact: true});
const accessList = (page: Page) => page.getByLabel("Client access for this folder");
async function openPanel(page: Page) {
  await page.goto("/delivery"); await page.getByRole("button", {name: "Actions for Acme"}).click(); await page.getByRole("menuitem", {name: "Share", exact: true}).click();
  await page.getByRole("tab", {name: "Client Workspace"}).click();
  await expect(client(page)).toBeEnabled();
  // Sizes are measured once the dialog has finished scaling in.
  await page.locator("dialog[open]").evaluate(element => Promise.all(element.getAnimations({subtree: true}).map(animation => animation.finished)));
  await expect(page.getByRole("combobox", {name: "Portal connection"})).toHaveCount(0);
}
async function pick(page: Page, query: string, name: RegExp) {await client(page).fill(query); await page.getByRole("option", {name}).click();}
async function selectRecipient(page: Page) {
  await pick(page, "casey", /Casey Coastal/);
  await page.getByRole("combobox", {name: "Recipient role"}).selectOption("collaborator");
}
async function review(page: Page) {await selectRecipient(page); await page.getByRole("button", {name: "Review connected workspace access"}).click(); await expect(page.getByRole("region", {name: "Review connected workspace access"})).toBeVisible();}
async function late(route: Route, json: unknown) {try {await route.fulfill({json});} catch { /* Request was aborted by a source/context change. */ }}

test("one client search routes a connected-workspace person to its own review, create and revoke", async ({page}) => {
  const calls = await mock(page); await openPanel(page);
  await client(page).fill("casey");
  const option = page.getByRole("option", {name: /Casey Coastal/}); await expect(option).not.toContainText(division(targetB.sourceId)); await expect(option).toContainText(targetB.workspaceName);
  await option.click();
  await expect(page.getByText(`Project (the only one available for this person): ${targetB.projectName}`, {exact: false})).toBeVisible();
  await page.getByRole("combobox", {name: "Recipient role"}).selectOption("collaborator");
  await page.getByRole("button", {name: "Review connected workspace access"}).click();
  const confirmation = page.getByRole("region", {name: "Review connected workspace access"});
  await expect(confirmation).not.toContainText(targetB.sourceName); await expect(confirmation).toContainText(targetB.workspaceName); await expect(confirmation).toContainText(targetB.projectName); await expect(confirmation).toContainText(recipientB.email); await expect(confirmation).toContainText("Acme deliverables");
  await expect(page.getByRole("heading", {name: "Confirm exact folder access"})).toBeFocused();
  await page.getByRole("button", {name: "Grant connected workspace access"}).click();
  await expect(page.getByRole("status").filter({hasText: "Connected workspace access granted"})).toBeVisible();
  const create = calls.find(call => call.path === "/api/delivery/native-grants" && call.method === "POST")!;
  expect(create.body).toEqual({folderRef: "folder-acme", sourceId: targetB.sourceId, workspaceId: targetB.workspaceId, projectId: targetB.projectId, principalPublicId: recipientB.principalPublicId, reasonCode: "client_delivery_access", expiresAt: null, accessTerms: collaboratorTerms, expectedContextVersion: previewContext});
  expect(create.body).not.toHaveProperty("r2Prefix"); expect(create.body).not.toHaveProperty("accountId"); expect(create.key).toMatch(/^[a-f0-9-]{36}$/);
  expect(calls.find(call => call.path === "/api/delivery/client-share-recipients")?.query.get("folderRef")).toBe("folder-acme");
  // A connected-workspace person never reaches the primary grant routes.
  expect(calls.some(call => call.path.startsWith("/api/delivery/authenticated-grants") && call.method === "POST")).toBe(false);
  await expect(accessList(page)).toContainText(`${targetB.workspaceName} · ${targetB.projectName}`); await expect(accessList(page)).not.toContainText(division(targetB.sourceId));
  page.once("dialog", dialog => {expect(dialog.message()).toContain(targetB.workspaceName); return dialog.accept();});
  await page.getByRole("button", {name: /^Revoke connected access\s*: Casey Coastal$/}).click();
  await expect(page.getByRole("status").filter({hasText: "Connected workspace access revoked"})).toBeVisible();
  expect(calls.find(call => call.path.endsWith("/revoke"))?.body).toEqual({folderRef: "folder-acme", expectedVersion: 1, reasonCode: "client_delivery_access"});
  await expect(page.getByRole("button", {name: /^Revoke connected access\s*:/})).toHaveCount(0);
});

test("a person with several projects must choose one before review", async ({page}) => {
  const annex = {...targetB, projectId: "ops-project-annex", projectName: "Seawall annex", projectEndSupported: false};
  const calls = await mock(page, (route, call) => call.path === "/api/delivery/client-share-recipients/projects" ? route.fulfill({json: projectsOf([targetB, annex])}) : undefined);
  await openPanel(page); await selectRecipient(page);
  const choices = page.getByRole("group", {name: "Project for Casey Coastal"});
  await expect(choices.getByRole("radio")).toHaveCount(2); await expect(choices.getByRole("radio", {checked: true})).toHaveCount(0);
  await expect(page.getByRole("button", {name: "Review connected workspace access"})).toBeDisabled();
  await choices.getByRole("radio", {name: /Seawall annex/}).check();
  await page.getByRole("combobox", {name: "Recipient role"}).selectOption("collaborator");
  await page.getByRole("combobox", {name: "Collaborator access duration"}).selectOption("until_revoked");
  await page.getByRole("button", {name: "Review connected workspace access"}).click();
  expect(calls.find(call => call.path.endsWith("/preview"))?.body).toMatchObject({sourceId: targetB.sourceId, workspaceId: targetB.workspaceId, projectId: annex.projectId, principalPublicId: recipientB.principalPublicId});
});

test("a customer role is explicitly chosen and retains completed history only for the reviewed grant", async ({page}) => {
  const calls = await mock(page); await openPanel(page); await pick(page, "casey", /Casey Coastal/);
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
  await mock(page, (route, call) => call.path === "/api/delivery/client-share-recipients/projects" ? route.fulfill({json: projectsOf([{...targetB, projectEndSupported: false}])}) : undefined);
  await openPanel(page); await selectRecipient(page);
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
  await openPanel(page); await expect(accessList(page)).toContainText("Existing access — unclassified");
  await selectRecipient(page); await page.getByRole("button", {name: "Review connected workspace access"}).click();
  await expect(page.getByRole("alert")).toContainText("could not be verified"); await expect(page.getByRole("button", {name: "Grant connected workspace access"})).toHaveCount(0);
  expect(calls.some(call => call.path === "/api/delivery/native-grants" && call.method === "POST")).toBe(false);
});

test("cancelling review writes no native grant", async ({page}) => {
  const calls = await mock(page); await openPanel(page); await review(page); await page.getByRole("button", {name: "Cancel review"}).click();
  await expect(page.getByRole("region", {name: "Review connected workspace access"})).toHaveCount(0);
  expect(calls.filter(call => call.path === "/api/delivery/native-grants" && call.method === "POST")).toHaveLength(0);
});

test("duplicate confirmation clicks issue one grant and lock client selection until it settles", async ({page}) => {
  let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
  const calls = await mock(page, (route, call) => call.path === "/api/delivery/native-grants" && call.method === "POST" ? wait.then(() => late(route, {grant: grant(), replayed: false})) : undefined);
  await openPanel(page); await review(page); await page.getByRole("button", {name: "Grant connected workspace access"}).dblclick();
  expect(calls.filter(call => call.path === "/api/delivery/native-grants" && call.method === "POST")).toHaveLength(1);
  await expect(client(page)).toBeDisabled(); release();
  await expect(page.getByRole("status").filter({hasText: "access granted"})).toBeVisible();
  await expect(client(page)).toBeEnabled();
});

test("choosing another person clears the earlier terms and review and uses that person's own project", async ({page}) => {
  const calls = await mock(page); await openPanel(page); await review(page);
  await pick(page, "morgan", /Morgan Mountain/);
  await expect(page.getByRole("region", {name: "Review connected workspace access"})).toHaveCount(0);
  await expect(page.getByRole("combobox", {name: "Recipient role"})).toHaveValue("");
  await expect(page.getByText(`Project (the only one available for this person): ${targetC.projectName}`, {exact: false})).toBeVisible();
  await page.getByRole("combobox", {name: "Recipient role"}).selectOption("customer"); await page.getByRole("button", {name: "Review connected workspace access"}).click();
  expect(calls.filter(call => call.path.endsWith("/preview")).at(-1)?.body).toMatchObject({sourceId: targetC.sourceId, workspaceId: targetC.workspaceId, projectId: targetC.projectId});
});

test("a Drone Services client opens the Drone Services steps and a connected person opens the connected steps", async ({page}, testInfo) => {
  const calls = await mock(page, (route, call) => call.path === "/api/delivery/client-share-recipients" ? route.fulfill({json: found([primaryOrganization, person(recipientB, targetB)])}) : undefined);
  await openPanel(page); await client(page).fill("ac");
  await expect(page.getByRole("option", {name: /Acme Organization/})).toContainText("Acme Workspace");
  await expect(page.getByRole("dialog")).not.toContainText(/Drone Services|Technologies|Coastal Survey Services|Mountain Survey Services/);
  await page.getByRole("option", {name: /Acme Organization/}).click();
  await expect(page.getByRole("button", {name: "Review authenticated access"})).toBeVisible();
  await expect(page.getByRole("button", {name: "Review connected workspace access"})).toHaveCount(0);
  await page.screenshot({path: testInfo.outputPath("unified-primary-selection.png")});
  await pick(page, "casey", /Casey Coastal/);
  await expect(page.getByRole("button", {name: "Review connected workspace access"})).toBeVisible();
  await expect(page.getByRole("button", {name: "Review authenticated access"})).toHaveCount(0);
  expect(calls.some(call => call.path.startsWith("/api/delivery/native-grants/") && call.method === "POST")).toBe(false);
});

test("a row whose division disagrees with its back end is refused before any review", async ({page}) => {
  const smuggled = {...person(recipientB, targetB), backend: "primary", key: JSON.stringify(["primary", targetB.sourceId, targetB.workspaceId, "principal", recipientB.principalPublicId]), folderBindingId: "binding-primary"};
  const calls = await mock(page, (route, call) => call.path === "/api/delivery/client-share-recipients" ? route.fulfill({json: found([smuggled])}) : undefined);
  await openPanel(page); await client(page).fill("casey");
  await expect(page.getByRole("alert")).toContainText("could not be verified"); await expect(page.getByRole("option")).toHaveCount(0);
  expect(calls.some(call => call.path.endsWith("/preview"))).toBe(false);
});

test("empty and truncated client searches are explicit and never select a client automatically", async ({page}) => {
  let empty = true;
  await mock(page, (route, call) => call.path === "/api/delivery/client-share-recipients" ? route.fulfill({json: found(empty ? [] : [person(recipientB, targetB)], {truncated: {...noneTruncated, connected: !empty}})}) : undefined);
  await openPanel(page); await client(page).fill("survey");
  await expect(page.getByText("No client you can share with matches this search.")).toBeVisible();
  empty = false; await client(page).fill("surveys"); await expect(page.getByText(/Some connected-workspace clients may not be listed/)).toBeVisible();
  await expect(page.getByRole("option", {name: /Casey Coastal/})).toHaveAttribute("aria-selected", "false");
  await expect(page.getByRole("combobox", {name: "Recipient role"})).toHaveCount(0);
});

test("native registration unavailable stays a visible error, never an empty list, until refresh succeeds", async ({page}) => {
  let unavailable = true;
  await mock(page, (route, call) => call.path === "/api/delivery/native-grants" && call.method === "GET" ? unavailable ? route.fulfill({status: 503, json: {error: "native_delivery_unavailable"}}) : route.fulfill({json: {grants: [grant()]}}) : undefined);
  await openPanel(page); await expect(page.getByRole("alert")).toContainText("database update or portal registration may not be ready");
  await expect(page.getByText("No client access is recorded for this folder.")).toHaveCount(0); await expect(accessList(page)).not.toContainText("Casey Coastal");
  unavailable = false; await page.getByRole("button", {name: "Refresh access"}).click(); await expect(accessList(page)).toContainText("Casey Coastal");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("nothing granted, a moved folder, and a failed half of the search each say so", async ({page}) => {
  let nativeStatus = 200, failedHalf = false;
  await mock(page, (route, call) => {
    if (call.path === "/api/delivery/native-grants" && call.method === "GET" && nativeStatus === 404) return route.fulfill({status: 404, json: {error: "Not found"}});
    if (call.path === "/api/delivery/client-share-recipients" && failedHalf) return route.fulfill({json: found([person(recipientB, targetB)], {primary: "failed"})});
    return undefined;
  });
  await openPanel(page); await expect(page.getByText("No client access is recorded for this folder.")).toBeVisible();
  nativeStatus = 404; await page.getByRole("button", {name: "Refresh access"}).click();
  await expect(page.getByRole("status").filter({hasText: "could not be found for connected-workspace sharing"})).toBeVisible();
  // A missing folder is not "nothing granted".
  await expect(page.getByText("No client access is recorded for this folder.")).toHaveCount(0);
  failedHalf = true; await client(page).fill("casey");
  await expect(page.getByRole("alert").filter({hasText: "Some clients could not be searched right now"})).toBeVisible();
  await expect(page.getByRole("dialog")).not.toContainText(/Drone Services|Technologies/);
  await expect(page.getByRole("option", {name: /Casey Coastal/})).toBeVisible();
});

test("a partial project list never picks a project and offers a project search", async ({page}) => {
  const annex = {...targetB, projectId: "ops-project-annex", projectName: "Seawall annex"};
  const calls = await mock(page, (route, call) => call.path === "/api/delivery/client-share-recipients/projects"
    ? route.fulfill({json: call.query.get("q") ? projectsOf([annex], {complete: false}) : projectsOf([targetB], {complete: false})}) : undefined);
  await openPanel(page); await pick(page, "casey", /Casey Coastal/);
  await expect(page.getByText(/More projects may match/)).toBeVisible();
  await expect(page.getByText(/the only one available/)).toHaveCount(0);
  await expect(page.getByRole("radio", {name: /Seawall construction documentation/})).not.toBeChecked();
  await page.getByRole("searchbox", {name: "Find a project"}).fill("annex"); await page.getByRole("button", {name: "Search projects"}).click();
  await page.getByRole("radio", {name: /Seawall annex/}).check();
  await page.getByRole("combobox", {name: "Recipient role"}).selectOption("customer"); await page.getByRole("button", {name: "Review connected workspace access"}).click();
  expect(calls.find(call => call.path.endsWith("/projects") && call.query.get("q") === "annex")?.query.get("principalPublicId")).toBe(recipientB.principalPublicId);
  expect(calls.filter(call => call.path.endsWith("/preview")).at(-1)?.body.projectId).toBe(annex.projectId);
});

test("a folder already linked to a project offers only that project", async ({page}) => {
  await mock(page, (route, call) => call.path === "/api/delivery/client-share-recipients/projects" ? route.fulfill({json: projectsOf([targetB], {bound: true})}) : undefined);
  await openPanel(page); await pick(page, "casey", /Casey Coastal/);
  await expect(page.getByText(`Project (this folder is already linked to it): ${targetB.projectName}`, {exact: false})).toBeVisible();
  await expect(page.getByRole("searchbox", {name: "Find a project"})).toHaveCount(0);
});

test("choosing a connected-workspace person ends an open Drone Services restore, so only one form shows", async ({page}) => {
  const revoked = {id: "grant-primary-v1", grantId: "grant-primary", version: 1, audience: {type: "organization", publicId: "org-acme"}, audienceLabel: "Acme Organization", workspaceLabel: "Acme Workspace",
    status: "revoked", expiresAt: null, accessTerms: null, effectiveAccessExpiresAt: null, recipientCount: 0, dynamicAudience: true, updatedAt: "2026-08-26T12:00:00Z"};
  await mock(page, (route, call) => call.path === "/api/delivery/authenticated-grants" && call.method === "GET"
    ? route.fulfill({json: {folderBindingId: "binding-primary", sourceId: "project-alpha:primary", projectName: null, accessTermsSupported: false, projectEndSupported: false, grants: [revoked]}}) : undefined);
  await openPanel(page); await page.getByRole("button", {name: "Restore as new version"}).click();
  await expect(page.getByRole("status").filter({hasText: "Reviewing a new version for Acme Organization"})).toBeVisible();
  await pick(page, "casey", /Casey Coastal/);
  await expect(page.getByRole("status").filter({hasText: "Reviewing a new version"})).toHaveCount(0);
  await expect(page.getByRole("button", {name: "Review authenticated access"})).toHaveCount(0);
  await expect(page.getByRole("button", {name: "Review connected workspace access"})).toBeVisible();
});

for (const status of [401, 403, 409]) test(`native preview ${status} clears the selected project and requires a fresh review`, async ({page}) => {
  await mock(page, (route, call) => call.path.endsWith("/preview") ? route.fulfill({status, json: {error: "Access changed"}}) : undefined);
  await openPanel(page); await selectRecipient(page); await page.getByRole("button", {name: "Review connected workspace access"}).click();
  await expect(page.getByRole("alert")).toContainText(status === 401 ? "session expired" : "workspace changed");
  await expect(page.getByRole("button", {name: "Refresh access"})).toBeEnabled();
  await expect(page.getByRole("region", {name: "Review connected workspace access"})).toHaveCount(0); await expect(page.getByRole("combobox", {name: "Recipient role"})).toHaveCount(0);
});

test("wrong preview source cannot be confirmed", async ({page}) => {
  const calls = await mock(page, (route, call) => call.path.endsWith("/preview") ? route.fulfill({json: {preview: preview({...call.body, sourceId: targetC.sourceId})}}) : undefined);
  await openPanel(page); await selectRecipient(page); await page.getByRole("button", {name: "Review connected workspace access"}).click();
  await expect(page.getByRole("alert")).toContainText("could not be verified"); await expect(page.getByRole("button", {name: "Grant connected workspace access"})).toHaveCount(0);
  expect(calls.filter(call => call.path === "/api/delivery/native-grants" && call.method === "POST")).toHaveLength(0);
});

test("malformed preview proof cannot be used to create a grant", async ({page}) => {
  const calls = await mock(page, (route, call) => call.path.endsWith("/preview") ? route.fulfill({json: {preview: {...preview(call.body), contextVersion: "not-a-context-digest"}}}) : undefined);
  await openPanel(page); await selectRecipient(page); await page.getByRole("button", {name: "Review connected workspace access"}).click();
  await expect(page.getByRole("alert")).toContainText("could not be verified"); await expect(page.getByRole("button", {name: "Grant connected workspace access"})).toHaveCount(0);
  expect(calls.filter(call => call.path === "/api/delivery/native-grants" && call.method === "POST")).toHaveLength(0);
});

test("reason validation matches the server and normalizes create and revoke operations", async ({page}) => {
  const calls = await mock(page); await openPanel(page); await selectRecipient(page);
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
  // The reason field belongs to the cleared person's form; revoke keeps the panel's own reason value.
  expect(calls.find(call => call.path.endsWith("/revoke"))?.body).toMatchObject({folderRef: "folder-acme", expectedVersion: 1});
});

test("uncertain create retry retains the exact idempotency key and body", async ({page}) => {
  let attempt = 0;
  const calls = await mock(page, (route, call) => call.path === "/api/delivery/native-grants" && call.method === "POST" ? ++attempt === 1 ? route.fulfill({status: 503, json: {error: "Temporary uncertainty"}}) : route.fulfill({json: {grant: grant(), replayed: true}}) : undefined);
  await openPanel(page); await review(page); await page.getByRole("button", {name: "Grant connected workspace access"}).click();
  await expect(page.getByRole("alert")).toContainText("result is not confirmed"); await expect(client(page)).toBeDisabled(); await expect(page.getByRole("button", {name: "Refresh access"})).toBeDisabled();
  await page.getByRole("button", {name: "Refresh folder access"}).click(); await expect(page.getByRole("button", {name: "Retry same operation"})).toBeEnabled();
  await page.getByRole("button", {name: "Retry same operation"}).click(); await expect(page.getByRole("status").filter({hasText: "access granted"})).toBeVisible();
  const writes = calls.filter(call => call.path === "/api/delivery/native-grants" && call.method === "POST"); expect(writes).toHaveLength(2); expect(writes[0]?.key).toBe(writes[1]?.key); expect(writes[0]?.body).toEqual(writes[1]?.body);
});

test("unconfirmed publication requires administrator review rather than another grant", async ({page}) => {
  const calls = await mock(page, (route, call) => call.path === "/api/delivery/native-grants" && call.method === "POST" ? route.fulfill({status: 409, json: {error: "native_delivery_reconciliation_required"}}) : undefined);
  await openPanel(page); await review(page); await page.getByRole("button", {name: "Grant connected workspace access"}).click();
  await expect(page.getByRole("alert")).toContainText("Do not create another grant");
  await expect(page.getByRole("button", {name: "Grant connected workspace access"})).toHaveCount(0);
  await expect(accessList(page)).not.toContainText("Casey Coastal");
  expect(calls.filter(call => call.path === "/api/delivery/native-grants" && call.method === "POST")).toHaveLength(1);
});

test("a reopened panel can cancel unpublished access without activating it", async ({page}) => {
  let cancelled = false;
  const calls = await mock(page, (route, call) => {
    if (call.path === "/api/delivery/native-grants" && call.method === "GET") return route.fulfill({json: {grants: [grant({status: cancelled ? "revoked" : "active", publicationState: cancelled ? "revoked" : "pending", canRevoke: !cancelled})]}});
    if (call.path.endsWith("/revoke")) {cancelled = true; return route.fulfill({json: {grant: grant({status: "revoked", publicationState: "revoked", canRevoke: false}), replayed: false}});}
    return undefined;
  });
  await openPanel(page); const history = accessList(page);
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
  const workspaceTab = page.getByRole("tab", {name: "Client Workspace"});
  await expect(workspaceTab).toBeDisabled();
  await expect(workspaceTab).toHaveAttribute("title", "Client Workspace sharing is not enabled for this deployment.");
  expect(calls.some(call => call.path.startsWith("/api/delivery/native-grants") || call.path.startsWith("/api/delivery/client-share-recipients"))).toBe(false);
});

for (const width of [375, 640, 1280, 3440]) test(`connected folder grant review is readable at ${width}px`, async ({page}, testInfo) => {
  await page.setViewportSize({width, height: 960}); await mock(page); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await openPanel(page);
  const input = client(page); await expect(input).toBeVisible(); expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(44); await expect(input).toHaveCSS("border-radius", "8px");
  await input.fill("casey"); const list = page.getByRole("listbox", {name: "Matching clients"}); await expect(list).toBeVisible();
  const box = (await list.boundingBox())!; expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
  await input.scrollIntoViewIfNeeded(); await page.screenshot({path: testInfo.outputPath(`native-grant-inputs-${width}.png`)});
  await input.fill("");
  await review(page); const reviewPanel = page.getByRole("region", {name: "Review connected workspace access"}); await reviewPanel.scrollIntoViewIfNeeded();
  expect(await page.locator("body").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(reviewPanel.getByRole("button", {name: "Grant connected workspace access"})).toBeVisible();
  await page.screenshot({path: testInfo.outputPath(`native-grant-review-${width}.png`)}); expect(errors).toEqual([]);
});
