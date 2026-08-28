import { expect, test, type Page, type Route } from "@playwright/test";

const auditPath = "/api/admin/audit";
const cursor = "opaque-encrypted-cursor-that-must-not-enter-the-url";
function event(id: string, overrides: Record<string, unknown> = {}) {
  return { id, actor: { type: "staff", id: `staff-${id}`, email: `operator-${id}@example.test`, displayName: `Operator ${id}` },
    action: "delivery.share.created", category: "delivery", resource: { type: "share", id: `share-${id}` },
    divisionId: "division-one", result: "succeeded", occurredAt: `2026-08-2${id}T12:00:00.000Z`, ...overrides };
}
function response(url: URL, events: unknown[], nextCursor: string | null) {
  const day = (name: string, end = false) => {
    const value = url.searchParams.get(name); if (!value) return { value: "", exclusive: false };
    const date = new Date(`${value}T00:00:00.000Z`); if (end) date.setUTCDate(date.getUTCDate() + 1);
    return { value: date.toISOString(), exclusive: end };
  };
  const from = day("from"), to = day("to", true);
  return { events, nextCursor, highWaterId: "93", filters: {
    actor: url.searchParams.get("actor") ?? "", action: url.searchParams.get("action") ?? "",
    category: url.searchParams.get("category") ?? "", entity: url.searchParams.get("entity") ?? "",
    division: url.searchParams.get("division") ?? "", result: url.searchParams.get("result") ?? "all",
    from: from.value, to: to.value, toExclusive: to.exclusive, limit: Number(url.searchParams.get("limit") ?? 25),
  } };
}
async function fixture(page: Page, audit: (route: Route, url: URL, call: number) => Promise<void>, user = { administrator: true, permission: true }) {
  let calls = 0;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: "audit-user", email: "audit@example.test",
      displayName: "Audit User", status: "Active", profileType: user.administrator ? "Administrator" : "Employee",
      isAdministrator: user.administrator, permissions: ["administration.view", ...(user.permission ? ["audit.view"] : [])], divisions: [] },
      csrfToken: "csrf", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    if (url.pathname === auditPath) { calls += 1; return audit(route, url, calls); }
    return route.fulfill({ status: 404, json: { error: "Unsupported fixture endpoint" } });
  });
  return () => calls;
}

test("filters are refresh-safe and opaque cursor pages accumulate without duplicates", async ({ page }) => {
  const urls: URL[] = [];
  await fixture(page, async (route, url) => {
    urls.push(url);
    await route.fulfill({ json: response(url, url.searchParams.has("cursor") ? [event("3"), event("2")] : [event("1"), event("2")],
      url.searchParams.has("cursor") ? null : cursor) });
  });
  await page.goto("/administration");
  const region = page.getByRole("region", { name: "Global audit history" });
  await expect(region.locator(".admin-audit-events > li")).toHaveCount(2);
  await region.getByLabel("Actor").fill(" Alice ");
  await region.getByLabel("Action").fill("delivery.share.created");
  await region.getByLabel("Category").fill("Delivery");
  await region.getByLabel("Resource").fill("share-1");
  await region.getByLabel("Division").fill("division-one");
  await region.getByLabel("Result").selectOption("succeeded");
  await region.getByLabel("From", { exact: true }).fill("2026-08-01"); await region.getByLabel("To", { exact: true }).fill("2026-08-28");
  await region.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/adminAudit\.actor=alice/); await expect(page).toHaveURL(/adminAudit\.category=delivery/);
  const applied = urls.at(-1)!;
  expect(Object.fromEntries(["actor", "action", "category", "entity", "division", "result", "from", "to"].map(key => [key, applied.searchParams.get(key)])))
    .toEqual({ actor: "alice", action: "delivery.share.created", category: "delivery", entity: "share-1", division: "division-one",
      result: "succeeded", from: "2026-08-01", to: "2026-08-28" });
  await region.getByLabel("Actor").fill("Not applied");
  await region.getByRole("button", { name: "Load more audit events" }).click();
  await expect(region.locator(".admin-audit-events > li")).toHaveCount(3);
  expect(urls.at(-1)!.searchParams.get("cursor")).toBe(cursor);
  expect(urls.at(-1)!.searchParams.get("actor")).toBe("alice");
  expect(page.url()).not.toContain("cursor"); expect(await page.content()).not.toContain(cursor);
  await expect(region.getByText("All matching audit events loaded.")).toBeVisible();
  await page.reload(); await expect(region.getByLabel("Actor")).toHaveValue("alice");
  await expect(region.getByLabel("Category")).toHaveValue("delivery");
});

test("loading, empty, malformed response, and retry states never render unverified events", async ({ page }) => {
  let held: Route | null = null;
  await fixture(page, async (route, url, call) => {
    if (call === 1) { held = route; return; }
    if (call === 2) return route.fulfill({ json: { ...response(url, [event("7")], null), events: [{ ...event("7"), actor: { type: "staff", id: null } }] } });
    await route.fulfill({ json: response(url, [], null) });
  });
  await page.goto("/administration"); const region = page.getByRole("region", { name: "Global audit history" });
  await expect(region.getByRole("status", { name: "Loading" })).toBeVisible();
  await expect.poll(() => Boolean(held)).toBe(true); await held!.fulfill({ json: response(new URL(held!.request().url()), [event("1")], null) });
  await expect(region.locator(".admin-audit-events > li")).toHaveCount(1);
  await region.getByRole("button", { name: "Refresh" }).click();
  await expect(region.getByRole("alert")).toContainText("could not be verified");
  await expect(region.locator(".admin-audit-events > li")).toHaveCount(0);
  await region.getByRole("button", { name: "Retry audit history" }).click();
  await expect(region.getByText("No matching audit events", { exact: true })).toBeVisible();
  await expect(region.getByRole("alert")).toHaveCount(0);
});

test("audit history does not probe the endpoint without both administrator membership and audit permission", async ({ page }) => {
  const nonAdminCalls = await fixture(page, async route => { await route.fulfill({ status: 500 }); }, { administrator: false, permission: true });
  await page.goto("/administration"); await expect(page.getByRole("region", { name: "Global audit history" })).toHaveCount(0);
  expect(nonAdminCalls()).toBe(0);
  await page.unrouteAll({ behavior: "wait" });
  const noPermissionCalls = await fixture(page, async route => { await route.fulfill({ status: 500 }); }, { administrator: true, permission: false });
  await page.reload(); await expect(page.getByRole("region", { name: "Global audit history" })).toHaveCount(0);
  expect(noPermissionCalls()).toBe(0);
});

test("invalid popstate cancels an in-flight page and Reset recovers without stale rows", async ({ page }) => {
  let release: (() => void) | null = null;
  const calls = await fixture(page, async (route, url, call) => {
    if (call === 1) {
      await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ json: response(url, [event("9", { action: "stale.event" })], null) }).catch(() => undefined);
      return;
    }
    await route.fulfill({ json: response(url, [event("4", { action: "recovered.event" })], null) });
  });
  await page.goto("/administration");
  const region = page.getByRole("region", { name: "Global audit history" });
  await expect.poll(() => calls()).toBe(1);
  await page.evaluate(() => { history.pushState(null, "", "/administration?adminAudit.result=bogus"); dispatchEvent(new PopStateEvent("popstate")); });
  await expect(region.getByRole("alert")).toContainText("filters in this URL are invalid");
  await expect(region.getByRole("button", { name: "Reset" })).toBeEnabled();
  await expect(region.locator(".admin-audit-events > li")).toHaveCount(0);
  (release as (() => void) | null)?.();
  await region.getByRole("button", { name: "Reset" }).click();
  await expect(region.getByText("recovered.event", { exact: true })).toBeVisible();
  await expect(region.getByText("stale.event", { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/administration$/);
});

test("audit controls remain accessible without horizontal overflow on mobile and ultrawide screens", async ({ page }) => {
  await fixture(page, async (route, url) => { await route.fulfill({ json: response(url, [event("1")], null) }); });
  await page.goto("/administration"); const region = page.getByRole("region", { name: "Global audit history" });
  for (const width of [390, 1920]) {
    await page.setViewportSize({ width, height: 1000 }); await expect(region).toBeVisible();
    const actor = await region.getByLabel("Actor").boundingBox(), apply = await region.getByRole("button", { name: "Apply filters" }).boundingBox();
    expect(actor).not.toBeNull(); expect(apply).not.toBeNull(); expect(actor!.x).toBeGreaterThanOrEqual(0);
    expect(actor!.x + actor!.width).toBeLessThanOrEqual(width); expect(apply!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});
