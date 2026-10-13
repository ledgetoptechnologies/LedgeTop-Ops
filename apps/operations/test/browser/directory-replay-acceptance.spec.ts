import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { isDirectoryReplayAcceptanceLocation } from "../../src/client/DirectoryReplayAcceptanceRoute";

type Mode = "normal" | "pending" | "denied" | "wrong-record" | "lost-write" | "lost-restore" | "lost-recovery" | "malformed-recovery" | "wrong-source" | "readback-mismatch" | "readback-unavailable" | "no-csrf" | "not-owner";
type Call = { path: string; method: string; key: string | null; body: string | null; csrf: string | null; contentType: string | null; credentials: RequestCredentials | undefined };
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
  expect(observed[0]?.path).toBe("/api/session");
  expect(observed.every(call => call.credentials === "same-origin")).toBe(true);
  expect(patches.every(call => call.csrf === "fixture-only-csrf" && call.contentType === "application/json")).toBe(true);
  expect(observed.filter(call => call.path !== "/api/admin/staging/directory/replay-destination-readback" && call.path !== "/api/session")
    .every(call => call.path === "/api/client-hub/directory/standalone-clients/614ed50f-8800-4ab3-aa69-009d8e5cefa9")).toBe(true);
  expect(observed.some(call => /create-admissions|relationship/.test(call.path))).toBe(false);
  expect(patches).toHaveLength(3); expect(patches[1]).toEqual(patches[0]);
  expect(patches[2]!.key).toBe(patches[0]!.key); expect(patches[2]!.body).not.toBe(patches[0]!.body);
});

test("refuses denied or invalid records without a write", async ({ page }) => {
  for (const mode of ["denied", "wrong-record", "no-csrf", "not-owner"] as const) {
    await render(page, mode); await page.getByRole("button", { name: "Load retained synthetic client" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    expect((await calls(page)).filter(call => call.method === "PATCH")).toHaveLength(0);
    if (mode === "no-csrf" || mode === "not-owner") expect((await calls(page)).map(call => call.path)).toEqual(["/api/session"]);
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  }
});

test("pending profile state blocks profile mutation but permits retained recovery", async ({ page }) => {
  await render(page, "pending"); await page.getByRole("button", { name: "Load retained synthetic client" }).click();
  await expect(page.getByText(/Profile replay is blocked/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Start reviewed acceptance" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Prepare retained create recovery" })).toBeVisible();
  expect((await calls(page)).filter(call => call.method === "PATCH")).toHaveLength(0);
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
  await page.getByRole("button", { name: "Verify independent Project Alpha destination" }).click();
  await page.getByRole("button", { name: "Prepare explicit fresh-key restore" }).click();
  for (let index = 0; index < 4; index += 1) await page.getByRole("button", { name: "Continue same frozen restore" }).click();
  await expect(page.getByText(/Original profile restored/)).toBeVisible();
  await page.getByRole("button", { name: "Verify independent Project Alpha destination" }).click();
  await expect(page.getByText(/destination readback verified for local version 6/)).toBeVisible();
  const observed = await calls(page), patches = observed.filter(call => call.method === "PATCH");
  const readbacks = observed.filter(call => call.path === "/api/admin/staging/directory/replay-destination-readback");
  expect(readbacks).toHaveLength(2);
  expect(readbacks.every(call => call.method === "POST" && call.csrf === "fixture-only-csrf"
    && call.credentials === "same-origin" && call.contentType === "application/json")).toBe(true);
  expect(patches[3]!.key).not.toBe(patches[0]!.key);
  expect(patches.slice(3, 6).every(call => call.key === patches[3]!.key && call.body === patches[3]!.body)).toBe(true);
});

for (const mode of ["readback-mismatch", "readback-unavailable"] as const) test(`${mode} keeps restore gated`, async ({ page }) => {
  await render(page, mode); await page.getByRole("button", { name: "Load retained synthetic client" }).click();
  await page.getByLabel("Confirm exact record ID").fill("614ed50f-8800-4ab3-aa69-009d8e5cefa9");
  await page.getByLabel("Confirm current name").fill("Synthetic Portal Acceptance 2026-10-08");
  for (const name of ["Start reviewed acceptance", "Retry same frozen step", "Retry same frozen step", "Retry same frozen step"])
    await page.getByRole("button", { name }).click();
  const restore = page.getByRole("button", { name: "Prepare explicit fresh-key restore" });
  await expect(restore).toBeDisabled();
  await page.getByRole("button", { name: "Verify independent Project Alpha destination" }).click();
  await expect(page.getByRole("alert")).toContainText("destination readback did not match");
  await expect(restore).toBeDisabled();
  expect((await calls(page)).filter(call => call.method === "PATCH")).toHaveLength(3);
});

test("create-generation recovery freezes the complete request and reports prepared as queued", async ({ page }) => {
  await render(page, "lost-recovery");
  await page.getByRole("button", { name: "Load retained synthetic client" }).click();
  await page.getByLabel("Predecessor command ID").fill("7dbf5685-91cf-494a-aa46-4d59c138d94e");
  await page.getByLabel("Source ID").fill("project-alpha:staging");
  await page.getByLabel("Recovery reason").fill("Recover retained staging fixture after verified generation conflict");
  await page.getByRole("button", { name: "Prepare retained create recovery" }).click();
  await expect(page.getByRole("alert")).toContainText("Retry retains the exact authorization, successor, and request bytes");
  await expect(page.getByLabel("Predecessor command ID")).toBeDisabled();
  await page.getByRole("button", { name: "Retry exact recovery request" }).click();
  await expect(page.getByRole("status")).toContainText("Queued is not acknowledged");
  const recovery = (await calls(page)).filter(call => call.path === "/api/client-hub/directory/create-generation-recovery");
  expect(recovery).toHaveLength(2); expect(recovery[1]).toEqual(recovery[0]);
  expect(recovery[0]).toMatchObject({ method: "POST", csrf: "fixture-only-csrf", contentType: "application/json", credentials: "same-origin" });
  const body = JSON.parse(recovery[0]!.body!);
  expect(recovery[0]!.key).toBe(body.authorizationId);
  expect(body).toEqual({ authorizationId: "22222222-2222-4222-8222-000000000001",
    predecessorCommandId: "7dbf5685-91cf-494a-aa46-4d59c138d94e",
    successorCommandId: "22222222-2222-4222-8222-000000000002", sourceId: "project-alpha:staging",
    reason: "Recover retained staging fixture after verified generation conflict" });
});

test("create-generation recovery validates deliberate administrator input before freezing", async ({ page }) => {
  await render(page); await page.getByRole("button", { name: "Load retained synthetic client" }).click();
  await page.getByLabel("Predecessor command ID").fill("not-a-command");
  await page.getByLabel("Source ID").fill("https://arbitrary.example/api");
  await page.getByRole("button", { name: "Prepare retained create recovery" }).click();
  await expect(page.getByRole("alert")).toContainText("exact retained predecessor command ID, staging source ID");
  expect((await calls(page)).filter(call => call.path === "/api/client-hub/directory/create-generation-recovery")).toHaveLength(0);
  await expect(page.getByLabel("Predecessor command ID")).toBeEnabled();
});

test("same-tick double submit creates only one frozen recovery request", async ({ page }) => {
  await render(page); await page.getByRole("button", { name: "Load retained synthetic client" }).click();
  await page.getByLabel("Predecessor command ID").fill("7dbf5685-91cf-494a-aa46-4d59c138d94e");
  await page.getByLabel("Recovery reason").fill("Recover the exact retained staging fixture");
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find(value => value.textContent === "Prepare retained create recovery") as HTMLButtonElement;
    button.click(); button.click();
  });
  await expect(page.getByRole("status")).toContainText("Queued is not acknowledged");
  expect((await calls(page)).filter(call => call.path === "/api/client-hub/directory/create-generation-recovery")).toHaveLength(1);
});

test("shared latch prevents a profile mutation racing a recovery request", async ({ page }) => {
  await render(page); await page.getByRole("button", { name: "Load retained synthetic client" }).click();
  await page.getByLabel("Confirm exact record ID").fill("614ed50f-8800-4ab3-aa69-009d8e5cefa9");
  await page.getByLabel("Confirm current name").fill("Synthetic Portal Acceptance 2026-10-08");
  await page.getByLabel("Predecessor command ID").fill("7dbf5685-91cf-494a-aa46-4d59c138d94e");
  await page.getByLabel("Recovery reason").fill("Recover the exact retained staging fixture");
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    (buttons.find(value => value.textContent === "Prepare retained create recovery") as HTMLButtonElement).click();
    (buttons.find(value => value.textContent === "Start reviewed acceptance") as HTMLButtonElement).click();
  });
  await expect(page.getByRole("status")).toContainText("Queued is not acknowledged");
  const observed = await calls(page);
  expect(observed.filter(call => call.path === "/api/client-hub/directory/create-generation-recovery")).toHaveLength(1);
  expect(observed.filter(call => call.method === "PATCH")).toHaveLength(0);
});

test("strict recovery response validation rejects malformed prepared payloads", async ({ page }) => {
  await render(page, "malformed-recovery"); await page.getByRole("button", { name: "Load retained synthetic client" }).click();
  await page.getByLabel("Predecessor command ID").fill("7dbf5685-91cf-494a-aa46-4d59c138d94e");
  await page.getByLabel("Recovery reason").fill("Recover the exact retained staging fixture");
  await page.getByRole("button", { name: "Prepare retained create recovery" }).click();
  await expect(page.getByRole("alert")).toContainText("recovery response could not be verified");
  await expect(page.getByRole("button", { name: "Retry exact recovery request" })).toBeVisible();
});
