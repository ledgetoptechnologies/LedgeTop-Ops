import test from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {createHash} from "node:crypto";
import {schemaObjectDigests,compareSchemaObjectDigests} from "./windows-files-schema-object-digests.mjs";
const require=createRequire(new URL("../apps/client/package.json",import.meta.url));
const {Miniflare}=require("miniflare");
test("real local SQLite trigger/DDL changes are attributed without SQL export or normalization",async()=>{
 const mf=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {}",d1Databases:["DB"],outboundService:()=>{throw Error("No network")}});
 try{
  const db=await mf.getD1Database("DB"),query="SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name";
  await db.batch([db.prepare("CREATE TABLE example(value TEXT)"),db.prepare("CREATE INDEX example_index ON example(value)"),db.prepare("CREATE TRIGGER example_trigger BEFORE INSERT ON example BEGIN SELECT 1; END")]);
  const before=schemaObjectDigests((await db.prepare(query).all()).results);
  await db.batch([db.prepare("DROP TRIGGER example_trigger"),db.prepare("CREATE TRIGGER example_trigger BEFORE INSERT ON example BEGIN SELECT  1; END"),db.prepare("DROP INDEX example_index"),db.prepare("CREATE TABLE extra(value INTEGER)")]);
  const after=schemaObjectDigests((await db.prepare(query).all()).results),diff=compareSchemaObjectDigests(before,after);
  assert.deepEqual(diff.changed.map(r=>r.name),["example_trigger"]);assert.deepEqual(diff.missing.map(r=>r.name),["example_index"]);assert.deepEqual(diff.extra.map(r=>r.name),["extra"]);
  assert.equal(diff.canonicalBaselineVerified,false);assert.ok(!JSON.stringify(after).includes("SELECT  1"));
 }finally{await mf.dispose()}
});
test("metadata DDL and raw UTF-8 differences are never ignored; null SQL remains distinct",()=>{
 const original={type:"table",name:"d1_migrations",tbl_name:"d1_migrations",sql:"CREATE TABLE d1_migrations(name TEXT) -- é"};
 const a=schemaObjectDigests([original]),b=schemaObjectDigests([{...original,sql:original.sql.replace("TEXT","TIMESTAMP")}]);
 assert.equal(a.objects[0].sqlSha256,createHash("sha256").update(original.sql).digest("hex"));assert.equal(compareSchemaObjectDigests(a,b).changed.length,1);
 const c=schemaObjectDigests([{type:"index",name:"synthetic_autoindex",tbl_name:"d1_migrations",sql:null}]);assert.equal(c.objects[0].sqlSha256,null);
});
test("refuses duplicate/malformed/oversized object inventories and forged digest manifests",()=>{
 const row={type:"table",name:"x",tbl_name:"x",sql:"CREATE TABLE x(v)"};
 for(const value of [[row,row],[{...row,type:"unknown"}],[{...row,sql:5}],Array.from({length:4097},()=>row)])assert.throws(()=>schemaObjectDigests(value),/schema_object_digests_invalid/);
 const valid=schemaObjectDigests([row]);assert.throws(()=>compareSchemaObjectDigests(valid,{...valid,sha256:"0".repeat(64)}),/schema_object_digests_invalid/);
});

test("retained baseline-only local capture is pinned and matches prior full-replay checkpoints",async()=>{
 const{readFile}=await import("node:fs/promises");
 const raw=(await readFile(new URL("../docs/staging/windows-canonical-baseline-objects-local-2026-10-22.json",import.meta.url),"utf8")).replace(/\r\n/g,"\n");
 assert.equal(createHash("sha256").update(raw).digest("hex"),"ed0764cb744631c864d9ad64ba0f2edc6d4c824b0a8c31e415b16cddf0e0d515");
 const captured=JSON.parse(raw),full=JSON.parse(await readFile(new URL("../docs/staging/windows-canonical-baseline-local-2026-10-22.json",import.meta.url),"utf8"));
 for(const app of ["operations","delivery"]){
  assert.equal(captured.apps[app].checkpoints.length,1);
  const c=captured.apps[app].checkpoints[0],old=full.apps[app].checkpoints[0];
  assert.deepEqual([c.through,c.schemaSha256,c.schemaObjectCount,c.ledgerSha256],[old.through,old.schemaSha256,old.schemaObjectCount,old.ledgerSha256]);
  assert.equal(c.schemaObjectDigests.count,c.schemaObjectCount);
  assert.deepEqual(compareSchemaObjectDigests(c.schemaObjectDigests,c.schemaObjectDigests).changed,[]);
 }
});
