import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const fixture = new URL("./operations-native-delivery-owner-fixture.tsx", import.meta.url);
const bundle = buildSync({ entryPoints: [fileURLToPath(fixture)], bundle: true, format: "iife", platform: "browser",
  write: false, outdir: "out", jsx: "automatic",
  nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
const script = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text;
const stylesheet = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text;
if (!script || !stylesheet) throw new Error("Operations-native delivery owner fixture did not compile.");
const route = "/administration/client-portal/operations-delivery-authority";
const targetId = "11111111-1111-4111-8111-111111111111";
const recipientBindingId = "22222222-2222-4222-8222-222222222222";
const folderReservationId = "33333333-3333-4333-8333-333333333333";
const authorityId = "44444444-4444-4444-8444-444444444444";
const recoveryOperationId = "55555555-5555-4555-8555-555555555555";

async function render(page: Page, mode = "success") {
  await page.route(`**${route}`, request => request.fulfill({ contentType: "text/html",
    body: '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>' }));
  await page.goto(route);
  await page.evaluate(selected => {
    (window as Window & { nativeDeliveryMode?: string }).nativeDeliveryMode = selected;
  }, mode);
  await page.addStyleTag({ content: stylesheet });
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("heading", { name: "Operations-native delivery authority" })).toBeVisible();
}
async function calls(page: Page) {
  return page.evaluate(() => (window as Window & { nativeDeliveryCalls?: Array<{
    path: string; method: string; body: Record<string, unknown> | null;
  }> }).nativeDeliveryCalls ?? []);
}
async function loadCandidate(page: Page) {
  await page.getByLabel("Exact native portal target ID").fill(targetId);
  await page.getByRole("button", { name: "Load current candidates" }).click();
  await expect(page.getByRole("heading", { name: "Candidate recipient and folder pairs" })).toBeVisible();
  await page.getByRole("button", { name: "Review this exact pair" }).click();
  await expect(page.getByRole("heading", { name: "Review exact delivery grant" })).toBeVisible();
}
async function submitGrant(page: Page) {
  await page.getByLabel("file.preview").uncheck();
  await page.getByLabel("file.download").uncheck();
  await page.getByLabel("Exact grant reason code").fill("approved-staging-review");
  await page.getByLabel(/I reviewed this exact recipient binding/).check();
  await page.getByRole("button", { name: "Grant exact delivery authority" }).click();
}
async function loadAuthority(page: Page) {
  await page.getByLabel("Exact delivery authority ID").fill(authorityId);
  await page.getByRole("button", { name: "Load exact authority" }).click();
  await expect(page.getByRole("heading", { name: "Current native delivery authority" })).toBeVisible();
}

test("grants only the reviewed recipient-binding and folder-reservation pair with exact features", async ({ page }) => {
  await render(page); await loadCandidate(page); await submitGrant(page);
  await expect(page.getByText("Grant delivery was acknowledged.")).toBeVisible();
  const request = (await calls(page)).find(call => call.path.endsWith("/authorities") && call.method === "POST");
  expect(request?.body).toMatchObject({ authorityId: expect.any(String), recipientBindingId, folderReservationId,
    expectedRevision: 0, expectedCandidateFingerprint: "a".repeat(64),
    features: ["folder.list", "file.metadata"], reasonCode: "approved-staging-review" });
  expect(Object.keys(request?.body ?? {}).sort()).toEqual(["authorityId", "expectedCandidateFingerprint",
    "expectedRevision", "expiresAt", "features", "folderReservationId", "operationId", "reasonCode",
    "recipientBindingId"].sort());
  await expect(page.getByText(/Features and expiry are immutable here/)).toBeVisible();
});

test("an uncertain grant renews the session and retries the identical frozen body", async ({ page }) => {
  await render(page, "grant-network"); await loadCandidate(page); await submitGrant(page);
  await expect(page.getByRole("alert")).toContainText("outcome is uncertain");
  await expect(page.getByLabel("Exact native portal target ID")).toBeDisabled();
  await page.getByRole("button", { name: "Retry same frozen grant" }).click();
  await expect(page.getByText("Grant delivery was acknowledged.")).toBeVisible();
  const recorded = await calls(page), grants = recorded.filter(call => call.path.endsWith("/authorities") && call.method === "POST");
  expect(grants).toHaveLength(2); expect(grants[1]?.body).toEqual(grants[0]?.body);
  expect(recorded.filter(call => call.path.endsWith("/session"))).toHaveLength(2);
});

test("a stale candidate is cleared and requires a fresh explicit review", async ({ page }) => {
  await render(page, "candidate-stale"); await loadCandidate(page); await submitGrant(page);
  await expect(page.getByRole("alert")).toContainText("candidate is stale");
  await expect(page.getByRole("heading", { name: "Review exact delivery grant" })).toHaveCount(0);
  expect((await calls(page)).filter(call => call.path.endsWith("/authorities"))).toHaveLength(1);
});

test("pending recovery is unavailable until reload and uses the exact stored operation", async ({ page }) => {
  await render(page, "load-pending");
  await page.getByLabel("Exact native portal target ID").fill(targetId);
  await page.getByRole("button", { name: "Load current candidates" }).click();
  await expect(page.getByRole("heading", { name: "Current delivery authorities" })).toBeVisible();
  await page.getByRole("button", { name: "Review current authority" }).click();
  await expect(page.getByText("pending", { exact: true })).toBeVisible();
  await page.getByLabel("Exact recovery reason").fill("retry-after-current-owner-review");
  await page.getByLabel(/I reviewed this exact authority/).check();
  await page.getByRole("button", { name: "Recover exact pending delivery" }).click();
  await expect(page.getByText("Recovery delivery was acknowledged.")).toBeVisible();
  const recovery = (await calls(page)).find(call => call.path.endsWith("/recover"));
  expect(recovery?.body).toMatchObject({ invocationId: expect.any(String), operationId: recoveryOperationId,
    expectedRevision: 1, reason: "retry-after-current-owner-review" });
});

test("a dead transport cannot recover and requires explicit revoke before reissue", async ({ page }) => {
  await render(page, "load-dead"); await loadAuthority(page);
  await expect(page.getByRole("alert")).toContainText("Delivery is dead and cannot be recovered");
  await expect(page.getByRole("button", { name: /Recover exact pending/ })).toHaveCount(0);
  await expect(page.getByText(/revoke an active local authority, then separately review/)).toBeVisible();
  await page.getByLabel("Exact revocation reason code").fill("dead-transport-cleanup");
  await page.getByLabel(/I reviewed this exact authority/).check();
  await page.getByRole("button", { name: "Revoke exact delivery authority" }).click();
  await expect(page.getByText("Revocation delivery was acknowledged.")).toBeVisible();
});

test("an uncertain revoke retries the exact body without silently changing authority", async ({ page }) => {
  await render(page, "revoke-network"); await loadAuthority(page);
  await page.getByLabel("Exact revocation reason code").fill("explicit-owner-revocation");
  await page.getByLabel(/I reviewed this exact authority/).check();
  await page.getByRole("button", { name: "Revoke exact delivery authority" }).click();
  await expect(page.getByRole("alert")).toContainText("outcome is uncertain");
  await page.getByRole("button", { name: "Retry same frozen revoke" }).click();
  await expect(page.getByText("Revocation delivery was acknowledged.")).toBeVisible();
  const recorded = await calls(page), revokes = recorded.filter(call => call.path.endsWith("/revoke"));
  expect(revokes).toHaveLength(2); expect(revokes[1]?.body).toEqual(revokes[0]?.body);
  expect(recorded.filter(call => call.path.endsWith("/session"))).toHaveLength(2);
});

test("an access denial clears candidate labels and identifiers", async ({ page }) => {
  await render(page, "candidate-denied-after-first");
  await page.getByLabel("Exact native portal target ID").fill(targetId);
  await page.getByRole("button", { name: "Load current candidates" }).click();
  await expect(page.getByRole("heading", { name: "Current delivery authorities" })).toBeVisible();
  await page.getByRole("button", { name: "Load current candidates" }).click();
  await expect(page.getByRole("alert")).toContainText("could not be loaded");
  await expect(page.getByText(recipientBindingId, { exact: true })).toHaveCount(0);
});

test("pages current authorities with opaque cursors without collapsing explicit reissues", async ({ page }) => {
  await render(page, "authority-pages");
  await page.getByLabel("Exact native portal target ID").fill(targetId);
  await page.getByRole("button", { name: "Load current candidates" }).click();
  await expect(page.getByText(authorityId, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Load more authorities" }).click();
  await expect(page.getByText("77777777-7777-4777-8777-777777777777", { exact: false })).toBeVisible();
  const authorityLists = (await calls(page)).filter(call => call.path.includes("/authorities?"));
  expect(authorityLists).toHaveLength(2);
  expect(authorityLists[1]?.path).toContain("cursor=v1.authority_page.");
});
