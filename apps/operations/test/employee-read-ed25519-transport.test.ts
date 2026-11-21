import { describe, expect, it } from 'vitest';
import { readEmployeeGateway, type EmployeeGatewayConfiguration, type EmployeeReadProof } from '../src/worker/employee-read-transport';
import { readGateway } from '../src/worker/windows-files-staging-worker';

const fromB64url = (text: string) => Uint8Array.from(atob(text.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - text.length % 4) % 4)), c => c.charCodeAt(0));
const hex = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');

describe('read cutover: one scheme per gateway (slice 2c, source only)', () => {
  const gatewayId = crypto.randomUUID(), origin = 'https://files-staging.ledgetopdroneservices.com';
  const proof: EmployeeReadProof = { gatewayId, rootId: crypto.randomUUID(), rootGeneration: 1, rootFingerprint: 'a'.repeat(64), staffId: 'staff-1',
    accessSubject: 'synthetic-subject-1', admissionVersion: 1, profileVersion: 1, grantId: crypto.randomUUID(), grantGeneration: 1,
    verifiedUntil: new Date(Date.now() + 600_000).toISOString() };
  const list = { operation: 'list' as const, path: '', expectedSha256: null, range: null, cursor: null, snapshotId: null };
  async function call(config: EmployeeGatewayConfiguration) {
    const seen: RequestInit[] = [];
    const response = await readEmployeeGateway(proof, list, config, { recheck: async () => true, auditContentStart: async () => {},
      fetch: (async (_url: string, init: RequestInit) => { seen.push(init); return Response.json({ schemaVersion: 1, entries: [], nextCursor: null }); }) as typeof fetch });
    return { response, headers: seen[0]?.headers as Record<string, string> | undefined, body: seen[0]?.body as string | undefined };
  }

  it('signs with the files-read Ed25519 key over the NAS link and sends no HMAC headers', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const seed = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).slice(-32);
    const { response, headers, body } = await call({ origin, gatewayId, keyId: 'read-1', key: seed, scheme: 'ed25519-nas-link',
      accessClientId: 'nas-link.access', accessClientSecret: 'link-secret-value-xyz' });
    expect(response.status).toBe(200);
    expect(Object.keys(headers!).filter(name => name.startsWith('X-Ops-Read'))).toEqual([]);
    expect(headers!['CF-Access-Client-Id']).toBe('nas-link.access');
    const message = ['ltfiles-v1read', gatewayId, 'read-1', headers!['X-Ltfiles-Read-Time'], headers!['X-Ltfiles-Read-Nonce'], 'POST', '/v1/read', await hex(body!)].join('\n');
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, pair.publicKey, fromB64url(headers!['X-Ltfiles-Read-Signature']!), new TextEncoder().encode(message))).toBe(true);
  });

  it('keeps the HMAC scheme unchanged and never mixes headers', async () => {
    const { response, headers } = await call({ origin, gatewayId, keyId: 'hmac-1', key: new Uint8Array(32).fill(7) });
    expect(response.status).toBe(200);
    expect(Object.keys(headers!).some(name => name.startsWith('X-Ltfiles') || name.startsWith('CF-Access'))).toBe(false);
    expect(headers!['X-Ops-Read-Signature']).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('refuses an incomplete Ed25519 configuration or link headers on an HMAC gateway', async () => {
    for (const config of [{ origin, gatewayId, keyId: 'read-1', key: new Uint8Array(32), scheme: 'ed25519-nas-link' as const },
      { origin, gatewayId, keyId: 'read-1', key: new Uint8Array(48), scheme: 'ed25519-nas-link' as const, accessClientId: 'x', accessClientSecret: 'y'.repeat(20) },
      { origin, gatewayId, keyId: 'hmac-1', key: new Uint8Array(32).fill(7), accessClientId: 'x', accessClientSecret: 'y'.repeat(20) }]) {
      const { response, headers } = await call(config);
      expect(response.status).toBeGreaterThanOrEqual(500); expect(headers).toBeUndefined();
    }
  });

  it('selects the scheme strictly from the mapping, with no fallback (staging worker)', () => {
    const profile = { origin, gatewayId, keyId: 'hmac-1' }, k = (fill: number) => b64url(new Uint8Array(32).fill(fill));
    const env = { WINDOWS_EMPLOYEE_GATEWAY_SIGNING_KEY: k(1), FILES_READ_SIGNING_KEY: k(2), FILES_READ_KEY_ID: 'read-1',
      FILES_BACKEND_ACCESS_CLIENT_ID: 'nas-link.access', FILES_BACKEND_ACCESS_CLIENT_SECRET: 'link-secret-value-xyz' };
    const map = (entry: unknown) => JSON.stringify({ [gatewayId]: entry });
    expect(readGateway(profile, env)).toMatchObject({ keyId: 'hmac-1' });  // no mapping yet: reviewed HMAC unchanged
    expect(readGateway(profile, { ...env, FILES_GATEWAY_TRANSPORTS: map({ scheme: 'hmac-v1', origin, audience: null }) })).not.toHaveProperty('scheme');
    expect(readGateway(profile, { ...env, FILES_GATEWAY_TRANSPORTS: map({ scheme: 'ed25519-nas-link', origin, audience: 'n'.repeat(40) }) }))
      .toMatchObject({ scheme: 'ed25519-nas-link', keyId: 'read-1' });
    // Rollback is a mapping edit back to hmac-v1 at the same origin; a missing entry or another origin never falls back.
    expect(() => readGateway(profile, { ...env, FILES_GATEWAY_TRANSPORTS: JSON.stringify({ [crypto.randomUUID()]: { scheme: 'hmac-v1', origin, audience: null } }) })).toThrow();
    expect(() => readGateway(profile, { ...env, FILES_GATEWAY_TRANSPORTS: map({ scheme: 'hmac-v1', origin: 'https://other-staging.ledgetopdroneservices.com', audience: null }) })).toThrow();
    expect(() => readGateway(profile, { ...env, FILES_READ_SIGNING_KEY: undefined, FILES_GATEWAY_TRANSPORTS: map({ scheme: 'ed25519-nas-link', origin, audience: 'n'.repeat(40) }) })).toThrow();
  });
});
