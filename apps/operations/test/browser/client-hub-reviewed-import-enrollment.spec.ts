import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const bundle = buildSync({ entryPoints: [fileURLToPath(new URL("./client-hub-reviewed-import-enrollment-fixture.tsx", import.meta.url))],
  bundle: true, format: "iife", platform: "browser", write: false, outdir: "out", jsx: "automatic",
  loader: { ".svg": "dataurl" }, nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
const script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
const style = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
const calls = (page: Page) => page.evaluate(() => (window as any).enrollmentHubCalls as Array<any>);
async function render(page: Page, enabled = true) {
  await page.route("**/clients/sources/**", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.goto("/clients/sources/project-alpha%3Aprimary/business/organizations/remote-parent");
  await page.evaluate(value => { (window as any).enrollmentFlag = value; }, enabled);
  await page.addStyleTag({ content: style }); await page.addScriptTag({ content: script });
  await expect(page.getByRole("heading", { name: "Imported organization" })).toBeVisible();
}
async function reviewChild(page: Page, recordId = "local-child-one") {
  await page.getByRole("combobox", { name: "Linked client", exact: true }).selectOption(recordId);
  await page.getByRole("button", { name: "Review sync enrollment" }).last().click();
  await expect(page.getByRole("region", { name: "Reviewed import enrollment sources" })).toBeVisible();
}

test("disabled enrollment capability hides parent and linked-client enrollment cards", async ({ page }) => {
  await render(page, false);
  await expect(page.getByRole("heading", { name: "Reviewed import enrollment" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Enroll linked clients" })).toHaveCount(0);
  expect(await calls(page)).toEqual([]);
});

test("parent review uses the canonical local organization ID and never the Project Alpha public ID", async ({ page }) => {
  await render(page); await page.getByRole("button", { name: "Review sync enrollment" }).click();
  await expect(page.getByRole("region", { name: "Reviewed import enrollment sources" })).toBeVisible();
  expect(await calls(page)).toEqual([{ path: "/api/native-directory/reviewed-import-enrollment/organizations/local-parent/review", method: "GET" }]);
  expect((await calls(page)).filter(call => call.method === "POST")).toEqual([]);
});

test("validated linked-child selection reviews the child's canonical local ID", async ({ page }) => {
  await render(page); await reviewChild(page);
  expect(await calls(page)).toEqual([{ path: "/api/native-directory/reviewed-import-enrollment/clients/local-child-one/review", method: "GET" }]);
});

test("tampered linked-child selection cannot expose a child enrollment control", async ({ page }) => {
  await render(page);
  const selector = page.getByRole("combobox", { name: "Linked client", exact: true });
  await selector.evaluate(select => { select.appendChild(new Option("Unvalidated child", "not-linked")); });
  await selector.selectOption("not-linked");
  await expect(page.getByRole("button", { name: "Review sync enrollment" })).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Reviewed import enrollment sources" })).toHaveCount(0);
  expect(await calls(page)).toEqual([]);
});

for (const transition of ["selection", "context"] as const) {
  test(`${transition} change cancels the old confirmation, sends no POST, and clears child review`, async ({ page }) => {
    await render(page); await reviewChild(page);
    await page.getByRole("checkbox", { name: "project-alpha:primary" }).check();
    await page.getByRole("button", { name: "Confirm reviewed enrollment" }).click();
    await expect(page.getByRole("dialog", { name: "Confirm action" })).toBeVisible();
    if (transition === "selection") await page.getByRole("combobox", { name: "Linked client", exact: true }).evaluate(select => {
      if (!(select instanceof HTMLSelectElement)) throw new Error("Expected linked-client selector");
      select.value = "local-child-two"; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    else await page.evaluate(() => (window as any).changeEnrollmentContext());
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Reviewed import enrollment sources" })).toHaveCount(0);
    expect((await calls(page)).filter(call => call.method === "POST")).toEqual([]);
    if (transition === "selection") {
      await page.getByRole("button", { name: "Review sync enrollment" }).last().click();
      await expect(page.getByRole("region", { name: "Reviewed import enrollment sources" })).toBeVisible();
      expect((await calls(page)).at(-1)?.path).toBe("/api/native-directory/reviewed-import-enrollment/clients/local-child-two/review");
    }
  });
}
