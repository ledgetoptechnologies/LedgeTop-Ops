import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from "./staging-requirements.mjs";
import { WINDOWS_STAGING_SECRET_SLOTS } from "./windows-files-staging-composition.mjs";
import { prepareWindowsStagingInheritedUpload as prepare, compareWindowsStagingInheritedCandidate as compare } from "./windows-files-staging-inherited-upload.mjs";

const APPS = ["operations", "delivery"], VERSION = "00000000-0000-4000-8000-000000000002";
function fixture() {
  const issuer = "https://ledgetoptechnologies.cloudflareaccess.com";
  const origins = { operations: "https://ops-staging.ledgetopdroneservices.com", delivery: "https://portal-staging.ledgetopdroneservices.com" };
  const auds = { operations: "559cd7c0d2cc47f271aac422412fce677a51443ec365d9f2c585d9c0e377cc0b", delivery: "8eed2de9972afe7d653de2adb68c1b0ef7c6462a9a694203b31d9a32f4248bbc" };
  const input = { sources: {}, versionDetails: {}, snapshotRefs: {}, preflight: { status: "read_only_observed", accountId: STAGING_ACCOUNT_ID, versionBindingsMatchedInventory: true, workers: [] },
    profile: { schemaVersion: 1, enabled: false, gateway: { origin: "https://synthetic-files-staging.ledgetopdroneservices.com", gatewayId: "00000000-0000-4000-8000-000000000001", keyId: "synthetic" }, secretSlots: structuredClone(WINDOWS_STAGING_SECRET_SLOTS) } };
  for (const app of APPS) {
    const inventory = STAGING_INVENTORY[app];
    const vars = { ENVIRONMENT: "staging", TEAM_DOMAIN: issuer, CURRENT_ONLY: "private-sentinel-do-not-echo", FEATURE: "false", EMPTY: "",
      ...(app === "operations" ? { PUBLIC_BASE_URL: origins.operations, EXPECTED_HOST: new URL(origins.operations).host, OPERATIONS_AUD: auds.operations }
        : { CLIENT_PORTAL_ORIGIN: origins.delivery, CLIENT_ACCESS_TEAM_DOMAIN: issuer, CLIENT_ACCESS_AUD: auds.delivery }) };
    input.sources[app] = { ...structuredClone(inventory), account_id: STAGING_ACCOUNT_ID, workers_dev: false, preview_urls: false, vars: { ...vars, TEMPLATE_ONLY: "remove" } };
    const bindings = [ ...Object.entries(vars).map(([name,text]) => ({ name,type:"plain_text",text })),
      ...inventory.d1_databases.map(b => ({ name:b.binding,type:"d1",id:b.database_id })),
      ...inventory.r2_buckets.map(b => ({ name:b.binding,type:"r2_bucket",bucket_name:b.bucket_name })),
      ...inventory.services.map(b => ({ name:b.binding,type:"service",service:b.service,entrypoint:b.entrypoint })),
      {name:"ASSETS",type:"assets"},{name:"OLD_SECRET",type:"secret_text"},
      {name:"EMAIL",type:"send_email",destination_address:"synthetic@example.invalid"},
      {name:"RATELIMITER",type:"ratelimit",namespace_id:"123",simple:{limit:3,period:60}},
      {name:"WORKFLOW",type:"workflow",workflow_name:"existing-synthetic-workflow",class_name:"ExistingWorkflow"} ];
    if (app === "operations") bindings.push({name:"THUMBNAIL_RENDERER",type:"durable_object_namespace",class_name:"ThumbnailRendererContainer",namespace_id:"a".repeat(32)});
    const runtime = { compatibility_date:inventory.compatibility_date,compatibility_flags:[...inventory.compatibility_flags],usage_model:"standard",
      assets: {not_found_handling:"single-page-application",serve_directly:true,raw_run_worker_first:["/api/*","!/assets/*"],static_routing:{user_worker:["/api/*"],asset_worker:["/assets/*"]},base_path:"/",
        ...(app === "delivery" ? {html_handling:"auto-trailing-slash"} : {})},
      exports: app === "operations" ? {SharedProfilePortalIngress:{type:"worker"},ThumbnailRendererContainer:{type:"durable-object",storage:"sqlite"}}
        : {SharedProfilePortalAuthorityReader:{type:"worker"}},
      ...(app === "operations" ? {containers:[{class_name:"ThumbnailRendererContainer"}]} : {limits:{cpu_ms:300000,subrequests:25000}}) };
    input.versionDetails[app]={accountId:STAGING_ACCOUNT_ID,workerName:inventory.name,detail:{id:VERSION,resources:{bindings,script_runtime:runtime}}};
    input.snapshotRefs[app]={accountId:STAGING_ACCOUNT_ID,workerName:inventory.name,latestUploadedVersionId:VERSION,activeDeployment:{versions:[{version_id:VERSION,percentage:100}]}};
    input.preflight.workers.push({app,workerName:inventory.name,versionId:VERSION,origin:origins[app],issuer,audience:auds[app],foreignKeyViolationCount:0,migrations:{status:"suffix_pending"},
      databases:inventory.d1_databases.map(b=>({binding:b.binding,name:b.database_name,id:b.database_id})),buckets:inventory.r2_buckets.map(b=>({binding:b.binding,name:b.bucket_name})),
      services:inventory.services.map(b=>({binding:b.binding,workerName:b.service,entrypoint:b.entrypoint})),secretSlots:["OLD_SECRET"]});
  }
  return input;
}
function candidate(input) {
  return Object.fromEntries(APPS.map(app=>[app,{...structuredClone(input.versionDetails[app]),detail:{...structuredClone(input.versionDetails[app].detail),id:"00000000-0000-4000-8000-000000000003"}}]));
}
test("inactive preparation preserves live variables, explicitly inherits resources, and omits nonversioned settings",()=>{
  const input=fixture(),before=structuredClone(input),result=prepare(input);
  assert.deepEqual(input,before);
  for(const app of APPS) {
    const upload=result.uploads[app],metadata=upload.unsafe.metadata;
    assert.deepEqual(Object.keys(upload).sort(),["account_id","compatibility_date","compatibility_flags","main","name","unsafe","vars"]);
    assert.equal(upload.vars.CURRENT_ONLY,"private-sentinel-do-not-echo");assert.equal(upload.vars.FEATURE,"false");assert.equal(upload.vars.EMPTY,"");
    assert.equal(Object.hasOwn(upload.vars,"TEMPLATE_ONLY"),false);
    assert.deepEqual(upload.unsafe.bindings,input.versionDetails[app].detail.resources.bindings.filter(b=>b.type!=="plain_text").map(b=>({name:b.name,type:"inherit"})));
    assert.deepEqual(metadata.keep_bindings,[]);assert.equal(metadata.keep_assets,true);
    assert.deepEqual(metadata.assets.config.run_worker_first,["/api/*","!/assets/*"]);
    assert.equal(Object.hasOwn(metadata.assets,"jwt"),false);assert.equal(Object.hasOwn(metadata.assets.config,"static_routing"),false);
    assert.deepEqual(result.promotions[app],{name:input.sources[app].name,account_id:STAGING_ACCOUNT_ID});
    assert.match(result.entries[app],/enabled.*false/);
  }
  assert.deepEqual(result.uploads.operations.unsafe.metadata.containers,[{class_name:"ThumbnailRendererContainer"}]);
  assert.deepEqual(result.uploads.delivery.unsafe.metadata.limits,{cpu_ms:300000,subrequests:25000});
  assert.doesNotMatch(JSON.stringify(result.receipt),/private-sentinel|CURRENT_ONLY|OLD_SECRET/);
  assert.equal(result.receipt.uploadAuthorized,false);assert.equal(result.receipt.promotionAuthorized,false);
});
test("asset request omits deprecated serve_directly without mutating or normalizing raw readback",()=>{
  const input=fixture(),before=structuredClone(input),result=prepare(input);
  for(const app of APPS) {
    const config=result.uploads[app].unsafe.metadata.assets.config;
    assert.equal(input.versionDetails[app].detail.resources.script_runtime.assets.serve_directly,true);
    assert.equal(Object.hasOwn(config,"serve_directly"),false);
    assert.deepEqual(config.run_worker_first,["/api/*","!/assets/*"]);
    assert.equal(compare(input,candidate(input)).assetsRoutingCompared,true);
    const changed=candidate(input);
    delete changed[app].detail.resources.script_runtime.assets.serve_directly;
    assert.throws(()=>compare(input,changed),/inputs_invalid/);
    changed[app].detail.resources.script_runtime.assets.serve_directly=false;
    assert.throws(()=>compare(input,changed),/inputs_invalid/);
  }
  assert.deepEqual(input,before);
  const falseInput=fixture();
  for(const app of APPS) falseInput.versionDetails[app].detail.resources.script_runtime.assets.serve_directly=false;
  const falseBefore=structuredClone(falseInput),falseResult=prepare(falseInput);
  for(const app of APPS) assert.equal(Object.hasOwn(falseResult.uploads[app].unsafe.metadata.assets.config,"serve_directly"),false);
  assert.deepEqual(falseInput,falseBefore);
});

test("actual inactive comparison is required but never grants activation or proves code/asset association",()=>{
  const input=fixture(),result=compare(input,candidate(input));
  assert.equal(result.status,"supplied_inactive_resources_match");assert.equal(result.promotionAuthorized,false);assert.equal(result.codeVerified,false);assert.equal(result.assetAssociationVerified,false);
});
test("Wrangler routing and API omission of empty asset-worker array are losslessly accepted",()=>{
  const input=fixture();
  for(const app of APPS) {
    const assets=input.versionDetails[app].detail.resources.script_runtime.assets;
    assets.raw_run_worker_first=["/api/*"];
    assets.static_routing={asset_worker:[],user_worker:["/api/*"]};
  }
  const result=prepare(input);
  for(const app of APPS) assert.deepEqual(result.uploads[app].unsafe.metadata.assets.config.run_worker_first,["/api/*"]);
  assert.equal(compare(input,candidate(input)).assetsRoutingCompared,true);
  for(const app of APPS) delete input.versionDetails[app].detail.resources.script_runtime.assets.static_routing.asset_worker;
  assert.deepEqual(prepare(input).uploads.operations.unsafe.metadata.assets.config.run_worker_first,["/api/*"]);
  assert.equal(compare(input,candidate(input)).assetsRoutingCompared,true);
  const changed=candidate(input);changed.operations.detail.resources.script_runtime.assets.static_routing.asset_worker=[];
  assert.throws(()=>compare(input,changed),/inputs_invalid/);
  input.versionDetails.operations.detail.resources.script_runtime.assets.static_routing.unknown=[];
  assert.throws(()=>prepare(input),/inputs_invalid/);
});
test("enabled composition retains original admission gates and allows only its documented Ops abort flag addition",()=>{
  const input=fixture();input.profile.enabled=true;
  assert.throws(()=>prepare(input),/inputs_invalid/);
  for(const app of APPS) {
    input.preflight.workers.find(w=>w.app===app).migrations.status="suffix_applied";
    for(const name of WINDOWS_STAGING_SECRET_SLOTS[app]) {
      input.versionDetails[app].detail.resources.bindings.push({name,type:"secret_text"});
      input.preflight.workers.find(w=>w.app===app).secretSlots.push(name);
    }
  }
  const result=prepare(input),c=candidate(input);
  assert.deepEqual(result.uploads.operations.compatibility_flags,["nodejs_compat","enable_request_signal"]);
  assert.deepEqual(result.uploads.delivery.compatibility_flags,["nodejs_compat"]);
  assert.equal(result.uploads.operations.vars.OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED,"true");
  assert.equal(result.uploads.delivery.vars.CLIENT_PORTAL_ENABLED,"true");
  assert.throws(()=>compare(input,c),/inputs_invalid/);
  for(const app of APPS) {
    c[app].detail.resources.script_runtime.compatibility_flags=[...result.uploads[app].compatibility_flags];
    c[app].detail.resources.bindings=[...c[app].detail.resources.bindings.filter(b=>b.type!=="plain_text"),
      ...Object.entries(result.uploads[app].vars).map(([name,text])=>({name,type:"plain_text",text}))];
  }
  assert.equal(compare(input,c).status,"supplied_inactive_resources_match");
  c.operations.detail.resources.script_runtime.compatibility_flags.push("unreviewed_flag");
  assert.throws(()=>compare(input,c),/inputs_invalid/);
  const optedOut=structuredClone(input);
  optedOut.sources.operations.compatibility_flags.push("disable_request_signal");
  optedOut.versionDetails.operations.detail.resources.script_runtime.compatibility_flags.push("disable_request_signal");
  assert.throws(()=>prepare(optedOut),/inputs_invalid/);
});
const mutations={
  "latest uploaded is inactive":f=>{f.snapshotRefs.operations.latestUploadedVersionId="00000000-0000-4000-8000-000000000004";},
  "split active":f=>{f.snapshotRefs.operations.activeDeployment.versions[0].percentage=99;},
  "wrong account":f=>{f.snapshotRefs.operations.accountId="other";},
  "wrong worker":f=>{f.snapshotRefs.operations.workerName="other";},
  "wrong physical D1":f=>{f.versionDetails.operations.detail.resources.bindings.find(b=>b.type==="d1").id="other";},
  "wrong physical service":f=>{f.versionDetails.operations.detail.resources.bindings.find(b=>b.type==="service").service="other";},
  "wrong observed DO name":f=>{f.versionDetails.operations.detail.resources.bindings.find(b=>b.type==="durable_object_namespace").name="OTHER_DO";},
  "wrong observed DO class":f=>{f.versionDetails.operations.detail.resources.bindings.find(b=>b.type==="durable_object_namespace").class_name="OtherClass";},
  "external observed DO script":f=>{f.versionDetails.operations.detail.resources.bindings.find(b=>b.type==="durable_object_namespace").script_name="external-worker";},
  "external observed DO environment":f=>{f.versionDetails.operations.detail.resources.bindings.find(b=>b.type==="durable_object_namespace").environment="external";},
  "missing observed DO":f=>{f.versionDetails.operations.detail.resources.bindings=f.versionDetails.operations.detail.resources.bindings.filter(b=>b.type!=="durable_object_namespace");},
  "extra observed DO":f=>{f.versionDetails.operations.detail.resources.bindings.push({name:"EXTRA_DO",type:"durable_object_namespace",class_name:"OtherClass",namespace_id:"b".repeat(32)});},
  "invalid observed DO namespace":f=>{f.versionDetails.operations.detail.resources.bindings.find(b=>b.type==="durable_object_namespace").namespace_id="not-a-namespace";},
  "unbounded observed DO namespace":f=>{f.versionDetails.operations.detail.resources.bindings.find(b=>b.type==="durable_object_namespace").namespace_id="a".repeat(1024);},
  "Client observed DO":f=>{f.versionDetails.delivery.detail.resources.bindings.push({name:"UNEXPECTED_DO",type:"durable_object_namespace",class_name:"OtherClass",namespace_id:"b".repeat(32)});},
  "unknown runtime":f=>{f.versionDetails.operations.detail.resources.script_runtime.future_setting=true;},
  "runtime mismatch":f=>{f.versionDetails.operations.detail.resources.script_runtime.compatibility_date="2026-10-23";},
  "runtime export lifecycle":f=>{f.versionDetails.operations.detail.resources.script_runtime.exports.ThumbnailRendererContainer.state="deleted";},
  "new source export":f=>{f.sources.operations.exports.NewClass={type:"durable-object",storage:"sqlite"};},
  "new container class":f=>{f.versionDetails.operations.detail.resources.script_runtime.containers.push({class_name:"NewClass"});},
  "invalid limits":f=>{f.versionDetails.delivery.detail.resources.script_runtime.limits.cpu_ms=0;},
  "unknown limits":f=>{f.versionDetails.delivery.detail.resources.script_runtime.limits.new_limit=1;},
  "unknown assets field":f=>{f.versionDetails.delivery.detail.resources.script_runtime.assets.new_asset_policy=true;},
  "inconsistent routing":f=>{f.versionDetails.delivery.detail.resources.script_runtime.assets.static_routing.user_worker=["/changed"];},
  "config migration":f=>{f.sources.operations.migrations=[{tag:"new",new_sqlite_classes:["NewClass"]}];},
  "duplicate binding":f=>{f.versionDetails.delivery.detail.resources.bindings.push({name:"OLD_SECRET",type:"secret_text"});},
  "secret as plain":f=>{f.versionDetails.delivery.detail.resources.bindings.push({name:"WINDOWS_PORTAL_QUEUE_KEY",type:"plain_text",text:"private-sentinel"});},
  "secret contents":f=>{f.versionDetails.delivery.detail.resources.bindings.find(b=>b.type==="secret_text").text="private-sentinel";},
  "secret inventory drift":f=>{f.preflight.workers[1].secretSlots=[];},
};
for(const [name,change]of Object.entries(mutations))test(`rejects ${name} generically`,()=>{const input=fixture();change(input);assert.throws(()=>prepare(input),e=>e.message==="windows_staging_inherited_upload_inputs_invalid");});
for(const field of ["assets","exports","containers"] )test(`inactive changed ${field} fails before any promotion`,()=>{const input=fixture(),c=candidate(input);c.operations.detail.resources.script_runtime[field]={changed:true};assert.throws(()=>compare(input,c),/inputs_invalid/);});
test("inactive binding inventory, secret values and variables must remain exact",()=>{
  for(const change of [c=>c.delivery.detail.resources.bindings.push({name:"NEW_SECRET",type:"secret_text"}),
    c=>{c.delivery.detail.resources.bindings.find(b=>b.name==="EMPTY").text="changed";},
    c=>{c.delivery.detail.resources.bindings.find(b=>b.name==="EMAIL").destination_address="changed@example.invalid";}]) {
    const input=fixture(),c=candidate(input);change(c);assert.throws(()=>compare(input,c),/inputs_invalid/);
  }
});
