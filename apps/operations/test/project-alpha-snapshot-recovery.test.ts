import { readFileSync,readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { registerProjectAlphaConnector,setProjectAlphaConnectorState,connectorFenceStatement,
  type ProjectAlphaConnectorProof } from "../src/worker/project-alpha-connectors";
import { getProjectAlphaSnapshotRecoveryStatus,runProjectAlphaSnapshotRecovery } from "../src/worker/project-alpha-snapshot-recovery";
import type { Env } from "../src/worker/types";

const primary="project-alpha:primary";
const key=(seed:number)=>btoa(String.fromCharCode(...new Uint8Array(32).fill(seed))).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
const credential=(seed:number)=>({snapshotApiKey:`private-api-key-${seed}`,eventCurrent:{keyId:"current",algorithm:"ed25519",value:key(seed)}});
const collections=["users","business_units","worker_business_units","clients","organizations","projects","project_assignments",
  "service_locations","application_entitlements","operations","operation_assignments","tasks","task_assignments","calendar_events"];
function page(name="Recovered",number=1,twoPages=false){return {generated_at:"2026-08-26T00:00:00Z",has_more:twoPages&&number===1,next_page:twoPages&&number===1?2:null,
  ...Object.fromEntries(collections.map(collection=>[collection,[]])),
  organizations:number===1?[{id:1,name,updated_at:"2026-08-25T00:00:00Z"}]:[],
  projects:number===2?[{id:2,name:"Recovered project",organization_id:1}]:[]};}
let runtime:Miniflare,db:D1Database,emptyDb:D1Database,env:Env,seed=1,scheduledAt=0;
let beforeMigration:unknown;
const sets:Record<string,ReturnType<typeof credential>>={primary:credential(1)};
const refresh=()=>{env.PROJECT_ALPHA_CONNECTOR_CREDENTIALS=JSON.stringify({version:1,sets});};
const tick=()=>{scheduledAt=Math.max(Date.now(),scheduledAt+1);return scheduledAt;};
async function source(name:string,active=true){
  sets[name]=credential(++seed);refresh();const sourceId=`project-alpha:${name}`;
  await registerProjectAlphaConnector(env,{sourceId,producerBindingId:name,snapshotOrigin:`https://${name}.example.test`,
    applicationKey:"ltds_ops",profile:"business_data",displayName:name,
    revision:{credentialRef:name,snapshotBasePath:"/alpha",accessIssuer:"https://access.example.test",accessAudience:"events",accessSubject:"service"}},"fixture");
  if(active)await setProjectAlphaConnectorState(env,sourceId,{expectedVersion:1,state:"active"},"fixture");
  return sourceId;
}
// These wrappers instrument actual D1 execution, not authority or projection.
function inspectDatabase(database:D1Database,beforeBatch?:(sql:string[])=>Promise<void>){
  let count=0;const originals=new WeakMap<D1PreparedStatement,D1PreparedStatement>(),texts=new WeakMap<D1PreparedStatement,string>();
  const wrapStatement=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>{
    const wrapped=new Proxy(statement,{get(target,property){
      if(property==="bind")return(...values:unknown[])=>wrapStatement(target.bind(...values),sql);
      const value=Reflect.get(target,property,target);
      return typeof value==="function"?(...args:unknown[])=>{count++;return Reflect.apply(value,target,args);}:value;
    }});originals.set(wrapped,statement);texts.set(wrapped,sql);return wrapped;
  };
  const proxy:D1Database=new Proxy(database,{get(target,property){
    if(property==="withSession")return()=>proxy;
    if(property==="prepare")return(sql:string)=>wrapStatement(target.prepare(sql),sql);
    if(property==="batch")return async <T>(statements:D1PreparedStatement[]):Promise<D1Result<T>[]>=>{
      await beforeBatch?.(statements.map(statement=>texts.get(statement)??""));count+=statements.length;
      return target.batch<T>(statements.map(statement=>originals.get(statement)??statement));
    };
    const value=Reflect.get(target,property,target);return typeof value==="function"?value.bind(target):value;
  }});return {db:proxy,count:()=>count};
}
async function noProjection(id:string){
  expect(await db.prepare("SELECT count(*) n FROM pa_projection_record_ids WHERE projection_source_id=?").bind(id).first("n")).toBe(0);
  expect(await db.prepare("SELECT count(*) n FROM pa_projection_fingerprints WHERE projection_source_id=?").bind(id).first("n")).toBe(0);
}
async function existingRows(){return Promise.all(["pa_connectors","pa_connector_revisions","pa_connector_signing_keys","staff_users"]
  .map(async table=>(await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results));}
beforeAll(async()=>{
  runtime=new Miniflare({modules:true,compatibilityDate:"2026-07-22",script:"export default {fetch(){return new Response('recovery')}}",d1Databases:["DB","EMPTY"]});
  db=await runtime.getD1Database("DB") as D1Database;
  emptyDb=await runtime.getD1Database("EMPTY") as D1Database;
  const directory=new URL("../migrations/",import.meta.url);
  for(const file of readdirSync(directory).filter(name=>/^\d+.*\.sql$/.test(name)&&!name.startsWith("0038_")).sort())
    await db.batch(splitD1MigrationStatements(readFileSync(new URL(file,directory),"utf8")).map(sql=>db.prepare(sql)));
  env={OPS_DB:db,PROJECT_ALPHA_BASE_URL:"https://primary.example.test",PROJECT_ALPHA_API_KEY:"primary-api",
    APPLICATION_KEY:"ltds_ops",PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY:key(1)} as unknown as Env;
  refresh();
  await registerProjectAlphaConnector(env,{sourceId:primary,producerBindingId:"primary",snapshotOrigin:"https://primary.example.test",
    applicationKey:"ltds_ops",profile:"primary_legacy",displayName:"Primary",revision:{credentialRef:"primary",snapshotBasePath:"/",
      accessIssuer:"https://access.example.test",accessAudience:"events",accessSubject:"service"}},"fixture");
  await setProjectAlphaConnectorState(env,primary,{expectedVersion:1,state:"active"},"fixture");
  await db.prepare("INSERT INTO staff_users(id,email,display_name) VALUES('preserved','staff@example.test','Preserved staff')").run();
  await source("recovery-existing",false);
  beforeMigration=await existingRows();
  await db.batch(splitD1MigrationStatements(readFileSync(new URL("0038_project_alpha_snapshot_recovery.sql",directory),"utf8")).map(sql=>db.prepare(sql)));
},120_000);
beforeEach(async()=>{
  await db.prepare("UPDATE pa_connectors SET state='suspended',version=version+1 WHERE profile='business_data' AND state='active'").run();
  await db.prepare("UPDATE pa_connectors SET state='active',version=version+1 WHERE source_id=? AND state='suspended'").bind(primary).run();
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
afterAll(async()=>{await runtime?.dispose();});

describe("durable secondary snapshot recovery",{timeout:60_000},()=>{
  it("upgrades populated registry without changing producer, key, revision or staff bytes",async()=>{
    expect(await existingRows()).toEqual(beforeMigration);
    expect((await getProjectAlphaSnapshotRecoveryStatus(db))?.find(row=>row.sourceId==="project-alpha:recovery-existing")?.status).toBe("never");
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    const plan=(await db.prepare("EXPLAIN QUERY PLAN SELECT id FROM pa_snapshot_recovery_attempts WHERE status='running' AND deadline_at<=unixepoch('now')*1000").all()).results;
    expect(JSON.stringify(plan)).toContain("idx_pa_snapshot_recovery_expired_running");
  });
  it("returns explicit never for pending sources, excludes primary and sanitizes stored errors",async()=>{
    const id=await source("recovery-pending",false);
    expect((await getProjectAlphaSnapshotRecoveryStatus(db))?.find(row=>row.sourceId===id)).toEqual({sourceId:id,lastAttemptAt:null,lastSuccessAt:null,
      nextAttemptAt:null,status:"never",errorCode:null,failureCount:0});
    await db.prepare("UPDATE pa_snapshot_recovery_sources SET error_code='private-secret-looking-code' WHERE source_id=?").bind(id).run();
    const status=await getProjectAlphaSnapshotRecoveryStatus(db);
    expect(status?.some(row=>row.sourceId===primary)).toBe(false);
    expect(status?.find(row=>row.sourceId===id)?.errorCode).toBe("project-alpha-recovery-failed");
  });
  it("never permits a scheduler claim to decorate primary or scalar compatibility authority",()=>{
    const proof:ProjectAlphaConnectorProof={mode:"legacy_primary",sourceId:primary,profile:"primary_legacy",revision:0,version:0,
      scheduledRecovery:{attemptId:"attempt",schedulerToken:"scheduler",leaseToken:"lease",primaryRevision:1,primaryVersion:1,deadlineAt:Date.now()+1000}};
    expect(()=>connectorFenceStatement(db,proof)).toThrow("Scheduled connector proof is invalid");
  });
  it("runs at most two sequential due sources with stable two-pass snapshots and no staff/Delivery authority",async()=>{
    const ids=await Promise.all([source("recovery-a"),source("recovery-b"),source("recovery-c")]);
    const before=(await db.prepare("SELECT * FROM staff_users").all()).results;
    const fetcher=vi.fn<typeof fetch>(async(input,init)=>{
      const url=new URL(String(input));expect(url.pathname).toBe("/alpha/api/v1/ops/snapshot");
      const ref=url.hostname.split(".")[0]!;expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${sets[ref]!.snapshotApiKey}`);
      return Response.json(page(url.hostname,Number(url.searchParams.get("page")),true));
    });vi.stubGlobal("fetch",fetcher);
    const measured=inspectDatabase(db),at=tick();
    expect(await runProjectAlphaSnapshotRecovery({...env,OPS_DB:measured.db},at)).toEqual({status:"completed",attempted:2,succeeded:2,failed:0,deferred:0});
    expect(measured.count()).toBeLessThanOrEqual(1000);expect(fetcher).toHaveBeenCalledTimes(8);
    expect(fetcher.mock.calls.map(([input])=>new URL(String(input)).hostname)).toEqual([
      ...Array(4).fill("recovery-a.example.test"),...Array(4).fill("recovery-b.example.test")]);
    expect((await db.prepare("SELECT * FROM staff_users").all()).results).toEqual(before);
    expect(await db.prepare("SELECT count(*) n FROM pa_application_entitlements").first("n")).toBe(0);
    // DELIVERY_DB deliberately absent: any accidental secondary use fails.
    const statuses=await getProjectAlphaSnapshotRecoveryStatus(db);
    for(const id of ids.slice(0,2)){
      const row=statuses!.find(value=>value.sourceId===id)!;expect(row.status).toBe("success");
      expect(Date.parse(row.nextAttemptAt!)-Date.parse(row.lastSuccessAt!)).toBe(86_400_000);
    }
    expect(statuses?.find(row=>row.sourceId===ids[2])?.status).toBe("never");
    expect((await runProjectAlphaSnapshotRecovery(env,at)).status).toBe("busy");
    expect((await runProjectAlphaSnapshotRecovery(env,at-1)).status).toBe("busy");
    expect((await runProjectAlphaSnapshotRecovery(env,tick())).succeeded).toBe(1);
    expect((await runProjectAlphaSnapshotRecovery(env,tick())).status).toBe("idle");
  });
  it("records missing credentials before fetch and does not starve a healthy later source",async()=>{
    const broken=await source("recovery-d-broken"),healthy=await source("recovery-e-healthy");
    const brokenRef=broken.slice("project-alpha:".length),saved=sets[brokenRef]!;delete sets[brokenRef];refresh();
    const fetcher=vi.fn<typeof fetch>(async()=>Response.json(page()));vi.stubGlobal("fetch",fetcher);
    try{
      expect(await runProjectAlphaSnapshotRecovery(env,tick())).toMatchObject({attempted:2,succeeded:1,failed:1});
      const status=await getProjectAlphaSnapshotRecoveryStatus(db),bad=status!.find(row=>row.sourceId===broken)!;
      expect(bad).toMatchObject({status:"failed",failureCount:1,errorCode:"connector_credentials_unavailable"});
      expect(bad.lastAttemptAt).not.toBeNull();expect(bad.nextAttemptAt).not.toBeNull();
      expect(status?.find(row=>row.sourceId===healthy)?.status).toBe("success");
      expect(fetcher).toHaveBeenCalledTimes(2);await noProjection(broken);
    }finally{sets[brokenRef]=saved;refresh();}
  });
  it("requires active registered primary and leaves pending/suspended secondaries alone",async()=>{
    await source("recovery-primary-paused");
    await db.prepare("UPDATE pa_connectors SET state='suspended',version=version+1 WHERE source_id=?").bind(primary).run();
    const fetcher=vi.fn<typeof fetch>();vi.stubGlobal("fetch",fetcher);
    expect((await runProjectAlphaSnapshotRecovery(env,tick())).status).toBe("idle");expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["primary","secondary","scheduler"])("fences a %s ownership/lease change in the first projection transaction",async(change)=>{
    const id=await source("recovery-race-"+change);let changed=false;
    const measured=inspectDatabase(db,async statements=>{
      if(!changed&&statements.some(sql=>sql.includes("INSERT INTO pa_organizations"))){
        changed=true;
        if(change==="scheduler")await db.prepare("UPDATE pa_snapshot_recovery_scheduler SET lease_token='replacement' WHERE id='secondary'").run();
        else await db.prepare("UPDATE pa_connectors SET version=version+1 WHERE source_id=?").bind(change==="primary"?primary:id).run();
      }
    });
    vi.stubGlobal("fetch",vi.fn<typeof fetch>(async()=>Response.json(page())));
    try{
      expect(await runProjectAlphaSnapshotRecovery({...env,OPS_DB:measured.db},tick())).toMatchObject({attempted:1,failed:1,succeeded:0});
      expect(changed).toBe(true);
      expect(await db.prepare("SELECT count(*) n FROM pa_organizations WHERE projection_source_id=?").bind(id).first("n")).toBe(0);
      expect(await db.prepare("SELECT count(*) n FROM pa_projection_fingerprints WHERE projection_source_id=?").bind(id).first("n")).toBe(0);
      if(change==="scheduler")expect(await db.prepare("SELECT lease_token FROM pa_snapshot_recovery_scheduler").first("lease_token")).toBe("replacement");
    }finally{if(change==="scheduler")await db.prepare("UPDATE pa_snapshot_recovery_scheduler SET lease_token=NULL,lease_until=NULL").run();}
  });
  it("defers a manual/event projection lease without fetching and preserves its owner",async()=>{
    const id=await source("recovery-busy");
    await db.prepare("INSERT INTO pa_projection_entity_leases(projection_source_id,entity_type,entity_id,owner_event_id,lease_until) VALUES(?,'integration_projection','project-alpha','manual',datetime('now','+10 minutes'))").bind(id).run();
    const fetcher=vi.fn<typeof fetch>();vi.stubGlobal("fetch",fetcher);
    expect(await runProjectAlphaSnapshotRecovery(env,tick())).toMatchObject({attempted:1,deferred:1,failed:0});
    expect(fetcher).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT owner_event_id FROM pa_projection_entity_leases WHERE projection_source_id=?").bind(id).first("owner_event_id")).toBe("manual");
  });
  it("fails a query-expensive snapshot before any mapping or projection and retains cleanup budget",async()=>{
    const id=await source("recovery-query-budget");const data={...page(),organizations:Array.from({length:250},(_,index)=>({id:index+1,name:"Organization"}))};
    vi.stubGlobal("fetch",vi.fn<typeof fetch>(async()=>Response.json(data)));
    const measured=inspectDatabase(db);
    expect(await runProjectAlphaSnapshotRecovery({...env,OPS_DB:measured.db},tick())).toMatchObject({attempted:1,failed:1});
    expect((await getProjectAlphaSnapshotRecoveryStatus(db))?.find(row=>row.sourceId===id)?.errorCode).toBe("project-alpha-recovery-query-budget");
    expect(measured.count()).toBeLessThan(1000);await noProjection(id);
    expect(await db.prepare("SELECT count(*) n FROM pa_projection_entity_leases WHERE projection_source_id=?").bind(id).first("n")).toBe(0);
  });
  it("stops a cumulative byte excess across individually valid pages before projection",async()=>{
    const id=await source("recovery-byte-budget");
    vi.stubGlobal("fetch",vi.fn<typeof fetch>(async input=>{
      const number=Number(new URL(String(input)).searchParams.get("page"));
      return Response.json({...page(),has_more:number<3,next_page:number<3?number+1:null,padding:"x".repeat(3*1024*1024)});
    }));
    expect(await runProjectAlphaSnapshotRecovery(env,tick())).toMatchObject({failed:1});await noProjection(id);
    expect((await getProjectAlphaSnapshotRecoveryStatus(db))?.find(row=>row.sourceId===id)?.errorCode).toBe("project-alpha-recovery-byte-budget");
  });
  it("checks the overall deadline without detached work and records a bounded failure",async()=>{
    const id=await source("recovery-deadline"),now=Date.now();
    vi.stubGlobal("fetch",vi.fn<typeof fetch>(async()=>{vi.spyOn(Date,"now").mockReturnValue(now+7*60_000);return Response.json(page());}));
    expect(await runProjectAlphaSnapshotRecovery(env,tick())).toMatchObject({failed:1});await noProjection(id);
    expect((await getProjectAlphaSnapshotRecoveryStatus(db))?.find(row=>row.sourceId===id)?.errorCode).toBe("project-alpha-recovery-time-budget");
  });
  it("returns null only for absent recovery migration, not unrelated database failures",async()=>{
    expect(await getProjectAlphaSnapshotRecoveryStatus(emptyDb)).toBeNull();
    const failure=new Proxy(db,{get(target,property){if(property==="withSession")throw new Error("D1_ERROR: storage unavailable");return Reflect.get(target,property,target);}});
    await expect(getProjectAlphaSnapshotRecoveryStatus(failure)).rejects.toThrow("storage unavailable");
  });
  it("does not present missing scheduler metadata as idle/busy or a healthy empty status",async()=>{
    const prior=await db.prepare("SELECT last_scheduled_at FROM pa_snapshot_recovery_scheduler WHERE id='secondary'").first<{last_scheduled_at:number}>();
    await db.prepare("DELETE FROM pa_snapshot_recovery_scheduler WHERE id='secondary'").run();
    try{
      await expect(getProjectAlphaSnapshotRecoveryStatus(db)).rejects.toThrow("snapshot-recovery-accounting-unavailable");
      await expect(runProjectAlphaSnapshotRecovery(env,tick())).rejects.toThrow("snapshot-recovery-accounting-unavailable");
    }finally{await db.prepare("INSERT INTO pa_snapshot_recovery_scheduler(id,last_scheduled_at) VALUES('secondary',?)").bind(prior!.last_scheduled_at).run();}
  });
  it("does not wait indefinitely for an upstream error body's cancellation",async()=>{
    const id=await source("recovery-cancel"),cancel=vi.fn(()=>new Promise<void>(()=>{}));
    vi.stubGlobal("fetch",vi.fn<typeof fetch>(async()=>new Response(new ReadableStream<Uint8Array>({cancel}),{status:503})));
    expect(await runProjectAlphaSnapshotRecovery(env,tick())).toMatchObject({failed:1});
    expect(cancel).toHaveBeenCalledTimes(3);await noProjection(id);
  });
  it("serializes genuinely concurrent scheduled invocations before either can fetch another source",async()=>{
    await source("recovery-concurrent");let enter!:()=>void,release!:()=>void,firstFetch=true;
    const entered=new Promise<void>(resolve=>{enter=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
    const fetcher=vi.fn<typeof fetch>(async()=>{if(firstFetch){firstFetch=false;enter();await released;}return Response.json(page());});
    vi.stubGlobal("fetch",fetcher);
    const at=tick(),first=runProjectAlphaSnapshotRecovery(env,at);
    await entered;
    try{
      expect((await runProjectAlphaSnapshotRecovery(env,at)).status).toBe("busy");
      expect((await runProjectAlphaSnapshotRecovery(env,tick())).status).toBe("busy");
    }finally{release();}
    expect(await first).toMatchObject({attempted:1,succeeded:1});expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("closes crashed expired claims once, preserves history, and applies a bounded retry delay",async()=>{
    const id=await source("recovery-crash"),at=Date.now(),attemptId=crypto.randomUUID();
    await db.batch([
      db.prepare("UPDATE pa_snapshot_recovery_sources SET status='running',attempt_id=?,lease_token='crashed',lease_until=?,last_attempt_at=? WHERE source_id=?")
        .bind(attemptId,at-2000,at-4000,id),
      db.prepare(`INSERT INTO pa_snapshot_recovery_attempts(id,source_id,scheduled_at,scheduler_token,lease_token,source_revision,source_version,
        primary_revision,primary_version,started_at,deadline_at,status) VALUES(?,?,?,'crashed','crashed',1,2,1,2,?,?,'running')`)
        .bind(attemptId,id,at-5000,at-4000,at-2000),
      db.prepare("UPDATE pa_snapshot_recovery_scheduler SET lease_token='crashed',lease_until=? WHERE id='secondary'").bind(at-2000),
    ]);
    const fetcher=vi.fn<typeof fetch>();vi.stubGlobal("fetch",fetcher);
    expect((await runProjectAlphaSnapshotRecovery(env,tick())).status).toBe("idle");
    expect(await db.prepare("SELECT status,error_code FROM pa_snapshot_recovery_attempts WHERE id=?").bind(attemptId).first()).toEqual({status:"failed",error_code:"lease_expired"});
    const state=(await getProjectAlphaSnapshotRecoveryStatus(db))!.find(row=>row.sourceId===id)!;
    expect(state).toMatchObject({status:"failed",errorCode:"lease_expired",failureCount:1});
    expect(Date.parse(state.nextAttemptAt!)).toBeGreaterThan(Date.now()+59*60_000);
    await runProjectAlphaSnapshotRecovery(env,tick());
    expect((await getProjectAlphaSnapshotRecoveryStatus(db))?.find(row=>row.sourceId===id)?.failureCount).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(db.prepare("UPDATE pa_snapshot_recovery_attempts SET source_version=3 WHERE id=?").bind(attemptId).run()).rejects.toThrow(/immutable/);
    await expect(db.prepare("INSERT OR REPLACE INTO pa_snapshot_recovery_sources(source_id) VALUES(?)").bind(id).run()).rejects.toThrow(/invalid/);
    const replacement=crypto.randomUUID();
    await db.prepare("UPDATE pa_snapshot_recovery_sources SET status='running',attempt_id=?,lease_token='crashed',lease_until=? WHERE source_id=?")
      .bind(replacement,at+60_000,id).run();
    try{
      await expect(db.prepare(`INSERT OR REPLACE INTO pa_snapshot_recovery_attempts(id,source_id,scheduled_at,scheduler_token,lease_token,
        source_revision,source_version,primary_revision,primary_version,started_at,deadline_at,status)
        SELECT ?,source_id,scheduled_at,scheduler_token,lease_token,source_revision,source_version,primary_revision,primary_version,
          started_at,deadline_at,'running' FROM pa_snapshot_recovery_attempts WHERE id=?`).bind(replacement,attemptId).run()).rejects.toThrow(/invalid/);
      expect(await db.prepare("SELECT status FROM pa_snapshot_recovery_attempts WHERE id=?").bind(attemptId).first("status")).toBe("failed");
    }finally{await db.prepare("UPDATE pa_snapshot_recovery_sources SET status='failed',lease_token=NULL,lease_until=NULL WHERE source_id=?").bind(id).run();}
  });
  it("honors the exact due boundary and increases failures without retrying on every tick",async()=>{
    const id=await source("recovery-due");
    const fetcher=vi.fn<typeof fetch>(async()=>new Response("unavailable",{status:503}));vi.stubGlobal("fetch",fetcher);
    await db.prepare("UPDATE pa_snapshot_recovery_sources SET next_attempt_at=unixepoch('now')*1000+60000 WHERE source_id=?").bind(id).run();
    expect((await runProjectAlphaSnapshotRecovery(env,tick())).attempted).toBe(0);
    await db.prepare("UPDATE pa_snapshot_recovery_sources SET next_attempt_at=unixepoch('now')*1000 WHERE source_id=?").bind(id).run();
    expect((await runProjectAlphaSnapshotRecovery(env,tick())).failed).toBe(1);
    expect((await runProjectAlphaSnapshotRecovery(env,tick())).attempted).toBe(0);
    await db.prepare("UPDATE pa_snapshot_recovery_sources SET next_attempt_at=unixepoch('now')*1000 WHERE source_id=?").bind(id).run();
    expect((await runProjectAlphaSnapshotRecovery(env,tick())).failed).toBe(1);
    const state=(await getProjectAlphaSnapshotRecoveryStatus(db))!.find(row=>row.sourceId===id)!;
    expect(state.failureCount).toBe(2);expect(Date.parse(state.nextAttemptAt!)-Date.parse(state.lastAttemptAt!)).toBeGreaterThanOrEqual(2*60*60_000);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
  it("cannot let an obsolete completion overwrite a replacement source head or release its scheduler token",async()=>{
    const id=await source("recovery-successor"),successor=crypto.randomUUID();let replaced=false;
    const measured=inspectDatabase(db,async statements=>{
      if(!replaced&&statements.some(sql=>sql.includes("UPDATE sync_runs SET status='success'"))){
        replaced=true;
        await db.batch([
          db.prepare("UPDATE pa_snapshot_recovery_scheduler SET lease_token='successor' WHERE id='secondary'"),
          db.prepare("UPDATE pa_snapshot_recovery_sources SET attempt_id=?,lease_token='successor',failure_count=7 WHERE source_id=?").bind(successor,id),
        ]);
      }
    });vi.stubGlobal("fetch",vi.fn<typeof fetch>(async()=>Response.json(page())));
    try{
      expect(await runProjectAlphaSnapshotRecovery({...env,OPS_DB:measured.db},tick())).toMatchObject({failed:1,succeeded:0});
      expect(await db.prepare("SELECT attempt_id,lease_token,failure_count,status FROM pa_snapshot_recovery_sources WHERE source_id=?").bind(id).first())
        .toEqual({attempt_id:successor,lease_token:"successor",failure_count:7,status:"running"});
      expect(await db.prepare("SELECT lease_token FROM pa_snapshot_recovery_scheduler").first("lease_token")).toBe("successor");
    }finally{
      await db.prepare("UPDATE pa_snapshot_recovery_scheduler SET lease_token=NULL,lease_until=NULL").run();
      await db.prepare("UPDATE pa_snapshot_recovery_sources SET status='deferred',lease_token=NULL,lease_until=NULL WHERE source_id=?").bind(id).run();
    }
  });
  it("rechecks current source authority after sync succeeds but before recovery success is committed",async()=>{
    const id=await source("recovery-finish-race");let changed=false;
    const measured=inspectDatabase(db,async statements=>{
      if(!changed&&statements.some(sql=>sql.includes("UPDATE pa_snapshot_recovery_attempts SET status="))
        &&statements.some(sql=>sql.includes("pa_connector_write_fences"))){
        changed=true;
        // The ordinary snapshot success transaction really has committed. Only
        // the separate recovery.finish success fence can reject this race.
        expect(await db.prepare("SELECT status FROM sync_runs WHERE projection_source_id=? ORDER BY started_at DESC LIMIT 1")
          .bind(id).first("status")).toBe("success");
        await db.prepare("UPDATE pa_connectors SET version=version+1 WHERE source_id=?").bind(id).run();
      }
    });vi.stubGlobal("fetch",vi.fn<typeof fetch>(async()=>Response.json(page())));
    expect(await runProjectAlphaSnapshotRecovery({...env,OPS_DB:measured.db},tick())).toMatchObject({attempted:1,failed:1,succeeded:0});
    expect(changed).toBe(true);
    expect((await getProjectAlphaSnapshotRecoveryStatus(db))?.find(row=>row.sourceId===id))
      .toMatchObject({status:"failed",lastSuccessAt:null,errorCode:"configuration_changed"});
    expect(await db.prepare("SELECT count(*) n FROM pa_snapshot_recovery_attempts WHERE source_id=? AND status='success'").bind(id).first("n")).toBe(0);
  });
  it("does not start new snapshot cleanup queries after the bounded cleanup deadline",async()=>{
    const id=await source("recovery-cleanup-deadline"),now=Date.now();let cleanupWrites=0;
    const measured=inspectDatabase(db,async statements=>{
      if(statements.some(sql=>sql.includes("UPDATE integration_health SET status='error'")))cleanupWrites++;
    });
    vi.stubGlobal("fetch",vi.fn<typeof fetch>(async()=>{
      // Beyond six normal minutes plus sixty cleanup seconds. Scheduler-owned
      // accounting remains possible; snapshot DB cleanup must not begin.
      vi.spyOn(Date,"now").mockReturnValue(now+8*60_000);return Response.json(page());
    }));
    expect(await runProjectAlphaSnapshotRecovery({...env,OPS_DB:measured.db},tick())).toMatchObject({failed:1});
    expect(cleanupWrites).toBe(0);await noProjection(id);
    expect(await db.prepare("SELECT status FROM sync_runs WHERE projection_source_id=?").bind(id).first("status")).toBe("running");
    expect((await getProjectAlphaSnapshotRecoveryStatus(db))?.find(row=>row.sourceId===id)?.status).toBe("failed");
    // The unrenewed snapshot lease is deliberately left for normal expiry;
    // this is not evidence of successful cleanup or a detached running promise.
    expect(await db.prepare("SELECT count(*) n FROM pa_projection_entity_leases WHERE projection_source_id=?").bind(id).first("n")).toBe(1);
  });
});
