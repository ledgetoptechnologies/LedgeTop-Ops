import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Actual module and Workerd RPC composition, with no routes, DBs or secrets.
describe('private-only iOS reader module', { timeout: 120_000 }, () => {
  let runtime: Miniflare;
  beforeAll(async () => {
    const built = await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true },
      build: { ssr: fileURLToPath(new URL('../src/worker/ios-pilot-private-entrypoint.ts', import.meta.url)),
        target: 'esnext', write: false, minify: false,
        rollupOptions: { external: id => id.startsWith('cloudflare:') } } });
    const output = Array.isArray(built) ? built[0] : built;
    if (!output || !('output' in output)) throw new Error('Private reader bundle missing');
    const entry = output.output.find(item => item.type === 'chunk' && item.isEntry);
    if (!entry || entry.type !== 'chunk') throw new Error('Private reader entry missing');
    expect([...entry.exports].sort()).toEqual(['default', 'IosPilotReadService', 'IosPilotBusinessReadService'].sort());
    runtime = new Miniflare({ workers: [
      { name: 'driver', modules: true, compatibilityDate: '2026-08-06',
        script: `export default { async fetch(request, env) {
          const query = new URL(request.url).searchParams;
          if (query.has('public')) return env.PUBLIC.fetch(new Request(
            'https://private-reader.example.test' + (query.get('path') || '/'), {
              method: query.get('method') || 'GET', headers: {
                Authorization: 'Bearer synthetic', Cookie: 'session=synthetic',
                'Cf-Access-Jwt-Assertion': 'synthetic.assertion.value'
              }
            }));
          const service = query.get('service') === 'business' ? env.BUSINESS : env.OPERATIONS;
          const result = await service.read(query.get('input') || '{}');
          return Response.json({ primitive: typeof result, result });
        } };`,
        serviceBindings: { PUBLIC: 'private', OPERATIONS: { name: 'private', entrypoint: 'IosPilotReadService' },
          BUSINESS: { name: 'private', entrypoint: 'IosPilotBusinessReadService' } } },
      { name: 'private', modules: true, compatibilityDate: '2026-08-06', compatibilityFlags: ['nodejs_compat'],
        script: entry.code, bindings: { ENVIRONMENT: 'staging', IOS_MANAGED_PILOT_ENABLED: 'false',
          IOS_PILOT_BUSINESS_ENABLED: 'false' } },
    ] });
  }, 120_000);
  afterAll(async () => { await runtime?.dispose(); });

  it.each(['operations', 'business'])('composes the existing %s RPC with its gates closed', async service => {
    for (const input of ['{}', JSON.stringify({ url: 'https://pilot-staging.example.test/mobile-pilot/v1/business-roots',
      assertion: 'synthetic.assertion.value' })]) {
      const response = await runtime.dispatchFetch(`https://driver.example.test/?service=${service}&input=${encodeURIComponent(input)}`);
      const body = await response.json() as { primitive: string; result: string };
      expect(body.primitive).toBe('string');
      expect(JSON.parse(body.result)).toEqual({ version: 1, status: 404,
        body: { error: 'Not found', code: 'not_found' } });
      expect(body.result).not.toMatch(/stack|sqlite|assertion|synthetic/i);
    }
  });

  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])('always rejects public %s without router dispatch', async method => {
    for (const path of ['/', '/api/operations', '/api/admin/integrations/project-alpha/api-v2/sync-page',
      '/mobile-pilot/v1/session', '/mobile-pilot/v1/business-roots', '/api/mobile-pilot/authorize']) {
      const response = await runtime.dispatchFetch(`https://driver.example.test/?public=1&method=${method}&path=${encodeURIComponent(path)}`);
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.has('Location')).toBe(false);
      expect(response.headers.has('Set-Cookie')).toBe(false);
      if (method !== 'HEAD') expect(await response.text()).toBe('Not found');
    }
  });
});
