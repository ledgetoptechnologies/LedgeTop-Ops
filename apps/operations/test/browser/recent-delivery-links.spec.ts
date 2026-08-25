import { expect, test, type Page } from "@playwright/test";

const root = "Jobs/Clients/";
const acme = `${root}Acme/`;
const edited = `${acme}Edited/`;

async function fixture(page: Page, options: { audit?: boolean; failFirst?: boolean; delayAcme?: Promise<void> } = {}) {
  const requests: string[] = [];
  let fail = options.failFirst === true;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: {
      user: { id: "scoped-links-review", email: "staff@example.test", displayName: "Delivery Staff", status: "Active", profileType: "Administrator", isAdministrator: true,
        permissions: ["delivery.browse", "delivery.delete", ...(options.audit === false ? [] : ["delivery.share.audit"])], divisions: [] },
      csrfToken: "local-fixture", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: { deliveryJobsRoot: { enabled: true } },
    } });
    if (url.pathname === "/api/delivery/folders") {
      const prefix = url.searchParams.get("prefix") || root;
      const folders = prefix === root ? [{ id: "acme", name: "Acme", prefix: acme }] : prefix === acme ? [{ id: "edited", name: "Edited", prefix: edited }] : [];
      return route.fulfill({ json: { prefix, folders, files: [], nextCursor: null, mediaHydrated: true } });
    }
    if (url.pathname === "/api/delivery/folders/locations") return route.fulfill({ json: { points: [], imageCount: 0, truncated: false } });
    if (url.pathname === "/api/delivery/trash") return route.fulfill({ json: { items: [] } });
    if (url.pathname === "/api/delivery/thumbnail-queue") return route.fulfill({ json: { pending: 0, processing: 0, total: 0 } });
    if (url.pathname === "/api/delivery/shares") {
      const prefix = url.searchParams.get("prefix") || "UNSCOPED";
      requests.push(prefix);
      expect(url.searchParams.get("limit")).toBe("8");
      if (fail) { fail = false; return route.fulfill({ status: 503, json: { error: "Link history temporarily unavailable" } }); }
      if (prefix === acme && options.delayAcme) await options.delayAcme;
      const name = prefix === edited ? "Edited photo link" : prefix === acme ? "Acme folder link" : "All clients recent link";
      return route.fulfill({ json: { shares: [{ id: `share-${name}`, display_name: name, target_path: `${prefix}example.jpg`, target_kind: "file", password_protected: 0, revoked_at: null, unavailable_since: null, expires_at: null }], nextCursor: null } }).catch(() => {});
    }
    return route.fulfill({ status: 404, json: { error: "No fixture endpoint" } });
  });
  return requests;
}

test("recent links follow folders, Back and refresh; Trash has breathing room", async ({ page }, testInfo) => {
  const requests = await fixture(page);
  await page.goto("/delivery");
  const searchLabel = await page.locator(".delivery-search > span").boundingBox();
  expect(searchLabel?.width).toBeLessThanOrEqual(1);
  await expect(page.getByText("All clients recent link", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open Acme", exact: true }).click();
  await expect(page.getByText("Acme folder link", { exact: true })).toBeVisible();
  await expect(page.getByText("All clients recent link", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Open Edited", exact: true }).click();
  await expect(page.getByText("Edited photo link", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "View folder links" })).toHaveAttribute("href", `/delivery/links?${new URLSearchParams({ prefix: edited })}`);
  await expect(page.getByText("Acme folder link", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Edited photo link", { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByText("Acme folder link", { exact: true })).toBeVisible();
  expect(requests).toContain(edited);
  expect(requests).not.toContain("UNSCOPED");
  const recent = page.locator(".recent-delivery-links");
  const trash = page.locator(".delivery-support-panels > section").filter({ has: page.getByRole("heading", { name: "Trash", exact: true }) });
  const a = await recent.boundingBox(), b = await trash.boundingBox();
  expect(a).not.toBeNull(); expect(b).not.toBeNull();
  expect(b!.y - (a!.y + a!.height)).toBeGreaterThanOrEqual(16);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("folder-links-layout.png"), fullPage: true });
});

test("late parent link responses cannot replace the current folder", async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const requests = await fixture(page, { delayAcme: delayed });
  try {
    await page.goto("/delivery/Acme");
    await expect.poll(() => requests.includes(acme)).toBe(true);
    await page.getByRole("button", { name: "Open Edited", exact: true }).click();
    await expect(page.getByText("Edited photo link", { exact: true })).toBeVisible();
    release();
    await expect(page.getByText("Acme folder link", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Edited photo link", { exact: true })).toBeVisible();
  } finally { release(); }
});

test("failed link history is actionable and retries in the same folder", async ({ page }) => {
  const requests = await fixture(page, { failFirst: true });
  await page.goto("/delivery/Acme/Edited");
  await expect(page.getByRole("alert")).toContainText("Link history temporarily unavailable");
  await expect(page.getByText("No links for this folder", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry client links" }).click();
  await expect(page.getByText("Edited photo link", { exact: true })).toBeVisible();
  expect(requests).toEqual([edited, edited]);
});

test("delivery browsing alone never fetches or reveals share history", async ({ page }) => {
  const requests = await fixture(page, { audit: false });
  await page.goto("/delivery/Acme");
  await expect(page.getByRole("button", { name: "Open Edited", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent client links" })).toHaveCount(0);
  expect(requests).toEqual([]);
});
