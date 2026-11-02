'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { applyMigrations } = require('../server/database');
const p = require('../server/referenceProtocol');
const { ReferenceTransferGrantVault, deriveReferenceTransferGrantKey } = require('../server/referenceTransferGrantVault');

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); applyMigrations(db);
  db.exec('PRAGMA foreign_keys=OFF');
  const sha = value => 'a'.repeat(64);
  db.prepare(`INSERT INTO viewer_reference_transfer_outbox
    (outbox_id,attempt_id,job_id,generation,environment,reservation_id,reservation_generation,reservation_nonce_sha256,reservation_expires_at,reservation_byte_budget,manifest_sha256,grant_id,grant_identity_sha256,grant_sha256,state,send_attempts,sender_generation,acknowledgement_sha256,created_at,updated_at)
    VALUES('outbox','attempt','job',1,'staging','reservation',1,?,'2026-12-01T00:00:00.000Z',1,?,'grant',? ,?,'prepared',0,0,NULL,'t','t')`)
    .run(sha(), sha(), sha(), sha());
  const grant = { protocol:'source-range-v2', jobId:'job', token:'secret-grant-token-value', environment:'staging' };
  db.prepare('INSERT INTO viewer_reference_transfer_grant_bindings(outbox_id,canonical_grant_sha256,created_at) VALUES(?,?,?)')
    .run('outbox', p.sha256(p.canonicalBytes(grant)), 't');
  const key = deriveReferenceTransferGrantKey('a stable session secret with enough entropy 0123456789');
  return { db, grant, key, vault: new ReferenceTransferGrantVault(db, { key }) };
}

test('encrypted v2 grant survives reopen and clears only after durable acknowledgement', t => {
  const f = fixture(t);
  f.vault.put('outbox', f.grant);
  const row = f.db.prepare('SELECT ciphertext,iv,auth_tag,state FROM viewer_reference_transfer_grant_vault WHERE outbox_id=?').get('outbox');
  assert.equal(row.state, 'active');
  assert.equal(row.ciphertext.includes(Buffer.from(f.grant.token)), false);
  assert.deepEqual(f.vault.load('outbox'), f.grant);
  assert.throws(() => f.vault.clearAfterAcknowledgement('outbox'), { code:'reference_transfer_vault_ack_required' });
  f.db.exec("UPDATE viewer_reference_transfer_outbox SET state='sending',send_attempts=1,sender_generation=1 WHERE outbox_id='outbox'");
  f.db.exec(`UPDATE viewer_reference_transfer_outbox SET state='acknowledged',acknowledgement_sha256='${'b'.repeat(64)}' WHERE outbox_id='outbox'`);
  assert.equal(f.vault.clearAfterAcknowledgement('outbox'), true);
  assert.equal(f.vault.clearAfterAcknowledgement('outbox'), false);
  assert.equal(f.db.prepare('SELECT ciphertext,state FROM viewer_reference_transfer_grant_vault WHERE outbox_id=?').get('outbox').ciphertext, null);
  assert.throws(() => f.vault.load('outbox'), { code:'reference_transfer_vault_unavailable' });
});

test('grant vault authenticates ciphertext and uses an explicit stable key', t => {
  const f = fixture(t); f.vault.put('outbox', f.grant);
  const altered = Buffer.from(f.db.prepare('SELECT auth_tag FROM viewer_reference_transfer_grant_vault WHERE outbox_id=?').get('outbox').auth_tag);
  altered[0] ^= 1;
  f.db.exec('DROP TRIGGER viewer_reference_transfer_grant_vault_transition');
  f.db.prepare('UPDATE viewer_reference_transfer_grant_vault SET auth_tag=? WHERE outbox_id=?').run(altered,'outbox');
  assert.throws(() => f.vault.load('outbox'), { code:'reference_transfer_vault_corrupt' });
  const otherKey = deriveReferenceTransferGrantKey('another stable session secret with enough entropy 0123456789');
  assert.throws(() => new ReferenceTransferGrantVault(f.db, { key: Buffer.alloc(31) }), { code:'reference_transfer_vault_unavailable' });
  assert.notDeepEqual(otherKey, f.key);
  assert.throws(() => new ReferenceTransferGrantVault(f.db, { key: otherKey }).load('outbox'), { code:'reference_transfer_vault_corrupt' });
});
