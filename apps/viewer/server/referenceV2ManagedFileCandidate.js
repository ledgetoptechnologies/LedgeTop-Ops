'use strict';
// Disabled, single-file experiment. The SQLite BLOB is a retained copy, not a
// fence on the original file or a production custody/authorization guarantee.
const fs=require('node:fs');
const crypto=require('node:crypto');
const {createSyntheticReservation,SCOPE}=require('./referenceV2ReservationFixture');
const fail=code=>{throw Object.assign(new Error(code),{code})};
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&a.nlink===b.nlink;
const slug=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v)&&v!=='.'&&v!=='..';
const MAX_BYTES=1048576;

function createManagedFileExperiment({database,rootFd,scope,afterCopy}={}){
  if(process.platform!=='linux'||scope!=='isolated-managed-file-experiment'||!database||!Number.isSafeInteger(rootFd)||rootFd<0)fail('experiment_unavailable');
  const root=fs.fstatSync(rootFd,{bigint:true});if(!root.isDirectory())fail('experiment_unavailable');
  const store=createSyntheticReservation(database,SCOPE);
  database.exec(`CREATE TABLE IF NOT EXISTS v2m_binding (slot INTEGER PRIMARY KEY CHECK(slot=1), root_dev TEXT NOT NULL, root_ino TEXT NOT NULL, name TEXT NOT NULL, source_id TEXT NOT NULL, revision TEXT NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS v2m_no_update BEFORE UPDATE ON v2m_binding BEGIN SELECT RAISE(ABORT,'binding immutable'); END;
    CREATE TRIGGER IF NOT EXISTS v2m_no_delete BEFORE DELETE ON v2m_binding BEGIN SELECT RAISE(ABORT,'binding immutable'); END;
    CREATE TRIGGER IF NOT EXISTS v2m_no_replace BEFORE INSERT ON v2m_binding WHEN EXISTS(SELECT 1 FROM v2m_binding) BEGIN SELECT RAISE(ABORT,'binding immutable'); END;`);
  function rootCurrent(){const now=fs.fstatSync(rootFd,{bigint:true});if(!now.isDirectory()||now.dev!==root.dev||now.ino!==root.ino)fail('source_changed');}
  function snapshot(name,input){
    if(!slug(name)||!Number.isSafeInteger(input.sourceBytes)||input.sourceBytes<0||input.sourceBytes>MAX_BYTES)fail('source_invalid');
    rootCurrent();const target=`/proc/self/fd/${rootFd}/${name}`;let fd;
    try{
      fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK|fs.constants.O_CLOEXEC);
      const before=fs.fstatSync(fd,{bigint:true});if(!before.isFile()||before.nlink!==1n||before.size!==BigInt(input.sourceBytes))fail('source_changed');
      const bytes=Buffer.alloc(input.sourceBytes);let offset=0;while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(n<=0)fail('source_changed');offset+=n;}
      const after=fs.fstatSync(fd,{bigint:true}),named=fs.lstatSync(target,{bigint:true});rootCurrent();
      if(!same(before,after)||!same(after,named)||!named.isFile()||named.isSymbolicLink()||crypto.createHash('sha256').update(bytes).digest('hex')!==input.sourceSha256)fail('source_changed');
      return bytes;
    }finally{if(fd!==undefined)fs.closeSync(fd)}
  }
  // The retained copy is installed first. A crash here leaves an uncharged,
  // unreserved copy; no automatic cleanup or release is allowed.
  function reserveFixture(name,input){
    if(!input||!slug(name)||!slug(input.sourceId)||!slug(input.sourceRevision)||!/^[a-f0-9]{64}$/.test(input.sourceSha256||'')||!Number.isSafeInteger(input.sourceBytes)||input.sourceBytes<0||input.sourceBytes>MAX_BYTES)fail('source_invalid');
    rootCurrent();
    const binding=[String(root.dev),String(root.ino),name,input.sourceId,input.sourceRevision,input.sourceSha256,input.sourceBytes];
    database.exec('BEGIN IMMEDIATE');try{
      const existing=database.prepare('SELECT root_dev,root_ino,name,source_id,revision,digest,bytes FROM v2m_binding WHERE slot=1').get();
      if(existing){if(JSON.stringify(Object.values(existing))!==JSON.stringify(binding))fail('source_binding_conflict');}
      else database.prepare('INSERT INTO v2m_binding VALUES(1,?,?,?,?,?,?,?)').run(...binding);
      database.exec('COMMIT');
    }catch(error){database.exec('ROLLBACK');throw error}
    const existing=database.prepare('SELECT 1 FROM v2s_sources WHERE id=?').get(input.sourceId);
    if(!existing){store.addSource({sourceId:input.sourceId,revision:input.sourceRevision,bytes:snapshot(name,input)});if(afterCopy)afterCopy();}
    return store.reserve(input);
  }
  function issue(){fail('v2_reservation_not_qualified')}
  return Object.freeze({provisionQuota:store.provisionQuota,reserveFixture,signFixture:store.signCommitted,issue});
}
module.exports={createManagedFileExperiment,MAX_BYTES};
