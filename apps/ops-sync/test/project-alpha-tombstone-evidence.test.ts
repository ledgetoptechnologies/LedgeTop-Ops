import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_splitSqlQuery } from "wrangler";

let runtime:Miniflare,db:D1Database;

const migration=new URL("../../operations/migrations/0049_project_alpha_party_tombstones.sql",import.meta.url);
const sourceA="project-alpha:primary";
const sourceB="project-alpha:secondary";
const eventA="11111111-1111-4111-8111-111111111111";
const eventB="22222222-2222-4222-8222-222222222222";
const updatedAt="2026-08-30T18:59:00Z";
const occurredAt="2026-08-30T19:00:00Z";
const hashA="a".repeat(64);
function migrationStatements(sql:string):string[]{
  return unstable_splitSqlQuery(sql.replace(/\r\n/g,"\n")).map(statement=>statement.trim())
    .filter(statement=>statement&&!/^PRAGMA\s+foreign_keys\s*=\s*ON\s*;?$/i.test(statement));
}

async function insertEvidence(source:string,event:string,entity="70",at=updatedAt,hash=hashA){
  return db.prepare(`INSERT INTO pa_projection_tombstones
    (projection_source_id,event_id,entity_type,entity_id,source_updated_at,occurred_at,payload_hash)
    VALUES (?,?,?,?,?,?,?)`).bind(source,event,"client",entity,at,occurredAt,hash).run();
}

beforeAll(async()=>{
  runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",
    script:"export default {fetch(){return new Response('evidence')}}",d1Databases:["OPS_DB"]});
  db=await runtime.getD1Database("OPS_DB") as D1Database;
  await db.exec("CREATE TABLE legacy_projection(entity_id TEXT PRIMARY KEY,active INTEGER NOT NULL); INSERT INTO legacy_projection VALUES ('inactive',0),('active',1);");
  await db.batch(migrationStatements(readFileSync(migration,"utf8")).map(sql=>db.prepare(sql)));
});
afterAll(async()=>{await runtime?.dispose();});

describe("Project Alpha tombstone evidence migration",()=>{
  it("upgrades without inferring deletion from inactivity, snapshot absence, or existing rows",async()=>{
    expect((await db.prepare("SELECT * FROM legacy_projection ORDER BY entity_id").all()).results)
      .toEqual([{entity_id:"active",active:1},{entity_id:"inactive",active:0}]);
    expect(await db.prepare("SELECT count(*) AS total FROM pa_projection_tombstones").first("total")).toBe(0);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(await db.prepare("PRAGMA quick_check('pa_projection_tombstones')").first("quick_check")).toBe("ok");
  });

  it("stores only exact source/event/entity/timestamp/hash evidence and no PII columns",async()=>{
    const columns=(await db.prepare("PRAGMA table_info('pa_projection_tombstones')").all()).results
      .map(row=>String(row.name));
    expect(columns).toEqual(["projection_source_id","event_id","entity_type","entity_id",
      "source_updated_at","occurred_at","payload_hash","recorded_at"]);
    expect(columns).not.toEqual(expect.arrayContaining(["payload","data","name","email","phone","address"]));
    await insertEvidence(sourceA,eventA);
    expect(await db.prepare(`SELECT projection_source_id,event_id,entity_type,entity_id,
      source_updated_at,occurred_at,payload_hash FROM pa_projection_tombstones
      WHERE projection_source_id=? AND event_id=?`).bind(sourceA,eventA).first())
      .toEqual({projection_source_id:sourceA,event_id:eventA,entity_type:"client",entity_id:"70",
        source_updated_at:updatedAt,occurred_at:occurredAt,payload_hash:hashA});
  });

  it("is append-only, replay-safe, stale-duplicate-safe, and source-qualified",async()=>{
    await expect(insertEvidence(sourceA,eventA)).rejects.toThrow();
    await expect(insertEvidence(sourceA,eventB)).rejects.toThrow();
    await expect(db.prepare("UPDATE pa_projection_tombstones SET payload_hash=? WHERE projection_source_id=? AND event_id=?")
      .bind("b".repeat(64),sourceA,eventA).run()).rejects.toThrow("project alpha tombstone evidence is immutable");
    await expect(db.prepare("DELETE FROM pa_projection_tombstones WHERE projection_source_id=? AND event_id=?")
      .bind(sourceA,eventA).run()).rejects.toThrow("project alpha tombstone evidence is persistent");
    await insertEvidence(sourceB,eventA);
    expect(await db.prepare("SELECT count(*) AS total FROM pa_projection_tombstones WHERE event_id=?")
      .bind(eventA).first("total")).toBe(2);
  });

  it("rejects malformed identity, type, and digest evidence",async()=>{
    await expect(insertEvidence("other:primary",eventB,"71","2026-08-30T19:01:00Z")).rejects.toThrow();
    await expect(insertEvidence(sourceA,eventB,"71","2026-08-30T19:01:00Z","A".repeat(64))).rejects.toThrow();
    await expect(db.prepare(`INSERT INTO pa_projection_tombstones
      (projection_source_id,event_id,entity_type,entity_id,source_updated_at,occurred_at,payload_hash)
      VALUES (?,?,?,?,?,?,?)`).bind(sourceA,eventB,"password","71","2026-08-30T19:01:00Z",occurredAt,hashA).run()).rejects.toThrow();
  });
});
