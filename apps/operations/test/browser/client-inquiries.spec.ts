import { expect, test, type Page } from "@playwright/test";

const capabilities = { directory: true, requests: true, delivery: false, viewer: false };
const inquiry = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, kind: "website", title: `Request ${id}`,
  details: "Add online booking to our site.\nIt should match the current look.", location: "Harbor office", status, createdAt: "2026-10-30T12:00:00Z", ...extra });
type Patch = { id: string; body: unknown; csrf: string | undefined };

async function mock(page: Page, { permissions = ["team.view", "operations.manage"], inquiries = [] as Array<Record<string, unknown>>,
  list = 200, patch = (_call: Patch) => 200 }: { permissions?: string[]; inquiries?: Array<Record<string, unknown>>; list?: number; patch?: (call: Patch) => number } = {}) {
  const listed: URL[] = [], patches: Patch[] = [], directory: URL[] = [];
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-a", email: "staff@example.test", displayName: "Staff", status: "Active",
        profileType: "Employee", isAdministrator: false, permissions, divisions: [] },
      csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
    } });
    if (url.pathname === "/api/client-service-requests") return route.fulfill({ json: { requests: [] } });
    if (url.pathname === "/api/client-hub") {
      directory.push(url);
      return route.fulfill({ json: { clients: [], nextCursor: null, capabilities,
        sources: [{ source_id: "project-alpha:staging", display_name: "Project Alpha" }] } });
    }
    if (url.pathname === "/api/operations/inbox/inquiries" && route.request().method() === "GET") {
      listed.push(url);
      return list === 200 ? route.fulfill({ json: { items: inquiries, nextCursor: null } }) : route.fulfill({ status: list, json: { error: "Unavailable" } });
    }
    const match = url.pathname.match(/^\/api\/operations\/inbox\/inquiries\/([^/]+)$/);
    if (match && route.request().method() === "PATCH") {
      const call = { id: decodeURIComponent(match[1]!), body: route.request().postDataJSON(), csrf: route.request().headers()["x-csrf-token"] };
      patches.push(call);
      const status = patch(call);
      return route.fulfill(status === 200 ? { json: { inquiry: { ...inquiry(call.id, (call.body as { status: string }).status) } } } : { status, json: { error: "Conflict" } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return { listed, patches, directory };
}

test("staff review a general request in a popup and move it through review without leaving the Client Hub", async ({ page }) => {
  const { patches } = await mock(page, { inquiries: [inquiry("a", "received"), inquiry("b", "under_review", { kind: "drone", location: null }), inquiry("c", "closed")] });
  await page.goto("/clients");
  const queue = page.getByRole("region", { name: "General requests" });
  // Only open work is queued.
  await expect(queue.locator("article strong")).toHaveText(["Request a", "Request b"]);
  await expect(queue.locator("article").first()).toContainText("Website work · Harbor office");
  await expect(queue.locator("article").nth(1)).toContainText("Drone work");
  await queue.getByRole("button", { name: "Review Request a" }).click();
  const dialog = page.getByRole("dialog", { name: "Request a" });
  await expect(dialog).toContainText("General request · Website work");
  await expect(dialog).toContainText("It should match the current look.");
  await expect(dialog).toContainText("Harbor office");
  await expect(dialog.locator(".client-inquiry-actions button")).toHaveText(["Start review", "Decline"]);
  await dialog.getByRole("button", { name: "Start review" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(queue.getByRole("status")).toHaveText("“Request a” is now under review.");
  await expect(queue.locator("article").first().locator(".status-pill")).toHaveText("Under review");
  await queue.getByRole("button", { name: "Review Request a" }).click();
  await expect(dialog.locator(".client-inquiry-actions button")).toHaveText(["Mark done", "Decline"]);
  await dialog.getByRole("button", { name: "Mark done" }).click();
  await expect(queue.locator("article strong")).toHaveText(["Request b"]);
  // Declining asks first; cancelling sends nothing.
  await queue.getByRole("button", { name: "Review Request b" }).click();
  await page.getByRole("dialog", { name: "Request b" }).getByRole("button", { name: "Decline" }).click();
  await page.locator(".ops-confirm-action").getByRole("button", { name: "Cancel" }).click();
  expect(patches).toHaveLength(2);
  await page.getByRole("dialog", { name: "Request b" }).getByRole("button", { name: "Decline" }).click();
  await page.locator(".ops-confirm-action").getByRole("button", { name: "Confirm" }).click();
  await expect(queue.locator("article")).toHaveCount(0);
  await expect(queue.getByRole("status")).toHaveText("“Request b” is now declined.");
  expect(patches).toEqual([
    { id: "a", body: { status: "under_review" }, csrf: "csrf-test" },
    { id: "a", body: { status: "closed" }, csrf: "csrf-test" },
    { id: "b", body: { status: "declined" }, csrf: "csrf-test" },
  ]);
});

test("a change someone else already made is explained and leaves the request in place", async ({ page }) => {
  await mock(page, { inquiries: [inquiry("a", "received")], patch: () => 409 });
  await page.goto("/clients");
  const queue = page.getByRole("region", { name: "General requests" });
  await queue.getByRole("button", { name: "Review Request a" }).click();
  const dialog = page.getByRole("dialog", { name: "Request a" });
  await dialog.getByRole("button", { name: "Start review" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Someone else already changed this request. Refresh the page to see its current status.");
  await expect(dialog.getByRole("button", { name: "Start review" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(queue.locator("article .status-pill")).toHaveText("Received");
});

test("where general requests aren't offered yet the Client Hub shows nothing for them", async ({ page }) => {
  const { listed } = await mock(page, { list: 404 });
  await page.goto("/clients");
  await expect.poll(() => listed.length).toBe(1);
  await expect(page.getByRole("region", { name: "Client directory" })).toBeVisible();
  await expect(page.getByRole("region", { name: "General requests" })).toHaveCount(0);
});

test("an empty queue stays out of the way, but a notification link still lands on it", async ({ page }) => {
  await mock(page);
  await page.goto("/clients");
  await expect(page.getByRole("region", { name: "Client directory" })).toBeVisible();
  await expect(page.getByRole("region", { name: "General requests" })).toHaveCount(0);
  await page.goto("/operations/inbox?source=inquiries");
  await expect(page).toHaveURL(/\/clients\?source=inquiries$/);
  const queue = page.getByRole("region", { name: "General requests" });
  await expect(queue.getByText("No open general requests")).toBeVisible();
});

test("a notification link's queue marker never filters the client directory, while real filters still do", async ({ page }) => {
  const { directory } = await mock(page, { inquiries: [inquiry("inq-1", "received")] });
  await page.goto("/operations/inbox?source=inquiries");
  await expect(page).toHaveURL(/\/clients\?source=inquiries$/);
  await expect(page.getByRole("region", { name: "General requests" }).getByText("Request inq-1")).toBeVisible();
  const select = page.getByLabel("Client source");
  await expect(select).toHaveValue("");
  await expect(select.locator("option", { hasText: "Unavailable source" })).toHaveCount(0);
  await expect.poll(() => directory.length).toBeGreaterThan(0);
  expect(directory.every(url => !url.searchParams.has("source"))).toBe(true);

  directory.length = 0;
  await page.goto("/clients?q=harbor&kind=organization&source=project-alpha%3Astaging&sort=name");
  await expect(page.getByLabel("Client source")).toHaveValue("project-alpha:staging");
  await expect.poll(() => directory.length).toBeGreaterThan(0);
  const filtered = directory.at(-1)!.searchParams;
  expect([filtered.get("q"), filtered.get("kind"), filtered.get("source"), filtered.get("sort")])
    .toEqual(["harbor", "organization", "project-alpha:staging", "name"]);
});

test("staff without request review never load general requests", async ({ page }) => {
  const { listed } = await mock(page, { permissions: ["team.view"] });
  await page.goto("/clients");
  await expect(page.getByRole("region", { name: "Client directory" })).toBeVisible();
  expect(listed).toHaveLength(0);
  await expect(page.getByRole("region", { name: "General requests" })).toHaveCount(0);
});

for (const status of [401, 403]) {
  const action = status === 401 ? "Sign in again" : "Sign in with a different email";
  test(`general request list ${status} offers inline sign-in and retries reads only`, async ({ page }) => {
    const { listed, patches } = await mock(page, { list: status });
    await page.goto("/clients");
    const queue = page.getByRole("region", { name: "General requests" });
    const signIn = queue.getByRole("link", { name: action, exact: true });
    await expect(signIn).toBeVisible();
    await expect(signIn).toHaveAttribute("href", "/cdn-cgi/access/logout");
    const before = listed.length;
    await queue.getByRole("button", { name: "Try again", exact: true }).click();
    await expect.poll(() => listed.length).toBeGreaterThan(before);
    await expect(signIn).toBeVisible();
    expect(patches).toHaveLength(0);
  });

  test(`general request change ${status} offers inline sign-in without replaying the change`, async ({ page }) => {
    let attempts = 0;
    const { patches, listed } = await mock(page, { inquiries: [inquiry("a", "received")], patch: () => ++attempts === 1 ? status : 200 });
    await page.goto("/clients");
    const queue = page.getByRole("region", { name: "General requests" });
    await queue.getByRole("button", { name: "Review Request a" }).click();
    const dialog = page.getByRole("dialog", { name: "Request a" });
    await dialog.getByRole("button", { name: "Start review" }).click();
    await expect(dialog.getByRole("link", { name: action, exact: true })).toHaveAttribute("href", "/cdn-cgi/access/logout");
    expect(patches).toHaveLength(1);
    const before = listed.length;
    await dialog.getByRole("button", { name: "Try again", exact: true }).click();
    await expect.poll(() => listed.length).toBeGreaterThan(before);
    await expect(queue.getByRole("button", { name: "Review Request a" })).toBeVisible();
    expect(patches).toHaveLength(1);
    await queue.getByRole("button", { name: "Review Request a" }).click();
    await dialog.getByRole("button", { name: "Start review" }).click();
    await expect(queue.getByRole("status")).toHaveText("“Request a” is now under review.");
    expect(patches).toHaveLength(2);
  });
}
