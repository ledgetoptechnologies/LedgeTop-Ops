import {isDeepStrictEqual as same} from "node:util";
import {compileProjectBusinessAreaAuthorityV184} from "./staging-project-business-area-authority-v184.mjs";
import {STAGING_TARGET} from "./staging-onboarding-native-only-authority-packet.mjs";
import {withStagingAuthorityBinding} from "./staging-native-authority-binding-runner.mjs";

const fail=message=>{throw Error(`project-authority-v184-apply: ${message}`)};
const timestamp=value=>typeof value==="string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value;
const withoutClock=row=>Object.fromEntries(Object.entries(row).filter(([key])=>key!=="executed_at"));

function reviewed(packet,phase,options){
  if(!same(options?.target,STAGING_TARGET))fail("trusted staging binding context required");
  if(!["provision","revoke"].includes(phase))fail("phase required");
  const expected=compileProjectBusinessAreaAuthorityV184(packet?.input,options?.root?{root:options.root}:{});
  if(!same(packet,expected))fail("compiled artifact altered");
  const sealed=Object.hasOwn(expected.input,"provisionReadback");
  if((phase==="provision"&&sealed)||(phase==="revoke"&&!sealed)||!expected[phase])fail("artifact is not sealed for this phase");
  return expected;
}

async function snapshot(db,packet){
  const i=packet.input,a=i.approval;
  // One D1 batch gives reconciliation a coherent read transaction. No statement
  // here writes state or opens authority; a missing receipt is never success.
  const results=await db.batch([
    db.prepare("SELECT * FROM native_staff_bootstrap_approvals WHERE approval_id IN (?,?) ORDER BY approval_id").bind(a.provisionApprovalId,a.revokeApprovalId),
    db.prepare("SELECT * FROM native_staff_bootstrap_receipts WHERE command_id IN (?,?) ORDER BY command_id").bind(a.provisionCommandId,a.revokeCommandId),
    db.prepare("SELECT * FROM native_project_grants WHERE staff_id=? ORDER BY id").bind(i.target.staffId),
    db.prepare("SELECT staff_id,generation FROM native_project_grant_generations WHERE staff_id=?").bind(i.target.staffId),
  ]);
  if(!Array.isArray(results)||results.length!==4||results.some(r=>r?.success!==true||!Array.isArray(r.results)))fail("invalid reconciliation query result");
  return {approvals:results[0].results,receipts:results[1].results,grants:results[2].results,generations:results[3].results};
}

function receiptMatches(actual,expected){
  return actual && timestamp(actual.executed_at) && same(withoutClock(actual),withoutClock(expected));
}

function settledState(packet,phase,state){
  const i=packet.input,a=i.approval,selected=packet[phase];
  const receipt=state.receipts.find(r=>r.command_id===selected.receipt.command_id);
  if(!receipt)return null;
  if(!receiptMatches(receipt,selected.receipt))fail("persisted receipt mismatch");
  const issued=Date.parse(a.issuedAt),expires=Date.parse(a.expiresAt);
  const provisionReceipt=state.receipts.find(r=>r.command_id===a.provisionCommandId);
  if(!receiptMatches(provisionReceipt,packet.provision.receipt)
    ||Date.parse(provisionReceipt.executed_at)<issued||Date.parse(provisionReceipt.executed_at)>=expires)fail("provision receipt chronology or identity mismatch");
  const provisionApproval=state.approvals.find(r=>r.approval_id===a.provisionApprovalId);
  const grant=state.grants.find(r=>r.id===a.grantId);
  if(!grant||!timestamp(grant.created_at)||Date.parse(grant.created_at)<issued
    ||Date.parse(grant.created_at)>Date.parse(provisionReceipt.executed_at))fail("grant creation chronology mismatch");
  const active=phase==="provision"?1:0,version=phase==="provision"?1:2;
  const expectedGrant={id:a.grantId,staff_id:i.target.staffId,capability:"project.shared.sync",effect:"allow",scope_kind:"business_area",
    business_area_id:i.target.businessAreaId,division_id:null,external_project_id:null,active,version,granted_by:i.target.staffId,created_at:grant.created_at};
  const expectedGrants=[...i.projectGrants,expectedGrant].sort((x,y)=>x.id.localeCompare(y.id));
  if(!same([...state.grants].sort((x,y)=>x.id.localeCompare(y.id)),expectedGrants)
    ||!same(state.generations,[{staff_id:i.target.staffId,generation:i.projectGeneration.generation+(phase==="provision"?1:2)}]))fail("grant or generation poststate mismatch");
  if(phase==="provision"){
    if(!same(provisionApproval,packet.provision.approval)||state.approvals.length!==1||state.receipts.length!==1)fail("provision approval poststate mismatch");
  }else{
    if(!timestamp(provisionApproval?.revoked_at)||Date.parse(provisionApproval.revoked_at)<Date.parse(provisionReceipt.executed_at)
      ||Date.parse(receipt.executed_at)<Date.parse(provisionApproval.revoked_at))fail("revoke chronology mismatch");
    if(!same(provisionApproval,{...packet.provision.approval,revoked_at:provisionApproval.revoked_at})
      ||!same(state.approvals.find(r=>r.approval_id===a.revokeApprovalId),packet.revoke.approval)
      ||state.approvals.length!==2||state.receipts.length!==2)fail("paired revoke approval poststate mismatch");
    if(!same(provisionReceipt,i.provisionReadback.receipt)||!same({...grant,active:1,version:1},i.provisionReadback.grant))fail("sealed provision readback mismatch");
  }
  return {phase,status:"settled",active:Boolean(active),generation:state.generations[0].generation};
}

/** Read-only reconciliation. Receipt absence means unproven, not safe to retry. */
export async function reconcileProjectBusinessAreaAuthorityV184(db,packet,phase,options={}){
  const expected=reviewed(packet,phase,options);
  return settledState(expected,phase,await snapshot(db,expected));
}

/** Module-only apply path; no CLI, HTTP route, ambient target or credential.
 * The caller must durably retain the reviewed artifact before invoking this.
 * A thrown batch error is potentially ambiguous: reconcile the same artifact;
 * do not issue a different grant or assume the write did not happen. */
export async function applyProjectBusinessAreaAuthorityV184(db,packet,phase,options={}){
  const expected=reviewed(packet,phase,options);
  const prior=settledState(expected,phase,await snapshot(db,expected));
  if(prior)return {...prior,replayed:true};
  const selected=expected[phase];
  const results=await db.batch(selected.statements.map(s=>db.prepare(s.sql).bind(...s.params)));
  if(!Array.isArray(results)||results.length!==selected.statements.length||results.some(r=>r?.success!==true))fail("ambiguous batch result; reconcile before retry");
  const settled=settledState(expected,phase,await snapshot(db,expected));
  if(!settled)fail("missing receipt after apply; reconcile before retry");
  return {...settled,replayed:false};
}

/** Production cannot be selected through this binding runner. */
export async function applyReviewedProjectBusinessAreaAuthorityV184(configPath,packet,phase,dependencies={}){
  return withStagingAuthorityBinding(configPath,({db,target})=>applyProjectBusinessAreaAuthorityV184(db,packet,phase,
    {target,...(dependencies.root?{root:dependencies.root}:{})}),dependencies);
}
