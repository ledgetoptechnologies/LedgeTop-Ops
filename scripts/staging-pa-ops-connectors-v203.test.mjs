import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {connectorMetadataTemplate203,connectorPublicKeyFingerprint203,buildConnectorManifest203,inspectConnectorMetadata203,
  buildOpsConnectorConfig203,parseConnectorMetadata203,CONNECTOR_MANIFEST203,SNAPSHOT_SECRET203} from './staging-pa-ops-connectors-v203.mjs';

function metadata() {
  const m=connectorMetadataTemplate203();
  for(const [index,s] of Object.values(m.sources).entries()) {
    s.publicEventKey=Buffer.alloc(32,index+1).toString('base64url');s.producerBindingId=`synthetic_producer_${index}`;
    if(index===1){s.applicationKey='synthetic_stage_two';}
    Object.assign(s.revision,{credentialRef:`synthetic_reference_${index}`,snapshotBasePath:'/',accessIssuer:'https://synthetic.cloudflareaccess.com',accessAudience:`synthetic_aud_${index}`,accessSubject:`synthetic_subject_${index}`});
    s.revision.eventCurrent={keyId:`synthetic_key_${index}`,algorithm:'ed25519',fingerprint:connectorPublicKeyFingerprint203(s.publicEventKey)};
  }
  return m;
}
function baseline() {
  const c={name:'ledgetop-ops-staging',account_id:'846c924bf17bf4f3dd15c97a4c5d1d51',keep_vars:false,
    main:'/synthetic/native-entrypoint.js',assets:{binding:'ASSETS',directory:'/synthetic/client'},vars:{ENVIRONMENT:'staging',APPLICATION_KEY:'ledgetop_ops_staging',
      PROJECT_ALPHA_BASE_URL:'https://pa-staging.ledgetoptechnologies.com',STREAM_ACCOUNT_ID:'',STREAM_CUSTOMER_CODE:'',NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED:'true'},
    routes:[{pattern:'ops-staging.example.test',custom_domain:true}],triggers:{crons:['1-56/5 * * * *']},
    containers:[{name:'synthetic-container',image:'registry.example.test/image@sha256:synthetic'}],
    services:Array.from({length:9},(_,i)=>({binding:`SERVICE_${i}`,service:`synthetic_${i}`})),
    r2_buckets:[{binding:'DATA_BUCKET'},{binding:'INCOMING_BUCKET'}],d1_databases:[{binding:'OPS_DB',database_id:'78b34173-b168-4e3d-9832-bb9d245cc6b8'},{binding:'DELIVERY_DB'}],
    workflows:Array.from({length:5},(_,i)=>({binding:`WORKFLOW_${i}`,name:`synthetic_${i}`})),send_email:[{name:'EMAIL'}],stream:{binding:'STREAM'},
    queues:{producers:[{binding:'QUEUE'}]},durable_objects:{bindings:[{name:'CONTAINER'}]},unsafe:{metadata:{placement:{},tags:['synthetic']}}};
  while(Object.keys(c.vars).length<121)c.vars[`SYNTHETIC_VAR_${Object.keys(c.vars).length}`]='';
  const inventory=Object.keys(c.vars).map(name=>({name,type:'plain_text'}));
  for(let i=0;i<7;i++)inventory.push({name:`EXISTING_SECRET_${i}`,type:'secret_text'});
  inventory.push({name:'ASSETS',type:'assets'});
  for(const [field,type] of [['services','service'],['r2_buckets','r2_bucket'],['d1_databases','d1'],['workflows','workflow'],['send_email','send_email']])
    for(const x of c[field])inventory.push({name:x.binding??x.name,type});
  inventory.push({name:'STREAM',type:'stream'},{name:'QUEUE',type:'queue'},{name:'CONTAINER',type:'durable_object_namespace'});
  assert.equal(inventory.length,151);return {c,inventory};
}

test('null public template is pending; incomplete identities cannot compile or deploy',()=>{
  const template=JSON.parse(fs.readFileSync(new URL('./staging-pa-ops-connectors-v203.example.json',import.meta.url)));
  assert.deepEqual(template,connectorMetadataTemplate203());assert.deepEqual(inspectConnectorMetadata203(template),{deployReady:false,manifest:null});
  assert.throws(()=>buildConnectorManifest203(template),/invalid or incomplete/);
  const {c,inventory}=baseline();assert.throws(()=>buildOpsConnectorConfig203(c,template,inventory));
});
test('public metadata produces canonical shared runtime manifest and preserves distinct classic/APIv2 identity',()=>{
  const m=metadata(),original=structuredClone(m),manifest=JSON.parse(buildConnectorManifest203(m));
  assert.deepEqual(m,original);assert.equal(manifest.version,1);assert.equal(manifest.sources[0].sourceId,'project-alpha:primary');
  assert.equal(m.sources.stageOne.apiV2SourceId,'project-alpha:staging');assert.equal(manifest.sources[1].profile,'business_data');
  assert.ok(manifest.sources.every(s=>s.enabled===false));assert.ok(!JSON.stringify(manifest).includes('publicEventKey'));
  assert.equal(inspectConnectorMetadata203(m).deployReady,true);
  assert.equal(m.sources.stageTwo.sourceId,m.sources.stageTwo.apiV2SourceId,'known source2 identity is shared deliberately');
});
test('actual Ops runtime accepts shared manifest and respects disabled sources without a database',async()=>{
  const require=createRequire(new URL('../apps/operations/package.json',import.meta.url));
  const {build}=require('esbuild');
  const bundled=await build({entryPoints:[fileURLToPath(new URL('../apps/operations/src/worker/project-alpha-connectors.ts',import.meta.url))],bundle:true,
    write:false,platform:'node',format:'esm',logLevel:'silent'});
  const runtime=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  const m=metadata();m.sources.stageOne.enabled=true;
  const env={PROJECT_ALPHA_CONNECTOR_SOURCES:buildConnectorManifest203(m),PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED:'true'};
  assert.equal(runtime.deploymentAllowsProjectAlphaSource(env,'project-alpha:primary'),true);
  assert.equal(runtime.deploymentAllowsProjectAlphaSource(env,'project-alpha:source-2-staging'),false);
  assert.equal(runtime.deploymentAllowsProjectAlphaSource(env,'project-alpha:staging'),false);
  m.sources.stageTwo.enabled=true;env.PROJECT_ALPHA_CONNECTOR_SOURCES=buildConnectorManifest203(m);
  assert.equal(runtime.deploymentAllowsProjectAlphaSource(env,'project-alpha:source-2-staging'),true);
});
test('fails closed on identity aliases, malformed Access fields, key commitments and secret-bearing metadata',()=>{
  const bad=[m=>m.sources.stageOne.sourceId='project-alpha:staging',m=>m.sources.stageOne.snapshotOrigin='https://production.example.test',
    m=>m.sources.stageOne.applicationKey='different',m=>m.sources.stageOne.revision.snapshotBasePath='/other',m=>m.sources.stageTwo.sourceId='project-alpha:other',
    m=>m.sources.stageTwo.producerBindingId=m.sources.stageOne.producerBindingId,m=>m.sources.stageTwo.revision.credentialRef=m.sources.stageOne.revision.credentialRef,
    m=>m.sources.stageTwo.publicEventKey=m.sources.stageOne.publicEventKey,m=>m.sources.stageTwo.revision.eventCurrent.algorithm='hmac-sha256',
    m=>m.sources.stageTwo.revision.accessIssuer='http://access.example.test',m=>m.sources.stageTwo.revision.accessAudience='',
    m=>m.sources.stageTwo.revision.accessSubject=null,m=>m.sources.stageTwo.apiKey='must-not-appear',m=>m.sources.stageTwo.enabled=true,
    m=>m.sources.stageTwo.producerBindingId=null,m=>m.sources.stageTwo.applicationKey=null,m=>m.sources.stageTwo.revision.credentialRef=null,
    m=>m.sources.stageTwo.revision.eventCurrent.keyId=null];
  for(const mutate of bad){const m=metadata();mutate(m);assert.throws(()=>buildConnectorManifest203(m),/^Error: Current203 connector profile is invalid or incomplete$/);}
  const m=metadata();m.sources.stageTwo.publicEventKey=m.sources.stageOne.publicEventKey;m.sources.stageTwo.revision.eventCurrent.fingerprint=m.sources.stageOne.revision.eventCurrent.fingerprint;
  assert.throws(()=>buildConnectorManifest203(m));
});
test('public Ed25519 fingerprints match runtime decoded-byte algorithm domain',()=>{
  assert.equal(connectorPublicKeyFingerprint203(Buffer.alloc(32,1).toString('base64url')),'f15216d70b6f061213b6d8c1737daf30a843f406259a378dff7fee3410a6ca51');
});
test('public metadata parser rejects duplicate declarations and pending-template accessors',()=>{
  assert.deepEqual(parseConnectorMetadata203(JSON.stringify(metadata())),metadata());
  const raw=JSON.stringify(metadata()).replace('"version":203','"version":203,"version":203');assert.throws(()=>parseConnectorMetadata203(raw));
  const m=connectorMetadataTemplate203();let accessed=false;Object.defineProperty(m.sources.stageOne,'publicEventKey',{enumerable:true,get(){accessed=true;return null;}});
  assert.throws(()=>inspectConnectorMetadata203(m));assert.equal(accessed,false);
});
test('exact128 text/151 provider budget preserves full runtime flags/resources and separates snapshot placeholders',()=>{
  const {c,inventory}=baseline(),prior=structuredClone(c),plan=buildOpsConnectorConfig203(c,metadata(),inventory);
  assert.deepEqual(c,prior);assert.equal(Object.keys(plan.config.vars).length,120);assert.equal(plan.budget.textBindings,128);assert.equal(plan.budget.providerBindings,151);
  const restored=structuredClone(plan.config);delete restored.vars[CONNECTOR_MANIFEST203];restored.vars.STREAM_ACCOUNT_ID='';restored.vars.STREAM_CUSTOMER_CODE='';assert.deepEqual(restored,c);
  assert.equal(plan.config.vars.NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED,'true');assert.equal(plan.credentialSecretName,SNAPSHOT_SECRET203);
  assert.ok(Object.values(plan.credentialTemplate.sets).every(x=>x.snapshotApiKey===null));
  assert.ok(!Object.hasOwn(plan.config.vars,SNAPSHOT_SECRET203));assert.ok(!JSON.stringify(plan.config).includes('snapshotApiKey'));
  c.vars.NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED='false';assert.equal(buildOpsConnectorConfig203(c,metadata(),inventory).config.vars.NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED,'false');
});
test('refuses nonempty Stream variables, wrong staging target, resource drift and secret material in inventory',()=>{
  for(const mutate of [x=>x.c.vars.STREAM_ACCOUNT_ID='real-account',x=>x.c.vars.STREAM_CUSTOMER_CODE='real-customer',x=>x.c.name='production',
    x=>x.c.vars.PROJECT_ALPHA_BASE_URL='https://other.example.test',x=>x.c.keep_vars=true,x=>x.inventory[0].text='credential',
    x=>x.inventory.pop(),x=>x.c.services[0].binding='unreviewed',x=>x.c.vars.PROJECT_ALPHA_CONNECTOR_EVENT_CREDENTIALS='secret',
    x=>x.c.kv_namespaces=[{binding:'unreviewed'}]]){
    const x=baseline();mutate(x);assert.throws(()=>buildOpsConnectorConfig203(x.c,metadata(),x.inventory));
  }
});
