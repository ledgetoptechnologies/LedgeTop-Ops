import { expect, test } from "@playwright/test";

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
