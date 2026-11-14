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

  it('sends the given per-action key only on writes that are not naturally idempotent', async () => {
    const { calls, fetchImpl } = recorder();
    const logs = createRemoteFlightLogs(env, fetchImpl);
    await logs.startImport(actor, { sourceSystem: 'opendronelog', pilotId: 'staff-beau', expectedFlights: 1 }, { idempotencyKey: 'key-start-0000000001' });
    await logs.decideSignIn(actor, { signInId: 'x', approve: true }, { idempotencyKey: 'key-decide-000000001' });
    await logs.revokeDevice(actor, 'dev-1', { idempotencyKey: 'key-revoke-000000001' });
    await logs.importFlights(actor, 'imp-1', { flights: [] });
    await logs.pendingSignIns(actor);
    expect(calls.map(c => c.headers['Idempotency-Key'])).toEqual(['key-start-0000000001', 'key-decide-000000001', 'key-revoke-000000001', undefined, undefined]);
  });

  it('a keyed write without a valid key is refused locally and never sent with a made-up key', async () => {
    const { calls, fetchImpl } = recorder();
    const logs = createRemoteFlightLogs(env, fetchImpl);
    for (const options of [undefined, {}, { idempotencyKey: 'short' }, { idempotencyKey: 'has spaces in it here' }])
      expect(await logs.revokeDevice(actor, 'dev-1', options)).toMatchObject({ ok: false, error: { code: 'idempotency_key_required', status: 400 } });
    expect(calls).toHaveLength(0);
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
    expect(await logs.revokeDevice(actor, 'dev-1', { idempotencyKey: 'key-revoke-000000009' })).toEqual(refusal);
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

  it('reuses the browser per-action key, so a retry after a lost answer is applied exactly once', async () => {
    // A fake NAS with the real idempotency rule: same key -> same stored answer, the effect runs once.
    const stored = new Map<string, unknown>();
    let effects = 0, loseNextAnswer = true;
    const fetchImpl = (async (_url: URL, init: RequestInit) => {
      const key = (init.headers as Record<string, string>)['Idempotency-Key'];
      if (!stored.has(key)) { effects++; stored.set(key, { importId: `imp-${effects}` }); }
      if (loseNextAnswer) { loseNextAnswer = false; throw new Error('connection reset after commit'); }
      return ok(stored.get(key));
    }) as unknown as typeof fetch;
    const logs = createRemoteFlightLogs(env, fetchImpl);
    const options = { idempotencyKey: 'browser-action-key-0001' };
    const input = { sourceSystem: 'opendronelog' as const, pilotId: 'staff-beau', expectedFlights: 3 };
    expect((await logs.startImport(actor, input, options)).ok).toBe(false);
    expect(await logs.startImport(actor, input, options)).toEqual({ ok: true, value: { importId: 'imp-1' } });
    expect(effects).toBe(1);
    expect(await logs.startImport(actor, input, { idempotencyKey: 'browser-action-key-0002' })).toEqual({ ok: true, value: { importId: 'imp-2' } });
    expect(effects).toBe(2);
  });

  it('a body that fails or times out mid-read is "unavailable", never an unhandled error', async () => {
    const broken = (first: Uint8Array) => () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(first); }, pull(controller) { controller.error(new Error('stream reset')); } }), { status: 200 });
    const midJson = createRemoteFlightLogs(env, recorder(broken(new TextEncoder().encode('{"ok":true,"val'))).fetchImpl);
    expect((await midJson.inventory(actor)).ok).toBe(false);
    const midTrack = createRemoteFlightLogs(env, recorder(() => { const r = broken(new Uint8Array([31, 139]))(); r.headers.set('Content-Type', 'application/octet-stream'); return r; }).fetchImpl);
    expect(await midTrack.getTelemetry(actor, 'f1')).toEqual(expect.objectContaining({ ok: false }));
    const hanging = (async (_url: URL, init: RequestInit) => new Response(new ReadableStream({ start(controller) {
      init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason)); } }), { status: 200 })) as unknown as typeof fetch;
    expect((await createRemoteFlightLogs(env, hanging, { timeoutMs: 50 }).inventory(actor)).ok).toBe(false);
  });
});

describe("attribution review through the local Logs host", () => {
  it("reads are plain RPCs; the three changes require and forward the per-action key", async () => {
    const { calls, fetchImpl } = recorder(() => ok({ flightId: "f" }));
    const logs = createRemoteFlightLogs(env, fetchImpl);
    await logs.logsStatus!(actor);
    await logs.reviewQueue!(actor, { queue: "unassigned", limit: 10 });
    expect(calls.map(c => c.url.pathname)).toEqual(["/internal/v1/logs/rpc/logsStatus", "/internal/v1/logs/rpc/reviewQueue"]);
    expect(calls.every(c => c.headers["Idempotency-Key"] === undefined)).toBe(true);
    const changes: Array<[string, (o?: { idempotencyKey?: string }) => Promise<unknown>]> = [
      ["assignDecodedLog", o => logs.assignDecodedLog!(actor, { rawSha256: "a".repeat(64), pilotId: "p", reason: null }, o)],
      ["reassignFlight", o => logs.reassignFlight!(actor, { flightId: "f1", pilotId: "p", reason: null }, o)],
      ["resolveConflict", o => logs.resolveConflict!(actor, { rawSha256: "a".repeat(64), resolution: "keep_existing", reason: null }, o)],
    ];
    for (const [method, call] of changes) {
      const before = calls.length;
      expect(await call()).toMatchObject({ ok: false, error: { code: "idempotency_key_required" } });
      expect(calls.length).toBe(before);
      await call({ idempotencyKey: `key-${method}-000000000` });
      expect(calls.at(-1)!.url.pathname).toBe(`/internal/v1/logs/rpc/${method}`);
      expect(calls.at(-1)!.headers["Idempotency-Key"]).toBe(`key-${method}-000000000`);
    }
  });
});
