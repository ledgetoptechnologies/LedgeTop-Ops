'use strict';
// Options fingerprints are opaque server-owned IDs. They are not recomputed
// from parsed JSON; JSON numbers do not retain Python float lexical identity.
const p=require('./referenceProtocol');
function validateReferenceOptions(catalog,capabilities){
 const fields=['schemaVersion','environment','capabilityFingerprint','optionsFingerprint','options'];
 if(!catalog||Object.getPrototypeOf(catalog)!==Object.prototype||Object.keys(catalog).length!==fields.length||fields.some(k=>!Object.hasOwn(catalog,k))||catalog.schemaVersion!==1||catalog.environment!==capabilities.environment||catalog.capabilityFingerprint!==capabilities.capabilityFingerprint||catalog.optionsFingerprint!==capabilities.engines.odm.optionsFingerprint||!Array.isArray(catalog.options)||catalog.options.length>p.LIMITS.objects)throw Error('invalid reference options');
 function finite(v,depth=0){if(depth>32)throw Error('invalid reference options');if(typeof v==='number'&&(!Number.isFinite(v)||Math.abs(v)>Number.MAX_SAFE_INTEGER))throw Error('invalid reference options');if(Array.isArray(v)){if(v.length>p.LIMITS.objects)throw Error('invalid reference options');for(const x of v)finite(x,depth+1)}else if(v&&typeof v==='object'){if(Object.getPrototypeOf(v)!==Object.prototype)throw Error('invalid reference options');for(const x of Object.values(v))finite(x,depth+1)}}
 finite(catalog.options);const names=new Set();for(const x of catalog.options){if(!x||Object.getPrototypeOf(x)!==Object.prototype||typeof x.name!=='string'||!/^[a-z][a-z0-9-]{0,79}$/.test(x.name)||!['bool','boolean','int','integer','float','double','number'].includes(x.type)||names.has(x.name))throw Error('invalid reference options');names.add(x.name)}
 return names;
}
// Strict JSON decoder: reject duplicate keys (including escaped aliases), bad
// UTF-8, nonfinite/out-of-safe-range numbers, deep nesting and large arrays.
function decodeOptionsWire(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length>p.LIMITS.metadataBytes||(bytes.length>=3&&bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf))throw Error('invalid options JSON');
 let source;try{source=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{throw Error('invalid options JSON')}
 let index=0;const token=/[\x20\t\r\n]*("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:])/y;
 const fail=()=>{throw Error('invalid options JSON')};const validText=s=>!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s);function next(){token.lastIndex=index;const m=token.exec(source);if(!m)fail();index=token.lastIndex;return m[1]}
 function value(t,depth){if(depth>32)fail();if(t==='{'){const out={},seen=new Set();let k=next();if(k==='}')return out;while(true){if(k[0]!=='"')fail();k=JSON.parse(k);if(!validText(k)||seen.has(k))fail();seen.add(k);if(next()!==':')fail();Object.defineProperty(out,k,{value:value(next(),depth+1),enumerable:true,writable:true,configurable:true});const sep=next();if(sep==='}')return out;if(sep!==',')fail();k=next()}}
 if(t==='['){const out=[];let x=next();if(x===']')return out;while(true){if(out.length>=p.LIMITS.objects)fail();out.push(value(x,depth+1));const sep=next();if(sep===']')return out;if(sep!==',')fail();x=next()}}
 let parsed;try{parsed=JSON.parse(t)}catch{fail()}if(typeof parsed==='string'&&!validText(parsed))fail();if(typeof parsed==='number'&&(!Number.isFinite(parsed)||Math.abs(parsed)>Number.MAX_SAFE_INTEGER))fail();return parsed}
 const result=value(next(),0);if(!/^[\x20\t\r\n]*$/.test(source.slice(index)))fail();return result;
}
module.exports={validateReferenceOptions,decodeOptionsWire};
