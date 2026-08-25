import { expect, test, type Page } from "@playwright/test";

const linkStaffSession={
  user:{id:"staff-links",email:"links@example.test",displayName:"Links Staff",status:"Active",profileType:"Administrator",isAdministrator:true,permissions:["delivery.browse","delivery.share.audit","delivery.share.revoke"],divisions:[]},
  csrfToken:"csrf-links",timezone:"America/Chicago",mapStyleUrl:null,mapboxPublicToken:null,capabilities:{deliveryJobsRoot:{enabled:true}},
};

function historyShare(id:string,label:string){
  return {id,label,client_name:"Acme",project_name:"Roof survey",target_path:`Jobs/Clients/Acme/Edited/${id}.jpg`,target_kind:"file",display_name:`${id}.jpg`,created_at:"2026-08-21T12:00:00Z",expires_at:null,revoked_at:null,unavailable_since:null,password_protected:0,access_count:0,last_accessed_at:null};
}

async function expectSearchSpacing(page:Page){
  const input=await page.getByRole("textbox",{name:"Search",exact:true}).boundingBox();
  const search=await page.getByRole("button",{name:"Search",exact:true}).boundingBox();
  const clear=await page.getByRole("button",{name:"Clear",exact:true}).boundingBox();
  expect(input).not.toBeNull();expect(search).not.toBeNull();expect(clear).not.toBeNull();
  const distance=(left:NonNullable<typeof input>,right:NonNullable<typeof input>)=>Math.max(right.x-left.x-left.width,left.x-right.x-right.width,right.y-left.y-left.height,left.y-right.y-right.height);
  expect(distance(input!,search!)).toBeGreaterThanOrEqual(8);
  expect(distance(search!,clear!)).toBeGreaterThanOrEqual(8);
  expect(search!.height).toBeGreaterThanOrEqual(44);
  expect(clear!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
}

test("audit-only staff can directly open Client links without browse or share mutation access",async({page})=>{
  const apiRequests:Array<{method:string;path:string}>=[];
  await page.route("**/api/**",async route=>{
    const request=route.request(),url=new URL(request.url());
    apiRequests.push({method:request.method(),path:url.pathname});
    if(url.pathname==="/api/session")return route.fulfill({json:{
      user:{id:"staff-link-auditor",email:"auditor@example.test",displayName:"Link Auditor",status:"Active",profileType:"Employee",isAdministrator:false,permissions:["delivery.share.audit"],divisions:[]},
      csrfToken:"csrf-audit",timezone:"America/Chicago",mapStyleUrl:null,mapboxPublicToken:null,capabilities:{},
    }});
    if(url.pathname==="/api/delivery/shares"&&request.method()==="GET")return route.fulfill({json:{shares:[{
      id:"share-audit",label:"Read-only handoff",client_name:"Acme",project_name:"Survey",target_path:"Jobs/Clients/Acme/final.mov",target_kind:"file",display_name:"final.mov",created_at:"2026-08-21T12:00:00Z",expires_at:null,revoked_at:null,unavailable_since:null,password_protected:0,access_count:1,last_accessed_at:null,
    }],nextCursor:null}});
    return route.fulfill({status:404,json:{error:"Not found"}});
  });

  await page.goto("/delivery/links");
  await expect(page).toHaveURL(/\/delivery\/links$/);
  await expect(page.getByRole("heading",{name:"Client links",exact:true})).toBeVisible();
  await expect(page.getByText("Read-only handoff")).toBeVisible();
  const dataNavigationLink=page.locator('.ops-desktop-nav a[href="/delivery"]');
  await expect(dataNavigationLink).toHaveAttribute("aria-current","page");
  await expect(page.getByRole("tab",{name:"Client delivery"})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Revoke"})).toHaveCount(0);
  expect(apiRequests.filter(({path})=>path.startsWith("/api/delivery"))).toEqual([
    {method:"GET",path:"/api/delivery/shares"},
  ]);
});

test("client-link history is refresh-safe, searchable, paginated, and revocable",async({page})=>{
  const shareQueries:string[]=[];
  const revoked:string[]=[];
  await page.route("**/api/**",async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.pathname==="/api/session")return route.fulfill({json:{
      user:{id:"staff-links",email:"links@example.test",displayName:"Links Staff",status:"Active",profileType:"Administrator",isAdministrator:true,permissions:["delivery.browse","delivery.share.audit","delivery.share.revoke"],divisions:[]},
      csrfToken:"csrf-links",timezone:"America/Chicago",mapStyleUrl:null,mapboxPublicToken:null,capabilities:{deliveryJobsRoot:{enabled:true}},
    }});
    if(url.pathname==="/api/delivery/shares"&&request.method()==="GET"){
      shareQueries.push(url.search);
      const searched=url.searchParams.get("q");
      if(searched)return route.fulfill({json:{shares:[{
        id:"share-search",label:"Gelsman handoff",client_name:"Gelsman Construction Service",project_name:"Site video",target_path:"Jobs/Clients/Gelsman/video.mov",target_kind:"file",display_name:"video.mov",created_at:"2026-08-20T12:00:00Z",expires_at:null,revoked_at:null,unavailable_since:null,password_protected:0,access_count:2,last_accessed_at:null,
      }],nextCursor:null}});
      if(url.searchParams.get("cursor"))return route.fulfill({json:{shares:[{
        id:"share-folder",label:null,client_name:"Acme",project_name:"Archive",target_path:"Jobs/Clients/Acme/Archive/",target_kind:"folder",display_name:"Archive",created_at:"2026-08-18T12:00:00Z",expires_at:null,revoked_at:null,unavailable_since:null,password_protected:1,access_count:0,last_accessed_at:null,
      }],nextCursor:null}});
      return route.fulfill({json:{shares:[{
        id:"share-file",label:"Roof walkthrough",client_name:"Acme",project_name:"Roof survey",target_path:"Jobs/Clients/Acme/final.mov",target_kind:"file",display_name:"Client walkthrough",created_at:"2026-08-21T12:00:00Z",expires_at:null,revoked_at:null,unavailable_since:null,password_protected:0,access_count:4,last_accessed_at:"2026-08-22T12:00:00Z",
      }],nextCursor:"next-page"}});
    }
    if(url.pathname.startsWith("/api/delivery/shares/")&&request.method()==="DELETE"){
      revoked.push(url.pathname);return route.fulfill({json:{success:true}});
    }
    return route.fulfill({status:404,json:{error:"Not found"}});
  });

  await page.goto("/delivery/links");
  await expect(page.getByRole("heading",{name:"Client links",exact:true})).toBeVisible();
  await expect(page.getByText("Roof walkthrough")).toBeVisible();
  expect(shareQueries[0]).toContain("limit=50");

  const loadMore=page.getByRole("button",{name:"Load more"});
  if((page.viewportSize()?.width||0)<=960)expect((await loadMore.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  await loadMore.click();
  await expect(page.getByText("Jobs/Clients/Acme/Archive/",{exact:true})).toBeVisible();
  expect(shareQueries.some(query=>query.includes("cursor=next-page"))).toBe(true);

  await page.getByRole("textbox",{name:"Search"}).fill("Gelsman");
  await page.getByRole("button",{name:"Search"}).click();
  await expect(page).toHaveURL(/\/delivery\/links\?q=Gelsman$/);
  await expect(page.getByText("Gelsman handoff")).toBeVisible();
  expect(shareQueries.some(query=>query.includes("q=Gelsman"))).toBe(true);

  page.once("dialog",dialog=>dialog.accept());
  await page.getByRole("button",{name:"Revoke"}).click();
  await expect(page.getByText("revoked")).toBeVisible();
  expect(revoked).toEqual(["/api/delivery/shares/share-search"]);
});

test("folder link history preserves scope through search, clear, pagination, revoke, refresh, and browser history",async({page},testInfo)=>{
  const prefix="Jobs/Clients/Acme/Edited/";
  const queries:URLSearchParams[]=[];
  const revoked:string[]=[];
  await page.route("**/api/**",async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.pathname==="/api/session")return route.fulfill({json:linkStaffSession});
    if(url.pathname==="/api/delivery/shares"&&request.method()==="GET"){
      queries.push(url.searchParams);
      const query=url.searchParams.get("q");
      if(query)return route.fulfill({json:{shares:[historyShare("filtered","Filtered roof delivery")],nextCursor:null}});
      if(url.searchParams.get("cursor"))return route.fulfill({json:{shares:[historyShare("older","Older roof delivery")],nextCursor:null}});
      return route.fulfill({json:{shares:[historyShare("newest","Newest roof delivery")],nextCursor:"older-cursor"}});
    }
    if(request.method()==="DELETE"){
      revoked.push(url.pathname);return route.fulfill({json:{success:true}});
    }
    return route.fulfill({status:404,json:{error:"Not found"}});
  });
  await page.goto(`/delivery/links?prefix=${encodeURIComponent(prefix)}`);
  await expect(page.getByRole("region",{name:"Link history scope"})).toContainText("Folder: Acme / Edited");
  await expect(page.getByRole("link",{name:"Back to folder"})).toHaveAttribute("href","/delivery/Acme/Edited");
  await expect(page.getByText("Newest roof delivery")).toBeVisible();
  await page.getByRole("button",{name:"Load more"}).click();
  await expect(page.getByText("Older roof delivery")).toBeVisible();
  expect(queries.at(-1)?.get("cursor")).toBe("older-cursor");

  await page.getByRole("textbox",{name:"Search",exact:true}).fill("roof");
  await expectSearchSpacing(page);
  await page.evaluate(()=>window.scrollTo(0,0));
  await expect.poll(()=>page.evaluate(()=>window.scrollY)).toBe(0);
  await page.screenshot({path:testInfo.outputPath("client-links-scoped-layout.png"),fullPage:true});
  await page.getByRole("button",{name:"Search",exact:true}).click();
  await expect(page.getByText("Filtered roof delivery")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("q")).toBe("roof");
  expect(new URL(page.url()).searchParams.get("prefix")).toBe(prefix);
  await page.reload();
  await expect(page.getByRole("textbox",{name:"Search",exact:true})).toHaveValue("roof");
  await expect(page.getByText("Filtered roof delivery")).toBeVisible();

  page.once("dialog",dialog=>dialog.accept());
  await page.getByRole("button",{name:"Revoke",exact:true}).click();
  await expect(page.getByText("revoked",{exact:true})).toBeVisible();
  expect(revoked).toEqual(["/api/delivery/shares/filtered"]);
  expect(new URL(page.url()).searchParams.get("prefix")).toBe(prefix);

  await page.getByRole("button",{name:"Clear",exact:true}).click();
  await expect(page.getByText("Newest roof delivery")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("q")).toBeNull();
  expect(new URL(page.url()).searchParams.get("prefix")).toBe(prefix);
  await page.goBack();
  await expect(page.getByRole("textbox",{name:"Search",exact:true})).toHaveValue("roof");
  await expect(page.getByText("Filtered roof delivery")).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("textbox",{name:"Search",exact:true})).toHaveValue("");
  await expect(page.getByText("Newest roof delivery")).toBeVisible();
  expect(queries.every(query=>query.get("prefix")===prefix)).toBe(true);

  await page.getByRole("link",{name:"View all links"}).click();
  await expect(page.getByRole("region",{name:"Link history scope"})).toHaveCount(0);
  await expect(page.getByText("Newest roof delivery")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("prefix")).toBeNull();
  expect(queries.at(-1)?.get("prefix")).toBeNull();
  await page.goBack();
  await expect(page.getByRole("region",{name:"Link history scope"})).toBeVisible();
  await expect(page.getByText("Newest roof delivery")).toBeVisible();
  expect(queries.at(-1)?.get("prefix")).toBe(prefix);
});

test("changing link search ignores an older continuation and retry keeps its folder scope",async({page})=>{
  const prefix="Jobs/Clients/Acme/Edited/";
  let releaseContinuation=()=>{};
  const continuationGate=new Promise<void>(resolve=>{releaseContinuation=resolve;});
  let continuationStarted=false;
  let continuationFinished=false;
  let searchAttempts=0;
  const queries:URLSearchParams[]=[];
  await page.route("**/api/**",async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==="/api/session")return route.fulfill({json:linkStaffSession});
    if(url.pathname==="/api/delivery/shares"){
      queries.push(url.searchParams);
      if(url.searchParams.get("cursor")){
        continuationStarted=true;
        await continuationGate;
        await route.fulfill({json:{shares:[historyShare("stale","Stale continuation")],nextCursor:null}}).catch(()=>undefined);
        continuationFinished=true;
        return;
      }
      if(url.searchParams.get("q")){
        searchAttempts+=1;
        if(searchAttempts===1)return route.fulfill({status:503,json:{error:"History is temporarily unavailable"}});
        return route.fulfill({json:{shares:[historyShare("current","Current search result")],nextCursor:null}});
      }
      return route.fulfill({json:{shares:[historyShare("initial","Initial result")],nextCursor:"slow-cursor"}});
    }
    return route.fulfill({status:404,json:{error:"Not found"}});
  });
  await page.goto(`/delivery/links?prefix=${encodeURIComponent(prefix)}`);
  await expect(page.getByText("Initial result")).toBeVisible();
  await page.getByRole("button",{name:"Load more"}).click();
  await expect.poll(()=>continuationStarted).toBe(true);
  await page.getByRole("textbox",{name:"Search",exact:true}).fill("current");
  await page.getByRole("button",{name:"Search",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("History is temporarily unavailable");
  await expect(page.getByText("No client links found",{exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"Retry",exact:true}).click();
  await expect(page.getByText("Current search result")).toBeVisible();
  releaseContinuation();
  await expect.poll(()=>continuationFinished).toBe(true);
  await expect(page.getByText("Stale continuation",{exact:true})).toHaveCount(0);
  await expect(page.getByText("Initial result",{exact:true})).toHaveCount(0);
  expect(searchAttempts).toBe(2);
  expect(queries.every(query=>query.get("prefix")===prefix)).toBe(true);
  expect(queries.at(-1)?.get("q")).toBe("current");
});

test("leaving folder scope preserves the query and ignores an older scoped response",async({page})=>{
  const prefix="Jobs/Clients/Acme/Edited/";
  let releaseScoped=()=>{};
  const scopedGate=new Promise<void>(resolve=>{releaseScoped=resolve;});
  let scopedStarted=false;
  let scopedFinished=false;
  const queries:URLSearchParams[]=[];
  await page.route("**/api/**",async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==="/api/session")return route.fulfill({json:linkStaffSession});
    if(url.pathname==="/api/delivery/shares"){
      queries.push(url.searchParams);
      if(url.searchParams.has("prefix")){
        scopedStarted=true;
        await scopedGate;
        await route.fulfill({json:{shares:[historyShare("stale-scoped","Stale scoped result")],nextCursor:null}}).catch(()=>undefined);
        scopedFinished=true;
        return;
      }
      return route.fulfill({json:{shares:[historyShare("all","All-folder roof result")],nextCursor:null}});
    }
    return route.fulfill({status:404,json:{error:"Not found"}});
  });
  await page.goto(`/delivery/links?prefix=${encodeURIComponent(prefix)}&q=roof`);
  await expect.poll(()=>scopedStarted).toBe(true);
  await page.getByRole("link",{name:"View all links"}).click();
  await expect(page.getByText("All-folder roof result")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("prefix")).toBeNull();
  expect(new URL(page.url()).searchParams.get("q")).toBe("roof");
  await expect(page.getByRole("textbox",{name:"Search",exact:true})).toHaveValue("roof");
  releaseScoped();
  await expect.poll(()=>scopedFinished).toBe(true);
  await expect(page.getByText("Stale scoped result",{exact:true})).toHaveCount(0);
  expect(queries.at(-1)?.get("prefix")).toBeNull();
  expect(queries.at(-1)?.get("q")).toBe("roof");
});

test("reselecting Client links preserves the active folder scope and query",async({page})=>{
  const prefix="Jobs/Clients/Acme/Edited/";
  const queries:URLSearchParams[]=[];
  await page.route("**/api/**",async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==="/api/session")return route.fulfill({json:linkStaffSession});
    if(url.pathname==="/api/delivery/shares"){
      queries.push(url.searchParams);
      return route.fulfill({json:{shares:[historyShare("roof","Scoped roof delivery")],nextCursor:null}});
    }
    return route.fulfill({status:404,json:{error:"Not found"}});
  });
  await page.goto(`/delivery/links?prefix=${encodeURIComponent(prefix)}&q=roof`);
  await expect(page.getByText("Scoped roof delivery")).toBeVisible();
  const urlBefore=page.url();
  await page.getByRole("tab",{name:"Client links",exact:true}).click();
  await expect(page).toHaveURL(urlBefore);
  await expect(page.getByRole("region",{name:"Link history scope"})).toContainText("Acme / Edited");
  await expect(page.getByRole("textbox",{name:"Search",exact:true})).toHaveValue("roof");
  await page.getByRole("button",{name:"Refresh",exact:true}).click();
  await expect(page.getByText("Scoped roof delivery")).toBeVisible();
  expect(queries.every(query=>query.get("prefix")===prefix&&query.get("q")==="roof")).toBe(true);
});

test("a pending revoke remains busy across a new query and updates the newly loaded matching row",async({page})=>{
  const prefix="Jobs/Clients/Acme/Edited/";
  let releaseDelete=()=>{};
  const deleteGate=new Promise<void>(resolve=>{releaseDelete=resolve;});
  let deleteStarted=false;
  await page.route("**/api/**",async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.pathname==="/api/session")return route.fulfill({json:linkStaffSession});
    if(url.pathname==="/api/delivery/shares")return route.fulfill({json:{shares:[historyShare("roof","Roof delivery")],nextCursor:null}});
    if(url.pathname==="/api/delivery/shares/roof"&&request.method()==="DELETE"){
      deleteStarted=true;await deleteGate;
      return route.fulfill({json:{success:true}});
    }
    return route.fulfill({status:404,json:{error:"Not found"}});
  });
  await page.goto(`/delivery/links?prefix=${encodeURIComponent(prefix)}&q=roof`);
  await expect(page.getByText("Roof delivery",{exact:true})).toBeVisible();
  page.once("dialog",dialog=>dialog.accept());
  await page.getByRole("button",{name:"Revoke",exact:true}).click();
  await expect.poll(()=>deleteStarted).toBe(true);
  await page.getByRole("textbox",{name:"Search",exact:true}).fill("delivery");
  await page.getByRole("button",{name:"Search",exact:true}).click();
  await expect(page.getByText("Roof delivery",{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Revoking…",exact:true})).toBeDisabled();
  releaseDelete();
  await expect(page.getByText("revoked",{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Revoke",exact:true})).toHaveCount(0);
  // Even a subsequent stale replica read cannot undo a confirmed revocation.
  await page.getByRole("button",{name:"Refresh",exact:true}).click();
  await expect(page.getByText("revoked",{exact:true})).toBeVisible();
});

for(const change of ["same-query search","folder scope"] as const){
  test(`confirmed revocation survives a delayed pre-delete read after changing ${change}`,async({page})=>{
    const prefix="Jobs/Clients/Acme/Edited/";
    let releaseDelete=()=>{},releaseRead=()=>{};
    const deleteGate=new Promise<void>(resolve=>{releaseDelete=resolve;});
    const readGate=new Promise<void>(resolve=>{releaseRead=resolve;});
    let deleteStarted=false,readStarted=false;
    await page.route("**/api/**",async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.pathname==="/api/session")return route.fulfill({json:linkStaffSession});
      if(url.pathname==="/api/delivery/shares"){
        if(deleteStarted){readStarted=true;await readGate;}
        return route.fulfill({json:{shares:[historyShare("roof","Roof delivery")],nextCursor:null}});
      }
      if(url.pathname==="/api/delivery/shares/roof"&&request.method()==="DELETE"){
        deleteStarted=true;await deleteGate;
        return route.fulfill({json:{success:true}});
      }
      return route.fulfill({status:404,json:{error:"Not found"}});
    });
    await page.goto(`/delivery/links?prefix=${encodeURIComponent(prefix)}&q=roof`);
    await expect(page.getByText("Roof delivery",{exact:true})).toBeVisible();
    page.once("dialog",dialog=>dialog.accept());
    const deleted=page.waitForResponse(response=>response.request().method()==="DELETE"&&response.url().endsWith("/api/delivery/shares/roof"));
    await page.getByRole("button",{name:"Revoke",exact:true}).click();
    await expect.poll(()=>deleteStarted).toBe(true);
    if(change==="same-query search")await page.getByRole("button",{name:"Search",exact:true}).click();
    else await page.getByRole("link",{name:"View all links"}).click();
    await expect.poll(()=>readStarted).toBe(true);
    releaseDelete();
    await (await deleted).finished();
    // Let the successful DELETE's state commit before returning the stale GET.
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    releaseRead();
    await expect(page.getByText("revoked",{exact:true})).toBeVisible();
    await expect(page.getByRole("button",{name:"Revoke",exact:true})).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("prefix")).toBe(change==="folder scope"?null:prefix);
    expect(new URL(page.url()).searchParams.get("q")).toBe("roof");
  });
}
