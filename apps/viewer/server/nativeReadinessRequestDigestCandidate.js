'use strict';
// Shared serialization and domain for the inactive readiness experiments.
const crypto=require('node:crypto');
function canonical(value){
  if(value===null||typeof value==='string'||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value)))return JSON.stringify(value);
  if(Array.isArray(value)){for(let i=0;i<value.length;i++)if(!Object.hasOwn(value,i))throw new Error('invalid readiness value');return '['+value.map(canonical).join(',')+']';}
  if(typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype)throw new Error('invalid readiness value');
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
}
function digest(request){return crypto.createHash('sha256').update('viewer-readiness-request-v1\0').update(canonical(request)).digest('hex');}
module.exports={digest};
