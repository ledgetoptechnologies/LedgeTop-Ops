import { expect, test, type Page, type Route } from "@playwright/test";

const path = "/operations/inbox";
const endpoints = {
  requests: "/api/operations/inbox/requests",
  feedback: "/api/operations/feedback",
  deliveries: "/api/notifications/deliveries",
  connections: "/api/admin/integrations/project-alpha/connectors",
} as const;
const sectionNames = ["Client requests", "Client feedback", "Pending delivery notices", "Connection failures"] as const;
type SectionName = typeof sectionNames[number];
const now = "2026-08-26T12:00:00Z";
const primary = "project-alpha:primary", secondary = "project-alpha:business-b";

function requestItem(id = "request-one", title = "Roof survey request") {
  return { id, title, accountName: "Acme Construction", projectName: "Church survey", status: "submitted", createdAt: now };
}
function feedbackItem(id = "feedback-one", message = "Please check the north edge of the roof.") {
  return { id, status: "new", revision: 1, message, completionNote: null, createdAt: now, updatedAt: now,
    completedAt: null, accountName: "Acme Construction", canStart: true, canComplete: true,
    target: { kind: "file", projectId: "project-one", label: "Church survey north edge.jpg", projectName: "Church survey", available: true, actionPath: null } };
}
function deliveryItem(id = "notice-one", accountName = "Acme Construction") {
  return { id, kind: "folder_changes", revision: 1, status: "pending", accountName, folderLabel: "Church survey · Edited",
    recipientEmail: "alex@example.test", addedCount: 12, removedCount: 2, eligibleAt: "2026-08-26T12:05:00Z",
    createdAt: now, updatedAt: now, deliveredAt: null, errorCode: null, canSendNow: true, canCancel: true };
}
function connector(sourceId = secondary, displayName = "Survey business connection", state = "active") {
  return { sourceId, displayName, producerBindingId: `producer-${sourceId.split(":")[1]}`, snapshotOrigin: "https://alpha.example.test",
    snapshotBasePath: "/api/exports", applicationKey: "external_operations", profile: sourceId === primary ? "primary_legacy" : "business_data",
    state, readVisible: true, activeRevision: 1, version: 3 };
}
function health(sourceId = secondary, status = "error") {
  return { sourceId, status, lastAttemptAt: now, lastSuccessAt: "2026-08-25T12:00:00Z", lastErrorCode: status === "error" ? "snapshot_unavailable" : null };
}
const requestPage = (items = [requestItem()], nextCursor: string | null = null) => ({ items, nextCursor });
const feedbackPage = (items = [feedbackItem()], nextCursor: string | null = null) => ({ items, nextCursor });
const deliveryPage = (items: Record<string, unknown>[] = [deliveryItem()], nextCursor: string | null = null) => ({ items, nextCursor, serverNow: now, coverage: "delivery_notifications_v2", availability: { folderChanges: true, nativeDeliveries: true } });
const connectionPage = (connectors = [connector()], rows = [health()], legacyPrimary = false) => ({ connectors, health: rows, legacyPrimary });

interface Access { permissions: string[]; isAdministrator?: boolean; feedback?: boolean }
const allAccess: Access = { permissions: ["operations.manage", "delivery.share.audit", "integrations.manage", "administration.view"], isAdministrator: true, feedback: true };
interface Call { path: string; method: string; query: URLSearchParams }
type Handler = (route: Route, url: URL, call: Call) => Promise<boolean>;

async function fixture(page: Page, access: Access = allAccess, handler?: Handler) {
  const calls: Call[] = [];
  await page.route("**/api/**", async route => {
    const req = route.request(), url = new URL(req.url());
    const call: Call = { path: url.pathname, method: req.method(), query: url.searchParams };
    calls.push(call);
    if (url.pathname === "/api/session") return route.fulfill({ json: {
      user: { id: "inbox-staff", email: "staff@example.test", displayName: "Inbox reviewer", status: "Active",
        profileType: access.isAdministrator ? "Administrator" : "Employee", isAdministrator: access.isAdministrator ?? false,
        permissions: access.permissions, divisions: [] }, csrfToken: "csrf-inbox", timezone: "America/Chicago",
      mapStyleUrl: null, mapboxPublicToken: null, capabilities: { clientFeedback: { enabled: access.feedback ?? false } },
    } });
    if (handler && await handler(route, url, call)) return;
    if (req.method() !== "GET") return route.fulfill({ status: 405, json: { error: "The inbox fixture permits reads only." } });
    if (url.pathname === endpoints.requests) return route.fulfill({ json: requestPage() });
    if (url.pathname === endpoints.feedback) return route.fulfill({ json: feedbackPage() });
    if (url.pathname === endpoints.deliveries) return route.fulfill({ json: deliveryPage() });
    if (url.pathname === endpoints.connections) return route.fulfill({ json: connectionPage() });
    if (url.pathname === "/api/sops") return route.fulfill({ json: { sops: [] } });
    return route.fulfill({ status: 404, json: { error: "Unsupported fixture endpoint" } });
  });
  return calls;
}
const inbox = (page: Page) => page.getByRole("region", { name: "Staff inbox", exact: true });
const section = (page: Page, name: SectionName) => inbox(page).getByRole("region", { name, exact: true });
const search = (page: Page) => inbox(page).getByRole("search", { name: "Search inbox", exact: true });
const loadMore = (page: Page, name: SectionName) => section(page, name).getByRole("button", { name: `Load more ${name.toLowerCase()}`, exact: true });
const retry = (page: Page, name: SectionName) => section(page, name).getByRole("button", { name: `Retry ${name.toLowerCase()}`, exact: true });
const requestLink = (page: Page, id = "request-one") => section(page, "Client requests").locator(`a[href="/clients/requests/${id}"]`);
const feedbackLink = (page: Page, id = "feedback-one") => section(page, "Client feedback").locator(`a[href="/operations/feedback/${id}?status=all"]`);
const inboxCalls = (calls: Call[]) => calls.filter(call => Object.values(endpoints).some(endpoint => endpoint === call.path));
async function open(page: Page, query = "") {
  await page.goto(`${path}${query}`);
  await expect(inbox(page).getByRole("heading", { name: "Needs attention", exact: true })).toBeVisible();
}
async function submitSearch(page: Page, value: string) {
  await search(page).getByRole("textbox", { name: "Search inbox", exact: true }).fill(value);
  await search(page).getByRole("button", { name: "Search", exact: true }).click();
}
async function late(route: Route, json: unknown) {
  try { await route.fulfill({ json }); } catch { /* An aborted old browser request is an expected outcome. */ }
}

test("operations-manage-only staff land in Inbox without probing unrelated queues", async ({ page }) => {
  const calls = await fixture(page, { permissions: ["operations.manage"] });
  await page.goto("/");
  await expect(page).toHaveURL(/\/operations\/inbox$/);
  await expect(requestLink(page)).toBeVisible();
  await expect(page.getByRole("tab", { name: "Inbox", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("link", { name: "Open staff inbox", exact: true })).toHaveAttribute("href", path);
  for (const name of sectionNames.slice(1)) await expect(section(page, name)).toHaveCount(0);
  expect(inboxCalls(calls).every(call => call.path === endpoints.requests)).toBe(true);
  expect(calls.every(call => call.method === "GET")).toBe(true);
});

test("feedback capability admits only feedback and does not infer operations management", async ({ page }) => {
  const calls = await fixture(page, { permissions: [], feedback: true });
  await open(page);
  await expect(feedbackLink(page)).toBeVisible();
  for (const name of ["Client requests", "Pending delivery notices", "Connection failures"] as const) await expect(section(page, name)).toHaveCount(0);
  expect(inboxCalls(calls).every(call => call.path === endpoints.feedback)).toBe(true);
  expect(inboxCalls(calls).every(call => call.query.get("status") === "open")).toBe(true);
});

test("audit-only staff retain Notifications landing and can open the read-only inbox", async ({ page }) => {
  const calls = await fixture(page, { permissions: ["delivery.share.audit"] });
  await page.goto("/");
  await expect(page).toHaveURL(/\/operations\/notifications$/);
  await page.getByRole("link", { name: "Open staff inbox", exact: true }).click();
  await expect(page).toHaveURL(/\/operations\/inbox$/);
  await expect(section(page, "Pending delivery notices")).toContainText("Acme Construction");
  for (const name of ["Client requests", "Client feedback", "Connection failures"] as const) await expect(section(page, name)).toHaveCount(0);
  expect(inboxCalls(calls).every(call => call.path === endpoints.deliveries)).toBe(true);
});

test("staff without inbox permissions never probe inbox sources through a direct URL", async ({ page }) => {
  const calls = await fixture(page, { permissions: ["sops.view", "delivery.share.create", "delivery.share.revoke"] });
  await page.goto(path);
  await expect(page).toHaveURL(/\/operations\/sops$/);
  await expect(inbox(page)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open staff inbox", exact: true })).toHaveCount(0);
  expect(inboxCalls(calls)).toEqual([]);
});

for (const access of [
  { label: "nonadministrator", isAdministrator: false, permissions: ["operations.manage", "integrations.manage", "administration.view"] },
  { label: "without integration management", isAdministrator: true, permissions: ["operations.manage", "administration.view"] },
  { label: "without administration visibility", isAdministrator: true, permissions: ["operations.manage", "integrations.manage"] },
]) test(`connection configuration is not probed by ${access.label}`, async ({ page }) => {
  const calls = await fixture(page, access);
  await open(page);
  await expect(requestLink(page)).toBeVisible();
  await expect(section(page, "Connection failures")).toHaveCount(0);
  expect(calls.some(call => call.path === endpoints.connections)).toBe(false);
});

test("populated queues link to their real workspaces and expose no mutations or invented total", async ({ page }) => {
  const calls = await fixture(page);
  await open(page);
  await expect(requestLink(page)).toContainText("Roof survey request");
  await expect(feedbackLink(page)).toBeVisible();
  const deliveryLink = section(page, "Pending delivery notices").locator('a[href^="/operations/notifications?"]');
  await expect(deliveryLink).toBeVisible();
  const deliveryUrl = new URL((await deliveryLink.getAttribute("href"))!, "http://fixture.test");
  expect(deliveryUrl.searchParams.get("batchId")).toBe("notice-one");
  expect([...deliveryUrl.searchParams.keys()]).toEqual(["batchId"]);
  await expect(section(page, "Connection failures").locator('a[href="/administration#project-alpha-connections"]')).toBeVisible();
  await expect(inbox(page).getByRole("button", { name: /Send now|Cancel notification|Mark Done|Confirm|Sync now/i })).toHaveCount(0);
  await expect(inbox(page)).not.toContainText(/\b\d+ (?:total|unread|notifications? needing attention)\b/i);
  expect(calls.every(call => call.method === "GET")).toBe(true);
  expect(calls.find(call => call.path === endpoints.feedback)?.query.get("status")).toBe("open");
  expect(calls.find(call => call.path === endpoints.deliveries)?.query.get("view")).toBe("pending");
});

test("only active connection errors appear, while a failing unregistered legacy primary remains visible", async ({ page }) => {
  const sources = [connector(secondary, "Active source failure"), connector("project-alpha:healthy", "Healthy source"),
    connector("project-alpha:suspended", "Suspended source", "suspended"), connector("project-alpha:pending", "Pending source", "pending"),
    connector("project-alpha:unknown", "Unknown source"), connector("project-alpha:disabled", "Disabled source")];
  await fixture(page, allAccess, async (route, url) => {
    if (url.pathname !== endpoints.connections) return false;
    await route.fulfill({ json: connectionPage(sources, [health(primary), health(secondary), health("project-alpha:healthy", "healthy"),
      health("project-alpha:suspended"), health("project-alpha:pending"), health("project-alpha:unknown", "unknown"), health("project-alpha:disabled", "disabled")], true) });
    return true;
  });
  await open(page);
  const failures = section(page, "Connection failures");
  await expect(failures).toContainText("Active source failure");
  await expect(failures).toContainText(/primary/i);
  for (const label of ["Healthy source", "Suspended source", "Pending source", "Unknown source", "Disabled source"]) await expect(failures).not.toContainText(label);
  await expect(failures.locator('a[href="/administration#project-alpha-connections"]')).toHaveCount(2);
});

test("one slow or unavailable section does not block empty, successful, or retryable siblings", async ({ page }) => {
  let pending: Route | null = null, attempts = 0;
  const calls = await fixture(page, allAccess, async (route, url) => {
    if (url.pathname === endpoints.requests && !pending) { pending = route; return true; }
    if (url.pathname === endpoints.feedback) { await route.fulfill({ json: feedbackPage([]) }); return true; }
    if (url.pathname === endpoints.deliveries && ++attempts === 1) { await route.fulfill({ status: 503, json: { error: "Delivery service temporarily unavailable." } }); return true; }
    return false;
  });
  await open(page);
  await expect.poll(() => pending !== null).toBe(true);
  await expect(section(page, "Connection failures")).toContainText("Survey business connection");
  await expect(section(page, "Client feedback").locator("a")).toHaveCount(0);
  await expect(section(page, "Client feedback").getByRole("alert")).toHaveCount(0);
  await expect(section(page, "Pending delivery notices").getByRole("alert")).toContainText(/unavailable/i);
  await expect(retry(page, "Pending delivery notices")).toBeVisible();
  const before = calls.filter(call => call.path !== endpoints.deliveries).length;
  await retry(page, "Pending delivery notices").click();
  await expect(section(page, "Pending delivery notices")).toContainText("Acme Construction");
  expect(calls.filter(call => call.path !== endpoints.deliveries)).toHaveLength(before);
  await pending!.fulfill({ json: requestPage() });
  await expect(requestLink(page)).toBeVisible();
});

test("an empty authorized scan with a cursor remains continuable instead of claiming completion", async ({ page }) => {
  const calls = await fixture(page, { permissions: ["operations.manage"] }, async (route, url) => {
    if (url.pathname !== endpoints.requests) return false;
    await route.fulfill({ json: url.searchParams.has("cursor") ? requestPage() : requestPage([], "next-authorized-scan") });
    return true;
  });
  await open(page);
  await expect(loadMore(page, "Client requests")).toBeVisible();
  await expect(section(page, "Client requests")).not.toContainText(/No (?:client )?requests (?:need|require|await)|No requests found/i);
  await loadMore(page, "Client requests").click();
  await expect(requestLink(page)).toBeVisible();
  await expect(loadMore(page, "Client requests")).toHaveCount(0);
  expect(inboxCalls(calls).map(call => call.query.get("cursor"))).toEqual([null, "next-authorized-scan"]);
});

test("continuation is section-local, duplicate clicks are bounded, and transient retry retains existing rows", async ({ page }) => {
  let pending: Route | null = null, continuations = 0;
  const calls = await fixture(page, allAccess, async (route, url) => {
    if (url.pathname !== endpoints.requests) return false;
    if (!url.searchParams.has("cursor")) { await route.fulfill({ json: requestPage([requestItem()], "page-two") }); return true; }
    if (++continuations === 1) { pending = route; return true; }
    await route.fulfill({ json: requestPage([requestItem("request-two", "Updated inspection request")]) }); return true;
  });
  await open(page);
  await expect(requestLink(page)).toBeVisible();
  await loadMore(page, "Client requests").evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect.poll(() => pending !== null).toBe(true);
  expect(continuations).toBe(1);
  await pending!.fulfill({ status: 503, json: { error: "Request queue temporarily unavailable." } });
  await expect(requestLink(page)).toBeVisible();
  await expect(feedbackLink(page)).toBeVisible();
  await retry(page, "Client requests").click();
  await expect(requestLink(page, "request-two")).toBeVisible();
  await expect(requestLink(page)).toBeVisible();
  expect(calls.filter(call => call.path === endpoints.requests && call.query.has("cursor")).map(call => call.query.get("cursor"))).toEqual(["page-two", "page-two"]);
  expect(calls.filter(call => call.path === endpoints.feedback)).toHaveLength(1);
});

test("403 on continuation clears every row in that section without discarding unrelated queues", async ({ page }) => {
  let requests = 0;
  const calls = await fixture(page, allAccess, async (route, url) => {
    if (url.pathname !== endpoints.requests) return false;
    requests += 1;
    if (url.searchParams.get("cursor") === "protected-page-one") { await route.fulfill({ json: requestPage([requestItem("request-two", "Previously authorized second request")], "protected-page-two") }); return true; }
    if (url.searchParams.has("cursor")) { await route.fulfill({ status: 403, json: { error: "Request access was removed." } }); return true; }
    await route.fulfill({ json: requests === 1 ? requestPage([requestItem()], "protected-page-one") : requestPage([requestItem("new-authorized", "Current authorized request")]) }); return true;
  });
  await open(page);
  await expect(requestLink(page)).toBeVisible();
  await loadMore(page, "Client requests").click();
  await expect(requestLink(page, "request-two")).toBeVisible();
  await loadMore(page, "Client requests").click();
  await expect(section(page, "Client requests").getByRole("alert")).toBeVisible();
  await expect(requestLink(page)).toHaveCount(0);
  await expect(requestLink(page, "request-two")).toHaveCount(0);
  await expect(loadMore(page, "Client requests")).toHaveCount(0);
  await expect(feedbackLink(page)).toBeVisible();
  await expect(section(page, "Pending delivery notices")).toContainText("Acme Construction");
  await retry(page, "Client requests").click();
  await expect(requestLink(page, "new-authorized")).toBeVisible();
  expect(calls.filter(call => call.path === endpoints.requests).map(call => call.query.get("cursor"))).toEqual([null, "protected-page-one", "protected-page-two", null]);
});

test("401 clears the whole inbox and a late sibling continuation cannot restore protected content", async ({ page }) => {
  let delayed: Route | null = null;
  await fixture(page, allAccess, async (route, url) => {
    if (url.pathname === endpoints.feedback) {
      if (url.searchParams.has("cursor")) { delayed = route; return true; }
      await route.fulfill({ json: feedbackPage([feedbackItem()], "feedback-page-two") }); return true;
    }
    if (url.pathname === endpoints.requests) {
      if (url.searchParams.has("cursor")) { await route.fulfill({ status: 401, json: { error: "Sign in again." } }); return true; }
      await route.fulfill({ json: requestPage([requestItem()], "request-page-two") }); return true;
    }
    return false;
  });
  await open(page);
  await expect(requestLink(page)).toBeVisible();
  await expect(feedbackLink(page)).toBeVisible();
  await loadMore(page, "Client feedback").click();
  await expect.poll(() => delayed !== null).toBe(true);
  await loadMore(page, "Client requests").click();
  await expect(page.getByRole("alert").filter({ hasText: /sign in again/i })).toBeVisible();
  await late(delayed!, feedbackPage([feedbackItem("late-private", "Late private feedback must remain hidden")]));
  await expect(page.getByText("Roof survey request", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Acme Construction", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Late private feedback must remain hidden", { exact: true })).toHaveCount(0);
  await expect(inbox(page).getByRole("button", { name: /^Load more / })).toHaveCount(0);
});

test("search uses server queries for each authorized queue, local connection labels, and browser history", async ({ page }) => {
  const calls = await fixture(page, allAccess, async (route, url) => {
    if (url.pathname !== endpoints.connections) return false;
    await route.fulfill({ json: connectionPage([connector(secondary, "North office"), connector(primary, "South office")], [health(secondary), health(primary)]) }); return true;
  });
  await open(page);
  await submitSearch(page, "North office");
  await expect(page).toHaveURL(/\/operations\/inbox\?q=North\+office$/);
  await expect.poll(() => [endpoints.requests, endpoints.feedback, endpoints.deliveries].every(endpoint => calls.some(call => call.path === endpoint && call.query.get("q") === "North office"))).toBe(true);
  await expect(section(page, "Connection failures")).toContainText("North office");
  await expect(section(page, "Connection failures")).not.toContainText("South office");
  await submitSearch(page, "South office");
  await expect(page).toHaveURL(/q=South\+office$/);
  await expect(section(page, "Connection failures")).toContainText("South office");
  await page.goBack();
  await expect(search(page).getByRole("textbox", { name: "Search inbox", exact: true })).toHaveValue("North office");
  await expect(section(page, "Connection failures")).toContainText("North office");
  await page.goForward();
  await expect(search(page).getByRole("textbox", { name: "Search inbox", exact: true })).toHaveValue("South office");
  await page.reload();
  await expect(search(page).getByRole("textbox", { name: "Search inbox", exact: true })).toHaveValue("South office");
  await expect(section(page, "Connection failures")).toContainText("South office");
  expect(calls.filter(call => call.path === endpoints.connections).every(call => !call.query.has("q") && !call.query.has("cursor"))).toBe(true);
});

test("a newer search can finish while the prior first page is busy without accepting its late result", async ({ page }) => {
  let delayed: Route | null = null;
  await fixture(page, { permissions: ["operations.manage"] }, async (route, url) => {
    if (url.pathname !== endpoints.requests) return false;
    if (url.searchParams.get("q") === "old search") { delayed = route; return true; }
    await route.fulfill({ json: requestPage([requestItem(url.searchParams.get("q") === "new search" ? "current" : "request-one", url.searchParams.get("q") === "new search" ? "Current search result" : "Roof survey request")]) }); return true;
  });
  await open(page);
  await expect(requestLink(page)).toBeVisible();
  await submitSearch(page, "old search");
  await expect.poll(() => delayed !== null).toBe(true);
  await submitSearch(page, "new search");
  await expect(requestLink(page, "current")).toBeVisible();
  await late(delayed!, requestPage([requestItem("stale", "Stale first page")]));
  await expect(requestLink(page, "current")).toBeVisible();
  await expect(requestLink(page, "stale")).toHaveCount(0);
  await expect(page).toHaveURL(/q=new\+search$/);
});

test("search resets cursors and a late old continuation cannot mix into the new results", async ({ page }) => {
  let delayed: Route | null = null;
  const calls = await fixture(page, { permissions: ["operations.manage"] }, async (route, url) => {
    if (url.pathname !== endpoints.requests) return false;
    if (url.searchParams.has("cursor")) { delayed = route; return true; }
    await route.fulfill({ json: url.searchParams.get("q") ? requestPage([requestItem("searched", "Filtered request")]) : requestPage([requestItem()], "old-cursor") }); return true;
  });
  await open(page);
  await loadMore(page, "Client requests").click();
  await expect.poll(() => delayed !== null).toBe(true);
  await submitSearch(page, "filter");
  await expect(requestLink(page, "searched")).toBeVisible();
  await late(delayed!, requestPage([requestItem("stale", "Old continuation")]));
  await expect(requestLink(page, "stale")).toHaveCount(0);
  await expect(requestLink(page)).toHaveCount(0);
  expect(calls.filter(call => call.path === endpoints.requests && call.query.get("q") === "filter").every(call => !call.query.has("cursor"))).toBe(true);
});

test("Refresh inbox retains search and reloads permitted sections from their first pages", async ({ page }) => {
  const calls = await fixture(page, { permissions: ["operations.manage", "delivery.share.audit"] });
  await open(page, "?q=Acme");
  await expect(requestLink(page)).toBeVisible();
  await expect(section(page, "Pending delivery notices")).toContainText("Acme Construction");
  const before = inboxCalls(calls).length;
  await inbox(page).getByRole("button", { name: "Refresh inbox", exact: true }).click();
  await expect.poll(() => inboxCalls(calls).length).toBe(before + 2);
  await expect(requestLink(page)).toBeVisible();
  await expect(page).toHaveURL(/\?q=Acme$/);
  expect(inboxCalls(calls).slice(before).every(call => call.query.get("q") === "Acme" && !call.query.has("cursor"))).toBe(true);
  expect(inboxCalls(calls).every(call => call.path === endpoints.requests || call.path === endpoints.deliveries)).toBe(true);
});

test("keyboard navigation reaches the inbox and real feedback detail without requiring pointer actions", async ({ page }) => {
  const calls = await fixture(page, { permissions: [], feedback: true }, async (route, url) => {
    if (url.pathname !== `${endpoints.feedback}/feedback-one`) return false;
    await route.fulfill({ json: { feedback: feedbackItem(), events: [{ revision: 1, actor: "client", status: "new", note: null, createdAt: now }] } }); return true;
  });
  await page.goto("/operations/feedback");
  const entry = page.getByRole("link", { name: "Open staff inbox", exact: true });
  await entry.focus(); await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/operations\/inbox$/);
  const field = search(page).getByRole("textbox", { name: "Search inbox", exact: true });
  await field.focus(); await field.fill("north edge"); await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/q=north\+edge$/);
  await feedbackLink(page).focus(); await expect(feedbackLink(page)).toBeFocused(); await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/operations\/feedback\/feedback-one\?status=all$/);
  await expect(page.getByRole("region", { name: "Client feedback", exact: true })).toContainText("Please check the north edge of the roof.");
  expect(calls.every(call => call.method === "GET")).toBe(true);
});

test("the inbox keeps native and folder notices with equal raw IDs and opens the exact native record read-only", async ({ page }) => {
  const native = { id: "nb_same", kind: "portal_delivery", revision: 1, status: "pending", workspaceName: "Acme portal workspace",
    sourceName: "Survey business source", eventLabel: "Delivery ready", deliveryMode: "staged", folderLabel: "Church survey · Edited",
    recipientEmail: "private-recipient@example.test", eligibleAt: "2026-08-26T12:05:00Z", createdAt: now, updatedAt: now,
    deliveredAt: null, errorCode: null, canSendNow: false, canCancel: false };
  const calls = await fixture(page, { permissions: ["delivery.share.audit"] }, async (route, url) => {
    if (url.pathname === endpoints.deliveries) { await route.fulfill({ json: deliveryPage([deliveryItem("nb_same"), native]) }); return true; }
    if (url.pathname === `${endpoints.deliveries}/portal_delivery/nb_same`) {
      await route.fulfill({ json: { item: native, serverNow: now, coverage: "delivery_notifications_v2", availability: { folderChanges: true, nativeDeliveries: true } } }); return true;
    }
    return false;
  });
  await open(page);
  const notices = section(page, "Pending delivery notices");
  await expect(notices.getByRole("article")).toHaveCount(2);
  await expect(notices).toContainText("Acme portal workspace · Survey business source · Delivery ready");
  await expect(notices).not.toContainText("private-recipient@example.test");
  const target = notices.locator('a[href="/operations/notifications?kind=portal_delivery&batchId=nb_same"]');
  await target.focus(); await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\?kind=portal_delivery&batchId=nb_same$/);
  await expect(page.getByRole("region", { name: "Delivery notification center" }).getByText("private-recipient@example.test", { exact: true })).toBeVisible();
  expect(calls.filter(call => call.path === endpoints.deliveries).every(call => call.query.get("format") === "combined")).toBe(true);
  expect(calls.every(call => call.method === "GET")).toBe(true);
});

test("the inbox shows native upgrade-required coverage while keeping folder notices usable", async ({ page }) => {
  await fixture(page, { permissions: ["delivery.share.audit"] }, async (route, url) => {
    if (url.pathname !== endpoints.deliveries) return false;
    await route.fulfill({ json: { ...deliveryPage(), availability: { folderChanges: true, nativeDeliveries: false } } }); return true;
  });
  await open(page);
  const notices = section(page, "Pending delivery notices");
  await expect(notices.getByRole("status").filter({ hasText: "database upgrade" })).toBeVisible();
  await expect(notices.locator('a[href="/operations/notifications?batchId=notice-one"]')).toBeVisible();
  await expect(notices.getByRole("alert")).toHaveCount(0);
});

for (const width of [375, 640, 1280, 3440]) test(`populated inbox spacing and keyboard-visible controls at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  const longName = "North district construction and environmental survey coordination company";
  await fixture(page, allAccess, async (route, url) => {
    if (url.pathname === endpoints.requests) { await route.fulfill({ json: requestPage([{ ...requestItem("request-one", "Roof inspection and site documentation for the north district community building"), accountName: longName }], "requests-next") }); return true; }
    if (url.pathname === endpoints.feedback) { await route.fulfill({ json: feedbackPage([{ ...feedbackItem(), accountName: longName, message: "Please check the north edge and the adjoining service building in the completed survey image before our next review meeting." }], "feedback-next") }); return true; }
    if (url.pathname === endpoints.deliveries) { await route.fulfill({ json: deliveryPage([{ ...deliveryItem("notice-one", longName), folderLabel: "North district community building · Approved edited delivery photographs" }], "deliveries-next") }); return true; }
    if (url.pathname === endpoints.connections) { await route.fulfill({ json: connectionPage([connector(secondary, "North district surveying business and environmental documentation connection")]) }); return true; }
    return false;
  });
  await open(page);
  await expect(requestLink(page)).toBeVisible(); await expect(feedbackLink(page)).toBeVisible();
  await expect(section(page, "Connection failures")).toContainText("North district surveying");
  const field = search(page).getByRole("textbox", { name: "Search inbox", exact: true });
  await field.focus(); await expect(field).toBeFocused();
  const inputGeometry = await field.evaluate(input => {
    const box = input.getBoundingClientRect(), style = getComputedStyle(input);
    return { height: box.height, padding: Number.parseFloat(style.paddingLeft), left: box.left, right: box.right, width: innerWidth };
  });
  expect(inputGeometry.height).toBeGreaterThanOrEqual(44);
  expect(inputGeometry.padding).toBeGreaterThanOrEqual(10);
  expect(inputGeometry.left).toBeGreaterThanOrEqual(0);
  expect(inputGeometry.right).toBeLessThanOrEqual(inputGeometry.width + 1);
  const spacing = await inbox(page).evaluate(root => {
    const boxes = [...root.children].filter(child => child.getBoundingClientRect().height > 0).map(child => child.getBoundingClientRect());
    const input = root.querySelector("input")!, label = input.closest("label")!;
    const range = document.createRange(); range.selectNodeContents(label.firstChild!);
    return { gaps: boxes.slice(1).map((box, index) => box.top - boxes[index]!.bottom),
      labelGap: input.getBoundingClientRect().top - range.getBoundingClientRect().bottom };
  });
  for (const gap of spacing.gaps) expect(gap).toBeGreaterThanOrEqual(12);
  expect(spacing.labelGap).toBeGreaterThanOrEqual(4);
  for (const name of sectionNames) {
    const region = section(page, name);
    const heading = region.getByRole("heading", { name, exact: true });
    await expect(heading).toBeVisible();
    const geometry = await region.evaluate(root => {
      const heading = root.querySelector("h2,h3,h4")!, link = root.querySelector("a")!;
      const box = root.getBoundingClientRect(), title = heading.getBoundingClientRect(), firstLink = link.getBoundingClientRect();
      return { left: box.left, right: box.right, width: innerWidth, headingGap: firstLink.top - title.bottom, linkHeight: firstLink.height };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.width + 1);
    expect(geometry.headingGap).toBeGreaterThanOrEqual(4);
    expect(geometry.linkHeight).toBeGreaterThanOrEqual(44);
  }
  const boxes = await Promise.all(sectionNames.map(name => section(page, name).boundingBox()));
  for (let left = 0; left < boxes.length; left++) for (let right = left + 1; right < boxes.length; right++) {
    const a = boxes[left]!, b = boxes[right]!;
    const horizontalGap = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
    const verticalGap = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
    expect(Math.max(horizontalGap, verticalGap)).toBeGreaterThanOrEqual(8);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath(`staff-inbox-${width}-viewport.png`) });
  await page.screenshot({ path: info.outputPath(`staff-inbox-${width}-full.png`), fullPage: true });
});
