import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile,readdir} from "node:fs/promises";
import {STAGING_ACCOUNT_ID} from "./staging-requirements.mjs";
import {readPinnedWindowsSchemaReference,verifyPinnedWindowsSchemaReferenceBytes,compareWindowsObservedSchemaAndLedger} from "./windows-files-canonical-comparison.mjs";
const sha=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const {reference}=await readPinnedWindowsSchemaReference();
function observed(ops=0,client=0){return{schemaVersion:1,status:"read_only_observed",schemaQuerySha256:reference.schemaQuerySha256,accountId:STAGING_ACCOUNT_ID,activated:false,migrationsApplied:false,
 workers:[...["operations","delivery"]].map((app,i)=>{const c=reference.apps[app].checkpoints[i===0?ops:client];return{app,migrations:{names:[...c.names],count:c.names.length,sha256:c.ledgerSha256,canonicalBaselineVerified:false},schemaSha256:c.schemaSha256,schemaObjectCount:c.schemaObjectCount,foreignKeyViolationCount:0}})}}
test("pins the complete local reference; modified bytes cannot become expected state",async()=>{
 const raw=await readFile(new URL("../docs/staging/windows-canonical-baseline-local-2026-10-22.json",import.meta.url),"utf8");
 assert.equal(verifyPinnedWindowsSchemaReferenceBytes(raw).reference.schemaVersion,1);
 assert.throws(()=>verifyPinnedWindowsSchemaReferenceBytes(raw.replace('"schemaVersion": 1','"schemaVersion": 2')),/canonical_reference_pin_mismatch/);
});
test("compares every exact ordered baseline/suffix checkpoint without upgrading canonical proof",async()=>{
 for(let ops=0;ops<4;ops++)for(let client=0;client<3;client++){
  const input=observed(ops,client),before=JSON.stringify(input),result=await compareWindowsObservedSchemaAndLedger(input);
  assert.equal(result.canonicalBaselineVerified,false);assert.equal(result.observedSchemaAndLedgerComparison.status,"matches_pinned_local_replay");
  assert.equal(JSON.stringify(input),before);assert.ok(result.observedSchemaAndLedgerComparison.workers.every(w=>w.ledgerMatches&&w.schemaMatches));
 }
});
test("missing early migration, reordered ledger or unreviewed suffix never match a named baseline",async()=>{
 for(const change of [names=>names.splice(4,1),names=>[names[0],names[1]]=[names[1],names[0]],names=>names.push("0999_unreviewed.sql")]){
  const input=observed(),w=input.workers[0];change(w.migrations.names);w.migrations.count=w.migrations.names.length;w.migrations.sha256=sha(w.migrations.names);
  const result=await compareWindowsObservedSchemaAndLedger(input);assert.equal(result.observedSchemaAndLedgerComparison.workers[0].status,"ledger_not_canonical_checkpoint");
 }
});
test("detects changed schema SQL fingerprints, extra objects and foreign-key failures",async()=>{
 for(const change of [w=>w.schemaSha256="0".repeat(64),w=>w.schemaObjectCount++,w=>w.foreignKeyViolationCount=1]){
  const input=observed();change(input.workers[1]);const result=await compareWindowsObservedSchemaAndLedger(input);
  assert.equal(result.observedSchemaAndLedgerComparison.status,"requires_review");assert.equal(result.canonicalBaselineVerified,false);
 }
});
test("supplied real staging summary differs: exact ledgers alone do not approve either schema",async()=>{
 const input=observed();Object.assign(input.workers[0],{schemaObjectCount:2403,schemaSha256:"90e1daff584a6f930c6e5922c24f042d9e6bda7acf12a7ca6dd31f400354825e"});
 Object.assign(input.workers[1],{schemaObjectCount:1158,schemaSha256:"66315f85873f39a4bd8cbd9b265dd7d4ad3e216111f0cb90d979ef2096f2623a"});
 const result=await compareWindowsObservedSchemaAndLedger(input);assert.equal(result.observedSchemaAndLedgerComparison.status,"requires_review");
 for(const w of result.observedSchemaAndLedgerComparison.workers)assert.deepEqual([w.ledgerMatches,w.schemaMatches],[true,false]);
});
test("rejects forged ledger digests, duplicate entries, wrong apps and invalid schema summaries",async()=>{
 for(const change of [o=>o.workers[0].migrations.sha256="f".repeat(64),o=>o.workers[0].migrations.names[1]=o.workers[0].migrations.names[0],
  o=>o.workers[1].app="operations",o=>o.workers[1]=null,o=>o.workers[0].schemaObjectCount=0,o=>o.workers[1].schemaSha256="not-sha",o=>o.accountId="other-account"]){
  const input=observed();change(input);await assert.rejects(compareWindowsObservedSchemaAndLedger(input),/canonical_observation/);
 }
});
test("reference source inventory matches every current LF-normalized migration byte",async()=>{
 for(const[app,p]of Object.entries(reference.apps)){
  const folder=new URL(`../apps/${app==="delivery"?"client":"operations"}/migrations/`,import.meta.url),final=p.checkpoints.at(-1).through;
  const names=(await readdir(folder)).filter(n=>/^\d{4}_.+\.sql$/.test(n)&&n<=final).sort();
  const inventory=await Promise.all(names.map(async n=>[n,createHash("sha256").update((await readFile(new URL(n,folder),"utf8")).replace(/\r\n/g,"\n")).digest("hex")]));
  assert.equal(sha(inventory),p.sourceInventorySha256);assert.equal(names.length,p.sourceCount);
 }
});

test("requires exact declared observation query scope before reporting replay matches",async()=>{
 for(const digest of [undefined,"0".repeat(64),createHash("sha256").update("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name").digest("hex")]){
  const input=observed();input.schemaQuerySha256=digest;const result=await compareWindowsObservedSchemaAndLedger(input);
  assert.equal(result.observedSchemaAndLedgerComparison.status,"requires_review");assert.equal(result.observedSchemaAndLedgerComparison.queryScopeVerified,false);
  assert.ok(result.observedSchemaAndLedgerComparison.workers.every(w=>w.status==="query_scope_unverified"));
 }
 const valid=await compareWindowsObservedSchemaAndLedger(observed());assert.equal(valid.observedSchemaAndLedgerComparison.queryScopeVerified,true);
 const invalid=observed();invalid.schemaQuerySha256="not-sha";await assert.rejects(compareWindowsObservedSchemaAndLedger(invalid),/canonical_observation_invalid/);
});
