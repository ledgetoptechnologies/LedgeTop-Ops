import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const fixture = new URL("./client-portal-recipient-enrollment-owner-fixture.tsx", import.meta.url);
const bundle = buildSync({ entryPoints: [fileURLToPath(fixture)], bundle: true, format: "iife", platform: "browser", write: false,
  outdir: "out", jsx: "automatic", nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
const script = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text;
const stylesheet = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text;
if (!script || !stylesheet) throw new Error("Portal recipient owner fixture did not compile.");
async function render(page: Page, mode = "success") {
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>');
  await page.evaluate(value => { (window as Window & { enrollmentMode?: string }).enrollmentMode = value; }, mode);
  await page.addStyleTag({ content: stylesheet }); await page.addScriptTag({ content: script });
  await expect(page.getByRole("heading", { name: "Client portal account enrollment" })).toBeVisible();
}
async function reviewAndConfirm(page: Page) {
  await expect(page.getByRole("heading", { name: "Review recipient" })).toBeVisible();
  await page.getByLabel("I reviewed the exact client, selection, issuer, and subject.").check();
  await page.getByRole("button", { name: "Confirm portal access" }).click();
}

test("issues a one-time link for one exact acknowledged target and separately confirms its signed principal", async ({ page }) => {
  await render(page);
  await page.getByLabel("Client record ID").fill("client:one");
  await page.getByLabel("Acknowledged workspace selection ID").fill("11111111-1111-4111-8111-111111111111");
  await page.getByLabel(/I verified that this client record/).check();
  await page.getByRole("button", { name: "Issue one-time confirmation link" }).click();
  await expect(page.getByLabel("Portal confirmation link")).toHaveText(
    `https://client-staging.example.test/portal/recipient-enrollment/33333333-3333-4333-8333-333333333333#${"b".repeat(64)}`);
  await reviewAndConfirm(page);
  await expect(page.getByRole("status").filter({ hasText: "acknowledged" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Active portal identity" })).toBeVisible();
  await expect(page.getByLabel("I reviewed the exact client, selection, issuer, and subject.")).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Revoke all portal access" })).toBeDisabled();
  const calls = await page.evaluate(() => (window as Window & { enrollmentCalls?: Array<{path:string;method:string;body:Record<string,unknown>}> }).enrollmentCalls ?? []);
  expect(calls.find(call => call.path.endsWith("/intents") && call.method === "POST")?.body).toMatchObject({
    clientRecordId: "client:one", selectionId: "11111111-1111-4111-8111-111111111111",
  });
  expect(calls.find(call => call.path.endsWith("/confirm"))?.body).toMatchObject({ expectedRevision: 2 });
});

test("an uncertain confirmation retries the same operation and expected revision", async ({ page }) => {
  await render(page, "confirm-uncertain");
  await reviewAndConfirm(page);
  await expect(page.getByRole("alert")).toContainText("outcome is uncertain");
  await page.getByRole("button", { name: "Retry same confirm" }).click();
  await expect(page.getByRole("status").filter({ hasText: "acknowledged" })).toBeVisible();
  const calls = await page.evaluate(() => (window as Window & { enrollmentCalls?: Array<{path:string;body:Record<string,unknown>}> }).enrollmentCalls ?? []);
  const confirmations = calls.filter(call => call.path.endsWith("/confirm"));
  expect(confirmations).toHaveLength(2);
  expect(confirmations[1]?.body).toEqual(confirmations[0]?.body);
});

test("an uncertain issuance freezes its exact input and retries the same operation", async ({ page }) => {
  await render(page, "issue-uncertain");
  await page.getByLabel("Client record ID").fill("client:one");
  await page.getByLabel("Acknowledged workspace selection ID").fill("11111111-1111-4111-8111-111111111111");
  await page.getByLabel(/I verified that this client record/).check();
  await page.getByRole("button", { name: "Issue one-time confirmation link" }).click();
  await expect(page.getByRole("alert")).toContainText("outcome is uncertain");
  await expect(page.getByLabel("Client record ID")).toBeDisabled();
  await expect(page.getByLabel("Acknowledged workspace selection ID")).toBeDisabled();
  await page.getByRole("button", { name: "Retry same issuance" }).click();
  await expect(page.getByRole("button", { name: "Start new intent" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("cannot be revealed again");
  const calls = await page.evaluate(() => (window as Window & { enrollmentCalls?: Array<{path:string;method:string;body:Record<string,unknown>}> }).enrollmentCalls ?? []);
  const issues = calls.filter(call => call.path.endsWith("/intents") && call.method === "POST");
  expect(issues).toHaveLength(2);
  expect(issues[1]?.body).toEqual(issues[0]?.body);
});
