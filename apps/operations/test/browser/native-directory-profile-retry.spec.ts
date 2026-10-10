import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

type Scenario = "create-lost-response" | "admission-400" | "write-400" | "record-switch" | "reload-failure" | "relationship-readonly"
  | "recovery-review" | "recovery-absent" | "recovery-malformed";
type Call = { path: string; method: string; mutationId: string | null; body: string | null };
const fixture = new URL("./native-directory-profile-retry-fixture.tsx", import.meta.url);
const bundle = buildSync({ entryPoints: [fileURLToPath(fixture)], bundle: true, format: "iife", platform: "browser", write: false,
  outdir: "out", jsx: "automatic", nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
const script = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text;
if (!script) throw new Error("Native Directory profile retry browser fixture did not compile.");

async function render(page: Page, scenario: Scenario) {
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>');
  await page.evaluate(value => { (window as Window & { nativeDirectoryScenario?: Scenario }).nativeDirectoryScenario = value; }, scenario);
  await page.addScriptTag({ content: script });
}

async function calls(page: Page): Promise<Call[]> {
  return page.evaluate(() => (window as Window & { nativeDirectoryCalls?: Call[] }).nativeDirectoryCalls ?? []);
}

async function fillCreate(page: Page, name: string) {
  await page.getByLabel("Project Alpha destinations").selectOption("project-alpha:primary");
  await page.getByLabel("Business scope").selectOption({ label: "Area One" });
  await page.getByLabel("Organization name").fill(name);
}

test("a lost create response retries the same write without preparing admission again", async ({ page }) => {
  await render(page, "create-lost-response");
  await page.getByLabel("Profile type").selectOption("organization");
  await fillCreate(page, "Frozen Organization");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("button", { name: "Retry same profile creation" })).toBeVisible();
  await page.getByRole("button", { name: "Retry same profile creation" }).click();
  await expect(page.getByText("Saved in Client Hub and queued for Project Alpha delivery.")).toBeVisible();

  const observed = await calls(page), admissions = observed.filter(call => call.path.endsWith("/create-admissions"));
  const writes = observed.filter(call => call.path.endsWith("/organizations") && call.method === "POST");
  expect(admissions).toHaveLength(1);
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0]!.mutationId).toBeTruthy();
});

test("an admission-phase 400 releases the form and a corrected submit uses a fresh UUID", async ({ page }) => {
  await render(page, "admission-400");
  await fillCreate(page, "Invalid Organization");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByText("Review the form before submitting a new operation.")).toBeVisible();
  await expect(page.getByLabel("Organization name")).toBeEnabled();
  await expect(page.getByRole("button", { name: "Create organization" })).toBeVisible();

  await page.getByLabel("Organization name").fill("Corrected Organization");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByText("Saved in Client Hub and queued for Project Alpha delivery.")).toBeVisible();

  const observed = await calls(page), admissions = observed.filter(call => call.path.endsWith("/create-admissions"));
  const writes = observed.filter(call => call.path.endsWith("/organizations") && call.method === "POST");
  expect(admissions).toHaveLength(2);
  expect(writes).toHaveLength(1);
  expect(admissions[0]!.mutationId).not.toBe(admissions[1]!.mutationId);
  expect(writes[0]!.mutationId).toBe(admissions[1]!.mutationId);
  expect(admissions[1]!.body).toContain("Corrected Organization");
});

test("a write-phase 400 keeps the exact frozen write and does not rerun admission", async ({ page }) => {
  await render(page, "write-400");
  await fillCreate(page, "Frozen Write Organization");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("button", { name: "Retry same profile creation" })).toBeVisible();
  await expect(page.getByLabel("Organization name")).toBeDisabled();
  await page.getByRole("button", { name: "Retry same profile creation" }).click();
  await expect(page.getByText("Saved in Client Hub and queued for Project Alpha delivery.")).toBeVisible();

  const observed = await calls(page), admissions = observed.filter(call => call.path.endsWith("/create-admissions"));
  const writes = observed.filter(call => call.path.endsWith("/organizations") && call.method === "POST");
  expect(admissions).toHaveLength(1);
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0]!.mutationId).toBe(admissions[0]!.mutationId);
});

test("switching records never retries an old frozen request against the new display", async ({ page }) => {
  await render(page, "record-switch");
  await expect(page.getByLabel("Organization name")).toHaveValue("Record One");
  await page.getByLabel("Organization name").fill("Record One Updated");
  await page.getByRole("button", { name: "Save client profile" }).click();
  await expect(page.getByRole("button", { name: "Retry same profile update" })).toBeVisible();
  await page.getByRole("button", { name: "Switch to record two" }).click();
  await expect(page.getByLabel("Organization name")).toHaveValue("Record Two");
  await expect(page.getByRole("button", { name: "Retry same profile update" })).toHaveCount(0);
  const patches = (await calls(page)).filter(call => call.method === "PATCH");
  expect(patches.filter(call => call.path.endsWith("/record-two"))).toHaveLength(0);
  expect(patches).toHaveLength(1);
});

test("a verified save followed by reload failure cannot submit a fresh UUID from the stale snapshot", async ({ page }) => {
  await render(page, "reload-failure");
  await expect(page.getByLabel("Organization name")).toHaveValue("Record One");
  await page.getByLabel("Organization name").fill("Committed Name");
  await page.getByRole("button", { name: "Save client profile" }).click();
  await expect(page.getByText("Reload failed")).toBeVisible();

  const save = page.getByRole("button", { name: "Retry same profile update" });
  await expect(save).toBeEnabled();
  const before = (await calls(page)).filter(call => call.method === "PATCH");
  await save.click();
  await expect(page.getByText("Reload failed")).toBeVisible();
  const after = (await calls(page)).filter(call => call.method === "PATCH");
  expect(after).toEqual([before[0]!, before[0]!]);
  expect(new Set(after.map(call => call.mutationId)).size).toBe(1);
});

test("missing relationship authority leaves profile editing mounted but hides relationship mutation controls", async ({ page }) => {
  await render(page, "relationship-readonly");
  await expect(page.getByLabel("Client name")).toHaveValue("Client One");
  await expect(page.getByRole("button", { name: "Save client profile" })).toBeVisible();
  await expect(page.getByText("The organization relationship is read-only")).toBeVisible();
  await expect(page.getByLabel("Organization")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Assign client to organization|Move client to organization|Remove organization relationship/ })).toHaveCount(0);
  expect((await calls(page)).filter(call => call.method === "POST")).toHaveLength(0);
});

test("recovery controls remain absent when the server capability is absent or malformed", async ({ page }) => {
  for (const scenario of ["recovery-absent", "recovery-malformed"] as const) {
    await render(page, scenario);
    await expect(page.getByText("This client profile is read-only")).toBeVisible();
    await expect(page.getByRole("button", { name: "Review generation conflict" })).toHaveCount(0);
    await page.setContent('<div id="root"></div>');
  }
});

test("read-only recovery review compares sealed state and retries one frozen authorization without claiming acknowledgement", async ({ page }) => {
  await render(page, "recovery-review");
  await expect(page.getByText("This client profile is read-only")).toBeVisible();
  await page.getByLabel("Project Alpha destination").selectOption("project-alpha:secondary");
  await page.getByRole("button", { name: "Review generation conflict" }).click();
  await expect(page.getByText("Local intended organization:")).toContainText("Intended Organization");
  await expect(page.getByText("Current remote organization:")).toContainText("None");
  await expect(page.locator("dt", { hasText: "Client revision" }).locator("xpath=following-sibling::dd[1]")).toHaveText("7");
  await expect(page.locator("dt", { hasText: "Organization revision" }).locator("xpath=following-sibling::dd[1]")).toHaveText("9");
  await expect(page.locator("dt", { hasText: "Authorization generation" }).locator("xpath=following-sibling::dd[1]")).toHaveText("12");
  await expect(page.getByText(/does not mutate the local profile or organization relationship/)).toBeVisible();

  const authorize = page.getByRole("button", { name: "Authorize recovery" });
  await expect(authorize).toBeDisabled();
  await page.getByLabel("Reason").fill("Reviewed exact remote evidence");
  await expect(authorize).toBeDisabled();
  await page.getByLabel(/I confirm the local relationship/).check();
  await authorize.click();
  await expect(page.getByText("Synthetic reservation response loss")).toBeVisible();
  await page.getByRole("button", { name: "Retry same recovery reservation" }).click();
  await expect(page.getByText(/prepared and queued for delivery.*not a Project Alpha acknowledgement/i)).toBeVisible();

  const observed = await calls(page), reviewCalls = observed.filter(call => call.path.endsWith("/relationship-generation-recovery/reviews"));
  const authorizationCalls = observed.filter(call => call.path.endsWith("/authorize"));
  expect(reviewCalls).toHaveLength(1); expect(reviewCalls[0]!.body).toBe(JSON.stringify({ sourceId: "project-alpha:secondary" }));
  expect(authorizationCalls).toHaveLength(2); expect(authorizationCalls[1]).toEqual(authorizationCalls[0]);
  expect(authorizationCalls[0]!.mutationId).toBeTruthy();
  expect(JSON.parse(authorizationCalls[0]!.body!)).toMatchObject({ authorizationId: authorizationCalls[0]!.mutationId,
    evidenceSha256: "a".repeat(64), reason: "Reviewed exact remote evidence" });
});
