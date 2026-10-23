import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {DIAGNOSTIC_IDENTITIES,DIAGNOSTIC_REPORT_SHA256} from "./windows-files-schema-diagnostic-allowlist.mjs";
import {diagnosticSchemaQuery,selectDiagnosticDefinitions,diagnosticDefinitionSummary} from "./windows-files-schema-definition-diagnostic.mjs";
const row=app=>{const[type,name,tbl_name]=DIAGNOSTIC_IDENTITIES[app][0];return{type,name,tbl_name,sql:"CREATE TABLE synthetic(secret TEXT DEFAULT 'DO_NOT_PRINT_SQL')"};};
test("allowlist is exact frozen identities of reviewed report, not a caller filter",async()=>{
  const bytes=await readFile(new URL("../docs/staging/windows-staging-schema-drift-2026-10-22.json",import.meta.url));
  const lf=bytes.toString("utf8").replace(/\r\n/g,"\n");
  for(const variant of [lf,lf.replace(/\n/g,"\r\n")])
    assert.equal(createHash("sha256").update(variant.replace(/\r\n/g,"\n")).digest("hex"),DIAGNOSTIC_REPORT_SHA256);
  for(const worker of JSON.parse(bytes).workers){
    assert.deepEqual(DIAGNOSTIC_IDENTITIES[worker.app],["missing","extra","changed"].flatMap(k=>worker.objectDifferences[k]).map(({type,name,tbl_name})=>[type,name,tbl_name]));
    assert.ok(Object.isFrozen(DIAGNOSTIC_IDENTITIES[worker.app]));assert.ok(DIAGNOSTIC_IDENTITIES[worker.app].every(Object.isFrozen));
    const query=diagnosticSchemaQuery(worker.app);assert.ok(query.startsWith("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE "));
    assert.ok(query.endsWith(` ORDER BY type,name,tbl_name LIMIT ${DIAGNOSTIC_IDENTITIES[worker.app].length+1}`));
    assert.ok(!query.includes(";")&&!query.includes("SELECT *"));
  }
  for(const value of ["production","operations; DROP TABLE clients",null,{},"__proto__"])assert.throws(()=>diagnosticSchemaQuery(value),/definition_app_invalid/);
});
test("selected raw copies are frozen and independent of source and safe summaries contain hashes only",()=>{
  const original=row("operations"),selected=selectDiagnosticDefinitions("operations",[original]);
  assert.ok(Object.isFrozen(selected)&&Object.isFrozen(selected[0]));
  assert.throws(()=>{selected[0].sql="tampered";},TypeError);original.sql="source mutation";
  assert.match(selected[0].sql,/DO_NOT_PRINT_SQL/);const safe=diagnosticDefinitionSummary("operations",selected);
  assert.ok(!JSON.stringify(safe).includes("DO_NOT_PRINT_SQL"));assert.ok(!JSON.stringify(safe).includes("CREATE TABLE"));
  assert.match(safe.objects[0].sqlSha256,/^[a-f0-9]{64}$/);
});
test("strict selected response refuses extra objects, keys, duplicate identities and bounded SQL overflow",()=>{
  for(const rows of [[{...row("operations"),name:"clients"}], [{...row("operations"),extra:"DO_NOT_PRINT_SQL"}],
    [row("operations"),row("operations")], [{...row("operations"),sql:1}], [{...row("operations"),sql:"x".repeat(128*1024+1)}]])
    assert.throws(()=>selectDiagnosticDefinitions("operations",rows,{selectedOnly:true}),/definition_response_/);
  assert.throws(()=>selectDiagnosticDefinitions("operations",Array(4097).fill(row("operations"))),/definition_response_invalid/);
  assert.throws(()=>selectDiagnosticDefinitions("operations",DIAGNOSTIC_IDENTITIES.operations.slice(0,9).map(([type,name,tbl_name])=>({type,name,tbl_name,sql:"x".repeat(128*1024)})),{selectedOnly:true}),/definition_response_limit/);
  const [type,name,tbl_name]=DIAGNOSTIC_IDENTITIES.operations[0];
  const selected=selectDiagnosticDefinitions("operations",[{type,name,tbl_name,sql:null}]);
  assert.equal(diagnosticDefinitionSummary("operations",selected).objects[0].sqlSha256,null);
});
