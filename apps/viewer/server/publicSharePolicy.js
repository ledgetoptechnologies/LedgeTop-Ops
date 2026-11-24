'use strict';
const VIEW_KINDS={model:['glb','tiles'],pointCloud:['ept','pointCloud'],ortho:['ortho'],dsm:['dsm'],dtm:['dtm']};
function revisionMatches(share,payload){return Number(payload?.shareRevision||0)===Number(share?.authorizationRevision||0);}
function assetAllowed(share,kind){
  if(share.permissions?.view===false)return false;
  if(kind==='shots')return share.permissions?.cameras!==false;
  if(kind==='report')return share.permissions?.download===true;
  const view=Object.keys(VIEW_KINDS).find(key=>VIEW_KINDS[key].includes(kind));
  return view ? (!share.allowedViews||share.allowedViews.includes(view)) : !share.allowedViews;
}
// A new link stores every permission, so nothing is decided by what a request left out: camera positions and
// downloads are on only when chosen. Reading an older link keeps its meaning (assetAllowed above).
function newSharePermissions(value){
  const input=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  return {view:input.view!==false,measure:input.measure!==false,cameras:input.cameras===true,download:input.download===true};
}
// What a stored link allows, whatever its record leaves out.
function effectiveSharePermissions(value){
  const input=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  return {view:input.view!==false,measure:input.measure!==false,cameras:input.cameras!==false,download:input.download===true};
}
const NEW_SHARE_DAYS=30;
// Left out: 30 days. No end is an explicit null. Anything else must be a future instant; undefined means refuse.
function newShareExpiry(value,now=Date.now()){
  if(value===undefined)return new Date(now+NEW_SHARE_DAYS*24*60*60*1000).toISOString();
  if(value===null)return null;
  const at=typeof value==='string'?Date.parse(value):NaN;
  return Number.isFinite(at)&&at>now?new Date(at).toISOString():undefined;
}
module.exports={VIEW_KINDS,NEW_SHARE_DAYS,revisionMatches,assetAllowed,newSharePermissions,effectiveSharePermissions,newShareExpiry};
