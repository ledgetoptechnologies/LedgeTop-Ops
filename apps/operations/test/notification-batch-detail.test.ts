import { readFileSync, readdirSync } from "node:fs";
import { Hono } from "hono";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { getDeliveryNotificationBatch, registerNotificationCenterRoutes } from "../src/worker/notification-center";
import type { Env, StaffPrincipal } from "../src/worker/types";

const actor: StaffPrincipal = { id: "detail-staff", email: "detail@example.test", displayName: "Staff", accessSubject: "detail-subject", projectAlphaUserId: null };
let runtime: Miniflare, db: D1Database, ops: D1Database, env: Env;
async function grant(permission: string, effect = "allow", division: string | null = null) {
  await ops.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
    VALUES(?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),actor.id,permission,effect,division ? "division" : "global",division,division ?? "global",actor.id).run();
}
async function seed(status = "pending") {
  const id = crypto.randomUUID(), prefix = `Jobs/Clients/${id}/`, client = `client-${id}`, project = `project-${id}`;
  await ops.batch([
    ops.prepare("INSERT INTO pa_clients(id,name,payload_json,last_sync_id) VALUES(?,'Same customer','{}','fixture')").bind(client),
    ops.prepare("INSERT INTO pa_projects(id,client_id,name,payload_json,last_sync_id) VALUES(?,?,'Project','{}','fixture')").bind(project,client),
    ops.prepare("INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by) VALUES(?,'detail-division',?,'manual',?)").bind(project,prefix,actor.id),
  ]);
  await db.batch([
    db.prepare("INSERT INTO client_accounts(id,display_name,status,project_alpha_client_id,project_alpha_source_id) VALUES(?,'Same customer','active',?,'project-alpha:primary')").bind(id,client),
    db.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES(?,?,'https://issuer.test',?,'recipient@example.test')").bind(id,id,id),
    db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES(?,?,'manager')").bind(id,id),
    db.prepare("INSERT INTO client_folder_associations(id,scope_type,account_id,r2_prefix,logical_grant_id,division_id,created_by) VALUES(?,'client',?,?,?,'detail-division',?)")
      .bind(id,id,prefix+"Delivery/",id,actor.id),
    db.prepare("INSERT INTO client_folder_notification_preferences(logical_grant_id,account_id,recipient_identity_id,mode,updated_by) VALUES(?,?,?,'both',?)").bind(id,id,id,actor.id),
    db.prepare(`INSERT INTO client_folder_notification_batches(id,account_id,logical_grant_id,recipient_identity_id,association_id,status,revision,added_count,eligible_at)
      VALUES(?,?,?,?,?,?,7,40,datetime('now','+5 minutes'))`).bind(id,id,id,id,id,status),
  ]);
  return { id, project };
}
beforeAll(async () => {
  runtime = new Miniflare({ modules:true, script:"export default {fetch(){return new Response('ok')}}", d1Databases:["OPS_DB","DELIVERY_DB"] });
  ops = await runtime.getD1Database("OPS_DB") as D1Database;
  db = await runtime.getD1Database("DELIVERY_DB") as D1Database;
  for (const [database,directory] of [[ops,new URL("../migrations/",import.meta.url)],[db,new URL("../../client/migrations/",import.meta.url)]] as const)
    for (const file of readdirSync(directory).filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort())
      await database.batch(splitD1MigrationStatements(readFileSync(new URL(file,directory),"utf8")).map(sql=>database.prepare(sql)));
  await ops.batch([
    ops.prepare("INSERT INTO staff_users(id,email,display_name,access_subject) VALUES(?,?,?,?)").bind(actor.id,actor.email,actor.displayName,actor.accessSubject),
    ops.prepare("INSERT INTO divisions(id,name,code) VALUES('detail-division','Detail','detail')"),
  ]);
  env = { OPS_DB:ops,DELIVERY_DB:db,OPERATIONS_SESSION_SECRET:"notification-detail-secret-01234567890123456789",PUBLIC_BASE_URL:"https://ops.test" } as Env;
},120_000);
afterAll(async()=>runtime?.dispose());
beforeEach(async()=>{
  await ops.prepare("DELETE FROM staff_permission_overrides WHERE staff_id=?").bind(actor.id).run();
  for (const permission of ["audit","create","revoke"]) await grant(`delivery.share.${permission}`);
});

describe("exact notification batch read",()=>{
  it("locates the exact batch independently of duplicate names and more than one queue page",async()=>{
    const selected=await seed();
    await db.batch(Array.from({length:30},()=>db.prepare(`INSERT INTO client_folder_notification_batches
      (id,account_id,logical_grant_id,recipient_identity_id,association_id,status) VALUES(?,?,?,?,?,'sent')`)
      .bind(crypto.randomUUID(),selected.id,selected.id,selected.id,selected.id)));
    const result=await getDeliveryNotificationBatch(env,actor,selected.id);
    expect(result.item).toMatchObject({id:selected.id,status:"pending",revision:7,canSendNow:true,canCancel:true});
    expect(result.coverage).toBe("legacy_folder_changes");
    expect(JSON.stringify(result)).not.toMatch(/Jobs\/|logical_grant_id|lease_token|project_alpha_client_id/);
  },30_000);
  it.each(["processing","sent","cancelled","suppressed","failed"])("returns current %s status without stale actions",async status=>{
    const {id}=await seed();
    await db.prepare("UPDATE client_folder_notification_batches SET status=?,revision=8 WHERE id=?").bind(status,id).run();
    expect((await getDeliveryNotificationBatch(env,actor,id)).item).toMatchObject({id,status,revision:8,canSendNow:false,canCancel:false});
  });
  it("requires current division audit permission, without requiring mutation permission",async()=>{
    const {id}=await seed();
    await ops.prepare("DELETE FROM staff_permission_overrides WHERE staff_id=?").bind(actor.id).run();
    await grant("delivery.share.audit","allow","detail-division");
    expect((await getDeliveryNotificationBatch(env,actor,id)).item).toMatchObject({canSendNow:false,canCancel:false});
    await grant("delivery.share.audit","deny","detail-division");
    await expect(getDeliveryNotificationBatch(env,actor,id)).rejects.toMatchObject({status:404});
  });
  it("denies global audit revocation and current source-owner reassignment",async()=>{
    const {id,project}=await seed();
    await ops.prepare("UPDATE pa_projects SET client_id=NULL WHERE id=?").bind(project).run();
    await expect(getDeliveryNotificationBatch(env,actor,id)).rejects.toMatchObject({status:404});
    await grant("delivery.share.audit","deny");
    await expect(getDeliveryNotificationBatch(env,actor,id)).rejects.toMatchObject({status:403});
  });
  it("keeps auditable revoked-recipient history but no send eligibility",async()=>{
    const {id}=await seed();
    await db.prepare("UPDATE client_identity_links SET revoked_at=datetime('now') WHERE id=?").bind(id).run();
    expect((await getDeliveryNotificationBatch(env,actor,id)).item).toMatchObject({recipientEmail:null,canSendNow:false,canCancel:true});
  });
  it("rejects an observed dispatch race instead of returning stale pending actions",async()=>{
    const {id}=await seed();let raced=false,sessionId=0;const exactReadSessions=new Set<number>();
    const wrap=(statement:D1PreparedStatement,match:boolean):D1PreparedStatement=>new Proxy(statement,{get(target,key){
      if(key==="bind")return (...values:unknown[])=>wrap(target.bind(...values),match);
      if(key==="first" && match)return async()=>{
        const row=await target.first();
        if(!raced){raced=true;await db.prepare("UPDATE client_folder_notification_batches SET status='sent',revision=8 WHERE id=?").bind(id).run();}
        return row;
      };
      const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
    }});
    const raceDb=new Proxy(db,{get(target,key){
      if(key==="withSession")return ()=>{const currentSession=++sessionId;return new Proxy(db.withSession("first-primary"),{get(session,method){
        if(method==="prepare")return (sql:string)=>{const match=sql.startsWith("SELECT batch.*");if(match)exactReadSessions.add(currentSession);return wrap(session.prepare(sql),match);};
        const value=Reflect.get(session,method);return typeof value==="function"?value.bind(session):value;
      }});};
      const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
    }});
    await expect(getDeliveryNotificationBatch({...env,DELIVERY_DB:raceDb},actor,id)).rejects.toMatchObject({status:409});
    expect(exactReadSessions.size).toBe(2);
    expect((await getDeliveryNotificationBatch(env,actor,id)).item.status).toBe("sent");
  });
  it("offers only a GET detail route and performs no queue, receipt or audit writes",async()=>{
    const {id}=await seed();
    const app=new Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>();
    app.use("/api/*",async(c,next)=>{c.set("principal",actor);c.set("administrator",false);await next();});
    registerNotificationCenterRoutes(app);
    const before=await db.prepare("SELECT * FROM client_folder_notification_batches WHERE id=?").bind(id).first();
    const audit=await db.prepare("SELECT count(*) n FROM audit_log").first("n");
    const url=`https://ops.test/api/notifications/deliveries/${id}`;
    const response=await app.request(url,{},env);
    expect(response.status).toBe(200);expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await app.request(url,{method:"POST"},env)).status).toBe(404);
    expect((await app.request(url+"?view=pending",{},env)).status).toBe(400);
    expect(await db.prepare("SELECT * FROM client_folder_notification_batches WHERE id=?").bind(id).first()).toEqual(before);
    expect(await db.prepare("SELECT count(*) n FROM audit_log").first("n")).toBe(audit);
    expect(await db.prepare("SELECT count(*) n FROM client_folder_notification_batch_controls WHERE batch_id=?").bind(id).first("n")).toBe(0);
    await expect(getDeliveryNotificationBatch(env,actor,"missing-notification")).rejects.toMatchObject({status:404});
    await expect(getDeliveryNotificationBatch(env,actor,"bad/id")).rejects.toMatchObject({status:404});
  });
});
