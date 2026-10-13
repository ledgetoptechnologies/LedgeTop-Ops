import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Test-only bundle of the real private class. This does not register it in the
// deployed Ops index, and does not claim joined positive-grant acceptance.
describe('native private reader class transport and environment boundaries', () => {
  let runtime: Miniflare;
  beforeAll(async () => {
    const built = await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true },
      build: { ssr: fileURLToPath(new URL('../src/worker/operations-portal-native-delivery-authorization-entrypoint.ts', import.meta.url)),
        target: 'esnext', write: false, minify: false,
        rollupOptions: { external: id => id.startsWith('cloudflare:') } } });
    const output = Array.isArray(built) ? built[0] : built;
    if (!output || !('output' in output)) throw new Error('Reader bundle missing');
    const entry = output.output.find(item => item.type === 'chunk' && item.isEntry);
    if (!entry || entry.type !== 'chunk') throw new Error('Reader entry missing');
    const script = `${entry.code}\nexport default { fetch() { return new Response('Not found', {status:404}); } };`;
    const target = (name: string, enabled: string, environment = 'staging', host = 'ops-staging.ledgetopdroneservices.com') => ({
      name, modules: true as const, compatibilityDate: '2026-08-06', compatibilityFlags: ['nodejs_compat'], script,
      // Deliberately no database: disabled/invalid requests must reject before I/O.
      bindings: { ENVIRONMENT: environment, EXPECTED_HOST: host, OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED: enabled },
    });
    runtime = new Miniflare({ workers: [
      { name: 'driver', modules: true, compatibilityDate: '2026-08-06',
        script: `export default { async fetch(request, env) {
          const selector = new URL(request.url).searchParams.get('case');
          const binding = selector==='enabled' ? env.ENABLED : selector==='production' ? env.PRODUCTION : selector==='wronghost' ? env.WRONGHOST : env.DISABLED;
          const input = request.method==='POST' ? await request.json() : {};
          const result = await binding.readNativeDeliveryAuthorization(input);
          return Response.json({ primitive: typeof result, result });
        } };`,
        serviceBindings: Object.fromEntries(['enabled','disabled','production','wronghost'].map(name => [name.toUpperCase(), {
          name, entrypoint: 'OperationsPortalNativeDeliveryAuthorizationReader',
        }])),
      }, target('enabled','true'), target('disabled','false'), target('production','true','production'),
      target('wronghost','true','staging','ops.ledgetopdroneservices.com'),
    ] });
  }, 120_000);
  afterAll(async () => { await runtime?.dispose(); });

  it('serializes the actual private class result as a primitive without internal error details', async () => {
    const response = await runtime.dispatchFetch('https://synthetic.test/?case=enabled');
    const body = await response.json() as { primitive: string; result: string };
    expect(body.primitive).toBe('string');
    expect(JSON.parse(body.result)).toEqual({ ok: false, protocolVersion: 1, code: 'denied' });
    expect(body.result).not.toMatch(/SELECT|sqlite|__rpc|dispos|stack/i);
  });

  it('rejects disabled, production, and wrong-host invocations before database access', async () => {
    for (const selector of ['disabled','production','wronghost']) {
      const response = await runtime.dispatchFetch(`https://synthetic.test/?case=${selector}`);
      const body = await response.json() as { primitive: string; result: string };
      expect(body.primitive).toBe('string');
      expect(JSON.parse(body.result)).toEqual({ ok: false, protocolVersion: 1, code: 'disabled' });
    }
  });

  it('does not expose runtime errors or infer authority from malformed or forged owner inputs', async () => {
    for (const input of [null, [], 'owner', { owner: true, permissions: ['*'], authorityRevision: 1 },
      { authorityId: '00000000-0000-4000-8000-000000000001', authorityRevision: 1 }]) {
      const response = await runtime.dispatchFetch('https://synthetic.test/?case=enabled', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
      });
      expect(await response.json()).toEqual({ primitive: 'string',
        result: JSON.stringify({ ok: false, protocolVersion: 1, code: 'denied' }) });
    }
  });

  it('returns only denial when a well-formed request cannot obtain current database proof', async () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const input = { authorityId: id(1), authorityRevision: 2, recipientBindingId: id(2), enrollmentIntentId: id(10),
      issuer: 'https://synthetic.cloudflareaccess.com', subject: 'synthetic-recipient', targetId: id(3), targetRevision: 4,
      targetClientRecordId: 'synthetic-client', clientAuthorityId: id(4), workspaceId: 'synthetic-workspace',
      homeOwnershipEpoch: 5, homeGrantRevision: 6, homeGrantOperationId: id(5), homeRequestFingerprint: 'a'.repeat(64),
      publicationOperationId: id(6), publicationId: id(7), publicationRevision: 8, publicationSourceSequence: 8,
      publicationSnapshotId: id(8), publicationSnapshotSha256: 'b'.repeat(64), folderReservationId: id(9),
      folderReservationRevision: 10, clientFolderBindingId: 'synthetic-binding', externalProjectId: 'synthetic-project',
      projectVersion: 11, opsFolderProjectId: 'synthetic-ops-project', opsDivisionId: 'synthetic-division', feature: 'file.download' };
    const response = await runtime.dispatchFetch('https://synthetic.test/?case=enabled', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    // No database is configured: even syntactically valid pins cannot establish access.
    expect(await response.json()).toEqual({ primitive: 'string',
      result: JSON.stringify({ ok: false, protocolVersion: 1, code: 'denied' }) });
  });
});
