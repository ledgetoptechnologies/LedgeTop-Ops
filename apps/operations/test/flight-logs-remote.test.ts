// Ops -> local (NAS) Logs host client: request shape, credentials and actor, idempotency keys only on
// non-idempotent writes, and a clear "unavailable" answer for every transport failure. Fake fetch only.
import { describe, expect, it } from 'vitest';
import { createRemoteFlightLogs, remoteLogsEnabled, REMOTE_LIMITS } from '../src/worker/flight-logs-remote';

const env = { LOGS_BACKEND_MODE: 'local', LOGS_BACKEND_URL: 'https://logs-backend-staging.example.test/',
  LOGS_BACKEND_ACCESS_CLIENT_ID: 'ops-staff-proxy.access', LOGS_BACKEND_ACCESS_CLIENT_SECRET: 's'.repeat(32) };
const actor = { staffId: 'staff-beau', permissions: ['flight_logs.view' as const, 'flight_logs.import' as const] };
const ok = (value: unknown) => new Response(JSON.stringify({ ok: true, value }), { status: 200, headers: { 'Content-Type': 'application/json' } });

function recorder(respond: (url: URL, init: RequestInit) => Response | Promise<Response> = () => ok({})) {
  const calls: Array<{ url: URL; init: RequestInit; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: URL, init: RequestInit) => {
    calls.push({ url, init, headers: init.headers as Record<string, string> });
    return respond(url, init);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const decodeActor = (value: string) => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));

describe('Ops client for the local Logs host', () => {
  it('is used only in local mode', () => {
    expect(remoteLogsEnabled(env)).toBe(true);
    expect(remoteLogsEnabled({ ...env, LOGS_BACKEND_MODE: undefined })).toBe(false);
    expect(remoteLogsEnabled({ ...env, LOGS_BACKEND_MODE: 'cloud' })).toBe(false);
  });

  it('sends Ops\' Access service token and the session actor, to the fixed RPC routes', async () => {
    const { calls, fetchImpl } = recorder(() => ok({ items: [], next: null, total: 0 }));
    const logs = createRemoteFlightLogs(env, fetchImpl);
    expect(await logs.listFlights(actor, { pilot: 'staff-beau', limit: 10 })).toEqual({ ok: true, value: { items: [], next: null, total: 0 } });
    const [call] = calls;
    expect(call.url.href).toBe('https://logs-backend-staging.example.test/internal/v1/logs/rpc/listFlights');
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('manual');
    expect(call.headers['CF-Access-Client-Id']).toBe(env.LOGS_BACKEND_ACCESS_CLIENT_ID);
    expect(call.headers['CF-Access-Client-Secret']).toBe(env.LOGS_BACKEND_ACCESS_CLIENT_SECRET);
    expect(decodeActor(call.headers['X-Ledge-Top-Actor'])).toEqual({ staffId: 'staff-beau', permissions: ['flight_logs.view', 'flight_logs.import'] });
    expect(JSON.parse(call.init.body as string)).toEqual({ args: [{ pilot: 'staff-beau', limit: 10 }] });
    expect(call.headers['Idempotency-Key']).toBeUndefined();
  });

  it('adds a fresh Idempotency-Key only to writes that are not naturally idempotent', async () => {
    const { calls, fetchImpl } = recorder();
    const logs = createRemoteFlightLogs(env, fetchImpl);
    await logs.startImport(actor, { sourceSystem: 'opendronelog', pilotId: 'staff-beau', expectedFlights: 1 });
    await logs.decideSignIn(actor, { signInId: 'x', approve: true });
    await logs.revokeDevice(actor, 'dev-1');
    await logs.importFlights(actor, 'imp-1', { flights: [] });
    await logs.pendingSignIns(actor);
    const keys = calls.map(c => c.headers['Idempotency-Key']);
    expect(keys.slice(0, 3).every(k => /^[0-9a-f]{32}$/.test(k))).toBe(true);
    expect(new Set(keys.slice(0, 3)).size).toBe(3);
    expect(keys.slice(3)).toEqual([undefined, undefined]);
  });

  it('streams telemetry both ways on the dedicated routes; a refusal comes back as the envelope', async () => {
    const track = new Uint8Array([31, 139, 8, 0]);
    const { calls, fetchImpl } = recorder(url => url.pathname.endsWith('/flights/f%201/telemetry') && !url.pathname.includes('imports')
      ? new Response(track, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }) : ok({ stored: true }));
    const logs = createRemoteFlightLogs(env, fetchImpl);
    expect(await logs.putTelemetry(actor, 'imp 1', 'f 1', track)).toEqual({ ok: true, value: { stored: true } });
    expect(calls[0].url.pathname).toBe('/internal/v1/logs/imports/imp%201/flights/f%201/telemetry');
    expect(calls[0].init.method).toBe('PUT');
    const got = await logs.getTelemetry(actor, 'f 1');
    expect(got.ok && [...got.value]).toEqual([...track]);
    const refusal = { ok: false, error: { code: 'track_not_found', status: 404, message: 'This flight has no stored track.' } };
    const missing = createRemoteFlightLogs(env, recorder(() => new Response(JSON.stringify(refusal), { status: 200, headers: { 'Content-Type': 'application/json' } })).fetchImpl);
    expect(await missing.getTelemetry(actor, 'nope')).toEqual(refusal);
  });

  it('passes business refusals through unchanged', async () => {
    const refusal = { ok: false, error: { code: 'forbidden', status: 403, message: 'You do not have permission to do that.' } };
    const logs = createRemoteFlightLogs(env, recorder(() => new Response(JSON.stringify(refusal), { status: 200 })).fetchImpl);
    expect(await logs.revokeDevice(actor, 'dev-1')).toEqual(refusal);
  });

  it('every transport failure is a clear 503 "unavailable", never a crash or a guess', async () => {
    const failures: Array<() => Response | Promise<Response>> = [
      () => { throw new Error('ECONNREFUSED'); },
      () => new Response(null, { status: 302, headers: { Location: 'https://example.cloudflareaccess.com/login' } }),
      () => new Response('down', { status: 502 }),
      () => new Response('not json', { status: 200 }),
      () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
      () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); } }), { status: 200 }),
    ];
    for (const respond of failures) {
      const result = await createRemoteFlightLogs(env, recorder(respond).fetchImpl).inventory(actor);
      expect(result).toEqual({ ok: false, error: { code: 'logs_unavailable', status: 503, message: expect.stringContaining('unavailable') } });
    }
    expect(REMOTE_LIMITS.jsonBytes).toBe(8 * 1024 * 1024);
  });

  it('incomplete local-mode configuration answers "unavailable" and makes no request', async () => {
    for (const broken of [{ LOGS_BACKEND_URL: 'http://plain.example.test/' }, { LOGS_BACKEND_URL: 'https://x.example.test/path' },
      { LOGS_BACKEND_ACCESS_CLIENT_SECRET: '' }, { LOGS_BACKEND_ACCESS_CLIENT_ID: 'x' }]) {
      const { calls, fetchImpl } = recorder();
      expect((await createRemoteFlightLogs({ ...env, ...broken }, fetchImpl).inventory(actor)).ok).toBe(false);
      expect(calls).toHaveLength(0);
    }
  });
});
