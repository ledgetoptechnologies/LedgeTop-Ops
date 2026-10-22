import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const fixture = new URL("./native-directory-profile-layout-fixture.tsx", import.meta.url);
const bundle = buildSync({ entryPoints: [fileURLToPath(fixture)], bundle: true, format: "iife", platform: "browser", write: false,
  outdir: "out", jsx: "automatic", loader: { ".svg": "dataurl", ".png": "dataurl", ".woff2": "dataurl" },
  nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
const script = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text;
const stylesheet = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text;
if (!script || !stylesheet) throw new Error("Native Directory client organization fixture did not compile.");
type Call = { path: string; method: string; mutationId: string | null; body: string | null };

async function open(page: Page, scenario: string) {
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>');
  await page.evaluate(value => { (window as Window & { nativeDirectoryScenario?: string }).nativeDirectoryScenario = value; }, scenario);
  await page.addStyleTag({ content: stylesheet });
  await page.addScriptTag({ content: script });
  await page.getByRole("button", { name: "Add client profile" }).click();
  const dialog = page.getByRole("dialog", { name: "Add client profile" });
  await expect(dialog).toBeVisible();
  return dialog;
}
const calls = (page: Page) => page.evaluate(() => (window as Window & { nativeDirectoryCalls?: Call[] }).nativeDirectoryCalls ?? []) as Promise<Call[]>;
const posts = async (page: Page, suffix: string) => (await calls(page)).filter(call => call.method === "POST" && call.path.endsWith(suffix))
  .map(call => ({ ...call, json: JSON.parse(call.body!) as Record<string, unknown> }));

test("a client is the default and the business scope follows the ticked businesses without a separate choice", async ({ page }) => {
  const dialog = await open(page, "two-destinations");
  await expect(dialog.getByLabel("Profile type")).toHaveValue("client");
  await expect(dialog.getByText("Business scope")).toHaveCount(0);
  await dialog.getByRole("checkbox", { name: "Ledge Top Drone Services" }).check();
  await dialog.getByRole("checkbox", { name: "Ledge Top Technologies" }).check();
  await dialog.getByLabel("Client name").fill("Jordan Field");
  await dialog.getByRole("button", { name: "Create client" }).click();
  await expect(dialog).toBeHidden();
  const [write] = await posts(page, "/standalone-clients");
  expect(write!.json.scopes).toEqual([{ businessAreaId: "area:one", divisionId: null }, { businessAreaId: "area:two", divisionId: null }]);
  expect(write!.json.relationship).toEqual({ organizationRecordId: null, expectedOrganizationVersion: null });
});

test("a new organization is created by name for the ticked businesses and linked to the new client", async ({ page }) => {
  const dialog = await open(page, "two-destinations");
  await dialog.getByRole("checkbox", { name: "Ledge Top Drone Services" }).check();
  await dialog.getByRole("searchbox", { name: "Organization" }).fill("Greenleaf Farms");
  await expect(dialog.getByText("No organization matches “Greenleaf Farms”")).toBeVisible();
  await dialog.getByRole("button", { name: "+ Create new organization" }).click();
  const panel = dialog.getByRole("group", { name: "Create new organization" });
  await expect(panel.getByLabel("Organization name")).toHaveValue("Greenleaf Farms");
  await expect(panel).toContainText("It's created for Ledge Top Drone Services");
  // The client can't be saved while the organization is still being set up.
  await expect(dialog.getByRole("button", { name: "Create client" })).toBeDisabled();
  await panel.getByRole("button", { name: "Create organization" }).click();
  await expect(panel).toHaveCount(0);
  await expect(dialog.locator(".client-directory-organization-chosen")).toContainText("Greenleaf Farms");
  const [organization] = await posts(page, "/organizations");
  expect(organization!.json).toMatchObject({ sourceIds: ["project-alpha:primary"], scopes: [{ businessAreaId: "area:one", divisionId: null }] });
  expect((organization!.json.profile as Record<string, string>).name).toBe("Greenleaf Farms");
  await dialog.getByLabel("Client name").fill("Jordan Field");
  await dialog.getByRole("button", { name: "Create client" }).click();
  await expect(dialog).toBeHidden();
  const [client] = await posts(page, "/standalone-clients");
  expect(client!.json.relationship).toEqual({ organizationRecordId: organization!.json.mutationId, expectedOrganizationVersion: 1 });
  expect(client!.json.sourceIds).toEqual(["project-alpha:primary"]);
});

test("an unconfirmed new organization retries the exact same request and keeps its businesses fixed", async ({ page }) => {
  const dialog = await open(page, "new-organization-lost");
  await dialog.getByRole("checkbox", { name: "Ledge Top Drone Services" }).check();
  await dialog.getByRole("button", { name: "+ Create new organization" }).click();
  const panel = dialog.getByRole("group", { name: "Create new organization" });
  await panel.getByLabel("Organization name").fill("Harbor Authority");
  await panel.getByRole("button", { name: "Create organization" }).click();
  await expect(panel.getByRole("alert")).toContainText("won't be created twice");
  await expect(panel.getByLabel("Organization name")).toBeDisabled();
  await expect(dialog.getByRole("checkbox", { name: "Ledge Top Technologies" })).toBeDisabled();
  await panel.getByRole("button", { name: "Retry same organization" }).click();
  await expect(dialog.locator(".client-directory-organization-chosen")).toContainText("Harbor Authority");
  const writes = await posts(page, "/organizations");
  expect(writes).toHaveLength(2);
  expect(writes[1]!.mutationId).toBe(writes[0]!.mutationId);
  expect(writes[1]!.body).toBe(writes[0]!.body);
});

test("a business without a matching Operations area can't be saved and says why", async ({ page }) => {
  const dialog = await open(page, "missing-area");
  await dialog.getByRole("checkbox", { name: "Ledge Top Technologies" }).check();
  await expect(dialog.getByRole("alert")).toContainText("You can't add client profiles for Ledge Top Technologies yet");
  await dialog.getByLabel("Client name").fill("Jordan Field");
  await expect(dialog.getByRole("button", { name: "Create client" })).toBeDisabled();
  expect(await posts(page, "/create-admissions")).toEqual([]);
});

test("the organization picker and new-organization panel fit a phone", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const dialog = await open(page, "two-destinations");
  await dialog.getByRole("checkbox", { name: "Ledge Top Drone Services" }).check();
  await dialog.getByRole("button", { name: "+ Create new organization" }).click();
  await expect(dialog.getByRole("group", { name: "Create new organization" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  void testInfo;
});
