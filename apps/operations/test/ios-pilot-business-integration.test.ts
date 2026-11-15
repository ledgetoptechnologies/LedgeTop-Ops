import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { Miniflare } from 'miniflare';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { importCase, type ImportFixture } from './helpers/native-existing-import-fixture';
import type { Env } from '../src/worker/types';
import type { PilotBusinessRoot, PilotBusinessProject } from '../src/worker/ios-pilot-business-reads';

const jwks = vi.hoisted(() => ({ publicKey: undefined as unknown }));
vi.mock('../src/worker/access-jwks', () => ({ accessJwksResolver: () => jwks.publicKey }));
import { readPilotBusinessRpc } from '../src/worker/ios-pilot-business-rpc';
import { verifyPilotAccessAssertion } from '../src/worker/ios-pilot-access';
import { pilotSessionFromAccessClaims } from '../src/worker/ios-pilot-session';
import { createPilotReadBarrier } from '../src/worker/ios-pilot-read-barrier';
import { readPilotBusiness } from '../src/worker/ios-pilot-business-reads';
import { preparePilotStaffSnapshot } from '../src/worker/ios-pilot-staff-snapshot';

const origin = 'https://pilot-business-staging.example.test';
const sourceId = 'project-alpha:staging';
const issuer = 'https://synthetic-team.cloudflareaccess.com';
const pilotAudience = 'synthetic-ios-pilot-business-audience';
const webAudience = 'synthetic-operations-web-audience';
const parse = (value: string) => JSON.parse(value) as { status: number; body: { schemaVersion?: number;
  roots?: PilotBusinessRoot[]; projects?: PilotBusinessProject[]; nextCursor?: string | null } };

describe('private iOS business pilot RPC with signed human identity and full local D1', { timeout: 240_000 }, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let delivery: D1Database;
  let fixture: ImportFixture;
  let env: Env & { IOS_PILOT_BUSINESS_ENABLED: string };
  let privateKey: CryptoKey;
  let rootId: string;
  let projectId: string;
  let rootCursor = '';
  let rootJwt = '';

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    jwks.publicKey = pair.publicKey;
    runtime = new Miniflare({ modules: true, compatibilityDate: '2026-08-06',
      script: "export default {fetch(){return new Response('fixture')}}",
      d1Databases: { OPS_DB: 'ios-pilot-business-ops', DELIVERY_DB: 'ios-pilot-business-delivery' } });
    db = await runtime.getD1Database('OPS_DB') as unknown as D1Database;
    delivery = await runtime.getD1Database('DELIVERY_DB') as unknown as D1Database;

    const opsMigrations = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(opsMigrations).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, opsMigrations), 'utf8')).map(sql => db.prepare(sql)));
    const clientMigrations = new URL('../../client/migrations/', import.meta.url);
    for (const name of readdirSync(clientMigrations).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort())
      await delivery.batch(splitD1MigrationStatements(readFileSync(new URL(name, clientMigrations), 'utf8')).map(sql => delivery.prepare(sql)));

    // The helper seeds source identity, inventory, classic projection, and real
    // native staff admission/profile/grants. It performs no import operation.
    fixture = await importCase(db, 'organization', { sourceId });
    const staffId = fixture.actor.staffId;
    const actor = await db.prepare('SELECT id,email,access_subject FROM staff_users WHERE id=?').bind(staffId)
      .first<{ id: string; email: string; access_subject: string }>();
    if (!actor) throw new Error('synthetic pilot reviewer missing');
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO role_permissions(role_id,permission_key) VALUES('role-owner','team.view')"),
      db.prepare("INSERT OR IGNORE INTO role_permissions(role_id,permission_key) VALUES('role-owner','projects.view')"),
      db.prepare("UPDATE client_hub_directory_state SET ready=1,last_success_at=datetime('now') WHERE id='directory'"),
    ]);
    rootId = fixture.selection.recordId;
    projectId = `pilot-business-project-${fixture.n}`;
    const roots = [fixture];
    for (let i = 0; i < 20; i++) roots.push(await importCase(db, 'organization', { sourceId,
      sourceFixture: { identity: fixture.identity, selection: fixture.selection } }));
    for (const [index, root] of roots.entries()) {
      const name = `${root.profile.name} ${String(index).padStart(2, '0')}`;
      await db.batch([
        db.prepare(`INSERT INTO client_hub_roots(source_id,root_namespace,kind,public_id,pa_public_id,mapping_status,
          display_name,sort_name,status,portal_status,account_count,project_count,request_count,contact_count)
          VALUES(?,'business','organization',?,?,'mapped',?,?,'active','not_provisioned',0,0,0,0)`)
          .bind(sourceId, root.selection.recordId, root.publicId, name, name.toLowerCase()),
        db.prepare(`INSERT INTO client_hub_search_values(source_id,root_namespace,kind,root_public_id,record_type,record_id,field,normalized_value)
          VALUES(?,'business','organization',?,'organization',?,'name',?)`)
          .bind(sourceId, root.selection.recordId, root.selection.recordId, name.toLowerCase()),
      ]);
    }
    await db.batch([
      db.prepare(`INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
        VALUES(?,'project',?,?)`).bind(sourceId, 'synthetic-pa-project', projectId),
      db.prepare(`INSERT INTO pa_projects(id,client_id,organization_id,name,status,start_date,end_date,active,payload_json,last_sync_id,projection_source_id)
        VALUES(?,NULL,?,?,?,? ,NULL,1,'{}','pilot-business-fixture',?)`)
        .bind(projectId, rootId, `Pilot Project ${fixture.n}`, 'active', '2026-11-01', sourceId),
    ]);

    env = { ...fixture.env, ENVIRONMENT: 'staging', PUBLIC_BASE_URL: 'https://ops-staging.example.test',
      TEAM_DOMAIN: issuer, OPERATIONS_AUD: webAudience, OPS_DB: db, DELIVERY_DB: delivery,
      IOS_PILOT_BUSINESS_ENABLED: 'true', IOS_PILOT_BUSINESS_ORIGIN: origin, IOS_PILOT_BUSINESS_AUDIENCE: pilotAudience,
      // The shared RPC envelope validates these trusted entrypoint settings too.
      IOS_MANAGED_PILOT_ENABLED: 'true', IOS_MANAGED_PILOT_ORIGIN: origin,
      IOS_MANAGED_PILOT_AUDIENCE: pilotAudience } as unknown as Env & { IOS_PILOT_BUSINESS_ENABLED: string };
    void actor;
    await watchWrites(db);
    await watchWrites(delivery);
  }, 240_000);

  afterAll(async () => { await runtime?.dispose(); });

  async function assertion(aud = pilotAudience, signingKey = privateKey) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ type: 'app', email: fixture.actor.loginEmail })
      .setProtectedHeader({ alg: 'RS256' }).setIssuer(issuer).setAudience(aud)
      .setSubject(fixture.actor.accessSubject).setIssuedAt(now - 1).setExpirationTime(now + 300).sign(signingKey);
  }
  async function watchWrites(database: D1Database) {
    // D1 owns its _cf_ metadata namespace and refuses application triggers on
    // those tables. Observe every application table, not platform internals.
    const tables = await database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*'")
      .all<{ name: string }>();
    await database.prepare('CREATE TABLE pilot_test_writes(kind TEXT NOT NULL)').run();
    const statements = tables.results.flatMap(({ name }, index) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw Error('unreviewed fixture table identifier');
      return ['INSERT', 'UPDATE', 'DELETE'].map(action => database.prepare(
        `CREATE TRIGGER pilot_write_${index}_${action} AFTER ${action} ON "${name}"
        BEGIN INSERT INTO pilot_test_writes VALUES('${name}:${action}'); END`));
    });
    for (let index = 0; index < statements.length; index += 100) await database.batch(statements.slice(index, index + 100));
  }
  async function clearWriteWatch() {
    await db.prepare('DELETE FROM pilot_test_writes').run();
    await delivery.prepare('DELETE FROM pilot_test_writes').run();
  }
  async function noWrites() {
    expect(await db.prepare('SELECT count(*) n FROM pilot_test_writes').first('n')).toBe(0);
    expect(await delivery.prepare('SELECT count(*) n FROM pilot_test_writes').first('n')).toBe(0);
  }
  const call = async (jwt: string, path = '/mobile-pilot/v1/business-roots') => {
    await clearWriteWatch();
    const result = parse(await readPilotBusinessRpc(JSON.stringify({ url: origin + path, assertion: jwt }), env, [origin]));
    await noWrites();
    return result;
  };

  it('revalidates real project data and signed staff authority in the same OPS read batch', async () => {
    await clearWriteWatch();
    const request = new Request(origin, { headers: { 'Cf-Access-Jwt-Assertion': await assertion() } });
    const claims = await verifyPilotAccessAssertion(request, { teamDomain: issuer, pilotAudience, operationsAudience: webAudience });
    const ops = createPilotReadBarrier(db), delivered = createPilotReadBarrier(delivery);
    const readEnv = { ...env, OPS_DB: ops.database, DELIVERY_DB: delivered.database };
    const current = await pilotSessionFromAccessClaims(readEnv, claims);
    const page = await readPilotBusiness(readEnv, current, { cursor: null, selection: { kind: 'organization', id: rootId } });
    expect(page).toMatchObject({ projects: [{ id: projectId }] });
    await delivered.verify({ session: delivery.withSession('first-primary') });
    const transaction = db.withSession('first-primary');
    const staff = await preparePilotStaffSnapshot(readEnv, transaction, current);
    expect(staff).not.toBeNull();
    await ops.verify({ session: transaction, prefixStatements: staff!.statements,
      checkPrefix: rows => staff!.verify(rows, Math.floor(Date.now() / 1000)) });
    console.info('pilot_business_d1_calls', JSON.stringify({ ops: ops.networkCalls, delivery: delivered.networkCalls }));
    expect(ops.networkCalls + delivered.networkCalls).toBeLessThanOrEqual(50);
    await noWrites();
  });

  it('uses the real signed RPC, source-bound Client Hub helpers, and narrow project projection without writes', async () => {
    const before = await db.prepare('SELECT last_seen_at FROM staff_users WHERE id=?').bind(fixture.actor.staffId).first('last_seen_at');
    rootJwt = await assertion();
    const result = await call(rootJwt);
    expect(result.status).toBe(200);
    expect(result.body.schemaVersion).toBe(1);
    expect(result.body.roots?.[0]).toMatchObject({ sourceId, rootNamespace: 'business',
      kind: 'organization', clientHubRootId: rootId, name: `${fixture.profile.name} 00` });
    expect(result.body.roots).toHaveLength(20);
    expect(JSON.stringify(result.body)).not.toMatch(/email|phone|address|payload|credential|token/i);
    expect(typeof result.body.nextCursor).toBe('string');
    rootCursor = result.body.nextCursor!;

    const projects = await call(await assertion(), `/mobile-pilot/v1/business-roots/organization/${encodeURIComponent(rootId)}/projects`);
    expect(projects.status).toBe(200);
    expect(projects.body).toMatchObject({ schemaVersion: 1, projects: [{ id: projectId, origin: 'pa',
      name: `Pilot Project ${fixture.n}`, status: 'active', startDate: '2026-11-01', endDate: null }] });
    expect(JSON.stringify(projects.body)).not.toMatch(/email|phone|address|payload|credential|token|manager/i);
    expect(await db.prepare('SELECT last_seen_at FROM staff_users WHERE id=?').bind(fixture.actor.staffId).first('last_seen_at')).toEqual(before);
  });

  it('rejects wrong audience and invalid signature', async () => {
    expect((await call(await assertion(webAudience))).status).toBe(401);
    const other = await generateKeyPair('RS256');
    expect((await call(await assertion(pilotAudience, other.privateKey))).status).toBe(401);
  });

  it('rejects deactivated staff and native admission revoked after cutover without issuing a replacement identity', async () => {
    const jwt = await assertion();
    await db.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").bind(fixture.actor.staffId).run();
    try { expect((await call(jwt)).status).toBe(401); }
    finally { await db.prepare("UPDATE staff_users SET status='active' WHERE id=?").bind(fixture.actor.staffId).run(); }
    await db.prepare('UPDATE native_staff_access_reconciliation SET enabled=1 WHERE singleton=1').run();
    await db.prepare('UPDATE native_staff_admissions SET active=0,version=version+1 WHERE staff_id=?').bind(fixture.actor.staffId).run();
    try { expect((await call(jwt)).status).toBe(403); }
    finally {
      await db.prepare('UPDATE native_staff_admissions SET active=1,version=version+1 WHERE staff_id=?').bind(fixture.actor.staffId).run();
      await db.prepare('UPDATE native_staff_access_reconciliation SET enabled=0 WHERE singleton=1').run();
    }
  });

  it('honors actual directory ACL denies and current source visibility', async () => {
    const jwt = await assertion();
    await db.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by)
      VALUES(? ,?,'team.view','deny','global','global',?)`).bind(`pilot-business-deny-${fixture.n}`, fixture.actor.staffId, fixture.actor.staffId).run();
    expect((await call(jwt)).status).toBe(403);
    await db.prepare('DELETE FROM staff_permission_overrides WHERE staff_id=? AND permission_key=\'team.view\'').bind(fixture.actor.staffId).run();

    await db.prepare('UPDATE pa_connectors SET read_visible=0,version=version+1 WHERE source_id=?').bind(sourceId).run();
    try {
      const hidden = await call(jwt);
      expect(hidden.status).toBe(404);
      expect(hidden.body.roots).toBeUndefined();
      expect((await call(jwt, `/mobile-pilot/v1/business-roots/organization/${encodeURIComponent(rootId)}/projects`)).status).not.toBe(200);
    } finally {
      await db.prepare('UPDATE pa_connectors SET read_visible=1,version=version+1 WHERE source_id=?').bind(sourceId).run();
    }
  });

  it('rejects cursor substitution across source, collection, and selected root', async () => {
    const wrongRoot = await call(rootJwt, `/mobile-pilot/v1/business-roots/organization/other-root/projects?cursor=${encodeURIComponent(rootCursor)}`);
    expect(wrongRoot.status).toBe(400);
    const crossCollection = await call(rootJwt, `/mobile-pilot/v1/business-roots/organization/${encodeURIComponent(rootId)}/projects?cursor=${encodeURIComponent(rootCursor)}`);
    expect(crossCollection.status).toBe(400);
  });
});
