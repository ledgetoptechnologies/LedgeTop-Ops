import {expect, test, type Page, type Route} from "@playwright/test";
const date = "2026-08-25T12:00:00Z", endpoint = "/api/operations/feedback";
function item(overrides: Record<string, unknown> = {}) {return {id: "feedback-one", status: "new", revision: 1, message: "Please check the north edge of the roof in the delivered image.", completionNote: null, createdAt: date, updatedAt: date, completedAt: null, accountName: "Acme Construction", canStart: true, canComplete: true, target: {kind: "file", projectId: "project-one", label: "Church survey north edge.jpg", projectName: "Church survey", available: true, actionPath: null}, ...overrides};}
function detail(overrides: Record<string, unknown> = {}) {return {feedback: item(overrides), events: [{revision: 1, actor: "client", status: "new", note: null, createdAt: date}]};}
type Call = {path: string; method: string; query: URLSearchParams; body: any; key?: string};
async function mock(page: Page, custom?: (route: Route, url: URL, call: Call) => Promise<unknown> | undefined, enabled = true) {
  const calls: Call[] = [];
  await page.route("**/api/**", async route => {
    const req = route.request(), url = new URL(req.url()), call = {path: url.pathname, method: req.method(), query: url.searchParams, body: req.postData() ? req.postDataJSON() : null, key: req.headers()["idempotency-key"]}; calls.push(call);
    if (call.path === "/api/session") return route.fulfill({json: {user: {id: "staff-one", email: "staff@example.test", displayName: "Feedback reviewer", status: "Active", profileType: "Employee", isAdministrator: false, permissions: enabled ? [] : ["sops.view"], divisions: []}, csrfToken: "csrf-feedback", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {clientFeedback: {enabled}}}});
    const handled = custom?.(route, url, call); if (handled) return handled;
    if (call.path === "/api/sops") return route.fulfill({json: {sops: []}});
    if (call.path === endpoint) return route.fulfill({json: {items: [item()], nextCursor: null}});
    if (call.path === `${endpoint}/feedback-one`) return route.fulfill({json: detail()});
    if (call.path === `${endpoint}/feedback-one/status`) return route.fulfill({json: {...detail({status: call.body.status, revision: 2, completionNote: call.body.note, canStart: false, canComplete: call.body.status !== "done"}), replayed: false, appliedRevision: 2}});
    return route.fulfill({status: 404, json: {error: "Not found"}});
  }); return calls;
}
async function late(route: Route, json: unknown) {try {await route.fulfill({json});} catch {/* navigation abort */}}
const queue = (page: Page) => page.getByRole("region", {name: "Client feedback", exact: true});

test("feedback-specific readiness admits filtered staff without synthesizing unrelated operations permissions", async ({page}) => {
  const calls = await mock(page); await page.goto("/"); await expect(page).toHaveURL(/\/operations\/feedback$/); await expect(queue(page).getByRole("heading", {name: "Feedback queue"})).toBeVisible();
  await expect(page.getByRole("tab", {name: "Client feedback", exact: true})).toHaveAttribute("aria-selected", "true"); await expect(page.getByRole("tab", {name: "Projects", exact: true})).toHaveCount(0);
  expect(calls.every(call => ["/api/session", endpoint].includes(call.path))).toBe(true);
});

test("disabled feedback never probes its API even on a direct link", async ({page}) => {
  const calls = await mock(page, undefined, false); await page.goto("/operations/feedback/feedback-one"); await expect(page).toHaveURL(/\/operations\/sops$/); await expect(queue(page)).toHaveCount(0); expect(calls.some(call => call.path.startsWith(endpoint))).toBe(false);
});

test("status and server search preserve account scope through history and refresh", async ({page}) => {
  const calls = await mock(page); await page.goto("/operations/feedback?accountId=account-one"); await queue(page).getByRole("textbox", {name: "Search feedback"}).fill("north edge"); await queue(page).getByRole("button", {name: "Search", exact: true}).click();
  await queue(page).getByRole("button", {name: "Done", exact: true}).click(); await expect(page).toHaveURL(/status=done&q=north\+edge&accountId=account-one/); await page.reload(); await expect(queue(page).getByRole("button", {name: "Done", exact: true})).toHaveAttribute("aria-pressed", "true");
  await page.goBack(); await expect(queue(page).getByRole("button", {name: "New", exact: true})).toHaveAttribute("aria-pressed", "true"); expect(calls.some(call => call.query.get("q") === "north edge" && call.query.get("accountId") === "account-one")).toBe(true);
});

test("empty authorized scan page still allows continuation without claiming queue empty", async ({page}) => {
  await mock(page, (route, _url, call) => call.path === endpoint ? route.fulfill({json: call.query.has("cursor") ? {items: [item()], nextCursor: null} : {items: [], nextCursor: "next"}}) : undefined);
  await page.goto("/operations/feedback"); await expect(queue(page).getByText(/Continue to check more records/)).toBeVisible(); await queue(page).getByRole("button", {name: "Load more feedback"}).click(); await expect(queue(page).getByRole("link", {name: "Church survey north edge.jpg"})).toBeVisible();
});

test("New can move directly to Done with an optional client-visible completion note", async ({page}) => {
  const calls = await mock(page); await page.goto("/operations/feedback/feedback-one?status=new&accountId=account-one"); await queue(page).getByRole("button", {name: "Mark Done", exact: true}).click();
  await queue(page).getByLabel("Completion note (optional)").fill("Updated the export. Please review the same location."); await queue(page).getByRole("button", {name: "Confirm Done"}).click(); await expect(queue(page).getByText(/Feedback marked Done/)).toBeVisible();
  expect(calls.find(call => call.method === "POST")?.body).toEqual({expectedRevision: 1, status: "done", note: "Updated the export. Please review the same location."});
  expect(calls.find(call => call.method === "POST")?.key).toMatch(/^[a-f0-9-]{36}$/); await expect(queue(page).getByRole("link", {name: "Back to feedback queue"})).toHaveAttribute("href", "/operations/feedback?status=new&accountId=account-one");
  await expect(queue(page).locator('a[href^="/portal"]')).toHaveCount(0);
});

test("In Progress has no completion-note form and preserves null note contract", async ({page}) => {
  const calls = await mock(page); await page.goto("/operations/feedback/feedback-one"); await queue(page).getByRole("button", {name: "Mark In Progress"}).click(); await expect(queue(page).locator("textarea")).toHaveCount(0); await queue(page).getByRole("button", {name: "Confirm In Progress"}).click(); await expect(queue(page).getByText("Feedback marked In Progress.")).toBeVisible(); expect(calls.find(call => call.method === "POST")?.body.note).toBeNull();
});

test("uncertain status retry reuses exact action and key, duplicate click stays bounded", async ({page}) => {
  let attempts = 0; const calls = await mock(page, (route, _url, call) => call.path.endsWith("/status") ? (++attempts === 1 ? route.fulfill({status: 503, json: {error: "Uncertain"}}) : route.fulfill({json: {...detail({revision: 2, status: "done", canStart: false, canComplete: false}), replayed: true, appliedRevision: 2}})) : undefined);
  await page.goto("/operations/feedback/feedback-one"); await queue(page).getByRole("button", {name: "Mark Done", exact: true}).click(); await queue(page).getByRole("button", {name: "Confirm Done"}).click(); await expect(queue(page).getByRole("alert")).toContainText("could not confirm"); await expect(queue(page).getByLabel("Completion note (optional)")).toHaveAttribute("readonly", ""); await queue(page).getByRole("button", {name: "Retry update"}).click(); await expect(queue(page).getByText(/Feedback marked Done/)).toBeVisible();
  const posts = calls.filter(call => call.method === "POST"); expect(posts).toHaveLength(2); expect(posts[0]?.key).toBe(posts[1]?.key); expect(posts[0]?.body).toEqual(posts[1]?.body);
});

for (const status of [403, 409]) test(`status ${status} clears protected detail and prevents stale mutation retry`, async ({page}) => {
  await mock(page, (route, _url, call) => call.path.endsWith("/status") ? route.fulfill({status, json: {error: "Changed"}}) : undefined); await page.goto("/operations/feedback/feedback-one"); await queue(page).getByRole("button", {name: "Mark Done", exact: true}).click(); await queue(page).getByRole("button", {name: "Confirm Done"}).click(); await expect(queue(page).getByRole("alert")).toContainText("access changed"); await expect(queue(page).getByText("Acme Construction", {exact: true})).toHaveCount(0); await expect(queue(page).getByRole("button", {name: "Retry update"})).toHaveCount(0);
});

test("server row actions govern buttons and missing original does not produce a replacement link", async ({page}) => {
  await mock(page, (route, _url, call) => call.path === `${endpoint}/feedback-one` ? route.fulfill({json: detail({canStart: false, canComplete: false, target: {...item().target, available: false}})}) : undefined);
  await page.goto("/operations/feedback/feedback-one"); await expect(queue(page).getByText(/original item is no longer available/)).toBeVisible(); await expect(queue(page).getByRole("button", {name: /^Mark /})).toHaveCount(0); await expect(queue(page).locator('a[href^="/portal"]')).toHaveCount(0);
});

test("secondary feedback uses only its source-qualified Client Hub deep link", async ({page}) => {
  const actionPath = "/clients/sources/project-alpha%3Asecondary/business/organizations/0123456789abcdef0123456789abcdef/business-projects/project-internal";
  await mock(page, (route, _url, call) => call.path === `${endpoint}/native_feedback-one` ? route.fulfill({json: detail({
    id: "native_feedback-one", accountName: "Secondary client", target: {...item().target, actionPath},
  })}) : undefined);
  await page.goto("/operations/feedback/native_feedback-one");
  const link = queue(page).getByRole("link", {name: "Open original item"});
  await expect(link).toHaveAttribute("href", actionPath);
  await expect(queue(page).locator('a[href*="/clients/sources/project-alpha%3Asecondary/"]')).toHaveCount(1);
  await expect(queue(page).locator('a[href^="/portal"]')).toHaveCount(0);
});

test("late continuation from a prior filter cannot replace the current queue", async ({page}) => {
  let captured = false, release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
  const calls = await mock(page, (route, _url, call) => call.path === endpoint ? call.query.has("cursor") ? (captured = true, wait.then(() => late(route, {items: [item({message: "Stale protected row"})], nextCursor: null}))) : route.fulfill({json: {items: [item({message: call.query.get("status") === "done" ? "Completed view" : "Original view"})], nextCursor: call.query.get("status") === "done" ? null : "next"}}) : undefined);
  await page.goto("/operations/feedback"); await queue(page).getByRole("button", {name: "Load more feedback"}).click(); await expect.poll(() => captured).toBe(true); await queue(page).getByRole("button", {name: "Done", exact: true}).click(); await expect(queue(page).getByText("Completed view")).toBeVisible(); release(); await expect(queue(page).getByText("Stale protected row")).toHaveCount(0); expect(calls.filter(call => call.query.has("cursor"))).toHaveLength(1);
});

for (const width of [375, 640, 1280, 3440]) test(`feedback queue and completion form layout ${width}px`, async ({page}, info) => {
  await page.setViewportSize({width, height: 1000}); await mock(page); await page.goto("/operations/feedback"); await expect(queue(page).getByRole("link", {name: "Church survey north edge.jpg"})).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await queue(page).getByLabel("Search feedback").evaluate(input => ({height: input.getBoundingClientRect().height, padding: parseFloat(getComputedStyle(input).paddingLeft)}))).toMatchObject({height: expect.any(Number), padding: expect.any(Number)});
  expect(await queue(page).getByLabel("Search feedback").evaluate(input => input.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  expect(await queue(page).getByLabel("Search feedback").evaluate(input => parseFloat(getComputedStyle(input).paddingLeft))).toBeGreaterThanOrEqual(10);
  await page.screenshot({path: info.outputPath(`feedback-queue-${width}.png`)});
  await queue(page).getByRole("link", {name: "Church survey north edge.jpg"}).click(); await queue(page).getByRole("button", {name: "Mark Done", exact: true}).click(); await queue(page).getByLabel("Completion note (optional)").fill("Updated the export. Please review the original location linked in your feedback."); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({path: info.outputPath(`feedback-completion-${width}.png`)});
});
