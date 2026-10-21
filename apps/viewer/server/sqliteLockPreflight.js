'use strict';

const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function verifySqliteLocking(databasePath) {
  const first = new DatabaseSync(databasePath);
  const second = new DatabaseSync(databasePath);
  const key = `sqlite_lock_preflight_${crypto.randomUUID()}`;
  let busyObserved = false;
  let writeAfterRollback = false;
  try {
    first.exec('PRAGMA busy_timeout=1');
    second.exec('PRAGMA busy_timeout=1');
    first.exec('BEGIN IMMEDIATE');
    try {
      second.prepare('INSERT INTO app_state(key,value,updated_at) VALUES (?,?,?)').run(key, 'locked', new Date().toISOString());
    } catch (error) {
      busyObserved = /busy|locked/i.test(String(error?.message || error));
    } finally {
      first.exec('ROLLBACK');
    }
    if (!busyObserved) throw Object.assign(new Error('SQLite BEGIN IMMEDIATE did not fence a concurrent writer'), { code: 'sqlite_locking_unavailable' });
    const t = new Date().toISOString();
    second.prepare('INSERT INTO app_state(key,value,updated_at) VALUES (?,?,?)').run(key, 'released', t);
    writeAfterRollback = second.prepare('SELECT value FROM app_state WHERE key=?').get(key)?.value === 'released';
    second.prepare('DELETE FROM app_state WHERE key=?').run(key);
    if (!writeAfterRollback) throw Object.assign(new Error('SQLite writer did not recover after rollback'), { code: 'sqlite_locking_unavailable' });
    return { ok: true, busyObserved, writeAfterRollback };
  } finally {
    try { first.exec('ROLLBACK'); } catch {}
    try { second.prepare('DELETE FROM app_state WHERE key=?').run(key); } catch {}
    first.close();
    second.close();
  }
}

module.exports = { verifySqliteLocking };
