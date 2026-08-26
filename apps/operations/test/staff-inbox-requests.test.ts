import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { registerStaffInboxRequestRoutes, type StaffInboxRequestItem } from "../src/worker/staff-inbox-requests";
import type { Env, StaffPrincipal } from "../src/worker/types";

let runtime:Miniflare,ops:D1Database,delivery:D1Database,env:Env;
const actor:StaffPrincipal={id:"inbox-admin",email:"inbox@example.test",displayName:"Inbox admin",accessSubject:"inbox-subject",projectAlphaUserId:null};
const second:StaffPrincipal={...actor,id:"inbox-second",email:"second@example.test",accessSubject:"second-subject"};
const scoped:StaffPrincipal={...actor,id:"inbox-scoped",email:"scoped@example.test",accessSubject:"scoped-subject"};
const app=new Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>();
// Access-token verification is outside this isolated router fixture. Identity
// is injected, but current staff state, every ACL grant and both DBs are real.
app.use("*",async(c,next)=>{
  const selected=c.req.header("x-test-actor");
  if(selected!=="anonymous")c.set("principal",selected==="second"?second:selected==="scoped"?scoped:actor);
  c.set("administrator",true);await next();
});
app.onError((error,c)=>c.json({error:error.message},error instanceof HTTPException?error.status:500));
registerStaffInboxRequestRoutes(app);
type Page={items:StaffInboxRequestItem[];nextCursor:string|null};
async function get(q:string,cursor?:string,environment=env,identity?:string){
  const url=new URL("https://ops.example.test/api/operations/inbox/requests");url.searchParams.set("q",q);
  if(cursor!==undefined)url.searchParams.set("cursor",cursor);
  return app.request(url.href,{headers:identity?{"x-test-actor":identity}:{}},environment);
}
async function page(q:string,cursor?:string){const response=await get(q,cursor);expect(response.status).toBe(200);return response.json() as Promise<Page>;}
async function owner(name:string,source:string|null=null,projectName:string|null=null){
  const key=crypto.randomUUID(),identity="identity-"+key,project=projectName===null?null:"project-"+key;
  await delivery.batch([
    delivery.prepare("INSERT INTO client_accounts(id,display_name,project_alpha_source_id,project_alpha_client_id,status) VALUES(?,?,?,?,'active')")
      .bind(key,name,source,source?key:null),
    delivery.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES(?,?,'https://issuer.example.test',?,'private@example.test')")
      .bind(identity,key,identity),
    ...(project?[delivery.prepare("INSERT INTO projects(id,client_name,project_name,r2_prefix,project_alpha_source_id,project_alpha_project_id) VALUES(?,?,?,?,?,?)")
      .bind(project,"Billing client alias",projectName,"Clients/"+key+"/",source,source?key:null),
      delivery.prepare("INSERT INTO client_project_grants(account_id,project_id,can_request_service) VALUES(?,?,1)").bind(key,project)]:[]),
  ]);
  return {key,identity,project};
}
type Owner=Awaited<ReturnType<typeof owner>>;
function requestStatement(customer:Owner,key:string,title:string,status="submitted",created="2026-01-01 00:00:00",source="project-alpha:primary"){
  return delivery.prepare(`INSERT INTO client_service_requests(id,account_id,project_id,created_by_identity_id,request_type,title,details,
    site_contact_name,site_contact_email,site_contact_phone,idempotency_key,request_fingerprint,status,created_at,catalog_source_id)
    VALUES(?,?,?,?,'service',?,'Private financial scope','Private Person','private@example.test','555-1234',?,?,?, ?,?)`)
    .bind(key,customer.key,customer.project,customer.identity,title,"key-"+key.padEnd(20,"x"),"f".repeat(43),status,created,source);
}
async function request(customer:Owner,title:string,status="submitted",created="2026-01-01 00:00:00",source="project-alpha:primary"){
  const key=crypto.randomUUID();await requestStatement(customer,key,title,status,created,source).run();return key;
}
function afterFirstPage(database:D1Database,action:()=>Promise<void>):D1Database{
  let fired=false;
  const wrapStatement=(raw:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(raw,{get(target,key){
    if(key==="bind")return(...values:unknown[])=>wrapStatement(target.bind(...values),sql);
    if(key==="all")return async <T>():Promise<D1Result<T>>=>{
      const result=await target.all<T>();
      if(!fired&&sql.includes("FROM client_service_requests")){fired=true;await action();}
      return result;
    };
    const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
  }});
  return new Proxy(database,{get(target,key){
    if(key==="withSession")return(constraint:D1SessionConstraint)=>new Proxy(target.withSession(constraint),{get(session,property){
      if(property==="prepare")return(sql:string)=>wrapStatement(session.prepare(sql),sql);
      const value=Reflect.get(session,property,session);return typeof value==="function"?value.bind(session):value;
    }});
    const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
  }});
}
beforeAll(async()=>{
  runtime=new Miniflare({modules:true,compatibilityDate:"2026-07-22",script:"export default {fetch(){return new Response('inbox')}}",d1Databases:["OPS_DB","DELIVERY_DB"]});
  ops=await runtime.getD1Database("OPS_DB") as D1Database;delivery=await runtime.getD1Database("DELIVERY_DB") as D1Database;
  for(const [database,path]of[[ops,"../migrations"],[delivery,"../../client/migrations"]]as const){
    const directory=resolve(import.meta.dirname,path);
    for(const filename of(await readdir(directory)).filter(name=>/^\d+_.*\.sql$/.test(name)).sort())
      await database.batch(splitD1MigrationStatements(await readFile(resolve(directory,filename),"utf8")).map(sql=>database.prepare(sql)));
  }
  for(const principal of[actor,second,scoped])
    await ops.prepare("INSERT INTO staff_users(id,email,display_name,access_subject) VALUES(?,?,?,?)")
      .bind(principal.id,principal.email,principal.displayName,principal.accessSubject).run();
  await ops.batch([
    ops.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES('inbox-admin-role',?,'role-admin','global','global'),('inbox-second-role',?,'role-admin','global','global')")
      .bind(actor.id,second.id),
    ops.prepare("INSERT INTO divisions(id,name,code) VALUES('inbox-division','Inbox division','inbox')"),
    ops.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
      VALUES('inbox-scoped-allow',?,'operations.manage','allow','division','inbox-division','inbox-division',?)`).bind(scoped.id,actor.id),
  ]);
  env={OPS_DB:ops,DELIVERY_DB:delivery,OPERATIONS_SESSION_SECRET:"staff-inbox-cursor-fixture-at-least-32-characters"} as Env;
},120_000);
afterEach(()=>vi.restoreAllMocks());
afterAll(async()=>{await runtime?.dispose();});

describe("staff request inbox on migrated D1 with real current ACL",{timeout:30_000},()=>{
  it("pages beyond 200 pending requests oldest-first without finance/contact payload or duplicates",async()=>{
    const customer=await owner("Bulk account");
    for(let start=0;start<230;start+=40)
      await delivery.batch(Array.from({length:Math.min(40,230-start)},(_,offset)=>{
        const index=start+offset;return requestStatement(customer,"bulk-"+String(index).padStart(4,"0"),"Bulk Inbox Request "+index,
          ["submitted","under_review","accepted_pending_pa_linkage"][index%3]!);
      }));
    for(const status of["accepted_linked","declined","cancelled","completed"])
      await request(customer,"Bulk Inbox terminal",status,"2025-01-01 00:00:00");
    const collected:StaffInboxRequestItem[]=[];let cursor:string|undefined;
    do{const current=await page("Bulk Inbox",cursor);expect(current.items.length).toBeLessThanOrEqual(25);
      collected.push(...current.items);cursor=current.nextCursor??undefined;
      expect(collected.length).toBeLessThanOrEqual(230);
    }while(cursor);
    expect(collected.map(row=>row.id)).toEqual(Array.from({length:230},(_,i)=>"bulk-"+String(i).padStart(4,"0")));
    expect(new Set(collected.map(row=>row.id)).size).toBe(230);
    expect(Object.keys(collected[0]!).sort()).toEqual(["accountName","createdAt","id","projectName","status","title"]);
    expect(collected.every(row=>row.createdAt==="2026-01-01T00:00:00.000Z")).toBe(true);
    expect(JSON.stringify(collected)).not.toMatch(/Private Person|private@example|Private financial|555-1234|account_id|catalog_source_id/);
  });
  it("filters title, account, project and client alias before the page limit; treats wildcard characters literally",async()=>{
    const customer=await owner("Needle account","project-alpha:primary","North 100%_literal");
    const requestId=await request(customer,"Unique title");
    for(const q of["needle ACCOUNT"," north 100%_literal ","billing CLIENT alias","unique TITLE"])
      expect((await page(q)).items.map(row=>row.id)).toEqual([requestId]);
    expect((await page("North 100Xliteral")).items).toEqual([]);
    const unicode=await owner("ÉLAN account");const unicodeId=await request(unicode,"Unicode request");
    expect((await page("E\u0301LAN")).items.map(row=>row.id)).toEqual([unicodeId]);
  });
  it("keeps local, primary and secondary requests in existing global triage without depending on a client portal grant",async()=>{
    const ids:string[]=[];
    for(const source of[null,"project-alpha:primary","project-alpha:secondary"]){
      const customer=await owner("Triage "+String(source),source,"Triage project");
      ids.push(await request(customer,"Source triage", "submitted","2026-01-01 00:00:00",source??"project-alpha:primary"));
      await delivery.prepare("UPDATE client_project_grants SET revoked_at=datetime('now') WHERE account_id=?").bind(customer.key).run();
    }
    expect((await page("Source triage")).items.map(row=>row.id).sort()).toEqual(ids.sort());
  });
  it("excludes inactive accounts and no longer pending requests before limit",async()=>{
    const customer=await owner("Inactive inbox");await request(customer,"Inactive inbox");
    await delivery.prepare("UPDATE client_accounts SET status='suspended' WHERE id=?").bind(customer.key).run();
    expect((await page("Inactive inbox")).items).toEqual([]);
  });
  it("requires a live staff principal and global management rather than division-only permission",async()=>{
    expect((await get("Bulk Inbox",undefined,env,"anonymous")).status).toBe(401);
    expect((await get("Bulk Inbox",undefined,env,"scoped")).status).toBe(403);
    await ops.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").bind(second.id).run();
    expect((await get("Bulk Inbox",undefined,env,"second")).status).toBe(403);
    await ops.prepare("UPDATE staff_users SET status='active' WHERE id=?").bind(second.id).run();
    await ops.prepare("UPDATE staff_users SET access_subject='changed-subject' WHERE id=?").bind(second.id).run();
    expect((await get("Bulk Inbox",undefined,env,"second")).status).toBe(403);
    await ops.prepare("UPDATE staff_users SET access_subject=? WHERE id=?").bind(second.accessSubject,second.id).run();
  });
  it("honors explicit global denial despite administrator role",async()=>{
    await ops.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by)
      VALUES('inbox-deny',?,'operations.manage','deny','global','global',?)`).bind(actor.id,actor.id).run();
    try{expect((await get("Bulk Inbox")).status).toBe(403);}
    finally{await ops.prepare("DELETE FROM staff_permission_overrides WHERE id='inbox-deny'").run();}
  });
  it("encrypts and binds continuation to actor, normalized search and policy, while exact replay is safe",async()=>{
    const first=await page("Bulk Inbox");expect(first.nextCursor).toBeTruthy();
    expect(first.nextCursor).not.toContain("bulk-");
    const next=await page("Bulk Inbox",first.nextCursor!);
    const replay=await page("Bulk Inbox",first.nextCursor!);
    expect(replay.items).toEqual(next.items);expect(Boolean(replay.nextCursor)).toBe(Boolean(next.nextCursor));
    expect((await get("Bulk",first.nextCursor!)).status).toBe(409);
    expect((await get("Bulk Inbox",first.nextCursor!,env,"second")).status).toBe(400);
    const token=first.nextCursor!;const mutated=(token[0]==="A"?"B":"A")+token.slice(1);
    expect((await get("Bulk Inbox",mutated)).status).toBe(400);
    await ops.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
      VALUES('inbox-policy-change',?,'operations.manage','deny','division','inbox-division','inbox-division',?)`).bind(actor.id,actor.id).run();
    try{
      // Existing global triage ignores division-only exclusions, but the changed
      // effective scope still invalidates a previously issued cursor.
      expect((await get("Bulk Inbox",first.nextCursor!)).status).toBe(409);
      expect((await get("Bulk Inbox")).status).toBe(200);
    }finally{await ops.prepare("DELETE FROM staff_permission_overrides WHERE id='inbox-policy-change'").run();}
  });
  it("rejects expired, malformed, oversized and unknown query parameters with no-store responses",async()=>{
    const first=await page("Bulk Inbox"),realNow=Date.now();
    const clock=vi.spyOn(Date,"now").mockReturnValue(realNow+31*60_000);
    expect((await get("Bulk Inbox",first.nextCursor!)).status).toBe(409);clock.mockRestore();
    for(const token of["","bad","a.b.c","A".repeat(4097)]){
      const response=await get("Bulk Inbox",token);expect(response.status).toBe(400);expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    for(const suffix of["q="+"x".repeat(201),"q=%00","limit=100","q=a&q=b","status=submitted"])
      expect((await app.request("https://ops.example.test/api/operations/inbox/requests?"+suffix,{},env)).status).toBe(400);
  });
  it("does not release a page after its account is revoked between reads",async()=>{
    const customer=await owner("Race account");await request(customer,"Account race");
    const database=afterFirstPage(delivery,()=>delivery.prepare("UPDATE client_accounts SET status='suspended' WHERE id=?").bind(customer.key).run().then(()=>undefined));
    expect((await get("Account race",undefined,{...env,DELIVERY_DB:database})).status).toBe(409);
  });
  it("does not release a page after a request leaves pending state between reads",async()=>{
    const customer=await owner("Race state");const key=await request(customer,"State race");
    const database=afterFirstPage(delivery,()=>delivery.prepare("UPDATE client_service_requests SET status='completed' WHERE id=?").bind(key).run().then(()=>undefined));
    expect((await get("State race",undefined,{...env,DELIVERY_DB:database})).status).toBe(409);
  });
  it("rechecks staff denial after data hydration and releases no stale items",async()=>{
    const database=afterFirstPage(delivery,()=>ops.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by)
      VALUES('inbox-midread-deny',?,'operations.manage','deny','global','global',?)`).bind(actor.id,actor.id).run().then(()=>undefined));
    try{expect((await get("Bulk Inbox",undefined,{...env,DELIVERY_DB:database})).status).toBe(403);}
    finally{await ops.prepare("DELETE FROM staff_permission_overrides WHERE id='inbox-midread-deny'").run();}
  });
});
