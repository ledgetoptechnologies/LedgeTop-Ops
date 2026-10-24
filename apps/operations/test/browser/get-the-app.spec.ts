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
  available: true, platform: "windows", channel: "pilot", version: "1.0.3", size: 83_809_359,
  sha256: "b7c01c87461471def1a432b2554c2b734aeb9042a4a5e47e5fd00ab4b7b7e472",
  downloadUrl: "/api/app/download/1.0.3?platform=windows&channel=pilot", minSupported: "Windows 10 and 11, 64-bit",
};
type Answer = { status: number; body?: unknown };

async function render(page: Page, respond: (platform: string, attempt: number) => Answer) {
  const attempts = new Map<string, number>(), asked: string[] = [];
  await page.route("https://fixture.test/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/app/latest") {
      const platform = url.searchParams.get("platform")!, attempt = (attempts.get(platform) ?? 0) + 1;
      attempts.set(platform, attempt); asked.push(url.pathname + url.search);
      const { status, body } = respond(platform, attempt);
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
  return { dialog: page.getByRole("dialog", { name: "Get the Ledge Top app" }), asked };
}

test("the account menu offers the signed-in download for this computer", async ({ page }, info) => {
  const { dialog, asked } = await render(page, platform => ({ status: 200, body: platform === "windows" ? windows
    // A release pointing off-site is never offered; that platform reads as coming later.
    : platform === "macos" ? { ...windows, platform: "macos", downloadUrl: "https://example.com/evil.dmg" } : { available: false } }));
  const download = dialog.getByRole("link", { name: "Download for Windows" });
  await expect(download).toHaveAttribute("href", "/api/app/download/1.0.3?platform=windows&channel=pilot");
  await expect(dialog).toContainText("Version 1.0.3 · 80 MB");
  await expect(dialog).toContainText("Early access");
  await expect(dialog).toContainText("Windows 10 and 11, 64-bit");
  await expect(dialog.getByRole("link", { name: "Download for Mac" })).toHaveCount(0);
  await expect(dialog.getByText("Coming later")).toHaveCount(2);
  expect(asked.sort()).toEqual(["/api/app/latest?platform=linux", "/api/app/latest?platform=macos", "/api/app/latest?platform=windows"]);
  await page.screenshot({ path: info.outputPath("get-the-app.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Account menu for Beau Koltz" })).toBeFocused();
});

test("before any release is published, people are told it is coming", async ({ page }) => {
  const { dialog } = await render(page, platform => platform === "windows" ? { status: 200, body: { available: false } } : { status: 404 });
  await expect(dialog).toContainText("The app isn't ready to download yet.");
  await expect(dialog.getByRole("link")).toHaveCount(0);
});

test("a failed check can be retried", async ({ page }) => {
  const { dialog } = await render(page, (platform, attempt) => platform !== "windows" ? { status: 200, body: { available: false } }
    : attempt === 1 ? { status: 503 } : { status: 200, body: windows });
  await expect(dialog.getByRole("alert")).toContainText("We couldn't check for the app just now.");
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(dialog.getByRole("link", { name: "Download for Windows" })).toBeVisible();
});
