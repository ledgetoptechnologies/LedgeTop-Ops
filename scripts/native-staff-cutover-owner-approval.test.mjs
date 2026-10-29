import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants, createHash, createPublicKey, generateKeyPairSync, sign as signBytes, verify as verifyBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalJson, protectedSign } from './native-staff-bootstrap-owner-approval.mjs';
import { loadPinnedNativeStaffCutoverConfig, parseNativeStaffCutoverConfig } from './native-staff-cutover-approved-executor-config.mjs';
import { assertPinnedNativeStaffCutoverDistribution } from './native-staff-cutover-distribution-pin.mjs';
import { NATIVE_STAFF_CUTOVER_CONSENT_PREFIX, acquireNativeStaffCutoverApprovalLease,
  assertPinnedNativeStaffCutoverSource, bindNativeStaffCutoverObservedGroupToCandidate,
  buildNativeStaffCutoverOwnerApprovalReceipt, compileNativeStaffCutoverApprovalContext, initializeNativeStaffCutoverApprovalRegistry,
  issueNativeStaffCutoverApproval, nativeStaffCutoverConsentText, readNativeStaffCutoverApprovalRegistry,
  revokeNativeStaffCutoverApproval, verifyCurrentNativeStaffCutoverOwnerSession,
  verifyNativeStaffCutoverOwnerApprovalReceipt, writeNativeStaffCutoverReceiptFile } from './native-staff-cutover-owner-approval.mjs';
import { compileNativeStaffCutoverV1 } from './native-staff-cutover-v1.mjs';
import { runNativeStaffCutoverApprovedExecutor } from './native-staff-cutover-approved-executor.mjs';
import { readNativeStaffAccessGroupObservation } from './native-staff-cutover-access-group-observation.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const uuid=n=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
const stable=value=>canonicalJson(value);
const ok=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});

function makeProtectedSigner(directory){
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:3072});
  const entropy='synthetic-cutover-dpapi-entropy-material-only';
  const input=JSON.stringify({privateKeyBase64:privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),entropy});
  const protect=spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',
    '$a=Join-Path $PSHOME "System.Security.Cryptography.ProtectedData.dll"; Add-Type -Path $a; $r=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()); $p=[Convert]::FromBase64String($r.privateKeyBase64); $e=[Text.Encoding]::UTF8.GetBytes($r.entropy); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($p,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)))'],
    {input,encoding:'utf8',windowsHide:true,timeout:20_000,maxBuffer:32*1024,stdio:['pipe','pipe','pipe']});
  assert.equal(protect.status,0,String(protect.stderr??''));
  const protectedPrivateKeyPath=path.join(directory,'cutover-test-key.dpapi');
  writeFileSync(protectedPrivateKeyPath,Buffer.from(protect.stdout.trim(),'base64'),{flag:'wx',mode:0o600});
  return {privateKey,publicKey,entropy,protectedPrivateKeyPath};
}

function makeConfig(directory,signer){
  const publicKeyPem=signer.publicKey.export({type:'spki',format:'pem'});
  const keyId=sha(createPublicKey(publicKeyPem).export({type:'spki',format:'der'}));
  return {schemaVersion:1,kind:'operations-native-staff-cutover-trust-config-v1',
    target:{accountId:'a'.repeat(32),databaseId:uuid(100),databaseName:'synthetic-cutover-db'},
    accessGroup:{id:uuid(101),name:'Synthetic Ops Staff'},
    source:{commit:'b'.repeat(40),migrationNamesSha256:'c'.repeat(64),migrationContentsSha256:'d'.repeat(64),
      cutoverModuleSha256:'e'.repeat(64),syncPreparationModuleSha256:'f'.repeat(64),accessGroupModuleSha256:'0'.repeat(64),installerModuleSha256:'1'.repeat(64)},
    access:{origin:'https://ops.example.test',issuer:'https://synthetic.cloudflareaccess.com',audience:'A'.repeat(32),
      owner:{staffId:'owner-synthetic',accessSubject:'access|owner-synthetic'},cloudflaredExecutablePath:'C:\\synthetic\\cloudflared.exe',
      cloudflaredExecutableSha256:'2'.repeat(64)},
    signer:{algorithm:'RSA-PSS-SHA256',keyId,publicKeyPem,protectedPrivateKeyPath:signer.protectedPrivateKeyPath,dpapiEntropy:signer.entropy},
    receiptDirectory:directory};
}

function candidateFor(config,serial=1){
  const owner={id:config.access.owner.staffId,email:'owner@example.test',display_name:'Synthetic Owner',
    access_subject:config.access.owner.accessSubject,status:'active',version:1};
  const admission={staff_id:owner.id,bound_access_subject:owner.access_subject,active:1,admitted_by:owner.id,version:1};
  const profile={staff_id:owner.id,login_email:owner.email,display_name:owner.display_name,version:1};
  const migrationNames=readdirSync(fileURLToPath(new URL('../apps/operations/migrations/',import.meta.url)))
    .filter(name=>/^\d{4}_.+\.sql$/u.test(name)&&Number(name.slice(0,4))<=230).sort();
  const snapshot={schema_count:[4],schema:[],ledger:migrationNames,rows:{staff_users:[owner],native_staff_admissions:[admission],
    native_staff_profiles:[profile],native_staff_access_reconciliation:[{singleton:1,enabled:0,generation:0,applied_generation:0,
      lease_id:null,lease_until:null,attempt_generation:null,last_success_at:null,last_error:null}]}};
  const snapshotJson=stable(snapshot),reviewedSnapshot={snapshotJson,snapshotSha256:sha(snapshotJson),migrationNames,
    migrationNamesSha256:sha(migrationNames.join('\n')),currentStaffCount:1,controlPlaneStaffIds:[owner.id]};
  const cohort=[{staffId:owner.id,email:owner.email,accessSubject:owner.access_subject,displayName:owner.display_name,active:true,
    admissionVersion:1,profileVersion:1}];
  const cohortSha256=sha(stable(cohort)),group=[owner.email];
  const groupPolicy={exclude:[],require:[],is_default:[]};
  const groupObservation=()=>{
    const body={schemaVersion:1,kind:'cloudflare-access-group-observation-v1',accountId:config.target.accountId,
      groupId:config.accessGroup.id,groupName:config.accessGroup.name,observedAt:new Date().toISOString(),
      managedEmailCount:group.length,managedEmailsSha256:sha(stable(group)),includeRuleCount:group.length,
      policySha256:sha(stable(groupPolicy)),providerResponseSha256:'9'.repeat(64)};
    return {...body,evidenceSha256:sha(stable(body))};
  };
  const prep={schemaVersion:1,kind:'operations-native-staff-sync-dormant-preparation-v1',accountId:config.target.accountId,workerName:'ltds-ops-sync',
    environment:'production',databaseId:uuid(101),activeRuntimeVersion:'runtime-a',candidateRuntimeVersion:'runtime-a',
    activeSettingsSha256:'3'.repeat(64),candidateSettingsSha256:'4'.repeat(64),bindingsSha256:'5'.repeat(64),activeModuleSha256:'6'.repeat(64),
    candidateModuleSha256:'7'.repeat(64),activeSourceCommit:'8'.repeat(40),candidateSourceCommit:'9'.repeat(40),controlState:'disabled',
    cohortSha256,activeStaffCount:1,activeAlternateBindingCount:0,alternateBindingEvidenceSha256:'a'.repeat(64),
    candidateSourceTreeSha256:'b'.repeat(64),sourceEvidenceSha256:'c'.repeat(64),behaviorQualificationSha256:'d'.repeat(64),
    testReportSha256:'e'.repeat(64),builtModuleSha256:'7'.repeat(64),qualificationRunnerSha256:'f'.repeat(64),
    accessGroupObservations:{before:groupObservation(),after:groupObservation()},
    currentGroupCount:1,currentGroupSha256:sha(stable(group)),
    desiredGroupCount:1,desiredGroupSha256:sha(stable(group))};
  const syncPreparationReceipt={...prep,receiptSha256:sha(stable(prep))};
  // Confirm fixture construction remains aligned with the production compiler.
  compileNativeStaffCutoverV1({reviewedSnapshot,controlPlaneStaffIds:[owner.id],operator:{staffId:owner.id,accessSubject:owner.access_subject},syncPreparationReceipt});
  return {schemaVersion:1,kind:'operations-native-staff-cutover-candidate-v1',approvalId:uuid(serial),commandId:uuid(serial+1),
    reviewedSnapshot,controlPlaneStaffIds:[owner.id],operator:{staffId:owner.id,accessSubject:owner.access_subject},syncPreparationReceipt};
}

function replaceObservationFields(value,changes){
  const {evidenceSha256:_old,...body}=value;
  const updated={...body,...changes};
  return {...updated,evidenceSha256:sha(stable(updated))};
}

function makeAccessToken(config){
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),kid='synthetic-access-kid';
  const now=Math.floor(Date.now()/1000),claims={iss:config.access.issuer,aud:config.access.audience,type:'app',sub:config.access.owner.accessSubject,
    exp:now+600,iat:now-5};
  const part=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const input=`${part({alg:'RS256',kid,typ:'JWT'})}.${part(claims)}`;
  const token=`${input}.${signBytes('RSA-SHA256',Buffer.from(input),privateKey).toString('base64url')}`;
  const jwk={...publicKey.export({format:'jwk'}),kid,alg:'RS256',use:'sig'};
  const fetchImpl=async url=>String(url).includes('/cdn-cgi/access/certs')?ok({keys:[jwk]}):ok({user:{id:config.access.owner.staffId},csrfToken:'x'.repeat(40)});
  return {token,fetchImpl,jwk};
}

test('cutover trust config and both runtime distribution pins fail closed before reading credentials',()=>{
  assert.throws(()=>loadPinnedNativeStaffCutoverConfig(),/config_pin_unprovisioned/u);
  assert.throws(()=>parseNativeStaffCutoverConfig('{}','0'.repeat(64)),/pin_mismatch/u);
  assert.throws(()=>assertPinnedNativeStaffCutoverDistribution(),/pin_unprovisioned/u);
});

test('approved executor cannot reach Access or D1 while its independent distribution pins are unprovisioned',async()=>{
  let accessCalls=0,bearerCalls=0,groupTokenCalls=0;
  await assert.rejects(runNativeStaffCutoverApprovedExecutor({candidate:{},receipt:{},
    getAccessToken:async()=>{accessCalls++;return 'unused';},getBearerToken:async()=>{bearerCalls++;return 'unused';},
    getAccessGroupReadCredential:async()=>{groupTokenCalls++;return {schemaVersion:1,accountId:'a'.repeat(32),
      groupId:uuid(101),groupName:'Synthetic Ops Staff',token:'unused'};},
    fetchImpl:async()=>{throw new Error('must-not-fetch');}}),/distribution_pin_unprovisioned/u);
  assert.equal(accessCalls,0);assert.equal(bearerCalls,0);assert.equal(groupTokenCalls,0);
});

test('owner consent artifact binds two actual fresh group observations and replaces candidate-supplied observation hashes',async()=>{
  const config=makeConfig(os.tmpdir(),{publicKey:generateKeyPairSync('rsa',{modulusLength:3072}).publicKey,
    protectedPrivateKeyPath:'C:\\synthetic\\unused.dpapi',entropy:'synthetic-dpapi-entropy-material'});
  // The group evidence is tested independently of signer use; the trust key fields
  // above are synthetic and this helper performs no provider or signing call.
  const candidate=candidateFor(config),reported=candidate.syncPreparationReceipt.accessGroupObservations.after;
  const read=async(members,now)=>readNativeStaffAccessGroupObservation({config,getAccessGroupReadCredential:async()=>({schemaVersion:1,
    accountId:config.target.accountId,groupId:config.accessGroup.id,groupName:config.accessGroup.name,token:'synthetic-test-token-value'}),now:()=>now,
    fetchImpl:async()=>ok({success:true,result:{id:config.accessGroup.id,name:config.accessGroup.name,
      include:members.map(email=>({email:{email}})),exclude:[],require:[],is_default:[]}})});
  const before=await read(['owner@example.test'],Date.now()-1000),after=await read(['owner@example.test'],Date.now());
  const bound=bindNativeStaffCutoverObservedGroupToCandidate(candidate,{before,after},config);
  assert.deepEqual(bound.artifact.syncPreparationReceipt.accessGroupObservations,{before,after});
  assert.notEqual(bound.artifact.syncPreparationReceipt.receiptSha256,candidate.syncPreparationReceipt.receiptSha256);
  assert.notEqual(bound.compiled.contextSha256,compileNativeStaffCutoverApprovalContext(candidate,config).contextSha256);
  const drift=await read(['owner@example.test','other@example.test'],Date.now());
  assert.throws(()=>bindNativeStaffCutoverObservedGroupToCandidate(candidate,{before,after:drift},config),/fresh_group_observation_invalid/u);
  const serialized=structuredClone(after);
  assert.throws(()=>bindNativeStaffCutoverObservedGroupToCandidate(candidate,{before,after:serialized},config),/fresh_group_observation_invalid/u);
});

test('230-source pin requires the contiguous committed migration chain and a clean pinned Git diff',()=>{
  const root=fileURLToPath(new URL('../',import.meta.url)),names=readdirSync(path.join(root,'apps','operations','migrations'))
    .filter(name=>/^\d{4}_.+\.sql$/u.test(name)&&Number(name.slice(0,4))<=230).sort();
  const reviewedSuccessor='0231_owner_google_ads_summary.sql';
  const modulePaths=['scripts/native-staff-cutover-v1.mjs','scripts/native-staff-sync-preparation.mjs',
    'scripts/native-staff-cutover-access-group-observation.mjs','scripts/native-staff-bootstrap-d1.mjs'];
  const moduleBytes=Object.fromEntries(modulePaths.map(name=>[name,readFileSync(path.join(root,name))]));
  const contentHash=sha(names.map(name=>`${name}\0${sha(readFileSync(path.join(root,'apps','operations','migrations',name)))}`).join('\n'));
  const config={source:{commit:'b'.repeat(40),migrationNamesSha256:sha(names.join('\n')),migrationContentsSha256:contentHash,
    cutoverModuleSha256:sha(moduleBytes[modulePaths[0]]),syncPreparationModuleSha256:sha(moduleBytes[modulePaths[1]]),
    accessGroupModuleSha256:sha(moduleBytes[modulePaths[2]]),installerModuleSha256:sha(moduleBytes[modulePaths[3]])}};
  const fakeGitFor=(listedNames,diffStatus=0)=>(file,args)=>{
    if(file!=='git'||args[0]!=='-C')throw new Error('unexpected-git-call');
    const command=args[2];if(command==='cat-file')return '';
    if(command==='ls-tree')return listedNames.map(name=>`apps/operations/migrations/${name}`).join('\n');
    if(command==='diff'&&diffStatus)throw Object.assign(new Error('pinned-source-diff'),{status:diffStatus});
    if(command==='diff')return '';
    throw new Error('unexpected-git-command');
  };
  const fakeGit=fakeGitFor(names);
  assert.equal(assertPinnedNativeStaffCutoverSource(config,{cwd:root,run:fakeGit}),true);
  assert.equal(assertPinnedNativeStaffCutoverSource(config,{cwd:root,run:fakeGitFor([...names,reviewedSuccessor])}),true,
    'the pinned source attests only the exact 0001–0230 prefix when the reviewed 0231 source exists');
  assert.throws(()=>assertPinnedNativeStaffCutoverSource({...config,source:{...config.source,migrationNamesSha256:'0'.repeat(64)}},
    {cwd:root,run:fakeGit}),/migration_names_mismatch/u);
  assert.throws(()=>assertPinnedNativeStaffCutoverSource(config,{cwd:root,run:fakeGitFor(names.filter(name=>name!=='0229_owner_intel_source_feed.sql'))}),
    /migration_names_mismatch/u,'a missing migration in the pinned prefix is rejected');
  assert.throws(()=>assertPinnedNativeStaffCutoverSource(config,{cwd:root,run:fakeGitFor([...names,'0230_duplicate.sql'])}),
    /migration_names_mismatch/u,'a duplicate migration number is rejected');
  assert.throws(()=>assertPinnedNativeStaffCutoverSource(config,{cwd:root,run:fakeGitFor([...names,names.at(-1)])}),
    /migration_names_mismatch/u,'a duplicate migration name is rejected');
  assert.throws(()=>assertPinnedNativeStaffCutoverSource(config,{cwd:root,run:fakeGitFor(names,1)}),/source_worktree_mismatch/u);
});

test('cutover receipt binds exact purpose, target/source, full preparation context, and live owner JWT',
  {skip:process.platform!=='win32'},async t=>{
    const directory=mkdtempSync(path.join(os.tmpdir(),'native-staff-cutover-owner-'));
    t.after(()=>rmSync(directory,{recursive:true,force:true}));
    const signer=makeProtectedSigner(directory),config=makeConfig(directory,signer),rawCandidate=candidateFor(config);
    const {token,fetchImpl,jwk}=makeAccessToken(config);
    const read=()=>readNativeStaffAccessGroupObservation({config,getAccessGroupReadCredential:async()=>({schemaVersion:1,accountId:config.target.accountId,
      groupId:config.accessGroup.id,groupName:config.accessGroup.name,token:'synthetic-test-token-value'}),fetchImpl:async()=>ok({success:true,
      result:{id:config.accessGroup.id,name:config.accessGroup.name,include:[{email:{email:'owner@example.test'}}],exclude:[],require:[],is_default:[]}})});
    const candidate=bindNativeStaffCutoverObservedGroupToCandidate(rawCandidate,{before:await read(),after:await read()},config).artifact;
    const session=await verifyCurrentNativeStaffCutoverOwnerSession(config,token,{fetchImpl});
    const consent=nativeStaffCutoverConsentText(candidate,config);
    assert.match(consent,new RegExp(`^${NATIVE_STAFF_CUTOVER_CONSENT_PREFIX} [a-f0-9]{64}$`,'u'));
    assert.notEqual(consent,nativeStaffCutoverConsentText(candidate,{...config,target:{...config.target,databaseId:uuid(999)}}));
    assert.notEqual(consent,nativeStaffCutoverConsentText(candidate,{...config,source:{...config.source,commit:'c'.repeat(40)}}));
    const receipt=buildNativeStaffCutoverOwnerApprovalReceipt({config,artifact:candidate,ownerSession:session,typedConsent:consent,
      authorizationChallenge:sha('synthetic-cutover-challenge')});
    const verified=verifyNativeStaffCutoverOwnerApprovalReceipt(receipt,{config,expectedArtifact:candidate});
    assert.equal(verified.approvalId,candidate.approvalId);assert.equal(verified.commandId,candidate.commandId);
    assert.equal(verified.contextSha256,receipt.payload.approvalContextSha256);
    assert.equal(verifyBytes('sha256',Buffer.from(canonicalJson(receipt.payload)),{key:signer.publicKey,
      padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32},Buffer.from(receipt.signature,'base64')),true);
    const changed=structuredClone(candidate);changed.approvalId=uuid(99);
    assert.throws(()=>verifyNativeStaffCutoverOwnerApprovalReceipt(receipt,{config,expectedArtifact:changed}),/receipt_artifact_mismatch/u);
    const tampered=structuredClone(receipt);tampered.payload.trustEnvelope.action='install-operations-native-staff-bootstrap';
    assert.throws(()=>verifyNativeStaffCutoverOwnerApprovalReceipt(tampered,{config,expectedArtifact:candidate}),/receipt_binding_invalid|receipt_signature_invalid/u);
    assert.throws(()=>buildNativeStaffCutoverOwnerApprovalReceipt({config,artifact:candidate,ownerSession:{claims:session.claims},typedConsent:consent}),
      /verified_owner_session_required/u);
    await assert.rejects(verifyCurrentNativeStaffCutoverOwnerSession(config,token,{fetchImpl:async url=>String(url).includes('/cdn-cgi/access/certs')
      ?ok({keys:[jwk]}):new Response('',{status:302,headers:{location:'/cdn-cgi/access/login'}})}),/session_rejected/u);
  });

test('cutover registry is independently signed, purpose-specific, one-shot, and revocable only before dispatch',
  {skip:process.platform!=='win32'},async t=>{
    const directory=mkdtempSync(path.join(os.tmpdir(),'native-staff-cutover-registry-'));
    t.after(()=>rmSync(directory,{recursive:true,force:true}));
    const signer=makeProtectedSigner(directory),config=makeConfig(directory,signer),rawCandidate=candidateFor(config,10);
    const {token,fetchImpl}=makeAccessToken(config),session=await verifyCurrentNativeStaffCutoverOwnerSession(config,token,{fetchImpl});
    const read=()=>readNativeStaffAccessGroupObservation({config,getAccessGroupReadCredential:async()=>({schemaVersion:1,accountId:config.target.accountId,
      groupId:config.accessGroup.id,groupName:config.accessGroup.name,token:'synthetic-test-token-value'}),fetchImpl:async()=>ok({success:true,
      result:{id:config.accessGroup.id,name:config.accessGroup.name,include:[{email:{email:'owner@example.test'}}],exclude:[],require:[],is_default:[]}})});
    const candidate=bindNativeStaffCutoverObservedGroupToCandidate(rawCandidate,{before:await read(),after:await read()},config).artifact;
    const receipt=buildNativeStaffCutoverOwnerApprovalReceipt({config,artifact:candidate,ownerSession:session,
      typedConsent:nativeStaffCutoverConsentText(candidate,config),authorizationChallenge:sha('registry-challenge')});
    initializeNativeStaffCutoverApprovalRegistry(config);
    writeNativeStaffCutoverReceiptFile(config,receipt);
    const issued=issueNativeStaffCutoverApproval(config,receipt);
    assert.equal(issued.receiptSha256,sha(canonicalJson(receipt)));
    assert.equal(readNativeStaffCutoverApprovalRegistry(config).envelope.kind,'operations-native-staff-cutover-approval-state-v1');
    const lease=acquireNativeStaffCutoverApprovalLease(config,receipt);
    assert.equal(readNativeStaffCutoverApprovalRegistry(config).envelope.payload.entries[0].state,'dispatching');
    assert.throws(()=>acquireNativeStaffCutoverApprovalLease(config,receipt),/registry_locked/u);
    lease.finish('consumed');
    assert.equal(readNativeStaffCutoverApprovalRegistry(config).envelope.payload.entries[0].state,'consumed');
    assert.throws(()=>acquireNativeStaffCutoverApprovalLease(config,receipt),/approval_not_issuable/u);
    const rawSecond=candidateFor(config,20),secondSession=await verifyCurrentNativeStaffCutoverOwnerSession(config,token,{fetchImpl});
    const second=bindNativeStaffCutoverObservedGroupToCandidate(rawSecond,{before:await read(),after:await read()},config).artifact;
    const secondReceipt=buildNativeStaffCutoverOwnerApprovalReceipt({config,artifact:second,ownerSession:secondSession,
      typedConsent:nativeStaffCutoverConsentText(second,config),authorizationChallenge:sha('revoke-challenge')});
    writeNativeStaffCutoverReceiptFile(config,secondReceipt);
    issueNativeStaffCutoverApproval(config,secondReceipt);
    const state=readNativeStaffCutoverApprovalRegistry(config);
    revokeNativeStaffCutoverApproval(config,secondReceipt,state.stateSha256);
    assert.equal(readNativeStaffCutoverApprovalRegistry(config).envelope.payload.entries.find(row=>row.approvalId===second.approvalId).state,'revoked');
    assert.throws(()=>revokeNativeStaffCutoverApproval(config,receipt,state.stateSha256),/registry_changed_after_consent/u);
  });
