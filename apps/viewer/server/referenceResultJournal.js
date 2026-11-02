'use strict';

// Unmounted draft. The caller must already possess a verified exclusive root
// and writer fence. This journal never issues an acceptance or publishes a model.
const fs=require('node:fs');
const {DatabaseSync}=require('node:sqlite');
const p=require('./referenceProtocol');
const {checkAuthority,retainReferenceResultResumable,recoverLinkedReferenceResult,verifyRetainedReferenceResult}=require('./referenceResultSpool');
const fail=code=>{const e=new Error(code);e.code=code;throw e;};
const JOURNAL_DDL=[
  `CREATE TABLE result_journal (storage_key TEXT PRIMARY KEY NOT NULL, job_id TEXT NOT NULL, generation INTEGER NOT NULL, environment TEXT NOT NULL, object_id TEXT NOT NULL, binding_json TEXT NOT NULL, root_device TEXT NOT NULL, root_inode TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','ready')), UNIQUE(job_id,generation,environment,object_id))`,
  `CREATE TRIGGER result_journal_no_replace BEFORE INSERT ON result_journal WHEN EXISTS(SELECT 1 FROM result_journal WHERE storage_key=NEW.storage_key OR rowid=NEW.rowid OR (job_id=NEW.job_id AND generation=NEW.generation AND environment=NEW.environment AND object_id=NEW.object_id)) BEGIN SELECT RAISE(ABORT,'result journal replacement'); END`,
  `CREATE TRIGGER result_journal_no_delete BEFORE DELETE ON result_journal BEGIN SELECT RAISE(ABORT,'result journal retention'); END`,
  `CREATE TRIGGER result_journal_immutable BEFORE UPDATE ON result_journal WHEN NEW.rowid IS NOT OLD.rowid OR NEW.storage_key IS NOT OLD.storage_key OR NEW.job_id IS NOT OLD.job_id OR NEW.generation IS NOT OLD.generation OR NEW.environment IS NOT OLD.environment OR NEW.object_id IS NOT OLD.object_id OR NEW.binding_json IS NOT OLD.binding_json OR NEW.root_device IS NOT OLD.root_device OR NEW.root_inode IS NOT OLD.root_inode OR (OLD.state='ready' AND NEW.state<>'ready') BEGIN SELECT RAISE(ABORT,'result journal immutable'); END`
];
const TRANSFER_DDL=[
  `CREATE TABLE result_transfer_progress (storage_key TEXT PRIMARY KEY NOT NULL REFERENCES result_journal(storage_key), offset INTEGER NOT NULL CHECK(offset>=0), prefix_sha256 TEXT NOT NULL)`,
  `CREATE TRIGGER result_transfer_progress_no_delete BEFORE DELETE ON result_transfer_progress BEGIN SELECT RAISE(ABORT,'result progress retention'); END`,
  `CREATE TRIGGER result_transfer_progress_guard BEFORE UPDATE ON result_transfer_progress WHEN NEW.rowid IS NOT OLD.rowid OR NEW.storage_key IS NOT OLD.storage_key OR NEW.offset<OLD.offset OR (NEW.offset=OLD.offset AND NEW.prefix_sha256 IS NOT OLD.prefix_sha256) OR NOT EXISTS(SELECT 1 FROM result_journal WHERE storage_key=OLD.storage_key AND state='pending') BEGIN SELECT RAISE(ABORT,'result progress monotonicity'); END`
];
const DDL=[...JOURNAL_DDL,...TRANSFER_DDL];
function binding(expected,manifest,objectId) {
  if (!expected || !Number.isSafeInteger(expected.generation) || expected.generation<1 || !Array.isArray(expected.requestedEngines) || !expected.requestedEngines.includes('odm') || !/^[a-f0-9]{64}$/.test(expected.inputManifestSha256||'') || !/^[a-f0-9]{64}$/.test(expected.resultManifestSha256||'')) fail('REFERENCE_RESULT_BINDING');
  p.validateResultManifest(manifest,expected);
  if(manifest.resultManifestSha256!==expected.resultManifestSha256)fail('REFERENCE_RESULT_BINDING');
  const object=manifest.objects.find(x=>x.id===objectId);
  if(!object || object.role!=='odm_archive' || object.byteSize<1)fail('REFERENCE_RESULT_BINDING');
  return {jobId:manifest.jobId,generation:manifest.generation,environment:manifest.environment,inputManifestSha256:expected.inputManifestSha256,pipelineDigest:manifest.pipelineDigest,resultManifestSha256:manifest.resultManifestSha256,objectId:object.id,objectSha256:object.sha256,objectBytes:object.byteSize};
}
function schemaMatches(db,ddl) {
  const actual=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const reference=new DatabaseSync(':memory:');
  try {for(const sql of ddl)reference.exec(sql);const expected=reference.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();return JSON.stringify(actual)===JSON.stringify(expected);}
  finally {reference.close();}
}
function schema(db) {if(!schemaMatches(db,DDL))fail('REFERENCE_RESULT_JOURNAL_SCHEMA');}
function migrateLegacyJournal(db,authority) {
  if(!schemaMatches(db,JOURNAL_DDL))fail('REFERENCE_RESULT_JOURNAL_SCHEMA');
  db.exec('BEGIN IMMEDIATE');
  try {
    for(const sql of TRANSFER_DDL)db.exec(sql);
    const emptyDigest=p.sha256(Buffer.alloc(0));
    for(const row of db.prepare('SELECT storage_key FROM result_journal').all())db.prepare('INSERT INTO result_transfer_progress VALUES(?,?,?)').run(row.storage_key,0,emptyDigest);
    checkAuthority(authority);db.exec('COMMIT');fs.fsyncSync(authority.rootFd);checkAuthority(authority);
  } catch(error) {db.exec('ROLLBACK');throw error;}
}
class ReferenceResultJournal {
  constructor({authority,maxBytes,maxPendingBytes=maxBytes}={}) {
    checkAuthority(authority);
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isSafeInteger(maxPendingBytes)||maxPendingBytes<1)fail('REFERENCE_RESULT_POLICY');
    this.authority=authority;this.maxBytes=maxBytes;this.maxPendingBytes=maxPendingBytes;
    const root=`/proc/self/fd/${authority.rootFd}`, filename=`${root}/.reference-result-journal.sqlite`;
    let created=false;
    for(const suffix of ['','-wal','-shm']) {try {const s=fs.lstatSync(filename+suffix,{bigint:true});if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n)fail('REFERENCE_RESULT_JOURNAL_PATH');}catch(e){if(e.code!=='ENOENT')throw e;}}
    try {const fd=fs.openSync(filename,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC,0o600);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.fsyncSync(authority.rootFd);created=true;}catch(e){if(e.code!=='EEXIST')throw e;}
    this.db=new DatabaseSync(filename);
    try {
      const existing=this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().n;
      if(existing===0){if(!created)fail('REFERENCE_RESULT_JOURNAL_SCHEMA');for(const sql of DDL)this.db.exec(sql);}
      else if(!schemaMatches(this.db,DDL))migrateLegacyJournal(this.db,authority);
      schema(this.db);
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      if(this.db.prepare('PRAGMA foreign_keys').get().foreign_keys!==1 || this.db.prepare('PRAGMA synchronous').get().synchronous!==2 || this.db.prepare('PRAGMA journal_mode').get().journal_mode!=='wal')fail('REFERENCE_RESULT_JOURNAL_DURABILITY');
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
      else {
        const pending=this.db.prepare("SELECT binding_json FROM result_journal WHERE state='pending'").all();
        const used=pending.reduce((total,row)=>total+JSON.parse(row.binding_json).objectBytes,0);
        if(!Number.isSafeInteger(used+value.objectBytes)||used+value.objectBytes>this.maxPendingBytes)fail('REFERENCE_RESULT_POLICY');
        this.db.prepare("INSERT INTO result_journal VALUES(?,?,?,?,?,?,?,?, 'pending')").run(key,value.jobId,value.generation,value.environment,value.objectId,json,dev,ino);
      }
      this.db.prepare('INSERT OR IGNORE INTO result_transfer_progress VALUES(?,?,?)').run(key,0,p.sha256(Buffer.alloc(0)));
      checkAuthority(this.authority);this.db.exec('COMMIT');return {storageKey:key,binding:value};
    } catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  progress(storageKey){
    checkAuthority(this.authority);const row=this.db.prepare('SELECT p.offset,p.prefix_sha256,j.state,j.root_device,j.root_inode FROM result_transfer_progress p JOIN result_journal j USING(storage_key) WHERE p.storage_key=?').get(storageKey);
    if(!row||row.state!=='pending'||row.root_device!==String(this.authority.device)||row.root_inode!==String(this.authority.inode)||!Number.isSafeInteger(row.offset)||! /^[a-f0-9]{64}$/.test(row.prefix_sha256))fail('REFERENCE_RESULT_CONFLICT');
    return Object.freeze({offset:row.offset,prefixSha256:row.prefix_sha256});
  }
  commitProgress(storageKey,expectedOffset,offset,prefixSha256){
    checkAuthority(this.authority);if(!Number.isSafeInteger(expectedOffset)||!Number.isSafeInteger(offset)||offset<expectedOffset||! /^[a-f0-9]{64}$/.test(prefixSha256||''))fail('REFERENCE_RESULT_PROGRESS');
    this.db.exec('BEGIN IMMEDIATE');
    try {checkAuthority(this.authority);const row=this.db.prepare('SELECT j.binding_json FROM result_journal j WHERE j.storage_key=? AND j.state=\'pending\'').get(storageKey);if(!row)fail('REFERENCE_RESULT_PROGRESS');const binding=JSON.parse(row.binding_json);if(offset>binding.objectBytes)fail('REFERENCE_RESULT_PROGRESS');const old=this.progress(storageKey);if(old.offset!==expectedOffset)fail('REFERENCE_RESULT_PROGRESS');if(offset===expectedOffset){if(old.prefixSha256!==prefixSha256)fail('REFERENCE_RESULT_PROGRESS');}else this.db.prepare('UPDATE result_transfer_progress SET offset=?,prefix_sha256=? WHERE storage_key=? AND offset=?').run(offset,prefixSha256,storageKey,expectedOffset);checkAuthority(this.authority);this.db.exec('COMMIT');}
    catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  async retain({expected,manifest,objectId,source,signal}) {
    // This FULL-synchronous commit must precede any attempted file creation.
    const {storageKey,binding:value}=this.prepare({expected,manifest,objectId});
    const args={authority:this.authority,storageKey,expectedSha256:value.objectSha256,expectedBytes:value.objectBytes,maxBytes:this.maxBytes};
    recoverLinkedReferenceResult(args);
    let receipt;
    try {receipt=verifyRetainedReferenceResult(args);}
    catch(e){
      if(e.code!=='ENOENT')throw e;
      if(typeof source!=='function')fail('REFERENCE_RESULT_SOURCE_REQUIRED');
      const progress={load:()=>this.progress(storageKey),commit:(from,to,digest)=>this.commitProgress(storageKey,from,to,digest)};
      try {await retainReferenceResultResumable({...args,progress,source:offset=>source(offset),signal});}
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
