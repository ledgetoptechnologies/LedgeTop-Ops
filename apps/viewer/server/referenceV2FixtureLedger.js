'use strict';

// Isolated fixture only: no authentication, migration, routes, or live broker.
// Do not use with production databases. Authority and process fencing are open.
const FIXTURE_SCOPE = 'synthetic-fixture-only';
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value, 'base64url').length === 32
  && Buffer.from(value, 'base64url').toString('base64url') === value;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const fail = code => { const e = new Error(code); e.code = code; throw e; };

function createFixtureLedger(db, scope) {
  if (scope !== FIXTURE_SCOPE) fail('fixture_scope_required');
  db.exec('PRAGMA busy_timeout=5000');
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  // Explicitly separate fixture tables; this is not a production migration.
  db.exec(`CREATE TABLE IF NOT EXISTS v2_fixture_jobs (
    job_id TEXT PRIMARY KEY, manifest_hash TEXT NOT NULL, byte_limit INTEGER NOT NULL,
    request_limit INTEGER NOT NULL, charged_bytes INTEGER NOT NULL DEFAULT 0,
    deliveries INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS v2_fixture_requests (
    request_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, request_hash TEXT NOT NULL, response_bytes INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS v2_fixture_deliveries (
    delivery_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, job_id TEXT NOT NULL,
    charged_bytes INTEGER NOT NULL, state TEXT NOT NULL
  );`);

  function provision({ jobId, manifestHash, byteLimit, requestLimit }) {
    if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId)
      || !digest(manifestHash) || !integer(byteLimit) || !integer(requestLimit)) fail('invalid_input');
    return transaction(() => {
      const job = db.prepare('SELECT * FROM v2_fixture_jobs WHERE job_id=?').get(jobId);
      if (job) {
        if (job.manifest_hash !== manifestHash || job.byte_limit !== byteLimit || job.request_limit !== requestLimit) fail('job_conflict');
        return;
      }
      db.prepare('INSERT INTO v2_fixture_jobs(job_id,manifest_hash,byte_limit,request_limit) VALUES(?,?,?,?)')
        .run(jobId, manifestHash, byteLimit, requestLimit);
    });
  }

  function admit({ jobId, manifestHash, requestId, requestHash, deliveryId, responseBytes }) {
    if (typeof jobId !== 'string' || !digest(manifestHash) || !identifier(requestId)
      || !identifier(deliveryId) || !digest(requestHash) || !integer(responseBytes)) fail('invalid_input');
    return transaction(() => {
      const job = db.prepare('SELECT * FROM v2_fixture_jobs WHERE job_id=?').get(jobId);
      if (!job || job.manifest_hash !== manifestHash) fail('job_conflict');
      const request = db.prepare('SELECT * FROM v2_fixture_requests WHERE request_id=?').get(requestId);
      if (request && (request.job_id !== jobId || request.request_hash !== requestHash || request.response_bytes !== responseBytes)) fail('request_conflict');
      const delivery = db.prepare('SELECT * FROM v2_fixture_deliveries WHERE delivery_id=?').get(deliveryId);
      if (delivery) {
        if (delivery.request_id !== requestId || delivery.job_id !== jobId || delivery.charged_bytes !== responseBytes) fail('delivery_conflict');
        fail('delivery_already_admitted');
      }
      if (db.prepare("SELECT 1 FROM v2_fixture_deliveries WHERE request_id=? AND state='active'").get(requestId)) fail('fence_required');
      if (responseBytes > job.byte_limit - job.charged_bytes) fail('byte_limit');
      if (job.deliveries >= job.request_limit) fail('request_limit');
      if (!request) db.prepare('INSERT INTO v2_fixture_requests VALUES(?,?,?,?)').run(requestId, jobId, requestHash, responseBytes);
      db.prepare("INSERT INTO v2_fixture_deliveries VALUES(?,?,?,?, 'active')").run(deliveryId, requestId, jobId, responseBytes);
      db.prepare('UPDATE v2_fixture_jobs SET charged_bytes=charged_bytes+?, deliveries=deliveries+1, revision=revision+1 WHERE job_id=?').run(responseBytes, jobId);
      return { chargedBytes: responseBytes };
    });
  }

  // Fixture assertion only. Real terminal transitions require a qualified fence.
  function fixtureProveStopped(deliveryId) {
    if (!identifier(deliveryId)) fail('invalid_input');
    return transaction(() => {
      const row = db.prepare("SELECT job_id FROM v2_fixture_deliveries WHERE delivery_id=? AND state='active'").get(deliveryId);
      if (!row) fail('not_active');
      db.prepare("UPDATE v2_fixture_deliveries SET state='stopped' WHERE delivery_id=?").run(deliveryId);
      db.prepare('UPDATE v2_fixture_jobs SET revision=revision+1 WHERE job_id=?').run(row.job_id);
    });
  }

  // No authoritative absence or authenticated public reconciliation in this fixture.
  function fixtureRead(deliveryId) {
    if (!identifier(deliveryId)) fail('invalid_input');
    const row = db.prepare('SELECT * FROM v2_fixture_deliveries WHERE delivery_id=?').get(deliveryId);
    return row ? { outcome: 'recorded', state: row.state, chargedBytes: row.charged_bytes } : { outcome: 'unknown' };
  }
  return { provision, admit, fixtureProveStopped, fixtureRead };
}

module.exports = { createFixtureLedger, FIXTURE_SCOPE };
