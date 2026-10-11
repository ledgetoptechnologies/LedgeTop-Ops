import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const component = fileURLToPath(new URL("../../src/client/OperationsDirectoryMaintenance.tsx", import.meta.url));
const resolveDir = fileURLToPath(new URL("../../src/client", import.meta.url));
const bundle = buildSync({ stdin: { contents: `import { createRoot } from "react-dom/client"; import "@ltds/ui/styles.css"; import "../../src/client/styles.css"; import { OperationsDirectoryMaintenance } from ${JSON.stringify(component)}; const root = document.getElementById("root"); if (root) createRoot(root).render(<OperationsDirectoryMaintenance />);`, resolveDir, sourcefile: "maintenance-fixture.tsx", loader: "tsx" },
  bundle: true, format: "iife", platform: "browser", write: false, outdir: "out", jsx: "automatic",
  nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
const script = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text;
const stylesheet = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text;
if (!script || !stylesheet) throw new Error("Directory maintenance fixture did not compile.");

const route = "/directory-maintenance-fixture";
const csrfToken = `123.${"a".repeat(64)}`;
const planSha256 = "b".repeat(64), independentBindingVerificationSha256 = "c".repeat(64);
const plan = { protocol: "native-directory-maintenance-authority", version: 1,
  target: { environment: "staging", accountLabel: "staging-account", workerLabel: "ledgetop-ops-staging", databaseLabel: "staging-database" },
  staffId: "staff-beau-koltz", grantId: "33333333-3333-4333-8333-333333333333", commandId: "11111111-1111-4111-8111-111111111111",
  operator: { staffId: "staff-beau-koltz", accessSubject: "private-access-subject" },
  approvalIssuer: { staffId: "staff-beau-koltz", accessSubject: "private-access-subject" },
  identityEvidence: { staffId: "staff-beau-koltz", accessSubject: "private-access-subject", verificationId: "verification-1",
    verifiedAt: "2026-10-11T00:00:00.000Z", expiresAt: "2026-10-11T01:00:00.000Z", issuer: "private-issuer" },
  snapshot: { staff: [{ email: "private@example.test" }], admission: [], profile: [], roles: [], grants: [], history: [], generation: [] } };
type Call = { path: string; method: string; body: Record<string, unknown> | null };

async function render(page: Page, mode = "normal") {
  await page.route(`**${route}`, request => request.fulfill({ contentType: "text/html",
    body: '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>' }));
  await page.goto(route);
  await page.evaluate(({ mode: selected, csrfToken, plan, planSha256, independentBindingVerificationSha256 }) => {
    const exposed = window as Window & { maintenanceCalls?: Call[] };
    const calls: Call[] = []; exposed.maintenanceCalls = calls;
    let executions = 0;
    window.fetch = async (input, init = {}) => {
      const path = String(input), method = init.method ?? "GET";
      const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
      calls.push({ path, method, body });
      if (path.endsWith("/session")) return selected === "session-denied"
        ? Response.json({ error: "denied" }, { status: 403 })
        : Response.json({ csrfToken, staffId: "staff-beau-koltz", verifiedUntil: "2026-10-11T23:00:00.000Z" });
      if (path.endsWith("/review")) return Response.json({ plan, planSha256, independentBindingVerificationSha256 });
      if (path.endsWith("/execute")) {
        executions += 1;
        if (selected === "lost-response" && executions === 1) throw new TypeError("response lost");
        return Response.json({ status: executions > 1 ? "replayed" : "applied", commandId: body?.commandId,
          approvalId: body?.approvalId, grantId: "33333333-3333-4333-8333-333333333333", resultingGeneration: 2 });
      }
      return Response.json({ error: "denied" }, { status: 403 });
    };
  }, { mode, csrfToken, plan, planSha256, independentBindingVerificationSha256 });
  await page.addStyleTag({ content: stylesheet }); await page.addScriptTag({ content: script });
  await expect(page.getByRole("heading", { name: mode === "session-denied"
    ? "Directory maintenance unavailable" : "Staging directory maintenance authority" })).toBeVisible();
}
const calls = (page: Page) => page.evaluate(() => (window as Window & { maintenanceCalls?: Call[] }).maintenanceCalls ?? []);

test("review is redacted, private export is explicit, and execution requires confirmation", async ({ page }) => {
  await render(page);
  expect(await page.locator("body").textContent()).not.toContain("private@example.test");
  await page.getByRole("button", { name: "Review server-derived plan" }).click();
  await expect(page.getByRole("heading", { name: "Redacted review summary" })).toBeVisible();
  expect(await page.locator("body").textContent()).not.toContain("private-access-subject");
  expect(await page.locator("body").textContent()).not.toContain("private@example.test");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download private plan JSON" }).click();
  expect((await download).suggestedFilename()).toContain(".private.json");
  await page.getByLabel("Exact preinstalled approval ID").fill("not-a-v4-uuid");
  await page.getByRole("button", { name: "Confirm exact approved execution" }).click();
  await expect(page.getByRole("alert")).toContainText("exact preinstalled approval ID");
  expect((await calls(page)).filter(call => call.path.endsWith("/execute"))).toHaveLength(0);
  await page.getByLabel("Exact preinstalled approval ID").fill("22222222-2222-4222-8222-222222222222");
  await page.getByRole("button", { name: "Confirm exact approved execution" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm action" })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await calls(page)).filter(call => call.path.endsWith("/execute"))).toHaveLength(0);
  await page.getByRole("button", { name: "Confirm exact approved execution" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm action" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("status").first()).toContainText("Applied");
  const execute = (await calls(page)).find(call => call.path.endsWith("/execute"));
  expect(execute?.body).toEqual({ approvalId: "22222222-2222-4222-8222-222222222222", commandId: "11111111-1111-4111-8111-111111111111",
    planSha256, confirm: true });
  expect((await calls(page)).find(call => call.path.endsWith("/review"))?.body).toEqual({});
});

test("uncertain execution freezes identity and retries exactly the same body", async ({ page }) => {
  await render(page, "lost-response");
  await page.getByRole("button", { name: "Review server-derived plan" }).click();
  await page.getByLabel("Exact preinstalled approval ID").fill("22222222-2222-4222-8222-222222222222");
  await page.getByRole("button", { name: "Confirm exact approved execution" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm action" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Outcome uncertain");
  await expect(page.getByLabel("Exact preinstalled approval ID")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Review server-derived plan" })).toBeDisabled();
  await page.getByRole("button", { name: "Retry exact frozen command" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm action" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("status").first()).toContainText("Replayed");
  const executions = (await calls(page)).filter(call => call.path.endsWith("/execute"));
  expect(executions).toHaveLength(2);
  expect(executions[1]?.body).toEqual(executions[0]?.body);
});

test("session denial reveals no private plan or execute action", async ({ page }) => {
  await render(page, "session-denied");
  await expect(page.getByRole("button", { name: "Review server-derived plan" })).toHaveCount(0);
  expect((await calls(page)).filter(call => call.method === "POST")).toHaveLength(0);
});
