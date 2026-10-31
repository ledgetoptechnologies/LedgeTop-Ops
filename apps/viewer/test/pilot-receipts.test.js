'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {readTerminalReceipt,completionReceipt}=require('./helpers/pilot-receipts.cjs');
test('terminal receipt requires matching run, task, completion and bounded digest',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-receipt-test-')),file=path.join(dir,'terminal.json');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const valid={schemaVersion:1,runId:'run',providerTaskId:'task',status:'completed',archiveSha256:'a'.repeat(64),archiveByteSize:42},args={file,runId:'run',providerTaskId:'task'};
 const write=value=>fs.writeFileSync(file,JSON.stringify(value));write(valid);assert.deepEqual(readTerminalReceipt(args),{sha256:valid.archiveSha256,byteSize:42});
 for(const changed of [{runId:'other'},{providerTaskId:'other'},{status:'running'},{archiveSha256:'x'.repeat(64)},{archiveByteSize:0},{archiveByteSize:1.5},{schemaVersion:2}]){write({...valid,...changed});assert.throws(()=>readTerminalReceipt(args),/mismatch/)}
 fs.writeFileSync(file,'x'.repeat(4097));assert.throws(()=>readTerminalReceipt(args),/invalid/);
});
test('completion receipt carries matching identities and archive evidence only for ingest',()=>{
 const identity={projectId:'p',datasetId:'d',taskId:'t',attemptId:'a',providerId:'v',providerTaskId:'remote',manifestSha256:'b'.repeat(64),expectedArchive:{sha256:'c'.repeat(64),byteSize:5}},job={id:'j',job_type:'ingest',lease_owner:'worker',attempt_count:2};
 const observedArchive={sha256:'c'.repeat(64),byteSize:5},output=completionReceipt({runId:'run',identity,job,attemptStatus:'derivatives',observedArchive});assert.deepEqual(output,{schemaVersion:1,runId:'run',...identity,jobId:'j',jobType:'ingest',claimOwner:'worker',claimCount:2,attemptStatus:'derivatives',observedArchive});
 assert.equal(Object.hasOwn(completionReceipt({runId:'run',identity,job:{...job,job_type:'submit'},attemptStatus:'queued_upstream'}),'expectedArchive'),false);
});
