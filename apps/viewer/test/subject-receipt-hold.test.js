'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {openDatabase}=require('../server/database'),{ProcessingRepository}=require('../server/processingRepository');
test('stale pending reservation stays held and late error cannot erase an attached operation',()=>{
 const db=openDatabase(':memory:');try{const p=new ProcessingRepository(db),r={subject:'synthetic',key:'synthetic-key',method:'POST',path:'/synthetic',requestHash:'a'.repeat(64)};
  assert.equal(p.reserveSubjectOperationReceipt(r).created,true);db.prepare("UPDATE subject_operation_receipts SET created_at='2000-01-01T00:00:00.000Z'").run();assert.equal(p.reserveSubjectOperationReceipt(r).created,false);assert.equal(p.reserveSubjectOperationReceipt({...r,requestHash:'b'.repeat(64)}).record.request_sha256,r.requestHash);
  const op=p.createImportPreviewOperation({request:{rootKey:'dataset_import',relativePath:'synthetic'},subject:r.subject,receipt:r});assert.ok(op.id);
  assert.equal(p.completeSubjectOperationReceipt(r.subject,r.key,400,{code:'late_error'}),false);assert.equal(p.getSubjectOperationReceipt(r.subject,r.key).operationId,op.id);
  assert.equal(p.completeSubjectOperationReceipt(r.subject,r.key,202,{operation:op}),true);assert.equal(p.completeSubjectOperationReceipt(r.subject,r.key,400,{code:'late_error'}),false);const replay=p.reserveSubjectOperationReceipt(r);assert.equal(replay.record.response_status,202);assert.equal(replay.record.operation_id,op.id);assert.equal(db.prepare('SELECT count(*) n FROM dataset_operations').get().n,1);
 }finally{db.close();}
});
test('completed error cannot later be attached to a new operation',()=>{
 const db=openDatabase(':memory:');try{const p=new ProcessingRepository(db),r={subject:'synthetic',key:'failure-key',method:'POST',path:'/synthetic',requestHash:'c'.repeat(64)};p.reserveSubjectOperationReceipt(r);assert.equal(p.completeSubjectOperationReceipt(r.subject,r.key,400,{code:'invalid'}),true);assert.throws(()=>p.createImportPreviewOperation({request:{},subject:r.subject,receipt:r}),/operation receipt is unavailable/);assert.equal(db.prepare('SELECT count(*) n FROM dataset_operations').get().n,0);}finally{db.close();}
});
