import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { lstatSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPinnedIssuerDistribution, canonicalJson, runPinnedCloudflaredToken } from './native-staff-bootstrap-owner-approval.mjs';
import { createApprovedExecutorD1Provider } from './native-staff-bootstrap-approved-executor.mjs';
import { assertPinnedNativeStaffCutoverDistribution } from './native-staff-cutover-distribution-pin.mjs';
import { loadPinnedNativeStaffCutoverConfig } from './native-staff-cutover-approved-executor-config.mjs';
import { assertPinnedNativeStaffCutoverSource, buildNativeStaffCutoverOwnerApprovalReceipt,
  compileNativeStaffCutoverApprovalContext, issueNativeStaffCutoverApproval, readNativeStaffCutoverApprovalRegistry,
  revokeNativeStaffCutoverApproval, verifyCurrentNativeStaffCutoverOwnerSession, verifyNativeStaffCutoverOwnerApprovalReceipt,
  writeNativeStaffCutoverReceiptFile } from './native-staff-cutover-owner-approval.mjs';
import { readNativeStaffCutoverSnapshot } from './native-staff-cutover-v1.mjs';
import { wranglerBearerToken } from './native-staff-cutover-approved-executor.mjs';

const stop=code=>{throw new Error(`native_staff_cutover_issuer_${code}`);};
function readJson(file,max=16*1024*1024){try{const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>max)stop('input_invalid');
  return JSON.parse(readFileSync(file,'utf8'));}catch(error){if(error instanceof Error&&error.message.startsWith('native_staff_cutover_issuer_'))throw error;stop('input_invalid');}}
function sameSnapshot(left,right){return left?.snapshotSha256===right?.snapshotSha256&&left?.snapshotJson===right?.snapshotJson
  &&canonicalJson([...(left?.controlPlaneStaffIds??[])].sort())===canonicalJson([...(right?.controlPlaneStaffIds??[])].sort());}
function ownerBound(snapshot,config){let rows;try{rows=JSON.parse(snapshot.snapshotJson).rows;}catch{return false;}const id=config.access.owner.staffId,s=config.access.owner.accessSubject;
  const user=rows.staff_users?.find(row=>row.id===id),admission=rows.native_staff_admissions?.find(row=>row.staff_id===id),profile=rows.native_staff_profiles?.find(row=>row.staff_id===id);
  return user?.status==='active'&&user.access_subject===s&&admission?.active===1&&admission.bound_access_subject===s
    &&profile?.staff_id===id&&Number.isSafeInteger(profile.version)&&profile.version>0&&snapshot.controlPlaneStaffIds.includes(id);}
async function promptConsent(expected){const rl=createInterface({input:stdin,output:stdout});try{
  const supplied=await rl.question(`Type exactly to issue this one-time cutover approval:\n${expected}\n> `);return supplied;
}finally{rl.close();}}
async function main(argv){
  assertPinnedNativeStaffCutoverDistribution();assertPinnedIssuerDistribution();
  const config=loadPinnedNativeStaffCutoverConfig();assertPinnedNativeStaffCutoverSource(config);
  if(argv[0]==='--revoke'){
    if(argv.length!==4||argv[2]!=='--state-sha256'||!/^[0-9a-f]{64}$/u.test(argv[3]??'')
      ||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(argv[1]??''))stop('usage');
    const approvalId=argv[1],receipt=readJson(path.join(config.receiptDirectory,`native-staff-cutover-owner-approval-${approvalId}.json`),2*1024*1024);
    const identity=verifyNativeStaffCutoverOwnerApprovalReceipt(receipt,{config});
    if(identity.approvalId!==approvalId)stop('receipt_mismatch');
    const before=readNativeStaffCutoverApprovalRegistry(config);
    if(before.stateSha256!==argv[3])stop('registry_changed_after_consent');
    const phrase=`REVOKE NATIVE STAFF CUTOVER ${approvalId} ${before.stateSha256}`;
    stdout.write(`Current cutover approval: ${canonicalJson({approvalId,commandId:identity.commandId,contextSha256:identity.contextSha256,
      registryStateSha256:before.stateSha256})}\n`);
    if(await promptConsent(phrase)!==phrase)stop('owner_consent_invalid');
    const session=await verifyCurrentNativeStaffCutoverOwnerSession(config,runPinnedCloudflaredToken(config));
    const after=readNativeStaffCutoverApprovalRegistry(config);
    if(session.staffId!==config.access.owner.staffId||after.stateSha256!==before.stateSha256)stop('registry_or_owner_changed_after_consent');
    revokeNativeStaffCutoverApproval(config,receipt,before.stateSha256);
    stdout.write(`${canonicalJson({approvalId,state:'revoked'})}\n`);return;
  }
  if(argv.length!==2||argv[0]!=='--candidate')stop('usage');
  const candidate=readJson(path.resolve(argv[1]));const compiled=compileNativeStaffCutoverApprovalContext(candidate,config);
  const provider=createApprovedExecutorD1Provider({config,getBearerToken:wranglerBearerToken});
  const target=await provider.assertTarget();if(target.databaseId!==config.target.databaseId||target.name!==config.target.databaseName)stop('target_mismatch');
  const before=await readNativeStaffCutoverSnapshot(provider);
  if(!sameSnapshot(before,candidate.reviewedSnapshot)||!ownerBound(before,config))stop('snapshot_or_owner_changed');
  let session=await verifyCurrentNativeStaffCutoverOwnerSession(config,runPinnedCloudflaredToken(config));
  if(session.staffId!==config.access.owner.staffId)stop('owner_session_mismatch');
  stdout.write(`Cutover review summary (hashes bind the complete context): ${canonicalJson({
    accountId:config.target.accountId,databaseId:config.target.databaseId,databaseName:config.target.databaseName,
    sourceCommit:config.source.commit,migrationNamesSha256:config.source.migrationNamesSha256,
    migrationContentsSha256:config.source.migrationContentsSha256,approvalId:candidate.approvalId,commandId:candidate.commandId,
    operatorStaffId:candidate.operator.staffId,snapshotSha256:candidate.reviewedSnapshot.snapshotSha256,
    approvalContextSha256:compiled.contextSha256,planSha256:compiled.context.planSha256,bindingSha256:compiled.context.bindingSha256,
    cohortSha256:compiled.context.cohortSha256,staffCount:compiled.compiled.cohort.length,
    controlPlaneStaffIds:compiled.context.controlPlaneStaffIds,
    currentGroupCount:candidate.syncPreparationReceipt.currentGroupCount,
    currentGroupSha256:candidate.syncPreparationReceipt.currentGroupSha256,
    desiredGroupCount:candidate.syncPreparationReceipt.desiredGroupCount,
    desiredGroupSha256:candidate.syncPreparationReceipt.desiredGroupSha256})}\n`);
  const typed=await promptConsent(compiled.consentText);
  session=await verifyCurrentNativeStaffCutoverOwnerSession(config,runPinnedCloudflaredToken(config));
  const after=await readNativeStaffCutoverSnapshot(provider);
  if(session.staffId!==config.access.owner.staffId||!sameSnapshot(before,after)||!sameSnapshot(after,candidate.reviewedSnapshot)||!ownerBound(after,config))
    stop('owner_or_snapshot_changed_after_consent');
  const receipt=buildNativeStaffCutoverOwnerApprovalReceipt({config,artifact:candidate,ownerSession:session,typedConsent:typed});
  const receiptPath=writeNativeStaffCutoverReceiptFile(config,receipt);const registration=issueNativeStaffCutoverApproval(config,receipt);
  stdout.write(`${canonicalJson({approvalId:registration.approvalId,commandId:registration.commandId,
    receiptSha256:registration.receiptSha256,registryStateSha256:registration.stateSha256,receiptPath})}\n`);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{
  const code=error instanceof Error&&/^native_staff_cutover_(?:issuer|owner|executor|config|distribution)_[a-z0-9_]+$/u.test(error.message)
    ?error.message:'native_staff_cutover_issuer_unavailable';process.stderr.write(`${code}\n`);process.exitCode=1;
});
