import { expect, test, type Page } from "@playwright/test";

const syntheticUrl = "https://portal.example.test/s/synthetic-share-only";
const share = { id: "share-synthetic", shareUrl: syntheticUrl, passwordProtected: false,
  expiresAt: null, recoverable: true, recipientEmail: null, imageLocationMapEnabled: false };

async function fixture(page: Page, existing = false, lifecycle = "updated") {
  let active: typeof share | null = existing ? { ...share } : null;
  const writes: Array<Record<string, unknown>> = [];
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-share", email: "staff@example.test", displayName: "Share Staff", status: "Active",
        profileType: "Administrator", isAdministrator: true, permissions: ["delivery.browse", "delivery.share.create"], divisions: [] },
      csrfToken: "csrf-synthetic", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null,
      capabilities: { deliveryJobsRoot: { enabled: true } },
    } });
    if (url.pathname === "/api/delivery/folders") return route.fulfill({ json: {
      prefix: url.searchParams.get("prefix") || "Jobs/Clients/", folders: [{ id: "folder-synthetic", prefix: "Jobs/Clients/Synthetic/",
        physicalKey: "Jobs/Clients/Synthetic/", name: "Synthetic", displayName: "Synthetic", kind: "folder", isShared: Boolean(active) }], files: [], nextCursor: null,
    } });
    if (url.pathname === "/api/delivery/folders/locations") return route.fulfill({ json: { points: [], imageCount: 0, truncated: false } });
    if (url.pathname === "/api/delivery/shares/active") return route.fulfill({ json: { share: active } });
    if (url.pathname === "/api/delivery/shares") {
      if (route.request().method() === "POST") {
        const created = active === null;
        writes.push(route.request().postDataJSON());
        active = { ...share };
        return route.fulfill({ status: created ? 201 : 200, json: { share: { ...active, lifecycle: created ? "created" : lifecycle } } });
      }
      return route.fulfill({ json: { shares: [] } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return writes;
}

async function openShare(page: Page) {
  await page.getByRole("button", { name: "Actions for Synthetic" }).click();
  await page.getByRole("menuitem", { name: "Share", exact: true }).click();
  return page.getByRole("dialog", { name: "Share folder" });
}

test("new folder link has one result, edits preserve the saved link, and reopening shows existing sharing", async ({ page }) => {
  const writes = await fixture(page);
  await page.goto("/delivery");
  let dialog = await openShare(page);
  await dialog.getByRole("button", { name: "Create link", exact: true }).click();
  await expect(dialog.getByText("Link created", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Already shared", { exact: true })).toHaveCount(0);
  await expect(dialog.locator(`a[href="${syntheticUrl}"]`)).toHaveCount(1);
  await dialog.getByRole("checkbox", { name: /Show photo locations on this client share/ }).check();
  await expect(dialog.getByText("Link created", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Already shared", { exact: true })).toBeVisible();
  await expect(dialog.locator(`a[href="${syntheticUrl}"]`)).toHaveCount(1);
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(dialog.getByText("Link updated", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Already shared", { exact: true })).toHaveCount(0);
  await expect(dialog.locator(`a[href="${syntheticUrl}"]`)).toHaveCount(1);
  expect(writes).toHaveLength(2);
  expect(writes[0]).toMatchObject({ r2Prefix: "Jobs/Clients/Synthetic/", imageLocationMapEnabled: false });
  expect(writes[1]).toMatchObject({ r2Prefix: "Jobs/Clients/Synthetic/", imageLocationMapEnabled: true });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  dialog = await openShare(page);
  await expect(dialog.getByText("Already shared", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Link created", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Link updated", { exact: true })).toHaveCount(0);
  await expect(dialog.locator(`a[href="${syntheticUrl}"]`)).toHaveCount(1);
});

for (const [lifecycle, label] of [["reused", "Existing link ready"], ["rotated", "New link created; old link disabled"]]) {
  test(`existing folder ${lifecycle} result replaces the existing-share summary`, async ({ page }) => {
    await fixture(page, true, lifecycle);
    await page.goto("/delivery");
    const dialog = await openShare(page);
    await expect(dialog.getByText("Already shared", { exact: true })).toBeVisible();
    await expect(dialog.locator(`a[href="${syntheticUrl}"]`)).toHaveCount(1);
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(dialog.getByText(label!, { exact: true })).toBeVisible();
    await expect(dialog.getByText("Already shared", { exact: true })).toHaveCount(0);
    await expect(dialog.locator(`a[href="${syntheticUrl}"]`)).toHaveCount(1);
  });
}
