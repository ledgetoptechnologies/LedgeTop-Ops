import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { isDirectoryReplayAcceptanceLocation } from "../../src/client/DirectoryReplayAcceptanceRoute";

type Mode = "normal" | "pending" | "denied" | "wrong-record" | "lost-write" | "lost-restore" | "wrong-source";
type Call = { path: string; method: string; key: string | null; body: string | null };
const fixture = new URL("./directory-replay-acceptance-fixture.tsx", import.meta.url);
const bundle = buildSync({ entryPoints: [fileURLToPath(fixture)], bundle: true, format: "iife", platform: "browser", write: false,
  outdir: "out", jsx: "automatic", nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
const script = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text;
if (!script) throw new Error("Directory replay acceptance fixture did not compile.");
async function render(page: Page, mode: Mode = "normal") {
  await page.setContent('<div id="root"></div>');
  await page.evaluate(value => { (window as Window & { directoryReplayMode?: Mode }).directoryReplayMode = value; }, mode);
  await page.addScriptTag({ content: script });
}
const calls = (page: Page) => page.evaluate(() => (window as Window & { directoryReplayCalls?: Call[] }).directoryReplayCalls ?? []);

test("uses only the retained standalone-client route and freezes replay/conflict bytes", async ({ page }) => {
  await render(page); await page.getByRole("button", { name: "Load retained synthetic client" }).click();
  await page.getByLabel("Confirm exact record ID").fill("614ed50f-8800-4ab3-aa69-009d8e5cefa9");
  await page.getByLabel("Confirm current name").fill("Synthetic Portal Acceptance 2026-10-08");
  await page.getByRole("button", { name: "Start reviewed acceptance" }).click();
  await page.getByRole("button", { name: "Retry same frozen step" }).click();
  await page.getByRole("button", { name: "Retry same frozen step" }).click();
  await page.getByRole("button", { name: "Retry same frozen step" }).click();
  await expect(page.getByText(/not independent Project Alpha readback proof/)).toBeVisible();
  const observed = await calls(page), patches = observed.filter(call => call.method === "PATCH");
  expect(observed.every(call => call.path === "/api/client-hub/directory/standalone-clients/614ed50f-8800-4ab3-aa69-009d8e5cefa9")).toBe(true);
  expect(observed.some(call => /create-admissions|relationship/.test(call.path))).toBe(false);
  expect(patches).toHaveLength(3); expect(patches[1]).toEqual(patches[0]);
  expect(patches[2]!.key).toBe(patches[0]!.key); expect(patches[2]!.body).not.toBe(patches[0]!.body);
});

test("refuses pending and denied records without a write", async ({ page }) => {
  for (const mode of ["pending", "denied", "wrong-record"] as const) {
    await render(page, mode); await page.getByRole("button", { name: "Load retained synthetic client" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    expect((await calls(page)).filter(call => call.method === "PATCH")).toHaveLength(0);
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  }
});

test("route predicate admits only the exact staging HTTPS location", () => {
  const exact = { protocol: "https:", hostname: "ops-staging.ledgetopdroneservices.com", port: "",
    pathname: "/administration/staging/directory-replay-acceptance" };
  expect(isDirectoryReplayAcceptanceLocation(exact)).toBe(true);
  expect(isDirectoryReplayAcceptanceLocation({ ...exact, hostname: "ops.ledgetopdroneservices.com" })).toBe(false);
  expect(isDirectoryReplayAcceptanceLocation({ ...exact, protocol: "http:" })).toBe(false);
  expect(isDirectoryReplayAcceptanceLocation({ ...exact, pathname: "/clients" })).toBe(false);
  expect(isDirectoryReplayAcceptanceLocation({ ...exact, port: "8443" })).toBe(false);
});

test("lost first-write response retries the same bytes then performs a deliberate replay", async ({ page }) => {
  await render(page, "lost-write"); await page.getByRole("button", { name: "Load retained synthetic client" }).click();
  await page.getByLabel("Confirm exact record ID").fill("614ed50f-8800-4ab3-aa69-009d8e5cefa9");
  await page.getByLabel("Confirm current name").fill("Synthetic Portal Acceptance 2026-10-08");
  await page.getByRole("button", { name: "Start reviewed acceptance" }).click();
  for (let index = 0; index < 4; index += 1) await page.getByRole("button", { name: "Retry same frozen step" }).click();
  await expect(page.getByText(/Passed local replay/)).toBeVisible();
  const patches = (await calls(page)).filter(call => call.method === "PATCH");
  expect(patches.slice(0, 3).every(call => call.key === patches[0]!.key && call.body === patches[0]!.body)).toBe(true);
});

test("rejects a destination outside the exact singleton staging source without rotating the attempt", async ({ page }) => {
  await render(page, "wrong-source"); await page.getByRole("button", { name: "Load retained synthetic client" }).click();
  await page.getByLabel("Confirm exact record ID").fill("614ed50f-8800-4ab3-aa69-009d8e5cefa9");
  await page.getByLabel("Confirm current name").fill("Synthetic Portal Acceptance 2026-10-08");
  await page.getByRole("button", { name: "Start reviewed acceptance" }).click();
  await expect(page.getByRole("alert")).toContainText("first write response could not be verified");
  await page.getByRole("button", { name: "Retry same frozen step" }).click();
  const patches = (await calls(page)).filter(call => call.method === "PATCH");
  expect(patches).toHaveLength(2); expect(patches[1]).toEqual(patches[0]);
});

test("restore survives a lost committed response with the same fresh key and exact replay", async ({ page }) => {
  await render(page, "lost-restore"); await page.getByRole("button", { name: "Load retained synthetic client" }).click();
  await page.getByLabel("Confirm exact record ID").fill("614ed50f-8800-4ab3-aa69-009d8e5cefa9");
  await page.getByLabel("Confirm current name").fill("Synthetic Portal Acceptance 2026-10-08");
  for (const name of ["Start reviewed acceptance", "Retry same frozen step", "Retry same frozen step", "Retry same frozen step"])
    await page.getByRole("button", { name }).click();
  await page.getByRole("button", { name: "Prepare explicit fresh-key restore" }).click();
  for (let index = 0; index < 4; index += 1) await page.getByRole("button", { name: "Continue same frozen restore" }).click();
  await expect(page.getByText(/Original profile restored/)).toBeVisible();
  const patches = (await calls(page)).filter(call => call.method === "PATCH");
  expect(patches[3]!.key).not.toBe(patches[0]!.key);
  expect(patches.slice(3, 6).every(call => call.key === patches[3]!.key && call.body === patches[3]!.body)).toBe(true);
});
