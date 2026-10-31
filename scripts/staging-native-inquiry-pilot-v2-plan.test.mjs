import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { canonical, hash } from './production-deploy.mjs';
import { compileStagingNativeInquiryPilotV2PlanFromEvidence as compile,
  compileStagingNativeInquiryPilotV2PlanFromFiles as compileFiles,
  hashStagingNativeInquiryPilotV2PlanFile as planFileHash,
  stagingNativeInquiryPilotV2PlanConstants as C } from './staging-native-inquiry-pilot-v2-plan.mjs';
import { STAGING_ACCOUNT_ID } from './staging-requirements.mjs';

const clone=value=>structuredClone(value);
const candidate='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const receiptSha=receipt=>hash(Buffer.from(JSON.stringify(receipt),'utf8'));
function readPinned(pin) {
  const bytes=fs.readFileSync(pin.path);
  assert.equal(hash(bytes),pin.sha256,`test fixture pin changed: ${pin.path}`);
  return JSON.parse(bytes.toString('utf8'));
}
const referenceControls=readPinned(C.baselineControls);
const basePlans={operations:readPinned(C.basePlans.operations),client:readPinned(C.basePlans.client)};

function fixture() {
  // Synthetic test time over the immutable real profile capture. The actual
  // file compiler below uses a real fresh hash-pinned capture and wall clock.
  const now=Date.now(), baselineControls=clone(referenceControls);
  baselineControls.observedAt=new Date(now-20_000).toISOString();
  const baselineControlsSHA256=hash(canonical(baselineControls));
  return {now,referenceControls,baselineControls,baselineControlsSHA256};
}
function clientPlanFor(f) {
  return compile({application:'client',referenceControls:f.referenceControls,baselineControls:f.baselineControls,
    currentControls:f.baselineControls,basePlan:basePlans.client,now:f.now,
    baselineControlsSHA256:f.baselineControlsSHA256,currentControlsSHA256:f.baselineControlsSHA256});
}
function clientPilotState(f) {
  const current=clone(f.baselineControls), client=current.workers.client;
  current.observedAt=new Date(f.now-5_000).toISOString();
  client.activeVersionId=candidate; client.latestVersionId=candidate;
  client.deployment.versions=client.deployment.versions.map(row=>({...row,version_id:candidate}));
  client.deployment.id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'; client.deployment.created_on=current.observedAt;
  client.modern.id=candidate; client.modern.number=(client.modern.number??1)+1;
  client.modern.created_on=current.observedAt; client.modern.startup_time_ms=(client.modern.startup_time_ms??50)+7;
  for (const name of C.gates.client) {
    client.selectedFlags[name]='true';
    for (const rows of [client.version.resources.bindings,client.settings.bindings,client.modern.bindings])
      rows.push({name,type:'plain_text',textSHA256:hash(JSON.stringify('true'))});
    client.modern.env[name]={name,type:'plain_text',textSHA256:hash(JSON.stringify('true'))};
  }
  return current;
}
function clientReceipt(f,plan,current,controlsSHA256=hash(canonical(current))) {
  return {schemaVersion:2,purpose:C.CLIENT_RECEIPT_PURPOSE,accountId:STAGING_ACCOUNT_ID,
    workerName:C.current.client.workerName,baselineVersionId:C.current.client.activeVersionId,
    candidateVersionId:current.workers.client.activeVersionId,deploymentId:current.workers.client.deployment.id,
    sourceCommit:C.sourceCommits.client,planSHA256:planFileHash(plan),baselineControlsSHA256:f.baselineControlsSHA256,
    controlsSHA256,observedAt:current.observedAt,readbackVerified:true,exactClientDeltaVerified:true,
    activeRuntimeUnchanged:true,otherControlsUnchanged:true,schemaUnchanged:true,resourceWrites:0,applicationRowsRead:0};
}
function compileOps(f,current,receipt) {
  return compile({application:'operations',referenceControls:f.referenceControls,baselineControls:f.baselineControls,
    currentControls:current,basePlan:basePlans.operations,clientBasePlan:basePlans.client,now:f.now,
    baselineControlsSHA256:f.baselineControlsSHA256,currentControlsSHA256:hash(canonical(current)),
    clientPilotReceipt:receipt,clientPilotReceiptSHA256:receiptSha(receipt)});
}

test('Client v2 plan uses the actual b22 base while pinning Ops49, Client2e and unchanged Sync',()=>{
  const f=fixture(),plan=clientPlanFor(f);
  assert.equal(plan.schemaVersion,2); assert.equal(plan.contract,C.CONTRACT); assert.equal(plan.step,1);
  assert.equal(plan.sourceCommit,C.sourceCommits.client); assert.equal(plan.sourceProfiles.operations,C.sourceCommits.operations);
  assert.equal(plan.basePlanSchemaVersion,4); assert.equal(plan.basePlanContract,C.basePlans.client.contract);
  assert.equal(plan.baselineVersionId,C.current.client.activeVersionId);
  assert.equal(plan.installedCodeMatchesQualifiedBuild,true); assert.equal(plan.installedRuntimeAndBindingsMatchBase,true);
  assert.equal(plan.schemaMatchesBase,true);
  assert.deepEqual(plan.configurationDelta,C.gates.client.map(name=>({name,type:'plain_text',text:'true'})));
  assert.equal(plan.versionCreateTemplate.bindings.filter(row=>row.type==='plain_text').length,2);
  assert.ok(plan.versionCreateTemplate.bindings.filter(row=>row.type==='inherit').every(row=>row.version_id===C.current.client.activeVersionId));
  assert.deepEqual(plan.expectedResolvedBindings.map(({name,type,projectionSHA256})=>({name,type,projectionSHA256})),
    [...basePlans.client.expectedUnchangedResources.bindings]
      .filter(row=>!(row.name==='ASSETS'&&row.type==='assets'))
      .map(row=>({name:row.name,type:row.type,projectionSHA256:hash(canonical(row))}))
      .sort((a,b)=>a.name.localeCompare(b.name)));
  assert.equal(plan.expectedResolvedBindings.some(row=>C.gates.client.includes(row.name)),false);
  assert.deepEqual(plan.expectedResolvedBindings.map(row=>row.name),plan.preservedBindings,
    'real binding names with prefix underscores must use the same ordering as their projections');
  assert.ok(plan.expectedResolvedBindings.every(row=>Object.keys(row).sort().join(',')==='name,projectionSHA256,type'
    && /^[a-f0-9]{64}$/u.test(row.projectionSHA256)));
  assert.equal(JSON.stringify(plan.expectedResolvedBindings).includes('@'),false);
  const invitation=basePlans.client.expectedUnchangedResources.bindings.find(row=>row.type==='send_email');
  assert.ok(invitation && Array.isArray(invitation.allowed_sender_addresses));
  const changedSenderScope={...invitation,allowed_sender_addresses:[...invitation.allowed_sender_addresses,'scope-change.invalid']};
  assert.notEqual(hash(canonical(invitation)),hash(canonical(changedSenderScope)),
    'sender scope changes must change the secret-free projection hash');
  assert.equal(plan.held,true); assert.equal(plan.offlineOnly,true); assert.equal(plan.deploymentEnabled,false); assert.equal(plan.executionAllowed,false);
  assert.equal(plan.noIdentityOrCapabilityGrant,true); assert.equal(plan.noFileOrFinancePermission,true);
  assert.equal(plan.noNotificationCreation,true); assert.equal(plan.noOpsSyncUpdate,true); assert.equal(plan.noMigrationConfig,true);
  assert.equal(Object.hasOwn(plan.versionCreateTemplate,'assets'),false); assert.equal(Object.hasOwn(plan.versionCreateTemplate,'migrations'),false);
  assert.equal(plan.assetUploadRecipe.completionJwtRequired,true); assert.equal(plan.assetUploadRecipe.completionJwtMemoryOnly,true);
  assert.equal(plan.assetUploadRecipe.completionJwtPersisted,false);
});

test('v2 base plans pin distinct Ops owner-review v5 and Client current-profile v4 sources',()=>{
  assert.deepEqual({schemaVersion:basePlans.operations.schemaVersion,contract:basePlans.operations.contract,
    sourceCommit:basePlans.operations.sourceCommit,selected:basePlans.operations.selectedActiveVersionId},
    {schemaVersion:5,contract:'staging-backend-only-owner-review-profile-v5',sourceCommit:C.sourceCommits.operations,selected:'e299b7af-f9ed-424b-ae8f-3fdff4f0614e'});
  assert.deepEqual({schemaVersion:basePlans.client.schemaVersion,contract:basePlans.client.contract,
    sourceCommit:basePlans.client.sourceCommit,selected:basePlans.client.selectedActiveVersionId},
    {schemaVersion:4,contract:'staging-backend-only-current-profile-v4',sourceCommit:C.sourceCommits.client,selected:'b1f9053b-e1b9-4435-8bc0-49d03b393fab'});
  assert.equal(basePlans.operations.artifact.main.sha256,'2ab14ee0ff246f5849c657dff48cc8f47555f99779b9753f19c5188979141992');
  assert.equal(basePlans.operations.artifact.sourceMap.sha256,'44f1b074e94d86393b31177c3afe33b5b869444fcd604ae8a0a270418a380cb6');
  assert.equal(basePlans.client.sourceCommit,'b22abeccd1889ed2f745db98c6123bafa5820b97');
});

test('rejects wrong account/environment/worker/schema and pre-pilot active or latest IDs',()=>{
  const mutations=[
    c=>{c.accountId='00000000000000000000000000000000';},
    c=>{c.environment='production';},
    c=>{c.workers.client.workerName=C.current.operations.workerName;},
    c=>{c.workers.operations.activeVersionId='e299b7af-f9ed-424b-ae8f-3fdff4f0614e';},
    c=>{c.workers.client.latestVersionId='b1f9053b-e1b9-4435-8bc0-49d03b393fab';},
    c=>{c.schema.DELIVERY_DB.id='wrong-db';},
  ];
  for(const mutate of mutations){const f=fixture(),bad=clone(f.baselineControls);mutate(bad);
    assert.throws(()=>compile({application:'client',referenceControls:f.referenceControls,baselineControls:bad,currentControls:bad,
      basePlan:basePlans.client,now:f.now,baselineControlsSHA256:hash(canonical(bad)),currentControlsSHA256:hash(canonical(bad))}),/Native inquiry pilot plan:/u);}
  const f=fixture(),stale=clone(f.baselineControls);stale.observedAt=new Date(f.now-31*60_000).toISOString();
  assert.throws(()=>compile({application:'client',referenceControls:f.referenceControls,baselineControls:stale,currentControls:stale,
    basePlan:basePlans.client,now:f.now,baselineControlsSHA256:hash(canonical(stale)),currentControlsSHA256:hash(canonical(stale))}),/stale|fresh/u);
});

test('rejects wrong mixed-source base, schema digest, module bytes, and existing gate additions',()=>{
  const f=fixture(),wrongSource={...basePlans.client,sourceCommit:C.sourceCommits.operations};
  assert.throws(()=>compile({application:'client',referenceControls:f.referenceControls,baselineControls:f.baselineControls,
    currentControls:f.baselineControls,basePlan:wrongSource,now:f.now,baselineControlsSHA256:f.baselineControlsSHA256,
    currentControlsSHA256:f.baselineControlsSHA256}),/identity|source-map|installed executable/u);
  const wrongSchema=clone(f.baselineControls),referenceSchema=clone(f.referenceControls);
  wrongSchema.schema.DELIVERY_DB.tableDigest='f'.repeat(64);referenceSchema.schema.DELIVERY_DB.tableDigest='f'.repeat(64);
  assert.throws(()=>compile({application:'client',referenceControls:referenceSchema,baselineControls:wrongSchema,currentControls:wrongSchema,
    basePlan:basePlans.client,now:f.now,baselineControlsSHA256:hash(canonical(wrongSchema)),currentControlsSHA256:hash(canonical(wrongSchema))}),/schema/u);
  const extraGate=clone(f.baselineControls);extraGate.workers.client.selectedFlags[C.gates.client[0]]='true';
  assert.throws(()=>compile({application:'client',referenceControls:extraGate,baselineControls:extraGate,currentControls:extraGate,
    basePlan:basePlans.client,now:f.now,baselineControlsSHA256:hash(canonical(extraGate)),currentControlsSHA256:hash(canonical(extraGate))}),/gate|default-off/u);
});

test('Ops plan requires independent Client v2 receipt, exact two-gate delta, and target deployment identity',()=>{
  const f=fixture(),clientPlan=clientPlanFor(f),current=clientPilotState(f),receipt=clientReceipt(f,clientPlan,current);
  const ops=compileOps(f,current,receipt);
  assert.equal(ops.step,2);assert.equal(ops.application,'operations');assert.equal(ops.sourceCommit,C.sourceCommits.operations);
  assert.equal(ops.basePlanSchemaVersion,5);assert.equal(ops.basePlanContract,C.basePlans.operations.contract);
  assert.equal(ops.baselineVersionId,C.current.operations.activeVersionId);
  assert.deepEqual(ops.configurationDelta,C.gates.operations.map(name=>({name,type:'plain_text',text:'true'})));
  assert.ok(ops.versionCreateTemplate.bindings.filter(row=>row.type==='inherit').every(row=>row.version_id===C.current.operations.activeVersionId));
  assert.equal(ops.expectedResolvedBindings.length,basePlans.operations.expectedUnchangedResources.bindings
    .filter(row=>!(row.name==='ASSETS'&&row.type==='assets')).length);
  assert.ok(ops.expectedResolvedBindings.every(row=>Object.keys(row).sort().join(',')==='name,projectionSHA256,type'
    && /^[a-f0-9]{64}$/u.test(row.projectionSHA256)));
  assert.equal(ops.expectedResolvedBindings.some(row=>C.gates.operations.includes(row.name)),false);
  assert.equal(ops.clientPilotContext.candidateVersionId,current.workers.client.activeVersionId);
  assert.equal(ops.clientPilotContext.deploymentId,receipt.deploymentId);
  assert.equal(ops.clientPilotContext.planSHA256,receipt.planSHA256);
  const forged={...receipt,candidateVersionId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
  assert.throws(()=>compileOps(f,current,forged),/independent Client-pilot receipt/u);
  const extra={...receipt,unreviewed:true};
  assert.throws(()=>compileOps(f,current,extra),/independent Client-pilot receipt/u);
  const changedDeployment=clone(current);changedDeployment.workers.client.deployment.id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const staleDeploymentProof={...receipt,controlsSHA256:hash(canonical(changedDeployment))};
  assert.throws(()=>compileOps(f,changedDeployment,staleDeploymentProof),/independent Client-pilot receipt/u);
});

test('Ops sequencing preserves provider strategy and runtime while allowing measured startup variance',()=>{
  const f=fixture(),clientPlan=clientPlanFor(f),current=clientPilotState(f),receipt=clientReceipt(f,clientPlan,current);
  const startupVariance=clone(current);startupVariance.workers.client.modern.startup_time_ms+=19;
  const updatedReceipt={...receipt,controlsSHA256:hash(canonical(startupVariance))};
  assert.equal(compileOps(f,startupVariance,updatedReceipt).step,2);
  const strategy=clone(current);strategy.workers.client.deployment.strategy='unreviewed';
  assert.throws(()=>compileOps(f,strategy,{...receipt,controlsSHA256:hash(canonical(strategy))}),/runtime or non-gate controls/u);
  const runtime=clone(current);runtime.workers.client.modern.compatibility_date='2027-01-01';
  assert.throws(()=>compileOps(f,runtime,{...receipt,controlsSHA256:hash(canonical(runtime))}),/runtime or non-gate controls/u);
  const broad=clone(current);broad.workers.client.selectedFlags.CLIENT_PORTAL_REQUEST_V2_ENABLED='true';
  assert.throws(()=>compileOps(f,broad,{...receipt,controlsSHA256:hash(canonical(broad))}),/non-pilot flags/u);
});

test('actual file-backed Client v2 compile requires a supplied fresh pinned capture', {
  skip: !process.env.LEDGETOP_NATIVE_INQUIRY_PILOT_V2_CONTROLS_PATH
    && 'fresh controls path/SHA env pins are required for an actual file-backed compile',
},()=>{
  const plan=compileFiles({application:'client',baselineControlsFile:{
    path:process.env.LEDGETOP_NATIVE_INQUIRY_PILOT_V2_CONTROLS_PATH,
    sha256:process.env.LEDGETOP_NATIVE_INQUIRY_PILOT_V2_CONTROLS_SHA256,
  }});
  assert.equal(plan.schemaVersion,2);assert.equal(plan.contract,C.CONTRACT);
  assert.equal(plan.application,'client');assert.equal(plan.sourceCommit,C.sourceCommits.client);
  assert.equal(plan.basePlanSHA256,C.basePlans.client.sha256);assert.equal(plan.executionAllowed,false);
});
