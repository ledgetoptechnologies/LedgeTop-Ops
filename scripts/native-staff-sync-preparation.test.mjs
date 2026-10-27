import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileNativeStaffSyncPreparation, deriveNativeStaffSyncSourceEvidence } from './native-staff-sync-preparation.mjs';
import { runNativeStaffSyncQualification } from './native-staff-sync-qualification.mjs';

const hash = 'a'.repeat(64), commitA = '1'.repeat(40);
const repositoryRoot=fileURLToPath(new URL('..',import.meta.url));
const candidateCommit=execFileSync('git',['-C',repositoryRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value === null || typeof value !== 'object' ? JSON.stringify(value)
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const digest = value => createHash('sha256').update(value).digest('hex');
const groupId='11111111-1111-4111-8111-111111111111',groupName='Synthetic Ops Staff';
function groupObservation(members, offsetMs=0, overrides={}) {
  const normalized=[...members].map(email=>email.trim().toLowerCase()).sort();
  const policy={exclude:[],require:[],is_default:[]};
  const body={schemaVersion:1,kind:'cloudflare-access-group-observation-v1',accountId:'a'.repeat(32),groupId,groupName,
    observedAt:new Date(Date.now()+offsetMs).toISOString(),managedEmailCount:normalized.length,managedEmailsSha256:digest(canonical(normalized)),
    includeRuleCount:normalized.length,policySha256:digest(canonical(policy)),providerResponseSha256:'f'.repeat(64),...overrides};
  return {...body,evidenceSha256:digest(canonical(body))};
}
const cohortRows=[{staffId:'owner',email:'owner@example.test',accessSubject:'access|owner',displayName:'Owner',active:true,admissionVersion:1,profileVersion:1}];
const aliasEvidence=()=>({issuer:'https://example.cloudflareaccess.com',activeBindings:[],pendingIntentCount:0});
const fixture = () => ({
  active:{accountId:'a'.repeat(32),workerName:'ltds-ops-sync',environment:'production',databaseId:'b'.repeat(8)+'-'+ 'b'.repeat(4)+'-'+ 'b'.repeat(4)+'-'+ 'b'.repeat(4)+'-'+ 'b'.repeat(12),
    runtimeVersion:'2026-07-22',settings:{compatibilityDate:'2026-07-22',triggers:['0 * * * *']},
    bindings:[{name:'OPS_DB',type:'d1',resourceId:'ops-db-id'},{name:'ACCESS_GROUP',type:'text',resourceId:'group-id'}],moduleSha256:hash,sourceCommit:commitA},
  candidate:{accountId:'a'.repeat(32),workerName:'ltds-ops-sync',environment:'production',databaseId:'b'.repeat(8)+'-'+ 'b'.repeat(4)+'-'+ 'b'.repeat(4)+'-'+ 'b'.repeat(4)+'-'+ 'b'.repeat(12),
    runtimeVersion:'2026-07-22',settings:{compatibilityDate:'2026-07-22',triggers:['0 * * * *']},
    bindings:[{name:'OPS_DB',type:'d1',resourceId:'ops-db-id'},{name:'ACCESS_GROUP',type:'text',resourceId:'group-id'}],moduleSha256:'c'.repeat(64),sourceCommit:candidateCommit},
  control:{tablePresent:false,enabled:null,generation:null,appliedGeneration:null,leaseId:null,leaseUntil:null,attemptGeneration:null},
  cohortBefore:{cohortSha256:digest(canonical(cohortRows)),rows:structuredClone(cohortRows)},
  cohortAfter:{cohortSha256:digest(canonical(cohortRows)),rows:structuredClone(cohortRows)},
  alternateBindingsBefore:aliasEvidence(),alternateBindingsAfter:aliasEvidence(),
  pins:{accountId:'a'.repeat(32),workerName:'ltds-ops-sync',environment:'production',databaseId:'b'.repeat(8)+'-'+ 'b'.repeat(4)+'-'+ 'b'.repeat(4)+'-'+ 'b'.repeat(4)+'-'+ 'b'.repeat(12),
    runtimeVersion:'2026-07-22',activeModuleSha256:hash,activeSourceCommit:commitA,candidateModuleSha256:'c'.repeat(64),candidateSourceCommit:candidateCommit,
    settingsSha256:digest(canonical({compatibilityDate:'2026-07-22',triggers:['0 * * * *']})),
    bindingsSha256:digest(canonical([{name:'ACCESS_GROUP',type:'text',resourceId:'group-id'},{name:'OPS_DB',type:'d1',resourceId:'ops-db-id'}])),
    staffAccessIssuer:'https://example.cloudflareaccess.com',accessGroupId:groupId,accessGroupName:groupName},
  groupBeforeObservation:groupObservation(['owner@example.test','staff@example.test'],-1000),
  groupAfterObservation:groupObservation(['owner@example.test','staff@example.test'],0),repositoryRoot,
});
function qualifiedFixture(){
  const value=fixture();value.sourceEvidence=deriveNativeStaffSyncSourceEvidence({repositoryRoot,
    sourceCommit:value.candidate.sourceCommit,moduleSha256:value.candidate.moduleSha256});
  const proof={schemaVersion:1,kind:'ops-sync-candidate-behavior-qualification-v1',sourceCommit:value.candidate.sourceCommit,
    sourceTreeSha256:value.sourceEvidence.sourceTreeSha256,sourceEvidenceSha256:value.sourceEvidence.sourceEvidenceSha256,
    candidateModuleSha256:value.candidate.moduleSha256,builtModuleSha256:value.candidate.moduleSha256,
    vitestVersion:'synthetic-test-fixture',wranglerVersion:'synthetic-build-fixture',suiteCount:6,testCount:53,
    testReportSha256:'9'.repeat(64),qualificationRunnerSha256:'a'.repeat(64),
    testFiles:['connector-ingress.test.ts','native-staff-access.test.ts','native-staff-preparation-entrypoint.test.ts']};
  value.qualificationEvidence={...proof,qualificationSha256:digest(JSON.stringify(proof))};
  return value;
}

test('compiles only a read-only dormant Sync preparation with exact surface and preserved staff/group',()=>{
  const receipt=compileNativeStaffSyncPreparation(qualifiedFixture());
  assert.equal(receipt.kind,'operations-native-staff-sync-dormant-preparation-v1');
  assert.equal(receipt.controlState,'missing');
  assert.equal(receipt.activeStaffCount,1);
  assert.equal(receipt.currentGroupSha256.length,64);
  assert.equal(receipt.desiredGroupSha256.length,64);
  assert.equal(receipt.receiptSha256.length,64);
});

test('accepts genuine Vitest nested-suite count with the exact three-file inventory',()=>{
  const value=qualifiedFixture();
  assert.equal(value.qualificationEvidence.suiteCount,6);
  assert.equal(value.qualificationEvidence.testCount,53);
  assert.deepEqual(value.qualificationEvidence.testFiles,
    ['connector-ingress.test.ts','native-staff-access.test.ts','native-staff-preparation-entrypoint.test.ts']);
  assert.equal(compileNativeStaffSyncPreparation(value).kind,'operations-native-staff-sync-dormant-preparation-v1');
});

for (const [field, invalid] of [
  ['suiteCount',0], ['suiteCount',-1], ['suiteCount',2], ['suiteCount',101], ['suiteCount',1.5],
  ['suiteCount',null], ['suiteCount','6'], ['suiteCount',Number.MAX_SAFE_INTEGER+1],
  ['testCount',0], ['testCount',-1], ['testCount',5], ['testCount',10001], ['testCount',1.5],
  ['testCount',null], ['testCount','53'], ['testCount',Number.MAX_SAFE_INTEGER+1],
]) test(`rejects malformed qualification ${field} ${invalid}`,()=>{
  const value=qualifiedFixture();
  value.qualificationEvidence[field]=invalid;
  const {qualificationSha256,...body}=value.qualificationEvidence;
  value.qualificationEvidence.qualificationSha256=digest(JSON.stringify(body));
  assert.throws(()=>compileNativeStaffSyncPreparation(value),/behavior_qualification_invalid/u);
});

for (const [label, mutate, code] of [
  ['binding change',x=>x.candidate.bindings[0].resourceId='other-db','deployment_surface_changed'],
  ['runtime change',x=>x.candidate.runtimeVersion='other-runtime','deployment_surface_changed'],
  ['settings change',x=>x.candidate.settings.compatibilityDate='other-date','deployment_surface_changed'],
  ['reviewed source pin mismatch',x=>x.candidate.moduleSha256='e'.repeat(64),'reviewed_pins_mismatch'],
  ['disabled control with prior generation',x=>{x.control.tablePresent=true;x.control.enabled=0;x.control.generation=1;x.control.appliedGeneration=0;},'control_not_dormant'],
  ['enabled control',x=>{x.control.tablePresent=true;x.control.enabled=1;x.control.generation=0;x.control.appliedGeneration=0;},'control_not_dormant'],
  ['lease active',x=>{x.control.tablePresent=true;x.control.enabled=0;x.control.generation=0;x.control.appliedGeneration=0;x.control.leaseId='lease';},'control_not_dormant'],
  ['cohort changed',x=>{x.cohortAfter.rows[0].displayName='Changed';x.cohortAfter.cohortSha256=digest(canonical(x.cohortAfter.rows));},'cohort_changed_during_preparation'],
  ['alternate binding changed',x=>x.alternateBindingsAfter.pendingIntentCount=1,'alternate_bindings_changed_during_preparation'],
  ['group changed',x=>x.groupAfterObservation=groupObservation(['owner@example.test']),'group_observation_invalid'],
]) test(`refuses ${label}`,()=>{
  const value=qualifiedFixture(); mutate(value);
  assert.throws(()=>compileNativeStaffSyncPreparation(value),new RegExp(code));
});

test('retains unrelated existing group members exactly during prep without writing them',()=>{
  const value=qualifiedFixture();
  value.groupBeforeObservation=groupObservation(['owner@example.test','staff@example.test','historical-member@example.test'],-1000);
  value.groupAfterObservation=groupObservation(['owner@example.test','staff@example.test','historical-member@example.test']);
  const receipt=compileNativeStaffSyncPreparation(value);
  assert.equal(receipt.activeStaffCount,1);
  assert.equal(receipt.currentGroupCount,3);
  assert.equal(receipt.accessGroupObservations.after.managedEmailsSha256,value.groupAfterObservation.managedEmailsSha256);
  assert.equal(JSON.stringify(receipt.accessGroupObservations).includes('historical-member@example.test'),false);
});

test('rejects stale, cross-account, cross-group and policy-drifted observations',()=>{
  const stale=qualifiedFixture();
  stale.groupBeforeObservation=groupObservation(['owner@example.test','staff@example.test'],-11*60_000);
  assert.throws(()=>compileNativeStaffSyncPreparation(stale),/group_observation_invalid/u);
  const cross=qualifiedFixture();
  cross.groupAfterObservation=groupObservation(['owner@example.test','staff@example.test'],0,{groupId:'22222222-2222-4222-8222-222222222222'});
  assert.throws(()=>compileNativeStaffSyncPreparation(cross),/group_observation_invalid/u);
  const policy=qualifiedFixture();
  policy.groupAfterObservation=groupObservation(['owner@example.test','staff@example.test'],0,{policySha256:'0'.repeat(64)});
  policy.groupAfterObservation.evidenceSha256=digest(canonical(Object.fromEntries(Object.entries(policy.groupAfterObservation).filter(([key])=>key!=='evidenceSha256'))));
  assert.throws(()=>compileNativeStaffSyncPreparation(policy),/group_observation_invalid/u);
});

test('rejects binding values instead of recording secrets in a preparation artifact',()=>{
  const value=qualifiedFixture();
  value.candidate.bindings[0]={name:'OPS_DB',type:'d1',resourceId:'ops-db-id',secretValue:'do-not-record'};
  assert.throws(()=>compileNativeStaffSyncPreparation(value),/binding_metadata_invalid/u);
});

test('includes each currently verified alternate owner login in the derived desired group',()=>{
  const value=qualifiedFixture();
  const binding={bindingId:'11111111-1111-4111-8111-111111111111',staffId:'owner',loginEmail:'tech@example.test',
    accessSubject:'access|alternate-tech',issuer:'https://example.cloudflareaccess.com',bindingVersion:1,status:'active',
    intentId:'22222222-2222-4222-8222-222222222222',intentStatus:'claimed',intentBindingId:'22222222-2222-4222-8222-222222222222',
    intentGeneration:0,canonicalEmail:'owner@example.test',canonicalSubject:'access|owner',staffStatus:'active',admissionActive:1,
    admissionSubject:'access|owner',profileEmail:'owner@example.test',generation:1,ownerGlobal:true,ownerAdminDeny:false};
  value.alternateBindingsBefore.activeBindings=[binding];
  value.alternateBindingsAfter.activeBindings=[structuredClone(binding)];
  const receipt=compileNativeStaffSyncPreparation(value);
  assert.equal(receipt.activeAlternateBindingCount,1);
});

test('does not treat an email-only or pending alias as an accepted alternate identity',()=>{
  const value=qualifiedFixture();
  const emailOnly={bindingId:'11111111-1111-4111-8111-111111111111',staffId:'owner',loginEmail:'tech@example.test',
    accessSubject:'access|alternate-tech',issuer:'https://example.cloudflareaccess.com',bindingVersion:1,status:'active',
    intentId:'22222222-2222-4222-8222-222222222222',intentStatus:'pending',intentBindingId:null,intentGeneration:0,
    canonicalEmail:'owner@example.test',canonicalSubject:'access|owner',staffStatus:'active',admissionActive:1,
    admissionSubject:'access|owner',profileEmail:'owner@example.test',generation:1,ownerGlobal:true,ownerAdminDeny:false};
  value.alternateBindingsBefore.activeBindings=[emailOnly];
  value.alternateBindingsAfter.activeBindings=[structuredClone(emailOnly)];
  assert.throws(()=>compileNativeStaffSyncPreparation(value),/alternate_binding_not_currently_authorized/u);
});

test('rejects modified source evidence and no longer consumes caller-supplied behavior booleans',()=>{
  const value=qualifiedFixture();
  value.sourceEvidence.files[0].sha256='f'.repeat(64);
  assert.throws(()=>compileNativeStaffSyncPreparation(value),/source_evidence_mismatch/u);
});

test('rejects a module hash that does not equal the locally built candidate bytes',()=>{
  const value=qualifiedFixture();
  value.qualificationEvidence.builtModuleSha256='f'.repeat(64);
  assert.throws(()=>compileNativeStaffSyncPreparation(value),/behavior_qualification_invalid/u);
});

test('rejects Git source override environment before reading candidate commit objects',()=>{
  const prior=process.env.GIT_DIR;
  process.env.GIT_DIR='C:/untrusted/git-dir';
  try { assert.throws(()=>deriveNativeStaffSyncSourceEvidence({repositoryRoot,sourceCommit:candidateCommit,moduleSha256:'c'.repeat(64)}),/git_environment_override/u); }
  finally { if(prior===undefined)delete process.env.GIT_DIR;else process.env.GIT_DIR=prior; }
});

test('qualification runner refuses a candidate commit that is not checked out before running tests or build',()=>{
  assert.throws(()=>runNativeStaffSyncQualification({sourceCommit:'f'.repeat(40),candidateModuleSha256:'c'.repeat(64)}),
    /candidate_not_checked_out/u);
});
