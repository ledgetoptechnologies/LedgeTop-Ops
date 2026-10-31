import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonical, hash } from './production-deploy.mjs';
import { compileStagingNativeInquiryPilotV2PlanFromEvidence as compile,
  compileStagingNativeInquiryPilotV2PlanFromFiles as compileFiles,
  hashStagingNativeInquiryPilotV2PlanFile as planFileHash,
  stagingNativeInquiryPilotV2PlanConstants as C } from './staging-native-inquiry-pilot-v2-plan.mjs';

const clone=value=>structuredClone(value);
const candidate='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function readPinned(pin) {
  const bytes=fs.readFileSync(pin.path);
  assert.equal(hash(bytes),pin.sha256,`test fixture pin changed: ${pin.path}`);
  return JSON.parse(bytes.toString('utf8'));
}
const referenceControls=readPinned(C.baselineControls);
const basePlans={operations:readPinned(C.basePlans.operations),client:readPinned(C.basePlans.client)};
const historicalClientBaselineBytes=fs.readFileSync(C.clientPilotBaselineControls.path);
const historicalClientBaseline=JSON.parse(historicalClientBaselineBytes.toString('utf8'));
const historicalClientBaselineSHA256=hash(historicalClientBaselineBytes);
const clientActivationControlsBytes=fs.readFileSync(C.clientPilotActivationControls.path);
const clientActivationControls=JSON.parse(clientActivationControlsBytes.toString('utf8'));
const clientActivationControlsSHA256=hash(clientActivationControlsBytes);
const clientActivationReceiptBytes=fs.readFileSync(C.clientPilotActivationReceipt.path);
const clientActivationReceipt=JSON.parse(clientActivationReceiptBytes.toString('utf8'));
const clientActivationReceiptSHA256=hash(clientActivationReceiptBytes);

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
function compileOps(f,current,receipt) {
  return compile({application:'operations',referenceControls:f.referenceControls,baselineControls:f.baselineControls,
    currentControls:current,basePlan:basePlans.operations,clientBasePlan:basePlans.client,now:f.now,
    baselineControlsSHA256:f.baselineControlsSHA256,currentControlsSHA256:hash(canonical(current)),
    clientPilotControls:f.clientPilotControls,clientPilotControlsSHA256:f.clientPilotControlsSHA256,
    clientPilotReceipt:receipt,clientPilotReceiptSHA256:clientActivationReceiptSHA256});
}
function opsFixture() {
  const baselineControls=clone(historicalClientBaseline),baselineAt=Date.parse(historicalClientBaseline.observedAt);
  const now=Date.now(),f={now,referenceControls,baselineControls,baselineControlsSHA256:historicalClientBaselineSHA256,
    clientPilotControls:clientActivationControls,clientPilotControlsSHA256:clientActivationControlsSHA256};
  // Recompute the original Client plan at its genuine baseline-time context for
  // receipt comparison. This does not qualify or refresh the live current view.
  const clientPlan=compile({application:'client',referenceControls:f.referenceControls,baselineControls,
    currentControls:baselineControls,basePlan:basePlans.client,now:baselineAt+20_000,
    baselineControlsSHA256:historicalClientBaselineSHA256,currentControlsSHA256:historicalClientBaselineSHA256});
  const current=clone(clientActivationControls);current.observedAt=new Date(now-5_000).toISOString();
  const receipt=clientActivationReceipt;
  return {f,clientPlan,current,receipt};
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
  const {f,clientPlan,current,receipt}=opsFixture();
  const ops=compileOps(f,current,receipt);
  assert.equal(planFileHash(clientPlan),C.clientPilotHeldPlanSHA256);
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
  assert.equal(ops.clientPilotContext.controlsSHA256,C.clientPilotActivationControls.sha256);
  assert.equal(ops.clientPilotContext.controlsObservedAt,clientActivationControls.observedAt);
  const forged={...receipt,candidateVersionId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
  assert.throws(()=>compileOps(f,current,forged),/independent Client-pilot receipt/u);
  const extra={...receipt,unreviewed:true};
  assert.throws(()=>compileOps(f,current,extra),/independent Client-pilot receipt/u);
  const changedDeployment=clone(current);changedDeployment.workers.client.deployment.id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  assert.throws(()=>compileOps(f,changedDeployment,receipt),/Client activation proof/u);
});

test('Ops sequencing preserves provider strategy and runtime while allowing measured startup variance',()=>{
  const {f,current,receipt}=opsFixture();
  const startupVariance=clone(current);startupVariance.workers.client.modern.startup_time_ms+=19;
  startupVariance.workers.client.rawControlSHA256='c'.repeat(64);
  assert.equal(compileOps(f,startupVariance,receipt).step,2);
  const strategy=clone(current);strategy.workers.client.deployment.strategy='unreviewed';
  assert.throws(()=>compileOps(f,strategy,receipt),/Client activation proof/u);
  const runtime=clone(current);runtime.workers.client.modern.compatibility_date='2027-01-01';
  assert.throws(()=>compileOps(f,runtime,receipt),/Client activation proof/u);
  const broad=clone(current);broad.workers.client.selectedFlags.CLIENT_PORTAL_REQUEST_V2_ENABLED='true';
  assert.throws(()=>compileOps(f,broad,receipt),/Client activation proof/u);
});

test('Ops accepts only the pinned historical C82 anchor and fresh receipt-bound Client controls',()=>{
  const {f,clientPlan,current,receipt}=opsFixture();
  assert.equal(f.baselineControls.observedAt,'2026-10-31T12:50:09.336Z');
  assert.equal(f.baselineControlsSHA256,C.clientPilotBaselineControls.sha256);
  assert.equal(planFileHash(clientPlan),C.clientPilotHeldPlanSHA256);
  const plan=compileOps(f,current,receipt);
  assert.equal(plan.baselineControlsSHA256,C.clientPilotBaselineControls.sha256);
  assert.equal(plan.baselineControlsObservedAt,f.baselineControls.observedAt);
  assert.equal(plan.controlsObservedAt,current.observedAt);
  assert.equal(plan.clientPilotContext.controlsSHA256,C.clientPilotActivationControls.sha256);

  assert.throws(()=>compile({application:'operations',referenceControls:f.referenceControls,
    baselineControls:f.baselineControls,currentControls:current,basePlan:basePlans.operations,
    clientBasePlan:basePlans.client,now:f.now,baselineControlsSHA256:'a'.repeat(64),
    currentControlsSHA256:hash(canonical(current)),clientPilotControls:f.clientPilotControls,
    clientPilotControlsSHA256:f.clientPilotControlsSHA256,clientPilotReceipt:receipt,
    clientPilotReceiptSHA256:clientActivationReceiptSHA256}),/historical baseline.*exact original/u);
  assert.throws(()=>compileFiles({application:'operations',baselineControlsFile:C.baselineControls}),
    /must use the byte-pinned historical C82/u);

  const staleCurrent=clone(current);staleCurrent.observedAt=new Date(f.now-30*60_000-1).toISOString();
  const staleReceipt={...receipt,observedAt:staleCurrent.observedAt,controlsSHA256:hash(canonical(staleCurrent))};
  assert.throws(()=>compileOps(f,staleCurrent,staleReceipt),/stale|fresh/u);

  assert.throws(()=>compileOps(f,current,{...receipt,planSHA256:'b'.repeat(64)}),/independent Client-pilot receipt/u);
});

test('Ops rechecks fresh captures against immutable Client activation proof without changing plan context',()=>{
  const {f,current,receipt}=opsFixture();
  const first=compileOps(f,current,receipt);
  const rechecked=clone(current);rechecked.observedAt=new Date(f.now-1_000).toISOString();
  rechecked.workers.client.modern.startup_time_ms+=4;
  rechecked.workers.client.rawControlSHA256='d'.repeat(64);
  const next=compileOps(f,rechecked,receipt);
  assert.notEqual(first.controlsSHA256,next.controlsSHA256);
  assert.notEqual(first.controlsObservedAt,next.controlsObservedAt);
  assert.deepEqual(first.clientPilotContext,next.clientPilotContext);
  assert.equal(next.clientPilotContext.controlsSHA256,C.clientPilotActivationControls.sha256);

  const preActivation=clone(current);
  const activationAt=Date.parse(f.clientPilotControls.observedAt);
  preActivation.observedAt=new Date(activationAt-1_000).toISOString();
  const testClock={...f,now:activationAt+60_000};
  assert.throws(()=>compileOps(testClock,preActivation,receipt),/fresh current controls predate/u);

  const changedGate=clone(rechecked);changedGate.workers.client.selectedFlags[C.gates.client[0]]='false';
  assert.throws(()=>compileOps(f,changedGate,receipt),/Client activation proof/u);
  const changedSchema=clone(rechecked);changedSchema.schema.OPS_DB.tableDigest='f'.repeat(64);
  assert.throws(()=>compileOps(f,changedSchema,receipt),/Client activation proof|schema/u);
  const changedOps=clone(rechecked);changedOps.workers.operations.latestVersionId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.throws(()=>compileOps(f,changedOps,receipt),/Client activation proof|pinned active\/latest/u);
});

test('file-backed Ops recompiles fresh controls against the actual pinned activation proof',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'native-inquiry-ops-recheck-'));
  const tempFiles=[];
  try {
    const makeCurrent=(suffix,ageMs=10_000,startupDelta=0)=>{
      const current=clone(clientActivationControls);
      current.observedAt=new Date(Date.now()-ageMs).toISOString();
      if(startupDelta){current.workers.client.modern.startup_time_ms+=startupDelta;current.workers.client.rawControlSHA256='e'.repeat(64);}
      const bytes=Buffer.from(`${JSON.stringify(current,null,2)}\n`,'utf8');
      const file=path.join(temp,`${suffix}.json`);fs.writeFileSync(file,bytes,{flag:'wx'});tempFiles.push(file);
      return {current,file,sha256:hash(bytes)};
    };
    const options=current=>({application:'operations',baselineControlsFile:C.clientPilotBaselineControls,
      currentControlsFile:{path:current.file,sha256:current.sha256},clientPilotControlsFile:C.clientPilotActivationControls,
      clientPilotReceiptFile:C.clientPilotActivationReceipt.path,
      clientPilotReceiptSHA256:C.clientPilotActivationReceipt.sha256});
    const first=compileFiles(options(makeCurrent('capture-1',20_000)));
    const secondCurrent=makeCurrent('capture-2',5_000,7);
    const second=compileFiles(options(secondCurrent));
    assert.notEqual(first.controlsSHA256,second.controlsSHA256);
    assert.notEqual(first.controlsObservedAt,second.controlsObservedAt);
    assert.deepEqual(first.clientPilotContext,second.clientPilotContext);
    assert.equal(second.clientPilotContext.controlsSHA256,C.clientPilotActivationControls.sha256);

    const changed=clone(secondCurrent.current);changed.workers.client.selectedFlags[C.gates.client[0]]='false';
    const changedBytes=Buffer.from(`${JSON.stringify(changed,null,2)}\n`,'utf8');
    const changedFile=path.join(temp,'changed-gate.json');fs.writeFileSync(changedFile,changedBytes,{flag:'wx'});tempFiles.push(changedFile);
    assert.throws(()=>compileFiles(options({file:changedFile,sha256:hash(changedBytes)})),/Client activation proof/u);
  } finally {
    for(const file of tempFiles) if(fs.existsSync(file)) fs.rmSync(file);
    fs.rmdirSync(temp);
  }
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
