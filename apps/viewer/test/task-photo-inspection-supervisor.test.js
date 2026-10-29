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

test('IPC send callback failure escalates and reaps its SIGTERM-resistant child', {skip:process.platform !== 'linux' && 'signal behavior requires Linux'}, async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'photo-ipc-failure-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const worker=path.join(root,'worker.js'),pidFile=path.join(root,'pid');
 fs.writeFileSync(worker,`process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
 const childProcess=require('node:child_process'),originalFork=childProcess.fork,modulePath=require.resolve('../server/taskPhotoInspectionSupervisor');
 const oldCache=require.cache[modulePath];delete require.cache[modulePath];let spawned;
 childProcess.fork=(...args)=>{spawned=originalFork(...args);spawned.send=(_input,callback)=>{const until=Date.now()+3000;const poll=setInterval(()=>{if(fs.existsSync(pidFile)){clearInterval(poll);callback(Object.assign(new Error('simulated IPC error'),{code:'EPIPE'}));}else if(Date.now()>until){clearInterval(poll);callback(new Error('worker did not start'));}},10);};return spawned;};
 let isolated;try{isolated=require(modulePath);}finally{childProcess.fork=originalFork;if(oldCache)require.cache[modulePath]=oldCache;else delete require.cache[modulePath];}
 await assert.rejects(isolated.runImportInspection({}, {workerFile:worker,timeoutMs:4000}),{code:'import_inspection_failed'});
 assert.ok(fs.existsSync(pidFile),'the test worker started');const pid=Number(fs.readFileSync(pidFile,'utf8'));let gone=false;
 for(let n=0;n<80;n++){try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH'){gone=true;break;}throw error;}await new Promise(resolve=>setTimeout(resolve,25));}
 assert.equal(gone,true,'the owned worker must be reaped after IPC failure');
 assert.equal(spawned.signalCode,'SIGKILL','the worker ignored SIGTERM and was forcibly reaped');
});
