import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const fixture = new URL("./client-onboarding-staff-fixture.tsx", import.meta.url);
const bundle = buildSync({ entryPoints: [fileURLToPath(fixture)], bundle: true, format: "iife", platform: "browser", write: false,
  outdir: "out", jsx: "automatic", nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
const script = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text;
const stylesheet = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text;
if (!script || !stylesheet) throw new Error("Staff onboarding browser fixture did not compile.");

async function render(page: Page, mode = "success") {
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>');
  await page.evaluate(value => { (window as Window & { onboardingMode?: string }).onboardingMode = value; }, mode);
  await page.addStyleTag({ content: stylesheet });
  await page.addScriptTag({ content: script });
}
async function issue(page: Page) {
  await expect(page.getByRole("heading", { name: "Issue client profile onboarding" })).toBeVisible();
  await expect(page.getByText("Recipient flow is disabled")).toBeVisible();
  await page.getByLabel("Business area ID").fill("area:onboarding");
  await page.getByRole("button", { name: "Issue invitation metadata" }).click();
  await expect(page.getByRole("heading", { name: "Invitation metadata issued" })).toBeVisible();
}

test("capability remains hidden when the dedicated administrator session is disabled", async ({ page }) => {
  await render(page, "disabled");
  await expect(page.getByRole("heading", { name: "Client onboarding unavailable" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Issue invitation metadata" })).toHaveCount(0);
});

test("issues metadata and permits exactly one reveal without creating a recipient URL", async ({ page }) => {
  await render(page);
  await issue(page);
  await page.getByRole("button", { name: "Reveal secret once" }).click();
  await expect(page.getByLabel("Invitation secret")).toHaveText("d".repeat(64));
  await expect(page.getByText("No recipient URL or client access has been created.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reveal secret once" })).toHaveCount(0);
  const calls = await page.evaluate(() => (window as Window & { onboardingCalls?: Array<{path: string}> }).onboardingCalls || []);
  expect(calls.filter(call => call.path.endsWith("/reveal"))).toHaveLength(1);
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});

test("an uncertain reveal is locked and never repeated", async ({ page }) => {
  await render(page, "uncertain");
  await issue(page);
  await page.getByRole("button", { name: "Reveal secret once" }).click();
  await expect(page.getByRole("alert")).toContainText("Reveal outcome is uncertain");
  await expect(page.getByRole("button", { name: "Reveal secret once" })).toHaveCount(0);
  const calls = await page.evaluate(() => (window as Window & { onboardingCalls?: Array<{path: string}> }).onboardingCalls || []);
  expect(calls.filter(call => call.path.endsWith("/reveal"))).toHaveLength(1);
});
