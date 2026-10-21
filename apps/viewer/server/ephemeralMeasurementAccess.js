'use strict';
const auth=require('./auth');
const {revisionMatches}=require('./publicSharePolicy');
const {ProcessingRepository}=require('./processingRepository');
const {sourceAuthorizationValidator}=require('./sourceAuthorization');
const fail=()=>{throw Object.assign(new Error('temporary_measurement_access_unavailable'),{code:'temporary_measurement_access_unavailable',status:403});};
function localAccess(authority,repository,at=Date.now()){
  if(!authority||!Number.isFinite(authority.expiresAt)||authority.expiresAt<=at)return null;
  let model,permissions,share=null,review=false;
  if(authority.kind==='viewer'){
    const session=repository.getViewerSessionByHash(authority.viewerHash);
    if(!repository.viewerSessionLive(session)||session.id!==authority.sessionId)return null;
    review=session.sessionMode==='review';
    model=session.sessionMode==='review'?repository.getModelVersion(session.modelId,session.modelVersionId):repository.getModel(session.modelId);
    if(session.modelId!==authority.modelId||session.modelVersionId!==authority.modelVersionId)return null;
    permissions=session.permissions;
  }else if(authority.kind==='share-asset'){
    share=repository.getPublicShare(authority.shareId);model=repository.getModel(authority.modelId);
    if(!repository.publicShareLive(share)||!revisionMatches(share,authority)||share.modelId!==authority.modelId||(share.versionPolicy==='pinned'&&share.modelVersionId!==authority.modelVersionId))return null;
    permissions=share.permissions;
  }else if(authority.kind==='project-share-asset'){
    share=repository.getProjectShare(authority.shareId);
    if(!repository.projectShareLive(share)||share.projectId!==authority.projectId)return null;
    const selected=new ProcessingRepository(repository.database).getActivePublishedProjectTask(share.projectId,authority.taskId);
    if(selected?.modelId!==authority.modelId||selected?.modelVersionId!==authority.modelVersionId)return null;
    model=repository.getModel(authority.modelId);permissions=share.permissions;
  }else return null;
  if(!model?.activeVersion||model.activeVersion.id!==authority.modelVersionId||model.activeVersion.status!=='ready'||(!review&&model.status!=='ready')||permissions?.view!==true||permissions?.measure!==true)return null;
  return{model,share,authority};
}
async function resolveEphemeralAccess(token,repository,{validator=sourceAuthorizationValidator}={}){
  if(typeof token!=='string'||token.length>4096||!/^[A-Za-z0-9_.-]{16,4096}$/.test(token))return fail();
  let authority;
  if(!token.includes('.')){
    const session=repository.getViewerSessionByHash(auth.hashToken(token));if(!repository.viewerSessionLive(session))return fail();
    authority={kind:'viewer',viewerHash:session.tokenHash,sessionId:session.id,modelId:session.modelId,modelVersionId:session.modelVersionId,expiresAt:Date.parse(session.expiresAt)};
  }else{
    if(token.split('.').length!==2)return fail();const payload=auth.verify(token);
    if(!payload||!['share-asset','project-share-asset'].includes(payload.kind)||typeof payload.modelId!=='string')return fail();
    const model=repository.getModel(payload.modelId);if(!model?.activeVersion)return fail();
    authority={kind:payload.kind,shareId:payload.shareId,shareRevision:payload.shareRevision||0,modelId:payload.modelId,modelVersionId:payload.kind==='project-share-asset'?payload.modelVersionId:model.activeVersion.id,expiresAt:payload.exp,...(payload.kind==='project-share-asset'?{projectId:payload.projectId,taskId:payload.taskId}:{})};
  }
  const access=localAccess(authority,repository);if(!access||(access.share&&!await validator.allows(access.share)))return fail();
  // Recheck local grant/version after the possibly awaited source authorization.
  if(!localAccess(authority,repository))return fail();
  const {expiresAt,...identity}=authority;
  return{...access,scopeKey:auth.hashToken(JSON.stringify(identity)),expiresAt:Math.min(expiresAt,Date.now()+15*60_000)};
}
module.exports={resolveEphemeralAccess,localAccess};
