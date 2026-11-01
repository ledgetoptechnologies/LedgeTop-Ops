'use strict';

// Synthetic-only storage transaction. Not a route, migration, authorization,
// real filesystem pin or production custody receipt. All authority is absent.
const {createHash, verify}=require('node:crypto');
const {canonicalBytes}=require('./referenceProtocol');
const SCOPE='synthetic-reservation-fixture-only';
const SIGN_DOMAIN=Buffer.from('ltds-v2-synthetic-reservation-receipt-v1\0','ascii');
const sha=b=>createHash('sha256').update(b).digest('hex');
const id=v=>typeof v==='string' && /^[A-Za-z0-9_-]{43}$/.test(v) && Buffer.from(v,'base64url').length===32 && Buffer.from(v,'base64url').toString('base64url')===v;
const slug=v=>typeof v==='string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const hash=v=>typeof v==='string' && /^[a-f0-9]{64}$/.test(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const closed=(x,keys)=>x && Object.getPrototypeOf(x)===Object.prototype && Object.keys(x).length===keys.length && keys.every(k=>Object.hasOwn(x,k));
const fail=code=>{const e=new Error(code);e.code=code;throw e};

function createSyntheticReservation(db,scope){
  if(scope!==SCOPE)fail('fixture_scope_required');
  db.exec('PRAGMA busy_timeout=5000');
  const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const out=fn();db.exec('COMMIT');return out}catch(e){db.exec('ROLLBACK');throw e}};
  db.exec(`CREATE TABLE IF NOT EXISTS v2s_quota (id TEXT PRIMARY KEY, capacity INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS v2s_sources (id TEXT PRIMARY KEY, revision TEXT NOT NULL, content BLOB NOT NULL, digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS v2s_reservations (reservation_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL UNIQUE, idempotency_id TEXT NOT NULL UNIQUE, receipt_id TEXT NOT NULL UNIQUE, source_id TEXT NOT NULL, intent BLOB NOT NULL, intent_sha TEXT NOT NULL, receipt BLOB NOT NULL, key_id TEXT NOT NULL, public_key BLOB NOT NULL, signature BLOB, state TEXT NOT NULL CHECK(state IN ('committed','signed')));
    CREATE TRIGGER IF NOT EXISTS v2s_source_no_update BEFORE UPDATE ON v2s_sources WHEN EXISTS(SELECT 1 FROM v2s_reservations WHERE source_id=OLD.id) BEGIN SELECT RAISE(ABORT,'synthetic source pinned'); END;
    CREATE TRIGGER IF NOT EXISTS v2s_source_no_delete BEFORE DELETE ON v2s_sources WHEN EXISTS(SELECT 1 FROM v2s_reservations WHERE source_id=OLD.id) BEGIN SELECT RAISE(ABORT,'synthetic source pinned'); END;
    CREATE TRIGGER IF NOT EXISTS v2s_source_no_replace BEFORE INSERT ON v2s_sources WHEN EXISTS(SELECT 1 FROM v2s_reservations WHERE source_id=NEW.id) BEGIN SELECT RAISE(ABORT,'synthetic source pinned'); END;
    CREATE TRIGGER IF NOT EXISTS v2s_reservation_no_delete BEFORE DELETE ON v2s_reservations BEGIN SELECT RAISE(ABORT,'synthetic reservation immutable'); END;
    CREATE TRIGGER IF NOT EXISTS v2s_reservation_no_replace BEFORE INSERT ON v2s_reservations WHEN EXISTS(SELECT 1 FROM v2s_reservations WHERE reservation_id=NEW.reservation_id OR intent_id=NEW.intent_id OR idempotency_id=NEW.idempotency_id OR receipt_id=NEW.receipt_id) BEGIN SELECT RAISE(ABORT,'synthetic reservation immutable'); END;
    CREATE TRIGGER IF NOT EXISTS v2s_reservation_update BEFORE UPDATE ON v2s_reservations WHEN NOT (OLD.state='committed' AND NEW.state='signed' AND OLD.signature IS NULL AND length(NEW.signature)=64 AND OLD.reservation_id IS NEW.reservation_id AND OLD.intent_id IS NEW.intent_id AND OLD.idempotency_id IS NEW.idempotency_id AND OLD.receipt_id IS NEW.receipt_id AND OLD.source_id IS NEW.source_id AND OLD.intent IS NEW.intent AND OLD.intent_sha IS NEW.intent_sha AND OLD.receipt IS NEW.receipt AND OLD.key_id IS NEW.key_id AND OLD.public_key IS NEW.public_key) BEGIN SELECT RAISE(ABORT,'synthetic reservation immutable'); END;`);
  function checkStoredSource(row){
    let intent;try{intent=JSON.parse(Buffer.from(row.intent).toString('utf8'))}catch{fail('source_conflict')}
    const source=db.prepare('SELECT * FROM v2s_sources WHERE id=?').get(row.source_id);
    if(sha(Buffer.from(row.intent))!==row.intent_sha||!source||intent.sourceId!==row.source_id||source.revision!==intent.sourceRevision||source.digest!==intent.sourceSha256||Buffer.from(source.content).length!==intent.sourceBytes||sha(Buffer.from(source.content))!==intent.sourceSha256)fail('source_conflict');
  }
  function provisionQuota(capacity){if(!integer(capacity))fail('invalid_input');return tx(()=>{const x=db.prepare('SELECT capacity FROM v2s_quota WHERE id=?').get('fixture');if(x){if(x.capacity!==capacity)fail('quota_conflict');return}db.prepare('INSERT INTO v2s_quota(id,capacity) VALUES(?,?)').run('fixture',capacity)})}
  function addSource({sourceId,revision,bytes}){if(!slug(sourceId)||!slug(revision)||!Buffer.isBuffer(bytes)||bytes.length>1048576)fail('invalid_input');return tx(()=>{const x=db.prepare('SELECT revision,content,digest FROM v2s_sources WHERE id=?').get(sourceId);if(x){if(x.revision!==revision||x.digest!==sha(bytes)||!Buffer.from(x.content).equals(bytes))fail('source_conflict');return}db.prepare('INSERT INTO v2s_sources VALUES(?,?,?,?)').run(sourceId,revision,bytes,sha(bytes))})}
  function reserve(input){
    const keys=['intentId','idempotencyId','reservationId','receiptId','jobId','generation','sourceId','sourceRevision','sourceSha256','sourceBytes','byteBudget','keyId','publicKeyDer'];
    if(!closed(input,keys)||!['intentId','idempotencyId','reservationId','receiptId'].every(k=>id(input[k]))||!['jobId','sourceId','sourceRevision','keyId'].every(k=>slug(input[k]))||!hash(input.sourceSha256)||!integer(input.generation)||input.generation<1||!integer(input.sourceBytes)||!integer(input.byteBudget)||input.byteBudget<input.sourceBytes||!Buffer.isBuffer(input.publicKeyDer)||input.publicKeyDer.length<32||input.publicKeyDer.length>128)fail('invalid_input');
    const intent=canonicalBytes({...input,publicKeyDer:input.publicKeyDer.toString('base64url')});const intentSha=sha(intent);
    return tx(()=>{
      const previous=db.prepare('SELECT * FROM v2s_reservations WHERE intent_id=? OR idempotency_id=? OR reservation_id=? OR receipt_id=?').all(input.intentId,input.idempotencyId,input.reservationId,input.receiptId);
      if(previous.length){if(previous.length!==1||!Buffer.from(previous[0].intent).equals(intent))fail('reservation_conflict');checkStoredSource(previous[0]);return {receipt:Buffer.from(previous[0].receipt),state:previous[0].state}}
      const source=db.prepare('SELECT * FROM v2s_sources WHERE id=?').get(input.sourceId),quota=db.prepare('SELECT * FROM v2s_quota WHERE id=?').get('fixture');
      if(!source||source.revision!==input.sourceRevision||source.digest!==input.sourceSha256||Buffer.from(source.content).length!==input.sourceBytes||sha(Buffer.from(source.content))!==input.sourceSha256)fail('source_conflict');
      if(!quota||input.byteBudget>quota.capacity-quota.used)fail('quota_exceeded');
      const receipt=canonicalBytes({version:1,scope:'synthetic-only',receiptId:input.receiptId,reservationId:input.reservationId,intentSha256:intentSha,jobId:input.jobId,generation:input.generation,sourceId:input.sourceId,sourceRevision:input.sourceRevision,sourceSha256:input.sourceSha256,sourceBytes:input.sourceBytes,byteBudget:input.byteBudget,keyId:input.keyId});
      db.prepare('UPDATE v2s_quota SET used=used+? WHERE id=?').run(input.byteBudget,'fixture');
      db.prepare("INSERT INTO v2s_reservations VALUES(?,?,?,?,?,?,?,?,?,?,NULL,'committed')").run(input.reservationId,input.intentId,input.idempotencyId,input.receiptId,input.sourceId,intent,intentSha,receipt,input.keyId,input.publicKeyDer);
      return {receipt,state:'committed'};
    });
  }
  function signCommitted(reservationId,signer){
    if(!id(reservationId)||typeof signer!=='function')fail('invalid_input');
    const row=db.prepare('SELECT * FROM v2s_reservations WHERE reservation_id=?').get(reservationId);if(!row)fail('not_found');
    checkStoredSource(row);
    if(row.state==='signed'){if(!verify(null,Buffer.concat([SIGN_DOMAIN,Buffer.from(row.receipt)]),{key:Buffer.from(row.public_key),format:'der',type:'spki'},Buffer.from(row.signature)))fail('synthetic_signature_invalid');return {receipt:Buffer.from(row.receipt),signature:Buffer.from(row.signature),state:'signed'}}
    const message=Buffer.concat([SIGN_DOMAIN,Buffer.from(row.receipt)]),signature=signer(Buffer.from(message));
    if(!Buffer.isBuffer(signature)||signature.length!==64||!verify(null,message,{key:Buffer.from(row.public_key),format:'der',type:'spki'},signature))fail('synthetic_signature_invalid');
    return tx(()=>{const fresh=db.prepare('SELECT * FROM v2s_reservations WHERE reservation_id=?').get(reservationId);if(!fresh||!Buffer.from(fresh.receipt).equals(Buffer.from(row.receipt))||!Buffer.from(fresh.public_key).equals(Buffer.from(row.public_key)))fail('reservation_conflict');checkStoredSource(fresh);if(fresh.state==='signed'){if(!Buffer.from(fresh.signature).equals(signature))fail('signature_conflict');return {receipt:Buffer.from(fresh.receipt),signature:Buffer.from(fresh.signature),state:'signed'}}db.prepare("UPDATE v2s_reservations SET signature=?,state='signed' WHERE reservation_id=? AND state='committed'").run(signature,reservationId);return {receipt:Buffer.from(fresh.receipt),signature,state:'signed'}});
  }
  function liveReserve(){fail('v2_reservation_not_qualified')}
  return {provisionQuota,addSource,reserve,signCommitted,liveReserve};
}
module.exports={createSyntheticReservation,SCOPE};
