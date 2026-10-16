import { expect, test, type Page } from "@playwright/test";

type Call = { method: string; path: string; body: Record<string, unknown> | null };

// Embedded and in-app browsers throw from window.prompt. Model that, and fail
// the test if any native dialog (prompt, confirm or alert) is ever opened.
async function inAppBrowser(page: Page) {
  const nativeDialogs: string[] = [];
  page.on("dialog", dialog => { nativeDialogs.push(`${dialog.type()}: ${dialog.message()}`); void dialog.dismiss(); });
  await page.addInitScript(() => {
    window.prompt = () => { throw new Error("prompt() is not supported."); };
  });
  return nativeDialogs;
}

async function mockDelivery(page: Page, options: { renameConflictOnce?: boolean } = {}) {
  const calls: Call[] = [];
  let renameAttempts = 0;
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : null;
    calls.push({ method: request.method(), path: url.pathname, body });
    if (url.pathname === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-dialogs", email: "staff-dialogs@example.test", displayName: "Dialog Staff", status: "Active",
        profileType: "Administrator", isAdministrator: true,
        permissions: ["delivery.browse", "delivery.files.create", "delivery.files.move", "delivery.files.copy"], divisions: [] },
      csrfToken: "csrf-dialogs", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null,
      capabilities: { deliveryJobsRoot: { enabled: true } },
    } });
    if (request.method() === "POST" && url.pathname === "/api/delivery/fs/folders")
      return route.fulfill({ json: { status: "completed", progress: 1, message: "Folder created" } });
    if (request.method() === "POST" && url.pathname === "/api/delivery/fs/rename") {
      renameAttempts += 1;
      if (options.renameConflictOnce && renameAttempts === 1)
        return route.fulfill({ status: 409, json: { error: "An item already exists at the destination" } });
      return route.fulfill({ json: { status: "completed", progress: 1, message: "Renamed", jobId: "job-rename" } });
    }
    if (url.pathname === "/api/delivery/folders") return route.fulfill({ json: {
      prefix: url.searchParams.get("prefix") || "Jobs/Clients/",
      folders: [{ id: "folder-acme", prefix: "Jobs/Clients/Acme/", name: "Acme", displayName: "Acme", isShared: false }],
      files: [], nextCursor: null,
    } });
    if (url.pathname === "/api/delivery/folders/locations") return route.fulfill({ json: { points: [], imageCount: 0, truncated: false } });
    if (url.pathname === "/api/delivery/shares") return route.fulfill({ json: { shares: [] } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return calls;
}

test("New folder opens an in-app dialog instead of the unsupported native prompt", async ({ page }) => {
  const nativeDialogs = await inAppBrowser(page);
  const calls = await mockDelivery(page);
  await page.goto("/delivery");
  await expect(page.locator(".file-card-title", { hasText: "Acme" })).toBeVisible();

  const newFolder = page.getByRole("button", { name: "New folder" });
  await newFolder.click();
  const dialog = page.getByRole("dialog", { name: "New folder" });
  await expect(dialog).toBeVisible();
  const name = dialog.getByRole("textbox", { name: "Folder name" });
  await expect(name).toBeFocused();

  // Escape cancels without creating anything and returns focus to the opener.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(newFolder).toBeFocused();
  expect(calls.some(call => call.path === "/api/delivery/fs/folders")).toBe(false);

  // An empty name is explained in place rather than silently ignored.
  await newFolder.click();
  await dialog.getByRole("button", { name: "Create folder" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Enter folder name.");
  await expect(name).toHaveAttribute("aria-invalid", "true");

  await name.fill("  Survey 2026  ");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => calls.filter(call => call.path === "/api/delivery/fs/folders")).toHaveLength(1);
  const create = calls.find(call => call.path === "/api/delivery/fs/folders")!;
  expect(String(create.body?.key)).toMatch(/Survey 2026\/$/);
  expect(nativeDialogs).toEqual([]);
});

test("rename uses an in-app dialog and resolves a name conflict with explicit choices", async ({ page }) => {
  const nativeDialogs = await inAppBrowser(page);
  const calls = await mockDelivery(page, { renameConflictOnce: true });
  await page.goto("/delivery");
  await page.getByRole("button", { name: "Actions for Acme" }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();

  const rename = page.getByRole("dialog", { name: "Rename Acme" });
  const field = rename.getByRole("textbox", { name: "New name" });
  await expect(field).toHaveValue("Acme");
  await field.fill("Acme Survey");
  await rename.getByRole("button", { name: "Rename" }).click();

  const conflict = page.getByRole("dialog", { name: "An item with this name already exists" });
  await expect(conflict).toBeVisible();
  await expect(conflict.getByRole("button", { name: "Keep both" })).toBeFocused();
  await expect(conflict.getByRole("button", { name: "Replace" })).toBeVisible();
  await conflict.getByRole("button", { name: "Keep both" }).click();

  await expect.poll(() => calls.filter(call => call.path === "/api/delivery/fs/rename")).toHaveLength(2);
  const [first, second] = calls.filter(call => call.path === "/api/delivery/fs/rename");
  expect(first!.body).toMatchObject({ conflict: "fail" });
  expect(second!.body).toMatchObject({ conflict: "rename", sourceKey: first!.body!.sourceKey, targetKey: first!.body!.targetKey });
  expect(String(second!.body!.targetKey)).toMatch(/Acme Survey\/?$/);
  expect(nativeDialogs).toEqual([]);
});

test("cancelling a name conflict sends no second request", async ({ page }) => {
  await inAppBrowser(page);
  const calls = await mockDelivery(page, { renameConflictOnce: true });
  await page.goto("/delivery");
  await page.getByRole("button", { name: "Actions for Acme" }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.getByRole("dialog", { name: "Rename Acme" }).getByRole("textbox", { name: "New name" }).fill("Acme Survey");
  await page.keyboard.press("Enter");
  const conflict = page.getByRole("dialog", { name: "An item with this name already exists" });
  await conflict.getByRole("button", { name: "Cancel" }).click();
  await expect(conflict).toHaveCount(0);
  await page.waitForTimeout(150);
  expect(calls.filter(call => call.path === "/api/delivery/fs/rename")).toHaveLength(1);
});
