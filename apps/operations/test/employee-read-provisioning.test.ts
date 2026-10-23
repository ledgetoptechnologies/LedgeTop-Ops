import { readFileSync, readdirSync } from 'node:fs';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { resolveNativeStaffIdentityWithAdmissionVersion } from '../src/worker/native-staff-identity';
import type { AuthenticatedNativeStaffWithAdmissionVersion as Actor } from '../src/worker/native-staff-auth';
import { parseEmployeeReadCommand, provisionEmployeeRead as provision, recordEmployeeContentStart as audit } from '../src/worker/employee-read-provisioning';
import { resolveEmployeeReadAuthority as resolve, recheckEmployeeReadAuthority as recheck, listEmployeeReadRoots } from '../src/worker/employee-read-authority';
import { createEmployeeReadAdminRouter } from '../src/worker/employee-read-admin-routes';

const uuid = () => crypto.randomUUID();
describe('native employee read provisioning and audit against full source223 D1', () => {
  let mf: Miniflare, db: D1Database, owner: Actor, employee: Actor, gatewayId: string, rootId: string;
  const fingerprint = 'a'.repeat(64), origin = 'https://ops.example.invalid';
  beforeAll(async () => {
    mf = new Miniflare({ modules: true, compatibilityDate: '2026-08-06', script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
    db = await mf.getD1Database('DB') as D1Database;
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/u.test(name) && name.slice(0, 4) <= '0223').sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), 'utf8')).map(sql => db.prepare(sql)));
  }, 90_000);
  afterAll(async () => { await mf?.dispose(); });
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
  beforeEach(async () => { owner = await person('role-owner'); employee = await person(); gatewayId = uuid(); rootId = uuid(); });
  const register = () => ({ commandId: uuid(), kind: 'register-root', rootId, gatewayId, rootFingerprint: fingerprint, displayName: 'Greenleaf server files' });
  const grant = (kind = 'grant-read') => ({ commandId: uuid(), kind, rootId, rootGeneration: 1, rootFingerprint: fingerprint, grantId: uuid(),
    targetStaffId: employee.identity.staffId, targetAccessSubject: employee.identity.verifiedAccessSubject, targetAdmissionVersion: employee.admissionVersion,
    expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  const run = (command: unknown, actor = owner, database = db) => provision(database, actor, command, { gatewayIds: [gatewayId] });
  async function count(table: string, commandId: string): Promise<number> {
    return (await db.prepare(`SELECT COUNT(*) count FROM ${table} WHERE command_id=?`).bind(commandId).first<{ count: number }>())!.count;
  }
  it('registers labels and exact root grants with durable actor-attributed receipts and audit', async () => {
    const command = register(), grantCommand = grant();
    expect(await run(command)).toMatchObject({ rootId, generation: 1, kind: 'register-root' });
    expect(await run(grantCommand)).toMatchObject({ rootId, grantId: grantCommand.grantId, generation: 1 });
    expect(await listEmployeeReadRoots(db, employee)).toEqual([{ rootId, gatewayId, displayName: command.displayName }]);
    const receipt = await db.prepare('SELECT * FROM ops_employee_read_commands WHERE command_id=?').bind(grantCommand.commandId).first();
    expect(receipt).toMatchObject({ actor_staff_id: owner.identity.staffId, actor_access_subject: owner.identity.verifiedAccessSubject,
      actor_admission_version: 1, actor_profile_version: 1, actor_email: owner.identity.email });
    expect(await count('ops_employee_read_mutation_audit', grantCommand.commandId)).toBe(1);
    expect(await count('ops_employee_read_issuers', grantCommand.commandId)).toBe(1);
  });
  it('makes replay idempotent and never revives a revoked grant; changed actor or payload conflicts', async () => {
    await run(register()); const command = grant();
    const receipt = await run(command); expect(await run({ ...command })).toEqual(receipt);
    await run({ commandId: uuid(), kind: 'revoke-grant', grantId: command.grantId, expectedGeneration: 1 });
    expect(await run(command)).toEqual(receipt);
    expect(await resolve(db, employee, rootId)).toBeNull();
    expect(await db.prepare('SELECT active,grant_generation FROM ops_employee_read_grants WHERE grant_id=?').bind(command.grantId).first()).toEqual({ active: 0, grant_generation: 2 });
    expect(await count('ops_employee_read_mutation_audit', command.commandId)).toBe(1);
    await expect(run({ ...command, expiresAt: command.expiresAt + 60 })).rejects.toMatchObject({ status: 409 });
    await expect(run(command, await person('role-owner'))).rejects.toMatchObject({ status: 409 });
  });
  it('denies nonmanagers, missing explicit permission and any-scope permission denies', async () => {
    await expect(run(register(), employee)).rejects.toMatchObject({ status: 403 });
    await db.prepare("DELETE FROM role_permissions WHERE role_id='role-owner' AND permission_key='employee.files.manage'").run();
    try { await expect(run(register())).rejects.toMatchObject({ status: 403 }); }
    finally { await db.prepare("INSERT INTO role_permissions VALUES('role-owner','employee.files.manage')").run(); }
    for (const scope of ['global', 'assigned', 'own']) {
      const actor = await person('role-owner');
      await db.prepare("INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by) VALUES(?,?,'employee.files.manage','deny',?,?,?)")
        .bind(uuid(), actor.identity.staffId, scope, scope, owner.identity.staffId).run();
      await expect(run(register(), actor)).rejects.toMatchObject({ status: 403 });
    }
  });
  it('does not turn admin management into implicit file read access', async () => {
    await run(register()); expect(await resolve(db, owner, rootId)).toBeNull();
    const admin = await person('role-admin'); await run({ ...register(), rootId: uuid() }, admin);
    expect(await listEmployeeReadRoots(db, admin)).toEqual([]);
  });
  it('binds target admission, current root pins and configured gateway', async () => {
    await run(register()); const command = grant();
    for (const changes of [{ rootGeneration: 2 }, { rootFingerprint: 'b'.repeat(64) }, { targetAccessSubject: 'other' }, { targetAdmissionVersion: 2 }])
      await expect(run({ ...command, commandId: uuid(), ...changes })).rejects.toMatchObject({ status: 409 });
    await expect(run({ ...register(), rootId: uuid(), gatewayId: uuid() })).rejects.toMatchObject({ status: 403 });
    await db.prepare('UPDATE native_staff_admissions SET active=0,version=version+1 WHERE staff_id=?').bind(employee.identity.staffId).run();
    await expect(run(command)).rejects.toMatchObject({ status: 409 });
  });
  it('advances root labels/remaps/disables with optimistic generation and invalidates old grants', async () => {
    await run(register()); await run(grant()); const proof = await resolve(db, employee, rootId);
    const change = { commandId: uuid(), kind: 'advance-root', rootId, expectedGeneration: 1, rootFingerprint: 'b'.repeat(64), displayName: 'Updated files', status: 'disabled' };
    expect(await run(change)).toMatchObject({ generation: 2 }); expect(await run(change)).toMatchObject({ generation: 2 });
    expect(await recheck(db, proof!)).toBe(false);
    await expect(run({ ...change, commandId: uuid() })).rejects.toMatchObject({ status: 409 });
  });
  it('a current exact deny overrides read allows', async () => {
    await run(register()); await run(grant()); const proof = await resolve(db, employee, rootId);
    await run(grant('deny-read')); expect(await recheck(db, proof!)).toBe(false); expect(await resolve(db, employee, rootId)).toBeNull();
  });
  it('same-batch authorization races roll back every write', async () => {
    const session = db.withSession('first-primary');
    const raced = { withSession: () => ({ prepare: (sql: string) => session.prepare(sql), batch: (statements: D1PreparedStatement[]) => session.batch([
      session.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").bind(owner.identity.staffId), ...statements,
    ]) }) } as unknown as D1Database;
    const command = register();
    await expect(run(command, owner, raced)).rejects.toMatchObject({ status: 403 });
    expect(await db.prepare('SELECT status FROM staff_users WHERE id=?').bind(owner.identity.staffId).first()).toEqual({ status: 'active' });
    expect(await count('ops_employee_read_commands', command.commandId)).toBe(0);
    expect(await db.prepare('SELECT root_id FROM ops_employee_read_roots WHERE root_id=?').bind(rootId).first()).toBeNull();
  });
  it('audit failures roll back mutation, receipt and issuer rows', async () => {
    const command = register();
    await db.prepare(`CREATE TRIGGER synthetic_employee_audit_failure BEFORE INSERT ON ops_employee_read_mutation_audit
      WHEN NEW.command_id='${command.commandId}' BEGIN SELECT RAISE(ABORT,'synthetic audit refusal'); END`).run();
    await expect(run(command)).rejects.toMatchObject({ status: 503 });
    expect(await count('ops_employee_read_commands', command.commandId)).toBe(0);
    expect(await count('ops_employee_read_mutation_audit', command.commandId)).toBe(0);
    expect(await count('ops_employee_read_issuers', command.commandId)).toBe(0);
    expect(await db.prepare('SELECT root_id FROM ops_employee_read_roots WHERE root_id=?').bind(rootId).first()).toBeNull();
  });
  it('same-batch target admission and root changes cannot race a grant mutation', async () => {
    await run(register());
    for (const mutate of [
      db.prepare('UPDATE native_staff_admissions SET active=0,version=version+1 WHERE staff_id=?').bind(employee.identity.staffId),
      db.prepare("UPDATE ops_employee_read_roots SET status='disabled',root_generation=root_generation+1 WHERE root_id=?").bind(rootId),
    ]) {
      const session = db.withSession('first-primary');
      const raced = { withSession: () => ({ prepare: (sql: string) => session.prepare(sql), batch: (statements: D1PreparedStatement[]) => session.batch([mutate, ...statements]) }) } as unknown as D1Database;
      const command = grant();
      await expect(run(command, owner, raced)).rejects.toMatchObject({ status: 409 });
      expect(await count('ops_employee_read_commands', command.commandId)).toBe(0);
      expect(await db.prepare('SELECT grant_id FROM ops_employee_read_grants WHERE grant_id=?').bind(command.grantId).first()).toBeNull();
    }
    expect(await db.prepare('SELECT active,version FROM native_staff_admissions WHERE staff_id=?').bind(employee.identity.staffId).first()).toEqual({ active: 1, version: 1 });
    expect(await db.prepare('SELECT status,root_generation FROM ops_employee_read_roots WHERE root_id=?').bind(rootId).first()).toEqual({ status: 'active', root_generation: 1 });
  });
  it('records exact content start pins with hashed paths and fails closed on revoke or audit error', async () => {
    await run(register()); const command = grant(); await run(command); const proof = (await resolve(db, employee, rootId))!;
    const selection = { operation: 'content' as const, path: 'photos/private.bin', expectedSha256: 'c'.repeat(64), snapshotId: uuid(), range: { start: 10, end: 20 } };
    await audit(db, proof, selection);
    const row = await db.prepare('SELECT * FROM ops_employee_read_content_starts WHERE grant_id=?').bind(command.grantId).first();
    expect(row).toMatchObject({ staff_id: employee.identity.staffId, access_subject: employee.identity.verifiedAccessSubject,
      root_id: rootId, grant_id: command.grantId, snapshot_id: selection.snapshotId, sha256: selection.expectedSha256, range_start: 10, range_end: 20 });
    expect(JSON.stringify(row)).not.toContain(selection.path);
    await run({ commandId: uuid(), kind: 'revoke-grant', grantId: command.grantId, expectedGeneration: 1 });
    await expect(audit(db, proof, selection)).rejects.toThrow('employee-content-audit-denied');
  });
  it('rechecks read authority inside the audit insert transaction after a delayed precheck', async () => {
    await run(register()); const command = grant(); await run(command); const proof = (await resolve(db, employee, rootId))!;
    let revoked = false;
    const delayed = { withSession: (hint: D1SessionConstraint) => {
      const session = db.withSession(hint);
      return { prepare: (sql: string) => ({ bind: (...values: (string | number | null)[]) => {
        const statement = session.prepare(sql).bind(...values);
        return { first: () => statement.first(), run: async () => {
          revoked = true; await db.prepare('UPDATE ops_employee_read_grants SET active=0,grant_generation=grant_generation+1 WHERE grant_id=?').bind(command.grantId).run();
          return statement.run();
        } };
      } }) };
    } } as unknown as D1Database;
    await expect(audit(delayed, proof, { operation: 'content', path: 'file.bin', expectedSha256: 'c'.repeat(64), snapshotId: uuid(), range: null })).rejects.toThrow();
    expect(revoked).toBe(true);
    expect(await db.prepare('SELECT event_id FROM ops_employee_read_content_starts WHERE grant_id=?').bind(command.grantId).first()).toBeNull();
  });
  it('a storage audit failure denies handoff without persisting a partial content-start record', async () => {
    await run(register()); await run(grant()); const proof = (await resolve(db, employee, rootId))!, snapshot = uuid();
    await db.prepare(`CREATE TRIGGER synthetic_content_audit_failure BEFORE INSERT ON ops_employee_read_content_starts
      WHEN NEW.snapshot_id='${snapshot}' BEGIN SELECT RAISE(ABORT,'synthetic content audit refusal'); END`).run();
    await expect(audit(db, proof, { operation: 'content', path: 'file.bin', expectedSha256: 'c'.repeat(64), snapshotId: snapshot, range: null })).rejects.toThrow('employee-content-audit-denied');
    expect(await db.prepare('SELECT event_id FROM ops_employee_read_content_starts WHERE snapshot_id=?').bind(snapshot).first()).toBeNull();
  });
  it('grant authority follows the target admission epoch while each read captures its current profile version', async () => {
    await run(register()); await run(grant()); const old = (await resolve(db, employee, rootId))!;
    await db.prepare("UPDATE native_staff_profiles SET display_name='Updated employee',version=version+1 WHERE staff_id=?").bind(employee.identity.staffId).run();
    expect(await recheck(db, old)).toBe(false);
    const current = await resolveNativeStaffIdentityWithAdmissionVersion(db, { verifiedEmail: employee.identity.email, verifiedAccessSubject: employee.identity.verifiedAccessSubject });
    const refreshed = { ...current!, verifiedUntil: employee.verifiedUntil };
    expect((await resolve(db, refreshed, rootId))?.profileVersion).toBe(2);
    expect((await resolve(db, refreshed, rootId))?.grantId).toBe(old.grantId);
  });
  it('rejects unknown command fields, getters, paths and noncanonical scalars before mutation', () => {
    for (const command of [{ ...register(), hostPath: '/etc' }, { ...register(), displayName: 'bad\nlabel' }, { ...grant(), rootGeneration: true }, { ...register(), rootId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }])
      expect(() => parseEmployeeReadCommand(command)).toThrow();
    let called = false;
    const value = Object.defineProperty(register(), 'displayName', { enumerable: true, get: () => { called = true; return 'no'; } });
    expect(() => parseEmployeeReadCommand(value)).toThrow(); expect(called).toBe(false);
  });
  it('unmounted admin factory defaults off and enforces exact Origin, human auth and bounded duplicate-free JSON', async () => {
    const config = { enabled: true, opsOrigin: origin, access: { enabled: true, issuer: 'https://synthetic.cloudflareaccess.com', staffAudience: 'synthetic-audience-123456' }, gatewayIds: [gatewayId] };
    const app = createEmployeeReadAdminRouter(config, { database: db, authenticate: async () => owner });
    const send = (body: string, headers: Record<string, string> = {}) => app.request(origin + '/api/admin/employee-files/commands', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body });
    expect((await send(JSON.stringify(register()), { Origin: 'https://other.example.invalid' })).status).toBe(403);
    expect((await send('{"kind":"register-root","kind":"grant-read"}')).status).toBe(400);
    expect((await send('x'.repeat(8193))).status).toBe(400);
    expect((await send(JSON.stringify(register()))).status).toBe(200);
    const disabled = createEmployeeReadAdminRouter({ ...config, enabled: false }, { database: db, authenticate: async () => { throw Error(); } });
    expect((await disabled.request(origin + '/api/admin/employee-files/commands', { method: 'POST' })).status).toBe(404);
    const unauthenticated = createEmployeeReadAdminRouter(config, { database: db, authenticate: async () => { throw Error('secret'); } });
    expect((await unauthenticated.request(origin + '/api/admin/employee-files/commands', { method: 'POST', headers: { Origin: origin } })).status).toBe(401);
  });
  it('captures enrollment and authentication configuration before asynchronous request work', async () => {
    const config = { enabled: true, opsOrigin: origin, access: { enabled: true, issuer: 'https://synthetic.cloudflareaccess.com', staffAudience: 'synthetic-audience-123456' }, gatewayIds: [gatewayId] };
    const dependencies = { database: db, authenticate: async (_request: Request, _database: D1Database, access: typeof config.access) => {
      expect(access.enabled).toBe(true); expect(Object.isFrozen(access)).toBe(true);
      config.enabled = false; config.opsOrigin = 'https://other.example.invalid'; config.access.enabled = false; config.gatewayIds[0] = uuid();
      dependencies.authenticate = async () => { throw Error('new callback must not run'); };
      dependencies.database = {} as D1Database;
      await Promise.resolve();
      return owner;
    } };
    const app = createEmployeeReadAdminRouter(config, dependencies);
    const command = register();
    const response = await app.request(origin + '/api/admin/employee-files/commands', { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    expect(response.status).toBe(200);
    expect(await db.prepare('SELECT gateway_id FROM ops_employee_read_roots WHERE root_id=?').bind(rootId).first()).toEqual({ gateway_id: gatewayId });
  });
});
