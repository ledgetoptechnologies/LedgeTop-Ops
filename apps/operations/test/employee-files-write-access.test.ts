import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { resolveNativeStaffIdentityWithAdmissionVersion } from '../src/worker/native-staff-identity';
import type { AuthenticatedNativeStaffWithAdmissionVersion as Actor } from '../src/worker/native-staff-auth';
import { listEmployeeFilesAccess, provisionEmployeeRead as provision, resolveEmployeeFilesCommandReceipt as resolveReceipt } from '../src/worker/employee-read-provisioning';
import { createEmployeeReadAdminRouter, CSRF_LIFETIME_SECONDS, employeeFilesCsrfValid, issueEmployeeFilesCsrf } from '../src/worker/employee-read-admin-routes';

const uuid = () => crypto.randomUUID();
const directory = new URL('../migrations/', import.meta.url);
const migrate = async (db: D1Database, name: string) =>
  db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), 'utf8')).map(sql => db.prepare(sql)));

describe('0245 staff Files write access: schema gates, provisioning and the Team listing (source-only)', () => {
  let mf: Miniflare, db: D1Database, owner: Actor, employee: Actor, gatewayId: string;
  let legacy: { commandId: string; grantId: string; rootId: string; receipt: unknown };
  const fingerprint = 'b'.repeat(64), origin = 'https://ops.example.invalid', day = 86400, now = () => Math.floor(Date.now() / 1000);

  async function person(role?: string, native = true): Promise<Actor> {
    const id = `employee-${uuid()}`, email = `${id}@example.invalid`, subject = `access|${id}`;
    await db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,'active')").bind(id, email, id, subject).run();
    if (!native) return { identity: { kind: 'native', staffId: id } } as unknown as Actor;
    await db.batch([
      db.prepare('INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)').bind(id, subject, id),
      db.prepare('INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)').bind(id, email, id),
    ]);
    if (role) await db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key,created_by) VALUES(?,?,?,'global','global',?)").bind(uuid(), id, role, id).run();
    const result = await resolveNativeStaffIdentityWithAdmissionVersion(db, { verifiedEmail: email, verifiedAccessSubject: subject });
    return { ...result!, verifiedUntil: new Date(Date.now() + 3600_000).toISOString() };
  }
  const run = (command: unknown, actor = owner) => provision(db, actor, command, { gatewayIds: [gatewayId] });
  const root = (kind: string, rootId = uuid()) => ({ commandId: uuid(), kind, rootId, gatewayId, rootFingerprint: fingerprint, displayName: 'Synthetic files' });
  const grant = (kind: string, rootId: string, target = employee, expiresAt = now() + 3600) => ({ commandId: uuid(), kind, rootId, rootGeneration: 1,
    rootFingerprint: fingerprint, grantId: uuid(), targetStaffId: target.identity.staffId, targetAccessSubject: target.identity.verifiedAccessSubject,
    targetAdmissionVersion: target.admissionVersion, expiresAt });
  const sqlFails = async (promise: Promise<unknown>, text: string) => { await expect(promise).rejects.toThrow(text); };

  beforeAll(async () => {
    mf = new Miniflare({ modules: true, compatibilityDate: '2026-08-06', script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] });
    db = await mf.getD1Database('DB') as D1Database;
    for (const name of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/u.test(name) && name.slice(0, 4) <= '0223').sort()) await migrate(db, name);
    // Rows and receipts written before 0245 must be unchanged by it.
    gatewayId = uuid(); owner = await person('role-owner'); employee = await person();
    // Seeded with the 0223 command table directly: the current Worker code expects 0245 to be applied first.
    const register = root('register-root'), read = grant('grant-read', register.rootId);
    const command = (c: Record<string, unknown>, rootId: string, grantId: string | null) => db.prepare(`INSERT INTO ops_employee_read_commands(command_id,
      request_sha256,action,actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,actor_email,verified_until,root_id,
      configured_gateway_id,grant_id,result_generation,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?)`).bind(c.commandId, 'd'.repeat(64), c.kind,
      owner.identity.staffId, owner.identity.verifiedAccessSubject, owner.admissionVersion, owner.identity.profileVersion, owner.identity.email,
      owner.verifiedUntil, rootId, gatewayId, grantId, JSON.stringify(c)).run();
    await command(register, register.rootId, null);
    await command(read, register.rootId, read.grantId);
    legacy = { commandId: read.commandId, grantId: read.grantId, rootId: register.rootId,
      receipt: { schemaVersion: 1, commandId: read.commandId, kind: 'grant-read', rootId: register.rootId, grantId: read.grantId, generation: 1 } };
    await migrate(db, '0245_staff_files_write_access.sql');
  }, 90_000);
  afterAll(async () => { await mf?.dispose(); });
  beforeEach(async () => { owner = await person('role-owner'); employee = await person(); });

  it('keeps pre-0245 rows and receipts: read rights, shared root, same replayed receipt', async () => {
    expect(await db.prepare('SELECT rights FROM ops_employee_read_grants WHERE grant_id=?').bind(legacy.grantId).first()).toEqual({ rights: 'read' });
    expect(await db.prepare('SELECT exclusive FROM ops_employee_read_roots WHERE root_id=?').bind(legacy.rootId).first()).toEqual({ exclusive: 0 });
    expect(await resolveReceipt(db, legacy.commandId)).toEqual(legacy.receipt);
  });

  it('creates an exclusive root and a read-write grant only through their commands', async () => {
    const register = root('register-exclusive-root');
    expect(await run(register)).toMatchObject({ kind: 'register-exclusive-root', rootId: register.rootId, generation: 1 });
    const write = grant('grant-write', register.rootId);
    expect(await run(write)).toMatchObject({ kind: 'grant-write', grantId: write.grantId, generation: 1 });
    expect(await db.prepare('SELECT g.rights,g.effect,r.exclusive FROM ops_employee_read_grants g JOIN ops_employee_read_roots r USING(root_id) WHERE g.grant_id=?')
      .bind(write.grantId).first()).toEqual({ rights: 'read-write', effect: 'allow', exclusive: 1 });
    expect(await db.prepare('SELECT COUNT(*) n FROM ops_employee_files_write_command_audit WHERE command_id=?').bind(write.commandId).first()).toEqual({ n: 1 });
  });

  it('refuses a write grant on a shared root, over 30 days, or for a legacy (non-native) staff member', async () => {
    const shared = root('register-root'); await run(shared);
    await expect(run(grant('grant-write', shared.rootId))).rejects.toMatchObject({ status: 409, code: 'conflict' });
    const exclusive = root('register-exclusive-root'); await run(exclusive);
    await expect(run(grant('grant-write', exclusive.rootId, employee, now() + 31 * day))).rejects.toMatchObject({ status: 409, code: 'conflict' });
    const legacyStaff = await person(undefined, false);
    await expect(run({ ...grant('grant-write', exclusive.rootId), targetStaffId: legacyStaff.identity.staffId,
      targetAccessSubject: `access|${legacyStaff.identity.staffId}`, targetAdmissionVersion: 1 })).rejects.toMatchObject({ status: 409 });
  });

  it('enforces the 30-day cap, rights and exclusivity inside D1 even without the Worker', async () => {
    const exclusive = root('register-exclusive-root'); await run(exclusive);
    const long = { ...grant('grant-write', exclusive.rootId), expiresAt: now() + 31 * day };
    await sqlFails(db.prepare(`INSERT INTO ops_employee_files_write_commands(command_id,request_sha256,action,actor_staff_id,actor_access_subject,actor_admission_version,
      actor_profile_version,actor_email,verified_until,root_id,configured_gateway_id,grant_id,result_generation,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?)`)
      .bind(long.commandId, 'c'.repeat(64), 'grant-write', owner.identity.staffId, owner.identity.verifiedAccessSubject, owner.admissionVersion,
        owner.identity.profileVersion, owner.identity.email, owner.verifiedUntil, exclusive.rootId, gatewayId, long.grantId, JSON.stringify(long)).run(), 'employee grant conflict');
    await sqlFails(db.prepare('UPDATE ops_employee_read_roots SET exclusive=1 WHERE root_id=?').bind(legacy.rootId).run(), 'exclusivity immutable');
    await sqlFails(db.prepare('UPDATE ops_employee_read_roots SET exclusive=0 WHERE root_id=?').bind(exclusive.rootId).run(), 'exclusivity immutable');
    await sqlFails(db.prepare("INSERT INTO ops_employee_read_roots(root_id,gateway_id,root_fingerprint,status,exclusive) VALUES(?,?,?,'active',1)")
      .bind(uuid(), gatewayId, fingerprint).run(), 'requires its enrollment command');
    const write = grant('grant-write', exclusive.rootId); await run(write);
    await sqlFails(db.prepare("UPDATE ops_employee_read_grants SET rights='read' WHERE grant_id=?").bind(write.grantId).run(), 'rights immutable');
    await sqlFails(db.prepare("UPDATE ops_employee_read_grants SET rights='read-write' WHERE grant_id=?").bind(legacy.grantId).run(), 'rights immutable');
    await sqlFails(db.prepare(`INSERT INTO ops_employee_read_grants(grant_id,root_id,root_generation,root_fingerprint,staff_id,access_subject,admission_version,effect,expires_at,rights)
      VALUES(?,?,1,?,?,?,?,'allow',?,'read-write')`).bind(uuid(), exclusive.rootId, fingerprint, employee.identity.staffId,
      employee.identity.verifiedAccessSubject, employee.admissionVersion, now() + 3600).run(), 'employee write grant requires');
  });

  it('revokes a read-write grant one way through the existing revoke command', async () => {
    const exclusive = root('register-exclusive-root'); await run(exclusive);
    const write = grant('grant-write', exclusive.rootId); await run(write);
    expect(await run({ commandId: uuid(), kind: 'revoke-grant', grantId: write.grantId, expectedGeneration: 1 })).toMatchObject({ generation: 2 });
    await sqlFails(db.prepare('UPDATE ops_employee_read_grants SET active=1,grant_generation=3 WHERE grant_id=?').bind(write.grantId).run(), 'revocation is terminal');
  });

  it('rejects a command id used in the other table, in both insert orders, and never double-applies', async () => {
    const readFirst = root('register-root'); await run(readFirst);
    await expect(run({ ...root('register-exclusive-root'), commandId: readFirst.commandId })).rejects.toMatchObject({ status: 409, code: 'command-conflict' });
    const writeFirst = root('register-exclusive-root'); const receipt = await run(writeFirst);
    await expect(run({ ...root('register-root'), commandId: writeFirst.commandId })).rejects.toMatchObject({ status: 409 });
    for (const id of [readFirst.commandId, writeFirst.commandId]) {
      const rows = await db.prepare(`SELECT (SELECT COUNT(*) FROM ops_employee_read_commands WHERE command_id=?1)
        + (SELECT COUNT(*) FROM ops_employee_files_write_commands WHERE command_id=?1) n`).bind(id).first<{ n: number }>();
      expect(rows!.n).toBe(1);
    }
    expect(await db.prepare('SELECT COUNT(*) n FROM ops_employee_read_roots WHERE root_id=?').bind(writeFirst.rootId).first()).toEqual({ n: 1 });
    expect(await resolveReceipt(db, writeFirst.commandId)).toEqual(receipt);
  });

  it('replays an identical write command and refuses a changed one under the same id', async () => {
    const exclusive = root('register-exclusive-root'); await run(exclusive);
    const write = grant('grant-write', exclusive.rootId), receipt = await run(write);
    expect(await run({ ...write })).toEqual(receipt);
    await expect(run({ ...write, expiresAt: write.expiresAt + 60 })).rejects.toMatchObject({ status: 409, code: 'command-conflict' });
  });

  it('lists one staff member for managers only, with grantable, roots and grants', async () => {
    const exclusive = root('register-exclusive-root'); await run(exclusive);
    const write = grant('grant-write', exclusive.rootId); await run(write);
    const listing = await listEmployeeFilesAccess(db, owner, employee.identity.staffId, { gatewayIds: [gatewayId] });
    expect(listing.canManage).toBe(true);
    expect(listing.target).toEqual({ staffId: employee.identity.staffId, accessSubject: employee.identity.verifiedAccessSubject,
      admissionVersion: employee.admissionVersion, grantable: true });
    expect(listing.roots).toContainEqual({ rootId: exclusive.rootId, name: 'Synthetic files', gatewayId, rootGeneration: 1,
      rootFingerprint: fingerprint, exclusive: true, status: 'active' });
    expect(listing.grants).toContainEqual({ grantId: write.grantId, rootId: exclusive.rootId, rootGeneration: 1, effect: 'allow',
      rights: 'read-write', expiresAt: write.expiresAt, generation: 1, active: true });
    expect(await listEmployeeFilesAccess(db, employee, owner.identity.staffId, { gatewayIds: [gatewayId] }))
      .toEqual({ schemaVersion: 1, canManage: false, target: null, roots: [], grants: [] });
    const legacyStaff = await person(undefined, false);
    expect((await listEmployeeFilesAccess(db, owner, legacyStaff.identity.staffId, { gatewayIds: [gatewayId] })).target)
      .toEqual({ staffId: legacyStaff.identity.staffId, accessSubject: null, admissionVersion: null, grantable: false });
    await expect(listEmployeeFilesAccess(db, owner, 'no-such-staff', { gatewayIds: [gatewayId] })).rejects.toMatchObject({ status: 404 });
  });

  it('CSRF tokens expire at exactly 15 minutes and cannot be extended', async () => {
    const access = { enabled: true, issuer: 'https://example.cloudflareaccess.com', staffAudience: 'a'.repeat(32) }, secret = 's'.repeat(32), t0 = 1_800_000_000;
    const token = await issueEmployeeFilesCsrf(secret, origin, access, owner, t0);
    expect(CSRF_LIFETIME_SECONDS).toBe(900);
    expect(await employeeFilesCsrfValid(token, secret, origin, access, owner, t0)).toBe(true);
    expect(await employeeFilesCsrfValid(token, secret, origin, access, owner, t0 + 899)).toBe(true);
    expect(await employeeFilesCsrfValid(token, secret, origin, access, owner, t0 + 900)).toBe(false);
    const [exp, mac] = token.split('.');
    expect(await employeeFilesCsrfValid(`${Number(exp) + 60}.${mac}`, secret, origin, access, owner, t0)).toBe(false);  // moved expiry
    expect(await employeeFilesCsrfValid(token, secret, origin, access, owner, t0 - 1)).toBe(false);  // more than 15 minutes ahead
    expect(await employeeFilesCsrfValid(token, secret, origin, access, employee, t0)).toBe(false);  // another person
    expect(await employeeFilesCsrfValid(token, 't'.repeat(32), origin, access, owner, t0)).toBe(false);
  });

  it('requires the CSRF token from the listing for browser commands', async () => {
    const router = createEmployeeReadAdminRouter({ enabled: true, opsOrigin: origin + '/'.slice(1),
      access: { enabled: true, issuer: 'https://example.cloudflareaccess.com', staffAudience: 'a'.repeat(32) },
      gatewayIds: [gatewayId], csrfSecret: 's'.repeat(32) }, { database: db, authenticate: async () => owner });
    const headers = { Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
    const listed = await router.fetch(new Request(`${origin}/api/admin/employee-files/staff/${employee.identity.staffId}/grants`, { headers }));
    expect(listed.status).toBe(200);
    const { csrfToken } = await listed.json() as { csrfToken: string };
    const post = (extra: Record<string, string>) => router.fetch(new Request(`${origin}/api/admin/employee-files/commands`, { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(root('register-exclusive-root')) }));
    expect((await post({})).status).toBe(403);
    expect(await (await post({ 'X-CSRF-Token': '0'.repeat(64) })).json()).toEqual({ error: 'invalid-csrf' });
    expect((await post({ 'X-CSRF-Token': csrfToken })).status).toBe(200);
  });
});
