import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const component = fileURLToPath(new URL("../../src/client/OperationsNativeBillingPermissions.tsx", import.meta.url));
const resolveDir = fileURLToPath(new URL("../../src/client", import.meta.url));
const bundle = buildSync({ stdin: { contents: `import { createRoot } from "react-dom/client"; import "@ltds/ui/styles.css"; import "../../src/client/styles.css"; import { OperationsNativeBillingPermissions } from ${JSON.stringify(component)}; const root = document.getElementById("root"); if (root) createRoot(root).render(<OperationsNativeBillingPermissions />);`, resolveDir, sourcefile: "billing-permissions-fixture.tsx", loader: "tsx" }, bundle: true, format: "iife", platform: "browser", write: false, outdir: "out", jsx: "automatic", nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
const script = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text;
const stylesheet = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text;
if (!script || !stylesheet) throw new Error("Operations-native billing permission fixture did not compile.");
const route = "/billing-permissions-owner-fixture";
const staffId = "staff:billing-manager", resourceId = "ops/project:alpha";
const grantId = "11111111-1111-4111-8111-111111111111";
const csrfToken = `123.${"a".repeat(64)}`;
const refreshedCsrfToken = `124.${"b".repeat(64)}`;
const permissions = [
  { grantId, effect: "allow", scopeKind: "resource", resourceId, revoked: false },
];
const currentReview = { staffId, resourceId, generation: 4, permissions };
type Call = { path: string; method: string; body: Record<string, unknown> | null; csrf: string | null };

async function render(page: Page, mode = "normal") {
  await page.route(`**${route}`, request => request.fulfill({ contentType: "text/html",
    body: '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>' }));
  await page.goto(route);
  await page.evaluate(({ mode: selected, csrfToken, refreshedCsrfToken, currentReview, grantId }) => {
    const exposed = window as Window & { billingPermissionMode?: string; billingPermissionCalls?: Call[] };
    exposed.billingPermissionMode = selected;
    const calls: Call[] = []; exposed.billingPermissionCalls = calls;
    let issues = 0, revokes = 0, sessions = 0;
    window.fetch = async (input, init = {}) => {
      const path = String(input), method = init.method ?? "GET";
      const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
      const csrf = new Headers(init.headers).get("X-CSRF-Token");
      calls.push({ path, method, body, csrf });
      if (path.endsWith("/session")) {
        sessions += 1;
        if (selected === "session-denied" || selected === "review-refresh-denied" && sessions === 2
          || (selected === "issue-refresh-denied" || selected === "revoke-refresh-denied") && sessions === 3)
          return new Response("denied", { status: 403, headers: { "Content-Type": "text/plain" } });
        if (selected === "review-refresh-pending" && sessions === 2)
          await new Promise(resolve => setTimeout(resolve, 100));
        return Response.json({ csrfToken: sessions === 1 ? csrfToken : refreshedCsrfToken });
      }
      if (path.endsWith("/review")) {
        if (csrf !== refreshedCsrfToken) return Response.json({ error: "denied" }, { status: 403 });
        return Response.json({ review: currentReview });
      }
      if (path.endsWith("/grants") && method === "POST") {
        issues += 1;
        if ((selected === "issue-network" || selected === "issue-refresh-denied") && issues === 1) throw new TypeError("lost response");
        return Response.json({ status: issues > 1 ? "replayed" : "applied", operationId: body?.operationId,
          grantId: body?.grantId, generation: Number(body?.expectedGeneration) + 1 });
      }
      if (path.endsWith(`/grants/${grantId}/revoke`) && method === "POST") {
        revokes += 1;
        if (selected === "revoke-refresh-denied" && revokes === 1) throw new TypeError("lost response");
        return Response.json({ status: revokes > 1 ? "replayed" : "applied", operationId: body?.operationId, grantId,
          generation: Number(body?.expectedGeneration) + 1 });
      }
      return Response.json({ error: "denied" }, { status: 403 });
    };
  }, { mode, csrfToken, refreshedCsrfToken, currentReview, grantId });
  await page.addStyleTag({ content: stylesheet }); await page.addScriptTag({ content: script });
  await expect(page.getByRole("heading", { name: mode === "session-denied"
    ? "Billing permission delegation unavailable" : "Operations-native billing permission delegation" })).toBeVisible();
}
async function calls(page: Page) {
  return page.evaluate(() => (window as Window & { billingPermissionCalls?: Call[] }).billingPermissionCalls ?? []);
}
async function reviewExact(page: Page) {
  await page.getByLabel("Exact native staff ID").fill(staffId);
  await page.getByLabel("Exact operations resource ID").fill(resourceId);
  await page.getByLabel("New resource permission effect").selectOption("deny");
  await page.getByRole("button", { name: "Review exact permission scope" }).click();
  await expect(page.getByRole("heading", { name: "Current active resource permissions" })).toBeVisible();
}

test("issues only an explicit reviewed resource grant and exposes no global permission identity", async ({ page }) => {
  await render(page); await reviewExact(page);
  const recordedReview = (await calls(page)).find(call => call.path.endsWith("/review"));
  expect(recordedReview?.csrf).toBe(refreshedCsrfToken);
  await expect(page.getByText("Global policy and revocation history are not exposed here.")).toBeVisible();
  await expect(page.getByRole("listitem")).toHaveCount(1);
  await expect(page.getByRole("listitem").first()).toContainText(`Resource ${resourceId}`);
  const issueButton = page.getByRole("button", { name: "Confirm exact resource grant" });
  await issueButton.click();
  await expect(page.getByRole("dialog", { name: "Confirm action" })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await calls(page)).filter(call => call.path.endsWith("/grants") && call.method === "POST")).toHaveLength(0);
  await issueButton.click();
  await expect(page.getByRole("dialog", { name: "Confirm action" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Permission applied at generation 5");
  const issue = (await calls(page)).find(call => call.path.endsWith("/grants") && call.method === "POST");
  expect(issue?.body).toMatchObject({ confirm: true, staffId, resourceId, effect: "deny", expectedGeneration: 4,
    operationId: expect.any(String), grantId: expect.any(String) });
  expect(Object.keys(issue?.body ?? {}).sort()).toEqual(["confirm", "operationId", "grantId", "expectedGeneration",
    "staffId", "effect", "resourceId"].sort());
});

test("uncertain issue freezes reviewed inputs and requires CSRF refresh before exact retry", async ({ page }) => {
  await render(page, "issue-network"); await reviewExact(page);
  await page.getByRole("button", { name: "Confirm exact resource grant" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm action" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("outcome is uncertain");
  await expect(page.getByLabel("Exact native staff ID")).toBeDisabled();
  await page.getByRole("button", { name: "Retry same frozen issue" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm action" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Permission replayed at generation 5");
  const recorded = await calls(page), issues = recorded.filter(call => call.path.endsWith("/grants") && call.method === "POST");
  expect(issues).toHaveLength(2); expect(issues[1]?.body).toEqual(issues[0]?.body);
  expect(recorded.filter(call => call.path.endsWith("/session"))).toHaveLength(3);
});

test("retry session denial preserves the uncertain issue until the exact operation is later replayed", async ({ page }) => {
  await render(page, "issue-refresh-denied"); await reviewExact(page);
  await page.getByRole("button", { name: "Confirm exact resource grant" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm action" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("outcome is uncertain");
  const first = (await calls(page)).find(call => call.path.endsWith("/grants") && call.method === "POST");
  await page.getByRole("button", { name: "Retry same frozen issue" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm action" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("original operation outcome is still unresolved");
  await expect(page.getByLabel("Exact native staff ID")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Retry same frozen issue" })).toBeVisible();
  await page.getByRole("button", { name: "Retry same frozen issue" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm action" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Permission replayed at generation 5");
  const issues = (await calls(page)).filter(call => call.path.endsWith("/grants") && call.method === "POST");
  expect(issues).toHaveLength(2); expect(issues[1]?.body).toEqual(first?.body);
  expect((await calls(page)).filter(call => call.path.endsWith("/session"))).toHaveLength(4);
});

test("revokes only the exact active resource grant with an in-page confirmation", async ({ page }) => {
  await render(page); await reviewExact(page);
  await page.getByRole("button", { name: "Revoke this resource grant" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm action" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Permission applied at generation 5");
  const revoke = (await calls(page)).find(call => call.path.endsWith(`/grants/${grantId}/revoke`));
  expect(revoke?.body).toMatchObject({ confirm: true, expectedGeneration: 4, operationId: expect.any(String) });
  expect(Object.keys(revoke?.body ?? {}).sort()).toEqual(["confirm", "operationId", "expectedGeneration"].sort());
});

test("retry session denial preserves the uncertain revoke until the exact operation is later replayed", async ({ page }) => {
  await render(page, "revoke-refresh-denied"); await reviewExact(page);
  await page.getByRole("button", { name: "Revoke this resource grant" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm action" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("outcome is uncertain");
  const first = (await calls(page)).find(call => call.path.endsWith("/revoke"));
  await page.getByRole("button", { name: "Retry same frozen revoke" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm action" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("original operation outcome is still unresolved");
  await expect(page.getByLabel("Exact native staff ID")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Retry same frozen revoke" })).toBeVisible();
  await page.getByRole("button", { name: "Retry same frozen revoke" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm action" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Permission replayed at generation 5");
  const revokes = (await calls(page)).filter(call => call.path.endsWith("/revoke"));
  expect(revokes).toHaveLength(2); expect(revokes[1]?.body).toEqual(first?.body);
  expect((await calls(page)).filter(call => call.path.endsWith("/session"))).toHaveLength(4);
});

test("refreshes an expired mount session before review and blocks review when refresh is denied", async ({ page }) => {
  await render(page); await reviewExact(page);
  const recorded = await calls(page);
  expect(recorded.filter(call => call.path.endsWith("/session"))).toHaveLength(2);
  expect(recorded.filter(call => call.path.endsWith("/review"))).toHaveLength(1);
  expect(recorded.find(call => call.path.endsWith("/review"))?.csrf).toBe(refreshedCsrfToken);

  await render(page, "review-refresh-denied");
  await page.getByLabel("Exact native staff ID").fill(staffId);
  await page.getByLabel("Exact operations resource ID").fill(resourceId);
  await page.getByRole("button", { name: "Review exact permission scope" }).click();
  await expect(page.getByRole("alert")).toContainText("authorization was denied");
  expect((await calls(page)).filter(call => call.path.endsWith("/review"))).toHaveLength(0);
});

test("pending session refresh prevents duplicate review submission", async ({ page }) => {
  await render(page, "review-refresh-pending");
  await page.getByLabel("Exact native staff ID").fill(staffId);
  await page.getByLabel("Exact operations resource ID").fill(resourceId);
  const button = page.getByRole("button", { name: "Review exact permission scope" });
  await button.dblclick();
  await expect(page.getByRole("heading", { name: "Current active resource permissions" })).toBeVisible();
  const recorded = await calls(page);
  expect(recorded.filter(call => call.path.endsWith("/session"))).toHaveLength(2);
  expect(recorded.filter(call => call.path.endsWith("/review"))).toHaveLength(1);
});

test("selection edits clear review and unavailable owner sessions expose no mutation controls", async ({ page }) => {
  await render(page); await reviewExact(page);
  await page.getByLabel("Exact operations resource ID").fill("ops/project:changed");
  await expect(page.getByRole("heading", { name: "Current scoped permissions" })).toHaveCount(0);
  expect((await calls(page)).filter(call => call.method === "POST" && call.path.endsWith("/grants"))).toHaveLength(0);
  await render(page, "session-denied");
  await expect(page.getByRole("alert")).toContainText("No delegated permission was changed");
  await expect(page.getByRole("button", { name: "Confirm exact resource grant" })).toHaveCount(0);
});

test("mobile review wraps opaque identifiers without horizontal page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 }); await render(page); await reviewExact(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
