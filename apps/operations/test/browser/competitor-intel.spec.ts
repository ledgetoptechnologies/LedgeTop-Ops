import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const bundle = buildSync({ entryPoints: [fileURLToPath(new URL("./competitor-intel-fixture.tsx", import.meta.url))], bundle: true, format: "iife",
  platform: "browser", write: false, outdir: "out", jsx: "automatic", loader: { ".svg": "dataurl" },
  nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
const script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
const style = bundle.outputFiles.filter(file => file.path.endsWith(".css")).map(file => file.text).join("\n");
const ORIGIN = "https://ops.competitor-intel.test";
type Command = { kind: string; params: Record<string, unknown> };

async function render(page: Page, mode = "ok", tenant = false) {
  await page.route(`${ORIGIN}/**`, route => route.fulfill({ contentType: "text/html",
    body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>' }));
  await page.goto(`${ORIGIN}/operations/competitor-intel${tenant ? "?tenant=sample-riverbend" : ""}`);
  await page.evaluate(value => { (window as Window & { ciMode?: string }).ciMode = value; }, mode);
  await page.addStyleTag({ content: style }); await page.addScriptTag({ content: script });
}
const commands = (page: Page) => page.evaluate(() => (window as Window & { ciCommands?: Command[] }).ciCommands ?? []) as Promise<Command[]>;
async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}
async function shot(page: Page, name: string) {
  if (process.env.CI_SHOTS) await page.screenshot({ path: `${process.env.CI_SHOTS}/${name}-${test.info().project.name}.png`, fullPage: true });
}

test("all-client triage puts critical work first and summarizes every tenant", async ({ page }) => {
  await render(page);
  const summary = page.getByRole("list", { name: "Competitor Intel summary" });
  await expect(summary.getByRole("listitem").filter({ hasText: "Changes to review" })).toContainText("12");
  await expect(summary.getByRole("listitem").filter({ hasText: "Ready to publish" })).toContainText("1");
  await expect(summary.getByRole("listitem").filter({ hasText: "Scans out of date" })).toContainText("1");
  await expect(summary.getByRole("listitem").filter({ hasText: "Clients monitored" })).toContainText("3 of 4");
  const names = await page.getByRole("list", { name: "Clients" }).getByRole("heading").allTextContents();
  expect(names.slice(0, 2)).toEqual(["Riverbend Roofing (sample)", "Ledge Top (sample)"]);
  await expect(page.getByRole("article", { name: "Harbor Dental (sample)" })).toContainText("Failed");
  await expect(page.getByRole("article", { name: "Harbor Dental (sample)" })).toContainText("Withdrawn");
  await noHorizontalScroll(page); await shot(page, "ops-ci-index");
  await page.getByRole("button", { name: "Open Riverbend Roofing (sample)" }).click();
  await expect(page.getByRole("heading", { name: "Riverbend Roofing (sample)", level: 2 })).toBeVisible();
  await page.getByRole("button", { name: "← All clients" }).click();
  await expect(page.getByRole("heading", { name: "Competitor Intel" })).toBeVisible();
});

test("an empty roster explains when monitoring starts", async ({ page }) => {
  await render(page, "empty");
  await expect(page.getByText("No clients are monitored yet")).toBeVisible();
});

test("a verdict sends only the set_verdict intent and never publishes", async ({ page }) => {
  await render(page, "ok", true);
  await expect(page.getByRole("tab", { name: /Review changes/ })).toHaveAttribute("aria-selected", "true");
  const cards = page.getByRole("tabpanel").getByRole("article");
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText("Critical");
  await expect(cards.first()).toContainText("High confidence");
  await noHorizontalScroll(page); await shot(page, "ops-ci-review");
  await cards.first().getByLabel(/Note for the team/).fill("  Checked their pricing page.  ");
  await cards.first().getByRole("button", { name: "Accurate", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Marked accurate.");
  expect(await commands(page)).toEqual([{ kind: "set_verdict", params: {
    changeOperationId: "00000000-0000-4000-8000-000000000011", verdict: "accurate", note: "Checked their pricing page." } }]);
  await page.getByRole("button", { name: "Reviewed", exact: true }).click();
  await expect(page.getByText("Not a real change.")).toBeVisible();
});

test("a rejected intent keeps the form open and says nothing changed", async ({ page }) => {
  await render(page, "reject", true);
  const card = page.getByRole("tabpanel").getByRole("article").first();
  await card.getByRole("button", { name: "Inaccurate" }).click();
  await expect(page.getByRole("alert")).toContainText("Nothing was changed");
  await expect(card.getByRole("button", { name: "Accurate", exact: true })).toBeEnabled();
});

test("competitors rank by threat and show missing evidence honestly", async ({ page }) => {
  await render(page, "ok", true);
  await page.getByRole("tab", { name: "Competitors" }).click();
  const headings = await page.getByRole("tabpanel").getByRole("heading", { level: 4 }).allTextContents();
  expect(headings).toEqual(["Summit Ridge Roofing", "Lakeside Exteriors", "North Pine Home Pros"]);
  const summit = page.getByRole("article", { name: "Summit Ridge Roofing" });
  await expect(summit.getByRole("meter", { name: "Threat" })).toHaveAttribute("aria-valuetext", "7.4 of 10, High concern");
  await expect(summit).toContainText("86%");
  await expect(summit).toContainText("About 14 ads");
  await expect(page.getByRole("article", { name: "Lakeside Exteriors" })).toContainText("Out of date");
  await expect(page.getByRole("article", { name: "Lakeside Exteriors" })).toContainText("None found");
  await expect(page.getByRole("article", { name: "Lakeside Exteriors" })).toContainText("Out of date · on Jul 1, 2026");
  await expect(summit).not.toContainText("Out of date");
  const pine = page.getByRole("article", { name: "North Pine Home Pros" });
  await expect(pine).toContainText("Blocked automated checks");
  await expect(pine).toContainText("No baseline assessment yet.");
  await noHorizontalScroll(page); await shot(page, "ops-ci-competitors");
});

test("Google Ads and self-assessment mark internal-only content", async ({ page }) => {
  await render(page, "ok", true);
  await page.getByRole("tab", { name: "Google Ads" }).click();
  const totals = page.getByRole("list", { name: "Ads totals" });
  await expect(totals).toContainText("$1,842.38");
  await expect(totals).toContainText("$44.94");
  await expect(totals).toContainText("4.35%");
  await expect(page.getByRole("tabpanel")).toContainText("Totals through Oct 20, 2026");
  await expect(page.getByRole("tabpanel")).toContainText("Out of date · scored Sep 12, 2026");
  await expect(page.getByRole("region", { name: "Active search ads" })).toContainText("Internal · never shown to the client");
  await noHorizontalScroll(page); await shot(page, "ops-ci-ads");
  await page.getByRole("tab", { name: /Self-assessment/ }).click();
  await expect(page.getByText("Internal · never shown to the client")).toBeVisible();
  await expect(page.getByRole("meter", { name: "Overall concern" })).toHaveAttribute("aria-valuetext", "5.4 of 10, Moderate concern");
  await page.getByRole("button", { name: "Run self-assessment" }).click();
  expect((await commands(page)).at(-1)).toEqual({ kind: "run_self_assessment", params: { scopeKey: "self:riverbend" } });
});

test("publishing pins exactly the ticked observations after confirmation", async ({ page }) => {
  await render(page, "ok", true);
  await page.getByRole("tab", { name: "Client report" }).click();
  await expect(page.getByText("Competitor report · September 2026")).toBeVisible();
  await expect(page.getByText(/2 still need review · 1 marked inaccurate and never published/)).toBeVisible();
  await expect(page.getByText("10 items")).toBeVisible();
  await page.getByRole("checkbox", { name: /North Pine Home Pros/ }).uncheck();
  await expect(page.getByText("9 items")).toBeVisible();
  await noHorizontalScroll(page); await shot(page, "ops-ci-publish");
  await page.getByLabel("Report title").fill("October check-in");
  await page.getByRole("button", { name: "Publish to client" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  expect(await commands(page)).toEqual([]);
  await page.getByRole("button", { name: "Publish to client" }).click();
  await expect(page.getByRole("dialog")).toContainText("exactly these 9 items, replacing the current report");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("status")).toHaveText("Report publish requested.");
  const [publish] = await commands(page);
  expect(publish!.kind).toBe("publish");
  expect(publish!.params.reportTitle).toBe("October check-in");
  const items = publish!.params.items as { operationId: string; payloadSha256: string }[];
  // Summit and Lakeside profile, baseline and ads; both accurate changes (a new revision replaces the old); the Ads checkup.
  expect(items.map(item => item.operationId.slice(-2))).toEqual(["01", "02", "03", "04", "05", "06", "12", "14", "20"]);
  expect(items.every(item => Object.keys(item).sort().join() === "operationId,payloadSha256")).toBe(true);
});

test("withdrawing needs a reason and confirmation", async ({ page }) => {
  await render(page, "ok", true);
  await page.getByRole("tab", { name: "Client report" }).click();
  await page.getByRole("button", { name: "Withdraw report" }).click();
  const submit = page.getByRole("region", { name: "What the client sees now" }).getByRole("button", { name: "Withdraw report" });
  await expect(submit).toBeDisabled();
  await page.getByLabel("Reason for withdrawing").fill("Pricing claim needs correction");
  await submit.click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  expect(await commands(page)).toEqual([{ kind: "withdraw", params: { manifestId: "11111111-1111-4111-8111-111111111111", reason: "Pricing claim needs correction" } }]);
});

test("scan requests are single Ops intents", async ({ page }) => {
  await render(page, "ok", true);
  await page.getByRole("button", { name: "Run scan" }).click();
  await expect(page.getByRole("status")).toContainText("Scan requested");
  await page.getByRole("button", { name: "Review Google Ads" }).click();
  expect(await commands(page)).toEqual([
    { kind: "run_scan", params: { scanType: "full", competitorSubjectKeys: [] } },
    { kind: "run_ads_review", params: { providerAccountRef: "ads-sample-1" } },
  ]);
});
