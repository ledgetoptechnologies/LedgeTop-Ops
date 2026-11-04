'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { MIGRATIONS, applyMigrations } = require('../server/database');

function ledgerThrough40() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const migration of MIGRATIONS.filter(m => m.version <= 40)) {
    db.exec(migration.sql);
    migration.after?.(db);
    db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(migration.version, migration.name, 'test');
  }
  return db;
}

test('upgrades a v40 ledger and accepts the resulting identities on restart', () => {
  const db = ledgerThrough40();
  try {
    applyMigrations(db);
    applyMigrations(db);
    assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version=41').get().name, 'gcp_odm_crs_confirmations');
    assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version=71').get().name, 'durable_provider_cancellation_requests');
  } finally { db.close(); }
});

test('accepts an existing matching GCP v41 and finishes the upgrade', () => {
  const db = ledgerThrough40();
  try {
    const migration = MIGRATIONS.find(m => m.version === 41);
    db.exec(migration.sql);
    db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(41, migration.name, 'test');
    applyMigrations(db);
    assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version=71').get().name, 'durable_provider_cancellation_requests');
  } finally { db.close(); }
});

test('rejects a cancellation v41 without modifying the prior database', () => {
  const db = ledgerThrough40();
  try {
    const cancellation = MIGRATIONS.find(m => m.version === 71);
    db.exec(cancellation.sql);
    db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(41, cancellation.name, 'test');
    assert.throws(() => applyMigrations(db), e => e.code === 'schema_migration_identity_mismatch' && /41.*durable_provider_cancellation_requests.*gcp_odm_crs_confirmations/.test(e.message));
    assert.equal(db.prepare('SELECT MAX(version) AS max FROM schema_migrations').get().max, 41);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='gcp_odm_crs_confirmations'").get().n, 0);
  } finally { db.close(); }
});
