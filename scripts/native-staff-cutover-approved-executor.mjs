import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, runPinnedCloudflaredToken, verifyCloudflareAccessJwt } from './native-staff-bootstrap-owner-approval.mjs';
import { createApprovedExecutorD1Provider } from './native-staff-bootstrap-approved-executor.mjs';
import { assertPinnedIssuerDistribution } from './native-staff-bootstrap-owner-approval-distribution-pin.mjs';
import { executeNativeStaffCutoverD1, prepareNativeStaffCutoverD1, readNativeStaffCutoverSnapshot } from './native-staff-cutover-v1.mjs';
import { assertPinnedNativeStaffCutoverDistribution } from './native-staff-cutover-distribution-pin.mjs';
import { assertPinnedNativeStaffCutoverSource } from './native-staff-cutover-owner-approval.mjs';
import { loadPinnedNativeStaffCutoverConfig } from './native-staff-cutover-approved-executor-config.mjs';
import { acquireNativeStaffCutoverApprovalLease, compileNativeStaffCutoverApprovalContext,
  readNativeStaffCutoverApprovalRegistry, verifyCurrentNativeStaffCutoverOwnerSession,
  verifyNativeStaffCutoverOwnerApprovalReceipt } from './native-staff-cutover-owner-approval.mjs';

const API_ROOT='https://api.cloudflare.com/client/v4';
const WRANGLER_SHA256='a1a7a98e0b073d39dc3229b1b89f66accb51ae557fb34552250f914f12a81efd';
const MAX_FILE_BYTES=16*1024*1024;
const stop=code=>{throw new Error(`native_staff_cutover_executor_${code}`);};
const sha=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);

function privateFile(file,max=MAX_FILE_BYTES){let text;
  try{const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>max)stop('file_invalid');text=readFileSync(file,'utf8');}
  catch(error){if(error instanceof Error&&error.message.startsWith('native_staff_cutover_executor_'))throw error;stop('file_unavailable');}
  try{return JSON.parse(text);}catch{stop('file_json_invalid');}}

function ownerIsBound(snapshot,config){let value;try{value=JSON.parse(snapshot.snapshotJson);}catch{return false;}
  const staffId=config.access.owner.staffId,subject=config.access.owner.accessSubject;
  const by=(table,key,id)=>Array.isArray(value?.rows?.[table])?value.rows[table].find(row=>row?.[key]===id):null;
  const user=by('staff_users','id',staffId),admission=by('native_staff_admissions','staff_id',staffId),profile=by('native_staff_profiles','staff_id',staffId);
  return Boolean(user?.status==='active'&&user.access_subject===subject&&admission?.active===1
    &&admission.bound_access_subject===subject&&profile?.staff_id===staffId&&Number.isSafeInteger(profile.version)
    &&profile.version>0&&Array.isArray(snapshot.controlPlaneStaffIds)&&snapshot.controlPlaneStaffIds.includes(staffId));}

function accessProofSame(initial,current,config){return Boolean(initial?.staffId===config.access.owner.staffId
  &&current?.staffId===config.access.owner.staffId
  &&initial.claims?.subject===current.claims?.subject&&initial.claims?.issuer===current.claims?.issuer
  &&initial.claims?.audience===current.claims?.audience&&current.claims?.expiresAt*1000>Date.now());}

function lowLevelInput(candidate,receipt,config){
  const compiled=compileNativeStaffCutoverApprovalContext(candidate,config),env=receipt.payload.trustEnvelope;
  return {schemaVersion:1,approval:{approvalId:candidate.approvalId,operatorStaffId:config.access.owner.staffId,
    operatorSubject:config.access.owner.accessSubject,issuedAt:env.authorizedAt,expiresAt:env.expiresAt},
    commandId:candidate.commandId,canonicalPlanJson:compiled.compiled.canonicalPlanJson,
    bindingEvidenceJson:compiled.compiled.bindingEvidenceJson,reviewedSnapshot:candidate.reviewedSnapshot,
    controlPlaneStaffIds:candidate.controlPlaneStaffIds,operator:candidate.operator,
    syncPreparationReceipt:candidate.syncPreparationReceipt,trustEnvelope:env};
}

function registryEntry(config,receipt,expectedState,expectedStateSha){
  const state=readNativeStaffCutoverApprovalRegistry(config);
  const context=receipt.payload.approvalContext.cutoverApprovalContext;
  const entry=state.envelope.payload.entries.find(row=>row.approvalId===context.approvalId);
  if(!entry||entry.commandId!==context.commandId||entry.receiptSha256!==sha(canonicalJson(receipt))
    ||entry.contextSha256!==receipt.payload.approvalContextSha256||entry.state!==expectedState
    ||expectedStateSha&&state.stateSha256!==expectedStateSha)stop('approval_registry_state_invalid');
  return state;
}

function approvalVerifier(config,candidate,receipt,session,stateName,stateSha){
  return async input=>{
    try{
      const signed=verifyNativeStaffCutoverOwnerApprovalReceipt(receipt,{config,expectedArtifact:candidate});
      if(!same(input.cutoverApprovalContext,receipt.payload.approvalContext.cutoverApprovalContext)
        ||input.cutoverApprovalContextSha256!==signed.cutoverContextSha256||input.planSha256!==signed.planSha256
        ||input.bindingSha256!==receipt.payload.bindingEvidenceSha256||input.snapshotSha256!==signed.snapshotSha256
        ||input.input?.approval?.approvalId!==signed.approvalId||input.input?.commandId!==signed.commandId
        ||!same(input.input?.trustEnvelope,receipt.payload.trustEnvelope))return false;
      registryEntry(config,receipt,stateName,stateSha);
      return session.staffId===config.access.owner.staffId&&session.claims.subject===config.access.owner.accessSubject
        &&session.claims.expiresAt*1000>Date.now();
    }catch{return false;}
  };
}

function executionDigest(config,candidate,receipt,target){return sha(canonicalJson({schemaVersion:1,action:'native-staff-cutover',
  target:config.target,source:config.source,candidateSha256:sha(canonicalJson(candidate)),receiptSha256:sha(canonicalJson(receipt)),
  databaseId:target.databaseId,databaseName:target.name}));}

function expectedResultJson(candidate,compiled){return canonicalJson({schemaVersion:1,action:'native-staff-cutover',
  cohortSha256:compiled.compiled.plan.cohortSha256,controlPlaneStaffIds:candidate.controlPlaneStaffIds,
  sourceSnapshotSha256:candidate.reviewedSnapshot.snapshotSha256,
  syncPreparationReceiptSha256:candidate.syncPreparationReceipt.receiptSha256,
  currentGroupSha256:candidate.syncPreparationReceipt.currentGroupSha256,
  desiredGroupSha256:candidate.syncPreparationReceipt.desiredGroupSha256,
  currentGroupCount:candidate.syncPreparationReceipt.currentGroupCount,
  desiredGroupCount:candidate.syncPreparationReceipt.desiredGroupCount,generation:0,enabled:1});}

async function durableCutoverMatches(provider,candidate,receipt,config){
  const compiled=compileNativeStaffCutoverApprovalContext(candidate,config),env=receipt.payload.trustEnvelope;
  const approval=await provider.prepare(`SELECT approval_id,canonical_plan_json,canonical_plan_sha256,approved_operator_staff_id,
    approved_operator_access_subject,independent_binding_verification_json,independent_binding_verification_sha256,
    issued_by_staff_id,issued_by_access_subject,issued_at,expires_at,revoked_at FROM native_staff_bootstrap_approvals WHERE approval_id=?`)
    .bind(candidate.approvalId).first();
  const resultJson=expectedResultJson(candidate,compiled),resultSha=sha(resultJson);
  const receiptRow=await provider.prepare(`SELECT command_id,approval_id,operator_staff_id,operator_access_subject,canonical_plan_json,
    canonical_plan_sha256,independent_binding_verification_json,independent_binding_verification_sha256,result_json,result_sha256
    FROM native_staff_bootstrap_receipts WHERE command_id=?`).bind(candidate.commandId).first();
  const control=await provider.prepare(`SELECT enabled,generation,applied_generation,lease_id,lease_until,attempt_generation,last_success_at,last_error
    FROM native_staff_access_reconciliation WHERE singleton=1`).first();
  return Boolean(approval&&receiptRow&&control&&approval.approval_id===candidate.approvalId
    &&approval.canonical_plan_json===compiled.compiled.canonicalPlanJson&&approval.canonical_plan_sha256===compiled.compiled.planSha256
    &&approval.approved_operator_staff_id===config.access.owner.staffId
    &&approval.approved_operator_access_subject===config.access.owner.accessSubject
    &&approval.issued_by_staff_id===config.access.owner.staffId&&approval.issued_by_access_subject===config.access.owner.accessSubject
    &&approval.issued_at===env.authorizedAt&&approval.expires_at===env.expiresAt&&approval.revoked_at===null
    &&approval.independent_binding_verification_json===compiled.compiled.bindingEvidenceJson
    &&approval.independent_binding_verification_sha256===compiled.compiled.bindingSha256
    &&receiptRow.command_id===candidate.commandId&&receiptRow.approval_id===candidate.approvalId
    &&receiptRow.operator_staff_id===config.access.owner.staffId&&receiptRow.operator_access_subject===config.access.owner.accessSubject
    &&receiptRow.canonical_plan_json===compiled.compiled.canonicalPlanJson&&receiptRow.canonical_plan_sha256===compiled.compiled.planSha256
    &&receiptRow.independent_binding_verification_json===compiled.compiled.bindingEvidenceJson
    &&receiptRow.independent_binding_verification_sha256===compiled.compiled.bindingSha256
    &&receiptRow.result_json===resultJson&&receiptRow.result_sha256===resultSha
    &&control.enabled===1&&control.generation===0&&control.applied_generation===0&&control.lease_id===null
    &&control.lease_until===null&&control.attempt_generation===null&&control.last_success_at===null&&control.last_error===null);
}

/** Read-only preview by default; execute requires the exact displayed digest and a one-shot signed lease. */
export async function runNativeStaffCutoverApprovedExecutor({candidate,receipt,mode='preview',preparedSha256,
  getAccessToken=()=>runPinnedCloudflaredToken(loadPinnedNativeStaffCutoverConfig()),getBearerToken,fetchImpl=globalThis.fetch,now=Date.now()}={}){
  if(!['preview','execute'].includes(mode)||!candidate||!receipt||typeof getAccessToken!=='function'
    ||typeof getBearerToken!=='function'||typeof fetchImpl!=='function')stop('arguments_invalid');
  assertPinnedNativeStaffCutoverDistribution();assertPinnedIssuerDistribution();
  const config=loadPinnedNativeStaffCutoverConfig();
  assertPinnedNativeStaffCutoverSource(config);
  const compiled=compileNativeStaffCutoverApprovalContext(candidate,config);
  verifyNativeStaffCutoverOwnerApprovalReceipt(receipt,{config,expectedArtifact:candidate,now});
  const initialRegistry=registryEntry(config,receipt,'issued');
  const provider=createApprovedExecutorD1Provider({config,getBearerToken,fetchImpl});
  const target=await provider.assertTarget();
  if(target.databaseId!==config.target.databaseId||target.name!==config.target.databaseName)stop('target_metadata_mismatch');
  let session=await verifyCurrentNativeStaffCutoverOwnerSession(config,await getAccessToken(),{fetchImpl,now});
  const snapshot=await readNativeStaffCutoverSnapshot(provider);
  if(snapshot.snapshotSha256!==candidate.reviewedSnapshot.snapshotSha256||snapshot.snapshotJson!==candidate.reviewedSnapshot.snapshotJson
    ||canonicalJson([...snapshot.controlPlaneStaffIds].sort())!==canonicalJson([...candidate.controlPlaneStaffIds].sort())||!ownerIsBound(snapshot,config))
    stop('current_snapshot_or_owner_changed');
  let verifyApproval=approvalVerifier(config,candidate,receipt,session,'issued');
  const input=lowLevelInput(candidate,receipt,config);
  const prepared=await prepareNativeStaffCutoverD1(input,{db:provider,verifyApproval});
  const digest=executionDigest(config,candidate,receipt,target);
  if(mode==='preview')return Object.freeze({mode,preparedSha256:digest,targetDatabaseId:target.databaseId,
    snapshotSha256:snapshot.snapshotSha256,approvalContextSha256:compiled.contextSha256,planSha256:compiled.context.planSha256,
    staffCount:compiled.compiled.cohort.length,desiredGroupCount:candidate.syncPreparationReceipt.desiredGroupCount});
  if(!/^[0-9a-f]{64}$/u.test(preparedSha256??'')||preparedSha256!==digest)stop('prepared_digest_mismatch');
  const lease=acquireNativeStaffCutoverApprovalLease(config,receipt);let dispatchStarted=false,finished=false;
  const finish=outcome=>{if(!finished){lease.finish(outcome);finished=true;}};
  try{
    session=await verifyCurrentNativeStaffCutoverOwnerSession(config,await getAccessToken(),{fetchImpl,now:Date.now()});
    if(session.staffId!==config.access.owner.staffId)stop('current_owner_changed');
    const current=await readNativeStaffCutoverSnapshot(provider);
    if(current.snapshotSha256!==candidate.reviewedSnapshot.snapshotSha256||current.snapshotJson!==candidate.reviewedSnapshot.snapshotJson||!ownerIsBound(current,config))
      stop('current_snapshot_or_owner_changed');
    verifyApproval=approvalVerifier(config,candidate,receipt,session,'dispatching',lease.stateSha256);
    const executePrepared=await prepareNativeStaffCutoverD1(input,{db:provider,verifyApproval});
    const result=await executeNativeStaffCutoverD1(provider,executePrepared,{verifyApproval,beforeMutationDispatch:async dispatch=>{
      if(!same(dispatch,{schemaVersion:1,commandId:candidate.commandId,approvalId:candidate.approvalId,
        snapshotSha256:candidate.reviewedSnapshot.snapshotSha256,planSha256:compiled.compiled.planSha256,
        bindingSha256:compiled.compiled.bindingSha256}))stop('dispatch_context_mismatch');
      const fresh=await verifyCurrentNativeStaffCutoverOwnerSession(config,await getAccessToken(),{fetchImpl,now:Date.now()});
      if(fresh.staffId!==config.access.owner.staffId||fresh.claims.subject!==session.claims.subject||fresh.claims.issuer!==session.claims.issuer
        ||fresh.claims.audience!==session.claims.audience)stop('current_owner_changed');
      const latest=await readNativeStaffCutoverSnapshot(provider);
      if(latest.snapshotSha256!==candidate.reviewedSnapshot.snapshotSha256||latest.snapshotJson!==candidate.reviewedSnapshot.snapshotJson
        ||!ownerIsBound(latest,config))stop('current_snapshot_or_owner_changed');
      const recheckedTarget=await provider.assertTarget();
      if(recheckedTarget.databaseId!==config.target.databaseId||recheckedTarget.name!==config.target.databaseName)stop('target_metadata_mismatch');
      registryEntry(config,receipt,'dispatching',lease.stateSha256);
      dispatchStarted=true;
    }});
    if(!await durableCutoverMatches(provider,candidate,receipt,config))stop('durable_result_not_observed');
    finish('consumed');
    return Object.freeze({mode,outcome:'consumed',approvalId:result.approvalId,commandId:result.commandId,
      cohortSha256:result.cohortSha256,planSha256:result.planSha256,snapshotSha256:result.snapshotSha256});
  }catch(error){
    if(dispatchStarted){try{finish(await durableCutoverMatches(provider,candidate,receipt,config)?'consumed':'uncertain');}catch{finish('uncertain');}}
    else finish('uncertain');
    throw error;
  }
}

function readCandidate(file){return privateFile(path.resolve(file));}
export async function wranglerBearerToken(){
  const root=fileURLToPath(new URL('..',import.meta.url)),cli=path.join(root,'apps','operations','node_modules','wrangler','wrangler-dist','cli.js');
  if(sha(readFileSync(cli))!=='a1a7a98e0b073d39dc3229b1b89f66accb51ae557fb34552250f914f12a81efd')stop('wrangler_runtime_pin_mismatch');
  const env={};for(const key of ['SystemRoot','WINDIR','PATH','COMSPEC','USERPROFILE','APPDATA','LOCALAPPDATA','HOME','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
  Object.assign(env,{CI:'true',NO_COLOR:'1',WRANGLER_LOG:'log',WRANGLER_SEND_METRICS:'false',WRANGLER_SEND_ERROR_REPORTS:'false',
    WRANGLER_WRITE_LOGS:'false',CLOUDFLARE_API_BASE_URL:API_ROOT});
  return new Promise((resolve,reject)=>{let child,parts=[],size=0,done=false;const timer=setTimeout(fail,45_000);
    function fail(){if(done)return;done=true;clearTimeout(timer);try{child?.kill();}catch{}reject(Error('native_staff_cutover_executor_provider_auth_unavailable'));}
    try{child=spawn(process.execPath,[cli,'auth','token','--json'],{cwd:root,env,shell:false,windowsHide:true,stdio:['ignore','pipe','ignore']});}
    catch{fail();return;}child.stdout.on('data',chunk=>{size+=chunk.length;if(size>24_576)fail();else parts.push(Buffer.from(chunk));});
    child.stderr.on('data',()=>{});child.on('error',fail);child.on('close',code=>{if(done)return;done=true;clearTimeout(timer);try{
      if(code!==0)throw Error();const value=JSON.parse(Buffer.concat(parts).toString('utf8'));
      if(!value||!['oauth','api_token'].includes(value.type)||typeof value.token!=='string'||value.token.length<20||value.token.length>16_384
        ||!/^[\x21-\x7e]+$/u.test(value.token))throw Error();resolve(value.token);
    }catch{reject(Error('native_staff_cutover_executor_provider_auth_unavailable'));}});});
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  (async()=>{assertPinnedNativeStaffCutoverDistribution();assertPinnedIssuerDistribution();const config=loadPinnedNativeStaffCutoverConfig();
    if(process.argv[2]!=='--candidate'||process.argv.length<4)stop('usage');const candidate=readCandidate(process.argv[3]);
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate?.approvalId??''))stop('candidate_invalid');
    const receiptFile=path.join(config.receiptDirectory,`native-staff-cutover-owner-approval-${candidate.approvalId}.json`);
    const execute=process.argv[4]==='--execute';
    if(process.argv.length!==(execute?7:4)||execute&&(process.argv[5]!=='--prepared-sha256'||! /^[0-9a-f]{64}$/u.test(process.argv[6]??'')))stop('usage');
    const receipt=privateFile(receiptFile,2*1024*1024);const result=await runNativeStaffCutoverApprovedExecutor({candidate,receipt,mode:execute?'execute':'preview',
      preparedSha256:execute?process.argv[6]:undefined,getAccessToken:()=>runPinnedCloudflaredToken(config),getBearerToken:wranglerBearerToken});
    process.stdout.write(`${canonicalJson(result)}\n`);})().catch(error=>{const code=error instanceof Error&&/^native_staff_cutover_executor_[a-z0-9_]+$/u.test(error.message)?error.message:'native_staff_cutover_executor_unavailable';
      process.stderr.write(`${code}\n`);process.exitCode=1;});
}
