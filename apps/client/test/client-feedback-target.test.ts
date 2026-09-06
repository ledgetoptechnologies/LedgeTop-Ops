import { readFileSync,readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { afterAll,beforeAll,beforeEach,describe,expect,it } from "vitest";
import type { Env } from "../src/worker/types";
import type { ClientPortalSession,VerifiedClientPrincipal } from "../src/worker/client-portal/types";
import { createClientPortalRouter } from "../src/worker/client-portal/routes";
import { createClientPortalFileHandle,encodeProjectFolderHandle,d1ClientPortalRepository } from "../src/worker/client-portal/repository";
import { resolveEffectivePortalWorkspaceContext } from "../src/worker/client-portal/workspace-v2";
import { resolveClientFeedbackTarget,reauthorizeFeedbackRecipient,clientFeedbackTargetActionPath,type FeedbackTargetInput } from "../src/worker/client-portal/feedback-target";
import { createFeedbackRecord,readFeedbackRecord,transitionFeedbackRecord } from "../src/worker/client-portal/feedback-store";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const origin="https://client.test", storageKey="clients/a/north/edited/photo.jpg";
const principal:VerifiedClientPrincipal={issuer:"https://team.cloudflareaccess.com",subject:"feedback-a",email:"a@example.test"};
const session:ClientPortalSession={accountId:"account-a",identityId:"identity-a",displayName:"Client A",role:"manager",canViewBilling:false,
  principalIssuer:principal.issuer,principalSubject:principal.subject};

describe("feedback target authorization against migrated D1",{timeout:60_000},()=>{
  let runtime:Miniflare,db:D1Database,env:Env,sequence=0;
  const mutationKey=()=>`feedback-target-test-${++sequence}`;
  async function migration(name:string){
    const statements=splitD1MigrationStatements(readFileSync(new URL(`../migrations/${name}`,import.meta.url),"utf8"));
    if(statements.length)await db.batch(statements.map(s=>db.prepare(s)));
  }
  beforeAll(async()=>{
    runtime=new Miniflare({compatibilityDate:"2026-07-16",modules:true,script:"export default {fetch(){return new Response('test')}}",d1Databases:{DELIVERY_DB:"feedback-target"}});
    db=await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    for(const name of readdirSync(fileURLToPath(new URL("../migrations/",import.meta.url))).filter(n=>n.endsWith(".sql")).sort())await migration(name);
    await db.batch([
      db.prepare("INSERT INTO client_accounts(id,display_name,status,project_alpha_organization_id,project_alpha_source_id) VALUES ('account-a','Client A','active','pa-org-a','project-alpha:primary'),('account-b','Client B','active','pa-org-b','project-alpha:primary')"),
      db.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES ('identity-a','account-a',?,?,?),('identity-b','account-b',?,'feedback-b','b@example.test')").bind(principal.issuer,principal.subject,principal.email,principal.issuer),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES ('account-a','identity-a','manager'),('account-b','identity-b','manager')"),
      db.prepare("INSERT INTO projects(id,project_alpha_project_id,client_name,project_name,r2_prefix,project_alpha_source_id) VALUES ('project-a','pa-project-a','Client A','North site','clients/a/north/','project-alpha:primary'),('project-b','pa-project-b','Client B','Other site','clients/b/','project-alpha:primary')"),
      db.prepare("INSERT INTO client_project_grants(account_id,project_id,can_request_service) VALUES ('account-a','project-a',1),('account-b','project-b',1)"),
      db.prepare("INSERT INTO client_folder_associations(id,scope_type,project_id,account_id,r2_prefix,created_by) VALUES ('folder-a','project','project-a','account-a','clients/a/north/','staff'),('folder-b','project','project-b','account-b','clients/b/','staff'),('folder-client','client',NULL,'account-a','clients/a/','staff')"),
      db.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES (?,'etag-one',200,'2026-08-25T01:00:00Z','image/jpeg','image'),('clients/b/secret.jpg','private',100,'2026-08-25T01:00:00Z','image/jpeg','image')").bind(storageKey),
    ]);
    await migration("0121_client_workspace_hierarchy_v2.sql");
    await db.batch([
      db.prepare("INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version) SELECT id,workspace_id,2 FROM portal_v2_directory_generations"),
      db.prepare("UPDATE portal_v2_folder_bindings SET source_version='legacy-backfill'"),
      db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants(id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,audience_source_version,reason_code,created_by_staff_id)
        VALUES ('delivery-a','delivery-a',1,'workspace-account-a','legacy-folder-folder-a','legacy-backfill','project','pa-project-a','legacy-backfill','test','staff')`),
      db.prepare("INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status) VALUES ('test-deny','workspace-account-a','identity-a','delivery.view','deny','project','pa-project-a','operations','revoked')"),
    ]);
    env={DELIVERY_DB:db,CLIENT_PORTAL_ENABLED:"true",CLIENT_PORTAL_HIERARCHY_V2_ENABLED:"false",CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:"true",
      AUTHENTICATED_DELIVERY_GRANTS_ENABLED:"false",CLIENT_PORTAL_ORIGIN:origin,ENVIRONMENT:"development",DELIVERY_SESSION_SECRET:"feedback-test-secret-abcdefghijklmnopqrstuvwxyz",
      PUBLIC_BULK_RATE_LIMITER:{limit:async()=>({success:true})} as RateLimit} as Env;
  },60_000);
  afterAll(async()=>runtime?.dispose());
  beforeEach(async()=>{
    await db.batch([
      db.prepare("UPDATE client_accounts SET status='active',project_alpha_organization_id=CASE WHEN id='account-a' THEN 'pa-org-a' ELSE 'pa-org-b' END"),db.prepare("UPDATE client_identity_links SET revoked_at=NULL,email='a@example.test' WHERE id='identity-a'"),
      db.prepare("UPDATE client_account_members SET role='manager',revoked_at=NULL"),db.prepare("UPDATE client_project_grants SET revoked_at=NULL"),
      db.prepare("UPDATE client_folder_associations SET revoked_at=NULL,account_id=CASE WHEN id='folder-b' THEN 'account-b' ELSE 'account-a' END"),
      db.prepare("UPDATE projects SET active=1,project_alpha_project_id=CASE WHEN id='project-a' THEN 'pa-project-a' ELSE 'pa-project-b' END"),
      db.prepare("INSERT OR REPLACE INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES (?,'etag-one',200,'2026-08-25T01:00:00Z','image/jpeg','image')").bind(storageKey),
      db.prepare("UPDATE portal_v2_identities SET status='active',revoked_at=NULL,verified_email='a@example.test' WHERE id='identity-a'"),
      // Earlier race tests intentionally invalidate bootstrap authority via
      // account root/status changes. Restore the complete test projection,
      // not only its membership rows, before testing another independent race.
      db.prepare("UPDATE portal_v2_workspaces SET status='active'"),
      db.prepare("UPDATE portal_v2_directory_entities SET active=1 WHERE source_version='legacy-backfill'"),
      db.prepare("UPDATE portal_v2_folder_bindings SET status='active',revoked_at=NULL WHERE source_type='legacy'"),
      db.prepare("UPDATE portal_v2_workspace_memberships SET status='active',revoked_at=NULL,expires_at=NULL"),
      db.prepare("UPDATE portal_v2_entitlements SET status=CASE WHEN id='test-deny' THEN 'revoked' ELSE 'active' END,revoked_at=NULL,expires_at=NULL"),
    ]);
  });
  const native=()=>({...env,CLIENT_PORTAL_HIERARCHY_V2_ENABLED:"true",AUTHENTICATED_DELIVERY_GRANTS_ENABLED:"true"});
  async function resolve(target:FeedbackTargetInput,settings:Env=env){
    const workspace=settings.CLIENT_PORTAL_HIERARCHY_V2_ENABLED==="true"?await resolveEffectivePortalWorkspaceContext(settings,principal,"workspace-account-a"):null;
    if(settings.CLIENT_PORTAL_HIERARCHY_V2_ENABLED==="true")expect(workspace).not.toBeNull();
    return resolveClientFeedbackTarget(settings,principal,session,workspace,target);
  }
  const file=async():Promise<FeedbackTargetInput>=>({kind:"file",projectId:"project-a",fileId:await createClientPortalFileHandle(env,storageKey)});
  const count=async()=>Number(await db.prepare("SELECT COUNT(*) n FROM client_feedback").first("n"));
  function router(actor:VerifiedClientPrincipal=principal){return createClientPortalRouter({resolvePrincipal:async()=>actor,repository:d1ClientPortalRepository,feedbackSchemaAvailable:async()=>true});}
  async function submit(target:FeedbackTargetInput,settings:Env=env,key=mutationKey()){
    return router().request(`${origin}/feedback`,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json","Idempotency-Key":key,
      ...(settings.CLIENT_PORTAL_HIERARCHY_V2_ENABLED==="true"?{"X-LTDS-Workspace-Id":"workspace-account-a"}:{})},body:JSON.stringify({target,message:"Please improve this area"})},settings);
  }

  it("resolves stable legacy project, folder and exact file targets without storing handles",async()=>{
    const project=await resolve({kind:"project",projectId:"project-a"});
    expect(project.target).toMatchObject({kind:"project",projectId:"project-a",associationId:null,label:"North site"});
    const folder=await resolve({kind:"folder",projectId:"project-a",folderId:await encodeProjectFolderHandle(env,"folder-a","edited/")});
    expect(folder.target).toMatchObject({associationId:"folder-a",relativePath:"edited/",storageKey:null});
    const exact=await resolve(await file());
    expect(exact.target).toMatchObject({associationId:"folder-a",storageKey,sourceOwner:{file:{etag:"etag-one",size:200}}});
    expect(exact.guard.bindings.length).toBeLessThanOrEqual(75);
    expect(exact.guard.sql.length).toBeLessThan(100_000);
    const saved=await createFeedbackRecord(db,exact,"A note",mutationKey());
    expect(JSON.stringify(saved.record.target)).not.toContain("cf1_");
    expect(await db.prepare("SELECT COUNT(*) n FROM client_project_grants").first("n")).toBe(2);
  });
  it("uses native current project and explicit authenticated folder authority",async()=>{
    const project=await resolve({kind:"project",projectId:"project-a"},native());
    expect(project.context.workspaceId).toBe("workspace-account-a");
    const exact=await resolve(await file(),native());
    expect(exact.target.sourceOwner.workspace?.rootPublicId).toBe("pa-org-a");
    expect(exact.guard.sql.length).toBeLessThan(100_000);expect(exact.guard.bindings.length).toBeLessThanOrEqual(75);
    expect((await createFeedbackRecord(db,exact,"Native file note",mutationKey())).record.status).toBe("new");
  });
  it("keeps versionless primary feedback snapshots byte-for-byte while new snapshots record source",async()=>{
    const authorization=await resolve({kind:"project",projectId:"project-a"});
    expect(authorization.target.sourceOwner).toMatchObject({version:2,account:{projectAlphaSourceId:"project-alpha:primary"},project:{projectAlphaSourceId:"project-alpha:primary"}});
    const legacy=structuredClone(authorization);
    delete legacy.target.sourceOwner.version;
    delete legacy.target.sourceOwner.account.projectAlphaSourceId;
    delete legacy.target.sourceOwner.project!.projectAlphaSourceId;
    const key=mutationKey();
    const created=await createFeedbackRecord(db,legacy,"Historical report",key);
    const before=await db.prepare("SELECT target_json,request_fingerprint FROM client_feedback WHERE id=?").bind(created.record.id).first();
    expect(await reauthorizeFeedbackRecipient(env,created.record)).not.toBeNull();
    const current=await resolve({kind:"project",projectId:"project-a"});
    expect(current.target.sourceOwner.version).toBe(2);
    expect(await createFeedbackRecord(db,current,"Historical report",key)).toMatchObject({record:{id:created.record.id},replayed:true});
    await expect(createFeedbackRecord(db,current,"Changed historical report",key)).rejects.toMatchObject({code:"idempotency_conflict"});
    expect(await db.prepare("SELECT target_json,request_fingerprint FROM client_feedback WHERE id=?").bind(created.record.id).first()).toEqual(before);
    expect(await db.prepare("SELECT count(*) n FROM client_feedback_events WHERE feedback_id=?").bind(created.record.id).first("n")).toBe(1);
  });
  it("does not create primary staff feedback for secondary parents with identical Alpha IDs",async()=>{
    const actor={issuer:principal.issuer,subject:"secondary-feedback",email:"secondary@example.test"};
    await db.batch([
      db.prepare("INSERT INTO client_accounts(id,display_name,status,project_alpha_organization_id,project_alpha_source_id) VALUES('secondary-feedback-account','Secondary','active','pa-org-a','project-alpha:secondary')"),
      db.prepare("INSERT INTO projects(id,project_alpha_project_id,client_name,project_name,r2_prefix,project_alpha_source_id) VALUES('secondary-feedback-project','pa-project-a','Secondary','Same external project','secondary-feedback/','project-alpha:secondary')"),
      db.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES('secondary-feedback-identity','secondary-feedback-account',?,?,?)").bind(actor.issuer,actor.subject,actor.email),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES('secondary-feedback-account','secondary-feedback-identity','manager')"),
      db.prepare("INSERT INTO client_project_grants(account_id,project_id) VALUES('secondary-feedback-account','secondary-feedback-project')"),
    ]);
    try {
      const before=await count();
      await expect(resolveClientFeedbackTarget(env,actor,{...session,accountId:"secondary-feedback-account",identityId:"secondary-feedback-identity"},null,
        {kind:"project",projectId:"secondary-feedback-project"})).rejects.toMatchObject({status:503});
      expect(await count()).toBe(before);
    } finally {
      await db.batch([
        db.prepare("DELETE FROM client_project_grants WHERE account_id='secondary-feedback-account'"),
        db.prepare("DELETE FROM client_account_members WHERE account_id='secondary-feedback-account'"),
        db.prepare("DELETE FROM client_identity_links WHERE id='secondary-feedback-identity'"),
        db.prepare("DELETE FROM projects WHERE id='secondary-feedback-project'"),
        db.prepare("DELETE FROM client_accounts WHERE id='secondary-feedback-account'"),
      ]);
    }
  });
  it("does not infer root delivery access from a project grant",async()=>{
    const fileId=await createClientPortalFileHandle(env,storageKey);
    await expect(resolve({kind:"file",projectId:null,fileId},native())).rejects.toMatchObject({status:404});
  });
  it("preserves the existing legacy/native media rollout gates without fallback",async()=>{
    await expect(resolve(await file(),{...native(),AUTHENTICATED_DELIVERY_GRANTS_ENABLED:"false"})).rejects.toMatchObject({status:404});
    await expect(resolve(await file(),{...env,AUTHENTICATED_DELIVERY_GRANTS_ENABLED:"true"})).rejects.toMatchObject({status:404});
  });
  it("rejects other account projects and encrypted handles outside current scope",async()=>{
    await expect(resolve({kind:"project",projectId:"project-b"})).rejects.toMatchObject({status:404});
    await expect(resolve({kind:"file",projectId:"project-a",fileId:await createClientPortalFileHandle(env,"clients/b/secret.jpg")})).rejects.toMatchObject({status:404});
    await expect(resolve({kind:"folder",projectId:"project-a",folderId:await encodeProjectFolderHandle(env,"folder-b","")})).rejects.toMatchObject({status:404});
  });
  it.each([
    "UPDATE client_accounts SET project_alpha_organization_id=NULL,project_alpha_client_id=NULL WHERE id='account-a'",
    "UPDATE projects SET project_alpha_project_id=NULL WHERE id='project-a'",
  ])("does not accept feedback staff cannot route without source mapping: %s",async(sql)=>{
    await db.prepare(sql).run();const before=await count();
    const response=await submit({kind:"project",projectId:"project-a"});
    expect(response.status).toBe(503);expect(await response.json()).toMatchObject({code:"feedback_target_unavailable"});
    expect(await count()).toBe(before);
  });
  it.each([
    "UPDATE client_accounts SET status='suspended' WHERE id='account-a'",
    "UPDATE client_account_members SET revoked_at=datetime('now') WHERE identity_id='identity-a'",
    "UPDATE client_project_grants SET revoked_at=datetime('now') WHERE project_id='project-a'",
    "UPDATE client_folder_associations SET account_id='account-b' WHERE id='folder-a'",
    "UPDATE file_index SET etag='replacement' WHERE r2_key='clients/a/north/edited/photo.jpg'",
  ])("fences live legacy authority/version changes inside the INSERT: %s",async(sql)=>{
    const authorized=await resolve(await file()),before=await count();
    const race={prepare:db.prepare.bind(db),batch:async<T>(statements:D1PreparedStatement[])=>{await db.prepare(sql).run();return db.batch<T>(statements)}};
    await expect(createFeedbackRecord(race,authorized,"Racing note",mutationKey())).rejects.toMatchObject({code:"changed"});
    expect(await count()).toBe(before);
  });
  it("fences a newly active native deny inside the INSERT",async()=>{
    const authorized=await resolve(await file(),native()),before=await count();
    const race={prepare:db.prepare.bind(db),batch:async<T>(statements:D1PreparedStatement[])=>{
      await db.prepare("UPDATE portal_v2_entitlements SET status='active' WHERE id='test-deny'").run();return db.batch<T>(statements)}};
    await expect(createFeedbackRecord(race,authorized,"Denied during submit",mutationKey())).rejects.toMatchObject({code:"changed"});
    expect(await count()).toBe(before);
  });
  it("retains creator history but never opens replacement or missing file bytes",async()=>{
    const authorized=await resolve(await file()),saved=await createFeedbackRecord(db,authorized,"Original file",mutationKey());
    await db.prepare("UPDATE file_index SET etag='replacement' WHERE r2_key=?").bind(storageKey).run();
    const replacement=await reauthorizeFeedbackRecipient(env,saved.record);
    expect(replacement?.authorization.available).toBe(false);
    expect(await clientFeedbackTargetActionPath(env,replacement!.authorization)).toBeNull();
    await db.prepare("DELETE FROM file_index WHERE r2_key=?").bind(storageKey).run();
    expect((await reauthorizeFeedbackRecipient(env,saved.record))?.authorization.available).toBe(false);
    await db.prepare("UPDATE client_folder_associations SET revoked_at=datetime('now') WHERE id='folder-a'").run();
    expect(await reauthorizeFeedbackRecipient(env,saved.record)).toBeNull();
  });
  it("uses exact current recipient identity and guards its email without Client handle secrets",async()=>{
    const saved=await createFeedbackRecord(db,await resolve(await file()),"Notice",mutationKey());
    const recipient=await reauthorizeFeedbackRecipient({DELIVERY_DB:db,CLIENT_PORTAL_HIERARCHY_V2_ENABLED:"false"},saved.record);
    expect(recipient?.email).toBe("a@example.test");
    await db.prepare("UPDATE client_identity_links SET email='new@example.test' WHERE id='identity-a'").run();
    expect(await db.prepare(`SELECT 1 ok WHERE ${recipient!.authorization.guard.sql}`).bind(...recipient!.authorization.guard.bindings).first("ok")).toBeNull();
    expect((await reauthorizeFeedbackRecipient(env,saved.record))?.email).toBe("new@example.test");
  });
  it("does not send to an email changed after recipient lookup but before authority capture",async()=>{
    const saved=await createFeedbackRecord(db,await resolve(await file()),"Email race",mutationKey());
    let changed=false;
    const racing=new Proxy(db,{get(target,property){
      if(property==="withSession")return ()=>{
        const primary=target.withSession("first-primary");
        return new Proxy(primary,{get(current,member){
          if(member==="prepare")return (sql:string)=>{
            const statement=current.prepare(sql);
            if(!sql.includes("SELECT issuer,subject,email FROM client_identity_links"))return statement;
            const wrap=(value:D1PreparedStatement):D1PreparedStatement=>new Proxy(value,{get(prepared,method){
              if(method==="bind")return (...values:(string|number|null)[])=>wrap(prepared.bind(...values));
              if(method==="first")return async(column?:string)=>{const row=column===undefined?await prepared.first():await prepared.first(column);
                if(!changed){changed=true;await db.prepare("UPDATE client_identity_links SET email='changed@example.test' WHERE id='identity-a'").run();}return row;};
              const item=Reflect.get(prepared,method);return typeof item==="function"?item.bind(prepared):item;
            }});return wrap(statement);
          };const item=Reflect.get(current,member);return typeof item==="function"?item.bind(current):item;
        }});
      };const item=Reflect.get(target,property);return typeof item==="function"?item.bind(target):item;
    }});
    expect(await reauthorizeFeedbackRecipient({...env,DELIVERY_DB:racing},saved.record)).toBeNull();expect(changed).toBe(true);
  });
  it("creates through the real mounted route and restricts details to the exact creator",async()=>{
    const key=mutationKey(),target=await file(),response=await submit(target,env,key);
    expect(response.status).toBe(201);
    const payload=await response.json() as {feedback:{id:string;target:{actionPath:string}}};
    expect(payload.feedback.target.actionPath).toContain("tab=files");expect(JSON.stringify(payload)).not.toContain(storageKey);
    expect((await submit(target,env,key)).status).toBe(200);
    expect((await router().request(`${origin}/feedback/${payload.feedback.id}`,{},env)).status).toBe(200);
    expect((await router({...principal,subject:"feedback-b",email:"b@example.test"}).request(`${origin}/feedback/${payload.feedback.id}`,{},env)).status).toBe(404);
  });
  it("lists only redacted exact-creator lifecycle history and binds continuation to actor and current authority",async()=>{
    const ids:string[]=[];
    for(let index=0;index<6;index++){
      const response=await submit({kind:"project",projectId:"project-a"},env,mutationKey());expect(response.status).toBe(201);
      ids.push((await response.json() as {feedback:{id:string}}).feedback.id);
    }
    const firstResponse=await router().request(`${origin}/feedback`,{},env);expect(firstResponse.status).toBe(200);
    const first=await firstResponse.json() as {scope:{sourceId:string;workspaceId:null;rootType:string;rootPublicId:string};asOf:string;
      items:Array<{feedbackId:string;events:Array<{action:string}>}>;nextCursor:string|null};
    expect(first.scope).toEqual({sourceId:"project-alpha:primary",workspaceId:null,rootType:"organization",rootPublicId:"pa-org-a"});
    expect(first.items.map(row=>row.feedbackId)).toEqual(expect.arrayContaining(ids.slice(-5)));
    expect(first.items.every(row=>row.events[0]?.action==="submitted")).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/Please improve this area|message|completionNote|actor|note/);
    expect(first.nextCursor).toMatch(/^fh1_/);
    const plan=await db.prepare(`EXPLAIN QUERY PLAN SELECT rowid,id,created_at FROM client_feedback INDEXED BY idx_client_feedback_author
      WHERE scope_key=? AND account_id=? AND principal_issuer=? AND principal_subject=? AND creator_identity_id=? AND rowid<=? AND created_at<=?
      ORDER BY created_at DESC,id DESC LIMIT 6`).bind("account:account-a","account-a",principal.issuer,principal.subject,"identity-a",Number.MAX_SAFE_INTEGER,new Date().toISOString()).all<{detail:string}>();
    expect(plan.results.some(row=>row.detail.includes("idx_client_feedback_author"))).toBe(true);
    const other=router({...principal,subject:"feedback-b",email:"b@example.test"});
    expect((await other.request(`${origin}/feedback?cursor=${encodeURIComponent(first.nextCursor!)}`,{},env)).status).toBe(409);
    await new Promise(resolve=>setTimeout(resolve,5));
    const oldest=await readFeedbackRecord(db,ids[0]!);expect(oldest).not.toBeNull();
    await transitionFeedbackRecord(db,oldest!,"staff",{expectedRevision:1,status:"done",note:"Completed after page one"},mutationKey(),{sql:"1",bindings:[]});
    const stable=await router().request(`${origin}/feedback?cursor=${encodeURIComponent(first.nextCursor!)}`,{},env);expect(stable.status).toBe(200);
    const stableItems=(await stable.json() as {items:Array<{feedbackId:string}>}).items;
    expect(stableItems.every(row=>!ids.includes(row.feedbackId))).toBe(true);
    await db.prepare("UPDATE client_project_grants SET revoked_at=datetime('now') WHERE project_id='project-a'").run();
    const revoked=await router().request(`${origin}/feedback?cursor=${encodeURIComponent(first.nextCursor!)}`,{},env);
    expect(revoked.status).toBe(200);expect((await revoked.json() as {items:unknown[]}).items).toEqual([]);
  });
  it("returns exact file metadata without touching media storage",async()=>{
    const target=await file();if(target.kind!=="file")throw new Error("fixture");
    const response=await router().request(`${origin}/files/${target.fileId}/metadata?projectId=project-a`,{},env);
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({projectId:"project-a",workspaceId:null,file:{name:"photo.jpg"}});
  });
  it.each([
    "UPDATE client_accounts SET project_alpha_organization_id=NULL,project_alpha_client_id=NULL WHERE id='account-a'",
    "UPDATE projects SET project_alpha_project_id=NULL WHERE id='project-a'",
  ])("preserves authorized metadata while feedback routing is unavailable: %s",async(sql)=>{
    await db.prepare(sql).run();const target=await file();if(target.kind!=="file")throw new Error("fixture");
    const response=await router().request(`${origin}/files/${target.fileId}/metadata?projectId=project-a`,{},env);
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({file:{id:target.fileId,name:"photo.jpg"}});
    expect((await submit(target)).status).toBe(503);
    expect((await router().request(`${origin}/feedback/target?target=${encodeURIComponent(JSON.stringify(target))}`,{},env)).status).toBe(503);
    expect((await router().request(`${origin}/files/${target.fileId}/metadata?projectId=project-b`,{},env)).status).toBe(404);
  });
  it("rejects malformed target JSON and fails closed without a limiter or correct origin",async()=>{
    expect((await router().request(`${origin}/feedback/target?target=%7B`,{},env)).status).toBe(400);
    const missingLimiter={...env};Object.defineProperty(missingLimiter,"PUBLIC_BULK_RATE_LIMITER",{value:undefined});
    expect((await submit({kind:"project",projectId:"project-a"},missingLimiter)).status).toBe(503);
    expect((await router().request(`${origin}/feedback`,{method:"POST",headers:{Origin:"https://other.test"}},env)).status).toBe(403);
  });
  it("does not apply feedback readiness to unrelated unknown client paths",async()=>{
    const unavailable=createClientPortalRouter({resolvePrincipal:async()=>principal,repository:d1ClientPortalRepository,feedbackSchemaAvailable:async()=>false});
    expect((await unavailable.request(`${origin}/not-a-route`,{},env)).status).toBe(404);
    expect((await unavailable.request(`${origin}/feedback`,{},env)).status).toBe(503);
  });
  it("lists and acknowledges only current creator completion notifications",async()=>{
    const saved=await createFeedbackRecord(db,await resolve({kind:"project",projectId:"project-a"}),"Done note",mutationKey());
    await transitionFeedbackRecord(db,saved.record,"staff",{expectedRevision:1,status:"done",note:"Handled"},mutationKey(),{sql:"1",bindings:[]});
    const response=await router().request(`${origin}/feedback-notifications`,{},env);
    expect(response.status).toBe(200);const payload=await response.json() as {notifications:{id:string;feedbackId:string}[]};
    const notification=payload.notifications.find(row=>row.feedbackId===saved.record.id);expect(notification).toBeDefined();
    const patch=await router().request(`${origin}/feedback-notifications/${notification!.id}`,{method:"PATCH",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({action:"dismiss"})},env);
    expect(patch.status).toBe(200);
    expect(await db.prepare("SELECT dismissed_at FROM client_feedback_notifications WHERE id=?").bind(notification!.id).first("dismissed_at")).not.toBeNull();
  });
});
