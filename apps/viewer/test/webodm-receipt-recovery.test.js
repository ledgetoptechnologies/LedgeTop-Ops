'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');

test('an abandoned WebODM receipt reservation becomes recoverable after its bounded lease',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-webodm-receipt-'));
  const db=openDatabase(path.join(root,'viewer.sqlite'));
  const processing=new ProcessingRepository(db);
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  const receipt={subject:'ops:recovery',key:'webodm-stale-key',method:'POST',path:'/api/v1/processing/webodm-task-imports',requestHash:'c'.repeat(64)};
  assert.equal(processing.reserveSubjectOperationReceipt(receipt).created,true);
  assert.equal(processing.reserveSubjectOperationReceipt(receipt).created,false);
  db.prepare('UPDATE subject_operation_receipts SET created_at=? WHERE subject=? AND client_key=?').run(new Date(Date.now()-121000).toISOString(),receipt.subject,receipt.key);
  assert.equal(processing.reserveSubjectOperationReceipt(receipt).created,true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM subject_operation_receipts WHERE subject=? AND client_key=?').get(receipt.subject,receipt.key).n,1);
});
