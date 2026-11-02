'use strict';
// Synthetic SQLite model only: no NAS, authentication, file access, fencing,
// transfer, receipt issuer, real ACK or cleanup authority. Not a wire contract.
const p=require('../../server/referenceProtocol');
const SCOPE='isolated-nas-seam-fixture';
const fail=code=>{const error=Error(code);error.code=code;throw error};
const closed=(x,keys)=>x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(x);
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const size=x=>Number.isSafeInteger(x)&&x>0;
const canonical=x=>p.canonicalBytes(x).toString('utf8');
function createNasSeamFixture(db,scope){
 if(scope!==SCOPE)fail('fixture_scope_required');
 db.exec(`CREATE TABLE IF NOT EXISTS nas_seam_fixture_sources(id TEXT PRIMARY KEY,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS nas_seam_fixture_reservations(id TEXT PRIMARY KEY,body TEXT NOT NULL,charged INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS nas_seam_fixture_deliveries(id TEXT PRIMARY KEY,reservation_id TEXT NOT NULL,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS nas_seam_fixture_acceptances(id TEXT PRIMARY KEY,ack_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL,acked INTEGER NOT NULL DEFAULT 0);`);
 const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const out=fn();db.exec('COMMIT');return out}catch(error){db.exec('ROLLBACK');throw error}};
 function put(table,key,body){const previous=db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(key);if(previous){if(previous.body!==body)fail('fixture_identity_conflict');return true}db.prepare(`INSERT INTO ${table}(id,body) VALUES (?,?)`).run(key,body);return false}
 function source(v){if(!closed(v,['sourceId','sha256','byteSize','kind'])||!id(v.sourceId)||!hash(v.sha256)||!size(v.byteSize)||!['image','raw_csv'].includes(v.kind))fail('fixture_invalid');return tx(()=>({replayed:put('nas_seam_fixture_sources',v.sourceId,canonical(v)),action:'hold'}))}
 function reserve(v){
  if(!closed(v,['reservationId','attemptId','sourceIds','manifestSha256','byteBudget'])||!id(v.reservationId)||!id(v.attemptId)||!hash(v.manifestSha256)||!size(v.byteBudget)||!Array.isArray(v.sourceIds)||!v.sourceIds.length||v.sourceIds.length>1000||v.sourceIds.some(x=>!id(x))||new Set(v.sourceIds).size!==v.sourceIds.length)fail('fixture_invalid');
  return tx(()=>{const sources=v.sourceIds.map(x=>{const row=db.prepare('SELECT body FROM nas_seam_fixture_sources WHERE id=?').get(x);if(!row)fail('fixture_source_missing');return JSON.parse(row.body)});
   if(sources.some(x=>x.kind==='raw_csv')||p.sha256(p.canonicalBytes(sources))!==v.manifestSha256)fail('fixture_source_binding_mismatch');
   return{replayed:put('nas_seam_fixture_reservations',v.reservationId,canonical(v)),action:'hold'};});
 }
 function delivery(v){
  if(!closed(v,['deliveryId','reservationId','sourceId','sha256','byteSize'])||!id(v.deliveryId)||!id(v.reservationId)||!id(v.sourceId)||!hash(v.sha256)||!size(v.byteSize))fail('fixture_invalid');
  return tx(()=>{const row=db.prepare('SELECT body,charged FROM nas_seam_fixture_reservations WHERE id=?').get(v.reservationId);if(!row)fail('fixture_reservation_missing');const r=JSON.parse(row.body),sourceRow=db.prepare('SELECT body FROM nas_seam_fixture_sources WHERE id=?').get(v.sourceId),s=sourceRow&&JSON.parse(sourceRow.body);
   if(!s||!r.sourceIds.includes(v.sourceId)||s.sha256!==v.sha256||s.byteSize!==v.byteSize)fail('fixture_source_binding_mismatch');
   const body=canonical(v),old=db.prepare('SELECT reservation_id,body FROM nas_seam_fixture_deliveries WHERE id=?').get(v.deliveryId);if(old){if(old.reservation_id!==v.reservationId||old.body!==body)fail('fixture_identity_conflict');return{replayed:true,charged:row.charged,action:'hold'}}
   if(v.byteSize>r.byteBudget-row.charged)fail('fixture_budget_exhausted');db.prepare('INSERT INTO nas_seam_fixture_deliveries VALUES(?,?,?)').run(v.deliveryId,v.reservationId,body);db.prepare('UPDATE nas_seam_fixture_reservations SET charged=charged+? WHERE id=?').run(v.byteSize,v.reservationId);return{replayed:false,charged:row.charged+v.byteSize,action:'hold'};});
 }
 function accept(v){
  if(!closed(v,['receiptId','ackOperationId','reservationId','resultId','sha256','byteSize'])||![v.receiptId,v.ackOperationId,v.reservationId,v.resultId].every(id)||!hash(v.sha256)||!size(v.byteSize))fail('fixture_invalid');
  return tx(()=>{if(!db.prepare('SELECT 1 FROM nas_seam_fixture_reservations WHERE id=?').get(v.reservationId))fail('fixture_reservation_missing');const body=canonical(v),old=db.prepare('SELECT id,ack_id,body FROM nas_seam_fixture_acceptances WHERE id=? OR ack_id=?').all(v.receiptId,v.ackOperationId);
   if(old.length){if(old.length!==1||old[0].id!==v.receiptId||old[0].ack_id!==v.ackOperationId||old[0].body!==body)fail('fixture_identity_conflict');return{replayed:true,receiptSha256:p.sha256(Buffer.from(body)),action:'hold'}}
   db.prepare('INSERT INTO nas_seam_fixture_acceptances(id,ack_id,body) VALUES (?,?,?)').run(v.receiptId,v.ackOperationId,body);return{replayed:false,receiptSha256:p.sha256(Buffer.from(body)),action:'hold'};});
 }
 function ack(v){
  if(!closed(v,['receiptId','ackOperationId','receiptSha256'])||!id(v.receiptId)||!id(v.ackOperationId)||!hash(v.receiptSha256))fail('fixture_invalid');
  return tx(()=>{const row=db.prepare('SELECT body,acked FROM nas_seam_fixture_acceptances WHERE id=?').get(v.receiptId);if(!row)fail('fixture_receipt_missing');const a=JSON.parse(row.body);if(a.ackOperationId!==v.ackOperationId||p.sha256(Buffer.from(row.body))!==v.receiptSha256)fail('fixture_ack_mismatch');db.prepare('UPDATE nas_seam_fixture_acceptances SET acked=1 WHERE id=?').run(v.receiptId);return{replayed:Boolean(row.acked),action:'hold'};});
 }
 // Even a synthetic matched ACK cannot grant real deletion or source release.
 function cleanup(){return{action:'hold',reason:'fixture_has_no_authority'}}
 return{source,reserve,delivery,accept,ack,cleanup};
}
module.exports={createNasSeamFixture,SCOPE};
