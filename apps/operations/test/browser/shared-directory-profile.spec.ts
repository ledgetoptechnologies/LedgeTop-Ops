import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import type { Call, Scenario } from "./shared-directory-profile-fixture";

const bundle = buildSync({ entryPoints: [fileURLToPath(new URL("./shared-directory-profile-fixture.tsx", import.meta.url))], bundle: true,
  format: "iife", platform: "browser", write: false, outdir: "out", jsx: "automatic",
  nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
const script = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text;
const styles = bundle.outputFiles.filter(file => file.path.endsWith(".css")).map(file => file.text).join("\n");
if (!script) throw new Error("Shared profile browser fixture did not compile.");
async function render(page: Page, scenario: Scenario) {
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>');
  await page.evaluate(value => { (window as Window & { sharedProfileScenario?: Scenario }).sharedProfileScenario = value; }, scenario);
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
}
async function calls(page: Page): Promise<Call[]> {
  return page.evaluate(() => (window as Window & { sharedProfileCalls?: Call[] }).sharedProfileCalls ?? []);
}
const mutations = (observed: Call[]) => observed.filter(call => call.method !== "GET");
async function reviewMerge(page: Page, scenario: Scenario) {
  await render(page, scenario);
  await page.getByRole("button", { name: "Merge with another PA profile" }).click();
  await expect(page.getByLabel("Profile to merge").locator("option")).toHaveCount(2);
  await page.getByLabel("Profile to merge").selectOption("record-two");
  const selectBounds = await page.getByLabel("Profile to merge").boundingBox();
  expect(selectBounds && selectBounds.x >= 0 && selectBounds.x + selectBounds.width <= page.viewportSize()!.width).toBeTruthy();
  await page.getByRole("button", { name: "Review merge", exact: true }).click();
}

for (const scenario of ["update-lost-response", "update-reload-failure"] as const) {
  test(`${scenario} retries the exact shared mutation and never writes a single source profile`, async ({ page }) => {
    await render(page, scenario);
    await expect(page.getByText("Updated in all connected PAs", { exact: true })).toBeVisible();
    await page.getByLabel("Organization name").fill("Reviewed Shared Organization");
    await page.getByRole("button", { name: "Save shared profile", exact: true }).click();
    await expect(page.getByRole("button", { name: "Retry same shared-profile update" })).toBeVisible();
    await expect(page.getByLabel("Organization name")).toBeDisabled();
    await page.getByRole("button", { name: "Retry same shared-profile update" }).click();
    await expect(page.getByText("Synchronizing with Project Alpha", { exact: true })).toBeVisible();
    await expect(page.getByText("Updated in all connected PAs", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save shared profile", exact: true })).toBeDisabled();
    const writes = mutations(await calls(page));
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]!.path).toBe("/api/client-hub/shared-profiles/shared-one");
    const parsed = JSON.parse(writes[0]!.body!);
    expect(parsed.mutationId).toBe(writes[0]!.mutationId);
    expect(parsed.expectedVersion).toBe(2);
    expect(parsed.expectedMembers).toEqual([{ recordId: "record-one", version: 4 }, { recordId: "record-two", version: 7 }]);
    expect(parsed.profile.name).toBe("Reviewed Shared Organization");
  });
}
for (const scenario of ["pending", "conflict", "readonly"] as const) {
  test(`${scenario} cannot submit or edit the shared revision`, async ({ page }) => {
    await render(page, scenario);
    await expect(page.getByLabel("Organization name")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save shared profile", exact: true })).toBeDisabled();
    await expect(page.getByText(scenario === "pending" ? "Synchronizing with Project Alpha" : scenario === "conflict" ? "Synchronization needs review" : "Updated in all connected PAs", { exact: true })).toBeVisible();
    expect(mutations(await calls(page))).toEqual([]);
  });
}
for (const scenario of ["protected", "stale"] as const) {
  test(`${scenario} shared read fails closed instead of exposing a single-record editor`, async ({ page }) => {
    await render(page, scenario);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh profile", exact: true })).toBeVisible();
    await expect(page.getByLabel("Organization name")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Save|Merge/ })).toHaveCount(0);
    expect((await calls(page)).some(call => call.path.startsWith("/api/client-hub/directory/"))).toBe(false);
    expect(mutations(await calls(page))).toEqual([]);
  });
}
test("merge requires explicit selection and reviews both PA destinations and profile fields before confirmation", async ({ page }) => {
  await reviewMerge(page, "merge");
  await expect(page.getByText("Both records will use the same organization profile across Ledge Top Drone Services PA and Ledge Top Technologies PA.")).toBeVisible();
  await expect(page.locator(".shared-profile-review")).toContainText("shared@example.test");
  await expect(page.locator(".shared-profile-review")).toContainText("100 Test Way");
  await expect(page.getByText("Documents, source histories, and existing access stay attached to their current PA records.")).toBeVisible();
  expect(mutations(await calls(page)).map(call => call.path)).toEqual(["/api/client-hub/shared-profiles/preview"]);
  await page.getByRole("button", { name: "Confirm shared profile", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Shared client profile", exact: true })).toBeVisible();
  expect(mutations(await calls(page)).map(call => call.path)).toEqual(["/api/client-hub/shared-profiles/preview", "/api/client-hub/shared-profiles/confirm"]);
});
for (const scenario of ["merge-denied", "merge-differences"] as const) {
  test(`${scenario} cannot confirm a reviewed merge`, async ({ page }) => {
    await reviewMerge(page, scenario);
    if (scenario === "merge-denied") await expect(page.getByRole("button", { name: "Confirm shared profile", exact: true })).toBeDisabled();
    else {
      await expect(page.getByRole("alert")).toContainText("generalEmail");
      await expect(page.getByRole("button", { name: "Confirm shared profile", exact: true })).toHaveCount(0);
    }
    expect(mutations(await calls(page)).map(call => call.path)).toEqual(["/api/client-hub/shared-profiles/preview"]);
  });
}
test("lost merge response retries the frozen confirmation without another preview or source PATCH", async ({ page }) => {
  await reviewMerge(page, "merge-lost-response");
  await page.getByRole("button", { name: "Confirm shared profile", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry same merge", exact: true })).toBeVisible();
  await expect(page.getByLabel("Profile to merge")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Review merge", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry same merge", exact: true }).click();
  await expect(page.getByText("The two records now use one shared profile.")).toBeVisible();
  const observed = mutations(await calls(page));
  expect(observed.filter(call => call.path.endsWith("/preview"))).toHaveLength(1);
  const confirms = observed.filter(call => call.path.endsWith("/confirm"));
  expect(confirms).toHaveLength(2); expect(confirms[1]).toEqual(confirms[0]);
  expect(JSON.parse(confirms[0]!.body!)).toEqual({ mutationId: confirms[0]!.mutationId, previewToken: "synthetic-reviewed-token" });
  expect(observed.some(call => call.method === "PATCH")).toBe(false);
});
test("a malformed merge profile fails closed without a confirmation or render crash", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await reviewMerge(page, "merge-malformed");
  await expect(page.getByRole("alert")).toContainText("could not be verified");
  await expect(page.getByRole("button", { name: "Confirm shared profile", exact: true })).toHaveCount(0);
  expect(mutations(await calls(page)).map(call => call.path)).toEqual(["/api/client-hub/shared-profiles/preview"]);
  expect(errors).toEqual([]);
});
for(const scenario of ['owner-positive','owner-lost-response'] as const)test(`${scenario} explicitly enables only the reviewed own-client portal permission`,async({page})=>{
  await render(page,scenario);
  await expect(page.getByRole('heading',{name:'Portal profile editing',exact:true})).toBeVisible();
  await expect(page.getByText('Synthetic Shared Client',{exact:true})).toBeVisible();
  expect(mutations(await calls(page))).toEqual([]);
  await page.getByRole('button',{name:'Enable portal profile editing',exact:true}).click();
  if(scenario==='owner-lost-response'){
    await expect(page.getByRole('button',{name:'Retry same portal permission',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Save shared profile',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'Retry same portal permission',exact:true}).click();
  }
  await expect(page.getByText('Profile editing enabled for verified sign-in.',{exact:true})).toBeVisible();
  const writes=mutations(await calls(page));expect(writes).toHaveLength(scenario==='owner-positive'?1:2);
  expect(writes.every(write=>write.path==='/api/client-hub/shared-profiles/portal-grants')).toBe(true);
  if(writes.length===2)expect(writes[1]).toEqual(writes[0]);
  const body=JSON.parse(writes[0]!.body!);expect(body.operationId).toBe(writes[0]!.mutationId);expect(body.id).not.toBe(body.operationId);
  expect(body).toMatchObject({recipientMode:'first_verified_identity',issuer:null,subject:null,targetType:'client',recordId:'record-one',principalPublicId:'principal-one',sourceId:'project-alpha:primary',expectedRevision:0,state:'active'});
});
test('an aliased candidate forwards its logical source with the exact portal correspondence pair',async({page})=>{
  await render(page,'owner-alias');
  await page.getByRole('button',{name:'Enable portal profile editing',exact:true}).click();
  await expect(page.getByText('Profile editing enabled for verified sign-in.',{exact:true})).toBeVisible();
  const writes=mutations(await calls(page));expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0]!.body!)).toMatchObject({sourceId:'project-alpha:staging',portalSourceId:'project-alpha:primary',
    correspondenceRevisionId:'11111111-2222-4333-8444-555555555555',expectedRevision:0,state:'active'});
});

test('a candidate with only half of the correspondence pair is rejected as unverifiable',async({page})=>{
  await render(page,'owner-half-pair');
  await expect(page.getByRole('button',{name:'Enable portal profile editing',exact:true})).toHaveCount(0);
  await expect(page.getByRole('alert')).toBeVisible();
  expect(mutations(await calls(page))).toEqual([]);
});

test('a suspended correspondence grant asks for review and offers no enable action',async({page})=>{
  await render(page,'owner-suspended');
  await expect(page.getByText(/Paused for review: the client workspace connection changed/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Enable portal profile editing',exact:true})).toHaveCount(0);
  expect(mutations(await calls(page))).toEqual([]);
});

for(const scenario of ['bootstrap-positive','bootstrap-lost-response'] as const)test(`${scenario} creates one reviewed client profile before presenting portal activation`,async({page})=>{
  await render(page,scenario);
  await expect(page.getByText('Merge a duplicate in the other PA first.',{exact:false})).toBeVisible();
  await expect(page.getByRole('button',{name:'Enable portal profile editing',exact:true})).toHaveCount(0);
  expect(mutations(await calls(page))).toEqual([]);
  await page.getByRole('button',{name:'Enable shared profile',exact:true}).click();
  if(scenario==='bootstrap-lost-response')await page.getByRole('button',{name:'Retry same profile setup',exact:true}).click();
  await expect(page.getByRole('button',{name:'Enable portal profile editing',exact:true})).toBeVisible();
  const writes=mutations(await calls(page));expect(writes).toHaveLength(scenario==='bootstrap-positive'?1:2);
  expect(writes.every(write=>write.path==='/api/client-hub/shared-profiles/bootstrap')).toBe(true);
  if(writes.length===2)expect(writes[1]).toEqual(writes[0]);
  expect(JSON.parse(writes[0]!.body!)).toEqual({recordId:'record-one',mutationId:writes[0]!.mutationId});
});
test('unavailable portal setup explains the account limitation instead of implying the client is not set up',async({page})=>{
  await render(page,'owner-setup-unavailable');
  await expect(page.getByRole('heading',{name:'Portal profile editing',exact:true})).toBeVisible();
  await expect(page.getByRole('status').filter({hasText:'Portal profile setup isn’t available from this account right now.'})).toBeVisible();
  await expect(page.getByText('No eligible own-client portal identity is available yet.',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Enable portal profile editing',exact:true})).toHaveCount(0);
  expect(mutations(await calls(page))).toEqual([]);
});
test('unavailable portal setup keeps listed identities read-only with the same explanation',async({page})=>{
  await render(page,'owner-setup-unavailable-listed');
  await expect(page.getByText('Synthetic Shared Client',{exact:true})).toBeVisible();
  await expect(page.getByRole('status').filter({hasText:'Portal profile setup isn’t available from this account right now.'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Enable portal profile editing',exact:true})).toBeDisabled();
  expect(mutations(await calls(page))).toEqual([]);
});
test('available portal setup with no eligible identity says so without an account warning',async({page})=>{
  await render(page,'owner-no-candidates');
  await expect(page.getByRole('heading',{name:'Portal profile editing',exact:true})).toBeVisible();
  await expect(page.getByText('No eligible own-client portal identity is available yet.',{exact:true})).toBeVisible();
  await expect(page.getByText('Portal profile setup isn’t available from this account right now.',{exact:false})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Enable portal profile editing',exact:true})).toHaveCount(0);
  expect(mutations(await calls(page))).toEqual([]);
});
