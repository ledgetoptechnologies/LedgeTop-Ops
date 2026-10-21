// Auth primitives shared by admin login and share-link validation.
// Deliberately dependency-free beyond Node's built-in `crypto` — no JWT
// library, no bcrypt: HMAC-signed cookies and scrypt password hashing cover
// this app's actual needs (single shared admin password, per-share optional
// passwords) without extra attack surface.
'use strict';

const crypto = require('crypto');
const { promisify } = require('util');
const { config } = require('./config');

const scrypt = promisify(crypto.scrypt);

// ─────────────────────────────────────────────────────────────
// Signed, stateless cookies (HMAC-SHA256). Payload is never encrypted —
// don't put secrets in it, only identifiers + an expiry.
// ─────────────────────────────────────────────────────────────
function sign(payload, ttlMs) {
  const body = { ...payload, exp: Date.now() + ttlMs };
  const json = Buffer.from(JSON.stringify(body)).toString('base64url');
  const mac = crypto.createHmac('sha256', config.sessionSecret).update(json).digest('base64url');
  return `${json}.${mac}`;
}

function verify(value) {
  if (!value || typeof value !== 'string' || !value.includes('.')) return null;
  const [json, mac] = value.split('.');
  const expectedMac = crypto.createHmac('sha256', config.sessionSecret).update(json).digest('base64url');
  const macBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expectedMac);
  if (macBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(macBuf, expectedBuf)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(json, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

// ─────────────────────────────────────────────────────────────
// Password hashing (scrypt, per-record random salt). Stored as "salt:hash".
// ─────────────────────────────────────────────────────────────
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  const derived = await scrypt(password, salt, 64);
  const storedBuf = Buffer.from(hashHex, 'hex');
  if (derived.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(derived, storedBuf);
}

function constantTimeEqual(a, b) {
  const aBuf = Buffer.from(String(a || ''));
  const bBuf = Buffer.from(String(b || ''));
  if (aBuf.length !== bBuf.length) {
    // still run a comparison of equal length to avoid an early-return timing
    // signal on length alone
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// ─────────────────────────────────────────────────────────────
// Share tokens. Only the SHA-256 hash is ever stored (never the raw token)
// — same model as a password-reset token.
// ─────────────────────────────────────────────────────────────
function newShareToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

// Idempotent administrative creation must be able to return the same
// one-time share identifier after response loss without storing that raw
// identifier in a receipt. A keyed, domain-separated PRF preserves the same
// 256-bit unpredictability as a random token while making the exact receipt
// inputs sufficient to reconstruct it.
function idempotentShareToken({ scope, sessionId, idempotencyKey, requestHash }) {
  const parts = [scope, sessionId, idempotencyKey, requestHash];
  if (parts.some((value) => typeof value !== 'string' || !value)) throw new Error('invalid idempotent share token input');
  const framed = parts.map((value) => `${Buffer.byteLength(value)}:${value}`).join('|');
  return crypto.createHmac('sha256', config.sessionSecret)
    .update('ltds-idempotent-public-share-v1\0')
    .update(framed)
    .digest('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ─────────────────────────────────────────────────────────────
// Tiny fixed-window rate limiter (in-memory; fine for a single instance).
// ─────────────────────────────────────────────────────────────
const windows = new Map();

function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const entry = windows.get(key);
  if (!entry || now - entry.start > windowMs) {
    windows.set(key, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > max;
}

// Periodically forget old windows so this Map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of windows) {
    if (now - entry.start > 10 * 60 * 1000) windows.delete(key);
  }
}, 5 * 60 * 1000).unref?.();

// ─────────────────────────────────────────────────────────────
// Cookie attributes. `SameSite=None; Secure` is required for the cookie to
// be sent inside a cross-origin `/embed/:token` iframe (e.g. embedded from
// LTDS Ops on a different domain); that combination requires HTTPS. Over
// plain HTTP (local dev) we fall back to `SameSite=Lax`.
// ─────────────────────────────────────────────────────────────
function isSecureRequest(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function cookieAttrs(req, { httpOnly = true, maxAge } = {}) {
  const secure = isSecureRequest(req);
  return {
    httpOnly,
    secure,
    sameSite: secure ? 'none' : 'lax',
    path: '/',
    maxAge,
  };
}

module.exports = {
  sign,
  verify,
  hashPassword,
  verifyPassword,
  constantTimeEqual,
  newShareToken,
  idempotentShareToken,
  hashToken,
  rateLimited,
  cookieAttrs,
  isSecureRequest,
};
