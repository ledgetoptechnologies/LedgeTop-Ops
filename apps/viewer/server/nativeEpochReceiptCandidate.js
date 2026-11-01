'use strict';
// Test-only draft: no HTTP route, coordinator credentials, or production integration.
const hold=()=>Object.assign(new Error('native epoch receipt requires review'),{code:'native_epoch_hold'});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash=/^[0-9a-f]{64}$/;
const common=['operationId','operationKind','taskUuid','environment','generation','epoch','manifestId','manifestSha256'];
const history=['manifestReceipt','planIntentPresent','planIntentSha256','planReceipt'];
function exact(value,keys){return !!value&&typeof value==='object'&&!Array.isArray(value)&&JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort());}
function validate(envelope,expected,{checkManifest,checkPlan}={}){
  try{
    if(!exact(envelope,['protocol','version','taskUuid','operationId','environment','generation','epoch','result'])||envelope.protocol!=='native-plan-epoch-v2-experiment'||envelope.version!==2)throw hold();
    const r=envelope.result;
    if(!expected||!uuid.test(expected.operationId)||!uuid.test(expected.taskUuid)||!['staging','production'].includes(expected.environment)||typeof expected.manifestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(expected.manifestId)||!hash.test(expected.manifestSha256))throw hold();
    for(const key of ['operationId','taskUuid','environment'])if(envelope[key]!==expected[key])throw hold();
    if(envelope.generation!==1||envelope.epoch!==1)throw hold();
    for(const key of ['operationId','taskUuid','environment','manifestId','manifestSha256'])if(r?.[key]!==expected[key])throw hold();
    if(r.operationKind!=='plan_bind'||r.generation!==1||r.epoch!==1)throw hold();
    if(r.state==='open'){if(!exact(r,[...common,'state']))throw hold();return r;}
    if(r.state==='intent'){if(!exact(r,[...common,'state','planSha256'])||!hash.test(r.planSha256)||r.planSha256!==expected.planSha256)throw hold();return r;}
    const closed=['closed_without_bind','bound_then_closed'].includes(r.state);
    if(!closed&&!['open_unbound','open_bound'].includes(r.state))throw hold();
    if(!exact(r,[...common,'state',...history,...(closed?['requestId']:[])]))throw hold();
    if(closed&&(!uuid.test(expected.requestId)||r.requestId!==expected.requestId))throw hold();
    if(typeof r.planIntentPresent!=='boolean'||(r.planIntentPresent?!hash.test(r.planIntentSha256):r.planIntentSha256!==null))throw hold();
    if(r.planIntentPresent&&r.planIntentSha256!==expected.planSha256)throw hold();
    if(r.manifestReceipt===null){if(r.planIntentPresent||r.planReceipt!==null)throw hold();}
    else if(typeof checkManifest!=='function'||checkManifest(r.manifestReceipt)!==true)throw hold();
    if(r.planReceipt!==null){if(!r.planIntentPresent||typeof checkPlan!=='function'||checkPlan(r.planReceipt,r.manifestReceipt,r.planIntentSha256)!==true)throw hold();}
    if((r.state==='open_bound'||r.state==='bound_then_closed')!==(r.planReceipt!==null))throw hold();
    return r;
  }catch{throw hold();}
}
module.exports={validate};
