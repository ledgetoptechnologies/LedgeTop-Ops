import {test} from "node:test";
import assert from "node:assert/strict";
import {STAGING_ACCOUNT_ID,STAGING_INVENTORY} from "./staging-requirements.mjs";
import {WINDOWS_STAGING_SECRET_SLOTS} from "./windows-files-staging-entry-renderer.mjs";
import {compareWindowsStagingSecretClone as compare} from "./windows-files-staging-secret-clone.mjs";

function fixture(app="operations") {
  const baselineVersionId="00000000-0000-4000-8000-000000000001",candidateVersionId="00000000-0000-4000-8000-000000000002";
  const bindings=[{name:"ENVIRONMENT",type:"plain_text",text:"staging"},{name:"PRIVATE_VALUE",type:"plain_text",text:"private-sentinel-do-not-echo"},
    {name:"OLD_SECRET",type:"secret_text"},{name:"ASSETS",type:"assets"},
    {name:"EXISTING_RESOURCE",type:"future-provider-resource",unknown_policy:{whole_object_must_match:[1,2]}}];
  const exports=app==="operations"?{ThumbnailRendererContainer:{type:"durable-object",storage:"sqlite"}}:{Reader:{type:"worker"}};
  const assets={config:{base_path:"/",html_handling:"auto-trailing-slash",not_found_handling:"single-page-application",run_worker_first:["/api/*"]}};
  const runtime={compatibility_date:"2026-07-22",compatibility_flags:["nodejs_compat"],assets:structuredClone(assets.config),exports,usage_model:"standard",
    ...(app==="operations"?{containers:[{class_name:"ThumbnailRendererContainer"}]}:{limits:{cpu_ms:300000,subrequests:25000}})};
  const version={id:baselineVersionId,number:3,annotations:{"workers/message":"old"},metadata:{source:"wrangler",created_on:"2026-10-23T00:00:00Z",author_id:"old-author",author_email:"synthetic@example.invalid",has_preview:false},resources:{script:{etag:"same-module-etag",handlers:["fetch"],named_handlers:[],last_deployed_from:"wrangler"},script_runtime:runtime,bindings}};
  const modern={id:baselineVersionId,number:3,startup_time_ms:12,compatibility_date:runtime.compatibility_date,compatibility_flags:runtime.compatibility_flags,
    main_module:"index.js",annotations:{"workers/message":"old"},exports,usage_model:"standard",...(app==="operations"?{containers:runtime.containers}:{limits:runtime.limits}),
    urls:[],source:"wrangler",created_on:"2026-10-23T00:00:00Z",author_id:"old-author",assets,
    modules:[{name:"index.js",content_type:"application/javascript+module",content_base64:Buffer.from("export default {fetch(){}};").toString("base64")},
      {name:"index.js.map",content_type:"application/json",content_base64:Buffer.from("{}").toString("base64")}],
    bindings:structuredClone(bindings),env:Object.fromEntries(bindings.map(({name,...binding})=>[name,structuredClone(binding)]))};
  const baseline=structuredClone({version,modern}),candidate=structuredClone(baseline);
  candidate.version.id=candidateVersionId;candidate.modern.id=candidateVersionId;candidate.version.number=4;candidate.modern.number=4;
  candidate.modern.startup_time_ms=13;candidate.modern.annotations={"workers/message":"secret-only candidate"};candidate.modern.urls=[{url:"https://new.invalid",kind:"version"}];
  candidate.modern.source="api";candidate.modern.created_on="2026-10-23T00:01:00Z";candidate.modern.author_id="new-author";
  candidate.version.metadata={source:"api",created_on:"2026-10-23T00:01:00Z",author_id:"new-author",author_email:"synthetic-new@example.invalid",has_preview:false};
  candidate.version.annotations={"workers/message":"secret-only candidate"};candidate.version.resources.script.last_deployed_from="api";
  for(const name of WINDOWS_STAGING_SECRET_SLOTS[app]) {
    candidate.version.resources.bindings.push({name,type:"secret_text"});candidate.modern.bindings.push({name,type:"secret_text"});candidate.modern.env[name]={type:"secret_text"};
  }
  return {app,accountId:STAGING_ACCOUNT_ID,workerName:STAGING_INVENTORY[app].name,baselineVersionId,candidateVersionId,
    plannedSecretNames:[...WINDOWS_STAGING_SECRET_SLOTS[app]],baseline,candidate};
}
test("actual-shaped paired responses allow only exact new secret slots while preserving bytes and policies",()=>{
  for(const app of ["operations","delivery"]) {
    const input=fixture(app),before=structuredClone(input),result=compare(input);
    assert.deepEqual(input,before);assert.equal(result.addedSecretCount,WINDOWS_STAGING_SECRET_SLOTS[app].length);
    assert.equal(result.returnedAssetsMetadataEqual,true);assert.equal(result.opaqueAssetAssociationVerified,false);
    assert.equal(result.authorized,false);assert.equal(result.physicallyVerified,false);assert.equal(result.freshnessVerified,false);
    assert.doesNotMatch(JSON.stringify(result),/private-sentinel|PRIVATE_VALUE|OLD_SECRET|content_base64/);
  }
});
const changes={
  "wrong account":f=>{f.accountId="other";},"wrong worker":f=>{f.workerName="other";},"wrong app":f=>{f.app="ops-sync";},
  "same version":f=>{f.candidateVersionId=f.baselineVersionId;},"malformed version":f=>{f.candidateVersionId="bad";},
  "mismatched response ID":f=>{f.candidate.modern.id=f.baselineVersionId;},
  "mismatched endpoint number":f=>{f.candidate.modern.number++;},
  "malformed old-version annotations":f=>{f.baseline.version.annotations=[];},
  "malformed candidate-version annotations":f=>{f.candidate.version.annotations=null;},
  "missing candidate-version annotations":f=>{delete f.candidate.version.annotations;},
  "object URLs instead of provider array":f=>{f.candidate.modern.urls={version:[]};},
  "unbounded URLs array":f=>{f.candidate.modern.urls=Array.from({length:101},()=>null);},
  "wrong planned secret":f=>{f.plannedSecretNames[0]="OTHER_SECRET";},"incomplete plan":f=>{f.plannedSecretNames.pop();},
  "module bytes":f=>{f.candidate.modern.modules[0].content_base64=Buffer.from("changed").toString("base64");},
  "module name":f=>{f.candidate.modern.modules[1].name="changed.map";},"module type":f=>{f.candidate.modern.modules[1].content_type="text/plain";},
  "module order":f=>{f.candidate.modern.modules.reverse();},"main module":f=>{f.candidate.modern.main_module="index.js.map";},
  "malformed base64":f=>{f.candidate.modern.modules[1].content_base64="a===";},
  "changed assets metadata":f=>{f.candidate.modern.assets.config.base_path="/changed";},
  "unknown changed assets field":f=>{f.candidate.modern.assets.extra="changed";},
  "changed runtime":f=>{f.candidate.version.resources.script_runtime.compatibility_flags.push("other");},
  "unknown runtime":f=>{f.candidate.version.resources.script_runtime.new_policy=true;},
  "changed export":f=>{f.candidate.modern.exports.NewClass={type:"worker"};},
  "changed handler":f=>{f.candidate.version.resources.script.handlers.push("scheduled");},
  "unknown resource field":f=>{f.candidate.version.resources.new_resource=true;},
  "old plain value":f=>{f.candidate.version.resources.bindings.find(b=>b.name==="PRIVATE_VALUE").text="changed";},
  "deleted old binding":f=>{f.candidate.version.resources.bindings.shift();},
  "unknown old binding policy":f=>{f.candidate.version.resources.bindings.find(b=>b.name==="EXISTING_RESOURCE").unknown_policy.whole_object_must_match.push(3);},
  "extra secret":f=>{f.candidate.version.resources.bindings.push({name:"EXTRA_SECRET",type:"secret_text"});},
  "wrong secret type":f=>{f.candidate.version.resources.bindings.at(-1).type="plain_text";},
  "secret with text":f=>{f.candidate.version.resources.bindings.at(-1).text="private-sentinel";},
  "changed env":f=>{f.candidate.modern.env.PRIVATE_VALUE.text="changed";},
  "extra env":f=>{f.candidate.modern.env.EXTRA={type:"secret_text"};},
  "secret env with contents":f=>{f.candidate.modern.env[WINDOWS_STAGING_SECRET_SLOTS.operations[0]].value="private-sentinel";},
  "duplicate binding":f=>{f.candidate.version.resources.bindings.push(f.candidate.version.resources.bindings[0]);},
};
for(const [name,change]of Object.entries(changes))test(`refuses ${name} with redacted error`,()=>{const input=fixture();change(input);assert.throws(()=>compare(input),e=>e.message==="windows_staging_secret_clone_inputs_invalid"&&!JSON.stringify(e).includes("private-sentinel"));});
function fillEnvironment(input,oldCount) {
  const current=input.baseline.version.resources.bindings.filter(b=>["plain_text","secret_text"].includes(b.type)).length;
  for(let i=current;i<oldCount;i++) for(const pair of [input.baseline,input.candidate]) {
    const binding={name:`FILLER_${i}`,type:"plain_text",text:"false"};pair.version.resources.bindings.push(structuredClone(binding));pair.modern.bindings.push(structuredClone(binding));pair.modern.env[binding.name]={type:"plain_text",text:"false"};
  }
}
test("128 environment budget refuses actual Ops126+3 shape without exposing values",()=>{
  const input=fixture();fillEnvironment(input,126);
  assert.throws(()=>compare(input),e=>e.message==="windows_staging_secret_clone_environment_budget_exceeded");
  const atLimit=fixture();fillEnvironment(atLimit,125);assert.equal(compare(atLimit).environmentCount,128);
  const client=fixture("delivery");fillEnvironment(client,99);assert.equal(compare(client).environmentCount,100);
});
test("old secret slots must be previously absent",()=>{const input=fixture();input.baseline.version.resources.bindings.push({name:input.plannedSecretNames[0],type:"secret_text"});assert.throws(()=>compare(input),/inputs_invalid/);});
for(const [label,change] of [
  ["missing modern assets",pair=>{delete pair.modern.assets;}],
  ["null modern assets",pair=>{pair.modern.assets=null;}],
  ["missing modern asset config",pair=>{delete pair.modern.assets.config;}],
  ["null modern asset config",pair=>{pair.modern.assets.config=null;}],
  ["missing runtime assets",pair=>{delete pair.version.resources.script_runtime.assets;}],
  ["null runtime assets",pair=>{pair.version.resources.script_runtime.assets=null;}],
]) test(`incomplete paired captures refuse even when both have ${label}`,()=>{
  const input=fixture();change(input.baseline);change(input.candidate);
  assert.throws(()=>compare(input),e=>e.message==="windows_staging_secret_clone_inputs_invalid");
});
