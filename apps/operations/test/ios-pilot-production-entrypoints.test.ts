import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('production pilot module isolation', { timeout: 120_000 }, () => {
  let runtime: Miniflare;
  beforeAll(async () => {
    const modules = new Map<string, string>();
    for (const [name, filename, exports] of [
      ['reader', 'ios-pilot-production-read-entrypoint.ts', ['default', 'IosPilotProductionReadService']],
      ['edge', 'ios-pilot-production-edge.ts', ['default']],
      ['staging-edge', 'ios-pilot-edge-bridge.ts', ['default', 'handlePilotEdge', 'handlePilotEdgeForEnvironment']],
    ] as const) {
      const built = await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true },
        build: { ssr: fileURLToPath(new URL('../src/worker/' + filename, import.meta.url)),
          target: 'esnext', write: false, minify: false,
          rollupOptions: { external: id => id.startsWith('cloudflare:') } } });
      const output = Array.isArray(built) ? built[0] : built;
      if (!output || !('output' in output)) throw Error('Missing bundle');
      const entry = output.output.find(x => x.type === 'chunk' && x.isEntry);
      if (!entry || entry.type !== 'chunk') throw Error('Missing entrypoint');
      expect([...entry.exports].sort()).toEqual([...exports].sort());
      if (name === 'edge') expect(entry.code).not.toMatch(/pa_connectors|FROM staff_users|readPilotOperations/);
      modules.set(name, entry.code);
    }
    runtime = new Miniflare({ workers: [
      { name: 'driver', modules: true, compatibilityDate: '2026-08-06',
        script: `export default { async fetch(request, env) {
          const mode = new URL(request.url).pathname;
          if (mode === '/rpc') return new Response(await env.PILOT.read('{}'));
          if (mode === '/staging-edge') return env.STAGING.fetch(new Request('https://ios-pilot-staging.ledgetop.app/mobile-pilot/v1/session'));
          return env.READER.fetch(new Request('https://ios-pilot.ledgetop.app' + mode, { method: request.method }));
        } };`, serviceBindings: { PILOT: { name: 'reader', entrypoint: 'IosPilotProductionReadService' }, READER: 'reader', STAGING: 'staging-edge' } },
      { name: 'reader', modules: true, compatibilityDate: '2026-08-06', compatibilityFlags: ['nodejs_compat'],
        script: modules.get('reader')!, bindings: { ENVIRONMENT: 'production', IOS_MANAGED_PILOT_ENABLED: 'true',
          IOS_MANAGED_PILOT_ORIGIN: 'https://ios-pilot.ledgetop.app', IOS_MANAGED_PILOT_AUDIENCE: 'production-pilot',
          PUBLIC_BASE_URL: 'https://ops.ledgetop.app' } },
      { name: 'staging-edge', modules: true, compatibilityDate: '2026-08-06', script: modules.get('staging-edge')!,
        bindings: { ENVIRONMENT: 'production', IOS_MANAGED_PILOT_ENABLED: 'true',
          IOS_MANAGED_PILOT_ORIGIN: 'https://ios-pilot-staging.ledgetop.app' } },
    ] });
  }, 120_000);
  afterAll(async () => { await runtime?.dispose(); });

  it('private default HTTP always denies routes and methods without a database or general API handler', async () => {
    for (const path of ['/', '/mobile-pilot/v1/session', '/api/operations', '/oauth-probe/v1']) {
      for (const method of ['GET', 'POST']) {
        const response = await runtime.dispatchFetch('https://driver.example.test' + path, { method });
        expect(response.status).toBe(404);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
      }
    }
  });

  it('exposes only the production named service and keeps it closed without the extra production switch', async () => {
    const response = await runtime.dispatchFetch('https://driver.example.test/rpc');
    expect(await response.json()).toEqual({ version: 1, status: 404, body: { error: 'Not found', code: 'not_found' } });
  });

  it('keeps the bundled staging edge closed in a production environment', async () => {
    expect((await runtime.dispatchFetch('https://driver.example.test/staging-edge')).status).toBe(404);
  });
});
