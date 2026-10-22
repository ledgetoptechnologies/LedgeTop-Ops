import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const fixture = new URL("./native-directory-profile-layout-fixture.tsx", import.meta.url);
const bundle = buildSync({ entryPoints: [fileURLToPath(fixture)], bundle: true, format: "iife", platform: "browser", write: false,
  outdir: "out", jsx: "automatic", loader: { ".svg": "dataurl", ".png": "dataurl", ".woff2": "dataurl" },
  nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
const script = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text;
const stylesheet = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text;
if (!script || !stylesheet) throw new Error("Native Directory profile layout fixture did not compile.");

async function openCreate(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>');
  await page.evaluate(() => { (window as Window & { nativeDirectoryScenario?: string }).nativeDirectoryScenario = "two-destinations"; });
  await page.addStyleTag({ content: stylesheet });
  await page.addScriptTag({ content: script });
  await page.getByRole("button", { name: "Add client profile" }).click();
  const dialog = page.getByRole("dialog", { name: "Add client profile" });
  await expect(dialog).toBeVisible();
  const drone = await dialog.getByRole("checkbox", { name: "Ledge Top Drone Services" }).locator("xpath=ancestor::label[1]").boundingBox();
  const tech = await dialog.getByRole("checkbox", { name: "Ledge Top Technologies" }).locator("xpath=ancestor::label[1]").boundingBox();
  expect(drone && tech).toBeTruthy();
  return { drone: drone!, tech: tech! };
}

test("Project Alpha destinations sit side by side on wider screens", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "The mobile project emulates a phone at any width.");
  const { drone, tech } = await openCreate(page, 1280);
  expect(Math.abs(drone.y - tech.y)).toBeLessThan(2);
  expect(tech.x).toBeGreaterThanOrEqual(drone.x + drone.width);
});

test("Project Alpha destinations stack on phones", async ({ page }) => {
  const { drone, tech } = await openCreate(page, 390);
  expect(tech.y).toBeGreaterThanOrEqual(drone.y + drone.height);
  expect(Math.abs(drone.x - tech.x)).toBeLessThan(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("new profiles start in Wisconsin, United States, with a state picker that gives way to free text abroad", async ({ page }) => {
  await openCreate(page, 1280);
  const dialog = page.getByRole("dialog", { name: "Add client profile" });
  const state = dialog.getByRole("combobox", { name: "State" }), country = dialog.getByRole("combobox", { name: "Country" });
  await expect(country).toHaveValue("US");
  await expect(state).toHaveValue("WI");
  await expect(state.locator("option:checked")).toHaveText("Wisconsin");
  await state.selectOption({ label: "Minnesota" });
  await expect(state).toHaveValue("MN");
  await country.selectOption({ label: "Other country" });
  await dialog.getByRole("textbox", { name: "Country name" }).fill("Canada");
  await expect(dialog.getByRole("combobox", { name: "State" })).toHaveCount(0);
  await expect(dialog.getByRole("textbox", { name: "State / province" })).toBeVisible();
  await country.selectOption({ label: "United States" });
  await expect(dialog.getByRole("textbox", { name: "Country name" })).toHaveCount(0);
  await expect(dialog.getByRole("combobox", { name: "State" })).toBeVisible();
});
