import { expect, test, type Page, type Route } from "@playwright/test";
import type { ProjectFeedbackHistoryPage } from "@ltds/shared";
import type { BusinessProjectDetail } from "../../src/client/BusinessProjectWorkspace";

const clientPath="/clients/sources/project-alpha%3Aprimary/business/standalone/client-one";
const projectPath=`${clientPath}/projects/project-one`;
const projectApi="/api/client-hub/sources/project-alpha%3Aprimary/business/standalone/client-one/business-projects/project-one";
const historyApi=`${projectApi}/feedback-history`;
const root={sourceId:"project-alpha:primary",rootNamespace:"business",kind:"standalone_client",publicId:"client-one"} as const;
const sourceClientPath=(sourceId:string)=>`/clients/sources/${encodeURIComponent(sourceId)}/business/standalone/client-one`;
function project(sourceId:string=root.sourceId):BusinessProjectDetail{return {canonicalRoot:{...root,sourceId},client:{display_name:"Acme Construction",detail_path:sourceClientPath(sourceId)},
  contextVersion:"project-context",refreshedAt:"2026-08-25T12:00:00.000Z",project:{id:"project-one",name:"Church survey",status:"active",description:null,
    start_date:null,end_date:null,created_at:"2026-08-01T12:00:00.000Z",manager:null},linkedContact:null,
  feedbackHistoryAvailable:sourceId===root.sourceId,
  availability:{linkedContact:"not_projected",siteContacts:"not_projected",billingContacts:"not_projected",projectMemory:"not_projected"}};}
function item(index:number){const feedbackId=`feedback-${String(index).padStart(2,"0")}`,done=index%2===0;
  return {feedbackId,createdAt:`2026-08-${String(20-index).padStart(2,"0")}T12:00:00.000Z`,status:done?"done" as const:"new" as const,
    events:done?[{revision:1,action:"submitted" as const,occurredAt:`2026-08-${String(20-index).padStart(2,"0")}T12:00:00.000Z`},
      {revision:2,action:"completed" as const,occurredAt:`2026-08-${String(21-index).padStart(2,"0")}T12:00:00.000Z`}]
      :[{revision:1,action:"submitted" as const,occurredAt:`2026-08-${String(20-index).padStart(2,"0")}T12:00:00.000Z`}],
    detailPath:`/operations/feedback/${feedbackId}?status=all`};}
function page(items:ReturnType<typeof item>[],nextCursor:string|null):ProjectFeedbackHistoryPage{return {canonicalRoot:root,projectId:"project-one",
  contextVersion:"project-context",refreshedAt:"2026-08-25T12:00:00.000Z",asOf:"2026-08-25T12:00:00.000Z",coverage:"feedback_only",items,
  page:{available:true,reason:null,nextCursor,hasMore:Boolean(nextCursor),returned:items.length,limit:nextCursor==="cursor-a"?5:25}};}
async function fixture(pageObject:Page,handler:(route:Route,url:URL)=>Promise<unknown>,options:{sourceId?:string;feedbackEnabled?:boolean}={}){
  const calls:Array<{url:URL;method:string}>=[],sourceId=options.sourceId??root.sourceId;
  const selectedProjectApi=`/api/client-hub/sources/${encodeURIComponent(sourceId)}/business/standalone/client-one/business-projects/project-one`;
  await pageObject.route("**/api/**",route=>{const request=route.request(),url=new URL(request.url());calls.push({url,method:request.method()});
    if(url.pathname==="/api/session")return route.fulfill({json:{user:{id:"staff-one",email:"staff@example.test",displayName:"Staff",status:"Active",profileType:"Employee",
      isAdministrator:false,permissions:["team.view","projects.view"],divisions:[]},csrfToken:"test",timezone:"America/Chicago",mapStyleUrl:null,mapboxPublicToken:null,
      capabilities:{clientFeedback:{enabled:options.feedbackEnabled??true}}}});
    if(url.pathname===selectedProjectApi)return route.fulfill({json:project(sourceId)});
    return handler(route,url);
  });return calls;
}
const workspace=(pageObject:Page)=>pageObject.getByRole("region",{name:"Business project workspace",exact:true});
const history=(pageObject:Page)=>pageObject.getByRole("region",{name:"Project feedback history",exact:true});
async function open(pageObject:Page){await pageObject.goto(projectPath);await expect(workspace(pageObject).getByRole("heading",{name:"Church survey",exact:true})).toBeVisible();}

test("feedback history is lazy, pages 5 then 25, preserves an empty continuation and uses safe review links",async({page:pageObject})=>{
  let historyCalls=0;
  const calls=await fixture(pageObject,(route,url)=>{
    if(url.pathname===historyApi){historyCalls+=1;
      if(historyCalls===1)return route.fulfill({json:page([0,1,2,3,4].map(item),"cursor-a")});
      if(historyCalls===2)return route.fulfill({json:{...page([],"cursor-b"),page:{...page([],"cursor-b").page,limit:25}}});
      return route.fulfill({json:page([5,6].map(item),null)});
    }return route.fulfill({status:500,json:{error:"Unexpected API"}});
  });
  await open(pageObject);expect(calls.filter(call=>call.url.pathname===historyApi)).toHaveLength(0);
  const show=history(pageObject).getByRole("button",{name:"Show feedback history",exact:true});await show.focus();await pageObject.keyboard.press("Enter");
  await expect(history(pageObject).getByText("5 feedback records shown",{exact:true})).toBeVisible();
  expect(calls.find(call=>call.url.pathname===historyApi)?.url.searchParams.get("limit")).toBe("5");
  await expect(history(pageObject).getByText(/Private|message|note|actor/i)).toHaveCount(0);
  await expect(history(pageObject).getByRole("link",{name:/Open done feedback 1 submitted/i}).first()).toHaveAttribute("href","/operations/feedback/feedback-00?status=all");
  const more=history(pageObject).getByRole("button",{name:"Load more feedback history",exact:true});await more.focus();await pageObject.keyboard.press("Enter");
  await expect(history(pageObject).getByText("5 feedback records shown",{exact:true})).toBeVisible();await expect(more).toBeFocused();
  expect(calls.filter(call=>call.url.pathname===historyApi)[1]?.url.searchParams.get("limit")).toBe("25");
  await pageObject.keyboard.press("Enter");await expect(history(pageObject).getByText("7 feedback records shown",{exact:true})).toBeVisible();
  await expect(history(pageObject).getByRole("button",{name:"Feedback history loaded",exact:true})).toBeFocused();
  expect(calls.every(call=>call.method==="GET")).toBe(true);
});

test("authorization or context loss clears the protected project workspace",async({page:pageObject})=>{
  await fixture(pageObject,(route,url)=>url.pathname===historyApi?route.fulfill({status:409,json:{error:"Project feedback or access changed."}}):route.fulfill({status:500}));
  await open(pageObject);await history(pageObject).getByRole("button",{name:"Show feedback history",exact:true}).click();
  await expect(workspace(pageObject).getByRole("alert")).toContainText("Project feedback or access changed");
  await expect(pageObject.getByText("Church survey",{exact:true})).toHaveCount(0);
  await expect(pageObject.getByRole("button",{name:"Reload project workspace",exact:true})).toBeVisible();
});

test("a transient feedback failure stays isolated and retries without clearing project data",async({page:pageObject})=>{
  let attempts=0;await fixture(pageObject,(route,url)=>url.pathname===historyApi
    ?++attempts===1?route.fulfill({status:503,json:{error:"Feedback database upgrade is still running"}}):route.fulfill({json:page([0].map(item),null)})
    :route.fulfill({status:500}));
  await open(pageObject);await history(pageObject).getByRole("button",{name:"Show feedback history",exact:true}).click();
  await expect(history(pageObject).getByRole("alert")).toContainText("Feedback database upgrade is still running");
  await expect(workspace(pageObject).getByRole("heading",{name:"Church survey",exact:true})).toBeVisible();
  await history(pageObject).getByRole("button",{name:"Retry feedback history",exact:true}).click();
  await expect(history(pageObject).getByText("1 feedback record shown",{exact:true})).toBeVisible();
});

test("refresh keeps keyboard focus while the replacement page is pending",async({page:pageObject})=>{
  const refreshGate:{resolve:null|(()=>void)}={resolve:null};let attempts=0;
  await fixture(pageObject,async(route,url)=>{
    if(url.pathname!==historyApi)return route.fulfill({status:500});
    attempts+=1;if(attempts===1)return route.fulfill({json:page([0].map(item),null)});
    await new Promise<void>(resolve=>{refreshGate.resolve=resolve;});return route.fulfill({json:page([1].map(item),null)});
  });
  await open(pageObject);await history(pageObject).getByRole("button",{name:"Show feedback history",exact:true}).click();
  const refresh=history(pageObject).getByRole("button",{name:"Refresh feedback history",exact:true});
  await expect(refresh).toHaveAttribute("aria-disabled","false");await refresh.focus();await pageObject.keyboard.press("Enter");
  await expect(refresh).toBeFocused();await expect(refresh).toHaveAttribute("aria-disabled","true");
  refreshGate.resolve?.();await expect(history(pageObject).getByText("1 feedback record shown",{exact:true})).toBeVisible();
  await expect(refresh).toBeFocused();await expect(refresh).toHaveAttribute("aria-disabled","false");
});

test("malformed or private additive fields are rejected without rendering them",async({page:pageObject})=>{
  const unsafe={...item(0),message:"Private message must not render"};
  await fixture(pageObject,(route,url)=>url.pathname===historyApi?route.fulfill({json:page([unsafe] as ReturnType<typeof item>[],null)}):route.fulfill({status:500}));
  await open(pageObject);await history(pageObject).getByRole("button",{name:"Show feedback history",exact:true}).click();
  await expect(history(pageObject).getByRole("alert")).toContainText("could not be verified");
  await expect(pageObject.getByText("Private message must not render",{exact:true})).toHaveCount(0);
});

test("same-minute feedback links retain unique accessible names",async({page:pageObject})=>{
  const first=item(0),second={...item(1),createdAt:item(0).createdAt,
    events:item(1).events.map(event=>({...event,occurredAt:item(0).createdAt}))};
  await fixture(pageObject,(route,url)=>url.pathname===historyApi?route.fulfill({json:page([first,second],null)}):route.fulfill({status:500}));
  await open(pageObject);await history(pageObject).getByRole("button",{name:"Show feedback history",exact:true}).click();
  const names=await history(pageObject).getByRole("link").evaluateAll(links=>links.map(link=>link.getAttribute("aria-label")));
  expect(names).toHaveLength(2);expect(new Set(names).size).toBe(2);
});

test("a secondary project route does not render or probe primary-only feedback history",async({page:pageObject})=>{
  const calls=await fixture(pageObject,route=>route.fulfill({status:500}),{sourceId:"project-alpha:secondary"});
  await pageObject.goto(`${sourceClientPath("project-alpha:secondary")}/projects/project-one`);
  await expect(workspace(pageObject).getByRole("heading",{name:"Church survey",exact:true})).toBeVisible();
  await expect(pageObject.getByRole("region",{name:"Project feedback history",exact:true})).toHaveCount(0);
  expect(calls.some(call=>call.url.pathname.includes("feedback-history"))).toBe(false);
});

test("a disabled feedback capability does not render or probe the history on a valid primary project",async({page:pageObject})=>{
  const calls=await fixture(pageObject,route=>route.fulfill({status:500}),{feedbackEnabled:false});
  await open(pageObject);await expect(pageObject.getByRole("region",{name:"Project feedback history",exact:true})).toHaveCount(0);
  expect(calls.some(call=>call.url.pathname.includes("feedback-history"))).toBe(false);
});

test("feedback history remains readable and actionable at 375 and 1280 pixels",async({page:pageObject},testInfo)=>{
  await fixture(pageObject,(route,url)=>url.pathname===historyApi?route.fulfill({json:page([0,1,2].map(item),null)}):route.fulfill({status:500}));
  await open(pageObject);await history(pageObject).getByRole("button",{name:"Show feedback history",exact:true}).click();
  await expect(history(pageObject).getByText("3 feedback records shown",{exact:true})).toBeVisible();
  for(const width of [375,1280]){await pageObject.setViewportSize({width,height:960});
    await expect.poll(()=>pageObject.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    for(const action of await history(pageObject).getByRole("button").or(history(pageObject).getByRole("link")).all()){
      const box=await action.boundingBox();expect(box!.height).toBeGreaterThanOrEqual(44);expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(width+1);
    }
    await history(pageObject).scrollIntoViewIfNeeded();await pageObject.screenshot({path:testInfo.outputPath(`project-feedback-history-${width}.png`)});
  }
});
