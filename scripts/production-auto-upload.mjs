/** Bounded Workers Direct Upload adapter. This uploads assets only: no Worker
 * version, deployment, settings, credential lookup, retry, or console output.
 * Provider hashes are opaque ledger identities; SHA256 verifies payload bytes.
 * https://developers.cloudflare.com/workers/static-assets/direct-upload/ */
import crypto from 'node:crypto';

const API = 'https://api.cloudflare.com/client/v4';
const HASH = /^[a-f0-9]{32}$/;
const SHA = /^[a-f0-9]{64}$/;
const REQUEST_MS = 30_000;
const MAX_RESPONSE = 8 * 1024 * 1024;
const MAX_PAYLOAD = 32 * 1024 * 1024;
const MAX_RESOLVED = 256 * 1024 * 1024;
const need = (condition, message) => { if (!condition) throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const jwt = value => typeof value === 'string' && value.length <= 16_384
  && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function validateManifest(input) {
  need(object(input), 'Asset manifest must be a plain object');
  const entries = Object.entries(input);
  need(entries.length > 0 && entries.length <= 20_000, 'Asset manifest count is outside its bound');
  const manifest = Object.create(null), sizes = new Map(), folded = new Set();
  for (const [name, row] of entries) {
    need(name.length <= 1024 && /^\/[A-Za-z0-9._/-]+$/.test(name)
      && name.slice(1).split('/').every(part => part && part !== '.' && part !== '..')
      && !folded.has(name.toLowerCase()), 'Asset manifest path is invalid or duplicated');
    folded.add(name.toLowerCase());
    need(object(row) && Object.keys(row).sort().join(',') === 'hash,size'
      && HASH.test(row.hash) && Number.isSafeInteger(row.size) && row.size >= 0 && row.size <= MAX_PAYLOAD,
    'Asset manifest entry is invalid');
    need(!sizes.has(row.hash) || sizes.get(row.hash) === row.size, 'Asset hash has inconsistent sizes');
    sizes.set(row.hash, row.size); manifest[name] = { hash: row.hash, size: row.size };
  }
  need(Buffer.byteLength(JSON.stringify({ manifest })) <= MAX_RESPONSE, 'Asset manifest exceeds its byte bound');
  return { manifest, sizes };
}

async function responseJson(response, signal) {
  need(response && Number.isInteger(response.status) && response.body
    && typeof response.body.getReader === 'function', 'Asset API response is invalid');
  const length = response.headers.get('content-length');
  need(length === null || /^\d+$/.test(length) && Number(length) <= MAX_RESPONSE,
    'Asset API response exceeds its byte bound');
  const reader = response.body.getReader(), chunks = [];
  const cancel = () => { try { void reader.cancel().catch(() => {}); } catch { /* closed */ } };
  signal.addEventListener('abort', cancel, { once: true });
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      need(!signal.aborted, 'Asset API request expired');
      if (next.done) break;
      need(next.value instanceof Uint8Array, 'Asset API response chunk is invalid');
      size += next.value.byteLength;
      need(size <= MAX_RESPONSE, 'Asset API response exceeds its byte bound');
      chunks.push(Buffer.from(next.value));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    need(object(body) && body.success === true && (body.errors == null
      || Array.isArray(body.errors) && body.errors.length === 0) && object(body.result),
    'Asset API did not acknowledge success');
    return body.result;
  } finally {
    signal.removeEventListener('abort', cancel);
    // Never wait for cooperation from an upstream cancellation implementation.
    try { void reader.cancel().catch(() => {}); } catch { /* already closed */ }
  }
}

async function post(fetchImpl, url, authorization, body, contentType) {
  const controller = new AbortController();
  let timer, response;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      try { void response?.body?.cancel().catch(() => {}); } catch { /* reader owns body */ }
      reject(new Error('Asset API request deadline exceeded; reconcile without retry'));
    }, REQUEST_MS);
  });
  const operation = (async () => {
    response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${authorization}`, ...(contentType ? { 'Content-Type': contentType } : {}) }, body });
    if (controller.signal.aborted) {
      try { void response?.body?.cancel().catch(() => {}); } catch { /* already locked */ }
    }
    need(!controller.signal.aborted, 'Asset API request expired');
    need([200, 201, 202].includes(response.status), 'Asset API rejected the request');
    return { status: response.status, result: await responseJson(response, controller.signal) };
  })();
  try { return await Promise.race([operation, timeout]); }
  catch {
    controller.abort();
    try { void response?.body?.cancel().catch(() => {}); } catch { /* reader owns body */ }
    // Do not surface fetch/provider/resolver errors: they can contain JWTs,
    // private paths or entire response bodies. No mutation is retried here.
    throw new Error('Asset API request failed or is uncertain; preserve intent and reconcile without retry');
  } finally { clearTimeout(timer); }
}

/** recordIntent MUST durably reject a replay/unfinished prior mutation before
 * resolving. Callback data contains only phase and hash identities, never JWTs.
 * The returned completion token is exactly the provider response, not locally
 * fabricated or cryptographically verified by this adapter. */
export async function uploadAssetManifest({ accountId, workerName, token, manifest: input,
  resolvePayload, fetchImpl = fetch, recordIntent }) {
  need(typeof accountId === 'string' && /^[a-f0-9]{32}$/.test(accountId), 'Invalid asset account');
  need(['ledgetop-clients', 'ledgetop-ops'].includes(workerName), 'Invalid asset Worker');
  need(typeof token === 'string' && token.length > 0 && token.length <= 16_384
    && !/[\s\x00-\x1f\x7f]/u.test(token), 'Invalid asset API credential');
  need(typeof resolvePayload === 'function' && typeof fetchImpl === 'function'
    && typeof recordIntent === 'function', 'Asset adapter callbacks are required');
  const { manifest, sizes } = validateManifest(input);
  const includedHashes = [...sizes.keys()].sort();
  const intent = async (phase, hashes) => {
    try { await recordIntent(Object.freeze({ phase, hashes: Object.freeze([...hashes]) })); }
    catch { throw new Error('Asset mutation intent was not durably accepted; no request made'); }
  };
  await intent('asset-session', includedHashes);
  const session = await post(fetchImpl,
    `${API}/accounts/${accountId}/workers/scripts/${workerName}/assets-upload-session`,
    token, JSON.stringify({ manifest }), 'application/json');
  need([200, 201].includes(session.status) && jwt(session.result.jwt)
    && Array.isArray(session.result.buckets) && session.result.buckets.length <= includedHashes.length,
  'Asset session response is invalid');
  const uploadToken = session.result.jwt, buckets = [], requested = new Set();
  for (const bucket of session.result.buckets) {
    need(Array.isArray(bucket) && bucket.length > 0 && bucket.length <= includedHashes.length,
      'Asset upload bucket is invalid');
    const copy = [];
    for (const hash of bucket) {
      need(typeof hash === 'string' && HASH.test(hash) && sizes.has(hash) && !requested.has(hash),
        'Asset upload bucket contains an unknown or repeated hash');
      requested.add(hash); copy.push(hash);
    }
    buckets.push(copy);
  }
  // Empty buckets is the documented provider-issued completion-token path.
  if (!buckets.length) return { completionToken: uploadToken, includedHashes, uploadedHashes: [] };
  const payloads = new Map();
  let resolvedBytes = 0;
  // Resolve and verify ALL requested old/new bytes before transmitting any file.
  for (const hash of requested) {
    let payload;
    try { payload = await resolvePayload(hash); }
    catch { throw new Error('Requested asset payload is unavailable; no files uploaded'); }
    need(payload && Buffer.isBuffer(payload.bytes) && SHA.test(payload.sha256)
      && typeof payload.mime === 'string' && payload.mime.length <= 128
      && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:; charset=utf-8)?$/.test(payload.mime),
    'Requested asset payload metadata is invalid; no files uploaded');
    need(payload.bytes.length === sizes.get(hash),
      'Requested asset payload bytes differ from their pin; no files uploaded');
    resolvedBytes += payload.bytes.length;
    need(resolvedBytes <= MAX_RESOLVED, 'Requested asset payloads exceed the memory bound');
    const bytes = Buffer.from(payload.bytes);
    need(sha256(bytes) === payload.sha256, 'Requested asset payload bytes differ from their pin; no files uploaded');
    payloads.set(hash, { bytes, mime: payload.mime });
  }
  const uploadedHashes = [];
  let completionToken;
  for (const [index, bucket] of buckets.entries()) {
    const form = new FormData();
    for (const hash of bucket) {
      const payload = payloads.get(hash);
      form.append(hash, new Blob([payload.bytes.toString('base64')], { type: payload.mime }), hash);
    }
    await intent('asset-bucket', bucket);
    const result = await post(fetchImpl, `${API}/accounts/${accountId}/workers/assets/upload?base64=true`, uploadToken, form);
    const last = index === buckets.length - 1;
    if (last) {
      need(result.status === 201 && jwt(result.result.jwt), 'Final asset bucket has no completion acknowledgement');
      completionToken = result.result.jwt;
    } else {
      need(result.status !== 201 && result.result.jwt == null, 'Asset upload completed before all requested buckets');
    }
    uploadedHashes.push(...bucket);
  }
  need(completionToken && uploadedHashes.length === requested.size, 'Asset upload is incomplete');
  return { completionToken, includedHashes, uploadedHashes };
}
