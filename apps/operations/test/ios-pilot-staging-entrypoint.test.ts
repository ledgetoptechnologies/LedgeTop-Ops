import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The release tooling's authoritative staging export inventory is plain JS.
import { WINDOWS_STAGING_EXPORT_POLICY } from '../../../scripts/windows-files-staging-exports.mjs';

// Bundle the actual staging wrapper. This is not a staging deployment: the
// Workers below have no database, secrets, network routes, or app bindings.
describe('review-only pilot staging entrypoint', { timeout: 120_000 }, () => {
  let runtime: Miniflare;
  beforeAll(async () => {
    const built = await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true },
      build: { ssr: fileURLToPath(new URL('../src/worker/staging-ios-pilot-entrypoint.ts', import.meta.url)),
        target: 'esnext', write: false, minify: false,
        rollupOptions: { external: id => id.startsWith('cloudflare:') } } });
    const output = Array.isArray(built) ? built[0] : built;
    if (!output || !('output' in output)) throw new Error('Staging bundle missing');
    const entry = output.output.find(item => item.type === 'chunk' && item.isEntry);
    if (!entry || entry.type !== 'chunk') throw new Error('Staging entry missing');
    // Exact runtime export inventory: no public HTTP handler is introduced,
    // and Workerd must not receive module helper constants as entrypoints.
    expect([...entry.exports].sort()).toEqual([
      'default', ...WINDOWS_STAGING_EXPORT_POLICY.operations.runtime, 'IosPilotReadService', 'IosPilotBusinessReadService',
    ].sort());
    runtime = new Miniflare({ workers: [
      { name: 'driver', modules: true, compatibilityDate: '2026-08-06',
        script: `export default { async fetch(request, env) {
          if (new URL(request.url).searchParams.has('public')) {
            return env.PUBLIC.fetch(new Request('https://ops-staging.example.test/api/mobile-pilot/authorize'));
          }
          const payload = new URL(request.url).searchParams.get('input') || '{}';
          const result = await (new URL(request.url).searchParams.has('business') ? env.BUSINESS : env.PILOT).read(payload);
          return Response.json({ primitive: typeof result, result });
        } };`, serviceBindings: { PILOT: { name: 'staging', entrypoint: 'IosPilotReadService' },
          BUSINESS: { name: 'staging', entrypoint: 'IosPilotBusinessReadService' }, PUBLIC: 'staging' } },
      { name: 'staging', modules: true, compatibilityDate: '2026-08-06', compatibilityFlags: ['nodejs_compat'],
        script: entry.code, bindings: { ENVIRONMENT: 'staging', IOS_MANAGED_PILOT_ENABLED: 'true', IOS_PILOT_BUSINESS_ENABLED: 'true',
          IOS_MANAGED_PILOT_ORIGIN: 'https://ios-pilot-staging.ledgetop.app', IOS_MANAGED_PILOT_AUDIENCE: 'pilot-audience',
          TEAM_DOMAIN: 'https://synthetic.cloudflareaccess.com', OPERATIONS_AUD: 'ordinary-web-audience',
          PUBLIC_BASE_URL: 'https://ops-staging.example.test' } },
    ] });
  }, 120_000);
  afterAll(async () => { await runtime?.dispose(); });

  it('exposes the named binding while its source-reviewed origin list remains empty', async () => {
    const response = await runtime.dispatchFetch('https://driver.example.test/?input=%7B%7D');
    const body = await response.json() as { primitive: string; result: string };
    expect(body.primitive).toBe('string');
    expect(JSON.parse(body.result)).toEqual({ version: 1, status: 404, body: { error: 'Not found', code: 'not_found' } });
    expect(body.result).not.toMatch(/stack|sqlite|assertion/i);
  });

  it('does not expose an enabled pilot HTTP route through the staging handler', async () => {
    const response = await runtime.dispatchFetch('https://driver.example.test/?public=1');
    expect(response.status).toBe(404);
  });

  it('keeps the new business binding closed without a reviewed source-origin admission', async () => {
    const input = JSON.stringify({ url: 'https://ios-pilot-staging.ledgetop.app/mobile-pilot/v1/business-roots', assertion: 'a.b.c' });
    const response = await runtime.dispatchFetch(`https://driver.example.test/?business=1&input=${encodeURIComponent(input)}`);
    const body = await response.json() as { primitive: string; result: string };
    expect(body.primitive).toBe('string');
    expect(JSON.parse(body.result)).toEqual({ version: 1, status: 404, body: { error: 'Not found', code: 'not_found' } });
  });
  it('does not admit the retired origin through the operations RPC even with complete staging settings', async () => {
    const input = JSON.stringify({ url: 'https://ios-pilot-staging.ledgetop.app/mobile-pilot/v1/session', assertion: 'a.b.c' });
    const response = await runtime.dispatchFetch(`https://driver.example.test/?input=${encodeURIComponent(input)}`);
    const body = await response.json() as { primitive: string; result: string };
    expect(JSON.parse(body.result)).toEqual({ version: 1, status: 404, body: { error: 'Not found', code: 'not_found' } });
  });
});
