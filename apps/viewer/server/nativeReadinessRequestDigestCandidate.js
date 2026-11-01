'use strict';
// Shared serialization and domain for the inactive readiness experiments.
const crypto=require('node:crypto');
function canonical(value){
  if(value===null||typeof value==='string'||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value)))return JSON.stringify(value);
  if(typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype)throw new Error('invalid readiness value');
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
}
function digest(request){return crypto.createHash('sha256').update('viewer-readiness-request-v1\0').update(canonical(request)).digest('hex');}
module.exports={digest};
