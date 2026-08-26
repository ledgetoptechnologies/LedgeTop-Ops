import { expect, test, type Page, type Route } from "@playwright/test";
import type { AddressBookContact } from "../../src/client/address-book-api";

const sourceId = "project-alpha:primary", contextVersion = "a".repeat(64);
const workspaces = [{id: "workspace-a", rootType: "organization", rootPublicId: "org-a", displayName: "Acme Construction"}, {id: "workspace-b", rootType: "organization", rootPublicId: "org-b", displayName: "Mountain Engineering"}];
const jane = (overrides: Partial<AddressBookContact> = {}): AddressBookContact => ({id: "contact-jane", workspaceId: "workspace-a", sourceId, displayName: "Jane Electrician", email: "jane@example.test", phone: "+1 555 0100", company: "Jane Electrical", roleOrTrade: "Electrician", version: 1, createdAt: "2026-08-27T12:00:00Z", updatedAt: "2026-08-27T12:00:00Z", previousInvitation: {status: "accepted", lastInvitedAt: "2026-08-20T12:00:00Z"}, ...overrides});
function access(id = "workspace-a", enabled = true) {return {sourceId, sourceName: "Project Alpha", workspaceName: workspaces.find(value => value.id === id)!.displayName, canManageMembers: true, members: [], invitations: [], invitationRequestsSupported: false, invitationPolicy: {mode: "allowed", version: 1}, projectAccessTermsSupported: true, projectAccessOptions: [{projectPublicId: `project-${id}`, projectEndSupported: true}], inviteScopes: [{type: "project", publicId: `project-${id}`, displayName: id === "workspace-a" ? "North seawall" : "Mountain bridge", capabilities: ["delivery.view"], projectEndSupported: true}], addressBookAvailable: enabled, canManageAddressBook: enabled};}
type Call = {path: string; method: string; body: any; key?: string; url: string};
type Handler = (route: Route, call: Call) => Promise<unknown> | undefined;

async function fixture(page: Page, handler?: Handler, enabled = true) {
  const calls: Call[] = []; let contacts: AddressBookContact[] = [jane()];
  await page.route("**/api/client/**", async route => {
    const request = route.request(), url = new URL(request.url()), call: Call = {path: url.pathname, method: request.method(), body: request.postData() ? request.postDataJSON() : null, key: request.headers()["idempotency-key"], url: request.url()}; calls.push(call);
    const handled = handler?.(route, call); if (handled) return handled;
    if (call.path === "/api/client/session") return route.fulfill({json: {account: {id: "account-a", displayName: "Acme Construction"}, capabilities: {workspaceHierarchyV2: true, workspaceMembershipManagement: true, hierarchyScopedInvitations: true, invitationEmailDelivery: true}}});
    if (call.path === "/api/client/v2/workspaces") return route.fulfill({json: {workspaces}});
    if (call.path === "/api/client/projects") return route.fulfill({json: {projects: []}});
    if (call.path === "/api/client/service-requests") return route.fulfill({json: {requests: []}});
    if (call.path === "/api/client/map-config") return route.fulfill({json: {mapboxPublicToken: null}});
    if (call.path === "/api/client/notifications") return route.fulfill({json: {notifications: [], unreadCount: 0, cursor: null}});
    if (call.path === "/api/client/request-readiness") return route.fulfill({json: {mode: "legacy", workspaceId: "workspace-a", target: {kind: "root", projectId: null}, canStartRequest: false, reason: "request_not_permitted", root: {canStartRequest: false, reason: "request_not_permitted"}, projectRequestsSupported: false, refreshedAt: "2026-08-27T12:00:00Z"}});
    const accessMatch = call.path.match(/^\/api\/client\/v2\/workspaces\/(workspace-[ab])\/access$/);
    if (accessMatch) return route.fulfill({json: access(accessMatch[1]!, enabled)});
    const search = call.path.match(/^\/api\/client\/v2\/workspaces\/(workspace-[ab])\/address-book\/contacts\/search$/);
    if (search && call.method === "POST") {const q = String(call.body.q ?? "").toLowerCase(); return route.fulfill({json: {items: contacts.filter(contact => contact.workspaceId === search[1] && `${contact.displayName} ${contact.email} ${contact.company} ${contact.roleOrTrade}`.toLowerCase().includes(q)), nextCursor: null, contextVersion}});}
    const collection = call.path.match(/^\/api\/client\/v2\/workspaces\/(workspace-[ab])\/address-book\/contacts$/);
    if (collection && call.method === "POST") {const contact = jane({...call.body, id: `contact-${contacts.length + 1}`, workspaceId: collection[1]!, previousInvitation: null}); contacts = [contact, ...contacts]; return route.fulfill({status: 201, json: {contact, replayed: false}});}
    const item = call.path.match(/^\/api\/client\/v2\/workspaces\/(workspace-[ab])\/address-book\/contacts\/(contact-[A-Za-z0-9_-]+)$/);
    if (item && call.method === "PATCH") {const current = contacts.find(value => value.id === item[2])!, contact = {...current, ...call.body, version: current.version + 1, updatedAt: "2026-08-27T13:00:00Z"}; delete (contact as any).expectedVersion; contacts = contacts.map(value => value.id === contact.id ? contact : value); return route.fulfill({json: {contact, replayed: false}});}
    if (item && call.method === "DELETE") {const current = contacts.find(value => value.id === item[2])!; contacts = contacts.filter(value => value.id !== current.id); return route.fulfill({json: {contact: {id: current.id, workspaceId: current.workspaceId, sourceId, status: "deleted", version: current.version + 1}, replayed: false}});}
    const invitation = call.path.match(/^\/api\/client\/v2\/workspaces\/(workspace-[ab])\/invitations$/);
    if (invitation && call.method === "POST") return route.fulfill({status: 201, json: {outcome: "created"}});
    return route.fulfill({status: 404, json: {error: "Unsupported fixture endpoint"}});
  });
  return calls;
}

async function open(page: Page) {await page.goto("/portal/account?workspace=workspace-a"); await expect(page.getByRole("button", {name: "Review invitation", exact: true})).toBeEnabled();}
const searchCalls = (calls: Call[]) => calls.filter(call => call.path.endsWith("/address-book/contacts/search"));

test("address book is default-off and never probes without its exact capability", async ({page}) => {
  const calls = await fixture(page, undefined, false); await open(page);
  await expect(page.getByRole("button", {name: "Manage address book"})).toHaveCount(0); await expect(page.getByRole("button", {name: "Choose saved contact"})).toHaveCount(0); expect(searchCalls(calls)).toHaveLength(0);
});

test("an available address book never becomes visible without its exact manage capability", async ({page}) => {
  const calls = await fixture(page, (route, call) => call.path.endsWith("/access") ? route.fulfill({json: {...access("workspace-a"), canManageAddressBook: false}}) : undefined); await open(page);
  await expect(page.getByRole("button", {name: "Manage address book"})).toHaveCount(0); await expect(page.getByRole("button", {name: "Choose saved contact"})).toHaveCount(0); expect(searchCalls(calls)).toHaveLength(0);
});

test("a standalone workspace cannot claim the organization address book even from malformed capability data", async ({page}) => {
  const calls = await fixture(page, (route, call) => call.path === "/api/client/v2/workspaces" ? route.fulfill({json: {workspaces: [{...workspaces[0], rootType: "standalone_client"}]}}) : undefined); await open(page);
  await expect(page.getByRole("button", {name: "Manage address book"})).toHaveCount(0); await expect(page.getByRole("button", {name: "Choose saved contact"})).toHaveCount(0); expect(searchCalls(calls)).toHaveLength(0);
});

test("lazy progressive search keeps contact PII in a bounded body and honors an empty page cursor", async ({page}) => {
  const calls = await fixture(page, (route, call) => call.path.endsWith("/contacts/search") ? route.fulfill({json: call.body.cursor ? {items: [jane()], nextCursor: null, contextVersion} : {items: [], nextCursor: "ab1_page-two", contextVersion}}) : undefined); await open(page);
  expect(searchCalls(calls)).toHaveLength(0); await page.getByRole("button", {name: "Manage address book"}).click(); await expect(page.getByText("No contacts in this page", {exact: false})).toBeVisible(); await page.getByRole("button", {name: "Load more contacts"}).click(); await expect(page.getByText("Jane Electrician", {exact: true})).toBeVisible();
  await page.getByLabel("Search contacts", {exact: true}).fill("Jane +1 555"); await page.getByRole("button", {name: "Search", exact: true}).click(); const last = searchCalls(calls).at(-1)!; expect(last.url).not.toContain("Jane"); expect(last.body).toEqual({q: "Jane +1 555", cursor: null});
});

test("contact create edit and delete are explicit versioned changes with no access implication", async ({page}) => {
  const calls = await fixture(page); await open(page); await page.getByRole("button", {name: "Manage address book"}).click(); await page.getByRole("button", {name: "Add contact"}).click();
  const editor = page.getByRole("form", {name: "Add organization contact"}); await editor.getByLabel("Name", {exact: true}).fill("Alex Surveyor"); await editor.getByLabel("Email", {exact: true}).fill("alex@example.test"); await editor.getByLabel("Company (optional)").fill("Alex Surveying"); await editor.getByLabel("Role or trade (descriptive only)").fill("Surveyor"); await editor.getByRole("button", {name: "Add contact", exact: true}).click(); await expect(page.getByRole("status").filter({hasText: "do not grant portal access"})).toBeVisible();
  await page.getByRole("button", {name: "Edit Alex Surveyor"}).click(); await page.getByLabel("Phone", {exact: true}).fill("555-0110"); await page.getByRole("button", {name: "Save contact"}).click();
  await page.getByRole("button", {name: "Delete Alex Surveyor"}).click(); const confirmation = page.getByRole("region", {name: "Confirm contact deletion"}); await expect(confirmation).toContainText("does not revoke invitations, memberships or access"); await confirmation.getByRole("button", {name: "Keep contact"}).click(); expect(calls.filter(call => call.method === "DELETE")).toHaveLength(0);
  await page.getByRole("button", {name: "Delete Alex Surveyor"}).click(); await confirmation.getByRole("button", {name: "Delete contact"}).click(); await expect(page.getByRole("status").filter({hasText: "Existing invitations and access were not changed"})).toBeVisible();
  const create = calls.find(call => call.method === "POST" && call.path.endsWith("/contacts"))!, update = calls.find(call => call.method === "PATCH")!, remove = calls.find(call => call.method === "DELETE")!; expect(create.key).toBeTruthy(); expect(update.body.expectedVersion).toBe(1); expect(remove.body).toEqual({expectedVersion: 2});
});

test("an uncertain contact change retries the identical operation and idempotency key", async ({page}) => {
  let attempts = 0; const calls = await fixture(page, (route, call) => call.method === "POST" && call.path.endsWith("/contacts") && ++attempts === 1 ? route.fulfill({status: 503, json: {error: "Unknown save"}}) : undefined); await open(page); await page.getByRole("button", {name: "Manage address book"}).click(); await page.getByRole("button", {name: "Add contact"}).click();
  const editor = page.getByRole("form", {name: "Add organization contact"}); await editor.getByLabel("Name", {exact: true}).fill("Retry Person"); await editor.getByLabel("Email", {exact: true}).fill("retry@example.test"); await editor.getByRole("button", {name: "Add contact", exact: true}).click(); await expect(page.getByRole("alert")).toContainText("not confirmed"); await expect(page.getByRole("combobox", {name: "Manage team workspace"})).toBeDisabled();
  await page.getByRole("button", {name: "Retry same change"}).click(); await expect(page.getByRole("status").filter({hasText: "was added"})).toBeVisible(); const writes = calls.filter(call => call.method === "POST" && call.path.endsWith("/contacts")); expect(writes).toHaveLength(2); expect(writes[1]!.key).toBe(writes[0]!.key); expect(writes[1]!.body).toEqual(writes[0]!.body);
});

test("address-book capacity is actionable and never treated as an uncertain write", async ({page}) => {
  await fixture(page, (route, call) => call.method === "POST" && call.path.endsWith("/contacts") ? route.fulfill({status: 409, json: {code: "address_book_capacity", error: "Address book capacity reached."}}) : undefined); await open(page); await page.getByRole("button", {name: "Manage address book"}).click(); await page.getByRole("button", {name: "Add contact"}).click();
  const editor = page.getByRole("form", {name: "Add organization contact"}); await editor.getByLabel("Name", {exact: true}).fill("Capacity Contact"); await editor.getByLabel("Email", {exact: true}).fill("capacity@example.test"); await editor.getByRole("button", {name: "Add contact", exact: true}).click(); await expect(page.getByRole("alert")).toContainText("Delete an unused contact"); await expect(editor.getByLabel("Email", {exact: true})).toHaveValue("capacity@example.test"); await expect(page.getByRole("button", {name: "Retry same change"})).toHaveCount(0); await expect(page.getByRole("combobox", {name: "Manage team workspace"})).toBeEnabled();
});

test("saved contact selection copies email and exact version without converting the card into access", async ({page}) => {
  const calls = await fixture(page); await open(page); const trigger = page.getByRole("button", {name: "Choose saved contact"}); await trigger.click(); const dialog = page.getByRole("dialog", {name: "Choose an organization contact"}); await expect(dialog.getByLabel("Search contacts")).toBeFocused();
  await dialog.getByRole("button", {name: /Use Jane Electrician/}).click(); await expect(trigger).toBeFocused(); await expect(page.getByLabel("Email address", {exact: true})).toHaveValue("jane@example.test"); await expect(page.getByText("not an identity or access grant", {exact: false})).toBeVisible();
  await page.getByRole("button", {name: "Review invitation", exact: true}).click(); await expect(page.getByRole("region", {name: "Review collaborator invitation"})).toContainText("independent access record"); await page.getByRole("button", {name: "Send invitation", exact: true}).click(); const invitation = calls.find(call => call.method === "POST" && call.path.endsWith("/invitations"))!; expect(invitation.body.addressContact).toEqual({id: "contact-jane", expectedVersion: 1}); expect(invitation.body.email).toBe("jane@example.test");
});

test("duplicate emails remain separate descriptive cards rather than inferred identities", async ({page}) => {
  await fixture(page, (route, call) => call.path.endsWith("/contacts/search") ? route.fulfill({json: {items: [jane(), jane({id: "contact-jane-two", displayName: "Jane Site Lead", company: "North Shore Builders", roleOrTrade: "Site lead"})], nextCursor: null, contextVersion}}) : undefined); await open(page); await page.getByRole("button", {name: "Choose saved contact"}).click(); const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", {name: "Use Jane Electrician at Jane Electrical — jane@example.test"})).toBeVisible(); await expect(dialog.getByRole("button", {name: "Use Jane Site Lead at North Shore Builders — jane@example.test"})).toBeVisible();
});

test("manual email edits clear address-book consistency metadata", async ({page}) => {
  const calls = await fixture(page); await open(page); await page.getByRole("button", {name: "Choose saved contact"}).click(); await page.getByRole("dialog").getByRole("button", {name: /Use Jane Electrician/}).click(); await page.getByLabel("Email address", {exact: true}).fill("manual@example.test"); await expect(page.getByText("Copied from Jane Electrician", {exact: false})).toHaveCount(0);
  await page.getByRole("button", {name: "Review invitation", exact: true}).click(); await page.getByRole("button", {name: "Send invitation", exact: true}).click(); const invitation = calls.find(call => call.method === "POST" && call.path.endsWith("/invitations"))!; expect(invitation.body.addressContact).toBeUndefined(); expect(invitation.body.email).toBe("manual@example.test");
});

test("a managed contact change clears a previously selected invitation snapshot", async ({page}) => {
  await fixture(page); await open(page); await page.getByRole("button", {name: "Choose saved contact"}).click(); await page.getByRole("dialog").getByRole("button", {name: /Use Jane Electrician/}).click(); await expect(page.getByText("Copied from Jane Electrician", {exact: false})).toBeVisible();
  await page.getByRole("button", {name: "Manage address book"}).click(); await page.getByRole("button", {name: "Edit Jane Electrician"}).click(); const editor = page.getByRole("form", {name: "Edit Jane Electrician"}); await editor.getByLabel("Phone", {exact: true}).fill("555-0199"); await editor.getByRole("button", {name: "Save contact"}).click(); await expect(page.getByText("Copied from Jane Electrician", {exact: false})).toHaveCount(0);
});

test("a late contact search cannot populate another management workspace", async ({page}) => {
  let release!: () => void; const waiting = new Promise<void>(resolve => {release = resolve;}); let started = false;
  const calls = await fixture(page, (route, call) => call.path.includes("workspace-a/address-book") ? (started = true, waiting.then(() => route.fulfill({json: {items: [jane()], nextCursor: null, contextVersion}}).catch(() => undefined))) : undefined); await open(page); await page.getByRole("button", {name: "Manage address book"}).click(); await expect.poll(() => started).toBe(true); await page.getByRole("combobox", {name: "Manage team workspace"}).selectOption("workspace-b"); await expect(page.getByRole("radio", {name: /Mountain bridge/})).toBeChecked(); release(); await expect(page.getByText("Jane Electrician", {exact: true})).toHaveCount(0); expect(searchCalls(calls).filter(call => call.path.includes("workspace-b"))).toHaveLength(0);
});

test("a wrong-source contact response clears the protected Team context", async ({page}) => {
  await fixture(page, (route, call) => call.path.endsWith("/contacts/search") ? route.fulfill({json: {items: [jane({sourceId: "project-alpha:secondary"})], nextCursor: null, contextVersion}}) : undefined); await open(page); await page.getByRole("button", {name: "Manage address book"}).click(); await expect(page.getByRole("alert")).toContainText("workspace access changed"); await expect(page.getByRole("button", {name: "Review invitation", exact: true})).toBeDisabled(); await expect(page.getByLabel("Email address", {exact: true})).toHaveValue(""); await expect(page.getByText("Jane Electrician", {exact: true})).toHaveCount(0);
});

for (const width of [375, 1280]) test(`address-book management and keyboard picker fit ${width}px`, async ({page}, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message)); await fixture(page); await page.setViewportSize({width, height: 900}); await open(page); await page.getByRole("button", {name: "Manage address book"}).click(); await expect(page.locator(".portal-address-book-list article").filter({hasText: "Jane Electrical · Electrician"})).toBeVisible();
  const searchBox = await page.getByLabel("Search contacts", {exact: true}).boundingBox(); expect(searchBox).not.toBeNull(); expect(searchBox!.height).toBeGreaterThanOrEqual(44); expect(searchBox!.height).toBeLessThanOrEqual(60); expect(searchBox!.x + searchBox!.width).toBeLessThanOrEqual(width); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({path: testInfo.outputPath(`address-book-${width}.png`), fullPage: true}); const picker = page.getByRole("button", {name: "Choose saved contact"}); await picker.focus(); await expect(picker).toBeFocused(); await picker.press("Enter"); const dialog = page.getByRole("dialog", {name: "Choose an organization contact"}); await expect(dialog.getByLabel("Search contacts")).toBeFocused();
  await page.screenshot({path: testInfo.outputPath(`address-book-picker-${width}.png`)}); await page.keyboard.press("Escape"); await expect(picker).toBeFocused(); expect(errors).toEqual([]);
});
