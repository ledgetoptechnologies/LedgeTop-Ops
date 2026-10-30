import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { createStaffLoginFixture } from './helpers/staff-login-fixture';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import type { Env } from '../src/worker/types';

const key = vi.hoisted(() => ({ publicKey: undefined as unknown }));
vi.mock('../src/worker/access-jwks', () => ({ accessJwksResolver: () => key.publicKey }));
import { readPilotRpc } from '../src/worker/ios-pilot-read-rpc';
import { handlePilotEdge } from '../src/worker/ios-pilot-edge-bridge';

const origin = 'https://pilot-staging.example.test';
describe('private pilot RPC with signed assertions and local D1', { timeout: 120_000 }, () => {
  let fixture: Awaited<ReturnType<typeof createStaffLoginFixture>>;
  let env: Env;
  let privateKey: CryptoKey;
  beforeAll(async () => {
    const pair = await generateKeyPair('RS256'); privateKey = pair.privateKey; key.publicKey = pair.publicKey;
    fixture = await createStaffLoginFixture();
    env = { ENVIRONMENT: 'staging', PUBLIC_BASE_URL: 'https://ops-staging.example.test',
      IOS_MANAGED_PILOT_ENABLED: 'true', IOS_MANAGED_PILOT_ORIGIN: origin,
      IOS_MANAGED_PILOT_AUDIENCE: 'pilot-audience', TEAM_DOMAIN: fixture.issuer,
      OPERATIONS_AUD: 'web-audience', OPS_DB: fixture.db } as unknown as Env;
    const schema = `
      CREATE TABLE native_staff_access_reconciliation(singleton INTEGER PRIMARY KEY,enabled INTEGER);
      INSERT INTO native_staff_access_reconciliation VALUES(1,1);
      ALTER TABLE staff_role_assignments ADD COLUMN division_id TEXT;
      ALTER TABLE staff_permission_overrides ADD COLUMN division_id TEXT;
      CREATE TABLE local_staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
      CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT);
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
      CREATE TABLE test_writes(kind TEXT);
    `;
    await fixture.db.batch(splitD1MigrationStatements(schema).map(sql => fixture.db.prepare(sql)));
    const watched = ['staff_users', 'staff_role_assignments', 'staff_permission_overrides', 'local_staff_role_assignments',
      'native_staff_admissions', 'pa_operations', 'pa_operation_assignments', 'pa_connectors', 'pa_projects'];
    await fixture.db.batch(watched.flatMap(table => ['INSERT', 'UPDATE', 'DELETE'].map(action =>
      fixture.db.prepare(`CREATE TRIGGER test_${table}_${action} AFTER ${action} ON ${table}
        BEGIN INSERT INTO test_writes VALUES('${table}:${action}'); END`))));
  }, 120_000);
  afterAll(async () => fixture?.runtime.dispose());
  async function assertion(aud = 'pilot-audience', extra: Record<string, unknown> = {}, signingKey = privateKey) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ type: 'app', email: fixture.owner.email, ...extra })
      .setProtectedHeader({ alg: 'RS256' }).setIssuer(fixture.issuer).setAudience(aud)
      .setSubject(fixture.owner.subject).setIssuedAt(now - 1).setExpirationTime(now + 300).sign(signingKey);
  }
  const call = async (jwt: string, path = '/mobile-pilot/v1/session') => JSON.parse(await readPilotRpc(JSON.stringify({
    url: origin + path, assertion: jwt,
  }), env, [origin])) as { status: number; body: { user?: { id: string }; readOnly?: boolean;
    operations?: Array<{ id: string }>; operation?: { id: string } } };

  it('accepts a currently bound human and rejects wrong audience, signature, machine and revoked staff', async () => {
    const valid = await assertion();
    expect(await call(valid)).toMatchObject({ status: 200, body: { readOnly: true, user: { id: fixture.owner.id } } });
    expect((await call(await assertion('web-audience'))).status).toBe(401);
    expect((await call(await assertion('pilot-audience', { service_token_id: 'machine' }))).status).toBe(401);
    const other = await generateKeyPair('RS256');
    expect((await call(await assertion('pilot-audience', {}, other.privateKey))).status).toBe(401);
    await fixture.db.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").bind(fixture.owner.id).run();
    expect((await call(valid)).status).toBe(401);
  });
  it('reapplies assignment and source visibility to list and detail without business updates', async () => {
    const db = fixture.db;
    await db.batch([
      db.prepare("UPDATE staff_users SET status='active',project_alpha_user_id='pa-human' WHERE id=?").bind(fixture.owner.id),
      db.prepare("UPDATE staff_role_assignments SET role_id='role-operator' WHERE staff_id=?").bind(fixture.owner.id),
      db.prepare("INSERT INTO pa_connectors VALUES('project-alpha:other',1)"),
      ...['assigned','unassigned'].map(id => db.prepare("INSERT INTO pa_operations VALUES(?, 'project-alpha:primary','project',?,'scheduled',NULL,NULL,NULL,1)").bind(id, `Operation ${id}`)),
      db.prepare("INSERT INTO pa_operations VALUES('foreign','project-alpha:other','project','Foreign','scheduled',NULL,NULL,NULL,1)"),
      db.prepare("INSERT INTO pa_operation_assignments VALUES('assigned','pa-human',1)"),
      db.prepare("INSERT INTO pa_operation_assignments VALUES('foreign','pa-human',1)"),
      db.prepare('DELETE FROM test_writes'),
    ]);
    const jwt = await assertion();
    const list = await call(jwt, '/mobile-pilot/v1/operations');
    expect(list.status).toBe(200);
    expect(list.body.operations?.map(item => item.id)).toEqual(['assigned']);
    expect((await call(jwt, '/mobile-pilot/v1/operations/assigned')).body.operation?.id).toBe('assigned');
    expect((await call(jwt, '/mobile-pilot/v1/operations/unassigned')).status).toBe(404);
    expect((await call(jwt, '/mobile-pilot/v1/operations/foreign')).status).toBe(404);
    expect(await db.prepare('SELECT count(*) n FROM test_writes').first('n')).toBe(0);
  });
  it('passes the edge and private RPC through signed identity and read authorization without business writes', async () => {
    const db = fixture.db;
    await db.batch([
      db.prepare("UPDATE staff_users SET status='active',project_alpha_user_id='pa-human' WHERE id=?").bind(fixture.owner.id),
      db.prepare("UPDATE staff_role_assignments SET role_id='role-operator' WHERE staff_id=?").bind(fixture.owner.id),
      db.prepare('DELETE FROM pa_operations'), db.prepare('DELETE FROM pa_operation_assignments'), db.prepare('DELETE FROM pa_connectors'),
      db.prepare("INSERT INTO pa_connectors VALUES('project-alpha:other',1)"),
      ...['edge-assigned','edge-unassigned'].map(id => db.prepare("INSERT INTO pa_operations VALUES(?, 'project-alpha:primary','project',?,'scheduled',NULL,NULL,NULL,1)").bind(id, `Operation ${id}`)),
      db.prepare("INSERT INTO pa_operations VALUES('edge-foreign','project-alpha:other','project','Foreign','scheduled',NULL,NULL,NULL,1)"),
      db.prepare("INSERT INTO pa_operation_assignments VALUES('edge-assigned','pa-human',1)"),
      db.prepare("INSERT INTO pa_operation_assignments VALUES('edge-foreign','pa-human',1)"),
      db.prepare('DELETE FROM test_writes'),
    ]);
    const valid = await assertion();
    const service = { read: (input: string) => readPilotRpc(input, env, [origin]) };
    const edgeEnv = { ENVIRONMENT: 'staging', IOS_MANAGED_PILOT_ENABLED: 'true', IOS_MANAGED_PILOT_ORIGIN: origin, IOS_PILOT_READ: service };
    const edgeCall = (path: string, jwt = valid, method = 'GET') => handlePilotEdge(new Request(origin + path,
      { method, headers: { Authorization: 'Bearer oauth:synthetic', 'Cf-Access-Jwt-Assertion': jwt } }), edgeEnv, [origin]);
    expect((await edgeCall('/mobile-pilot/v1/session')).status).toBe(200);
    const list = await edgeCall('/mobile-pilot/v1/operations');
    expect(list.status).toBe(200);
    expect((await list.json() as { operations: Array<{ id: string }> }).operations.map(item => item.id)).toEqual(['edge-assigned']);
    expect((await edgeCall('/mobile-pilot/v1/operations/edge-assigned')).status).toBe(200);
    expect((await edgeCall('/mobile-pilot/v1/operations/edge-unassigned')).status).toBe(404);
    expect((await edgeCall('/mobile-pilot/v1/operations/edge-foreign')).status).toBe(404);
    expect((await edgeCall('/mobile-pilot/v1/session', await assertion('web-audience'))).status).toBe(401);
    expect((await edgeCall('/mobile-pilot/v1/operations', valid, 'POST')).status).toBe(405);
    expect(await db.prepare('SELECT count(*) n FROM test_writes').first('n')).toBe(0);
  });
});
