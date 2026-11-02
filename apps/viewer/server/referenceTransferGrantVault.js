'use strict';

// Short-lived bearer payloads needed to replay an ambiguous grant POST are
// encrypted at rest. Call put() inside the same SQLite transaction that
// prepares its outbox row. The configured grant secret is used only to derive
// an in-memory key and is never stored in the database.
const crypto = require('node:crypto');
const p = require('./referenceProtocol');

const fail = code => { throw Object.assign(new Error(code), { code }); };
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;

function deriveReferenceTransferGrantKey(grantSecret) {
  if (typeof grantSecret !== 'string' || Buffer.byteLength(grantSecret) < 32) fail('reference_transfer_vault_key_unavailable');
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(grantSecret, 'utf8'), Buffer.from('ledgetop-viewer-reference-v1'), Buffer.from('source-range-grant-outbox-aes-256-gcm'), 32));
}

class ReferenceTransferGrantVault {
  constructor(db, { key } = {}) {
    if (!db || typeof db.prepare !== 'function' || !Buffer.isBuffer(key) || key.length !== 32) fail('reference_transfer_vault_unavailable');
    this.db = db;
    this.key = Buffer.from(key);
  }

  put(outboxId, grant) {
    if (typeof outboxId !== 'string' || !ID.test(outboxId) || !grant || typeof grant !== 'object' || Array.isArray(grant)) fail('reference_transfer_vault_invalid');
    let plaintext;
    try { plaintext = Buffer.from(JSON.stringify(grant), 'utf8'); } catch { fail('reference_transfer_vault_invalid'); }
    if (plaintext.length > p.LIMITS.metadataBytes) fail('reference_transfer_vault_invalid');
    const grantSha256 = p.sha256(p.canonicalBytes(grant));
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${outboxId}:${grantSha256}`));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]), authTag = cipher.getAuthTag();
    const createdAt = new Date().toISOString();
    this.db.prepare("INSERT INTO viewer_reference_transfer_grant_vault(outbox_id,ciphertext,iv,auth_tag,state,created_at,cleared_at) VALUES(?,?,?,?,'active',?,NULL)")
      .run(outboxId, ciphertext, iv, authTag, createdAt);
    return { grantSha256 };
  }

  load(outboxId) {
    if (typeof outboxId !== 'string' || !ID.test(outboxId)) fail('reference_transfer_vault_invalid');
    const row = this.db.prepare(`SELECT v.ciphertext,v.iv,v.auth_tag,v.state,b.canonical_grant_sha256
      FROM viewer_reference_transfer_grant_vault v
      JOIN viewer_reference_transfer_grant_bindings b ON b.outbox_id=v.outbox_id
      WHERE v.outbox_id=?`).get(outboxId);
    if (!row || row.state !== 'active' || !ArrayBuffer.isView(row.ciphertext) || !ArrayBuffer.isView(row.iv) || !ArrayBuffer.isView(row.auth_tag) || !HASH.test(row.canonical_grant_sha256)) fail('reference_transfer_vault_unavailable');
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.iv));
      decipher.setAAD(Buffer.from(`${outboxId}:${row.canonical_grant_sha256}`));
      decipher.setAuthTag(Buffer.from(row.auth_tag));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()]);
      if (plaintext.length > p.LIMITS.metadataBytes) fail('reference_transfer_vault_corrupt');
      const grant = JSON.parse(plaintext.toString('utf8'));
      if (!grant || typeof grant !== 'object' || Array.isArray(grant) || p.sha256(p.canonicalBytes(grant)) !== row.canonical_grant_sha256) fail('reference_transfer_vault_corrupt');
      return grant;
    } catch (error) {
      if (error?.code === 'reference_transfer_vault_corrupt') throw error;
      fail('reference_transfer_vault_corrupt');
    }
  }

  clearAfterAcknowledgement(outboxId) {
    if (typeof outboxId !== 'string' || !ID.test(outboxId)) fail('reference_transfer_vault_invalid');
    const row = this.db.prepare('SELECT state FROM viewer_reference_transfer_grant_vault WHERE outbox_id=?').get(outboxId);
    if (!row || row.state === 'cleared') return false;
    const result = this.db.prepare(`UPDATE viewer_reference_transfer_grant_vault
      SET ciphertext=NULL,iv=NULL,auth_tag=NULL,state='cleared',cleared_at=? WHERE outbox_id=? AND state='active'
      AND EXISTS(SELECT 1 FROM viewer_reference_transfer_outbox WHERE outbox_id=? AND state='acknowledged')`)
      .run(new Date().toISOString(), outboxId, outboxId);
    if (result.changes !== 1) fail('reference_transfer_vault_ack_required');
    return true;
  }
}

module.exports = { ReferenceTransferGrantVault, deriveReferenceTransferGrantKey };
