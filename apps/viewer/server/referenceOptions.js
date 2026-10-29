'use strict';
// Strict, fail-closed subset: the existing cross-language v1 canonicalizer
// accepts integers only. A catalog containing floats is unsupported until a
// lossless, jointly specified canonical representation is available.
const p=require('./referenceProtocol');
function validateReferenceOptions(catalog,capabilities){
 const fields=['schemaVersion','environment','capabilityFingerprint','optionsFingerprint','options'];
 if(!catalog||Object.getPrototypeOf(catalog)!==Object.prototype||Object.keys(catalog).length!==fields.length||fields.some(k=>!Object.hasOwn(catalog,k))||catalog.schemaVersion!==1||catalog.environment!==capabilities.environment||catalog.capabilityFingerprint!==capabilities.capabilityFingerprint||catalog.optionsFingerprint!==capabilities.engines.odm.optionsFingerprint||!Array.isArray(catalog.options)||catalog.options.length>p.LIMITS.objects)throw Error('invalid reference options');
 const names=new Set();for(const x of catalog.options){if(!x||Object.getPrototypeOf(x)!==Object.prototype||typeof x.name!=='string'||!/^[a-z][a-z0-9-]{0,79}$/.test(x.name)||!['bool','boolean','int','integer','float','double','number'].includes(x.type)||names.has(x.name))throw Error('invalid reference options');names.add(x.name)}
 const definitions=[...catalog.options].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
 if(p.sha256(p.canonicalBytes({protocol:'reference-options-v1',definitions}))!==catalog.optionsFingerprint)throw Error('invalid reference options');
 return names;
}
module.exports={validateReferenceOptions};
