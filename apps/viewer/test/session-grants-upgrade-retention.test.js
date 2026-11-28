'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { MIGRATIONS, applyMigrations } = require('../server/database');
const { ViewerRepository } = require('../server/repository');

// Exercise the shipped migrations only. No Marks fixtures or migration edits.
test('schema 90 to 92 retains every session_grants field and defaults restricted_redemption to zero', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  const all = [...MIGRATIONS];
  try {
    MIGRATIONS.splice(0, MIGRATIONS.length, ...all.filter(item => item.version <= 90));
    applyMigrations(db);
  } finally {
    MIGRATIONS.splice(0, MIGRATIONS.length, ...all);
  }
  assert.equal(db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v, 90);
  const at = '2026-01-01T00:00:00.000Z';
  db.prepare(`INSERT INTO models(id,provider,provider_model_id,display_name,status,created_at,updated_at)
    VALUES ('synthetic-model','local','synthetic-model','Synthetic model','ready',?,?)`).run(at, at);
  db.prepare(`INSERT INTO model_versions(id,model_id,provider_version_id,source_locator_json,status,created_at,updated_at)
    VALUES ('synthetic-version','synthetic-model','v1','{}','ready',?,?)`).run(at, at);
  const permissions = '{ "view":true, "measure":true, "cameras":false, "download":false }';
  const insert = db.prepare(`INSERT INTO session_grants(id,model_id,model_version_id,subject,audience,permissions_json,
    expires_at,redeemed_at,created_at,display_units,session_mode,source_authorization_type,source_authorization_id,source_authorization_version)
    VALUES (?,'synthetic-model','synthetic-version','client:synthetic','client',?,?,?,?,'metric','published','direct_client_grant','synthetic-grant',3)`);
  insert.run('pending', permissions, '2099-01-01T00:00:00.000Z', null, at);
  insert.run('redeemed', permissions, '2099-01-01T00:00:00.000Z', at, at);
  insert.run('expired', permissions, '2025-01-01T00:00:00.000Z', null, at);
  const before = db.prepare('SELECT * FROM session_grants ORDER BY id').all();
  const ledger = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  assert.equal(db.prepare('PRAGMA table_info(session_grants)').all().some(row => row.name === 'restricted_redemption'), false);
  applyMigrations(db);
  assert.equal(db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v, 93);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=90 ORDER BY version').all(), ledger);
  const after = db.prepare('SELECT * FROM session_grants ORDER BY id').all();
  assert.deepEqual(after.map(({ restricted_redemption, ...row }) => {
    assert.equal(restricted_redemption, 0);
    return Object.assign(Object.create(null), row);
  }), before);
  const column = db.prepare('PRAGMA table_info(session_grants)').all().find(row => row.name === 'restricted_redemption');
  assert.equal(column.type, 'INTEGER');
  assert.equal(column.notnull, 1);
  assert.equal(column.dflt_value, '0');
  insert.run('new-default', permissions, '2099-01-01T00:00:00.000Z', null, at);
  assert.equal(db.prepare("SELECT restricted_redemption FROM session_grants WHERE id='new-default'").get().restricted_redemption, 0);
  applyMigrations(db);
  assert.deepEqual(db.prepare('SELECT * FROM session_grants WHERE id<>? ORDER BY id').all('new-default'), after);
  const repo = new ViewerRepository(db);
  assert.equal(repo.redeemSessionGrant('pending', Date.parse(at)).permissions.view, true);
  assert.equal(repo.redeemSessionGrant('pending', Date.parse(at)), null);
  assert.equal(repo.redeemSessionGrant('redeemed', Date.parse(at)), null);
  assert.equal(repo.redeemSessionGrant('expired', Date.parse(at)), null);
  assert.equal(db.prepare("SELECT restricted_redemption FROM session_grants WHERE id='pending'").get().restricted_redemption, 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});
