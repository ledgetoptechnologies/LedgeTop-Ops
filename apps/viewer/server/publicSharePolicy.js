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
module.exports={VIEW_KINDS,revisionMatches,assetAllowed};
