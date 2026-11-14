// The runner's only network peer besides DJI (reached by the parser): the configured Logs origin. Paths are fixed;
// nothing from a response is ever used to build a URL. The bearer token is sent only to that origin.
const HEX64 = /^[0-9a-f]{64}$/;

export class LogsUnavailable extends Error {}   // network failure or 5xx: back off and try again later
export class LogsRejected extends Error {       // 4xx: this report was refused (stale lease, invalid input)
  constructor(status, code) { super(`${status} ${code}`); this.status = status; this.code = code; }
}

export function createClient({ baseUrl, token, fetchImpl = fetch, timeoutMs = 60_000 }) {
  const origin = new URL(baseUrl).origin;
  const url = path => `${origin}/api/v1/decoder/${path}`;
  async function send(path, init) {
    let response;
    try {
      response = await fetchImpl(url(path), { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { ...init.headers, Authorization: `Bearer ${token}` } });
    } catch (error) { throw new LogsUnavailable(error?.name === 'TimeoutError' ? 'timeout' : 'network'); }
    if (response.status === 404) {
      // The one meaningful 404 is a held log whose bytes are gone. Any other 404 (for example the decoder routes
      // being switched off) is treated like an outage: wait, never report a decode result.
      const body = await response.json().catch(() => ({}));
      if (body?.error === 'raw_missing') throw new LogsRejected(404, 'raw_missing');
      throw new LogsUnavailable('http 404');
    }
    if (response.status >= 500 || response.status === 429) {
      await response.body?.cancel().catch(() => {});
      throw new LogsUnavailable(`http ${response.status}`);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new LogsRejected(response.status, typeof body.error === 'string' ? body.error.slice(0, 60) : 'rejected');
    }
    return response;
  }
  const postJson = (path, body) => send(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  return {
    async lease(limit) {
      const { leases } = await (await postJson('lease', { limit })).json();
      return (Array.isArray(leases) ? leases : []).filter(lease => HEX64.test(lease?.sha256 ?? '') && typeof lease.attemptToken === 'string');
    },
    async raw(lease) {
      const response = await postJson('raw', { sha256: lease.sha256, attemptToken: lease.attemptToken });
      return new Uint8Array(await response.arrayBuffer());
    },
    async complete(lease, { contentSha256, summary, trackGzip }) {
      return (await send('complete', { method: 'POST', body: trackGzip, headers: { 'Content-Type': 'application/octet-stream',
        'X-Lease-Sha256': lease.sha256, 'X-Attempt-Token': lease.attemptToken, 'X-Content-Sha256': contentSha256,
        'X-Decode-Summary': Buffer.from(JSON.stringify(summary)).toString('base64url') } })).json();
    },
    async retry(lease, errorCode) { return (await postJson('retry', { sha256: lease.sha256, attemptToken: lease.attemptToken, errorCode })).json(); },
    async fail(lease, errorCode) { return (await postJson('fail', { sha256: lease.sha256, attemptToken: lease.attemptToken, errorCode })).json(); },
  };
}
