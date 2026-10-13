import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const bundle = buildSync({ entryPoints: [fileURLToPath(new URL("./reviewed-import-enrollment-fixture.tsx", import.meta.url))],
  bundle: true, format: "iife", platform: "browser", write: false, outdir: "out", jsx: "automatic",
  nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
const script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
const style = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
const calls = (page: Page) => page.evaluate(() => (window as any).enrollmentCalls as Array<any>);
async function render(page: Page, scenario = "success") {
  await page.setContent('<meta name="viewport" content="width=device-width"><div id="root"></div>');
  await page.evaluate(value => { (window as any).enrollmentScenario = value; }, scenario);
  await page.addStyleTag({ content: style }); await page.addScriptTag({ content: script });
}
async function review(page: Page) {
  await page.getByRole("button", { name: "Review sync enrollment" }).click();
  await expect(page.getByRole("region", { name: "Reviewed import enrollment sources" })).toBeVisible();
}
async function submit(page: Page, retry = false) {
  await page.getByRole("button", { name: retry ? "Retry same enrollment" : "Confirm reviewed enrollment" }).click();
  await page.getByRole("dialog", { name: "Confirm action" }).getByRole("button", { name: "Confirm", exact: true }).click();
}

test("disabled is hidden and newly eligible sources require explicit selection", async ({ page }) => {
  await render(page, "disabled"); await expect(page.getByText("Reviewed import enrollment")).toHaveCount(0); expect(await calls(page)).toEqual([]);
});

test("prior enrollment is locked, eligible source is unselected, and in-app cancel sends no POST", async ({ page }) => {
  await render(page); await review(page);
  const existing = page.getByRole("checkbox", { name: "project-alpha:existing (already enrolled)" }), eligible = page.getByRole("checkbox", { name: "project-alpha:eligible" });
  await expect(existing).toBeChecked(); await expect(existing).toBeDisabled(); await expect(eligible).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Confirm reviewed enrollment" })).toBeDisabled();
  await eligible.check(); await page.getByRole("button", { name: "Confirm reviewed enrollment" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm action" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await calls(page)).filter(call => call.method === "POST")).toHaveLength(0);
});

test("fresh CSRF and matching idempotency are used while duplicate activation is locked", async ({ page }) => {
  await render(page); await review(page); await page.getByRole("checkbox", { name: "project-alpha:eligible" }).check();
  await page.getByRole("button", { name: "Confirm reviewed enrollment" }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).dblclick();
  await expect(page.getByRole("status")).toContainText("enrolled");
  const recorded = await calls(page), post = recorded.find(call => call.method === "POST"), body = JSON.parse(post.body);
  expect(recorded.filter(call => call.path.endsWith("/session"))).toHaveLength(1);
  expect(post.headers["x-csrf-token"]).toBe(`101.${"1".repeat(64)}`); expect(post.headers["idempotency-key"]).toBe(body.mutationId);
  expect(body.sourceIds).toEqual(["project-alpha:eligible", "project-alpha:existing"]); expect(await page.evaluate(() => (window as any).changeCount)).toBe(1);
});

test("uncertain outcome retries identical body and mutation with a freshly fetched session", async ({ page }) => {
  await render(page, "network"); await review(page); await page.getByRole("checkbox", { name: "project-alpha:eligible" }).check(); await submit(page);
  await expect(page.getByRole("alert")).toContainText("uncertain"); await submit(page, true);
  await expect(page.getByRole("status")).toContainText("enrolled");
  const recorded = await calls(page), posts = recorded.filter(call => call.method === "POST"), sessions = recorded.filter(call => call.path.endsWith("/session"));
  expect(posts).toHaveLength(2); expect(posts[1].body).toBe(posts[0].body); expect(posts[1].headers["idempotency-key"]).toBe(posts[0].headers["idempotency-key"]);
  expect(sessions).toHaveLength(2); expect(posts[1].headers["x-csrf-token"]).toBe(`102.${"2".repeat(64)}`);
});

test("409 requires a fresh review and never automatically posts", async ({ page }) => {
  await render(page, "conflict"); await review(page); await page.getByRole("checkbox", { name: "project-alpha:eligible" }).check(); await submit(page);
  await expect(page.getByRole("alert")).toContainText("stale");
  await expect(page.getByRole("button", { name: "Refresh enrollment review" })).toBeVisible();
  expect((await calls(page)).filter(call => call.method === "POST")).toHaveLength(1);
});

test("zero-source review is valid and presents an informative empty state", async ({ page }) => {
  await render(page, "empty"); await review(page);
  await expect(page.getByText("No Project Alpha sources are eligible for enrollment.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm reviewed enrollment" })).toBeDisabled();
});

test("malformed review fails closed before exposing enrollment", async ({ page }) => {
  await render(page, "malformed-review"); await page.getByRole("button", { name: "Review sync enrollment" }).click();
  await expect(page.getByRole("alert")).toContainText("unavailable"); await expect(page.getByRole("checkbox")).toHaveCount(0);
});

for (const scenario of ["malformed-session", "malformed-outcome"]) {
  test(`${scenario} fails closed and preserves the frozen request without reporting success`, async ({ page }) => {
    await render(page, scenario); await review(page); await page.getByRole("checkbox", { name: "project-alpha:eligible" }).check(); await submit(page);
    await expect(page.getByRole("alert")).toContainText("uncertain"); await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry same enrollment" })).toBeVisible();
  });
}
