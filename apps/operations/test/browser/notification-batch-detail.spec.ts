import { expect, test, type Page, type Route } from "@playwright/test";

const base="/notifications",apiBase="/api/notifications/deliveries",at="2026-08-25T12:00:00Z";
function item(id="selected-batch",status="pending") {
  return {id,status,revision:7,accountName:"Same customer",folderLabel:"Selected delivery",recipientEmail:"exact-recipient@example.test",
    addedCount:40,removedCount:0,eligibleAt:"2026-08-25T12:05:00Z",createdAt:at,updatedAt:at,deliveredAt:status==="sent"?at:null,
    errorCode:null,canSendNow:status==="pending",canCancel:status==="pending"};
}
const detail=(status="pending",id="selected-batch")=>({item:item(id,status),serverNow:at,coverage:"legacy_folder_changes"});
const list=()=>({items:[],nextCursor:null,serverNow:at,coverage:"delivery_notifications_v2",availability:{folderChanges:true,nativeDeliveries:true}});
const center=(page:Page)=>page.getByRole("region",{name:"Delivery notification center"});
async function fixture(page:Page,handler:(route:Route,url:URL)=>Promise<unknown>){
  const calls:Array<{path:string;query:string;method:string}>=[];
  await page.route("**/api/**",route=>{
    const url=new URL(route.request().url());
    calls.push({path:url.pathname,query:url.search,method:route.request().method()});
    if(url.pathname==="/api/session")return route.fulfill({json:{user:{id:"auditor",email:"auditor@example.test",displayName:"Auditor",
      status:"Active",profileType:"Employee",isAdministrator:false,permissions:["delivery.share.audit"],divisions:[]},
      csrfToken:"test-only",timezone:"America/Chicago",mapStyleUrl:null,mapboxPublicToken:null,capabilities:{}}});
    return handler(route,url);
  });
  return calls;
}

test("exact notice opens one ID without scanning or sending, survives refresh, and returns to unfiltered queues",async({page})=>{
  const calls=await fixture(page,(route,url)=>route.fulfill({json:url.pathname===apiBase?list():detail()}));
  await page.goto(`${base}?batchId=selected-batch`);
  await expect(center(page).getByText("exact-recipient@example.test",{exact:true})).toBeVisible();
  await expect(center(page).getByRole("heading",{name:"Selected notification",exact:true})).toBeVisible();
  await expect(center(page).getByRole("textbox",{name:"Search notifications"})).toHaveCount(0);
  expect(calls.filter(call=>call.path.startsWith(apiBase))).toEqual([{path:`${apiBase}/selected-batch`,query:"",method:"GET"}]);
  await page.reload();
  await expect(center(page).getByText("exact-recipient@example.test",{exact:true})).toBeVisible();
  await center(page).getByRole("button",{name:"Pending",exact:true}).click();
  await expect(page).toHaveURL(new RegExp(`${base}$`));
  await expect(center(page).getByRole("textbox",{name:"Search notifications"})).toHaveValue("");
  await page.goBack();
  await expect(page).toHaveURL(/\?batchId=selected-batch$/);
  await expect(center(page).getByText("exact-recipient@example.test",{exact:true})).toBeVisible();
  await center(page).getByRole("button",{name:"History",exact:true}).click();
  await expect(page).toHaveURL(/\?view=history$/);
  expect(calls.every(call=>call.method==="GET")).toBe(true);
});

for(const status of ["sent","cancelled","suppressed","failed","processing"]){
  test(`notice that became ${status} still opens exact status without pending actions`,async({page})=>{
    const calls=await fixture(page,route=>route.fulfill({json:detail(status)}));
    await page.goto(`${base}?batchId=selected-batch`);
    await expect(center(page).getByText("exact-recipient@example.test",{exact:true})).toBeVisible();
    const label=status==="suppressed"?"Not sent":status[0]!.toUpperCase()+status.slice(1);
    await expect(center(page).getByText(label,{exact:true}).first()).toBeVisible();
    await expect(center(page).getByRole("button",{name:"Send now",exact:true})).toHaveCount(0);
    await expect(center(page).getByRole("button",{name:"Cancel notification",exact:true})).toHaveCount(0);
    if(status!=="processing")await expect(center(page).locator(".notification-countdown")).toHaveCount(0);
    expect(calls.every(call=>call.method==="GET")).toBe(true);
  });
}

for(const status of [403,404,409]){
  test(`selected notice clears details and actions when fresh lookup returns ${status}`,async({page})=>{
    let reads=0;
    await fixture(page,route=>route.fulfill(++reads===1?{json:detail()}:{status,json:{error:"Unavailable"}}));
    await page.goto(`${base}?batchId=selected-batch`);
    await expect(center(page).getByRole("button",{name:"Send now",exact:true})).toBeVisible();
    await center(page).getByRole("button",{name:"Refresh notifications",exact:true}).click();
    await expect(center(page).getByRole("alert")).toBeVisible();
    await expect(center(page).getByText("exact-recipient@example.test",{exact:true})).toHaveCount(0);
    await expect(center(page).getByRole("button",{name:"Send now",exact:true})).toHaveCount(0);
    await expect(center(page).getByRole("button",{name:"Cancel notification",exact:true})).toHaveCount(0);
  });
}

test("malformed duplicate IDs never fall back to an unfiltered queue request",async({page})=>{
  const calls=await fixture(page,route=>route.fulfill({json:list()}));
  await page.goto(`${base}?batchId=first&batchId=second`);
  await expect(center(page).getByRole("alert")).toContainText("notification link is invalid");
  expect(calls.filter(call=>call.path.startsWith(apiBase))).toHaveLength(0);
  await center(page).getByRole("button",{name:"Pending",exact:true}).click();
  await expect(page).toHaveURL(new RegExp(`${base}$`));
  await expect(center(page).getByText("No pending notifications found",{exact:true})).toBeVisible();
});

test("a delayed selected notice cannot replace the queue after navigation",async({page})=>{
  let delayed:Route|undefined;
  await fixture(page,(route,url)=>{
    if(url.pathname!==apiBase){delayed=route;return Promise.resolve();}
    return route.fulfill({json:list()});
  });
  await page.goto(`${base}?batchId=selected-batch`);
  await expect.poll(()=>Boolean(delayed)).toBe(true);
  await center(page).getByRole("button",{name:"History",exact:true}).click();
  await expect(center(page).getByText("No notification history found",{exact:true})).toBeVisible();
  try{await delayed!.fulfill({json:detail()});}catch{/* The selected request was aborted by navigation. */}
  await expect(center(page).getByText("exact-recipient@example.test",{exact:true})).toHaveCount(0);
  await expect(center(page).getByRole("heading",{name:"Selected notification",exact:true})).toHaveCount(0);
});

test("a mismatched exact DTO fails closed, while narrow selected details remain readable",async({page},testInfo)=>{
  let wrong=true;
  await fixture(page,route=>route.fulfill({json:detail("sent",wrong?"other-batch":"selected-batch")}));
  await page.goto(`${base}?batchId=selected-batch`);
  await expect(center(page).getByRole("alert")).toContainText("could not be verified");
  await expect(center(page).getByRole("article")).toHaveCount(0);
  wrong=false;
  await center(page).getByRole("button",{name:"Retry notifications"}).click();
  await expect(center(page).getByText("exact-recipient@example.test",{exact:true})).toBeVisible();
  for(const width of [375,1280]){
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.evaluate(async()=>{
      window.scrollTo({top:0,left:0,behavior:"instant"});
      await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
    });
    await expect.poll(()=>page.evaluate(()=>window.scrollY)).toBe(0);
    await page.screenshot({path:testInfo.outputPath(`selected-notification-${width}.png`),fullPage:true});
  }
});
