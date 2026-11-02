'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const p=require('../server/referenceProtocol'),{createNasSeamFixture,SCOPE}=require('./helpers/reference-nas-seam-fixture.cjs');
const image={sourceId:'photo-1',sha256:'11'.repeat(32),byteSize:10,kind:'image'};
const raw={sourceId:'emlid-raw',sha256:'22'.repeat(32),byteSize:4,kind:'raw_csv'};
const reservation={reservationId:'reservation-1',attemptId:'attempt-1',sourceIds:[image.sourceId],manifestSha256:p.sha256(p.canonicalBytes([image])),byteBudget:20};
const delivery={deliveryId:'delivery-1',reservationId:'reservation-1',sourceId:'photo-1',sha256:image.sha256,byteSize:10};
const acceptance={receiptId:'acceptance-1',ackOperationId:'ack-1',reservationId:'reservation-1',resultId:'result-1',sha256:'33'.repeat(32),byteSize:7};
test('synthetic source, budget, receipt and exact ACK stay non-authoritative',()=>{
 const db=new DatabaseSync(':memory:');try{
  assert.throws(()=>createNasSeamFixture(db,'production'),{code:'fixture_scope_required'});const f=createNasSeamFixture(db,SCOPE);
  assert.equal(f.source(image).action,'hold');f.source(raw);assert.throws(()=>f.source({...image,sha256:'ff'.repeat(32)}),{code:'fixture_identity_conflict'});
  assert.throws(()=>f.reserve({...reservation,sourceIds:[raw.sourceId],manifestSha256:p.sha256(p.canonicalBytes([raw]))}),{code:'fixture_source_binding_mismatch'});
  assert.throws(()=>f.reserve({...reservation,manifestSha256:'00'.repeat(32)}),{code:'fixture_source_binding_mismatch'});f.reserve(reservation);
  assert.deepEqual(f.delivery(delivery),{replayed:false,charged:10,action:'hold'});assert.deepEqual(f.delivery(delivery),{replayed:true,charged:10,action:'hold'});
  assert.throws(()=>f.delivery({...delivery,deliveryId:'delivery-2',sha256:'44'.repeat(32)}),{code:'fixture_source_binding_mismatch'});
  assert.equal(f.delivery({...delivery,deliveryId:'delivery-2'}).charged,20);assert.throws(()=>f.delivery({...delivery,deliveryId:'delivery-3'}),{code:'fixture_budget_exhausted'});
  const receipt=f.accept(acceptance);assert.equal(receipt.action,'hold');assert.equal(f.accept(acceptance).replayed,true);
  assert.throws(()=>f.accept({...acceptance,receiptId:'different'}),{code:'fixture_identity_conflict'});
  assert.throws(()=>f.ack({receiptId:acceptance.receiptId,ackOperationId:'ack-1',receiptSha256:'00'.repeat(32)}),{code:'fixture_ack_mismatch'});
  assert.equal(f.cleanup().action,'hold');const ack={receiptId:acceptance.receiptId,ackOperationId:acceptance.ackOperationId,receiptSha256:receipt.receiptSha256};
  assert.deepEqual(f.ack(ack),{replayed:false,action:'hold'});assert.deepEqual(f.ack(ack),{replayed:true,action:'hold'});assert.equal(f.cleanup().action,'hold');
 }finally{db.close()}
});
test('synthetic pending records survive close and reopen',{skip:!process.env.NAS_SEAM_FIXTURE_DB},()=>{
 const filename=process.env.NAS_SEAM_FIXTURE_DB;let db=new DatabaseSync(filename),receipt;
 try{const f=createNasSeamFixture(db,SCOPE);f.source(image);f.reserve(reservation);f.delivery(delivery);receipt=f.accept(acceptance)}finally{db.close()}
 db=new DatabaseSync(filename);try{const f=createNasSeamFixture(db,SCOPE);assert.equal(f.source(image).replayed,true);assert.equal(f.reserve(reservation).replayed,true);assert.equal(f.delivery(delivery).charged,10);assert.equal(f.accept(acceptance).receiptSha256,receipt.receiptSha256);assert.equal(f.cleanup().action,'hold');assert.equal(f.ack({receiptId:acceptance.receiptId,ackOperationId:acceptance.ackOperationId,receiptSha256:receipt.receiptSha256}).action,'hold')}finally{db.close()}
});
