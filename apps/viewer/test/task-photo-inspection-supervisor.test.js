'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const {runImportInspection}=require('../server/taskPhotoInspectionSupervisor');
test('inspection timeout terminates only its own child and releases capacity after close', async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'photo-inspection-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const worker=path.join(root,'worker.js'),pidFile=path.join(root,'pid');
 fs.writeFileSync(worker,`process.once('message', value => { require('node:fs').writeFileSync(value.pidFile, String(process.pid)); setInterval(() => {}, 1000); });`);
 const started=Date.now();
 await assert.rejects(runImportInspection({pidFile},{workerFile:worker,timeoutMs:500}),{code:'import_inspection_timeout'});
 assert.ok(Date.now()-started<3000);
 const pid=Number(fs.readFileSync(pidFile,'utf8'));let gone=false;
 for(let n=0;n<30;n++){try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH'){gone=true;break;}throw error;}await new Promise(resolve=>setTimeout(resolve,25));}
 assert.equal(gone,true,'owned timed-out child exits');
});
test('child capacity rejects excess work and recovers after owned children close',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'photo-inspection-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const worker=path.join(root,'worker.js');fs.writeFileSync(worker,`process.once('message', () => setInterval(() => {}, 1000));`);
 const work=Array.from({length:4},()=>runImportInspection({}, {workerFile:worker,timeoutMs:200}));
 await assert.rejects(runImportInspection({}, {workerFile:worker,timeoutMs:200}),{code:'import_inspection_busy'});
 const results=await Promise.allSettled(work);assert.ok(results.every(item=>item.status==='rejected'&&item.reason.code==='import_inspection_timeout'));
 await new Promise(resolve=>setTimeout(resolve,150));
 await assert.rejects(runImportInspection({}, {workerFile:worker,timeoutMs:200}),{code:'import_inspection_timeout'});
 await new Promise(resolve=>setTimeout(resolve,150));
});

test('a worker that replies and retains a handle is timed out and reaped before capacity is reused',{skip:process.platform !== 'linux' && 'signal behavior requires Linux'},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'photo-reply-hang-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const worker=path.join(root,'worker.js'),pidFile=path.join(root,'pid');
 fs.writeFileSync(worker,`process.once('message', value => { require('node:fs').writeFileSync(value.pidFile, String(process.pid)); process.send({ok:true,value:'premature'}); process.on('SIGTERM',()=>{}); setInterval(() => {},1000); });`);
 await assert.rejects(runImportInspection({pidFile},{workerFile:worker,timeoutMs:500}),{code:'import_inspection_timeout'});
 const pid=Number(fs.readFileSync(pidFile,'utf8'));let gone=false;
 for(let n=0;n<50;n++){try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH'){gone=true;break;}throw error;}await new Promise(resolve=>setTimeout(resolve,25));}
 assert.equal(gone,true,'the worker that replied but hung must exit');
});
