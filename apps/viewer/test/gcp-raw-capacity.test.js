'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {assertRawJournalCapacity}=require('../server/gcpRawCapacity');

function fixture(t){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE viewer_gcp_raw_sources(status TEXT,source_bytes BLOB)');t.after(()=>db.close());return db;}
test('quota counts pending and ready bytes and entries without discarding rows',t=>{
  const db=fixture(t);db.prepare('INSERT INTO viewer_gcp_raw_sources VALUES (?,?)').run('pending',Buffer.from('abc'));db.prepare('INSERT INTO viewer_gcp_raw_sources VALUES (?,?)').run('ready',Buffer.from('de'));
  db.exec('BEGIN IMMEDIATE');try{
    assert.doesNotThrow(()=>assertRawJournalCapacity(db,{maxJournalBytes:6,maxJournalEntries:3},1));
    assert.throws(()=>assertRawJournalCapacity(db,{maxJournalBytes:5,maxJournalEntries:3},1),{code:'gcp_capacity_exceeded'});
    assert.throws(()=>assertRawJournalCapacity(db,{maxJournalBytes:9,maxJournalEntries:2},1),{code:'gcp_capacity_exceeded'});
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM viewer_gcp_raw_sources').get().n,2);
  } finally {db.exec('ROLLBACK');}
});
test('unknown policy, missing table and missing transaction fail closed',t=>{
  const db=fixture(t),policy={maxJournalBytes:10,maxJournalEntries:1};
  assert.throws(()=>assertRawJournalCapacity(db,policy,1),{code:'gcp_capacity_unavailable'});
  db.exec('BEGIN IMMEDIATE');try{
    for(const invalid of [null,{}, {maxJournalBytes:Infinity,maxJournalEntries:1},{maxJournalBytes:10,maxJournalEntries:0}]) assert.throws(()=>assertRawJournalCapacity(db,invalid,1),{code:'gcp_capacity_unavailable'});
    assert.throws(()=>assertRawJournalCapacity(db,policy,0),{code:'gcp_capacity_unavailable'});
    db.exec('DROP TABLE viewer_gcp_raw_sources');assert.throws(()=>assertRawJournalCapacity(db,policy,1),{code:'gcp_capacity_unavailable'});
  } finally {db.exec('ROLLBACK');}
});
test('malformed stored source cannot be silently omitted from accounting',t=>{
  const db=fixture(t);db.exec('BEGIN IMMEDIATE');try{
    db.prepare('INSERT INTO viewer_gcp_raw_sources VALUES (?,?)').run('pending',null);
    assert.throws(()=>assertRawJournalCapacity(db,{maxJournalBytes:10,maxJournalEntries:2},1),{code:'gcp_capacity_unavailable'});
  } finally {db.exec('ROLLBACK');}
});
test('two independent connections cannot both admit the last slot under BEGIN IMMEDIATE',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gcp-capacity-')),filename=path.join(dir,'journal.sqlite');
  const first=new DatabaseSync(filename),second=new DatabaseSync(filename);
  t.after(()=>{first.close();second.close();for(const suffix of ['', '-wal', '-shm', '-journal']){const file=filename+suffix;if(fs.existsSync(file))fs.unlinkSync(file);}fs.rmdirSync(dir);});
  first.exec('PRAGMA journal_mode=WAL; CREATE TABLE viewer_gcp_raw_sources(status TEXT,source_bytes BLOB)');
  second.exec('PRAGMA busy_timeout=0');
  const policy={maxJournalBytes:1,maxJournalEntries:1};
  first.exec('BEGIN IMMEDIATE');
  assert.doesNotThrow(()=>assertRawJournalCapacity(first,policy,1));
  assert.throws(()=>second.exec('BEGIN IMMEDIATE'),/locked|busy/i);
  first.prepare('INSERT INTO viewer_gcp_raw_sources VALUES (?,?)').run('pending',Buffer.from('a'));
  first.exec('COMMIT');
  second.exec('BEGIN IMMEDIATE');
  try {assert.throws(()=>assertRawJournalCapacity(second,policy,1),{code:'gcp_capacity_exceeded'});}
  finally {second.exec('ROLLBACK');}
  assert.equal(first.prepare('SELECT COUNT(*) AS n FROM viewer_gcp_raw_sources').get().n,1);
});
