'use strict';

// Conservative comparison of indexed logical paths under the same configured
// root. This is not mount, alias, case-sensitivity, inode or writer attestation.
// Unknown same-root path syntax is held rather than treated as disjoint.
function indexedScopeMayOverlap(a,b){
 if(!a||!b||typeof a.rootKey!=='string'||typeof b.rootKey!=='string'||!a.rootKey||!b.rootKey) return true;
 if(a.rootKey!==b.rootKey)return false;
 const parts=x=>typeof x==='string'&&x.length>0&&x.length<=1024&&x.split('/').every(c=>/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(c)&&c!=='.'&&c!=='..')?x.toLowerCase().split('/'):null;
 const aa=parts(a.relativePath),bb=parts(b.relativePath);if(!aa||!bb)return true;
 return aa.slice(0,Math.min(aa.length,bb.length)).every((part,index)=>part===bb[index]);
}
module.exports={indexedScopeMayOverlap};
