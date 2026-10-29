import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
import worker from '../src/worker/index';
import type { Env } from '../src/worker/types';

const origin = 'https://ops-staging.ledgetopdroneservices.com';
const context = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
function fixture(enabled?: string) {
  const assets = vi.fn(async () => new Response('SPA shell'));
  const db = vi.fn(() => { throw Error('Unexpected database use'); });
  const env = { IOS_PILOT_ENABLED: enabled, ENVIRONMENT: 'staging', EXPECTED_HOST: new URL(origin).host,
    PUBLIC_BASE_URL: origin, TEAM_DOMAIN: 'https://synthetic.cloudflareaccess.com', OPERATIONS_AUD: 'synthetic-audience',
    OPS_DB: { prepare: db, withSession: db }, ASSETS: { fetch: assets } } as unknown as Env;
  return { assets, db, request: (path: string, init?: RequestInit) => worker.fetch(new Request(origin + path, init), env, context) };
}
describe('iOS pilot real exported Worker mount', () => {
  it('keeps mobile paths worker-first and default-disabled in source configuration', () => {
    const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
    expect(config.assets.run_worker_first).toEqual(expect.arrayContaining(['/api/*', '/mobile-pilot/v1', '/mobile-pilot/v1/*']));
    expect(config.vars.IOS_PILOT_ENABLED).not.toBe('true');
  });
  it('terminates disabled bootstrap, base and child paths before legacy authentication or SPA assets', async () => {
    const f = fixture();
    for (const path of ['/api/mobile-pilot/authorize', '/mobile-pilot/v1', '/mobile-pilot/v1/session', '/mobile-pilot/v1/operations']) {
      const response = await f.request(path);
      expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ code: 'not_found' });
    }
    expect(f.db).not.toHaveBeenCalled(); expect(f.assets).not.toHaveBeenCalled();
  });
  it('enforces native authentication and read-only methods on mounted enabled paths', async () => {
    const f = fixture('true');
    expect((await f.request('/mobile-pilot/v1/session')).status).toBe(401);
    expect((await f.request('/mobile-pilot/v1/operations', { method: 'POST' })).status).toBe(405);
    expect((await f.request('/mobile-pilot/v1/not-an-api')).status).toBe(404);
    expect((await f.request('/api/operations', { method: 'POST', headers: { Authorization: 'Bearer ' + 'a'.repeat(43) } })).status).toBe(401);
    expect(f.db).not.toHaveBeenCalled(); expect(f.assets).not.toHaveBeenCalled();
  });
});
