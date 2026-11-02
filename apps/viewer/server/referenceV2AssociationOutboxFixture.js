'use strict';
// Disposable-database experiment only. No real issuer, authority, quota,
// physical pin, migration, network route or production activation is supplied.
const crypto=require('node:crypto'),{inspectFixture}=require('./referenceV2IssuerInspection'),{prepareObservedSourceBindingDraft}=require('./referenceSourceBindingDraft');
const domain=Buffer.from('ltds-v2-two-attempt-binding-experiment-v1\0','ascii');
const fail=code=>{throw Object.assign(new Error(code),{code})};
const keyOf=buffer=>{try{if(!Buffer.isBuffer(buffer)||crypto.createPublicKey({key:buffer,format:'der',type:'spki'}).asymmetricKeyType!=='ed25519')fail('fixture_invalid');return Buffer.from(buffer)}catch{fail('fixture_invalid')}};
function createAssociationOutboxFixture(processing,scope){
 if(scope!=='isolated-association-outbox-fixture'||!processing?.database)fail('fixture_unavailable');
 const db=processing.database;
 processing.transaction(()=>db.exec(`CREATE TABLE IF NOT EXISTS v2_assoc_fixture(intent_id TEXT PRIMARY KEY,idempotency_id TEXT NOT NULL UNIQUE,request_id TEXT NOT NULL UNIQUE,nonce TEXT NOT NULL UNIQUE,binding_id TEXT NOT NULL UNIQUE,intent BLOB NOT NULL,intent_signature BLOB NOT NULL,body BLOB NOT NULL,viewer_key BLOB NOT NULL,signature BLOB,state TEXT NOT NULL CHECK(state IN ('committed','signed')));
 CREATE TRIGGER IF NOT EXISTS v2_assoc_no_delete BEFORE DELETE ON v2_assoc_fixture BEGIN SELECT RAISE(ABORT,'fixture outbox retained'); END;
 CREATE TRIGGER IF NOT EXISTS v2_assoc_no_replace BEFORE INSERT ON v2_assoc_fixture WHEN EXISTS(SELECT 1 FROM v2_assoc_fixture WHERE rowid=NEW.rowid OR intent_id=NEW.intent_id OR idempotency_id=NEW.idempotency_id OR request_id=NEW.request_id OR nonce=NEW.nonce OR binding_id=NEW.binding_id) BEGIN SELECT RAISE(ABORT,'fixture outbox retained'); END;
 CREATE TRIGGER IF NOT EXISTS v2_assoc_immutable BEFORE UPDATE ON v2_assoc_fixture WHEN NOT(OLD.state='committed' AND NEW.state='signed' AND OLD.rowid IS NEW.rowid AND OLD.intent_id IS NEW.intent_id AND OLD.idempotency_id IS NEW.idempotency_id AND OLD.request_id IS NEW.request_id AND OLD.nonce IS NEW.nonce AND OLD.binding_id IS NEW.binding_id AND OLD.intent IS NEW.intent AND OLD.intent_signature IS NEW.intent_signature AND OLD.body IS NEW.body AND OLD.viewer_key IS NEW.viewer_key AND OLD.signature IS NULL AND length(NEW.signature)=64) BEGIN SELECT RAISE(ABORT,'fixture outbox retained'); END;`));
 function inspected(args,key){
  if(!args||args.processing!==processing||args.scope!=='isolated-v2-issuer-inspection')fail('fixture_invalid');
  const result=inspectFixture(args);if(result.viewerJournal!=='matched_local_fixture'||!result.proposal)fail('fixture_unavailable');
  const intent=JSON.parse(args.intentBytes.toString('ascii')),body=Buffer.from(result.proposal.canonicalUtf8,'ascii');return {intent,body,key:keyOf(key)};
 }
 function matches(row,args,inspected){return row.intent_id===inspected.intent.intentId&&row.idempotency_id===inspected.intent.idempotencyId&&row.request_id===inspected.intent.reservationRequestId&&row.nonce===args.associationConfig.nonce&&row.binding_id===args.bindingId&&Buffer.from(row.intent).equals(args.intentBytes)&&Buffer.from(row.intent_signature).equals(args.signature)&&Buffer.from(row.body).equals(inspected.body)&&Buffer.from(row.viewer_key).equals(inspected.key)}
 function prepareInTransaction(args,publicKeyDer){
  const i=inspected(args,publicKeyDer),rows=db.prepare('SELECT * FROM v2_assoc_fixture WHERE intent_id=? OR idempotency_id=? OR request_id=? OR nonce=? OR binding_id=?').all(i.intent.intentId,i.intent.idempotencyId,i.intent.reservationRequestId,args.associationConfig.nonce,args.bindingId);
  if(rows.length){if(rows.length!==1||!matches(rows[0],args,i))fail('fixture_conflict');return {state:rows[0].state,body:Buffer.from(rows[0].body)}}
  db.prepare("INSERT INTO v2_assoc_fixture VALUES(?,?,?,?,?,?,?,?,?,NULL,'committed')").run(i.intent.intentId,i.intent.idempotencyId,i.intent.reservationRequestId,args.associationConfig.nonce,args.bindingId,args.intentBytes,args.signature,i.body,i.key);
  return {state:'committed',body:Buffer.from(i.body)};
 }
 function prepare(args,publicKeyDer){return processing.transactionOrOwned(()=>prepareInTransaction(args,publicKeyDer))}
 // Only synthetic tests may call this. Binding insertion and the outbox share
 // one synchronous transaction; any failure must escape to roll both back.
 function prepareWithBinding(args,publicKeyDer,bindingRequest,{afterBinding}={}){return processing.transaction(()=>{
  if(!bindingRequest||bindingRequest.id!==args?.bindingId||typeof bindingRequest.attemptId!=='string')fail('fixture_invalid');
  prepareObservedSourceBindingDraft(processing,bindingRequest);
  if(afterBinding!==undefined){if(typeof afterBinding!=='function')fail('fixture_invalid');const result=afterBinding();if(result&&typeof result.then==='function')fail('fixture_invalid')}
  return prepareInTransaction(args,publicKeyDer);
 })}
 function signCommitted(args,publicKeyDer,signer){
  if(typeof signer!=='function')fail('fixture_invalid');
  const first=processing.transaction(()=>{const i=inspected(args,publicKeyDer),row=db.prepare('SELECT * FROM v2_assoc_fixture WHERE intent_id=?').get(i.intent.intentId);if(!row||!matches(row,args,i))fail('fixture_conflict');if(row.state==='signed'&&!crypto.verify(null,Buffer.concat([domain,Buffer.from(row.body)]),{key:i.key,format:'der',type:'spki'},Buffer.from(row.signature)))fail('fixture_signature_invalid');return {state:row.state,body:Buffer.from(row.body),signature:row.signature&&Buffer.from(row.signature),key:i.key}});
  if(first.state==='signed')return {state:'signed',body:first.body,signature:first.signature};
  const message=Buffer.concat([domain,first.body]),signature=signer(Buffer.from(message));if(!Buffer.isBuffer(signature)||signature.length!==64||!crypto.verify(null,message,{key:first.key,format:'der',type:'spki'},signature))fail('fixture_signature_invalid');
  return processing.transaction(()=>{const i=inspected(args,publicKeyDer),row=db.prepare('SELECT * FROM v2_assoc_fixture WHERE intent_id=?').get(i.intent.intentId);if(!row||!matches(row,args,i))fail('fixture_conflict');if(row.state==='signed'){const saved=Buffer.from(row.signature);if(!crypto.verify(null,Buffer.concat([domain,Buffer.from(row.body)]),{key:i.key,format:'der',type:'spki'},saved)||!saved.equals(signature))fail('fixture_conflict');return {state:'signed',body:Buffer.from(row.body),signature:saved}}if(db.prepare("UPDATE v2_assoc_fixture SET signature=?,state='signed' WHERE intent_id=? AND state='committed'").run(signature,i.intent.intentId).changes!==1)fail('fixture_conflict');return {state:'signed',body:Buffer.from(row.body),signature:Buffer.from(signature)}});
 }
 return Object.freeze({prepare,prepareWithBinding,signCommitted,liveIssue(){fail('v2_issuer_not_qualified')}});
}
module.exports={createAssociationOutboxFixture};
