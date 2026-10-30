'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {runLockedExecutor}=require('../server/containerExecutorLock');

test('executor rejects a matching descriptor that is not locked',{skip:process.platform!=='linux'},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-unheld-lock-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'lock');fs.writeFileSync(file,crypto.randomBytes(32),{mode:0o600});
 const fd=fs.openSync(file,'r+'),stat=fs.fstatSync(fd,{bigint:true}),digest=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 try{
  const result=require('node:child_process').spawnSync(process.execPath,['-e',`require(${JSON.stringify(require.resolve('../server/containerExecutorLock'))}).inheritedLockIdentity()`],{stdio:['ignore','pipe','pipe',fd],env:{...process.env,VIEWER_CONTAINER_LOCK_DEVICE:String(stat.dev),VIEWER_CONTAINER_LOCK_INODE:String(stat.ino),VIEWER_CONTAINER_LOCK_NONCE_SHA256:digest},timeout:5000});
  assert.notEqual(result.status,0);assert.match(result.stderr.toString(),/does not hold the expected flock/);
 }finally{fs.closeSync(fd);}
});

test('executor rejects a locked file after its pathname is unlinked',{skip:process.platform!=='linux'},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-unlinked-lock-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const containerId=crypto.randomUUID(),executor=path.join(root,'executor.js');
 fs.writeFileSync(executor,"let body='';process.stdin.on('data',c=>body+=c);process.stdin.on('end',()=>{const p=JSON.parse(body);require('node:fs').unlinkSync(p.lockPath);require(p.modulePath).inheritedLockIdentity();});");
 const result=await runLockedExecutor({lockDirectory:root,containerId,executorPath:executor,input:{lockPath:path.join(root,`${containerId}.lock`),modulePath:require.resolve('../server/containerExecutorLock')},timeoutMs:5000});
 assert.notEqual(result.code,0);assert.match(result.stderr,/inherited container lock identity mismatch/);
});

test('no-fork executors exclude each other and release after exit or timeout',{skip:process.platform!=='linux'},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-executor-lock-'));
 const executor=path.join(root,'executor.js'),ready=path.join(root,'ready'),containerId=crypto.randomUUID();
 fs.writeFileSync(executor,"let body='';process.stdin.on('data',c=>body+=c);process.stdin.on('end',()=>{const p=JSON.parse(body),identity=require(p.modulePath).inheritedLockIdentity();require('node:fs').writeFileSync(p.ready,JSON.stringify(identity));setTimeout(()=>process.exit(0),p.delay);});");
 const modulePath=require.resolve('../server/containerExecutorLock'),first=runLockedExecutor({lockDirectory:root,containerId,executorPath:executor,input:{ready,delay:700,modulePath},timeoutMs:5000});
 t.after(async()=>{await first;fs.rmSync(root,{recursive:true,force:true});});
 const deadline=Date.now()+5000;while(!fs.existsSync(ready)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));assert.equal(fs.existsSync(ready),true);
 const identity=JSON.parse(fs.readFileSync(ready,'utf8')),stat=fs.statSync(path.join(root,`${containerId}.lock`),{bigint:true});assert.equal(identity.device,String(stat.dev));assert.equal(identity.inode,String(stat.ino));
 const second=await runLockedExecutor({lockDirectory:root,containerId,executorPath:executor,input:{ready,delay:1,modulePath},timeoutMs:5000});assert.equal(second.lockConflictOrReservedExit,true);
 assert.equal((await first).code,0);
 const after=await runLockedExecutor({lockDirectory:root,containerId,executorPath:executor,input:{ready,delay:1,modulePath},timeoutMs:5000});assert.equal(after.code,0);
 const stopped=await runLockedExecutor({lockDirectory:root,containerId,executorPath:executor,input:{ready,delay:5000,modulePath},timeoutMs:200});assert.equal(stopped.timedOut,true);
 assert.equal((await runLockedExecutor({lockDirectory:root,containerId,executorPath:executor,input:{ready,delay:1,modulePath},timeoutMs:5000})).code,0);
});

test('executor rejects symlink lock files and nonprivate directories',{skip:process.platform!=='linux'},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-executor-lock-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const containerId=crypto.randomUUID();fs.symlinkSync(path.join(root,'target'),path.join(root,`${containerId}.lock`));
 assert.throws(()=>runLockedExecutor({lockDirectory:root,containerId,executorPath:__filename,input:{}}));
 fs.chmodSync(root,0o777);assert.throws(()=>runLockedExecutor({lockDirectory:root,containerId:crypto.randomUUID(),executorPath:__filename,input:{}}),/not private/);
});

test('an action refuses a replacement lock inode',{skip:process.platform!=='linux'},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-action-lock-binding-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dbPath=path.join(root,'fixture.sqlite'),{openDatabase}=require('../server/database'),{ProcessingRepository}=require('../server/processingRepository');
 const db=openDatabase(dbPath),processing=new ProcessingRepository(db),project=processing.createProject({displayName:'Synthetic'}),trash=processing.trashProject(project.id,'fixture');
 assert.equal(processing.finishContainerTrashPlan(trash.id),true);const action=processing.acquireContainerAction(trash.id,'restore');assert.ok(action);db.close();
 const executor=path.join(root,'executor.js');fs.writeFileSync(executor,"let body='';process.stdin.on('data',c=>body+=c);process.stdin.on('end',()=>{const p=JSON.parse(body),db=require(p.dbModule).openDatabase(p.dbPath),Repo=require(p.repoModule).ProcessingRepository;try{process.stdout.write(JSON.stringify({bound:new Repo(db).bindContainerActionLock(p.action)}));}finally{db.close();}});");
 const input={dbPath,action,dbModule:require.resolve('../server/database'),repoModule:require.resolve('../server/processingRepository')},run=()=>runLockedExecutor({lockDirectory:root,containerId:trash.id,executorPath:executor,input,timeoutMs:10000});
 const first=await run();assert.equal(first.code,0);assert.equal(JSON.parse(first.stdout).bound,true);
 const same=await run();assert.equal(same.code,0);assert.equal(JSON.parse(same.stdout).bound,true);
 fs.unlinkSync(path.join(root,`${trash.id}.lock`));
 const replaced=await run();assert.equal(replaced.code,0);assert.equal(JSON.parse(replaced.stdout).bound,false);
});
