'use strict';

// Unmounted draft. The caller must already possess a verified exclusive root
// and writer fence. This journal never issues an acceptance or publishes a model.
const fs=require('node:fs');
const {DatabaseSync}=require('node:sqlite');
const p=require('./referenceProtocol');
const {checkAuthority,retainReferenceResult,verifyRetainedReferenceResult}=require('./referenceResultSpool');
const fail=code=>{const e=new Error(code);e.code=code;throw e;};
const DDL=[
  `CREATE TABLE result_journal (storage_key TEXT PRIMARY KEY NOT NULL, job_id TEXT NOT NULL, generation INTEGER NOT NULL, environment TEXT NOT NULL, object_id TEXT NOT NULL, binding_json TEXT NOT NULL, root_device TEXT NOT NULL, root_inode TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','ready')), UNIQUE(job_id,generation,environment,object_id))`,
  `CREATE TRIGGER result_journal_no_replace BEFORE INSERT ON result_journal WHEN EXISTS(SELECT 1 FROM result_journal WHERE storage_key=NEW.storage_key OR rowid=NEW.rowid OR (job_id=NEW.job_id AND generation=NEW.generation AND environment=NEW.environment AND object_id=NEW.object_id)) BEGIN SELECT RAISE(ABORT,'result journal replacement'); END`,
  `CREATE TRIGGER result_journal_no_delete BEFORE DELETE ON result_journal BEGIN SELECT RAISE(ABORT,'result journal retention'); END`,
  `CREATE TRIGGER result_journal_immutable BEFORE UPDATE ON result_journal WHEN NEW.rowid IS NOT OLD.rowid OR NEW.storage_key IS NOT OLD.storage_key OR NEW.job_id IS NOT OLD.job_id OR NEW.generation IS NOT OLD.generation OR NEW.environment IS NOT OLD.environment OR NEW.object_id IS NOT OLD.object_id OR NEW.binding_json IS NOT OLD.binding_json OR NEW.root_device IS NOT OLD.root_device OR NEW.root_inode IS NOT OLD.root_inode OR (OLD.state='ready' AND NEW.state<>'ready') BEGIN SELECT RAISE(ABORT,'result journal immutable'); END`
];
function binding(expected,manifest,objectId) {
  if (!expected || !Number.isSafeInteger(expected.generation) || expected.generation<1 || !Array.isArray(expected.requestedEngines) || !expected.requestedEngines.includes('odm') || !/^[a-f0-9]{64}$/.test(expected.inputManifestSha256||'') || !/^[a-f0-9]{64}$/.test(expected.resultManifestSha256||'')) fail('REFERENCE_RESULT_BINDING');
  p.validateResultManifest(manifest,expected);
  if(manifest.resultManifestSha256!==expected.resultManifestSha256)fail('REFERENCE_RESULT_BINDING');
  const object=manifest.objects.find(x=>x.id===objectId);
  if(!object || object.role!=='odm_archive' || object.byteSize<1)fail('REFERENCE_RESULT_BINDING');
  return {jobId:manifest.jobId,generation:manifest.generation,environment:manifest.environment,inputManifestSha256:expected.inputManifestSha256,pipelineDigest:manifest.pipelineDigest,resultManifestSha256:manifest.resultManifestSha256,objectId:object.id,objectSha256:object.sha256,objectBytes:object.byteSize};
}
function schema(db) {
  const actual=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const reference=new DatabaseSync(':memory:');
  try {for(const sql of DDL)reference.exec(sql);const expected=reference.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();if(JSON.stringify(actual)!==JSON.stringify(expected))fail('REFERENCE_RESULT_JOURNAL_SCHEMA');}
  finally {reference.close();}
}
class ReferenceResultJournal {
  constructor({authority,maxBytes}={}) {
    checkAuthority(authority);
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1)fail('REFERENCE_RESULT_POLICY');
    this.authority=authority;this.maxBytes=maxBytes;
    const root=`/proc/self/fd/${authority.rootFd}`, filename=`${root}/.reference-result-journal.sqlite`;
    let created=false;
    for(const suffix of ['','-wal','-shm']) {try {const s=fs.lstatSync(filename+suffix,{bigint:true});if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n)fail('REFERENCE_RESULT_JOURNAL_PATH');}catch(e){if(e.code!=='ENOENT')throw e;}}
    try {const fd=fs.openSync(filename,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC,0o600);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.fsyncSync(authority.rootFd);created=true;}catch(e){if(e.code!=='EEXIST')throw e;}
    this.db=new DatabaseSync(filename);
    try {
      const existing=this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().n;
      if(existing===0){if(!created)fail('REFERENCE_RESULT_JOURNAL_SCHEMA');for(const sql of DDL)this.db.exec(sql);}
      schema(this.db);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      if(this.db.prepare('PRAGMA synchronous').get().synchronous!==2 || this.db.prepare('PRAGMA journal_mode').get().journal_mode!=='wal')fail('REFERENCE_RESULT_JOURNAL_DURABILITY');
      fs.fsyncSync(authority.rootFd);checkAuthority(authority);
    }catch(e){this.db.close();throw e;}
  }
  close(){this.db.close();}
  prepare({expected,manifest,objectId}){
    checkAuthority(this.authority);const value=binding(expected,manifest,objectId);if(value.objectBytes>this.maxBytes)fail('REFERENCE_RESULT_POLICY');
    const json=p.canonicalBytes(value).toString('utf8'),key=p.sha256(Buffer.from(json)),dev=String(this.authority.device),ino=String(this.authority.inode);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old=this.db.prepare('SELECT * FROM result_journal WHERE storage_key=? OR (job_id=? AND generation=? AND environment=? AND object_id=?)').all(key,value.jobId,value.generation,value.environment,value.objectId);
      if(old.length){if(old.length!==1||old[0].storage_key!==key||old[0].binding_json!==json||old[0].root_device!==dev||old[0].root_inode!==ino)fail('REFERENCE_RESULT_CONFLICT');}
      else this.db.prepare("INSERT INTO result_journal VALUES(?,?,?,?,?,?,?,?, 'pending')").run(key,value.jobId,value.generation,value.environment,value.objectId,json,dev,ino);
      checkAuthority(this.authority);this.db.exec('COMMIT');return {storageKey:key,binding:value};
    } catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  async retain({expected,manifest,objectId,source,signal}) {
    // This FULL-synchronous commit must precede any attempted file creation.
    const {storageKey,binding:value}=this.prepare({expected,manifest,objectId});
    const args={authority:this.authority,storageKey,expectedSha256:value.objectSha256,expectedBytes:value.objectBytes,maxBytes:this.maxBytes};
    let receipt;
    try {receipt=verifyRetainedReferenceResult(args);}
    catch(e){
      if(e.code!=='ENOENT')throw e;
      if(typeof source!=='function')fail('REFERENCE_RESULT_SOURCE_REQUIRED');
      try {await retainReferenceResult({...args,source:await source(),signal});}
      catch(err){if(err.code!=='EEXIST')throw err;}
      receipt=verifyRetainedReferenceResult(args);
    }
    // Verification is repeated before every replay; the external fence must
    // remain valid through this commit and subsequent acceptance.
    this.db.exec('BEGIN IMMEDIATE');
    try {checkAuthority(this.authority);const row=this.db.prepare('SELECT * FROM result_journal WHERE storage_key=?').get(storageKey);if(!row || row.binding_json!==p.canonicalBytes(value).toString('utf8') || row.root_device!==String(this.authority.device) || row.root_inode!==String(this.authority.inode))fail('REFERENCE_RESULT_CONFLICT');this.db.prepare("UPDATE result_journal SET state='ready' WHERE storage_key=? AND state='pending'").run(storageKey);checkAuthority(this.authority);this.db.exec('COMMIT');return {storageKey,binding:value,receipt};}catch(e){this.db.exec('ROLLBACK');throw e;}
  }
}
module.exports={ReferenceResultJournal,validateResultBinding:binding};
