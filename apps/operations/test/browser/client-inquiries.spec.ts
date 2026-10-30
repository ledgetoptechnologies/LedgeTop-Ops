import { expect, test, type Page } from "@playwright/test";

const capabilities = { directory: true, requests: true, delivery: false, viewer: false };
const inquiry = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, kind: "website", title: `Request ${id}`,
  details: "Add online booking to our site.\nIt should match the current look.", location: "Harbor office", status, createdAt: "2026-10-30T12:00:00Z", ...extra });
type Patch = { id: string; body: unknown; csrf: string | undefined };

async function mock(page: Page, { permissions = ["team.view", "operations.manage"], inquiries = [] as Array<Record<string, unknown>>,
  list = 200, patch = (_call: Patch) => 200 }: { permissions?: string[]; inquiries?: Array<Record<string, unknown>>; list?: number; patch?: (call: Patch) => number } = {}) {
  const listed: URL[] = [], patches: Patch[] = [];
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-a", email: "staff@example.test", displayName: "Staff", status: "Active",
        profileType: "Employee", isAdministrator: false, permissions, divisions: [] },
      csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
    } });
    if (url.pathname === "/api/client-service-requests") return route.fulfill({ json: { requests: [] } });
    if (url.pathname === "/api/client-hub") return route.fulfill({ json: { clients: [], nextCursor: null, capabilities } });
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
  return { listed, patches };
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

test("staff without request review never load general requests", async ({ page }) => {
  const { listed } = await mock(page, { permissions: ["team.view"] });
  await page.goto("/clients");
  await expect(page.getByRole("region", { name: "Client directory" })).toBeVisible();
  expect(listed).toHaveLength(0);
  await expect(page.getByRole("region", { name: "General requests" })).toHaveCount(0);
});
