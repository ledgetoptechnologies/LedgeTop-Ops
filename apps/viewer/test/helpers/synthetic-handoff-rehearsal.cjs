'use strict';
// Test-only: caller supplies a disposable SQLite connection and fake authority.
// This module never opens files, performs network I/O, or grants real authority.
const { createHash } = require('node:crypto');
const digest = b => createHash('sha256').update(b).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const id = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(x);
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
function createSyntheticHandoff(db, { failpoint = () => {} } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS synthetic_handoff (
    operation_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, generation INTEGER NOT NULL,
    manifest_sha256 TEXT NOT NULL, request BLOB NOT NULL, request_sha256 TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('prepared','outcome_unknown','observed_committed')),
    receipt TEXT
  )`);
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } };
  const get = op => db.prepare('SELECT * FROM synthetic_handoff WHERE operation_id=?').get(op);
  function prepare(input) {
    if (!input || Object.keys(input).sort().join(',') !== 'attemptId,generation,manifestSha256,operationId,request' || !id(input.operationId) || !id(input.attemptId) || !Number.isSafeInteger(input.generation) || input.generation < 1 || !hash(input.manifestSha256) || !Buffer.isBuffer(input.request) || input.request.length < 1 || input.request.length > 65536) fail('INVALID_INTENT');
    const request = Buffer.from(input.request), sha = digest(request);
    return tx(() => {
      const row = get(input.operationId);
      if (row) {
        if (row.attempt_id !== input.attemptId || row.generation !== input.generation || row.manifest_sha256 !== input.manifestSha256 || row.request_sha256 !== sha || !Buffer.from(row.request).equals(request)) fail('INTENT_CONFLICT');
        return { state: row.state, replay: true };
      }
      db.prepare('INSERT INTO synthetic_handoff VALUES(?,?,?,?,?,?,?,NULL)').run(input.operationId,input.attemptId,input.generation,input.manifestSha256,request,sha,'prepared');
      failpoint('before_intent_commit');
      return { state:'prepared', replay:false };
    });
  }
  function observe(op, response) {
    return tx(() => {
      const row = get(op); if (!row || row.state !== 'outcome_unknown') fail('NOT_RECONCILABLE');
      if (!response || response.status !== 'committed' || response.operationId !== op || response.requestSha256 !== row.request_sha256 || !id(response.receiptId) || Object.keys(response).sort().join(',') !== 'operationId,receiptId,requestSha256,status') return {state:'outcome_unknown'};
      db.prepare("UPDATE synthetic_handoff SET state='observed_committed', receipt=? WHERE operation_id=? AND state='outcome_unknown'").run(JSON.stringify(response),op);
      failpoint('before_observation_commit');
      return {state:'observed_committed'};
    });
  }
  function sendOnce(op, authority) {
    const row = tx(() => {
      const current = get(op); if (!current || current.state !== 'prepared') fail('HELD_REQUIRES_RECONCILIATION');
      db.prepare("UPDATE synthetic_handoff SET state='outcome_unknown' WHERE operation_id=? AND state='prepared'").run(op);
      return current;
    });
    // A crash here leaves the operation held even if nothing was sent.
    failpoint('after_unknown_commit');
    let response; try { response = authority.send({operationId:op, request:Buffer.from(row.request), requestSha256:row.request_sha256}); } catch { return {state:'outcome_unknown'}; }
    failpoint('after_fake_send');
    return observe(op,response);
  }
  function reconcile(op, authority) {
    const row = get(op); if (!row || row.state !== 'outcome_unknown') fail('NOT_RECONCILABLE');
    let result; try { result = authority.lookup({operationId:op, requestSha256:row.request_sha256}); } catch { return {state:'outcome_unknown'}; }
    return observe(op,result);
  }
  return {prepare, sendOnce, reconcile, get};
}
module.exports = { createSyntheticHandoff };
