'use strict';
// Disposable fixture, not a broker, authentication system, or migration.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fail = () => { throw Object.assign(new Error('fixture rejected'), {code:'FIXTURE_REJECTED'}); };
const closed = (x, keys) => x && typeof x==='object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === [...keys].sort().join(',');
const id = x => typeof x==='string' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(x);
const hash = x => typeof x==='string' && /^[a-f0-9]{64}$/.test(x);
const positive = x => Number.isSafeInteger(x) && x>0;
function validateReservation(r) {
  if (!closed(r,['version','environment','jobId','manifestSha256','generation','reservationId','policy']) || r.version!==2 || !['staging','production'].includes(r.environment) || !id(r.jobId) || !hash(r.manifestSha256) || !positive(r.generation) || !id(r.reservationId) || !closed(r.policy,['version','chunkBytes','requestBudget','byteBudget']) || r.policy.version!==1 || !positive(r.policy.chunkBytes) || !positive(r.policy.requestBudget) || !positive(r.policy.byteBudget)) fail();
}
function validateGrant(g,r) {
  validateReservation(r);
  if (!closed(g,['version','environment','jobId','manifestSha256','generation','reservationId','grantId','policy']) || !id(g.grantId)) fail();
  for (const k of ['version','environment','jobId','manifestSha256','generation','reservationId']) if (g[k]!==r[k]) fail();
  if (!closed(g.policy,['version','chunkBytes','requestBudget','byteBudget']) || Object.keys(r.policy).some(k=>g.policy[k]!==r.policy[k])) fail();
}
function mac(key,e) { return crypto.createHmac('sha256',key).update(JSON.stringify(e)).digest('hex'); }
function openFixture(file,key) {
  const db=new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS jobs(identity TEXT PRIMARY KEY,policy TEXT NOT NULL,requests INTEGER NOT NULL DEFAULT 0,bytes INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS ranges(identity TEXT NOT NULL,object_id TEXT NOT NULL,start INTEGER NOT NULL,length INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(identity,object_id,start));`);
  const identity=r=>JSON.stringify([r.environment,r.jobId,r.manifestSha256]);
  return {
    close:()=>db.close(),
    charge(r,g,objectId,start,length) {
      validateGrant(g,r);if (!id(objectId) || !Number.isSafeInteger(start) || start<0 || !positive(length) || length>r.policy.chunkBytes || !Number.isSafeInteger(start+length)) fail();
      const keyId=identity(r),policy=JSON.stringify(Object.fromEntries(Object.keys(r.policy).sort().map(k=>[k,r.policy[k]])));
      db.exec('BEGIN IMMEDIATE');try {
        const job=db.prepare('SELECT * FROM jobs WHERE identity=?').get(keyId);
        if (job && job.policy!==policy) fail();
        if (!job) db.prepare('INSERT INTO jobs(identity,policy) VALUES(?,?)').run(keyId,policy);
        const current=db.prepare('SELECT * FROM jobs WHERE identity=?').get(keyId);
        if (current.requests>=r.policy.requestBudget || length>r.policy.byteBudget-current.bytes || db.prepare('SELECT 1 FROM ranges WHERE identity=? AND object_id=? AND start < ? AND start+length > ?').get(keyId,objectId,start+length,start)) fail();
        db.prepare('UPDATE jobs SET requests=requests+1,bytes=bytes+? WHERE identity=?').run(length,keyId);
        db.prepare("INSERT INTO ranges VALUES(?,?,?,?,'uncertain')").run(keyId,objectId,start,length);
        db.exec('COMMIT');return 'charged';
      } catch(e) { db.exec('ROLLBACK'); throw e; }
    },
    verify(r,objectId,start,bytes,proof) {
      validateReservation(r); const keyId=identity(r), row=db.prepare('SELECT * FROM ranges WHERE identity=? AND object_id=? AND start=?').get(keyId,objectId,start);
      if (!row || row.state!=='uncertain' || !Buffer.isBuffer(bytes) || bytes.length!==row.length || !hash(proof)) fail();
      const evidence={identity:keyId,objectId,start,length:row.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
      const expected=mac(key,evidence);if(!crypto.timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(proof,'hex'))) fail();
      db.prepare("UPDATE ranges SET state='verified' WHERE identity=? AND object_id=? AND start=? AND state='uncertain'").run(keyId,objectId,start);
    },
    status(r,objectId,start) { validateReservation(r); return db.prepare('SELECT state,length FROM ranges WHERE identity=? AND object_id=? AND start=?').get(identity(r),objectId,start) || null; },
    usage(r) { validateReservation(r); return db.prepare('SELECT requests,bytes FROM jobs WHERE identity=?').get(identity(r)) || null; }
  };
}
module.exports={openFixture,validateReservation,validateGrant,mac};
