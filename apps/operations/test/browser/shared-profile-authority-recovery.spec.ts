import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import type { Scenario, Call } from "./shared-profile-authority-recovery-fixture";
const bundle=buildSync({entryPoints:[fileURLToPath(new URL("./shared-profile-authority-recovery-fixture.tsx",import.meta.url))],bundle:true,
  format:"iife",platform:"browser",write:false,outdir:"out",jsx:"automatic",nodePaths:[fileURLToPath(new URL("../../node_modules",import.meta.url))]});
const script=bundle.outputFiles.find(file=>file.path.endsWith(".js"))?.text;
const styles=bundle.outputFiles.filter(file=>file.path.endsWith(".css")).map(file=>file.text).join("\n");
if(!script)throw new Error("Recovery browser fixture failed to compile");
async function render(page:Page,scenario:Scenario){
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>');
  await page.evaluate(value=>{(window as Window&{recoveryScenario?:Scenario}).recoveryScenario=value;},scenario);
  await page.addStyleTag({content:styles});await page.addScriptTag({content:script});
  await expect(page.getByRole("heading",{name:"Shared client profile",exact:true})).toBeVisible();
}
const calls=(page:Page):Promise<Call[]>=>page.evaluate(()=>(window as Window&{recoveryCalls?:Call[]}).recoveryCalls??[]);
const writes=(all:Call[])=>all.filter(call=>call.method!=="GET");
for(const scenario of ["pending","bulk"] as const)test(`${scenario} requires explicit owner review and submits only recovery`,async({page})=>{
  await render(page,scenario);
  await expect(page.getByText("Recovery does not replay access changes. Review current state and retry the intended change.")).toBeVisible();
  expect(writes(await calls(page))).toEqual([]);
  const button=page.getByRole("button",{name:"Recover blocked profile editing",exact:true});
  const bounds=await button.boundingBox();expect(bounds&&bounds.x>=0&&bounds.x+bounds.width<=page.viewportSize()!.width).toBeTruthy();
  await button.click();await expect(page.getByText("Recovery completed. Review current state and retry the intended change.")).toBeVisible();
  const observed=writes(await calls(page));expect(observed).toHaveLength(1);expect(observed[0]!.path).toBe("/api/client-hub/shared-profiles/authority-recovery");
  expect(JSON.parse(observed[0]!.body!)).toEqual({operationId:observed[0]!.operationId});
});
for(const scenario of ["clean","unavailable","old-route","malformed","nonowner"] as const)test(`${scenario} exposes no recovery action`,async({page})=>{
  await render(page,scenario);
  if(scenario!=="nonowner")await expect.poll(async()=>(await calls(page)).filter(call=>call.path.endsWith("/authority-recovery")).length).toBe(1);
  await expect(page.getByRole("heading",{name:"Profile editing recovery",exact:true})).toHaveCount(0);
  expect(writes(await calls(page))).toEqual([]);
  if(scenario==="nonowner")expect((await calls(page)).some(call=>call.path.endsWith("/authority-recovery"))).toBe(false);
});
for(const scenario of ["lost-response","pending-response","wrong-ack","incomplete-ack"] as const)test(`${scenario} preserves exact request and operation on retry`,async({page})=>{
  await render(page,scenario);await page.getByRole("button",{name:"Recover blocked profile editing",exact:true}).click();
  await expect(page.getByRole("alert")).toHaveText("Recovery could not be confirmed. Retry keeps the same recovery request.");
  await expect(page.getByText("Recovery completed. Review current state and retry the intended change.")).toHaveCount(0);
  await page.getByRole("button",{name:"Retry same profile editing recovery",exact:true}).click();
  await expect(page.getByText("Recovery completed. Review current state and retry the intended change.")).toBeVisible();
  const observed=writes(await calls(page));expect(observed).toHaveLength(2);expect(observed[1]).toEqual(observed[0]);
});
test("another owner resumes the existing recovery operation",async({page})=>{
  await render(page,"resume");await page.getByRole("button",{name:"Recover blocked profile editing",exact:true}).click();
  await expect(page.getByText("Recovery completed. Review current state and retry the intended change.")).toBeVisible();
  const observed=writes(await calls(page));expect(observed).toHaveLength(1);
  expect(observed[0]!.operationId).toBe("22222222-2222-4222-8222-222222222222");expect(JSON.parse(observed[0]!.body!)).toEqual({operationId:observed[0]!.operationId});
});
