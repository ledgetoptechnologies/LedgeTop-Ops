// Summarize server-reported eligible Viewer asset kinds. This does not inspect the
// source archive or establish whether a source point cloud exists elsewhere.
const VIEW_KINDS={model:['glb','tiles'],pointCloud:['ept'],ortho:['ortho'],dsm:['dsm'],dtm:['dtm']};
const LABELS={model:'3D model',pointCloud:'Point cloud',ortho:'Orthophoto',dsm:'DSM',dtm:'DTM'};
const KNOWN_KINDS=new Set([...Object.values(VIEW_KINDS).flat(),'shots','orthoCutline']);
export function verifiedPublicationViews(kinds){
  if(!Array.isArray(kinds)||!kinds.every(kind=>typeof kind==='string'))return null;
  const available=new Set(kinds);
  return Object.keys(VIEW_KINDS).filter(view=>VIEW_KINDS[view].some(kind=>available.has(kind)));
}
export function publicationViewNotice(kinds){
  const views=verifiedPublicationViews(kinds);
  if(!views?.length||views.includes('pointCloud'))return '';
  return 'The point-cloud view is not among the currently eligible views. A point-cloud source may still exist.';
}
export function publicationConfirmation(kinds){
  const views=verifiedPublicationViews(kinds);
  if(!views?.length||kinds.some(kind=>!KNOWN_KINDS.has(kind)))return null;
  const assets=views.map(view=>LABELS[view]);
  if(kinds.includes('shots'))assets.push('Camera positions');
  if(kinds.includes('orthoCutline'))assets.push('Orthophoto boundary');
  const notice=publicationViewNotice(kinds);
  return `Publish these eligible assets: ${assets.join(', ')}?${notice?`\n\n${notice}`:''}`;
}
