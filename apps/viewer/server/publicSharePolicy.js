'use strict';
const VIEW_KINDS={model:['glb','tiles'],pointCloud:['ept','pointCloud'],ortho:['ortho'],dsm:['dsm'],dtm:['dtm']};
function revisionMatches(share,payload){return Number(payload?.shareRevision||0)===Number(share?.authorizationRevision||0);}
// The original model report has its own switch. A record from before it had one keeps what it allowed then: the
// report came with downloads. A field that is present must be exactly true; anything else refuses.
function reportAllowed(permissions){
  if(!permissions||typeof permissions!=='object')return false;
  return Object.hasOwn(permissions,'report')?permissions.report===true:permissions.download===true;
}
function assetAllowed(share,kind){
  if(share.permissions?.view===false)return false;
  if(kind==='shots')return share.permissions?.cameras!==false;
  if(kind==='report')return reportAllowed(share.permissions);
  const view=Object.keys(VIEW_KINDS).find(key=>VIEW_KINDS[key].includes(kind));
  return view ? (!share.allowedViews||share.allowedViews.includes(view)) : !share.allowedViews;
}
// A new link stores every permission, so nothing is decided by what a request left out: camera positions and
// downloads are on only when chosen. Marks staff shared on the model show on a
// staff link unless turned off, and on a client's link only when chosen. Reading an older link keeps its meaning (assetAllowed above).
function newSharePermissions(value,shareClass='staff'){
  const input=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  return {view:input.view!==false,measure:input.measure!==false,cameras:input.cameras===true,download:input.download===true,report:input.report===true,marks:shareClass==='staff'?input.marks!==false:input.marks===true};
}
// What a stored link allows, whatever its record leaves out. A link from before marks could be shown does not show them.
function effectiveSharePermissions(value){
  const input=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  return {view:input.view!==false,measure:input.measure!==false,cameras:input.cameras!==false,download:input.download===true,report:reportAllowed(input),marks:input.marks===true};
}
const NEW_SHARE_DAYS=30;
// Left out: 30 days. No end is an explicit null. Anything else must be a future instant; undefined means refuse.
function newShareExpiry(value,now=Date.now()){
  if(value===undefined)return new Date(now+NEW_SHARE_DAYS*24*60*60*1000).toISOString();
  if(value===null)return null;
  const at=typeof value==='string'?Date.parse(value):NaN;
  return Number.isFinite(at)&&at>now?new Date(at).toISOString():undefined;
}
module.exports={VIEW_KINDS,NEW_SHARE_DAYS,revisionMatches,reportAllowed,assetAllowed,newSharePermissions,effectiveSharePermissions,newShareExpiry};
