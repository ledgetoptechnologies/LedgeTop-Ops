'use strict';
// Isolated test fixture only: no authentication, production DB or dispatcher.
const { DatabaseSync } = require('node:sqlite');
const fail = () => { throw Object.assign(new Error('synthetic intent refused'), { code: 'INTENT_REFUSED' }); };
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const id = x => typeof x === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(x);
function openFixture(path) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS intent (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS intent_no_update BEFORE UPDATE ON intent BEGIN SELECT RAISE(ABORT,'immutable intent'); END;
    CREATE TRIGGER IF NOT EXISTS intent_no_delete BEFORE DELETE ON intent BEGIN SELECT RAISE(ABORT,'immutable intent'); END;`);
  return {
    close: () => db.close(),
    inspect: key => { const row = db.prepare('SELECT payload FROM intent WHERE id=?').get(key); return row ? JSON.parse(row.payload) : null; },
    prepare(request, capability, resolveSynthetic) {
      if (!request || !capability || typeof resolveSynthetic !== 'function' ||
          !id(request.intentId) || !id(request.projectId) || !id(request.assetId) || !id(request.receiptId) ||
          !hash(request.sha256) || !hash(request.capabilityFingerprint) ||
          request.treedar !== true || request.gaussianSplat !== false ||
          capability.available !== true || capability.current !== true ||
          capability.fingerprint !== request.capabilityFingerprint) fail();
      const evidence = resolveSynthetic(request.projectId, request.assetId);
      if (!evidence || evidence.authenticated !== true || evidence.immutable !== true ||
          evidence.projectId !== request.projectId || evidence.assetId !== request.assetId ||
          evidence.receiptId !== request.receiptId || evidence.sha256 !== request.sha256 ||
          evidence.genuineSensorLidar !== true || evidence.photogrammetryDerived !== false) fail();
      const payload = JSON.stringify({ projectId: request.projectId, assetId: request.assetId,
        sha256: request.sha256, receiptId: request.receiptId, capabilityFingerprint: request.capabilityFingerprint,
        pipeline: { treedar: { requested: true }, gaussian_splat: { requested: false } } });
      db.exec('BEGIN IMMEDIATE');
      try {
        const old = db.prepare('SELECT payload FROM intent WHERE id=?').get(request.intentId);
        if (old && old.payload !== payload) fail();
        if (!old) db.prepare('INSERT INTO intent(id,payload) VALUES(?,?)').run(request.intentId, payload);
        db.exec('COMMIT');
        return JSON.parse(payload);
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
}
module.exports = { openFixture };
