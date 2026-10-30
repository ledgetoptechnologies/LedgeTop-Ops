import { describe, expect, it, vi } from 'vitest';
import { readPilotRpc } from '../src/worker/ios-pilot-read-rpc';
import type { Env } from '../src/worker/types';

const origin = 'https://pilot-staging.example.test';
const env = { ENVIRONMENT: 'staging', PUBLIC_BASE_URL: 'https://ops-staging.example.test',
  IOS_MANAGED_PILOT_ENABLED: 'true', IOS_MANAGED_PILOT_ORIGIN: origin,
  IOS_MANAGED_PILOT_AUDIENCE: 'pilot-audience' } as unknown as Env;
const assertion = 'aaa.bbb.ccc';
const message = (url = origin + '/mobile-pilot/v1/session', token = assertion) => JSON.stringify({ url, assertion: token });
const parse = (value: string) => JSON.parse(value) as { status: number; body: Record<string, unknown> };

describe('private pilot read RPC boundary', () => {
  it('defaults closed and rejects unreviewed, production, or incomplete settings', async () => {
    const handler = vi.fn();
    for (const candidate of [env, { ...env, ENVIRONMENT: 'production' },
      { ...env, IOS_MANAGED_PILOT_ENABLED: 'false' }, { ...env, IOS_MANAGED_PILOT_ORIGIN: undefined }]) {
      expect(parse(await readPilotRpc(message(), candidate as Env, [], handler)).status).toBe(404);
    }
    expect(handler).not.toHaveBeenCalled();
  });
  it('rejects caller identity, foreign URL, malformed assertion and oversized input', async () => {
    const handler = vi.fn();
    for (const input of [JSON.stringify({ url: origin + '/mobile-pilot/v1/session', assertion, principal: 'owner' }),
      message('https://foreign.example.test/mobile-pilot/v1/session'), message(undefined, 'not-a-jwt'), 'x'.repeat(25_000)]) {
      expect(parse(await readPilotRpc(input, env, [origin], handler)).status).toBe(404);
    }
    expect(handler).not.toHaveBeenCalled();
  });
  it('forwards only a GET, assertion and trusted configuration to the authoritative handler', async () => {
    const handler = vi.fn(async (request: Request) => {
      expect(request.method).toBe('GET');
      expect(request.headers.get('Cf-Access-Jwt-Assertion')).toBe(assertion);
      expect(request.headers.get('Authorization')).toBe('Bearer rpc-internal');
      return Response.json({ schemaVersion: 1, readOnly: true });
    });
    expect(parse(await readPilotRpc(message(), env, [origin], handler))).toEqual({ status: 200, version: 1,
      body: { schemaVersion: 1, readOnly: true } });
    expect(handler).toHaveBeenCalledOnce();
  });
  it('fails closed on handler errors or oversized responses without reflecting them', async () => {
    for (const handler of [vi.fn(async () => { throw Error('sensitive internal failure'); }),
      vi.fn(async () => new Response('x'.repeat(1_048_577), { status: 200 }))]) {
      const result = await readPilotRpc(message(), env, [origin], handler);
      expect(parse(result).status).toBe(503);
      expect(result).not.toContain('sensitive');
    }
  });
});
