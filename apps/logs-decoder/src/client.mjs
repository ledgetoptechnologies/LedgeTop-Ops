// The runner's only peer besides DJI (reached by the parser wrapper): the decoder machine bridge, on its own configured
// host. Paths are fixed and nothing from a response is used to build a URL; redirects are refused. The bearer token
// and audience go only to that origin. The runner never names its own identity: the bridge supplies it.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { LIMITS } from './limits.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const REPLY_BYTES = 64 * 1024;   // every control reply is small; anything bigger is refused, never buffered

/** Reads a JSON reply of at most REPLY_BYTES; an oversized or malformed body is a fixed error, never kept. */
async function boundedJson(response) {
  if (Number(response.headers.get('Content-Length') ?? 0) > REPLY_BYTES) { await response.body?.cancel().catch(() => {}); throw new LogsUnavailable('reply_too_large'); }
  const chunks = [];
  let size = 0;
  if (response.body) for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > REPLY_BYTES) throw new LogsUnavailable('reply_too_large');
    chunks.push(chunk);
  }
  try { return size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { throw new LogsUnavailable('reply_invalid'); }
}

export class LogsUnavailable extends Error {}   // network failure, 5xx/429, bridge closed or not authorized yet: back off, keep state
export class LogsRejected extends Error {       // the call was refused for this lease (stale, invalid): don't retry the same call
  constructor(status, code) { super(`${status} ${code}`); this.status = status; this.code = code; }
}

export function createClient({ baseUrl, token, audience, fetchImpl = fetch, timeoutMs = 60_000 }) {
  const origin = new URL(baseUrl).origin;
  const url = route => `${origin}/api/machine/logs-decoder/${route}`;
  async function send(route, init, signal) {
    let response;
    try {
      response = await fetchImpl(url(route), { ...init, method: 'POST', redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        headers: { ...init.headers, Authorization: `Bearer ${token}`, 'X-Machine-Audience': audience } });
    } catch (error) { throw new LogsUnavailable(error?.name === 'TimeoutError' ? 'timeout' : 'network'); }
    if (response.ok) return response;
    const body = await boundedJson(response).catch(() => ({}));
    const code = typeof body?.error === 'string' && /^[a-z_]{1,60}$/.test(body.error) ? body.error : 'error';
    if (response.status === 404 && code === 'raw_missing') throw new LogsRejected(404, code);
    if (response.status === 413) throw new LogsRejected(413, code);
    // Closed bridge (404), not yet authorized (401), disabled decoder (503), overload (429) and server errors: wait.
    if ([401, 404, 429, 503].includes(response.status) || response.status >= 500) throw new LogsUnavailable(`http ${response.status} ${code}`);
    throw new LogsRejected(response.status, code);
  }
  const postJson = async (route, body, signal) => boundedJson(await send(route, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, signal));
  const leaseBody = lease => ({ sha256: lease.sha256, attemptToken: lease.attemptToken });

  return {
    async claim(requestId, signal) {
      const lease = await postJson('claim', { requestId }, signal);
      return lease && HEX64.test(lease.sha256 ?? '') && typeof lease.attemptToken === 'string' ? lease : null;
    },
    heartbeat: (lease, signal) => postJson('heartbeat', leaseBody(lease), signal),
    /**
     * Streams the held raw log straight to `file` (tmpfs) while hashing it, so the bytes are never held whole in
     * memory. Returns the SHA-256. Over LIMITS.rawBytes is refused as raw_too_large.
     */
    async rawToFile(lease, file, signal) {
      const response = await send('raw', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(leaseBody(lease)) }, signal);
      if (Number(response.headers.get('Content-Length') ?? 0) > LIMITS.rawBytes) { await response.body?.cancel(); throw new LogsRejected(413, 'raw_too_large'); }
      const hash = createHash('sha256'), out = await fs.open(file, 'wx', 0o600);
      let size = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > LIMITS.rawBytes) throw new LogsRejected(413, 'raw_too_large');
          hash.update(chunk);
          await out.write(chunk);
        }
      } finally { await out.close(); }
      return hash.digest('hex');
    },
    async complete(lease, { contentSha256, summary, trackGzip, decoderVersion }, signal) {
      return boundedJson(await send('complete', { body: trackGzip, headers: { 'Content-Type': 'application/octet-stream',
        'X-Lease-Sha256': lease.sha256, 'X-Attempt-Token': lease.attemptToken, 'X-Content-Sha256': contentSha256, 'X-Decoder-Version': decoderVersion,
        'X-Decode-Summary': Buffer.from(JSON.stringify(summary)).toString('base64url') } }, signal));
    },
    defer: (lease, errorCode, retryAfterSeconds, signal) => postJson('defer', { ...leaseBody(lease), errorCode, retryAfterSeconds }, signal),
    retry: (lease, errorCode, signal) => postJson('retry', { ...leaseBody(lease), errorCode }, signal),
    suspend: (lease, errorCode, signal) => postJson('suspend', { ...leaseBody(lease), errorCode }, signal),
    fail: (lease, errorCode, signal) => postJson('fail', { ...leaseBody(lease), errorCode }, signal),
    reconcile: (lease, signal) => postJson('reconcile', leaseBody(lease), signal),
  };
}
