// The runner's only peer besides DJI (reached by the parser wrapper): the Ops machine bridge for the decoder, on its
// own configured host. Paths are fixed and nothing from a response is used to build a URL; redirects are refused.
// The bearer token and audience go only to that origin.
const HEX64 = /^[0-9a-f]{64}$/;
export const RAW_LOG_MAX_BYTES = 128 * 1024 * 1024;   // never buffer more than this for one raw log

export class LogsUnavailable extends Error {}   // network failure, 5xx/429, bridge closed or not authorized yet: back off, keep state
export class LogsRejected extends Error {       // the call was refused for this lease (stale, invalid): don't retry the same call
  constructor(status, code) { super(`${status} ${code}`); this.status = status; this.code = code; }
}

export function createClient({ baseUrl, token, audience, fetchImpl = fetch, timeoutMs = 60_000 }) {
  const origin = new URL(baseUrl).origin;
  const url = route => `${origin}/api/machine/logs-decoder/${route}`;
  async function send(route, init) {
    let response;
    try {
      response = await fetchImpl(url(route), { ...init, method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { ...init.headers, Authorization: `Bearer ${token}`, 'X-Machine-Audience': audience } });
    } catch (error) { throw new LogsUnavailable(error?.name === 'TimeoutError' ? 'timeout' : 'network'); }
    if (response.ok) return response;
    const body = await response.json().catch(() => ({}));
    const code = typeof body?.error === 'string' ? body.error.slice(0, 60) : 'error';
    if (response.status === 404 && code === 'raw_missing') throw new LogsRejected(404, code);
    // Closed bridge (404), not yet authorized (401), disabled decoder (503), overload (429) and server errors: wait.
    if ([401, 404, 429, 503].includes(response.status) || response.status >= 500) throw new LogsUnavailable(`http ${response.status} ${code}`);
    throw new LogsRejected(response.status, code);
  }
  const postJson = async (route, body) => (await send(route, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const leaseBody = lease => ({ sha256: lease.sha256, attemptToken: lease.attemptToken });

  return {
    async claim(requestId) {
      const lease = await postJson('claim', { requestId });
      return lease && HEX64.test(lease.sha256 ?? '') && typeof lease.attemptToken === 'string' ? lease : null;
    },
    heartbeat: lease => postJson('heartbeat', leaseBody(lease)),
    async raw(lease) {
      const response = await send('raw', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(leaseBody(lease)) });
      if (Number(response.headers.get('Content-Length') ?? 0) > RAW_LOG_MAX_BYTES) { await response.body?.cancel(); throw new LogsRejected(413, 'raw_too_large'); }
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > RAW_LOG_MAX_BYTES) { await reader.cancel(); throw new LogsRejected(413, 'raw_too_large'); }
        chunks.push(value);
      }
      return new Uint8Array(Buffer.concat(chunks));
    },
    async complete(lease, { contentSha256, summary, trackGzip, decoderVersion }) {
      return (await send('complete', { body: trackGzip, headers: { 'Content-Type': 'application/octet-stream',
        'X-Lease-Sha256': lease.sha256, 'X-Attempt-Token': lease.attemptToken, 'X-Content-Sha256': contentSha256, 'X-Decoder-Version': decoderVersion,
        'X-Decode-Summary': Buffer.from(JSON.stringify(summary)).toString('base64url') } })).json();
    },
    defer: (lease, errorCode, retryAfterSeconds) => postJson('defer', { ...leaseBody(lease), errorCode, retryAfterSeconds }),
    retry: (lease, errorCode) => postJson('retry', { ...leaseBody(lease), errorCode }),
    fail: (lease, errorCode) => postJson('fail', { ...leaseBody(lease), errorCode }),
    reconcile: lease => postJson('reconcile', leaseBody(lease)),
  };
}
