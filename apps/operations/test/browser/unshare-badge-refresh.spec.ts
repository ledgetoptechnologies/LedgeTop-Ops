import { expect, test, type Page } from "@playwright/test";

const root = "Jobs/Clients/";

async function fixture(page: Page, options: { deleteFails?: boolean } = {}) {
  let revoked = false;
  const calls: Array<{ method: string; path: string }> = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    calls.push({ method: request.method(), path: url.pathname });
    if (url.pathname === "/api/session") return route.fulfill({ json: {
      user: { id: "unshare-staff", email: "staff@example.test", displayName: "Delivery Staff", status: "Active", profileType: "Administrator",
        isAdministrator: true, permissions: ["delivery.browse", "delivery.share.audit", "delivery.share.revoke"], divisions: [] },
      csrfToken: "local-fixture", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: { deliveryJobsRoot: { enabled: true } },
    } });
    if (url.pathname === "/api/delivery/folders") return route.fulfill({ json: {
      prefix: url.searchParams.get("prefix") || root,
      folders: [{ id: "acme", name: "Acme", displayName: "Acme", prefix: `${root}Acme/`, isShared: !revoked }],
      files: [], nextCursor: null, mediaHydrated: true,
    } });
    if (url.pathname === "/api/delivery/folders/locations") return route.fulfill({ json: { points: [], imageCount: 0, truncated: false } });
    if (url.pathname === "/api/delivery/trash") return route.fulfill({ json: { items: [] } });
    if (url.pathname === "/api/delivery/thumbnail-queue") return route.fulfill({ json: { pending: 0, processing: 0, total: 0 } });
    if (url.pathname === "/api/delivery/shares") return route.fulfill({ json: { shares: [{
      id: "share-acme", display_name: "Acme", target_path: `${root}Acme/`, target_kind: "folder", password_protected: 0,
      revoked_at: revoked ? "2026-10-16T20:00:00.000Z" : null, unavailable_since: null, expires_at: null,
    }], nextCursor: null } });
    if (request.method() === "DELETE" && url.pathname === "/api/delivery/shares/share-acme") {
      if (options.deleteFails) return route.fulfill({ status: 503, json: { error: "The link could not be revoked right now." } });
      revoked = true;
      return route.fulfill({ json: { revoked: true } });
    }
    return route.fulfill({ status: 404, json: { error: "No fixture endpoint" } });
  });
  return calls;
}

const acmeCard = (page: Page) => page.getByRole("button", { name: /^Open Acme/ });
const folderLoads = (calls: Array<{ method: string; path: string }>) => calls.filter(call => call.path === "/api/delivery/folders").length;

test("unsharing from Recent client links clears the file card's shared badge without a manual refresh", async ({ page }) => {
  const calls = await fixture(page);
  await page.goto("/delivery");
  const links = page.locator(".recent-delivery-links");
  await expect(links.getByRole("button", { name: "Unshare" })).toBeVisible();
  await expect(acmeCard(page).getByLabel("Currently shared")).toBeVisible();
  const loadsBefore = folderLoads(calls);

  page.once("dialog", dialog => dialog.accept());
  await links.getByRole("button", { name: "Unshare" }).click();
  await expect(links.getByRole("button", { name: "Unshare" })).toHaveCount(0);
  await expect(acmeCard(page).getByLabel("Currently shared")).toHaveCount(0);
  expect(folderLoads(calls)).toBeGreaterThan(loadsBefore);
});

test("cancelling the unshare confirmation sends nothing and keeps the badge", async ({ page }) => {
  const calls = await fixture(page);
  await page.goto("/delivery");
  const links = page.locator(".recent-delivery-links");
  await expect(acmeCard(page).getByLabel("Currently shared")).toBeVisible();
  const loadsBefore = folderLoads(calls);

  page.once("dialog", dialog => dialog.dismiss());
  await links.getByRole("button", { name: "Unshare" }).click();
  await page.waitForTimeout(150);
  expect(calls.some(call => call.method === "DELETE")).toBe(false);
  expect(folderLoads(calls)).toBe(loadsBefore);
  await expect(acmeCard(page).getByLabel("Currently shared")).toBeVisible();
});

test("a failed unshare reports the error and does not claim the item is unshared", async ({ page }) => {
  const calls = await fixture(page, { deleteFails: true });
  await page.goto("/delivery");
  const links = page.locator(".recent-delivery-links");
  await expect(acmeCard(page).getByLabel("Currently shared")).toBeVisible();
  const loadsBefore = folderLoads(calls);

  page.once("dialog", dialog => dialog.accept());
  await links.getByRole("button", { name: "Unshare" }).click();
  await expect(links.getByRole("alert")).toContainText("could not be revoked");
  expect(folderLoads(calls)).toBe(loadsBefore);
  await expect(acmeCard(page).getByLabel("Currently shared")).toBeVisible();
  await expect(links.getByRole("button", { name: "Unshare" })).toBeVisible();
});
