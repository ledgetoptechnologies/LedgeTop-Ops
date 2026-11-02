'use strict';

// Unmounted synthetic SQLite experiment only. No route, worker integration,
// production migration, authentication, receipt verification, fence or retry.
// Caller must supply a trusted dedicated fixture DB; scope is not a DB guard.
const {createHash}=require('node:crypto');
const {canonicalBytes}=require('./referenceProtocol');
const {FIXTURE_SCOPE}=require('./referenceV2FixtureLedger');
const DOMAIN=Buffer.from('ltds-viewer-batch-intent-fixture-v1\0','ascii');
const fail=code=>{const error=new Error(code);error.code=code;throw error};
const closed=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const decimal=v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v);
const fields=['attemptId','batchId','initializationSha256','manifestSha256','providerId','providerTaskId','reservationSha256','entries'];
const entryFields=['wireNameUtf8Base64url','role','sizeBytes','sha256'];
function entries(value,{sort=false}={}){
  if(!Array.isArray(value)||!value.length||value.length>1000)fail('invalid_fixture_entries');
  const names=new Set();
  for(const item of value){
    if(!closed(item,entryFields)||!['photo','gcp','auxiliary'].includes(item.role)||!decimal(item.sizeBytes)||!hash(item.sha256)||typeof item.wireNameUtf8Base64url!=='string')fail('invalid_fixture_entries');
    const raw=Buffer.from(item.wireNameUtf8Base64url,'base64url');
    // This deliberately narrow fixture supports ASCII basenames only; real
    // receiver name equivalence and Unicode mapping remain unspecified.
    const name=raw.toString('ascii');
    if(!raw.length||raw.length>255||raw.toString('base64url')!==item.wireNameUtf8Base64url||!raw.equals(Buffer.from(name,'ascii'))||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)||names.has(name.toLowerCase()))fail('invalid_fixture_entries');
    names.add(name.toLowerCase());
  }
  return sort?[...value].sort((a,b)=>Buffer.compare(Buffer.from(a.wireNameUtf8Base64url,'base64url'),Buffer.from(b.wireNameUtf8Base64url,'base64url'))):[...value];
}
function canonicalIntent(value){
  if(!closed(value,fields)||![value.attemptId,value.batchId,value.providerId,value.providerTaskId].every(uuid)||![value.initializationSha256,value.manifestSha256,value.reservationSha256].every(hash))fail('invalid_fixture_intent');
  return canonicalBytes({...value,entries:entries(value.entries)});
}
function createBatchIntentFixture(db,scope){
  if(scope!==FIXTURE_SCOPE)fail('fixture_scope_required');
  db.exec(`CREATE TABLE IF NOT EXISTS reference_batch_fixture_intents(batch_id TEXT PRIMARY KEY, intent BLOB NOT NULL, intent_sha256 TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reference_batch_fixture_observations(observation_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, observation BLOB NOT NULL, FOREIGN KEY(batch_id) REFERENCES reference_batch_fixture_intents(batch_id));`);
  const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result}catch(error){db.exec('ROLLBACK');throw error}};
  function persist(intent){
    const bytes=canonicalIntent(intent),digest=createHash('sha256').update(DOMAIN).update(bytes).digest('hex');
    return transaction(()=>{const prior=db.prepare('SELECT intent,intent_sha256 FROM reference_batch_fixture_intents WHERE batch_id=?').get(intent.batchId);
      if(prior){if(prior.intent_sha256!==digest||!Buffer.from(prior.intent).equals(bytes))fail('batch_conflict');return {digest,replayed:true};}
      db.prepare('INSERT INTO reference_batch_fixture_intents VALUES(?,?,?)').run(intent.batchId,bytes,digest);return {digest,replayed:false};});
  }
  function observe(value){
    if(!closed(value,['observationId','batchId','intentSha256','complete','entries'])||!uuid(value.observationId)||!uuid(value.batchId)||!hash(value.intentSha256)||typeof value.complete!=='boolean')fail('invalid_fixture_observation');
    // Empty accepted inventory is permitted, but not an empty expected batch.
    if(!Array.isArray(value.entries))fail('invalid_fixture_entries');
    const accepted=value.entries.length?entries(value.entries,{sort:true}):[];
    const normalized={...value,entries:accepted},bytes=canonicalBytes(normalized);
    return transaction(()=>{const row=db.prepare('SELECT intent,intent_sha256 FROM reference_batch_fixture_intents WHERE batch_id=?').get(value.batchId);
      if(!row||row.intent_sha256!==value.intentSha256)fail('intent_mismatch');
      const prior=db.prepare('SELECT batch_id,observation FROM reference_batch_fixture_observations WHERE observation_id=?').get(value.observationId);
      if(prior&&(prior.batch_id!==value.batchId||!Buffer.from(prior.observation).equals(bytes)))fail('observation_conflict');
      if(!prior)db.prepare('INSERT INTO reference_batch_fixture_observations VALUES(?,?,?)').run(value.observationId,value.batchId,bytes);
      const expected=JSON.parse(Buffer.from(row.intent).toString()).entries, map=new Map(expected.map(x=>[x.wireNameUtf8Base64url,canonicalBytes(x).toString()]));
      const mismatch=accepted.some(x=>map.get(x.wireNameUtf8Base64url)!==canonicalBytes(x).toString());
      const comparison=mismatch?'conflict':!value.complete?'unknown':accepted.length===expected.length?'exact':'subset';
      return {comparison,action:'hold',replayed:Boolean(prior)};
    });
  }
  return {persist,observe};
}
module.exports={createBatchIntentFixture,canonicalIntent};
