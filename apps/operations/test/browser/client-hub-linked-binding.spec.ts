import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const bundle = buildSync({ entryPoints: [fileURLToPath(new URL("./client-hub-linked-binding-fixture.tsx", import.meta.url))],
  bundle: true, format: "iife", platform: "browser", write: false, outdir: "out", jsx: "automatic",
  loader: { ".svg": "dataurl" }, nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
const script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
const style = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
const calls = (page: Page) => page.evaluate(() => (window as any).bindingCalls);
async function render(page: Page, enabled = true) {
  await page.route("**/clients/sources/**", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.goto("/clients/sources/project-alpha%3Asecondary/business/organizations/remote-org");
  await page.evaluate(value => { (window as any).bindingFlag = value; }, enabled);
  await page.addStyleTag({ content: style }); await page.addScriptTag({ content: script });
  await expect(page.getByRole("combobox", { name: "Linked client", exact: true })).toBeVisible();
}
async function selectAndReview(page: Page) {
  await page.getByRole("combobox", { name: "Linked client", exact: true }).selectOption("local-child-one");
  await page.getByRole("button", { name: "Review binding revision", exact: true }).click();
  await expect(page.getByRole("region", { name: "Reviewed binding revision" })).toBeVisible();
}

test("selected linked client uses its validated native ID and current server source", async ({ page }) => {
  await render(page);
  await expect(page.getByRole("button", { name: "Review binding revision" })).toHaveCount(0);
  await selectAndReview(page);
  expect(await calls(page)).toEqual([{ path: "/api/client-hub/directory/binding-revisions/review",
    body: { recordId: "local-child-one", sourceId: "project-alpha:secondary" } }]);
});

test("disabled refresh capability does not expose linked-client refresh", async ({ page }) => {
  await render(page, false);
  await page.getByRole("combobox", { name: "Linked client", exact: true }).selectOption("local-child-one");
  await expect(page.getByRole("button", { name: "Review binding revision" })).toHaveCount(0);
  expect(await calls(page)).toEqual([]);
});

test("unvalidated selection cannot expose a refresh control", async ({ page }) => {
  await render(page);
  await page.getByRole("combobox", { name: "Linked client", exact: true }).evaluate(select => {
    select.appendChild(new Option("Unvalidated", "not-linked"));
  });
  await page.getByRole("combobox", { name: "Linked client", exact: true }).selectOption("not-linked");
  await expect(page.getByRole("button", { name: "Review binding revision" })).toHaveCount(0);
  expect(await calls(page)).toEqual([]);
});

for (const transition of ["selection", "removed", "context"]) {
  test(`${transition} change cancels pending confirmation and clears child review`, async ({ page }) => {
    await render(page); await selectAndReview(page);
    await page.getByRole("button", { name: "Confirm binding revision refresh", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // The modal makes background controls inert; simulate a context update rather than a user click through it.
    if (transition === "selection") await page.getByRole("combobox", { name: "Linked client", exact: true }).evaluate(select => {
      if (!(select instanceof HTMLSelectElement)) throw new Error("Expected linked-client selector");
      select.value = "local-child-two";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    else await page.evaluate(value => value === "removed" ? (window as any).replaceLinkedClients() : (window as any).changeHubContext(), transition);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Reviewed binding revision" })).toHaveCount(0);
    expect((await calls(page)).filter((call: any) => call.path.endsWith("/execute"))).toEqual([]);
    if (transition === "selection") {
      await page.getByRole("button", { name: "Review binding revision", exact: true }).click();
      await expect(page.getByRole("region", { name: "Reviewed binding revision" })).toBeVisible();
      expect((await calls(page))[1].body).toEqual({ recordId: "local-child-two", sourceId: "project-alpha:secondary" });
    } else await expect(page.getByRole("button", { name: "Review binding revision" })).toHaveCount(0);
  });
}
