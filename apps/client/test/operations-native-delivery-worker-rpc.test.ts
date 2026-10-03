import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Transport/startup acceptance only. Real grant predicates have separate D1
 * producer tests; this suite verifies the actual named platform RPC class. */
describe('native delivery private Worker RPC transport', () => {
  let runtime: Miniflare;
  beforeAll(async () => {
    const built = await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true },
      build: { ssr: fileURLToPath(new URL('../src/worker/index.ts', import.meta.url)),
        target: 'esnext', write: false, minify: false,
        rollupOptions: { external: id => id.startsWith('cloudflare:') } } });
    const output = Array.isArray(built) ? built[0] : built;
    if (!output || !('output' in output)) throw new Error('Native delivery RPC bundle missing');
    const entry = output.output.find(item => item.type === 'chunk' && item.isEntry);
    if (!entry || entry.type !== 'chunk') throw new Error('Native delivery RPC entrypoint missing');
    const target = (name: string, enabled: string) => ({ name, modules: true as const,
      compatibilityDate: '2026-08-06', compatibilityFlags: ['nodejs_compat'], script: entry.code,
      bindings: { ENVIRONMENT: 'staging', EXPECTED_HOST: 'delivery-staging.ledgetopdroneservices.com',
        PUBLIC_BASE_URL: 'https://delivery-staging.ledgetopdroneservices.com',
        PUBLIC_SHARE_ORIGIN: 'https://delivery-staging.ledgetopdroneservices.com',
        CLIENT_PORTAL_ORIGIN: 'https://client-staging.ledgetopdroneservices.com',
        CLIENT_PORTAL_ORIGINS: 'https://client-staging.ledgetopdroneservices.com,https://portal-staging.ledgetoptechnologies.com',
        CLIENT_ACCESS_TEAM_DOMAIN: 'https://synthetic.cloudflareaccess.com', CLIENT_ACCESS_AUD: 'synthetic-client-audience',
        CLIENT_PORTAL_ENABLED: 'true', CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED: enabled,
        CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_WRITER_ENABLED: enabled,
        CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_STATUS_ENABLED: enabled },
      d1Databases: { DELIVERY_DB: crypto.randomUUID() } });
    runtime = new Miniflare({ workers: [
      { name: 'driver', modules: true, compatibilityDate: '2026-08-06',
        script: `export default { async fetch(request, env) {
          const url = new URL(request.url);
          if (url.pathname === '/mounted') return env.HTTP.fetch(new Request(
            'https://client-staging.ledgetopdroneservices.com/api/client/operations/data/deliveries'));
          if (url.pathname === '/host-matrix') return env.READ_HTTP.fetch(new Request(
            url.searchParams.get('target') + '/api/client/operations/data/deliveries'));
          const binding = url.searchParams.get('enabled') === 'true' ? env.ENABLED : env.DISABLED;
          const result = url.pathname === '/status'
            ? await binding.getNativeDeliveryAuthorityStatus('{}')
            : await binding.applyNativeDeliveryAuthority('{}');
          return Response.json({ primitive: typeof result, result });
        } };`,
        serviceBindings: {
          ENABLED: { name: 'enabled-client', entrypoint: 'OperationsPortalNativeDeliveryAuthorityIngress' },
          DISABLED: { name: 'disabled-client', entrypoint: 'OperationsPortalNativeDeliveryAuthorityIngress' },
          HTTP: { name: 'disabled-client' }, READ_HTTP: { name: 'enabled-client' },
        } }, target('enabled-client', 'true'), target('disabled-client', 'false'),
    ] });
  }, 120_000);
  afterAll(async () => { await runtime?.dispose(); });

  it('serves primitive private grant/status results with independent default-off gates', async () => {
    for (const path of ['/apply', '/status']) {
      for (const enabled of ['false', 'true']) {
        const response = await runtime.dispatchFetch(`https://synthetic.test${path}?enabled=${enabled}`);
        expect(response.status).toBe(200);
        const body = await response.json() as { primitive: string; result: string };
        expect(body.primitive).toBe('string');
        expect(JSON.parse(body.result)).toEqual({ ok: false, protocolVersion: 1,
          code: enabled === 'true' ? 'invalid' : 'disabled', retryable: enabled !== 'true' });
        expect(body.result).not.toMatch(/__rpc|dispos|SELECT|sqlite/i);
      }
    }
  });

  it('starts the complete Client Worker and denies the mounted default-off native path without PA admission', async () => {
    const response = await runtime.dispatchFetch('https://synthetic.test/mounted');
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ error: 'Not found' });
  });
  it('uses separate public and primary portal origins at the mounted native Access boundary', async () => {
    for (const [origin, status] of [
      ['https://client-staging.ledgetopdroneservices.com', 401],
      ['https://delivery-staging.ledgetopdroneservices.com', 404],
      ['https://portal-staging.ledgetoptechnologies.com', 404],
      ['https://unrelated.test', 404],
    ] as const) {
      const response = await runtime.dispatchFetch(`https://synthetic.test/host-matrix?target=${encodeURIComponent(origin)}`);
      expect(response.status).toBe(status);
      expect(await response.text()).not.toMatch(/PA|project_alpha|no such table|SELECT/);
    }
  });
});
