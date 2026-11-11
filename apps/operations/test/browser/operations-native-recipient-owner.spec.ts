import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const fixture = new URL("./operations-native-recipient-owner-fixture.tsx", import.meta.url);
const bundle = buildSync({ entryPoints: [fileURLToPath(fixture)], bundle: true, format: "iife", platform: "browser", write: false,
  outdir: "out", jsx: "automatic", nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
const script = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text;
const stylesheet = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text;
if (!script || !stylesheet) throw new Error("Operations-native recipient owner fixture did not compile.");
const route = "/administration/client-portal/operations-recipients";
const intentId = "22222222-2222-4222-8222-222222222222";
const targetId = "11111111-1111-4111-8111-111111111111";
const recoveryOperationId = "33333333-3333-4333-8333-333333333333";

async function render(page: Page, mode = "success") {
  await page.route(`**${route}`, request => request.fulfill({ contentType: "text/html",
    body: '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>' }));
  await page.goto(route);
  await page.evaluate(selectedMode => {
    (window as Window & { nativeRecipientMode?: string }).nativeRecipientMode = selectedMode;
  }, mode);
  await page.addStyleTag({ content: stylesheet });
  await page.addScriptTag({ content: script });
  await expect(page).toHaveURL(new RegExp(`${route}$`));
  await expect(page.getByRole("heading", { name: "Operations-native recipient enrollment" })).toBeVisible();
}
async function calls(page: Page) {
  return page.evaluate(() => (window as Window & { nativeRecipientCalls?: Array<{
    path: string; method: string; body: Record<string, unknown> | null;
  }> }).nativeRecipientCalls ?? []);
}
async function loadIntent(page: Page) {
  await page.getByLabel("Exact enrollment intent ID").fill(intentId);
  await page.getByRole("button", { name: "Load exact intent" }).click();
  await expect(page.getByText(targetId, { exact: true })).toBeVisible();
  await expect(page.getByText("recipient@example.test", { exact: true })).toBeVisible();
}
async function loadWorkspace(page: Page) {
  await page.getByLabel("Exact native workspace target ID").fill(targetId);
  await page.getByRole("button", { name: "Load exact workspace" }).click();
  await expect(page.getByRole("heading", { name: "Native workspace cleanup state" })).toBeVisible();
}

test("issues only an operations-native private link for an exact acknowledged target", async ({ page }) => {
  await render(page);
  await page.getByLabel("Exact portal target ID").fill(targetId);
  await page.getByLabel("Exact client record ID").fill("client:one");
  await page.getByLabel(/I verified this existing client record/).check();
  await page.getByRole("button", { name: "Issue native confirmation link" }).click();
  await expect(page.getByLabel("Native portal confirmation link")).toHaveText(
    `https://client-staging.example.test/portal/operations-recipient-enrollment/55555555-5555-4555-8555-555555555555#${"b".repeat(64)}`);
  const recorded = await calls(page), issue = recorded.find(call => call.path.endsWith("/intents") && call.method === "POST");
  expect(issue?.body).toEqual({ operationId: expect.any(String), targetId, targetClientRecordId: "client:one",
    expiresAt: expect.any(String), permissions: ["operations.service_home.read"] });
  await expect(reviewed(page, "Requested access")).toHaveText("View their service home");
  expect(recorded.every(call => !call.path.includes("/api/native-client-portal/recipient-enrollment"))).toBe(true);
  expect(await page.evaluate(() => ({ href: location.href, storage: { ...localStorage } }))).toEqual({
    href: expect.not.stringContaining("b".repeat(64)), storage: {},
  });
});

test("pending confirmation reloads current review and recovers the exact stored operation", async ({ page }) => {
  await render(page, "pending-recover");
  await loadIntent(page);
  await page.getByLabel(/I reviewed the exact target/).check();
  await page.getByRole("button", { name: "Confirm exact native recipient" }).click();
  await expect(page.getByRole("heading", { name: "Grant delivery pending" })).toBeVisible();
  await expect(page.getByText(/delivery is still pending/)).toBeVisible();
  await page.getByLabel(/I reviewed the exact target/).check();
  await page.getByRole("button", { name: "Recover exact pending delivery" }).click();
  await expect(page.getByRole("heading", { name: "Current native recipient authority" })).toBeVisible();
  const recorded = await calls(page);
  const confirmation = recorded.find(call => call.path.endsWith("/confirm"));
  const recovery = recorded.find(call => call.path.endsWith("/recover"));
  expect(confirmation?.body).toMatchObject({ expectedRevision: 2 });
  expect(recovery?.body).toEqual({ operationId: confirmation?.body?.operationId, expectedRevision: 3 });
  expect(recorded.filter(call => call.path.endsWith(`/intents/${intentId}`) && call.method === "GET")).toHaveLength(2);
});

test("an uncertain confirmation refreshes CSRF and retries the identical operation body", async ({ page }) => {
  await render(page, "confirm-uncertain");
  await loadIntent(page);
  await page.getByLabel(/I reviewed the exact target/).check();
  await page.getByRole("button", { name: "Confirm exact native recipient" }).click();
  await expect(page.getByRole("alert")).toContainText("outcome is uncertain");
  await page.getByRole("button", { name: "Retry same confirm" }).click();
  await expect(page.getByRole("heading", { name: "Current native recipient authority" })).toBeVisible();
  const recorded = await calls(page), confirmations = recorded.filter(call => call.path.endsWith("/confirm"));
  expect(confirmations).toHaveLength(2);
  expect(confirmations[1]?.body).toEqual(confirmations[0]?.body);
  expect(recorded.filter(call => call.path.endsWith("/session"))).toHaveLength(2);
});

test("a rejected issuance fetch freezes its exact request and retries without minting a new operation", async ({ page }) => {
  await render(page, "issue-network-rejection");
  await page.getByLabel("Exact portal target ID").fill(targetId);
  await page.getByLabel("Exact client record ID").fill("client:one");
  await page.getByLabel(/I verified this existing client record/).check();
  await page.getByRole("button", { name: "Issue native confirmation link" }).click();
  await expect(page.getByRole("alert")).toContainText("outcome is uncertain");
  await expect(page.getByLabel("Exact portal target ID")).toBeDisabled();
  await page.getByRole("button", { name: "Retry same native issuance" }).click();
  await expect(page.getByRole("alert")).toContainText("cannot be revealed again");
  const recorded = await calls(page), issues = recorded.filter(call => call.path.endsWith("/intents") && call.method === "POST");
  expect(issues).toHaveLength(2);
  expect(issues[1]?.body).toEqual(issues[0]?.body);
  expect(recorded.filter(call => call.path.endsWith("/session"))).toHaveLength(2);
});

test("a rejected confirmation fetch survives attempted reload and retries the identical operation", async ({ page }) => {
  await render(page, "confirm-network-rejection");
  await loadIntent(page);
  await page.getByLabel(/I reviewed the exact target/).check();
  await page.getByRole("button", { name: "Confirm exact native recipient" }).click();
  await expect(page.getByRole("alert")).toContainText("outcome is uncertain");
  await page.getByRole("button", { name: "Load exact intent" }).click();
  await expect(page.getByRole("alert")).toContainText("Resolve the uncertain confirm");
  await expect(page.getByRole("button", { name: "Retry same confirm" })).toBeVisible();
  await page.getByRole("button", { name: "Retry same confirm" }).click();
  await expect(page.getByRole("heading", { name: "Current native recipient authority" })).toBeVisible();
  const recorded = await calls(page), confirmations = recorded.filter(call => call.path.endsWith("/confirm"));
  expect(confirmations).toHaveLength(2);
  expect(confirmations[1]?.body).toEqual(confirmations[0]?.body);
  expect(recorded.filter(call => call.path.endsWith(`/intents/${intentId}`) && call.method === "GET")).toHaveLength(1);
  expect(recorded.filter(call => call.path.endsWith("/session"))).toHaveLength(2);
});

test("a reloaded transitional intent uses its owner-read recovery operation and never generates a replacement", async ({ page }) => {
  await render(page, "load-recovery");
  await loadIntent(page);
  await expect(page.getByRole("heading", { name: "Grant delivery pending" })).toBeVisible();
  await page.getByLabel(/I reviewed the exact target/).check();
  await page.getByRole("button", { name: "Recover exact pending delivery" }).click();
  await expect(page.getByRole("heading", { name: "Current native recipient authority" })).toBeVisible();
  const recovery = (await calls(page)).find(call => call.path.endsWith("/recover"));
  expect(recovery?.body).toEqual({ operationId: recoveryOperationId, expectedRevision: 3 });
});

test("revokes only the explicitly reviewed workspace target and reports pending cleanup honestly", async ({ page }) => {
  await render(page, "workspace-pending");
  await loadWorkspace(page);
  await page.getByLabel("Exact cleanup reason").fill("Retire exact staging workspace");
  await page.getByLabel(/I reviewed this exact target/).check();
  await page.getByRole("button", { name: "Revoke exact native workspace" }).click();
  await expect(page.getByText(/remote cleanup is still pending/)).toBeVisible();
  await expect(page.getByText("revoking", { exact: true })).toBeVisible();
  const recorded = await calls(page), revocations = recorded.filter(call => call.path.endsWith(`/workspaces/${targetId}/revoke`));
  expect(revocations).toHaveLength(1);
  expect(revocations[0]?.body).toMatchObject({ expectedOwnershipEpoch: 4, reason: "Retire exact staging workspace" });
  expect(recorded.some(call => call.path.includes("/intents/") && call.method === "POST")).toBe(false);
});

test("an uncertain workspace revoke refreshes CSRF and retries the identical frozen body", async ({ page }) => {
  await render(page, "workspace-network-rejection");
  await loadWorkspace(page);
  await page.getByLabel("Exact cleanup reason").fill("Retire exact staging workspace");
  await page.getByLabel(/I reviewed this exact target/).check();
  await page.getByRole("button", { name: "Revoke exact native workspace" }).click();
  await expect(page.getByRole("alert")).toContainText("outcome is uncertain");
  await expect(page.getByLabel("Exact native workspace target ID")).toBeDisabled();
  await page.getByRole("button", { name: "Load exact workspace" }).click();
  await expect(page.getByRole("alert")).toContainText("Resolve the uncertain workspace revoke");
  await page.getByRole("button", { name: "Retry same workspace revoke" }).click();
  await expect(page.getByText("revoked", { exact: true })).toBeVisible();
  const recorded = await calls(page), revocations = recorded.filter(call => call.path.endsWith(`/workspaces/${targetId}/revoke`));
  expect(revocations).toHaveLength(2);
  expect(revocations[1]?.body).toEqual(revocations[0]?.body);
  expect(recorded.filter(call => call.path.endsWith("/session"))).toHaveLength(2);
});

test("workspace recovery uses only the owner-read stored cleanup operation", async ({ page }) => {
  await render(page, "workspace-recovery");
  await loadWorkspace(page);
  await page.getByLabel(/I reviewed this exact target/).check();
  await page.getByRole("button", { name: "Recover stored workspace cleanup" }).click();
  await expect(page.getByText("revoked", { exact: true })).toBeVisible();
  const recorded = await calls(page), recovery = recorded.find(call => call.path.endsWith(`/workspaces/${targetId}/recover`));
  expect(recovery?.body).toEqual({ operationId: recoveryOperationId, expectedOwnershipEpoch: 5 });
  expect(recorded.some(call => call.path.endsWith(`/workspaces/${targetId}/revoke`))).toBe(false);
});

function reviewed(page: Page, term: string) {
  return page.locator(".onboarding-created dt", { hasText: term }).locator("xpath=following-sibling::dd");
}
async function fillIssue(page: Page) {
  await page.getByLabel("Exact portal target ID").fill(targetId);
  await page.getByLabel("Exact client record ID").fill("client:one");
  await page.getByLabel(/I verified this existing client record/).check();
}

test("submitting service requests is an explicit choice, sent as the exact permission set and shown as the server pinned it", async ({ page }) => {
  await render(page);
  await expect(page.locator(".eyebrow")).toHaveText("Client portal access");
  const allow = page.getByRole("checkbox", { name: /Submit service requests/ });
  await expect(allow).not.toBeChecked();
  await fillIssue(page);
  await allow.check();
  await page.getByRole("button", { name: "Issue native confirmation link" }).click();
  await expect(page.getByLabel("Native portal confirmation link")).toBeVisible();
  await expect(allow).toBeDisabled();
  await expect(reviewed(page, "Requested access")).toHaveText("View their service home and submit service requests");
  const issue = (await calls(page)).find(call => call.path.endsWith("/intents") && call.method === "POST");
  expect(issue?.body?.permissions).toEqual(["operations.request.create", "operations.service_home.read"]);
  expect(issue?.body).not.toHaveProperty("permissionSchemaVersion");
  await page.getByRole("button", { name: "Start new native intent" }).click();
  await expect(allow).not.toBeChecked();
});

test("a server that pins different access than requested is never shown as issued", async ({ page }) => {
  await render(page, "issue-mismatch");
  await fillIssue(page);
  await page.getByRole("checkbox", { name: /Submit service requests/ }).check();
  await page.getByRole("button", { name: "Issue native confirmation link" }).click();
  await expect(page.getByRole("alert")).toContainText("outcome is uncertain");
  await expect(page.getByLabel("Native portal confirmation link")).toHaveCount(0);
});

test("a client that can't take service requests yet is told so, and can still be issued home-only access", async ({ page }) => {
  await render(page, "issue-capability-unavailable");
  await fillIssue(page);
  const allow = page.getByRole("checkbox", { name: /Submit service requests/ });
  await allow.check();
  await page.getByRole("button", { name: "Issue native confirmation link" }).click();
  await expect(page.getByRole("alert")).toContainText("Submitting service requests isn't available for this client yet");
  await expect(allow).toBeEnabled();
  await allow.uncheck();
  await page.getByRole("button", { name: "Issue native confirmation link" }).click();
  await expect(page.getByLabel("Native portal confirmation link")).toBeVisible();
  await expect(reviewed(page, "Requested access")).toHaveText("View their service home");
});

test("confirming a recipient with service requests names that access, and shows it in effect only once it is", async ({ page }) => {
  await render(page, "requests-pending");
  await loadIntent(page);
  await expect(reviewed(page, "Requested access")).toHaveText("View their service home and submit service requests");
  await expect(reviewed(page, "Service requests")).toHaveText("Waiting to take effect");
  await expect(reviewed(page, "In effect now")).toHaveText("No access");
  await page.getByLabel(/including submitting service requests/).check();
  await page.getByRole("button", { name: "Confirm exact native recipient" }).click();
  await expect(page.getByRole("heading", { name: "Current native recipient authority" })).toBeVisible();
  await expect(reviewed(page, "Service requests")).toHaveText("On");
  await expect(reviewed(page, "In effect now")).toHaveText("View their service home and submit service requests");
  await expect(page.getByText(/revoke this access and issue a new link without service requests/)).toBeVisible();
});

test("while only the home grant has landed, service requests show as waiting and aren't in effect", async ({ page }) => {
  await render(page, "requests-partial");
  await loadIntent(page);
  await page.getByLabel(/including submitting service requests/).check();
  await page.getByRole("button", { name: "Confirm exact native recipient" }).click();
  await expect(page.getByRole("heading", { name: "Current native recipient authority" })).toBeVisible();
  await expect(reviewed(page, "Requested access")).toHaveText("View their service home and submit service requests");
  await expect(reviewed(page, "Service requests")).toHaveText("Waiting to take effect");
  await expect(reviewed(page, "In effect now")).toHaveText("View their service home");
});

test("an expired pending link shows its expiry, can't be confirmed, and can still be canceled", async ({ page }) => {
  await render(page, "expired");
  await loadIntent(page);
  await expect(page.getByRole("heading", { name: "Expired native confirmation" })).toBeVisible();
  await expect(reviewed(page, "Link expires")).toContainText("(expired)");
  await expect(reviewed(page, "Link expires").locator("time")).toHaveAttribute("datetime", "2020-01-01T00:00:00.000Z");
  await expect(page.getByText("This confirmation link expired, so it can’t be confirmed. Cancel it and issue a new link.")).toBeVisible();
  await page.getByLabel(/I reviewed the exact target/).check();
  await expect(page.getByRole("button", { name: "Confirm exact native recipient" })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel native confirmation" }).click();
  await expect(page.getByRole("heading", { name: "Canceled native enrollment" })).toBeVisible();
  await expect(page.getByText(/read-only audit state/)).toBeVisible();
  const recorded = await calls(page);
  expect(recorded.some(call => call.path.endsWith("/confirm"))).toBe(false);
  expect(recorded.filter(call => call.path.endsWith("/cancel"))).toHaveLength(1);
});

test("a refused confirmation explains existing access and the revoke-then-reissue path, and grants nothing", async ({ page }) => {
  await render(page, "confirm-denied");
  await loadIntent(page);
  await page.getByLabel(/I reviewed the exact target/).check();
  await page.getByRole("button", { name: "Confirm exact native recipient" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "couldn’t be confirmed" }))
    .toContainText("If they already have client portal access for this client, that access stays as it is: load their current intent, revoke it, then issue a new link");
  await expect(page.getByRole("heading", { name: "Review native recipient" })).toBeVisible();
  await expect(reviewed(page, "In effect now")).toHaveText("No access");
  expect((await calls(page)).filter(call => call.path.endsWith("/confirm"))).toHaveLength(1);
});

test("a current link shows its expiry without an expired state", async ({ page }) => {
  await render(page);
  await loadIntent(page);
  await expect(reviewed(page, "Link expires").locator("time")).toHaveAttribute("datetime", "2099-01-01T00:00:00.000Z");
  await expect(reviewed(page, "Link expires")).not.toContainText("expired");
  await expect(page.getByRole("heading", { name: "Review native recipient" })).toBeVisible();
});

test("home-only access is shown as such, with service requests not included", async ({ page }) => {
  await render(page);
  await loadIntent(page);
  await expect(reviewed(page, "Service requests")).toHaveText("Not included");
  await page.getByLabel(/I reviewed the exact target/).check();
  await page.getByRole("button", { name: "Confirm exact native recipient" }).click();
  await expect(reviewed(page, "In effect now")).toHaveText("View their service home");
  await expect(page.getByText(/issue a new link without service requests/)).toHaveCount(0);
});

for (const [mode, name] of [["access-missing", "isn't stated"], ["access-unknown", "isn't recognized"],
  ["access-overclaimed", "claims requests in effect before they're on"]] as const)
  test(`a recipient whose access ${name} stays listed but can't be confirmed`, async ({ page }) => {
    await render(page, mode);
    await loadIntent(page);
    await expect(reviewed(page, "Requested access")).toHaveText("Couldn’t be read");
    await expect(page.getByRole("alert")).toContainText("can’t be confirmed");
    await page.getByLabel(/I reviewed the exact target/).check();
    await expect(page.getByRole("button", { name: "Confirm exact native recipient" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Cancel native confirmation" })).toBeEnabled();
    expect((await calls(page)).filter(call => call.path.endsWith("/confirm"))).toHaveLength(0);
  });
