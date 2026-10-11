import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const component = fileURLToPath(new URL("../../src/client/OperationsNativeBillingAuthority.tsx", import.meta.url));
const resolveDir = fileURLToPath(new URL("../../src/client", import.meta.url));
const bundle = buildSync({ stdin: { contents: `import { createRoot } from "react-dom/client"; import "@ltds/ui/styles.css"; import "../../src/client/styles.css"; import { OperationsNativeBillingAuthority } from ${JSON.stringify(component)}; const root = document.getElementById("root"); if (root) createRoot(root).render(<OperationsNativeBillingAuthority />);`, resolveDir, sourcefile: "billing-fixture.tsx", loader: "tsx" }, bundle: true, format: "iife", platform: "browser", write: false, outdir: "out", jsx: "automatic", nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
const script = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text;
const stylesheet = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text;
if (!script || !stylesheet) throw new Error("Operations-native billing owner fixture did not compile.");
const route = "/billing-owner-fixture";
const targetId = "11111111-1111-4111-8111-111111111111", recipientBindingId = "22222222-2222-4222-8222-222222222222";
const grantId = "33333333-3333-4333-8333-333333333333", operationId = "44444444-4444-4444-8444-444444444444";
const csrfToken = `123.${"a".repeat(64)}`, fingerprint = "b".repeat(64);
const selectedEntity = { kind: "project", nativeId: "ops/project:billing" };
const reviewed = { targetId, recipientBindingId, entity: selectedEntity, expiresAt: null,
  expectedRevision: 0, reviewFingerprint: fingerprint, grantId: null };
const authority = { targetId, recipientBindingId, entity: selectedEntity, expiresAt: null,
  grantId, revision: 1, state: "active", live: true };
type Call = { path: string; method: string; body: Record<string, unknown> | null };

async function render(page: Page, mode = "normal") {
  await page.route(`**${route}`, request => request.fulfill({ contentType: "text/html",
    body: '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>' }));
  await page.goto(route);
  await page.evaluate(({ mode: selected, csrfToken, reviewed, authority, grantId, operationId }) => {
    const exposed = window as Window & { billingMode?: string; billingCalls?: Call[] };
    exposed.billingMode = selected;
    const calls: Call[] = []; exposed.billingCalls = calls;
    let grants = 0;
    window.fetch = async (input, init = {}) => {
      const path = String(input), method = init.method ?? "GET";
      const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
      calls.push({ path, method, body });
      if (path.endsWith("/session")) return selected === "session-denied"
        ? new Response("denied", { status: 403, headers: { "Content-Type": "text/plain" } })
        : Response.json({ csrfToken });
      if (path.endsWith("/review")) return Response.json({ review: reviewed });
      if (/\/grants\/[0-9a-f-]{36}$/u.test(path) && method === "GET")
        return Response.json({ authority: { ...authority, grantId: path.split("/").pop() } });
      if (path.endsWith("/grants") && method === "POST") {
        grants += 1;
        if (selected === "grant-network" && grants === 1) throw new TypeError("response lost");
        const finalAuthority = selected === "replayed-revoked"
          ? { ...authority, state: "revoked", live: false, revision: 2 } : authority;
        return Response.json({ status: grants > 1 ? "replayed" : "applied", operationId: body?.operationId ?? operationId,
          authority: { ...finalAuthority, grantId: body?.grantId ?? grantId } });
      }
      if (path.endsWith(`/grants/${grantId}/revoke`) && method === "POST")
        return Response.json({ status: "applied", operationId: body?.operationId ?? operationId,
          authority: { ...authority, state: "revoked", live: false, revision: 2 } });
      return Response.json({ error: "denied" }, { status: 403 });
    };
  }, { mode, csrfToken, reviewed, authority, grantId, operationId });
  await page.addStyleTag({ content: stylesheet }); await page.addScriptTag({ content: script });
  await expect(page.getByRole("heading", { name: mode === "session-denied"
    ? "Native billing authority unavailable" : "Operations-native billing authority" })).toBeVisible();
}
async function calls(page: Page) {
  return page.evaluate(() => (window as Window & { billingCalls?: Call[] }).billingCalls ?? []);
}
async function reviewExact(page: Page) {
  await page.getByLabel("Exact native portal target ID").fill(targetId);
  await page.getByLabel("Exact recipient binding ID").fill(recipientBindingId);
  await page.getByLabel("Entity kind").selectOption("project");
  await page.getByLabel("Exact native entity ID").fill(selectedEntity.nativeId);
  const reviewButton = page.getByRole("button", { name: "Review exact selection" });
  await reviewButton.scrollIntoViewIfNeeded(); await reviewButton.click();
  await expect(page.getByRole("heading", { name: "Reviewed selection" })).toBeVisible();
}

test("requires exact review and browser confirmation before an explicit grant", async ({ page }) => {
  await render(page);
  await expect(page.getByRole("button", { name: "Confirm exact billing grant" })).toHaveCount(0);
  await reviewExact(page);
  page.once("dialog", dialog => dialog.dismiss());
  const grantButton = page.getByRole("button", { name: "Confirm exact billing grant" });
  await grantButton.scrollIntoViewIfNeeded(); await grantButton.click();
  expect((await calls(page)).filter(call => call.path.endsWith("/grants") && call.method === "POST")).toHaveLength(0);
  page.once("dialog", dialog => dialog.accept());
  await grantButton.click();
  await expect(page.getByRole("status")).toContainText("operation was applied");
  const grant = (await calls(page)).find(call => call.path.endsWith("/grants") && call.method === "POST");
  expect(grant?.body).toMatchObject({ confirm: true, targetId, recipientBindingId, entity: selectedEntity,
    expectedRevision: 0, reviewFingerprint: fingerprint });
  expect(Object.keys(grant?.body ?? {}).sort()).toEqual(["confirm", "operationId", "grantId", "targetId",
    "recipientBindingId", "entity", "expiresAt", "expectedRevision", "reviewFingerprint"].sort());
  await expect(page.getByText("Ledger status is local authority state, not remote client acknowledgement.")).toBeVisible();
});

test("uncertain grant locks the reviewed input and retries only the identical frozen operation", async ({ page }) => {
  await render(page, "grant-network"); await reviewExact(page);
  page.once("dialog", dialog => dialog.accept());
  const grantButton = page.getByRole("button", { name: "Confirm exact billing grant" });
  await grantButton.scrollIntoViewIfNeeded();
  await grantButton.click();
  await expect(page.getByRole("alert")).toContainText("outcome is uncertain");
  await expect(page.getByLabel("Exact native portal target ID")).toBeDisabled();
  const firstGrant = (await calls(page)).find(call => call.path.endsWith("/grants") && call.method === "POST");
  const frozenGrantId = String(firstGrant?.body?.grantId);
  const statusButton = page.getByRole("button", { name: "Load frozen grant current status" });
  await statusButton.scrollIntoViewIfNeeded(); await statusButton.click();
  await expect(page.getByRole("heading", { name: "Current billing authority" })).toBeVisible();
  expect((await calls(page)).some(call => call.path.endsWith(`/grants/${frozenGrantId}`) && call.method === "GET")).toBe(true);
  page.once("dialog", dialog => dialog.accept());
  const retryButton = page.getByRole("button", { name: "Retry same frozen grant" });
  await retryButton.scrollIntoViewIfNeeded(); await retryButton.click();
  await expect(page.getByRole("status")).toContainText("operation was replayed");
  const requests = (await calls(page)).filter(call => call.path.endsWith("/grants") && call.method === "POST");
  expect(requests).toHaveLength(2); expect(requests[1]?.body).toEqual(requests[0]?.body);
  expect((await calls(page)).filter(call => call.path.endsWith("/session"))).toHaveLength(2);
});

test("reports replayed revoked state separately from live status on mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 }); await render(page, "replayed-revoked"); await reviewExact(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  page.once("dialog", dialog => dialog.accept());
  const grantButton = page.getByRole("button", { name: "Confirm exact billing grant" });
  await grantButton.scrollIntoViewIfNeeded(); await grantButton.click();
  await expect(page.getByRole("status")).toContainText("Current ledger state is revoked; live is no.");
  await expect(page.getByText("Ledger state", { exact: true }).locator("..")).toContainText("revoked");
  await expect(page.getByText("Live", { exact: true }).locator("..")).toContainText("No");
});

test("loads current status then uses explicit browser confirmation for exact revocation", async ({ page }) => {
  await render(page);
  await page.getByLabel("Exact billing grant ID").fill(grantId);
  const statusButton = page.getByRole("button", { name: "Load exact grant status" });
  await statusButton.scrollIntoViewIfNeeded(); await statusButton.click();
  await expect(page.getByRole("heading", { name: "Current billing authority" })).toBeVisible();
  page.once("dialog", dialog => dialog.accept());
  const revokeButton = page.getByRole("button", { name: "Confirm exact billing revocation" });
  await revokeButton.scrollIntoViewIfNeeded(); await revokeButton.click();
  await expect(page.getByRole("status")).toContainText("ledger state is revoked");
  const revoke = (await calls(page)).find(call => call.path.endsWith("/revoke"));
  expect(revoke?.body).toMatchObject({ confirm: true, operationId: expect.any(String), expectedRevision: 1 });
});

test("clears the mandatory review when any selected identity field changes", async ({ page }) => {
  await render(page); await reviewExact(page);
  await page.getByLabel("Exact native entity ID").fill("ops/project:changed");
  await expect(page.getByRole("heading", { name: "Reviewed selection" })).toHaveCount(0);
  expect((await calls(page)).filter(call => call.path.endsWith("/grants") && call.method === "POST")).toHaveLength(0);
});

test("shows explicit owner access denial without offering grant actions", async ({ page }) => {
  await render(page, "session-denied");
  await expect(page.getByRole("alert")).toContainText("unavailable or your access was denied");
  await expect(page.getByRole("button", { name: "Confirm exact billing grant" })).toHaveCount(0);
  expect((await calls(page)).filter(call => call.method === "POST")).toHaveLength(0);
});
