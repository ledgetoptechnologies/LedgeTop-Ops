import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const bundle = buildSync({ entryPoints: [fileURLToPath(new URL("./native-directory-binding-refresh-fixture.tsx",import.meta.url))],
  bundle:true,format:"iife",platform:"browser",write:false,outdir:"out",jsx:"automatic",
  nodePaths:[fileURLToPath(new URL("../../node_modules",import.meta.url))] });
const script=bundle.outputFiles.find(file=>file.path.endsWith(".js"))!.text;
const style=bundle.outputFiles.find(file=>file.path.endsWith(".css"))?.text ?? "";
const commandId="11111111-1111-4111-8111-111111111111";
const calls = (page: Page) => page.evaluate(() => (window as Window & { bindingCalls?: Array<{path:string;body:unknown}> }).bindingCalls ?? []);
async function render(page: Page, scenario="acknowledged") {
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>');
  await page.evaluate(value => { (window as Window & {bindingScenario?:string}).bindingScenario=value; },scenario);
  await page.addStyleTag({content:style}); await page.addScriptTag({content:script});
}
async function review(page: Page) {
  await page.getByRole("button",{name:"Review binding revision",exact:true}).click();
  await expect(page.getByRole("region",{name:"Reviewed binding revision"})).toBeVisible();
}
async function confirm(page: Page, retry=false) {
  await page.getByRole("button",{name:retry?"Retry same binding refresh":"Confirm binding revision refresh",exact:true}).click();
  await page.getByRole("dialog",{name:"Confirm action"}).getByRole("button",{name:"Confirm",exact:true}).click();
}

test("disabled capability exposes no refresh action or requests",async({page})=>{
  await render(page,"disabled");
  await expect(page.getByRole("button")).toHaveCount(0); expect(await calls(page)).toEqual([]);
});

test("review and cancelled confirmations never execute; the same frozen review remains usable",async({page})=>{
  await render(page); await review(page);
  expect(await calls(page)).toEqual([{path:"/api/client-hub/directory/binding-revisions/review",
    body:{recordId:"client-one",sourceId:"project-alpha:primary"}}]);
  const action=page.getByRole("button",{name:"Confirm binding revision refresh",exact:true});
  await action.click();
  await expect(page.getByRole("dialog").getByRole("button",{name:"Cancel",exact:true})).toBeFocused();
  await page.getByRole("dialog").getByRole("button",{name:"Cancel",exact:true}).click();
  await expect(action).toBeFocused();
  await expect(action).toBeEnabled(); expect(await calls(page)).toHaveLength(1);
  await action.click(); await page.getByRole("dialog").press("Escape");
  await expect(action).toBeFocused();
  await expect(action).toBeEnabled(); expect(await calls(page)).toHaveLength(1);
  await confirm(page); await expect(page.getByRole("status")).toContainText("acknowledged");
  expect((await calls(page))[1]).toEqual({path:"/api/client-hub/directory/binding-revisions/execute",body:{commandId,confirm:true}});
});

for(const scenario of ["network","uncertain","wrong-command","wrong-revision"]) {
  test(`${scenario} preserves the frozen command and retry sends identical bytes without another review`,async({page})=>{
    await render(page,scenario); await review(page); await confirm(page);
    await expect(page.getByRole("alert")).toContainText("outcome is uncertain");
    await expect(page.getByRole("button",{name:"Review binding revision",exact:true})).toHaveCount(0);
    await confirm(page,true); await expect(page.getByRole("status")).toContainText("acknowledged");
    const recorded=await calls(page); expect(recorded.filter(call=>call.path.endsWith("/review"))).toHaveLength(1);
    const writes=recorded.filter(call=>call.path.endsWith("/execute")); expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  });
}

for(const scenario of ["blocked","conflict"]) {
  test(`${scenario} releases only after an exact authoritative result`,async({page})=>{
    await render(page,scenario); await review(page); await confirm(page);
    await expect(page.getByRole("alert")).toContainText("review is stale");
    await expect(page.getByRole("button",{name:"Review binding revision",exact:true})).toBeEnabled();
    await expect(page.getByRole("button",{name:"Retry same binding refresh",exact:true})).toHaveCount(0);
  });
}

test("mismatched review identity cannot expose execute",async({page})=>{
  await render(page,"bad-review"); await page.getByRole("button",{name:"Review binding revision",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("review is unavailable");
  await expect(page.getByRole("button",{name:"Confirm binding revision refresh",exact:true})).toHaveCount(0);
  expect((await calls(page)).filter(call=>call.path.endsWith("/execute"))).toHaveLength(0);
});

test("unmounting the reviewed card cancels an open confirmation without execution",async({page})=>{
  await render(page); await review(page);
  await page.getByRole("button",{name:"Confirm binding revision refresh",exact:true}).click();
  await page.evaluate(()=> (window as Window & {unmountBinding?:()=>void}).unmountBinding?.());
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await calls(page)).filter(call=>call.path.endsWith("/execute"))).toHaveLength(0);
});

test("duplicate activation cannot reserve or dispatch a second command",async({page})=>{
  await render(page);
  await page.getByRole("button",{name:"Review binding revision",exact:true}).evaluate(button=>{
    (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click();
  });
  await expect(page.getByRole("region",{name:"Reviewed binding revision"})).toBeVisible();
  await page.getByRole("button",{name:"Confirm binding revision refresh",exact:true}).evaluate(button=>{
    (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click();
  });
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.getByRole("dialog").getByRole("button",{name:"Confirm",exact:true}).evaluate(button=>{
    (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click();
  });
  await expect(page.getByRole("status")).toContainText("acknowledged");
  expect((await calls(page)).filter(call=>call.path.endsWith("/review"))).toHaveLength(1);
  expect((await calls(page)).filter(call=>call.path.endsWith("/execute"))).toHaveLength(1);
});
