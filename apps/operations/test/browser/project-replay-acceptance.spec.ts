import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { isProjectReplayAcceptanceLocation } from "../../src/client/ProjectReplayAcceptanceRoute";
const PROJECT_COMMANDS_PATH = "/api/admin/project-alpha/projects/v2/commands";
type Mode = "normal" | "lost-create" | "stale-readback" | "form" | "wrong-scopes" | "non-admin" | "missing-csrf" | "wrong-directory" | "wrong-local";
type Call = { path: string; method: string; key: string | null; body: string | null; csrf: string | null;
  contentType: string | null; credentials: RequestCredentials | undefined };
const fixture = new URL("./project-replay-acceptance-fixture.tsx", import.meta.url);
const bundle = buildSync({ entryPoints: [fileURLToPath(fixture)], bundle: true, format: "iife", platform: "browser", write: false,
  outdir: "out", jsx: "automatic", nodePaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))] });
const script = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text;
if (!script) throw new Error("Project replay acceptance fixture did not compile.");
async function render(page: Page, mode: Mode = "normal") { await page.setContent('<div id="root"></div>');
  await page.evaluate(value => { (window as Window & { projectAcceptanceMode?: Mode }).projectAcceptanceMode = value; }, mode);
  await page.addScriptTag({ content: script }); }
const calls = (page: Page) => page.evaluate(() => (window as Window & { projectAcceptanceCalls?: Call[] }).projectAcceptanceCalls ?? []);
async function confirm(page: Page, stage: "create" | "update") {
  await page.getByLabel("Confirm exact external project ID").fill("synthetic-project-20261008");
  await page.getByLabel("Confirm displayed project name").fill("Synthetic Project Acceptance");
  await page.getByRole("button", { name: `Start reviewed ${stage}` }).click();
}
test("exact staging location predicate denies production and near-match paths", () => {
  const exact = { protocol: "https:", hostname: "ops-staging.ledgetopdroneservices.com", port: "", pathname: "/administration/staging/project-v2-replay-acceptance" };
  expect(isProjectReplayAcceptanceLocation(exact)).toBe(true);
  expect(isProjectReplayAcceptanceLocation({ ...exact, hostname: "ops.ledgetopdroneservices.com" })).toBe(false);
  expect(isProjectReplayAcceptanceLocation({ ...exact, pathname: "/administration/staging/project-v2" })).toBe(false);
});
test("create and update use frozen commands, deliberate replay, conflict, and refreshed server fences", async ({ page }) => {
  await render(page); await page.getByRole("button", { name: "Load create preparation" }).click(); await confirm(page, "create");
  for (let i=0;i<3;i+=1) await page.getByRole("button", { name: "Retry same frozen Project step" }).click();
  await confirm(page, "update"); for (let i=0;i<3;i+=1) await page.getByRole("button", { name: "Retry same frozen Project step" }).click();
  await expect(page.getByText(/Independent PA readback and live staging evidence are still required/)).toBeVisible();
  const commands=(await calls(page)).filter(call=>call.path===PROJECT_COMMANDS_PATH);
  expect(commands).toHaveLength(6); expect(commands[1]).toEqual(commands[0]); expect(commands[2]!.key).toBe(commands[0]!.key);
  expect(commands[2]!.body).not.toBe(commands[0]!.body); expect(commands[4]).toEqual(commands[3]);
  expect(commands[3]!.key).not.toBe(commands[0]!.key);
  const mutations=(await calls(page)).filter(call=>call.method==="POST");
  expect(mutations.every(call=>call.credentials==="same-origin"&&call.csrf==="fixture-csrf-token-value"
    &&call.contentType==="application/json")).toBe(true);
});
test("lost create response never allocates a replacement command", async ({ page }) => {
  await render(page,"lost-create"); await page.getByRole("button", { name: "Load create preparation" }).click(); await confirm(page,"create");
  for(let i=0;i<4;i+=1) await page.getByRole("button",{name:"Retry same frozen Project step"}).click();
  const commands=(await calls(page)).filter(call=>call.path===PROJECT_COMMANDS_PATH);
  expect(commands.slice(0,3).every(call=>call.key===commands[0]!.key&&call.body===commands[0]!.body)).toBe(true);
});
test("stale server readback fences stop before update", async ({ page }) => {
  await render(page,"stale-readback"); await page.getByRole("button", { name: "Load create preparation" }).click(); await confirm(page,"create");
  for(let i=0;i<3;i+=1) await page.getByRole("button",{name:"Retry same frozen Project step"}).click();
  await expect(page.getByRole("alert")).toContainText("current Project fences did not confirm");
  expect((await calls(page)).filter(call=>call.path===PROJECT_COMMANDS_PATH)).toHaveLength(3);
});
async function fillSelection(page:Page){
  await page.getByLabel("expectedApplicationId").fill("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  await page.getByLabel("externalProjectId").fill("ops/project-acceptance-browser");
  await page.getByLabel("organizationRecordId").fill("organization-one");
  await page.getByLabel("businessAreaId").fill("staging-native-only-portal-acceptance-20261008-window-1");
}
test("mounted form rejects blank selection without calls and freezes exact reviewed scope before preparation",async({page})=>{
  await render(page,"form"); await page.getByRole("button",{name:"Freeze reviewed synthetic selection"}).click();
  await expect(page.getByRole("alert")).toBeVisible(); expect(await calls(page)).toHaveLength(0);
  await fillSelection(page); await page.getByRole("button",{name:"Freeze reviewed synthetic selection"}).click();
  expect(await calls(page)).toHaveLength(0); await page.getByRole("button",{name:"Load create preparation"}).click();
  await expect(page.getByRole("button",{name:"Start reviewed create"})).toBeVisible();
  const observed=await calls(page); expect(observed.map(call=>call.path)).toEqual(["/api/session","/api/admin/staging/projects/v2/preparation"]);
  expect(observed.some(call=>call.path===PROJECT_COMMANDS_PATH)).toBe(false);
  expect(JSON.parse(observed[1]!.body!).scopes).toEqual([{scopeKind:"business_area",businessAreaId:"staging-native-only-portal-acceptance-20261008-window-1",divisionId:null}]);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
test("wrong returned scopes, non-admin sessions, and missing CSRF stop before Project commands",async({page})=>{
  for(const mode of ["wrong-scopes","non-admin","missing-csrf"] as const){await render(page,mode);await fillSelection(page);
    await page.getByRole("button",{name:"Freeze reviewed synthetic selection"}).click();await page.getByRole("button",{name:"Load create preparation"}).click();
    await expect(page.getByRole("alert")).toBeVisible();expect((await calls(page)).some(call=>call.path===PROJECT_COMMANDS_PATH)).toBe(false);
    await page.setContent('<div id="reset"></div>');}
});
test("mismatched create directory identity and nonzero create-local fences fail closed",async({page})=>{
  for(const mode of ["wrong-directory","wrong-local"] as const){await render(page,mode);
    await page.getByRole("button",{name:"Load create preparation"}).click();
    await expect(page.getByRole("alert")).toContainText("server-derived Project acceptance fences could not be verified");
    expect((await calls(page)).some(call=>call.path===PROJECT_COMMANDS_PATH)).toBe(false);
    await page.setContent('<div id="reset"></div>');}
});
