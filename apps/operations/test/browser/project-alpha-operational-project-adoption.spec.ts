import { expect,test,type Page } from "@playwright/test";

const sourceId="project-alpha:primary",path=`/clients/sources/${encodeURIComponent(sourceId)}/business/organizations/42`;
const base=`/api/client-hub/sources/${encodeURIComponent(sourceId)}/business/organizations/42`,adoption=`${base}/project-adoption`;
const publicId="a".repeat(32),reviewId="10000000-0000-4000-8000-000000000001";
const reservationId="20000000-0000-4000-8000-000000000002",commandId="30000000-0000-4000-8000-000000000003";
function detail(enabled=true){return{client:{workspace_id:null,public_id:"42",kind:"organization",route_kind:"organizations",source_id:sourceId,
  root_namespace:"business",pa_public_id:"b".repeat(32),detail_path:path,display_name:"Acme",status:"active",portal_status:"mapping_unavailable",
  account_count:0,project_count:0,request_count:0,contact_count:0},contextVersion:"context-one",contacts:[],accounts:[],projects:[],requests:[],
  deliveryGrants:[],authenticatedDeliveryGrants:[],viewerGrants:[],businessProjects:[],pages:{businessProjects:{available:true,reason:null,hasMore:false,nextCursor:null,limit:5,returned:0}},
  projectAdoptionAvailable:enabled,capabilities:{directory:true,requests:false,delivery:false,viewer:false}};}
async function fixture(page:Page,enabled=true){
  const calls:Array<{path:string;headers:Record<string,string>;body:unknown}>=[];let reviewAttempts=0,finalizeAttempts=0;
  await page.route("**/api/**",async route=>{const request=route.request(),url=new URL(request.url());
    if(url.pathname==="/api/session")return route.fulfill({json:{user:{id:"owner",email:"owner@example.test",displayName:"Owner",status:"Active",profileType:"Administrator",isAdministrator:true,permissions:["team.view","integrations.manage"],divisions:[]},csrfToken:"csrf",timezone:"America/Chicago",mapStyleUrl:null,mapboxPublicToken:null,capabilities:{}}});
    if(url.pathname===base)return route.fulfill({json:detail(enabled)});
    if(url.pathname===`${adoption}/candidates`)return route.fulfill({json:{contextVersion:"context-one",outcome:{status:"observed",authorizationGeneration:"7",projects:[{publicId,revision:"4",projectionSha256:"c".repeat(64),name:"PA Project",status:"active",archived:false,organizationPublicId:"b".repeat(32),clientPublicId:null}],nextCursor:null}}});
    if(url.pathname.startsWith(adoption)){calls.push({path:url.pathname,headers:request.headers(),body:request.postDataJSON()});
      if(url.pathname===`${adoption}/review`){reviewAttempts+=1;return route.fulfill(reviewAttempts===1?{status:503,json:{error:"review uncertain"}}:{json:{outcome:{status:"reviewed",reviewItemId:reviewId,requestSha256:"d".repeat(64),replayed:true}}});}
      if(url.pathname===`${adoption}/reserve`)return route.fulfill({json:{status:"reserved",reservationId,reviewItemId:reviewId,idempotencyKey:calls.at(-1)!.headers["idempotency-key"],replayed:false}});
      if(url.pathname===`${adoption}/bind`)return route.fulfill({json:{status:"planned",reservationId,commandId,bridgeId:"40000000-0000-4000-8000-000000000004",requestSha256:"e".repeat(64),replayed:false}});
      if(url.pathname===`${adoption}/finalize`){finalizeAttempts+=1;return route.fulfill({json:finalizeAttempts===1?{stage:"dispatch",outcome:{status:"uncertain",reason:"lost_ack"}}:{stage:"activate",outcome:{status:"activated",activationId:"50000000-0000-4000-8000-000000000005",replayed:true}}});}
    }
    return route.fulfill({status:503,json:{error:"fixture endpoint unavailable"}});
  });return calls;
}

test("customer project list completes exact PA-first adoption with frozen uncertain retries and no access action",async({page})=>{
  const calls=await fixture(page),dialogs:string[]=[];page.on("dialog",async dialog=>{dialogs.push(dialog.message());await dialog.accept();});
  await page.goto(path);const panel=page.getByRole("region",{name:"Adopt a Project Alpha project for this customer"});
  await expect(panel).toBeVisible();await panel.getByRole("button",{name:"Find unbound Projects for this customer"}).click();
  await panel.getByLabel(/PA Project/).check();await panel.getByLabel("New, unused Operations Project ID").fill("new-ops-project");
  await panel.getByRole("button",{name:"Create review evidence"}).click();await expect(panel.getByRole("alert")).toContainText("review uncertain");
  await panel.getByRole("button",{name:"Retry frozen review request"}).click();
  const reviews=calls.filter(call=>call.path.endsWith("/review"));expect(reviews).toHaveLength(2);
  expect(reviews[1]).toEqual(reviews[0]);expect(reviews[0]!.body).toEqual({expectedContextVersion:"context-one",externalProjectId:"new-ops-project",projectAlphaPublicId:publicId});
  await panel.getByRole("button",{name:"Reserve reviewed intent"}).click();await panel.getByRole("button",{name:"Create Project and queue bind command"}).click();
  await panel.getByRole("button",{name:"Finalize and verify Project binding"}).click();await expect(panel.getByRole("alert")).toContainText("Do not create a replacement command");
  await panel.getByRole("button",{name:"Resume verification of the same bind command"}).click();
  await expect(panel.getByRole("status")).toContainText("mapping activated");await expect(panel.getByRole("status")).toContainText("Client access and public links remain unchanged");
  const finals=calls.filter(call=>call.path.endsWith("/finalize"));expect(finals).toHaveLength(2);expect(finals[1]).toEqual(finals[0]);
  expect(calls.every(call=>call.headers["x-csrf-token"]==="csrf")).toBe(true);
  expect(calls.some(call=>/access|portal|link/.test(call.path))).toBe(false);
  expect(dialogs.join(" ")).toContain("new Operations Project ID");
});

test("operational panel is absent when its server-derived availability is off",async({page})=>{
  const calls=await fixture(page,false);await page.goto(path);
  await expect(page.getByRole("region",{name:"Adopt a Project Alpha project for this customer"})).toHaveCount(0);
  expect(calls).toHaveLength(0);
});
