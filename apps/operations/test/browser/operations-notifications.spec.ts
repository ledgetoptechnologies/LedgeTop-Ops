import { expect, test, type Page, type Route } from "@playwright/test";

const centerPath = "/notifications", endpoint = "/api/notifications/deliveries";
const now = "2026-08-25T12:00:00Z";
function batch(id = "batch-one", overrides: Record<string, unknown> = {}) {
  return { id, kind: "folder_changes", revision: 1, status: "pending", accountName: "Acme Construction", folderLabel: "Church survey · Edited",
    recipientEmail: "alex@example.test", addedCount: 40, removedCount: 2, eligibleAt: "2026-08-25T12:05:00Z", createdAt: now,
    updatedAt: now, deliveredAt: null, errorCode: null, canSendNow: false, canCancel: false, ...overrides };
}
function result(items: Record<string, unknown>[] = [batch()], nextCursor: string | null = null, serverNow = now) {
  return { items, nextCursor, serverNow, coverage: "delivery_notifications_v2", availability: { folderChanges: true, nativeDeliveries: true } };
}
function nativeNotice(id = "nb_one", overrides: Record<string, unknown> = {}) {
  const { accountName: _accountName, addedCount: _addedCount, removedCount: _removedCount, ...common } = batch(id);
  return { ...common, kind: "portal_delivery", sourceName: "Survey business source", workspaceName: "Acme portal workspace",
    eventLabel: "Delivery ready", deliveryMode: "staged", ...overrides };
}
function authenticatedNotice(id = "exact_one", overrides: Record<string, unknown> = {}) {
  const { accountName: _accountName, ...common } = batch(id);
  return { ...common, kind: "authenticated_delivery", addedCount: 3, removedCount: 1,
    bellPublishedAt: null, emailSuppressedAt: null, canSuppressEmail: false, ...overrides };
}
const nativeArticle = (page: Page) => center(page).locator('article[data-notification-kind="portal_delivery"]');
const authenticatedArticle = (page: Page) => center(page).locator('article[data-notification-kind="authenticated_delivery"]');
async function mock(page: Page, handler: (route: Route, url: URL) => Promise<unknown>, permissions = ["delivery.share.audit"]) {
  const requests: Array<{ path: string; query: URLSearchParams; method: string; key: string | undefined; body: unknown }> = [];
  await page.route("**/api/**", route => {
    const request = route.request(), url = new URL(request.url());
    requests.push({ path: url.pathname, query: url.searchParams, method: request.method(), key: request.headers()["idempotency-key"],
      body: request.method() === "POST" ? request.postDataJSON() : null });
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: "notification-auditor", email: "auditor@example.test",
      displayName: "Notification auditor", status: "Active", profileType: "Employee", isAdministrator: false, permissions, divisions: [] },
      csrfToken: "csrf-notifications", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    if (url.pathname === "/api/sops") return route.fulfill({ json: { sops: [] } });
    return handler(route, url);
  });
  return requests;
}
const center = (page: Page) => page.getByRole("region", { name: "Delivery notification center" });
const article = (page: Page, name = "Acme Construction · Church survey · Edited") => center(page).getByRole("article", { name, exact: true });
async function expectNotificationSpacing(page: Page) {
  const geometry = await center(page).evaluate(root => {
    const blocks = [...root.children].filter(child => child.getBoundingClientRect().height > 0).map(child => child.getBoundingClientRect());
    const input = root.querySelector<HTMLInputElement>(".notification-search input")!;
    const label = input.closest("label")!;
    const range = document.createRange(); range.selectNodeContents(label.firstChild!);
    return { gaps: blocks.slice(1).map((block, index) => block.top - blocks[index]!.bottom),
      labelGap: input.getBoundingClientRect().top - range.getBoundingClientRect().bottom,
      inputPadding: Number.parseFloat(getComputedStyle(input).paddingLeft) };
  });
  for (const gap of geometry.gaps) expect(gap).toBeGreaterThanOrEqual(12);
  expect(geometry.labelGap).toBeGreaterThanOrEqual(4);
  expect(geometry.inputPadding).toBeGreaterThanOrEqual(10);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
async function late(route: Route, json: unknown) { try { await route.fulfill({ json }); } catch { /* A cancelled browser request is an expected outcome. */ } }
async function open(page: Page, suffix = "") {
  await page.goto(`${centerPath}${suffix}`);
  await expect(center(page).getByRole("heading", { name: "Delivery activity", exact: true })).toBeVisible();
}

test("audit-only staff land in the dedicated notification center without operation or mutation access", async ({ page }) => {
  const calls = await mock(page, route => route.fulfill({ json: result() }));
  await page.goto("/");
  await expect(page).toHaveURL(new RegExp(`${centerPath}$`));
  await expect(page.getByRole("heading", { name: "Notifications", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Open notifications" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("tab", { name: "Operations", exact: true })).toHaveCount(0);
  await expect(article(page)).toBeVisible();
  await expect(center(page).getByText(/Legacy folder subscriptions, explicit Project Alpha delivery notices, and opt-in summaries/)).toBeVisible();
  await expect(center(page).getByText("40 added · 2 removed", { exact: true })).toBeVisible();
  await expect(center(page).getByRole("button", { name: "Send now", exact: true })).toHaveCount(0);
  await expect(center(page).getByRole("button", { name: "Cancel notification", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(article(page)).toBeVisible();
  expect(calls.filter(call => call.method !== "GET")).toHaveLength(0);
  expect(calls.every(call => call.path === "/api/session" || call.path === endpoint)).toBe(true);
});

test("exact authenticated change notices use a distinct deep link and action route without exposing storage paths", async ({page}) => {
  const row = authenticatedNotice("exact-one", {canSendNow: true, canCancel: true, r2Prefix: "clients/acme/private/"});
  const pageResult = {...result([row]), availability: {folderChanges: true, nativeDeliveries: true, authenticatedDeliveries: true}};
  const calls = await mock(page, (route, url) => {
    if (url.pathname === `${endpoint}/authenticated_delivery/exact-one/send-now`) return route.fulfill({json: {ok: true, kind: "authenticated_delivery", id: "exact-one", action: "send-now", revision: 2, status: "pending", replayed: false}});
    if (url.pathname === `${endpoint}/authenticated_delivery/exact-one`) return route.fulfill({json: {item: row, serverNow: now, coverage: "delivery_notifications_v2", availability: pageResult.availability}});
    return route.fulfill({json: pageResult});
  });
  await open(page, "?kind=authenticated_delivery&batchId=exact-one");
  await expect(authenticatedArticle(page)).toContainText("Authenticated recipient changes");
  await expect(authenticatedArticle(page)).toContainText("3 added · 1 removed");
  await expect(center(page)).not.toContainText("clients/acme/private");
  await authenticatedArticle(page).getByRole("button", {name: "Send now"}).click();
  await expect(center(page).getByText(/Notification made eligible for dispatch\. This does not confirm delivery or change recipient access/)).toBeVisible();
  const action = calls.find(call => call.path.endsWith("/authenticated_delivery/exact-one/send-now"));
  expect(action?.method).toBe("POST");
  expect(action?.body).toEqual({expectedRevision: 1});
  expect(action?.key).toMatch(/^[0-9a-f-]{36}$/);
});

test("published authenticated bells retain their portal notice while staff suppress only the pending email", async ({page}, testInfo) => {
  let suppressed = false;
  const row = authenticatedNotice("published-one", {bellPublishedAt: now, canSuppressEmail: true, canSendNow: false, canCancel: false});
  const pageResult = {...result([row]), availability: {folderChanges: true, nativeDeliveries: true, authenticatedDeliveries: true}};
  const calls = await mock(page, (route, url) => {
    if (url.pathname === `${endpoint}/authenticated_delivery/published-one/suppress-email`) {
      suppressed = true;
      return route.fulfill({json: {ok: true, kind: "authenticated_delivery", id: "published-one", action: "suppress-email", revision: 2, status: "suppressed", replayed: false}});
    }
    if (url.pathname === `${endpoint}/authenticated_delivery/published-one`) return route.fulfill({json: {item: suppressed ? {
      ...row, revision: 2, status: "suppressed", emailSuppressedAt: now, canSuppressEmail: false,
    } : row, serverNow: now, coverage: "delivery_notifications_v2", availability: pageResult.availability}});
    return route.fulfill({json: suppressed ? {...pageResult, items: []} : pageResult});
  });
  await open(page, "?kind=authenticated_delivery&batchId=published-one");
  const rowArticle = authenticatedArticle(page);
  await expect(rowArticle).toContainText("Bell"); await expect(rowArticle).toContainText("Published");
  await expect(rowArticle).toContainText("Email"); await expect(rowArticle).toContainText("Pending");
  await expect(rowArticle.getByRole("button", {name: "Send now", exact: true})).toHaveCount(0);
  await expect(rowArticle.getByRole("button", {name: "Cancel notification", exact: true})).toHaveCount(0);
  for (const width of [375, 1280]) { await page.setViewportSize({width, height: 900}); await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({path: testInfo.outputPath(`authenticated-bell-pending-email-${width}.png`), fullPage: true}); }
  page.once("dialog", dialog => { expect(dialog.message()).toContain("does not change access"); expect(dialog.message()).toContain("does not recall the bell notification"); return dialog.accept(); });
  await rowArticle.getByRole("button", {name: "Suppress email", exact: true}).click();
  await expect(center(page).getByText("Email suppressed. Files and access are unchanged, and an already published bell notification cannot be recalled.", {exact: true})).toBeVisible();
  await expect(rowArticle).toContainText("Published"); await expect(rowArticle).toContainText("Suppressed");
  await expect(rowArticle).toContainText("Email suppressed by staff. The published bell notice remains subject to current client access.");
  await expect(rowArticle).not.toContainText("Not sent after eligibility checks.");
  await expect(rowArticle.getByRole("button", {name: "Suppress email", exact: true})).toHaveCount(0);
  for (const width of [375, 1280]) { await page.setViewportSize({width, height: 900}); await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({path: testInfo.outputPath(`authenticated-bell-email-suppressed-${width}.png`), fullPage: true}); }
  const action = calls.find(call => call.path === `${endpoint}/authenticated_delivery/published-one/suppress-email`);
  expect(action?.method).toBe("POST"); expect(action?.body).toEqual({expectedRevision: 1});
  expect(action?.key).toMatch(/^[0-9a-f-]{36}$/);
});

test("the notification bell preserves SOP navigation and browser history", async ({ page }) => {
  await mock(page, route => route.fulfill({ json: result() }), ["sops.view", "delivery.share.audit"]);
  await page.goto("/operations/sops");
  await page.getByRole("link", { name: "Open notifications" }).click();
  await expect(page).toHaveURL(new RegExp(`${centerPath}$`));
  await expect(article(page)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/operations\/sops$/);
  await expect(page.getByRole("tab", { name: "SOP Library" })).toHaveAttribute("aria-selected", "true");
  await page.goForward();
  await expect(article(page)).toBeVisible();
});

test("staff without audit permission never probe notification APIs", async ({ page }) => {
  const calls = await mock(page, route => route.fulfill({ status: 404, json: { error: "Not found" } }), ["sops.view", "delivery.share.create", "delivery.share.revoke"]);
  await page.goto(centerPath);
  await expect(page).toHaveURL(/\/operations\/sops$/);
  await expect(center(page)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open notifications" })).toHaveCount(0);
  expect(calls.filter(call => call.path.startsWith(endpoint))).toHaveLength(0);
});

test("server search and history selection persist through refresh and Back without inventing unsupported status filters", async ({ page }) => {
  const calls = await mock(page, (route, url) => route.fulfill({ json: result([batch(url.searchParams.get("q") || "unfiltered", {
    accountName: url.searchParams.get("q") || "Acme Construction", ...(url.searchParams.get("view") === "history" ? { status: "sent", deliveredAt: now } : {}) })]) }));
  await open(page);
  await center(page).getByRole("textbox", { name: "Search notifications" }).fill("Gelsman");
  await center(page).getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/\?q=Gelsman$/);
  await expect(article(page, "Gelsman · Church survey · Edited")).toBeVisible();
  await center(page).getByRole("button", { name: "History", exact: true }).click();
  await expect(page).toHaveURL(/\?view=history&q=Gelsman$/);
  await expect(article(page, "Gelsman · Church survey · Edited").getByText("Sent", { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(center(page).getByRole("button", { name: "History", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(center(page).getByRole("textbox", { name: "Search notifications" })).toHaveValue("Gelsman");
  await page.goBack();
  await expect(page).toHaveURL(/\?q=Gelsman$/);
  await expect(center(page).getByRole("button", { name: "Pending", exact: true })).toHaveAttribute("aria-pressed", "true");
  await center(page).getByRole("button", { name: "Clear search" }).click();
  await expect(page).toHaveURL(new RegExp(`${centerPath}$`));
  expect(calls.filter(call => call.path === endpoint).every(call => !call.query.has("status"))).toBe(true);
});

test("empty candidate pages keep Load more and continuation failures retain records and cursor", async ({ page }) => {
  let moreCalls = 0, pending: Route | undefined;
  const calls = await mock(page, async (route, url) => {
    const cursor = url.searchParams.get("cursor");
    if (!cursor) return route.fulfill({ json: result([], "page-two") });
    if (cursor === "page-two") return route.fulfill({ json: result([batch()], "page-three") });
    moreCalls += 1;
    if (moreCalls === 1) { pending = route; return; }
    return route.fulfill({ json: result([batch(), batch("second", { accountName: "Other client" })]) });
  });
  await open(page);
  await expect(center(page).getByText("No matching notifications in this page", { exact: true })).toBeVisible();
  await expect(center(page).getByText("No pending notifications found", { exact: true })).toHaveCount(0);
  const more = center(page).getByRole("button", { name: "Load more notifications", exact: true });
  await more.focus(); await page.keyboard.press("Enter");
  await expect(article(page)).toBeVisible();
  await expect(more).toBeFocused();
  await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
  await expect.poll(() => Boolean(pending)).toBe(true);
  expect(moreCalls).toBe(1);
  await pending!.fulfill({ status: 503, json: { error: "History service temporarily unavailable" } });
  await expect(article(page)).toBeVisible();
  await center(page).getByRole("button", { name: "Retry notifications" }).click();
  await expect(article(page, "Other client · Church survey · Edited")).toBeVisible();
  await expect(article(page)).toHaveCount(1);
  expect(calls.filter(call => call.query.get("cursor") === "page-three")).toHaveLength(2);
  await expect(center(page).getByRole("button", { name: "No more notifications" })).toHaveAttribute("aria-disabled", "true");
});

test("new route search aborts earlier reads and late pending batches cannot replace history", async ({ page }) => {
  let stale: Route | undefined;
  await mock(page, (route, url) => {
    if (url.searchParams.get("q") === "slow" && url.searchParams.get("view") === "pending") { stale = route; return Promise.resolve(); }
    return route.fulfill({ json: result([batch("history", { status: "sent", accountName: "Fresh history", deliveredAt: now })]) });
  });
  await open(page, "?q=slow");
  await expect.poll(() => Boolean(stale)).toBe(true);
  await center(page).getByRole("button", { name: "History", exact: true }).click();
  await expect(article(page, "Fresh history · Church survey · Edited")).toBeVisible();
  await late(stale!, result([batch("stale", { accountName: "Stale pending" })]));
  await expect(center(page).getByText("Stale pending", { exact: true })).toHaveCount(0);
});

test("countdown uses server time, becomes eligible without claiming delivery, and processing cannot be cancelled", async ({ page }) => {
  await page.clock.install({ time: new Date("2034-01-01T00:00:00Z") });
  await mock(page, route => route.fulfill({ json: result([batch("countdown", { eligibleAt: "2026-08-25T12:00:02Z" }),
    batch("processing", { accountName: "Processing client", status: "processing", canCancel: true, canSendNow: true })]) }));
  await open(page);
  await expect(article(page).getByText("Eligible in 0:02", { exact: true })).toBeVisible();
  await page.clock.fastForward(3000);
  await expect(article(page).getByText("Ready for dispatch", { exact: true })).toBeVisible();
  await expect(article(page).getByText("Sent", { exact: true })).toHaveCount(0);
  const processing = article(page, "Processing client · Church survey · Edited");
  await expect(processing.getByText("Dispatch in progress", { exact: true })).toBeVisible();
  await expect(processing.getByRole("button")).toHaveCount(0);
});

test("Send now uses exact revision and one operation key through uncertain retry without implying receipt", async ({ page }) => {
  let attempts = 0, pending: Route | undefined, sentNow = false;
  const calls = await mock(page, async (route, url) => {
    if (route.request().method() === "GET") return route.fulfill({ json: result([batch("batch-one", { canSendNow: true, canCancel: true, revision: sentNow ? 2 : 1,
      eligibleAt: sentNow ? now : "2026-08-25T12:05:00Z" })]) });
    attempts += 1;
    expect(url.pathname).toBe(`${endpoint}/batch-one/send-now`);
    expect(route.request().headers()["x-csrf-token"]).toBe("csrf-notifications");
    if (attempts === 1) { pending = route; return; }
    sentNow = true;
    return route.fulfill({ json: { ok: true, id: "batch-one", action: "send-now", revision: 2, status: "pending", replayed: true } });
  }, ["delivery.share.audit", "delivery.share.create", "delivery.share.revoke"]);
  await open(page);
  const send = article(page).getByRole("button", { name: "Send now", exact: true });
  await send.click();
  await expect(send).toBeDisabled();
  await expect(article(page).getByRole("button", { name: "Cancel notification" })).toBeDisabled();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await pending!.fulfill({ status: 503, json: { error: "Could not confirm outcome" } });
  await center(page).getByRole("button", { name: "Retry action", exact: true }).click();
  await expect(center(page).getByText(/Notification made eligible for dispatch/)).toBeVisible();
  await expect(article(page).getByText("Ready for dispatch", { exact: true })).toBeVisible();
  const writes = calls.filter(call => call.method === "POST");
  expect(writes).toHaveLength(2); expect(writes[0]!.key).toBeTruthy(); expect(writes[1]!.key).toBe(writes[0]!.key);
  expect(writes.map(call => call.body)).toEqual([{ expectedRevision: 1 }, { expectedRevision: 1 }]);
  await expect(center(page).getByText(/recipient received/i)).not.toBeVisible();
});

test("Cancel needs confirmation and a stale pre-cancel snapshot cannot restore the pending notification", async ({ page }) => {
  let cancelled = false;
  const calls = await mock(page, (route, url) => {
    if (route.request().method() === "POST") {
      cancelled = true;
      return route.fulfill({ json: { ok: true, id: "batch-one", action: "cancel", revision: 2, status: "cancelled", replayed: false } });
    }
    return route.fulfill({ json: url.searchParams.get("view") === "history" ? result([batch("batch-one", { revision: 2, status: "cancelled" })]) : result([batch("batch-one", { canCancel: true })]) });
  });
  await open(page);
  page.once("dialog", dialog => { expect(dialog.message()).toContain("does not remove files or change access"); return dialog.dismiss(); });
  await article(page).getByRole("button", { name: "Cancel notification" }).click();
  expect(cancelled).toBe(false);
  page.once("dialog", dialog => {
    expect(dialog.message()).toContain("Later file changes");
    expect(dialog.message()).toContain("published inbox notices cannot be recalled");
    return dialog.accept();
  });
  await article(page).getByRole("button", { name: "Cancel notification" }).click();
  await expect(center(page).getByText(/Notification cancelled\. Files and access are unchanged/)).toBeVisible();
  await expect(center(page).getByText(/Email already accepted for delivery and published inbox notices cannot be recalled/)).toBeVisible();
  await expect(article(page)).toHaveCount(0);
  await center(page).getByRole("button", { name: "History", exact: true }).click();
  await expect(article(page).getByText("Cancelled", { exact: true })).toBeVisible();
  expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
});

for (const malformed of ["status", "revision"] as const) test(`a mismatched ${malformed} action receipt stays uncertain and cannot falsely confirm cancellation`, async ({ page }) => {
  await mock(page, route => route.request().method() === "GET" ? route.fulfill({ json: result([batch("batch-one", { canCancel: true })]) })
    : route.fulfill({ json: { ok: true, id: "batch-one", action: "cancel", revision: malformed === "revision" ? 3 : 2,
      status: malformed === "status" ? "pending" : "cancelled", replayed: false } }));
  await open(page);
  page.once("dialog", dialog => dialog.accept());
  await article(page).getByRole("button", { name: "Cancel notification" }).click();
  await expect(center(page).getByRole("button", { name: "Retry action", exact: true })).toBeVisible();
  await expect(center(page).getByText(/Notification cancelled\./)).toHaveCount(0);
  await expect(article(page).getByRole("button", { name: "Cancel notification" })).toBeDisabled();
});

test("server eligibility controls override staff mutation permissions and retry copy explains non-recallable notices", async ({ page }) => {
  await mock(page, route => route.fulfill({ json: result([batch("unavailable", { recipientEmail: null, canSendNow: false, canCancel: false }),
    batch("retry", { accountName: "Retry client", errorCode: "delivery-attempt-failed", canSendNow: false, canCancel: true })]) }),
  ["delivery.share.audit", "delivery.share.create", "delivery.share.revoke"]);
  await open(page);
  await expect(article(page).getByText("Recipient unavailable", { exact: true })).toBeVisible();
  await expect(article(page).getByRole("button")).toHaveCount(0);
  const retry = article(page, "Retry client · Church survey · Edited");
  await expect(retry.getByText(/An earlier email may already have been accepted/)).toBeVisible();
  await expect(retry.getByRole("button", { name: "Send now", exact: true })).toHaveCount(0);
  await expect(retry.getByRole("button", { name: "Cancel notification", exact: true })).toBeVisible();
});

test("an uncertain action survives filter navigation and retries its original revision instead of starting a new action", async ({ page }) => {
  let attempts = 0;
  const calls = await mock(page, (route, url) => {
    if (route.request().method() === "POST") {
      attempts += 1;
      return route.fulfill(attempts === 1 ? { status: 503, json: { error: "Connection lost" } }
        : { json: { ok: true, id: "batch-one", action: "send-now", revision: 2, status: "pending", replayed: true } });
    }
    return route.fulfill({ json: result(url.searchParams.get("view") === "history" ? [] : [batch("batch-one", { canSendNow: true })]) });
  });
  await open(page);
  await article(page).getByRole("button", { name: "Send now", exact: true }).click();
  await expect(center(page).getByRole("button", { name: "Retry action", exact: true })).toBeVisible();
  await center(page).getByRole("button", { name: "History", exact: true }).click();
  await expect(center(page).getByText("No notification history found", { exact: true })).toBeVisible();
  await center(page).getByRole("button", { name: "Retry action", exact: true }).click();
  await expect(center(page).getByText(/Notification made eligible for dispatch/)).toBeVisible();
  await expect(page).toHaveURL(/\?view=history$/);
  const writes = calls.filter(call => call.method === "POST");
  expect(writes).toHaveLength(2); expect(writes[0]!.key).toBe(writes[1]!.key);
  expect(writes[1]!.body).toEqual({ expectedRevision: 1 });
  await expect(article(page)).toHaveCount(0);
});

test("pending refresh updates state without discarding explicitly loaded pages or restoring older duplicate revisions", async ({ page }) => {
  await page.clock.install({ time: new Date(now) });
  let firstReads = 0;
  await mock(page, (route, url) => {
    if (url.searchParams.has("cursor")) return route.fulfill({ json: result([batch("batch-one", { revision: 1, addedCount: 1 }), batch("two", { accountName: "Second client" })]) });
    firstReads += 1;
    return route.fulfill({ json: result([batch("batch-one", { revision: firstReads + 1, addedCount: firstReads === 1 ? 45 : 46 })], "next") });
  });
  await open(page);
  await expect(article(page).getByText("45 added · 2 removed", { exact: true })).toBeVisible();
  await page.clock.fastForward(20_000);
  await expect.poll(() => firstReads).toBe(2);
  await expect(article(page).getByText("46 added · 2 removed", { exact: true })).toBeVisible();
  await center(page).getByRole("button", { name: "Load more notifications" }).click();
  await expect(article(page, "Second client · Church survey · Edited")).toBeVisible();
  await expect(article(page).getByText("46 added · 2 removed", { exact: true })).toBeVisible();
  await page.clock.fastForward(40_000);
  expect(firstReads).toBe(2);
  await expect(article(page, "Second client · Church survey · Edited")).toBeVisible();
});

test("dispatch claim conflicts refresh authoritative state without retrying or cancelling processing work", async ({ page }) => {
  let processing = false;
  const calls = await mock(page, route => {
    if (route.request().method() === "POST") { processing = true; return route.fulfill({ status: 409, json: { error: "Already claimed" } }); }
    return route.fulfill({ json: result([batch("batch-one", { canCancel: !processing, status: processing ? "processing" : "pending", revision: processing ? 2 : 1 })]) });
  });
  await open(page);
  page.once("dialog", dialog => dialog.accept());
  await article(page).getByRole("button", { name: "Cancel notification" }).click();
  await expect(center(page).getByText(/changed before the action could be applied/)).toBeVisible();
  await expect(article(page).getByText("Dispatch in progress", { exact: true })).toBeVisible();
  await expect(center(page).getByRole("button", { name: "Retry action", exact: true })).toHaveCount(0);
  expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
});

for (const code of [401, 403, 409] as const) {
  test(`a ${code} continuation clears loaded batches rather than keeping stale protected content`, async ({ page }) => {
    await mock(page, (route, url) => route.fulfill(url.searchParams.has("cursor")
      ? { status: code, json: { error: "Notification access changed" } } : { json: result([batch()], "next") }));
    await open(page);
    await expect(article(page)).toBeVisible();
    await center(page).getByRole("button", { name: "Load more notifications" }).click();
    await expect(center(page).getByRole("alert")).toBeVisible();
    await expect(article(page)).toHaveCount(0);
    await expect(center(page).getByRole("button", { name: "Load more notifications" })).toHaveCount(0);
  });
}

for (const status of [403, 409]) test(`an action pending during a ${status} context change cannot restore cleared notification data`, async ({ page }) => {
  let pending: Route | undefined;
  await mock(page, (route, url) => {
    if (route.request().method() === "POST") { pending = route; return Promise.resolve(); }
    return route.fulfill(url.searchParams.get("view") === "history" ? { status, json: { error: "Access withdrawn" } }
      : { json: result([batch("batch-one", { canSendNow: true })]) });
  });
  await open(page);
  await article(page).getByRole("button", { name: "Send now", exact: true }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await center(page).getByRole("button", { name: "History", exact: true }).click();
  await expect(center(page).getByText(status === 403 ? "Notification access is no longer available." : "Notifications changed while this page was loading. Refresh the list.", { exact: true })).toBeVisible();
  await late(pending!, { ok: true, id: "batch-one", action: "send-now", revision: 2, status: "pending", replayed: false });
  await expect(article(page)).toHaveCount(0);
  await expect(center(page).getByText(/Notification made eligible/)).toHaveCount(0);
});

test("unmount aborts a pending notification read and later responses cannot interrupt another Operations view", async ({ page }) => {
  let pending: Route | undefined;
  await mock(page, route => { pending = route; return Promise.resolve(); }, ["sops.view", "delivery.share.audit"]);
  await open(page);
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.evaluate(() => { history.pushState(null, "", "/operations/sops"); dispatchEvent(new PopStateEvent("popstate")); });
  await late(pending!, result());
  await expect(page).toHaveURL(/\/operations\/sops$/);
  await expect(center(page)).toHaveCount(0);
});

test("malformed notification fields fail safely and initial failures have a real retry", async ({ page }) => {
  let reads = 0;
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await mock(page, route => {
    reads += 1;
    return route.fulfill({ json: result([batch("batch-one", reads === 1 ? { accountName: { private: "bad-field" } } : {})]) });
  });
  await open(page);
  await expect(center(page).getByText(/Notification records could not be verified/)).toBeVisible();
  await expect(article(page)).toHaveCount(0);
  await center(page).getByRole("button", { name: "Retry notifications" }).click();
  await expect(article(page)).toBeVisible();
  expect(errors).toEqual([]);
});

test("notification cards and actions remain readable at mobile, narrow, laptop and ultrawide sizes", async ({ page }, testInfo) => {
  const longName = "Acme Construction Services — Regional delivery and survey coordination";
  await mock(page, route => route.fulfill({ json: result([batch("long", { accountName: longName,
    folderLabel: "Church survey / Client-approved edited imagery and final deliverables", recipientEmail: "delivery-coordinator-with-long-name@regional-construction-services.example.test", canSendNow: true, canCancel: true }),
    batch("second", { accountName: "Second client", status: "processing" })]) }));
  await open(page);
  for (const width of [375, 640, 1280, 3440]) {
    await page.setViewportSize({ width, height: 960 });
    await expect(center(page).getByRole("heading", { name: longName })).toBeVisible();
    await expectNotificationSpacing(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(center(page).getByRole("heading", { name: "Delivery activity", exact: true, level: 2 })).toBeVisible();
    for (const control of await center(page).getByRole("button").all()) {
      if (await control.isVisible()) expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    const refresh = center(page).getByRole("button", { name: "Refresh notifications" });
    await refresh.focus(); await page.keyboard.press("Enter");
    await expect(center(page).getByRole("heading", { name: longName })).toBeVisible();
    await expect(center(page).getByText("Loading notifications…", { exact: true })).toHaveCount(0);
    await expect(refresh).toBeFocused();
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`notifications-${width}.png`) });
    await page.screenshot({ path: testInfo.outputPath(`notifications-${width}-full.png`), fullPage: true });
  }
});

test("notification guidance and simultaneous action and load errors retain accessible spacing", async ({ page }, testInfo) => {
  let reads = 0;
  await mock(page, route => {
    if (route.request().method() === "POST") return route.fulfill({ status: 503, json: { error: "Outcome not confirmed" } });
    reads += 1;
    return route.fulfill(reads === 1 ? { json: result([batch("batch-one", { canSendNow: true })]) }
      : { status: 503, json: { error: "Notifications temporarily unavailable. Your previous update is still shown." } });
  });
  await open(page);
  await article(page).getByRole("button", { name: "Send now", exact: true }).click();
  await expect(center(page).getByRole("button", { name: "Retry action", exact: true })).toBeVisible();
  await center(page).getByRole("button", { name: "Refresh notifications" }).click();
  await expect(center(page).getByRole("button", { name: "Retry notifications" })).toBeVisible();
  const guidance = center(page).locator("summary");
  await guidance.focus(); await page.keyboard.press("Enter");
  await expect(center(page).getByText(/The countdown shows the earliest dispatch time/)).toBeVisible();
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 960 });
    await expectNotificationSpacing(page);
    await expect(center(page).getByRole("alert")).toHaveCount(2);
    const error = center(page).locator(".notification-error");
    const label = await error.locator("span").boundingBox(), retry = await error.getByRole("button").boundingBox();
    expect(Math.max(retry!.x - label!.x - label!.width, retry!.y - label!.y - label!.height)).toBeGreaterThanOrEqual(8);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`notification-errors-${width}.png`), fullPage: true });
  }
});

test("combined pages retain equal raw IDs across kinds and show native audience without invented file counts", async ({ page }) => {
  const calls = await mock(page, (route, url) => route.fulfill({ json: result(url.searchParams.has("cursor")
    ? [nativeNotice("nb_same", { revision: 2, eventLabel: "Updated delivery ready" }), batch("nb_same", { revision: 2, addedCount: 15 })]
    : [batch("nb_same"), nativeNotice("nb_same")], url.searchParams.has("cursor") ? null : "next") }));
  await open(page);
  await expect(center(page).getByRole("article")).toHaveCount(2);
  await expect(nativeArticle(page)).toContainText("Acme portal workspace");
  await expect(nativeArticle(page)).toContainText("Survey business source");
  await expect(nativeArticle(page)).toContainText("Delivery ready");
  await expect(nativeArticle(page).getByText("Net changes", { exact: true })).toHaveCount(0);
  await expect(nativeArticle(page)).not.toContainText(/\d+ added|\d+ removed/);
  await center(page).getByRole("button", { name: "Load more notifications" }).click();
  await expect(nativeArticle(page)).toContainText("Updated delivery ready");
  await expect(center(page).getByRole("article")).toHaveCount(2);
  await expect(center(page).locator('article[data-notification-kind="folder_changes"]')).toContainText("15 added");
  expect(calls.filter(call => call.path === endpoint).every(call => call.query.get("format") === "combined")).toBe(true);
});

test("unavailable native storage shows upgrade-required coverage without hiding available folder notices", async ({ page }) => {
  await mock(page, route => route.fulfill({ json: { ...result(), availability: { folderChanges: true, nativeDeliveries: false } } }));
  await open(page);
  await expect(article(page)).toBeVisible();
  await expect(center(page).getByRole("status").filter({ hasText: "notification database upgrade" })).toBeVisible();
  await expect(nativeArticle(page)).toHaveCount(0);
  await expect(center(page).getByText("No pending notifications found", { exact: true })).toHaveCount(0);
});

test("an unavailable native exact notice never falls back to legacy or a list scan", async ({ page }) => {
  const calls = await mock(page, route => route.fulfill({ status: 503, json: { error: "Native delivery notification upgrade required." } }));
  await open(page, "?kind=portal_delivery&batchId=nb_one");
  await expect(center(page).getByRole("alert")).toContainText("upgrade required");
  await expect(center(page).getByRole("article")).toHaveCount(0);
  await expect(center(page).getByText("No pending notifications found", { exact: true })).toHaveCount(0);
  expect(calls.filter(call => call.path.startsWith(endpoint)).map(call => call.path)).toEqual([`${endpoint}/portal_delivery/nb_one`]);
});

test("native exact links preserve kind through reload and Back and reject a same-ID folder response", async ({ page }) => {
  let wrong = true;
  const calls = await mock(page, (route, url) => route.fulfill({ json: url.pathname === endpoint ? result([])
    : { item: wrong ? batch("nb_one") : nativeNotice(), serverNow: now, coverage: "delivery_notifications_v2", availability: { folderChanges: true, nativeDeliveries: true } } }));
  await open(page, "?kind=portal_delivery&batchId=nb_one");
  await expect(center(page).getByRole("alert")).toContainText("could not be verified");
  await expect(center(page).getByRole("article")).toHaveCount(0);
  wrong = false; await center(page).getByRole("button", { name: "Retry notifications" }).click();
  await expect(nativeArticle(page)).toBeVisible();
  await page.reload(); await expect(nativeArticle(page)).toBeVisible();
  await center(page).getByRole("button", { name: "History", exact: true }).click();
  await expect(page).toHaveURL(/\?view=history$/);
  await page.goBack(); await expect(nativeArticle(page)).toBeVisible();
  await expect(page).toHaveURL(/\?kind=portal_delivery&batchId=nb_one$/);
  expect(calls.filter(call => call.path.startsWith(endpoint) && call.path !== endpoint).every(call => call.path === `${endpoint}/portal_delivery/nb_one`)).toBe(true);
  expect(calls.every(call => call.method === "GET")).toBe(true);
});

for (const query of ["kind=unknown&batchId=nb_one", "kind=portal_delivery&kind=folder_changes&batchId=nb_one", "kind=portal_delivery"]) test(`ambiguous native route ${query} cannot probe a different notification namespace`, async ({ page }) => {
  const calls = await mock(page, route => route.fulfill({ json: result() }));
  await open(page, `?${query}`);
  await expect(center(page).getByRole("alert")).toContainText("notification link is invalid");
  expect(calls.filter(call => call.path.startsWith(endpoint))).toEqual([]);
});

test("native Send now retries the original kind, revision and operation key across history navigation", async ({ page }) => {
  let attempts = 0;
  const calls = await mock(page, (route, url) => {
    if (route.request().method() === "POST") return route.fulfill(++attempts === 1 ? { status: 503, json: { error: "Uncertain" } }
      : { json: { ok: true, kind: "portal_delivery", id: "nb_one", action: "send-now", revision: 2, status: "pending", replayed: true } });
    return route.fulfill({ json: result(url.searchParams.get("view") === "history" ? [] : [nativeNotice("nb_one", { canSendNow: true })]) });
  });
  await open(page); await nativeArticle(page).getByRole("button", { name: "Send now", exact: true }).click();
  await expect(center(page).getByRole("button", { name: "Retry action" })).toBeVisible();
  await center(page).getByRole("button", { name: "History", exact: true }).click();
  await center(page).getByRole("button", { name: "Retry action" }).click();
  await expect(center(page).getByRole("status").filter({ hasText: "does not confirm delivery or change recipient access" })).toBeVisible();
  const posts = calls.filter(call => call.method === "POST");
  expect(posts.map(call => call.path)).toEqual([`${endpoint}/portal_delivery/nb_one/send-now`, `${endpoint}/portal_delivery/nb_one/send-now`]);
  expect(posts[0]?.key).toBeTruthy(); expect(posts[1]?.key).toBe(posts[0]?.key);
  expect(posts.map(call => call.body)).toEqual([{ expectedRevision: 1 }, { expectedRevision: 1 }]);
  await expect(page).toHaveURL(/\?view=history$/);
});

test("native cancellation cannot remove a same-ID folder notice or resurrect its own stale pre-action row", async ({ page }) => {
  const calls = await mock(page, route => route.fulfill(route.request().method() === "POST"
    ? { json: { ok: true, kind: "portal_delivery", id: "nb_same", action: "cancel", revision: 2, status: "cancelled", replayed: false } }
    : { json: result([batch("nb_same"), nativeNotice("nb_same", { canCancel: true })]) }));
  await open(page);
  page.once("dialog", async dialog => {
    expect(dialog.message()).toContain("Acme portal workspace"); expect(dialog.message()).toContain("Survey business source");
    expect(dialog.message()).toContain("alex@example.test"); expect(dialog.message()).toContain("delivery itself is not revoked");
    expect(dialog.message()).toContain("cannot be recalled"); await dialog.accept();
  });
  await nativeArticle(page).getByRole("button", { name: "Cancel notification" }).click();
  await expect(center(page).getByRole("status").filter({ hasText: "Notification cancelled" })).toBeVisible();
  await expect(nativeArticle(page)).toHaveCount(0);
  await expect(center(page).locator('article[data-notification-kind="folder_changes"]')).toBeVisible();
  expect(calls.filter(call => call.method === "POST").map(call => call.path)).toEqual([`${endpoint}/portal_delivery/nb_same/cancel`]);
});

test("a native action receipt without its kind stays uncertain and cannot confirm cancellation", async ({ page }) => {
  await mock(page, route => route.fulfill(route.request().method() === "POST"
    ? { json: { ok: true, id: "nb_one", action: "cancel", revision: 2, status: "cancelled", replayed: false } }
    : { json: result([nativeNotice("nb_one", { canCancel: true })]) }));
  await open(page); page.once("dialog", dialog => dialog.accept());
  await nativeArticle(page).getByRole("button", { name: "Cancel notification" }).click();
  await expect(center(page).getByRole("button", { name: "Retry action" })).toBeVisible();
  await expect(center(page).getByText(/Notification cancelled\./)).toHaveCount(0);
  await expect(nativeArticle(page)).toBeVisible();
});

for (const deliveryMode of ["direct_legacy", "awaiting_staging"]) test(`${deliveryMode} native notices remain read-only without implying file-change counts`, async ({ page }) => {
  await mock(page, route => route.fulfill({ json: result([nativeNotice("nd_one", { deliveryMode })]) }));
  await open(page);
  await expect(nativeArticle(page)).toContainText(deliveryMode === "direct_legacy" ? "Earlier direct-dispatch notice" : "Awaiting staging");
  await expect(nativeArticle(page).getByRole("button")).toHaveCount(0);
  await expect(nativeArticle(page).getByText("Net changes", { exact: true })).toHaveCount(0);
  if (deliveryMode === "awaiting_staging") await expect(nativeArticle(page)).not.toContainText("Ready for dispatch");
});

test("mixed native and folder notices stay readable and keyboard accessible at four viewport widths", async ({ page }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await mock(page, route => route.fulfill({ json: result([batch(), nativeNotice("nb_one", {
    workspaceName: "North district construction and environmental survey documentation workspace",
    sourceName: "Regional aerial surveying and environmental documentation business source",
    folderLabel: "Community building construction survey · Approved delivery photographs", recipientEmail: "long-recipient-name@regional-survey-company.example.test", canSendNow: true, canCancel: true,
  })]) }));
  await open(page); await expect(nativeArticle(page)).toBeVisible();
  for (const width of [375, 640, 1280, 3440]) {
    await page.setViewportSize({ width, height: 1000 }); await expectNotificationSpacing(page);
    const button = nativeArticle(page).getByRole("button", { name: "Send now", exact: true });
    await button.focus(); await expect(button).toBeFocused();
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const fields = await nativeArticle(page).locator("dl > div").evaluateAll(nodes => nodes.map(node => {
      const label = node.querySelector("dt")!.getBoundingClientRect(), value = node.querySelector("dd")!.getBoundingClientRect();
      return value.top - label.bottom;
    }));
    for (const gap of fields) expect(gap).toBeGreaterThanOrEqual(4);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`combined-notifications-${width}-viewport.png`) });
    await page.screenshot({ path: testInfo.outputPath(`combined-notifications-${width}-full.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});
