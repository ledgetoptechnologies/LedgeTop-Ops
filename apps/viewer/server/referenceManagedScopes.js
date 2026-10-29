'use strict';
// Mapping and comparison only. A configured map is NOT evidence that mounts,
// aliases, filesystem case rules or writers have been independently attested.
// This module is not wired to runtime admission or cleanup.
const ROOTS=new Set(['datasets','models','cache','trash','dataset_import','webodm','terra_import']);
const ident=x=>typeof x==='string'&&/^[a-z0-9][a-z0-9_-]{0,63}$/.test(x);
const fail=()=>{throw Object.assign(new Error('managed scope is unavailable or ambiguous'),{code:'managed_scope_unverified'});};
function components(value,{allowEmpty=false}={}){
 if(typeof value!=='string'||value.length>512)fail();if(value===''&&allowEmpty)return [];
 const parts=value.split('/');if(parts.length>32||!parts.every(c=>/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(c)&&c!=='.'&&c!=='..'))fail();return parts;
}
function createManagedScopeMap(configuration){
 if(!configuration||typeof configuration!=='object'||Array.isArray(configuration)||configuration.caseMode!=='sensitive'||!ident(configuration.revision)||!configuration.roots||typeof configuration.roots!=='object'||Array.isArray(configuration.roots))fail();
 const entries=Object.entries(configuration.roots);if(!entries.length||entries.length>ROOTS.size)fail();const roots=new Map();
 for(const [key,value] of entries){if(!ROOTS.has(key)||!value||typeof value!=='object'||Array.isArray(value)||!ident(value.domain))fail();const prefix=components(value.prefix,{allowEmpty:true});roots.set(key,{domain:value.domain,prefix});}
 const revision=configuration.revision;const make=(rootKey,tail)=>{const root=roots.get(rootKey);if(!root)fail();const combined=[...root.prefix,...tail];if(combined.length>32||combined.join('/').length>512)fail();return Object.freeze({domain:root.domain,revision,components:Object.freeze(combined)});};return Object.freeze({scope(rootKey,relativePath){return make(rootKey,components(relativePath));},scopeRoot(rootKey){return make(rootKey,[]);}});
}
function scopesOverlap(a,b){
 if(!a||!b||!ident(a.domain)||!ident(b.domain)||!ident(a.revision)||!ident(b.revision)||!Array.isArray(a.components)||!Array.isArray(b.components)||!a.components.every(x=>typeof x==='string')||!b.components.every(x=>typeof x==='string'))fail();
 const aa=components(a.components.join('/'),{allowEmpty:true}),bb=components(b.components.join('/'),{allowEmpty:true});if(aa.length!==a.components.length||bb.length!==b.components.length||a.revision!==b.revision)fail();if(a.domain!==b.domain)return false;return aa.slice(0,Math.min(aa.length,bb.length)).every((part,index)=>part===bb[index]);
}
module.exports={createManagedScopeMap,scopesOverlap};
