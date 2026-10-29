'use strict';
// Offline preparation only. No authenticated issuer, purge fence, or evidence
// attestor exists here. Prepared records are NOT source-retention receipts.
const crypto=require('node:crypto');
const fail=()=>Object.assign(new Error('invalid dormant custody preparation'),{code:'custody_invalid'});
const slug=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const keys=(o,n)=>o&&Object.getPrototypeOf(o)===Object.prototype&&Object.keys(o).sort().join('|')===[...n].sort().join('|');
function prepare(db,input){
 if(!keys(input,['id','jobId','generation','environment','pipelineDigest','manifestSha256','holderInventory','objects'])||!slug(input.id)||!slug(input.jobId)||!Number.isSafeInteger(input.generation)||input.generation<1||!['staging','production'].includes(input.environment)||!digest(input.pipelineDigest)||!digest(input.manifestSha256)||!keys(input.holderInventory,['complete','profile','holders'])||input.holderInventory.complete!==true||input.holderInventory.profile!=='single-viewer-odm'||!Array.isArray(input.holderInventory.holders)||input.holderInventory.holders.length!==1||input.holderInventory.holders[0]!=='viewer-odm'||!Array.isArray(input.objects)||!input.objects.length||input.objects.length>20001)throw fail();
 const seen=new Set(),objects=input.objects.map(o=>{if(!keys(o,['id','byteSize','sha256','kind','isRawCsv'])||!slug(o.id)||seen.has(o.id)||!Number.isSafeInteger(o.byteSize)||o.byteSize<0||!digest(o.sha256)||!['image','lidar','survey'].includes(o.kind)||typeof o.isRawCsv!=='boolean'||(o.isRawCsv&&o.kind!=='survey'))throw fail();seen.add(o.id);return {id:o.id,byteSize:o.byteSize,sha256:o.sha256,kind:o.kind,isRawCsv:o.isRawCsv};}).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 const total=objects.reduce((sum,o)=>sum+BigInt(o.byteSize),0n);if(total>BigInt(Number.MAX_SAFE_INTEGER))throw fail();
 const binding={id:input.id,jobId:input.jobId,generation:input.generation,environment:input.environment,pipelineDigest:input.pipelineDigest,manifestSha256:input.manifestSha256,holderInventory:{complete:true,profile:'single-viewer-odm',holders:['viewer-odm']},objects};
 const canonical=JSON.stringify(binding),hash=crypto.createHash('sha256').update(canonical).digest('hex');
 db.exec('BEGIN IMMEDIATE');try{const existing=db.prepare('SELECT binding_sha256,canonical_binding FROM viewer_custody_intents WHERE id=?').get(input.id);if(existing){if(existing.binding_sha256!==hash||existing.canonical_binding!==canonical)throw Object.assign(new Error('custody identity conflict'),{code:'custody_conflict'});db.exec('COMMIT');return {id:input.id,bindingSha256:hash,replayed:true,state:'prepared'};}
 db.prepare("INSERT INTO viewer_custody_intents VALUES(?,?,?,?,?,?,'building',?)").run(input.id,input.jobId,input.generation,input.environment,hash,canonical,new Date().toISOString());const insert=db.prepare('INSERT INTO viewer_custody_pins VALUES(?,?,?,?,?,?)');for(const o of objects)insert.run(input.id,o.id,o.byteSize,o.sha256,o.kind,o.isRawCsv?1:0);db.prepare("UPDATE viewer_custody_intents SET state='prepared' WHERE id=? AND state='building'").run(input.id);db.exec('COMMIT');return {id:input.id,bindingSha256:hash,replayed:false,state:'prepared'};}catch(e){try{db.exec('ROLLBACK')}catch{}throw e;}
}
// Intentionally impossible until real authentication, purge fencing, verified
// source custody, old-writer exclusion and an authoritative holder registry exist.
function issue(){throw Object.assign(new Error('custody issuance unavailable'),{code:'custody_unavailable'});}
module.exports={prepare,issue};
