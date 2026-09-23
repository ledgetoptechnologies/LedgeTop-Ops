import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const fixture = new URL("./client-profile-onboarding-fixture.tsx", import.meta.url);
const bundle = buildSync({ entryPoints: [fileURLToPath(fixture)], bundle: true, format: "iife", platform: "browser", write: false, outdir: "out", jsx: "automatic", nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
const script = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text;
const stylesheet = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text;
if (!script || !stylesheet) throw new Error("Client onboarding browser fixture did not compile.");

async function render(page: Page) {
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>');
  await page.addStyleTag({ content: stylesheet });
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("heading", { name: "Client profile onboarding" })).toBeVisible();
}

test("real onboarding form switches profile fields, clears stale values and stays responsive", async ({ page }) => {
  await render(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByLabel("Organization").check();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("Organization name")).toHaveAttribute("required", "");
  await expect(page.getByLabel("Region / state")).toHaveAttribute("maxlength", "100");
  await expect(page.getByLabel("Postal code")).toHaveAttribute("maxlength", "32");
  await page.getByLabel("Organization name").fill("Ledge Top");
  await page.getByLabel("General company email").fill("office@example.test");
  await page.getByLabel("Individual").check();
  await expect(page.getByLabel("Organization name")).toHaveCount(0);
  await page.getByLabel("Contact name").fill("Pat Lee");
  await page.getByLabel("Email address").fill("pat@example.test");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { onboardingSubmission?: unknown }).onboardingSubmission)).toMatchObject({
    profileType: "individual", organizationName: "", generalEmail: "", generalPhone: "",
  });
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 320, height: 900 });
  const fields = await page.locator(".client-profile-onboarding-grid > :not(.client-profile-onboarding-span-two)").evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect(); return { x: rect.x, width: rect.width };
  }));
  expect(new Set(fields.map(field => field.x)).size).toBe(1);
  expect(new Set(fields.map(field => field.width)).size).toBe(1);
});
