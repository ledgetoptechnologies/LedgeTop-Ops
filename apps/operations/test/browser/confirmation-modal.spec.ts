import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const helper = fileURLToPath(new URL("../../src/client/confirm-action.ts", import.meta.url));
const result = buildSync({ stdin: { contents: `import { confirmAction } from ${JSON.stringify(helper)};
  const button = document.getElementById('trigger');
  let busy = false;
  button.addEventListener('click', async () => {
    if (busy) return;
    const frozen = { operationId: 'original-id', body: document.getElementById('input').value };
    if (!await confirmAction('Apply the exact reviewed operation?')) return;
    busy = true;
    window.writes.push(frozen);
  });
  window.writes = [];
  window.askAgain = () => confirmAction('A duplicate request must not queue');`,
  resolveDir: fileURLToPath(new URL("../../src/client", import.meta.url)), loader: "ts" },
  bundle: true, write: false, outdir: "out", format: "iife", platform: "browser" });
const script = result.outputFiles.find(file => file.path.endsWith(".js"))!.text;
const css = result.outputFiles.find(file => file.path.endsWith(".css"))!.text;
async function render(page: Page) {
  await page.route("**/confirmation-fixture", route => route.fulfill({ contentType: "text/html",
    body: '<meta name="viewport" content="width=device-width, initial-scale=1"><button id="trigger">Review operation</button><input id="input" value="original body"><button>Background action</button>' }));
  await page.goto("/confirmation-fixture");
  await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
}

test("in-page dialog traps keyboard focus, Escape cancels without writing and restores focus", async ({ page }) => {
  await render(page);
  page.on("dialog", () => { throw new Error("Native browser dialog is forbidden"); });
  const trigger = page.getByRole("button", { name: "Review operation" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Confirm action" });
  await expect(dialog).toBeVisible();
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  const confirm = dialog.getByRole("button", { name: "Confirm", exact: true });
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Shift+Tab"); await expect(confirm).toBeFocused();
  await page.keyboard.press("Tab"); await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab"); await expect(confirm).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => (window as any).writes)).toEqual([]);
  await trigger.click(); await cancel.click();
  expect(await page.evaluate(() => (window as any).writes)).toEqual([]);
});

test("confirm dispatches once with frozen input and never queues competing confirmations", async ({ page }) => {
  await render(page);
  await page.getByRole("button", { name: "Review operation" }).click();
  expect(await page.evaluate(() => (window as any).askAgain())).toBe(false);
  // Background is inert to users; even programmatic field changes cannot alter the frozen request.
  await page.evaluate(() => { (document.getElementById("input") as HTMLInputElement).value = "changed"; });
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).dblclick();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).writes)).toEqual([{ operationId: "original-id", body: "original body" }]);
});

test("mobile layout stays within viewport and cancel stays reachable", async ({ page }) => {
  await render(page);
  await page.getByRole("button", { name: "Review operation" }).click();
  const box = await page.getByRole("dialog").boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await page.evaluate(() => (window as any).writes)).toEqual([]);
});

test("unmount of initiating view cancels stale confirmation", async ({ page }) => {
  await render(page);
  await page.getByRole("button", { name: "Review operation" }).click();
  await page.evaluate(() => document.getElementById("trigger")!.remove());
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).writes)).toEqual([]);
});
