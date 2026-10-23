import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const built = buildSync({ entryPoints: [fileURLToPath(new URL("./competitor-report-fixture.tsx", import.meta.url))], bundle: true, write: false,
  outdir: "out", format: "iife", platform: "browser", jsx: "automatic", loader: { ".svg": "dataurl" },
  nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
async function render(page: Page, mode = "report") {
  await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>');
  await page.evaluate(value => { (window as Window & { ciMode?: string }).ciMode = value; }, mode);
  for (const file of built.outputFiles) if (file.path.endsWith(".css")) await page.addStyleTag({ content: file.text });
  for (const file of built.outputFiles) if (file.path.endsWith(".js")) await page.addScriptTag({ content: file.text });
}
async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

test("a published report shows reviewed competitors, changes and the Ads overview", async ({ page }) => {
  await render(page);
  await expect(page.getByText("Reviewed by Ledge Top")).toBeVisible();
  await expect(page.getByText("Competitor report · October 2026")).toBeVisible();
  const cards = page.getByRole("region", { name: "Who to keep an eye on" }).getByRole("article");
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText("Summit Ridge Roofing");
  await expect(cards.first().getByRole("meter", { name: "Threat to your business" })).toHaveAttribute("aria-valuetext", "7.4 of 10, High concern");
  await expect(cards.first()).toContainText("High confidence");
  await expect(cards.first()).toContainText("counts are approximate");
  await expect(page.getByRole("region", { name: "What changed" }).getByRole("article")).toHaveCount(2);
  const ads = page.getByRole("list", { name: "Google Ads totals" });
  await expect(ads).toContainText("$1,842.38"); await expect(ads).toContainText("$44.94"); await expect(ads).toContainText("41");
  await expect(ads).toContainText("Cost per conversion");
  await noHorizontalScroll(page);
  if (process.env.CI_SHOTS) await page.screenshot({ path: `${process.env.CI_SHOTS}/portal-ci-report-${test.info().project.name}.png`, fullPage: true });
});

test("each item keeps its own freshness so a current badge never hides a stale one", async ({ page }) => {
  await render(page);
  const cards = page.getByRole("region", { name: "Who to keep an eye on" }).getByRole("article");
  await expect(cards.first()).toContainText("Assessed Sep 14, 2026");
  await expect(cards.first()).not.toContainText("Out of date");
  await expect(cards.nth(1)).toContainText("Out of date · assessed Jul 1, 2026");
  await expect(cards.nth(1)).toContainText("Out of date · checked Oct 1, 2026");
  const ads = page.getByRole("region", { name: "How your Google Ads are doing" });
  await expect(ads).toContainText("Totals through Oct 20, 2026");
  await expect(ads).toContainText("Out of date · scored Sep 12, 2026");
});

test("raw Google Ads conversions are never labeled as leads", async ({ page }) => {
  await render(page);
  const ads = page.getByRole("region", { name: "How your Google Ads are doing" });
  for (const label of ["Leads", "Cost per lead", "No leads"]) await expect(ads.getByText(label, { exact: true })).toHaveCount(0);
  await expect(ads.getByRole("columnheader", { name: "Conversions" })).toBeVisible();
});

test("the client never sees internal-only fields", async ({ page }) => {
  await render(page);
  const text = await page.locator("#root").innerText();
  for (const hidden of ["Inaccurate", "Accurate", "Not a real change", "Hail Damage Roof Repair", "Self-assessment", "Pricing clarity",
    "Beau Koltz", "0.83", "Internal", "North Pine", "Publish to", "revision"]) expect(text).not.toContain(hidden);
  expect(text).not.toMatch(/[0-9a-f]{64}|00000000-0000-4000/);
});

test("missing report and missing metrics read plainly", async ({ page }) => {
  await render(page, "none");
  await expect(page.getByText("No competitor report yet")).toBeVisible();
  await render(page, "no-metrics");
  await expect(page.getByText("Google Ads metrics were unavailable")).toBeVisible();
  await expect(page.getByText("No notable changes on competitor websites in this report.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Google Ads totals" })).toHaveCount(0);
});
