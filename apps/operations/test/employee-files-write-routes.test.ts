import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { resolveNativeStaffIdentityWithAdmissionVersion } from '../src/worker/native-staff-identity';
import type { AuthenticatedNativeStaffWithAdmissionVersion as Actor } from '../src/worker/native-staff-auth';
import { provisionEmployeeRead as provision } from '../src/worker/employee-read-provisioning';
import { canonicalJson, createEmployeeFilesWriteRouter, filesGatewayTransportSeeding, parseFilesGatewayTransports } from '../src/worker/employee-files-write';

const uuid = () => crypto.randomUUID();
const directory = new URL('../migrations/', import.meta.url);
const migrate = async (db: D1Database, name: string) =>
  db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), 'utf8')).map(sql => db.prepare(sql)));
const fromB64url = (text: string) => Uint8Array.from(atob(text.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - text.length % 4) % 4)), c => c.charCodeAt(0));
const sha = async (data: Uint8Array | string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  (typeof data === 'string' ? new TextEncoder().encode(data) : data) as Uint8Array<ArrayBuffer>)), b => b.toString(16).padStart(2, '0')).join('');

describe('0246 staff Files write routes, audit-before-sign and the Ed25519 signer (source-only)', () => {
  let mf: Miniflare, db: D1Database, owner: Actor, employee: Actor, gatewayId: string, rootId: string, grantId: string;
  const origin = 'https://ops.example.invalid', nas = 'https://files-staging.example.invalid', fingerprint = 'e'.repeat(64);
  const audience = 'n'.repeat(40), clientId = 'nas-link.access', now = () => Math.floor(Date.now() / 1000);
  let seed: Uint8Array, publicKey: CryptoKey, calls: { url: string; init: RequestInit }[], respond: (init: RequestInit) => Promise<Response>;

  async function person(role?: string): Promise<Actor> {
    const id = `employee-${uuid()}`, email = `${id}@example.invalid`, subject = `access|${id}`;
    await db.batch([
      db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,'active')").bind(id, email, id, subject),
      db.prepare('INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)').bind(id, subject, id),
      db.prepare('INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)').bind(id, email, id),
    ]);
    if (role) await db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key,created_by) VALUES(?,?,?,'global','global',?)").bind(uuid(), id, role, id).run();
    const result = await resolveNativeStaffIdentityWithAdmissionVersion(db, { verifiedEmail: email, verifiedAccessSubject: subject });
    return { ...result!, verifiedUntil: new Date(Date.now() + 3600_000).toISOString() };
  }
  const run = (command: unknown) => provision(db, owner, command, { gatewayIds: [gatewayId] });
  const writeGrant = async (expiresAt = now() + 3600) => {
    const command = { commandId: uuid(), kind: 'grant-write', rootId, rootGeneration: 1, rootFingerprint: fingerprint, grantId: uuid(),
      targetStaffId: employee.identity.staffId, targetAccessSubject: employee.identity.verifiedAccessSubject, targetAdmissionVersion: employee.admissionVersion, expiresAt };
    await run(command); return command.grantId;
  };
  function router(overrides: Record<string, unknown> = {}, database: D1Database = db) {
    return createEmployeeFilesWriteRouter({ enabled: true, opsOrigin: origin, access: { enabled: true, issuer: 'https://example.cloudflareaccess.com', staffAudience: 'a'.repeat(32) },
      transports: parseFilesGatewayTransports(JSON.stringify({ [gatewayId]: { scheme: 'ed25519-nas-link', origin: nas, audience } })),
      servicePrincipal: clientId, accessClientId: clientId, accessClientSecret: 'link-secret-value-xyz', keyId: 'write-1', signingSeed: seed, ...overrides } as never,
    { database, authenticate: async () => employee, fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return respond(init); }) as typeof fetch });
  }
  const post = (app: ReturnType<typeof router>, body: unknown) => app.request(`${origin}/api/staff/files/roots/${rootId}/operations`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const mkdir = (operationId = uuid(), path = 'jobs/new') => ({ operationId, operation: 'mkdir', args: { path, parentId: 'f'.repeat(32) } });

  beforeAll(async () => {
    mf = new Miniflare({ modules: true, compatibilityDate: '2026-08-06', script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
    db = await mf.getD1Database('DB') as D1Database;
    for (const name of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/u.test(name) && name.slice(0, 4) <= '0223').sort()) await migrate(db, name);
    await migrate(db, '0245_staff_files_write_access.sql');
    await migrate(db, '0246_staff_files_write_requests.sql');
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    seed = pkcs8.slice(-32); publicKey = pair.publicKey;
  }, 90_000);
  afterAll(async () => { await mf?.dispose(); });
  beforeEach(async () => {
    owner = await person('role-owner'); employee = await person(); gatewayId = uuid(); rootId = uuid(); calls = [];
    respond = async () => Response.json({ schemaVersion: 2, operationId: 'x', state: 'applied', result: {} });
    await run({ commandId: uuid(), kind: 'register-exclusive-root', rootId, gatewayId, rootFingerprint: fingerprint, displayName: 'Synthetic files' });
    grantId = await writeGrant();
  });

  it('audits, signs the exact audited envelope and forwards over the NAS link', async () => {
    const request = mkdir();
    const response = await post(router(), request);
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.url).toBe(`${nas}/v2/op`);
    expect(headers['CF-Access-Client-Id']).toBe(clientId); expect(headers['CF-Access-Client-Secret']).toBe('link-secret-value-xyz');
    const bytes = fromB64url(headers['X-Ltfiles-Envelope']!), signature = fromB64url(headers['X-Ltfiles-Signature']!);
    const message = new Uint8Array([...new TextEncoder().encode('ltfiles-v2\n'), ...bytes]);
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signature, message)).toBe(true);
    const envelope = JSON.parse(new TextDecoder().decode(bytes));
    expect(envelope).toMatchObject({ schemaVersion: 2, scope: 'files-write', keyId: 'write-1', audience, servicePrincipal: clientId, method: 'POST', route: '/v2/op',
      operationId: request.operationId, operation: 'mkdir', args: request.args, bodySha256: await sha(new Uint8Array()),
      actor: { staffId: employee.identity.staffId, accessSubject: employee.identity.verifiedAccessSubject, admissionVersion: employee.admissionVersion },
      grant: { grantId, grantGeneration: 1, path: '', rights: ['read', 'write'] }, root: { rootId, rootGeneration: 1, rootFingerprint: fingerprint, exclusive: true } });
    expect(envelope.expiresAt - envelope.issuedAt).toBeLessThanOrEqual(25);
    const audit = await db.prepare('SELECT * FROM ops_employee_files_write_requests WHERE operation_id=?').bind(request.operationId).first<Record<string, unknown>>();
    expect(audit).toMatchObject({ step: 'mkdir', grant_id: grantId, args_sha256: await sha(canonicalJson(request.args)), envelope_expires_at: envelope.expiresAt });
  });

  it('caps the envelope at the grant expiry', async () => {
    await run({ commandId: uuid(), kind: 'revoke-grant', grantId, expectedGeneration: 1 });
    const soon = now() + 10; grantId = await writeGrant(soon);
    await post(router(), mkdir());
    expect(JSON.parse(new TextDecoder().decode(fromB64url((calls[0]!.init.headers as Record<string, string>)['X-Ltfiles-Envelope']!))).expiresAt).toBe(soon);
  });

  it('refuses without a write grant, and signs nothing when the audit insert fails', async () => {
    await run({ commandId: uuid(), kind: 'revoke-grant', grantId, expectedGeneration: 1 });
    expect((await post(router(), mkdir())).status).toBe(403);
    grantId = await writeGrant();
    const failing = { withSession: (mode: string) => { const s = db.withSession(mode as never);
      return { ...s, prepare: (sql: string) => { if (sql.includes('INSERT INTO ops_employee_files_write_requests')) throw new Error('audit unavailable'); return s.prepare(sql); } }; } } as unknown as D1Database;
    expect((await post(router({}, failing), mkdir())).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('binds one immutable intent per operation id and one hash per chunk', async () => {
    const app = router(), operationId = uuid();
    expect((await post(app, mkdir(operationId))).status).toBe(200);
    expect((await post(app, mkdir(operationId))).status).toBe(200);  // same-step replay, fresh nonce
    const [first, second] = calls.map(call => JSON.parse(new TextDecoder().decode(fromB64url((call.init.headers as Record<string, string>)['X-Ltfiles-Envelope']!))));
    expect(first.nonce).not.toBe(second.nonce);
    expect(await (await post(app, mkdir(operationId, 'jobs/other'))).json()).toEqual({ error: 'operation-conflict' });
    const upload = uuid(), data = new TextEncoder().encode('chunk-one');
    expect((await post(app, { operationId: upload, operation: 'upload.begin', args: { path: 'jobs/u.bin', parentId: 'f'.repeat(32), size: data.length,
      sha256: await sha(data), precondition: { kind: 'create' } } })).status).toBe(200);
    const put = (body: Uint8Array, index = 0, op = upload) => app.request(`${origin}/api/staff/files/roots/${rootId}/uploads/${op}/chunks/${index}`, { method: 'PUT',
      headers: { 'X-Chunk-Sha256': '', 'Content-Length': String(body.length) }, body: body as Uint8Array<ArrayBuffer> });
    const putSigned = async (body: Uint8Array, index = 0, op = upload) => app.request(`${origin}/api/staff/files/roots/${rootId}/uploads/${op}/chunks/${index}`,
      { method: 'PUT', headers: { 'X-Chunk-Sha256': await sha(body), 'Content-Length': String(body.length) }, body: body as Uint8Array<ArrayBuffer> });
    expect((await put(data)).status).toBe(400);
    expect((await putSigned(data)).status).toBe(200);
    expect((await putSigned(data)).status).toBe(200);  // identical chunk replay
    expect(await (await putSigned(new TextEncoder().encode('different'))).json()).toEqual({ error: 'chunk-conflict' });
    expect(await (await putSigned(data, 0, operationId)).json()).toEqual({ error: 'operation-conflict' });  // not an upload
    const chunkAudit = await db.prepare("SELECT COUNT(*) n FROM ops_employee_files_write_requests WHERE operation_id=? AND step='upload.chunk'").bind(upload).first();
    expect(chunkAudit).toEqual({ n: 2 });
  });

  it('ties follow-ups to the operation\'s own grant generation (409 after revoke and regrant)', async () => {
    const app = router(), upload = uuid();
    await post(app, { operationId: upload, operation: 'upload.begin', args: { path: 'jobs/g.bin', parentId: 'f'.repeat(32), size: 1, sha256: 'a'.repeat(64), precondition: { kind: 'create' } } });
    await run({ commandId: uuid(), kind: 'revoke-grant', grantId, expectedGeneration: 1 });
    expect((await post(app, { operationId: upload, operation: 'upload.status', args: {} })).status).toBe(403);
    grantId = await writeGrant();
    expect(await (await post(app, { operationId: upload, operation: 'upload.commit', args: {} })).json()).toEqual({ error: 'operation-grant-changed' });
  });

  it('answers 502 (retry with the same operation id) on an ambiguous upstream, and withholds results after a late revoke', async () => {
    respond = async () => new Response('busy', { status: 503 });
    expect(await (await post(router(), mkdir())).json()).toEqual({ error: 'retry-with-same-operation-id' });
    respond = async () => { throw new Error('network'); };
    expect((await post(router(), mkdir())).status).toBe(502);
    respond = async () => { await run({ commandId: uuid(), kind: 'revoke-grant', grantId, expectedGeneration: 1 }); return Response.json({ state: 'applied' }); };
    expect(await (await post(router(), mkdir())).json()).toEqual({ error: 'authorization-changed' });
  });

  it('keeps the transport mapping strict and reports unseeded gateways', async () => {
    for (const bad of ['{}', '[]', JSON.stringify({ [uuid()]: { scheme: 'ed25519-nas-link', origin: 'http://x.example', audience } }),
      JSON.stringify({ [uuid()]: { scheme: 'hmac-v1', origin: nas, audience } }), JSON.stringify({ [uuid()]: { scheme: 'other', origin: nas, audience } }),
      JSON.stringify({ [uuid()]: { scheme: 'ed25519-nas-link', origin: nas, audience, extra: 1 } })]) expect(() => parseFilesGatewayTransports(bad)).toThrow();
    const seeding = await filesGatewayTransportSeeding(db, parseFilesGatewayTransports(JSON.stringify({ [gatewayId]: { scheme: 'ed25519-nas-link', origin: nas, audience } })));
    expect(seeding.ok).toBe(false); expect(seeding.missing).not.toContain(gatewayId);
    expect((await post(router({ transports: parseFilesGatewayTransports(JSON.stringify({ [uuid()]: { scheme: 'ed25519-nas-link', origin: nas, audience } })) }), mkdir())).status).toBe(503);
  });

  it('refuses malformed operations before any audit', async () => {
    for (const body of [{ operationId: 'x', operation: 'mkdir', args: {} }, { operationId: uuid(), operation: 'mkdir', args: { path: '../x', parentId: 'f'.repeat(32) } },
      { operationId: uuid(), operation: 'upload.begin', args: { path: 'a', parentId: 'f'.repeat(32), size: 1, sha256: 'a'.repeat(64), precondition: { kind: 'replace' } } },
      { operationId: uuid(), operation: 'rm-rf', args: {} }]) expect((await post(router(), body)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
