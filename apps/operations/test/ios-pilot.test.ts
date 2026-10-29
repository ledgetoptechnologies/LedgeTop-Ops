import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStaffLoginFixture, staffLoginClaims } from './helpers/staff-login-fixture';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { handleIosPilot } from '../src/worker/ios-pilot-routes';
import { authenticateStaff } from '../src/worker/auth';
import { authenticatePilotSession, IOS_PILOT_CALLBACK, pkceChallenge, recheckPilotSession, sha256 } from '../src/worker/ios-pilot-session';
import { claimStaffLoginBindingIntent, createStaffLoginBindingIntent, resolveVerifiedStaffLogin, revokeStaffLoginBinding, type VerifiedStaffLoginClaims } from '../src/worker/staff-login-bindings';
import type { Env } from '../src/worker/types';

// The external Access JWT verification is the only mocked trust boundary.
// Identity/admission/ACL/source/session SQL executes against real local D1.
const access = vi.hoisted(() => ({ claims: {} as VerifiedStaffLoginClaims }));
vi.mock('../src/worker/auth', async original => ({ ...await original<typeof import('../src/worker/auth')>(),
  verifyStaffLoginClaims: vi.fn(async () => access.claims) }));
const origin = 'https://ops-staging.ledgetopdroneservices.com';
const verifier = 'v'.repeat(64), state = 's'.repeat(43);
type Token = { accessToken: string; tokenType: string; expiresAt: number };
describe('isolated read-only iOS pilot', { timeout: 120_000 }, () => {
  let fixture: Awaited<ReturnType<typeof createStaffLoginFixture>>, db: D1Database, env: Env;
  beforeAll(async () => {
    fixture = await createStaffLoginFixture(); db = fixture.db;
    const migration = readFileSync(new URL('../migrations/0232_ios_pilot_sessions.sql', import.meta.url), 'utf8');
    await db.batch(splitD1MigrationStatements(migration).map(sql => db.prepare(sql)));
    const schema = `
      CREATE TABLE native_staff_access_reconciliation(singleton INTEGER PRIMARY KEY,enabled INTEGER);
      INSERT INTO native_staff_access_reconciliation VALUES(1,1);
      ALTER TABLE staff_role_assignments ADD COLUMN division_id TEXT;
      ALTER TABLE staff_permission_overrides ADD COLUMN division_id TEXT;
      CREATE TABLE local_staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
      CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT);
      INSERT INTO role_permissions VALUES('role-owner','operations.view');
      INSERT INTO role_permissions VALUES('role-operator','operations.view');
      CREATE TABLE pa_connectors(source_id TEXT PRIMARY KEY,read_visible INTEGER);
      CREATE TABLE divisions(id TEXT PRIMARY KEY,name TEXT,active INTEGER);
      CREATE TABLE pa_local_division_source_heads(projection_source_id TEXT,identity_key TEXT);
      CREATE TABLE pa_local_division_mappings(resource_kind TEXT,resource_id TEXT,projection_source_id TEXT,identity_key TEXT,division_id TEXT);
      CREATE TABLE pa_projects(id TEXT PRIMARY KEY,projection_source_id TEXT,name TEXT,active INTEGER);
      CREATE TABLE pa_operations(id TEXT PRIMARY KEY,projection_source_id TEXT,project_id TEXT,title TEXT,status TEXT,
        scheduled_start_at TEXT,scheduled_end_at TEXT,location TEXT,active INTEGER);
      CREATE TABLE pa_operation_assignments(operation_id TEXT,user_id TEXT,active INTEGER);
      INSERT INTO pa_projects VALUES('project','project-alpha:primary','Synthetic project',1);
    `;
    await db.batch(splitD1MigrationStatements(schema).map(sql => db.prepare(sql)));
    env = { OPS_DB: db, IOS_PILOT_ENABLED: 'true', TEAM_DOMAIN: fixture.issuer, OPERATIONS_AUD: 'synthetic-staff-audience',
      ENVIRONMENT: 'staging', EXPECTED_HOST: new URL(origin).host, PUBLIC_BASE_URL: origin } as Env;
  }, 120_000);
  afterAll(async () => fixture?.runtime.dispose());
  beforeEach(async () => {
    access.claims = staffLoginClaims(fixture.owner.email, fixture.owner.subject);
    await db.batch([
      db.prepare('DELETE FROM ios_pilot_codes'), db.prepare('DELETE FROM ios_pilot_sessions'),
      db.prepare('DELETE FROM pa_operations'), db.prepare('DELETE FROM pa_operation_assignments'), db.prepare('DELETE FROM pa_connectors'),
      db.prepare('DELETE FROM staff_permission_overrides'),
      db.prepare("UPDATE staff_users SET status='active',project_alpha_user_id='pa-human' WHERE id=?").bind(fixture.owner.id),
      db.prepare("UPDATE staff_role_assignments SET role_id='role-owner' WHERE staff_id=?").bind(fixture.owner.id),
      db.prepare('UPDATE native_staff_admissions SET active=1 WHERE staff_id=?').bind(fixture.owner.id),
      db.prepare('UPDATE native_staff_access_reconciliation SET enabled=1'),
    ]);
  });
  const route = (path: string, init?: RequestInit, override: Env = env) => handleIosPilot(new Request(origin + path, init), override);
  async function code() {
    const query = new URLSearchParams({ redirect_uri: IOS_PILOT_CALLBACK, state, code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256' });
    const response = await route('/api/mobile-pilot/authorize?' + query);
    expect(response.status).toBe(302);
    const callback = new URL(response.headers.get('Location')!);
    expect(callback.searchParams.get('state')).toBe(state);
    return callback.searchParams.get('code')!;
  }
  async function exchange(codeValue: string, extra: Record<string, string> = {}) {
    return route('/mobile-pilot/v1/token', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: codeValue, codeVerifier: verifier, state, redirectUri: IOS_PILOT_CALLBACK, ...extra }) });
  }
  async function signIn(): Promise<Token> { const response = await exchange(await code()); expect(response.status).toBe(200); return response.json(); }
  function read(path: string, token: Token, method = 'GET') { return route(path, { method, headers: { Authorization: `Bearer ${token.accessToken}` } }); }
  function raceEnvironment(mutate: () => Promise<unknown>): Env {
    let fired = false;
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (key === 'all' && sql.startsWith('SELECT o.id,o.title')) return async () => {
          const result = await target.all();
          if (!fired) { fired = true; await mutate(); }
          return result;
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const wrapSession = (session: D1DatabaseSession): D1DatabaseSession => new Proxy(session, {
      get(target, key) {
        if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { ...env, OPS_DB: new Proxy(db, { get(target, key) {
      if (key === 'withSession') return (constraint?: Parameters<D1Database['withSession']>[0]) => wrapSession(target.withSession(constraint));
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } }) };
  }
  async function operation(id: string, source = 'project-alpha:primary') {
    await db.prepare(`INSERT INTO pa_operations VALUES(?,?,'project',?,'scheduled','2026-10-29T13:00:00Z',NULL,NULL,1)`).bind(id, source, `Operation ${id}`).run();
  }
  it('defaults absent before any database or auth work; rejects foreign origin and arbitrary callback', async () => {
    expect((await route('/mobile-pilot/v1/session', undefined, { IOS_PILOT_ENABLED: 'false' } as Env)).status).toBe(404);
    expect((await handleIosPilot(new Request('https://foreign.test/mobile-pilot/v1/session'), env)).status).toBe(404);
    expect((await route('/api/mobile-pilot/authorize?redirect_uri=https://attacker.test')).status).toBe(400);
  });
  it('stores only credential hashes; produces minimal read-only session with bounded expiry', async () => {
    const token = await signIn();
    expect(token.tokenType).toBe('Bearer'); expect(token.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token.expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 900);
    const rows = await db.prepare('SELECT * FROM ios_pilot_sessions').all();
    expect(JSON.stringify(rows.results)).not.toContain(token.accessToken);
    expect(rows.results[0]).toHaveProperty('token_hash', await sha256(token.accessToken));
    const response = await read('/mobile-pilot/v1/session', token);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ schemaVersion: 1, readOnly: true,
      user: { id: fixture.owner.id, email: fixture.owner.email, displayName: 'Synthetic Owner' }, expiresAt: token.expiresAt });
  });
  it('rejects wrong PKCE/state without creating sessions; atomic concurrent redemption has one winner', async () => {
    const value = await code();
    expect((await exchange(value, { codeVerifier: 'x'.repeat(64) })).status).toBe(401);
    expect((await exchange(value, { state: 'x'.repeat(43) })).status).toBe(401);
    expect(await db.prepare('SELECT count(*) n FROM ios_pilot_sessions').first('n')).toBe(0);
    const responses = await Promise.all([exchange(value), exchange(value)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 401]);
    expect((await exchange(value)).status).toBe(401);
  });
  it('rejects expired codes, sessions and inactive staff', async () => {
    const value = await code(); await db.prepare('UPDATE ios_pilot_codes SET expires_at=0').run();
    expect((await exchange(value)).status).toBe(401);
    const token = await signIn(); await db.prepare('UPDATE ios_pilot_sessions SET expires_at=0').run();
    expect((await read('/mobile-pilot/v1/session', token)).status).toBe(401);
    const active = await signIn(); await db.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").bind(fixture.owner.id).run();
    expect((await read('/mobile-pilot/v1/session', active)).status).toBe(401);
  });
  it('caps session at Access expiry and fences issuer changes', async () => {
    access.claims = { ...access.claims, expiresAt: Math.floor(Date.now() / 1000) + 30 };
    const token = await signIn(); expect(token.expiresAt).toBe(access.claims.expiresAt);
    expect((await route('/mobile-pilot/v1/session', { headers: { Authorization: `Bearer ${token.accessToken}` } },
      { ...env, TEAM_DOMAIN: 'https://changed.cloudflareaccess.com' })).status).toBe(401);
    expect((await route('/mobile-pilot/v1/session', { headers: { Authorization: `Bearer ${token.accessToken}` } },
      { ...env, OPERATIONS_AUD: 'changed-staff-audience' })).status).toBe(401);
  });
  it('enforces cutover mode, admission version and active admission without auto-provisioning', async () => {
    await db.prepare('UPDATE native_staff_access_reconciliation SET enabled=0').run();
    const old = await signIn(); await db.prepare('UPDATE native_staff_access_reconciliation SET enabled=1').run();
    expect((await read('/mobile-pilot/v1/session', old)).status).toBe(401);
    const current = await signIn(); await db.prepare('UPDATE native_staff_admissions SET version=version+1 WHERE staff_id=?').bind(fixture.owner.id).run();
    expect((await read('/mobile-pilot/v1/session', current)).status).toBe(401);
    const admitted = await signIn(); await db.prepare('UPDATE native_staff_admissions SET active=0 WHERE staff_id=?').bind(fixture.owner.id).run();
    expect((await read('/mobile-pilot/v1/session', admitted)).status).toBe(403);
  });
  it('revokes logout immediately and rejects in-flight session proofs after logout', async () => {
    const token = await signIn(), request = new Request(origin + '/mobile-pilot/v1/session', { headers: { Authorization: `Bearer ${token.accessToken}` } });
    const pending = await authenticatePilotSession(request, env, origin);
    expect((await read('/mobile-pilot/v1/session', token, 'DELETE')).status).toBe(204);
    expect((await read('/mobile-pilot/v1/session', token)).status).toBe(401);
    await expect(recheckPilotSession(env, pending)).rejects.toMatchObject({ status: 401 });
  });
  it('cannot mutate operations or use general web API authentication even for owner', async () => {
    const token = await signIn();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect((await read('/mobile-pilot/v1/operations', token, method)).status).toBe(405);
    expect((await read('/mobile-pilot/v1/tasks', token)).status).toBe(404);
    await expect(authenticateStaff(new Request(origin + '/api/operations', { method: 'POST', headers: {
      Authorization: `Bearer ${token.accessToken}`, Origin: origin, 'X-CSRF-Token': 'forged' } }), env)).rejects.toMatchObject({ status: 401 });
    expect((await route('/mobile-pilot/v1/session', { headers: { Authorization: `Bearer ${token.accessToken}`, Cookie: 'CF_Authorization=ambient' } })).status).toBe(403);
  });
  it('reads only current source-qualified assignments; hides cross-source and unassigned detail', async () => {
    await db.prepare("UPDATE staff_role_assignments SET role_id='role-operator' WHERE staff_id=?").bind(fixture.owner.id).run();
    await operation('assigned'); await operation('unassigned'); await operation('foreign', 'project-alpha:other');
    await db.batch([db.prepare("INSERT INTO pa_connectors VALUES('project-alpha:other',1)"),
      db.prepare("INSERT INTO pa_operation_assignments VALUES('assigned','pa-human',1)"), db.prepare("INSERT INTO pa_operation_assignments VALUES('foreign','pa-human',1)")]);
    const token = await signIn();
    const list = await (await read('/mobile-pilot/v1/operations', token)).json() as { operations: Array<{id:string}>;nextCursor:null };
    expect(list.operations.map(o => o.id)).toEqual(['assigned']); expect(list.nextCursor).toBeNull();
    expect((await read('/mobile-pilot/v1/operations/assigned', token)).status).toBe(200);
    expect((await read('/mobile-pilot/v1/operations/unassigned', token)).status).toBe(404);
    expect((await read('/mobile-pilot/v1/operations/foreign', token)).status).toBe(404);
    await db.prepare("UPDATE pa_operation_assignments SET active=0 WHERE operation_id='assigned'").run();
    expect((await read('/mobile-pilot/v1/operations/assigned', token)).status).toBe(404);
  });
  it('paginates without fabricated totals and enforces permission denies and hidden sources', async () => {
    const statements = Array.from({ length: 52 }, (_, i) => db.prepare(`INSERT INTO pa_operations VALUES(?,'project-alpha:primary','project','Test','draft',NULL,NULL,NULL,1)`).bind(`op-${String(i).padStart(3, '0')}`));
    await db.batch(statements); const token = await signIn();
    const first = await (await read('/mobile-pilot/v1/operations', token)).json() as { operations: unknown[]; nextCursor: string };
    expect(first.operations).toHaveLength(50); expect(first).not.toHaveProperty('total');
    const second = await (await read('/mobile-pilot/v1/operations?cursor=' + first.nextCursor, token)).json() as { operations: unknown[]; nextCursor: null };
    expect(second.operations).toHaveLength(2); expect(second.nextCursor).toBeNull();
    await db.prepare("INSERT INTO pa_connectors VALUES('project-alpha:primary',0)").run();
    expect((await (await read('/mobile-pilot/v1/operations', token)).json() as {operations:unknown[]}).operations).toHaveLength(0);
    await db.prepare("INSERT INTO staff_permission_overrides(staff_id,permission_key,effect,scope) VALUES(?,'operations.view','deny','global')").bind(fixture.owner.id).run();
    expect((await read('/mobile-pilot/v1/operations', token)).status).toBe(403);
  });
  it('malformed or required absent connector configuration fails closed without reconciliation writes', async () => {
    const token = await signIn();
    for (const extra of [{ PROJECT_ALPHA_CONNECTOR_SOURCES: '{bad' }, { PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED: 'true' }]) {
      expect((await route('/mobile-pilot/v1/operations', { headers: { Authorization: `Bearer ${token.accessToken}` } }, { ...env, ...extra })).status).toBe(503);
    }
    expect(await db.prepare('SELECT count(*) n FROM pa_connectors').first('n')).toBe(0);
  });
  it.each(['assignment', 'source', 'logout'] as const)('rejects %s revocation between the first data query and response', async kind => {
    await db.prepare("UPDATE staff_role_assignments SET role_id='role-operator' WHERE staff_id=?").bind(fixture.owner.id).run();
    await operation('race'); await db.prepare("INSERT INTO pa_operation_assignments VALUES('race','pa-human',1)").run();
    const token = await signIn();
    const raced = raceEnvironment(async () => {
      if (kind === 'assignment') return db.prepare("UPDATE pa_operation_assignments SET active=0 WHERE operation_id='race'").run();
      if (kind === 'source') return db.prepare("INSERT INTO pa_connectors VALUES('project-alpha:primary',0)").run();
      return db.prepare('DELETE FROM ios_pilot_sessions').run();
    });
    const response = await route('/mobile-pilot/v1/operations', { headers: { Authorization: `Bearer ${token.accessToken}` } }, raced);
    expect(response.status).toBe(kind === 'logout' ? 401 : 403);
    expect(await response.text()).not.toContain('Operation race');
  });
  it('linked alternate login revocation invalidates its mobile session', async () => {
    const primary = await resolveVerifiedStaffLogin(db, access.claims);
    const intent = await createStaffLoginBindingIntent(db, primary!.proof, fixture.owner.alternate);
    access.claims = staffLoginClaims(fixture.owner.alternate, fixture.owner.alternateSubject);
    const linked = await claimStaffLoginBindingIntent(db, access.claims, intent);
    const token = await signIn();
    const owner = await resolveVerifiedStaffLogin(db, staffLoginClaims(fixture.owner.email, fixture.owner.subject));
    await revokeStaffLoginBinding(db, owner!.proof, { bindingId: linked.bindingId, expectedVersion: 1 });
    expect((await read('/mobile-pilot/v1/session', token)).status).toBe(401);
  });
});
