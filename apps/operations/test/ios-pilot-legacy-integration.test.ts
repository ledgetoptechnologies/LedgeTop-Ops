import { describe, expect, it, vi } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { createStaffLoginFixture, seedStaffLoginOwner } from './helpers/staff-login-fixture';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import type { Env } from '../src/worker/types';

const key = vi.hoisted(() => ({ publicKey: undefined as unknown }));
vi.mock('../src/worker/access-jwks', () => ({ accessJwksResolver: () => key.publicKey }));
import { readPilotRpc } from '../src/worker/ios-pilot-read-rpc';
import { handlePilotEdge } from '../src/worker/ios-pilot-edge-bridge';

describe('synthetic pilot on pre-cutover staff schema', { timeout: 120_000 }, () => {
  it('permits an already-bound active primary under disabled control and fails closed on authority changes', async () => {
    const local = await createStaffLoginFixture({ includeCompatibilityDatabases: true });
    try {
      const db = local.legacy!;
      const owner = await seedStaffLoginOwner(db, 'pilot-legacy');
      const schema = `
        CREATE TABLE native_staff_access_reconciliation(singleton INTEGER PRIMARY KEY,enabled INTEGER);
        INSERT INTO native_staff_access_reconciliation VALUES(1,0);
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
        INSERT INTO pa_operations VALUES('assigned','project-alpha:primary','project','Synthetic operation','scheduled',NULL,NULL,NULL,1);
        INSERT INTO pa_operations VALUES('unassigned','project-alpha:primary','project','Other operation','scheduled',NULL,NULL,NULL,1);
        INSERT INTO pa_operation_assignments VALUES('assigned','pa-human',1);
        CREATE TABLE test_writes(kind TEXT);
      `;
      await db.batch(splitD1MigrationStatements(schema).map(sql => db.prepare(sql)));
      await db.batch([
        db.prepare("UPDATE staff_users SET project_alpha_user_id='pa-human' WHERE id=?").bind(owner.id),
        db.prepare("UPDATE staff_role_assignments SET role_id='role-operator' WHERE staff_id=?").bind(owner.id),
        ...['staff_users', 'staff_role_assignments', 'pa_operations', 'pa_operation_assignments', 'pa_connectors'].flatMap(table =>
          ['INSERT', 'UPDATE', 'DELETE'].map(action => db.prepare(`CREATE TRIGGER test_${table}_${action} AFTER ${action} ON ${table}
            BEGIN INSERT INTO test_writes VALUES('${table}:${action}'); END`))),
      ]);
      const pair = await generateKeyPair('RS256'); key.publicKey = pair.publicKey;
      const now = Math.floor(Date.now() / 1000);
      const sign = (email: string, subject: string) => new SignJWT({ type: 'app', email })
        .setProtectedHeader({ alg: 'RS256' }).setIssuer(local.issuer).setAudience('pilot-audience')
        .setSubject(subject).setIssuedAt(now - 1).setExpirationTime(now + 300).sign(pair.privateKey);
      const jwt = await sign(owner.email, owner.subject);
      const origin = 'https://pilot-staging.example.test';
      const env = { ENVIRONMENT: 'staging', PUBLIC_BASE_URL: 'https://ops-staging.example.test',
        IOS_MANAGED_PILOT_ENABLED: 'true', IOS_MANAGED_PILOT_ORIGIN: origin,
        IOS_MANAGED_PILOT_AUDIENCE: 'pilot-audience', TEAM_DOMAIN: local.issuer,
        OPERATIONS_AUD: 'web-audience', OPS_DB: db } as unknown as Env;
      const edgeEnv = { ...env, IOS_PILOT_READ: { read: (input: string) => readPilotRpc(input, env, [origin]) } };
      const context = { aud: 'pilot-audience', getIdentity: async () => ({ user_uuid: owner.subject, email: owner.email }) };
      const request = (path: string, token = jwt, identity = context) => handlePilotEdge(new Request(origin + path,
        { headers: { 'Cf-Access-Jwt-Assertion': token } }), edgeEnv, [origin], identity);
      const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('staff_login_binding_control','staff_login_generations','staff_login_binding_intents','staff_login_bindings','staff_login_binding_audit')").all();
      expect(tables.results).toHaveLength(0);
      expect((await request('/mobile-pilot/v1/session')).status).toBe(200);
      const list = await request('/mobile-pilot/v1/operations');
      expect(list.status).toBe(200);
      expect((await list.json() as { operations: Array<{ id: string }> }).operations.map(item => item.id)).toEqual(['assigned']);
      expect((await request('/mobile-pilot/v1/operations/assigned')).status).toBe(200);
      expect((await request('/mobile-pilot/v1/operations/unassigned')).status).toBe(404);
      const foreignSubject = 'access|foreign';
      expect((await request('/mobile-pilot/v1/session', await sign(owner.email, foreignSubject),
        { aud: 'pilot-audience', getIdentity: async () => ({ user_uuid: foreignSubject, email: owner.email }) })).status).toBe(401);
      expect((await request('/mobile-pilot/v1/session', await sign(owner.alternate, owner.alternateSubject),
        { aud: 'pilot-audience', getIdentity: async () => ({ user_uuid: owner.alternateSubject, email: owner.alternate }) })).status).toBe(401);
      expect(await db.prepare('SELECT count(*) n FROM test_writes').first('n')).toBe(0);
      await db.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").bind(owner.id).run();
      expect((await request('/mobile-pilot/v1/session')).status).toBe(401);
      await db.prepare("UPDATE staff_users SET status='active' WHERE id=?").bind(owner.id).run();
      await db.prepare('UPDATE native_staff_access_reconciliation SET enabled=1 WHERE singleton=1').run();
      // No matching native admission is present for this primary staff member.
      await db.prepare('UPDATE native_staff_admissions SET active=0 WHERE staff_id=?').bind(owner.id).run();
      expect((await request('/mobile-pilot/v1/session')).status).toBe(403);
      await db.prepare('UPDATE native_staff_access_reconciliation SET enabled=0 WHERE singleton=1').run();
      await db.prepare('CREATE TABLE staff_login_binding_control(singleton INTEGER PRIMARY KEY,schema_version INTEGER)').run();
      expect((await request('/mobile-pilot/v1/session')).status).toBe(503);
    } finally { await local.runtime.dispose(); }
  });
});
