import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const fixture = new URL("./get-the-app-fixture.tsx", import.meta.url);
const bundle = buildSync({ entryPoints: [fileURLToPath(fixture)], bundle: true, format: "iife", platform: "browser", write: false,
  outdir: "out", jsx: "automatic", loader: { ".css": "empty" },
  nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
const script = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text;
if (!script) throw new Error("Get the app browser fixture did not compile.");
const styles = [new URL("../../../../packages/ui/src/styles.css", import.meta.url), new URL("../../src/client/styles.css", import.meta.url)]
  .map(url => readFileSync(url, "utf8")).join("\n");

const windows = {
  platform: "windows", version: "1.0.3", publishedAt: "2026-10-23T12:00:00Z", sizeBytes: 83_809_359,
  sha256: "b7c01c87461471def1a432b2554c2b734aeb9042a4a5e47e5fd00ab4b7b7e472",
  downloadPath: "/api/app/download/windows/stable/1.0.3", requirements: "Windows 10 and 11, 64-bit",
};

async function render(page: Page, respond: (count: number) => { status: number; body?: unknown }) {
  let count = 0;
  await page.route("https://fixture.test/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/app/releases") {
      const { status, body } = respond(++count);
      return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body ?? {}) });
    }
    return route.fulfill({ contentType: "text/html",
      body: '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>' });
  });
  await page.goto("https://fixture.test/");
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page.getByRole("button", { name: "Account menu for Beau Koltz" }).click();
  await page.getByRole("menuitem", { name: "Get the app" }).click();
  return page.getByRole("dialog", { name: "Get the Ledge Top app" });
}

test("the account menu offers the signed-in download for this computer", async ({ page }, info) => {
  const dialog = await render(page, () => ({ status: 200, body: { releases: [windows,
    { ...windows, platform: "macos", downloadPath: "https://example.com/evil.dmg" }] } }));
  const download = dialog.getByRole("link", { name: "Download for Windows" });
  await expect(download).toHaveAttribute("href", "/api/app/download/windows/stable/1.0.3");
  await expect(dialog).toContainText("Version 1.0.3 · 80 MB");
  await expect(dialog).toContainText("Windows 10 and 11, 64-bit");
  // A release pointing off-site is never offered; that platform reads as coming later.
  await expect(dialog.getByRole("link", { name: "Download for Mac" })).toHaveCount(0);
  await expect(dialog.getByText("Coming later")).toHaveCount(2);
  await page.screenshot({ path: info.outputPath("get-the-app.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Account menu for Beau Koltz" })).toBeFocused();
});

test("before any release is published, people are told it is coming", async ({ page }) => {
  const dialog = await render(page, () => ({ status: 404 }));
  await expect(dialog).toContainText("The app isn't ready to download yet.");
  await expect(dialog.getByRole("link")).toHaveCount(0);
});

test("a failed check can be retried", async ({ page }) => {
  const dialog = await render(page, count => count === 1 ? { status: 503 } : { status: 200, body: { releases: [windows] } });
  await expect(dialog.getByRole("alert")).toContainText("We couldn't check for the app just now.");
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(dialog.getByRole("link", { name: "Download for Windows" })).toBeVisible();
});
