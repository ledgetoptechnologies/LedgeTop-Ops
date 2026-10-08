import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

type Scenario = "create-lost-response" | "admission-400" | "write-400" | "record-switch" | "reload-failure";
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
