'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {readPilotIdentity}=require('./helpers/pilot-identity.cjs');
test('pilot identity binds the active attempt to its original dataset and manifest',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-identity-test-')),file=path.join(dir,'identity.json');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const identity={schemaVersion:1,ownerId:'run',projectId:'p',datasetId:'d',taskId:'t',attemptId:'a',providerId:'v',providerTaskId:'remote',photoCount:40,manifestSha256:'a'.repeat(64)};fs.writeFileSync(file,JSON.stringify(identity));
 const rows={attempt:{taskId:'t',datasetId:'d',providerId:'v',providerTaskId:'remote'},task:{projectId:'p',activeAttemptId:'a'},dataset:{projectId:'p',manifestSha256:identity.manifestSha256,fileCount:40}},processing={getAttempt:()=>rows.attempt,getTask:()=>rows.task,getDataset:()=>rows.dataset},args={file,ownerId:'run',processing};
 assert.deepEqual(readPilotIdentity(args),identity);
 for(const [table,key,value] of [['attempt','datasetId','other'],['attempt','providerTaskId','other'],['task','activeAttemptId','other'],['dataset','manifestSha256','b'.repeat(64)],['dataset','fileCount',39]]){const previous=rows[table][key];rows[table][key]=value;assert.throws(()=>readPilotIdentity(args),/database identity/);rows[table][key]=previous;}
 assert.throws(()=>readPilotIdentity({...args,ownerId:'other'}),/identity invalid/);
 fs.writeFileSync(file,'x'.repeat(4097));assert.throws(()=>readPilotIdentity(args),/identity invalid/);
});
