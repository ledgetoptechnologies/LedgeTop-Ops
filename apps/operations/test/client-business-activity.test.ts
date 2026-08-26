import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { businessActivityProjectionStatement, businessActivityObservationStatement, businessActivityRecencyCte,
  normalizeBusinessActivityTime } from "../src/worker/client-business-activity";
import { createProjectAlphaSourceContext, prepareProjectAlphaSourceRecords } from "../src/worker/project-alpha-source";
import type { SqlFilter } from "../src/worker/visibility";

const primary="project-alpha:primary", secondary="project-alpha:activity-test", asOf="2026-08-26T18:00:00.000Z";
let runtime:Miniflare, db:D1Database;
const preserved=new Map<string,Record<string,unknown>[]>();
const at="2026-01-02T03:04:05.000Z";
const id=()=>crypto.randomUUID();
const payload=(updated_at:unknown)=>JSON.stringify({updated_at,private_billing:{secret:"never in activity"}});
async function organization(key:string=id(),time:unknown=at){
  await db.prepare("INSERT INTO pa_organizations(id,name,payload_json,last_sync_id) VALUES(?,'Organization',?,'snapshot-fixture')")
    .bind(key,payload(time)).run(); return key;
}
async function client(org:string|null=null,key:string=id(),time:unknown=at){
  await db.prepare("INSERT INTO pa_clients(id,name,organization_id,payload_json,last_sync_id) VALUES(?,'Contact',?,?,'snapshot-fixture')")
    .bind(key,org,payload(time)).run(); return key;
}
async function project(org:string|null,person:string|null=null,key:string=id(),time:unknown=at){
  await db.prepare("INSERT INTO pa_projects(id,name,organization_id,client_id,payload_json,last_sync_id) VALUES(?,'Project',?,?,?,'snapshot-fixture')")
    .bind(key,org,person,payload(time)).run(); return key;
}
async function activity(key:string,kind:"organization"|"client"|"project",time:string,eventId=id(),source=primary,sourceTime=time){
  const statement=businessActivityProjectionStatement(db,{sourceId:source,eventId,recordKind:kind,recordId:key,
    action:"upsert",occurredAt:time,sourceUpdatedAt:sourceTime});
  if(!statement)throw new Error("fixture timestamp invalid");
  await db.batch([statement]); return eventId;
}
async function roots(filter:SqlFilter={sql:"p.active=1",values:[]},time=asOf){
  const query=businessActivityRecencyCte(filter,time);
  return (await db.prepare(`WITH ${query.sql} SELECT * FROM business_activity_roots ORDER BY source_id,root_kind,root_id`)
    .bind(...query.values).all<{source_id:string;root_kind:string;root_id:string;meaningful_activity_at:string}>()).results;
}
async function visibleEvents(root:string){
  const query=businessActivityRecencyCte({sql:"p.active=1",values:[]},asOf);
  return (await db.prepare(`WITH ${query.sql} SELECT * FROM business_activity_eligible WHERE root_id=? ORDER BY sequence`)
    .bind(...query.values,root).all<Record<string,unknown>>()).results;
}
async function revision(){return db.prepare("SELECT revision FROM client_business_activity_state WHERE singleton=1").first<number>("revision");}
async function count(key:string){return db.prepare("SELECT count(*) n FROM client_business_activity WHERE record_id=?").bind(key).first<number>("n");}

beforeAll(async()=>{
  runtime=new Miniflare({modules:true,script:"export default {fetch(){return new Response('activity')}}",d1Databases:["OPS_DB"]});
  db=await runtime.getD1Database("OPS_DB") as D1Database;
  const directory=resolve(import.meta.dirname,"../migrations");
  for(const name of (await readdir(directory)).filter(name=>/^\d+_.*\.sql$/.test(name)&&name<"0037_").sort())
    await db.batch(splitD1MigrationStatements(await readFile(resolve(directory,name),"utf8")).map(sql=>db.prepare(sql)));
  await organization("populated-organization");
  await client("populated-organization","populated-contact");
  await project("populated-organization","populated-contact","populated-project");
  await organization("missing-source-date",null);
  for(const table of ["pa_clients","pa_organizations","pa_projects","pa_projection_record_ids","staff_users","integration_event_receipts"])
    preserved.set(table,(await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all<Record<string,unknown>>()).results);
  await db.batch(splitD1MigrationStatements(await readFile(resolve(directory,"0037_client_business_activity.sql"),"utf8")).map(sql=>db.prepare(sql)));
},120_000);
afterAll(async()=>{await runtime?.dispose();});

describe("source-record activity: populated migration and real D1 producers",()=>{
  it("preserves every old source row and only backfills known source dates",async()=>{
    for(const [table,rows] of preserved)
      expect((await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results).toEqual(rows);
    const rows=(await db.prepare("SELECT * FROM client_business_activity ORDER BY sequence").all()).results;
    expect(rows).toHaveLength(3);expect(rows.every(row=>row.origin==="source_observation"&&row.occurred_at===at)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("private_billing");
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(await db.prepare("PRAGMA quick_check('client_business_activity')").first("quick_check")).toBe("ok");
  });
  it("normalizes strict UTC/offset source timestamps identically in SQL and JS, ignoring malformed/scalar dates",async()=>{
    const cases:unknown[]=["2026-01-02 03:04:05","2026-01-02T03:04:05.123456Z","2026-01-02T03:04:05.9999Z",
      "2026-01-02T03:04:05+02:30","2026-01-02T03:04:05.1","2026-02-30T01:01:01Z","2026-01-02T24:01:01Z",
      "2026-01-02T03:04:05Z ","2026-01-02TT03:04:05Z","2026-01-02T03:04:05.2.3Z","2026-01-02","now","",null,42,{date:at},
      "2026-01-02T03:04:05Z\u0000junk"];
    for(const value of cases){
      const key=await organization(id(),value);
      const row=await db.prepare("SELECT occurred_at FROM client_business_activity WHERE record_id=?").bind(key).first<{occurred_at:string}>();
      expect(row?.occurred_at??null,JSON.stringify(value)).toBe(normalizeBusinessActivityTime(value));
    }
  },30_000);
  it("does not bump activity/epoch for page reads, sync clocks, identical snapshots or observation retries",async()=>{
    const root=await organization();const before=await revision(),number=await count(root);
    await roots();await roots();
    await db.prepare("UPDATE pa_organizations SET updated_at=datetime('now'),last_sync_id='another-sync',payload_json=payload_json WHERE id=?").bind(root).run();
    await db.batch([businessActivityObservationStatement(db,primary,"organization",root)]);
    expect(await count(root)).toBe(number);expect(await revision()).toBe(before);
  });
  it("deduplicates event replay and event-then-snapshot same-version observations without losing event evidence",async()=>{
    const root=await organization(id(),null),version="2026-03-01T00:00:00.000Z",occurred="2026-03-01T00:05:00.000Z";
    const event=await activity(root,"organization",occurred,id(),primary,version);
    const before=await revision();await activity(root,"organization",occurred,event,primary,version);
    expect(await revision()).toBe(before);
    await db.prepare("UPDATE pa_organizations SET payload_json=?,last_sync_id='later-snapshot' WHERE id=?").bind(payload(version),root).run();
    expect(await count(root)).toBe(2);
    expect((await visibleEvents(root))[0]?.origin).toBe("projection_event");
  });
  it("supersedes a same-version observation in the read model, without rewriting immutable observation history",async()=>{
    const root=await organization(id(),"2026-03-02T00:00:00Z");
    await activity(root,"organization","2026-03-02T00:02:00Z",id(),primary,"2026-03-02T00:00:00Z");
    expect(await count(root)).toBe(2);
    const rows=await visibleEvents(root);expect(rows).toHaveLength(1);expect(rows[0]?.origin).toBe("projection_event");
  });
  it("keeps future-event/past-observation recency identical in either arrival order",async()=>{
    const version="2026-03-03T00:00:00Z";
    for(const eventFirst of [true,false]){
      const root=await organization(id(),eventFirst?null:version);
      await activity(root,"organization","2099-01-01T00:00:00Z",id(),primary,version);
      if(eventFirst)await db.prepare("UPDATE pa_organizations SET payload_json=? WHERE id=?").bind(payload(version),root).run();
      const rows=await visibleEvents(root);
      expect(rows).toHaveLength(1);expect(rows[0]?.origin).toBe("source_observation");
      expect(rows[0]?.occurred_at).toBe("2026-03-03T00:00:00.000Z");
    }
  });
  it("does not let an ineligible old-owner event suppress a new owner's independently captured observation",async()=>{
    const first=await organization(),second=await organization(),work=await project(first,null,id(),null);
    const version="2026-03-04T00:00:00Z";
    await activity(work,"project","2026-03-04T00:05:00Z",id(),primary,version);
    await db.prepare("UPDATE pa_projects SET organization_id=?,payload_json=?,last_sync_id='snapshot-moved' WHERE id=?")
      .bind(second,payload(version),work).run();
    const current=(await visibleEvents(second)).filter(row=>row.record_id===work);
    expect(current).toHaveLength(1);expect(current[0]?.origin).toBe("source_observation");
    expect((await visibleEvents(first)).some(row=>row.record_id===work)).toBe(false);
    // The once-per-version observation remains owned by its original recorded
    // root. Another move with that same date cannot borrow or rewrite it.
    await db.prepare("UPDATE pa_projects SET organization_id=?,payload_json=payload_json WHERE id=?").bind(first,work).run();
    const observation=await db.prepare("SELECT root_id FROM client_business_activity WHERE record_id=? AND origin='source_observation'").bind(work).first("root_id");
    expect(observation).toBe(second);
    expect((await visibleEvents(first)).filter(row=>row.record_id===work).map(row=>row.origin)).toEqual(["projection_event"]);
  });
  it("filters project permission before MAX, and excludes future records using frozen asOf",async()=>{
    const root=await organization(),hidden=await project(root),shown=await project(root);
    await activity(hidden,"project","2026-07-01T00:00:00Z");
    await activity(shown,"project","2026-06-01T00:00:00Z");
    await activity(root,"organization","2099-01-01T00:00:00Z");
    expect((await roots({sql:"p.id=?",values:[shown]})).find(row=>row.root_id===root)?.meaningful_activity_at).toBe("2026-06-01T00:00:00.000Z");
    expect((await roots({sql:"0=1",values:[]})).find(row=>row.root_id===root)?.meaningful_activity_at).toBe(at);
  });
  it("does not transfer old project or contact activity when a fallback client moves organizations",async()=>{
    const first=await organization(),second=await organization(),person=await client(first),work=await project(null,person);
    await activity(work,"project","2026-06-02T00:00:00Z");await activity(person,"client","2026-06-03T00:00:00Z");
    const before=await revision();
    await db.prepare("UPDATE pa_clients SET organization_id=? WHERE id=?").bind(second,person).run();
    expect(await revision()).toBeGreaterThan(before!);
    for(const root of [first,second]){
      expect((await roots()).find(row=>row.root_id===root)?.meaningful_activity_at).toBe(at);
      expect((await visibleEvents(root)).some(row=>row.record_id===work||row.record_id===person)).toBe(false);
    }
  });
  it("honors explicit project organization instead of the linked contact's organization",async()=>{
    const explicit=await organization(),contactRoot=await organization(),person=await client(contactRoot),work=await project(explicit,person);
    await activity(work,"project","2026-06-04T00:00:00Z");
    expect((await roots()).find(row=>row.root_id===explicit)?.meaningful_activity_at).toBe("2026-06-04T00:00:00.000Z");
    expect((await visibleEvents(contactRoot)).some(row=>row.record_id===work)).toBe(false);
  });
  it("repairs first snapshot child-before-owner observation after all rows exist, without fabricating missing dates",async()=>{
    const root=id(),person=await client(root),work=await project(root,person);
    expect(await count(person)).toBe(0);expect(await count(work)).toBe(0);
    await organization(root);
    await db.batch([businessActivityObservationStatement(db,primary,"client",person),businessActivityObservationStatement(db,primary,"project",work)]);
    expect(await count(person)).toBe(1);expect(await count(work)).toBe(1);
  });
  it("rolls row and event back together when the same transaction fails",async()=>{
    const root=await organization(id(),null),event=id(),before=await revision();
    const statement=businessActivityProjectionStatement(db,{sourceId:primary,eventId:event,recordKind:"organization",recordId:root,
      action:"upsert",occurredAt:at,sourceUpdatedAt:at})!;
    await expect(db.batch([db.prepare("UPDATE pa_organizations SET name='must rollback' WHERE id=?").bind(root),
      statement,db.prepare("INSERT INTO client_business_activity_state(singleton) VALUES(2)")])).rejects.toThrow();
    expect(await count(root)).toBe(0);expect(await revision()).toBe(before);
    expect(await db.prepare("SELECT name FROM pa_organizations WHERE id=?").bind(root).first("name")).toBe("Organization");
  });
  it("rejects a permanently reused event ID with changed evidence even after transient receipts are gone",async()=>{
    const root=await organization(id(),null),event=await activity(root,"organization",at);
    await expect(activity(root,"organization","2026-01-03T00:00:00Z",event)).rejects.toThrow("immutable");
    expect(await count(root)).toBe(1);
  });
  it("rejects UPDATE/DELETE/REPLACE rewrites and malformed canonical timestamps",async()=>{
    const root=await organization(),row=await db.prepare("SELECT * FROM client_business_activity WHERE record_id=?").bind(root).first<Record<string,unknown>>();
    expect(row).not.toBeNull();
    await expect(db.prepare("UPDATE client_business_activity SET occurred_at=? WHERE sequence=?").bind(at,row!.sequence).run()).rejects.toThrow("immutable");
    await expect(db.prepare("DELETE FROM client_business_activity WHERE sequence=?").bind(row!.sequence).run()).rejects.toThrow("immutable");
    const columns=Object.keys(row!),values=columns.map(column=>row![column]);
    await expect(db.prepare(`INSERT OR REPLACE INTO client_business_activity(${columns.join(",")}) VALUES(${columns.map(()=>"?").join(",")})`).bind(...values).run()).rejects.toThrow("immutable");
    for(const invalid of ["0000-invalid-invalid-time","2026-02-30T00:00:00.000Z"]){
      await expect(db.prepare(`INSERT INTO client_business_activity(projection_source_id,event_key,origin,record_kind,record_id,
        root_kind,root_id,root_record_kind,action,occurred_at,source_updated_at)
        VALUES(? ,?,'projection_event','organization',?,'organization',?,'organization','upsert',?,?)`)
        .bind(primary,id(),root,root,invalid,at).run()).rejects.toThrow();
    }
  });
  it("keeps equal external IDs and event IDs source-qualified; hidden sources never affect recency",async()=>{
    const external=id(),a=await organization(external,null);
    const map=await prepareProjectAlphaSourceRecords(db,createProjectAlphaSourceContext(secondary),[{kind:"organization",externalId:external}]);
    const b=map.get("organization",external);
    await db.prepare("INSERT INTO pa_organizations(projection_source_id,id,name,payload_json,last_sync_id) VALUES(?,?,'Hidden B','{}','event:fixture')").bind(secondary,b).run();
    const event=id();await activity(a,"organization",at,event);await activity(b,"organization",at,event,secondary);
    expect(a).not.toBe(b);expect(await count(a)).toBe(1);expect(await count(b)).toBe(1);
    expect((await roots()).some(row=>row.source_id===secondary)).toBe(false);
    await expect(db.prepare(`INSERT INTO client_business_activity(projection_source_id,event_key,origin,record_kind,record_id,
      root_kind,root_id,root_record_kind,action,occurred_at,source_updated_at)
      VALUES(?,?,'projection_event','organization',?,'organization',?,'organization','upsert',?,?)`)
      .bind(primary,id(),b,a,at,at).run()).rejects.toThrow();
  });
  it("invalidates activity pages on live assignment/ownership changes, not their sync metadata",async()=>{
    const root=await organization(),work=await project(root),user=id();
    await db.prepare("INSERT INTO pa_users(id,email,payload_json,last_sync_id) VALUES(?,'assigned@example.test','{}','fixture')").bind(user).run();
    let before=await revision();
    await db.prepare("INSERT INTO pa_project_assignments(id,project_id,user_id,payload_json,last_sync_id) VALUES(?,?,?,'{}','fixture')").bind(id(),work,user).run();
    expect(await revision()).toBeGreaterThan(before!);before=await revision();
    await db.prepare("UPDATE pa_project_assignments SET last_sync_id='noop' WHERE project_id=?").bind(work).run();
    expect(await revision()).toBe(before);
    await db.prepare("UPDATE pa_project_assignments SET active=0 WHERE project_id=?").bind(work).run();
    expect(await revision()).toBeGreaterThan(before!);
  });
  it("uses root/record chronology indexes for scoped bounded pages",async()=>{
    for(const [sql,index] of [
      ["SELECT sequence FROM client_business_activity WHERE projection_source_id=? AND root_kind=? AND root_id=? AND occurred_at<=? ORDER BY occurred_at DESC,sequence DESC LIMIT 26","idx_client_business_activity_root"],
      ["SELECT sequence FROM client_business_activity WHERE projection_source_id=? AND record_kind=? AND record_id=? AND occurred_at<=? ORDER BY occurred_at DESC,sequence DESC LIMIT 26","idx_client_business_activity_record"],
    ]){
      const plan=(await db.prepare("EXPLAIN QUERY PLAN "+sql).bind(primary,"organization","populated-organization",asOf).all()).results;
      expect(JSON.stringify(plan)).toContain(index);expect(JSON.stringify(plan)).not.toContain("TEMP B-TREE");
    }
  });
});
