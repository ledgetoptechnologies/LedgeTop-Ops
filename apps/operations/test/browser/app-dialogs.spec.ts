import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const fixture = new URL("./app-dialogs-fixture.tsx", import.meta.url);
const bundle = buildSync({ entryPoints: [fileURLToPath(fixture)], bundle: true, format: "iife", platform: "browser", write: false,
  outdir: "out", jsx: "automatic", loader: { ".css": "empty" },
  nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
const script = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text;
if (!script) throw new Error("App dialog browser fixture did not compile.");

async function render(page: Page, { host = true }: { host?: boolean } = {}) {
  const nativeDialogs: string[] = [];
  page.on("dialog", dialog => { nativeDialogs.push(dialog.type()); void dialog.dismiss(); });
  await page.route("https://fixture.test/**", route => route.fulfill({ contentType: "text/html",
    body: '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>' }));
  await page.goto(`https://fixture.test/app-dialogs?host=${host ? "1" : "0"}`);
  await page.addInitScript(() => { window.prompt = () => { throw new Error("prompt() is not supported."); }; });
  await page.evaluate(() => { window.prompt = () => { throw new Error("prompt() is not supported."); }; });
  await page.addScriptTag({ content: script });
  await expect(page.locator("#opener")).toBeVisible();
  return nativeDialogs;
}
const run = (page: Page, name: string) => page.evaluate(key =>
  (window as Window & { appDialogs?: Record<string, () => void> }).appDialogs![key]!(), name);
const values = (page: Page) => page.evaluate(() =>
  (window as Window & { appDialogResults?: { values: Array<string | null> } }).appDialogResults!.values);

test("a typed confirmation must match exactly: padded or wrong text keeps the dialog open, cancel fails closed", async ({ page }) => {
  const nativeDialogs = await render(page);
  await page.locator("#opener").focus();
  await run(page, "typedPurge");
  const dialog = page.getByRole("dialog", { name: "Permanently purge" });
  const field = dialog.getByRole("textbox", { name: "Type dataset ID ds-42 to continue" });

  await field.fill(" ds-42 ");
  await dialog.getByRole("button", { name: "Permanently purge" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("The ID does not match. Nothing will be purged until it does.");
  await field.fill("ds-41");
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(await values(page)).toEqual([]);

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => values(page)).toEqual([null]);
  await expect(page.locator("#opener")).toBeFocused();

  await run(page, "typedPurge");
  await field.fill("ds-42");
  await dialog.getByRole("button", { name: "Permanently purge" }).click();
  await expect.poll(() => values(page)).toEqual([null, "ds-42"]);
  expect(nativeDialogs).toEqual([]);
});

test("queued requests show one at a time and never reuse an earlier dialog's text", async ({ page }) => {
  await render(page);
  await run(page, "twoInARow");
  const first = page.getByRole("dialog", { name: "First name" });
  await expect(first.getByRole("textbox", { name: "First" })).toHaveValue("one");
  await expect(page.getByRole("dialog", { name: "Second name" })).toHaveCount(0);
  await first.getByRole("textbox", { name: "First" }).fill("typed in first");
  await page.keyboard.press("Enter");

  const second = page.getByRole("dialog", { name: "Second name" });
  await expect(second.getByRole("textbox", { name: "Second" })).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect.poll(() => values(page)).toEqual(["typed in first", null]);
});

test("a choice dialog resolves only to an explicit choice; Escape and Cancel resolve null", async ({ page }) => {
  await render(page);
  await run(page, "conflict");
  const dialog = page.getByRole("dialog", { name: "An item with this name already exists" });
  await expect(dialog.getByRole("button", { name: "Keep both" })).toBeFocused();
  await page.keyboard.press("Escape");
  await run(page, "conflict");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await run(page, "conflict");
  await dialog.getByRole("button", { name: "Replace" }).click();
  await expect.poll(() => values(page)).toEqual([null, null, "replace"]);
});

test("without a mounted host, an unsupported native prompt resolves as cancelled, never accepted", async ({ page }) => {
  await render(page, { host: false });
  await run(page, "typedPurge");
  await run(page, "conflict");
  await expect.poll(() => values(page)).toEqual([null, null]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
