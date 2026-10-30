'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {checkPilotBoundary,sealPilotDbIdentity,verifyPilotDbIdentity}=require('./helpers/pilot-fixture-boundary.cjs');

test('pilot boundary rejects unintended endpoints, mounts, owners and unprepared state',{skip:process.platform!=='linux'},t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-pilot-boundary-')),parent=path.join(base,'state'),source=path.join(base,'photos'),ownerId='pilot-'+'a'.repeat(32);t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 fs.mkdirSync(parent,{mode:0o700});fs.mkdirSync(source,{mode:0o700});fs.writeFileSync(path.join(parent,'.viewer-pilot-owner'),ownerId,{mode:0o600});
 const args={root:path.join(parent,'viewer'),input:source,endpoint:'https://127.0.0.1:28443',ownerId,phase:'prepare',parent,source};
 assert.deepEqual(checkPilotBoundary(args),{root:args.root,input:source,endpoint:args.endpoint});
 assert.throws(()=>checkPilotBoundary({...args,endpoint:'https://viewer.example'}),/boundary/);
 assert.throws(()=>checkPilotBoundary({...args,ownerId:'pilot-'+'b'.repeat(32)}),/marker/);
 assert.throws(()=>checkPilotBoundary({...args,phase:'submit'}));
 fs.mkdirSync(args.root,{mode:0o700});assert.throws(()=>checkPilotBoundary(args),/already exists/);
 const db=path.join(args.root,'viewer.sqlite'),{DatabaseSync}=require('node:sqlite'),database=new DatabaseSync(db);fs.chmodSync(db,0o600);database.exec('CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT)');assert.throws(()=>checkPilotBoundary({...args,phase:'submit'}));sealPilotDbIdentity({parent,root:args.root,ownerId,database});assert.doesNotThrow(()=>checkPilotBoundary({...args,phase:'submit'}));assert.equal(verifyPilotDbIdentity({database,parent,ownerId}),true);assert.throws(()=>sealPilotDbIdentity({parent,root:args.root,ownerId,database}));
 const foreign=new DatabaseSync(':memory:');foreign.exec('CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT)');foreign.prepare('INSERT INTO app_state VALUES(?,?,?)').run('viewer-pilot-fixture-identity','wrong','t');assert.throws(()=>verifyPilotDbIdentity({database:foreign,parent,ownerId}),/internal identity/);foreign.close();database.close();
 fs.renameSync(db,`${db}.original`);fs.writeFileSync(db,'replacement',{mode:0o600});assert.throws(()=>checkPilotBoundary({...args,phase:'submit'}),/database identity/);fs.unlinkSync(db);fs.renameSync(`${db}.original`,db);assert.doesNotThrow(()=>checkPilotBoundary({...args,phase:'submit'}));
 fs.linkSync(db,`${db}.link`);assert.throws(()=>checkPilotBoundary({...args,phase:'submit'}),/database identity/);fs.unlinkSync(`${db}.link`);
 fs.chmodSync(parent,0o755);assert.throws(()=>checkPilotBoundary({...args,phase:'submit'}),/private/);fs.chmodSync(parent,0o700);
 const linked=path.join(base,'link');fs.symlinkSync(source,linked);assert.throws(()=>checkPilotBoundary({...args,input:linked,source:linked,phase:'submit'}),/redirected/);
});

test('a pinned fixture directory keeps a SQLite open on the original directory after path replacement',{skip:process.platform!=='linux'},t=>{
 const {DatabaseSync}=require('node:sqlite'),base=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-pilot-dir-pin-')),root=path.join(base,'fixture'),moved=path.join(base,'original');t.after(()=>fs.rmSync(base,{recursive:true,force:true}));fs.mkdirSync(root);
 const create=file=>{const db=new DatabaseSync(file);db.exec('CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES(\'original\')');db.close();};create(path.join(root,'viewer.sqlite'));
 const fd=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{
  fs.renameSync(root,moved);fs.mkdirSync(root);const replacement=new DatabaseSync(path.join(root,'viewer.sqlite'));replacement.exec('CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES(\'replacement\')');replacement.close();
  const db=new DatabaseSync(`/proc/self/fd/${fd}/viewer.sqlite`);try{assert.equal(db.prepare('SELECT value FROM marker').get().value,'original');db.exec('PRAGMA journal_mode=WAL');db.prepare('INSERT INTO marker VALUES(?)').run('pinned-write');}finally{db.close();}
  const original=new DatabaseSync(path.join(moved,'viewer.sqlite'),{readOnly:true}),other=new DatabaseSync(path.join(root,'viewer.sqlite'),{readOnly:true});try{assert.equal(original.prepare('SELECT COUNT(*) n FROM marker').get().n,2);assert.equal(other.prepare('SELECT COUNT(*) n FROM marker').get().n,1);}finally{original.close();other.close();}
 }finally{fs.closeSync(fd);}
});

test('SQLite descriptor experiment rejects a write after post-open directory replacement',{skip:process.platform!=='linux'},t=>{
 const {DatabaseSync}=require('node:sqlite'),base=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-pilot-postopen-')),root=path.join(base,'fixture'),moved=path.join(base,'original');t.after(()=>fs.rmSync(base,{recursive:true,force:true}));fs.mkdirSync(root);
 const seed=new DatabaseSync(path.join(root,'viewer.sqlite'));seed.exec('CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES(\'original\')');seed.close();
 const fd=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW),db=new DatabaseSync(`/proc/self/fd/${fd}/viewer.sqlite`);
 try{fs.renameSync(root,moved);fs.mkdirSync(root);const replacement=new DatabaseSync(path.join(root,'viewer.sqlite'));replacement.exec('CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES(\'replacement\')');replacement.close();
  assert.throws(()=>{db.exec('PRAGMA journal_mode=WAL');db.prepare('INSERT INTO marker VALUES(?)').run('pinned-write');},/readonly database/);
 }finally{db.close();fs.closeSync(fd);}
 const original=new DatabaseSync(path.join(moved,'viewer.sqlite'),{readOnly:true}),other=new DatabaseSync(path.join(root,'viewer.sqlite'),{readOnly:true});try{assert.equal(original.prepare('SELECT COUNT(*) n FROM marker').get().n,1);assert.equal(other.prepare('SELECT COUNT(*) n FROM marker').get().n,1);}finally{original.close();other.close();}
});
