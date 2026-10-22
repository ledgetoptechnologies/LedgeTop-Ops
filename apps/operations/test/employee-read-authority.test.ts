import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { resolveNativeStaffIdentityWithAdmissionVersion } from '../src/worker/native-staff-identity';
import type { AuthenticatedNativeStaffWithAdmissionVersion } from '../src/worker/native-staff-auth';
import { resolveEmployeeReadAuthority as resolve, recheckEmployeeReadAuthority as recheck, listEmployeeReadRoots as list } from '../src/worker/employee-read-authority';

let sequence = 0;
const uuid = () => `20000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
type Staff = { id: string; email: string; subject: string };
describe('explicit exact-root employee read authority against full source222 D1', () => {
  let mf: Miniflare, db: D1Database, rootId: string, gatewayId: string, alice: Staff, bob: Staff, outsider: Staff;
  const fingerprint = 'a'.repeat(64);
  beforeAll(async () => {
    mf = new Miniflare({ modules: true, compatibilityDate: '2026-08-06', script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['OPS_DB'] });
    db = await mf.getD1Database('OPS_DB') as D1Database;
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/u.test(name) && name.slice(0, 4) <= '0223').sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), 'utf8')).map(sql => db.prepare(sql)));
  }, 90_000);
  afterAll(async () => { await mf?.dispose(); });
  afterEach(() => { vi.restoreAllMocks(); });
  async function staff(): Promise<Staff> {
    const id = `employee-${++sequence}`, email = `${id}@example.invalid`, subject = `access|${id}`;
    await db.batch([
      db.prepare('INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,\'active\')').bind(id, email, id, subject),
      db.prepare('INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)').bind(id, subject, id),
      db.prepare('INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)').bind(id, email, id),
    ]);
    return { id, email, subject };
  }
  async function authenticated(person: Staff): Promise<AuthenticatedNativeStaffWithAdmissionVersion> {
    const resolved = await resolveNativeStaffIdentityWithAdmissionVersion(db, { verifiedEmail: person.email, verifiedAccessSubject: person.subject });
    if (!resolved) throw Error('Synthetic native identity missing');
    return Object.freeze({ ...resolved, verifiedUntil: new Date(Date.now() + 3600_000).toISOString() });
  }
  async function grant(person: Staff, options: { root?: string; effect?: 'allow' | 'deny'; expires?: number } = {}): Promise<string> {
    const id = uuid();
    await db.prepare(`INSERT INTO ops_employee_read_grants(grant_id,root_id,root_generation,root_fingerprint,staff_id,access_subject,admission_version,effect,expires_at)
      SELECT ?,root.root_id,root.root_generation,root.root_fingerprint,admission.staff_id,admission.bound_access_subject,admission.version,?,?
      FROM ops_employee_read_roots root,native_staff_admissions admission WHERE root.root_id=? AND admission.staff_id=?`)
      .bind(id, options.effect ?? 'allow', options.expires ?? Math.floor(Date.now() / 1000) + 3600, options.root ?? rootId, person.id).run();
    return id;
  }
  beforeEach(async () => {
    rootId = uuid(); gatewayId = uuid();
    await db.prepare("INSERT INTO ops_employee_read_roots(root_id,gateway_id,root_fingerprint,status) VALUES(?,?,?,'active')").bind(rootId, gatewayId, fingerprint).run();
    alice = await staff(); bob = await staff(); outsider = await staff();
  });
  it('requires exact explicit grants for two staff and denies an admitted outsider or owner role alone', async () => {
    await grant(alice);
    const secondRoot = uuid();
    await db.prepare("INSERT INTO ops_employee_read_roots(root_id,gateway_id,root_fingerprint,status) VALUES(?,?,?,'active')").bind(secondRoot, gatewayId, 'b'.repeat(64)).run();
    await grant(bob, { root: secondRoot });
    const first = await resolve(db, await authenticated(alice), rootId);
    expect(first).toMatchObject({ rootId, gatewayId, rootGeneration: 1, rootFingerprint: fingerprint, staffId: alice.id, accessSubject: alice.subject,
      admissionVersion: 1, profileVersion: 1, grantGeneration: 1 });
    expect(Object.isFrozen(first)).toBe(true); expect(await recheck(db, first!)).toBe(true);
    expect(await resolve(db, await authenticated(bob), secondRoot)).not.toBeNull();
    expect(await resolve(db, await authenticated(bob), rootId)).toBeNull();
    expect(await resolve(db, await authenticated(alice), secondRoot)).toBeNull();
    await db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key,created_by) VALUES(?,?,'role-owner','global','global',?)")
      .bind(uuid(), outsider.id, outsider.id).run();
    expect(await resolve(db, await authenticated(outsider), rootId)).toBeNull();
  });
  it('can resolve a requested current grant without silently substituting another grant', async () => {
    const first = await grant(alice), second = await grant(alice), auth = await authenticated(alice);
    expect((await resolve(db, auth, rootId))?.grantId).toBe(first);
    expect((await resolve(db, auth, rootId, second))?.grantId).toBe(second);
    await db.prepare('UPDATE ops_employee_read_grants SET active=0,grant_generation=grant_generation+1 WHERE grant_id=?').bind(second).run();
    expect(await resolve(db, auth, rootId, second)).toBeNull();
    expect((await resolve(db, auth, rootId))?.grantId).toBe(first);
  });
  it('a matching current exact-root deny overrides allows without denying another staff member', async () => {
    await grant(alice); await grant(bob);
    const proof = await resolve(db, await authenticated(alice), rootId);
    await grant(alice, { effect: 'deny' });
    expect(await resolve(db, await authenticated(alice), rootId)).toBeNull();
    expect(await recheck(db, proof!)).toBe(false);
    expect(await resolve(db, await authenticated(bob), rootId)).not.toBeNull();
  });
  it('denies altered subject/email/profile/admission inputs and inactive staff', async () => {
    await grant(alice); const auth = await authenticated(alice);
    for (const identity of [{ ...auth.identity, verifiedAccessSubject: bob.subject }, { ...auth.identity, email: bob.email },
      { ...auth.identity, profileVersion: 2 }]) expect(await resolve(db, { ...auth, identity }, rootId)).toBeNull();
    expect(await resolve(db, { ...auth, admissionVersion: 2 }, rootId)).toBeNull();
    const proof = await resolve(db, auth, rootId);
    await db.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").bind(alice.id).run();
    expect(await resolve(db, auth, rootId)).toBeNull(); expect(await recheck(db, proof!)).toBe(false);
  });
  it('a fresh admission or subject rebind cannot inherit a previous epoch grant', async () => {
    const grantId = await grant(alice), auth = await authenticated(alice), proof = await resolve(db, auth, rootId);
    await db.prepare('UPDATE native_staff_admissions SET active=0,version=version+1 WHERE staff_id=?').bind(alice.id).run();
    expect(await recheck(db, proof!)).toBe(false);
    await db.prepare('UPDATE native_staff_admissions SET active=1,version=version+1 WHERE staff_id=?').bind(alice.id).run();
    expect(await resolve(db, await authenticated(alice), rootId)).toBeNull();
    await expect(db.prepare('UPDATE ops_employee_read_grants SET admission_version=3,grant_generation=grant_generation+1 WHERE grant_id=?').bind(grantId).run()).rejects.toThrow();
    await grant(alice);
    const fresh = await resolve(db, await authenticated(alice), rootId); expect(fresh?.admissionVersion).toBe(3);
    const subject = `access|rebound-${++sequence}`;
    await expect(db.prepare('UPDATE native_staff_admissions SET bound_access_subject=?,version=version+1 WHERE staff_id=?').bind(subject, alice.id).run()).rejects.toThrow();
    // Admission identity itself is immutable. Even a legacy staff subject change
    // must not let an existing root grant follow a different login subject.
    await db.prepare('UPDATE staff_users SET access_subject=? WHERE id=?').bind(subject, alice.id).run();
    expect(await recheck(db, fresh!)).toBe(false);
    expect(await resolve(db, { ...auth, identity: { ...auth.identity, verifiedAccessSubject: subject }, admissionVersion: 3 }, rootId)).toBeNull();
  });
  it('rechecks current profile version and exact grant generation after an upstream await', async () => {
    const grantId = await grant(alice), auth = await authenticated(alice), proof = await resolve(db, auth, rootId);
    await Promise.resolve();
    await db.prepare('UPDATE native_staff_profiles SET display_name=display_name||\' revised\',version=version+1 WHERE staff_id=?').bind(alice.id).run();
    expect(await recheck(db, proof!)).toBe(false); expect(await resolve(db, auth, rootId)).toBeNull();
    const fresh = await resolve(db, await authenticated(alice), rootId); expect(fresh?.profileVersion).toBe(2);
    await db.prepare('UPDATE ops_employee_read_grants SET expires_at=expires_at+60,grant_generation=grant_generation+1 WHERE grant_id=?').bind(grantId).run();
    expect(await recheck(db, fresh!)).toBe(false);
    expect((await resolve(db, await authenticated(alice), rootId))?.grantGeneration).toBe(2);
  });
  it('root remap and disable/re-enable invalidate old grants even after restoring the old fingerprint', async () => {
    await grant(alice); const auth = await authenticated(alice), proof = await resolve(db, auth, rootId);
    await db.prepare('UPDATE ops_employee_read_roots SET root_fingerprint=?,root_generation=root_generation+1 WHERE root_id=?').bind('c'.repeat(64), rootId).run();
    expect(await recheck(db, proof!)).toBe(false); expect(await resolve(db, auth, rootId)).toBeNull();
    await db.prepare("UPDATE ops_employee_read_roots SET status='disabled',root_generation=root_generation+1 WHERE root_id=?").bind(rootId).run();
    await db.prepare("UPDATE ops_employee_read_roots SET status='active',root_fingerprint=?,root_generation=root_generation+1 WHERE root_id=?").bind(fingerprint, rootId).run();
    expect(await resolve(db, auth, rootId)).toBeNull();
    await grant(alice); expect((await resolve(db, auth, rootId))?.rootGeneration).toBe(4);
    expect(await recheck(db, proof!)).toBe(false);
  });
  it('revoked grants remain durable and cannot be rescued by a new allow', async () => {
    const grantId = await grant(alice), auth = await authenticated(alice), proof = await resolve(db, auth, rootId);
    await db.prepare('UPDATE ops_employee_read_grants SET active=0,grant_generation=grant_generation+1 WHERE grant_id=?').bind(grantId).run();
    expect(await recheck(db, proof!)).toBe(false);
    await expect(db.prepare('UPDATE ops_employee_read_grants SET active=1,grant_generation=grant_generation+1 WHERE grant_id=?').bind(grantId).run()).rejects.toThrow();
    await grant(alice); expect(await resolve(db, auth, rootId)).not.toBeNull(); expect(await recheck(db, proof!)).toBe(false);
  });
  it('root/grant identity, deletion and generation rollback are rejected by durable schema guards', async () => {
    const grantId = await grant(alice);
    for (const sql of [
      'DELETE FROM ops_employee_read_roots WHERE root_id=?',
      "UPDATE ops_employee_read_roots SET root_fingerprint='" + 'd'.repeat(64) + "' WHERE root_id=?",
      "UPDATE ops_employee_read_roots SET gateway_id='" + uuid() + "',root_generation=root_generation+1 WHERE root_id=?",
    ]) await expect(db.prepare(sql).bind(rootId).run()).rejects.toThrow();
    for (const sql of ['DELETE FROM ops_employee_read_grants WHERE grant_id=?',
      'UPDATE ops_employee_read_grants SET expires_at=expires_at+1 WHERE grant_id=?',
      "UPDATE ops_employee_read_grants SET effect='deny',grant_generation=grant_generation+1 WHERE grant_id=?"])
      await expect(db.prepare(sql).bind(grantId).run()).rejects.toThrow();
    await expect(db.prepare(`INSERT INTO ops_employee_read_grants(grant_id,root_id,root_generation,root_fingerprint,staff_id,access_subject,admission_version,effect,expires_at)
      VALUES(?,?,1,?,?,?,999,'allow',unixepoch()+3600)`).bind(uuid(), rootId, fingerprint, alice.id, alice.subject).run()).rejects.toThrow();
  });
  it('caps proof expiry to the grant and rejects expiry observed after a delayed primary read', async () => {
    const expiry = Math.floor(Date.now() / 1000) + 120;
    await grant(alice, { expires: expiry }); const auth = await authenticated(alice), proof = await resolve(db, auth, rootId);
    expect(proof?.verifiedUntil).toBe(new Date(expiry * 1000).toISOString());
    const firstPrimary = vi.fn((hint: D1SessionConstraint) => {
      const session = db.withSession(hint);
      return { prepare: (sql: string) => ({ bind: (...values: (string | number)[]) => ({ first: async () => {
        const result = await session.prepare(sql).bind(...values).first();
        vi.spyOn(Date, 'now').mockReturnValue(expiry * 1000 + 1);
        return result;
      } }) }) };
    });
    const delayed = { withSession: firstPrimary } as unknown as D1Database;
    expect(await resolve(delayed, auth, rootId)).toBeNull();
    expect(firstPrimary).toHaveBeenCalledWith('first-primary');
    vi.restoreAllMocks();
    expect(await recheck(delayed, proof!)).toBe(false);
  });
  it('rejects expired verification, malformed proofs, getter inputs and unavailable schema without fallback', async () => {
    await grant(alice); const auth = await authenticated(alice), proof = await resolve(db, auth, rootId);
    expect(await resolve(db, { ...auth, verifiedUntil: new Date(0).toISOString() }, rootId)).toBeNull();
    const getter = vi.fn(() => auth.identity);
    const input = Object.defineProperty({ ...auth }, 'identity', { enumerable: true, get: getter });
    expect(await resolve(db, input, rootId)).toBeNull(); expect(getter).not.toHaveBeenCalled();
    expect(await recheck(db, { ...proof!, grantGeneration: 0 })).toBe(false);
    expect(await recheck(db, { ...proof!, rootFingerprint: 'x'.repeat(64) })).toBe(false);
    const unavailable = { withSession: () => { throw Error('schema unavailable'); } } as unknown as D1Database;
    expect(await resolve(unavailable, auth, rootId)).toBeNull(); expect(await recheck(unavailable, proof!)).toBe(false);
  });
  it('discovers only exact allowed roots, excludes denies and rejects stale identity even with no roots', async () => {
    const auth = await authenticated(alice);
    expect(await list(db, auth)).toEqual([]);
    await grant(alice); await grant(bob);
    expect(await list(db, auth)).toEqual([{ rootId, gatewayId, displayName: 'Server files' }]);
    const roots = await list(db, auth); expect(Object.isFrozen(roots)).toBe(true); expect(Object.isFrozen(roots![0])).toBe(true);
    expect(await list(db, await authenticated(outsider))).toEqual([]);
    await grant(alice, { effect: 'deny' }); expect(await list(db, auth)).toEqual([]);
    expect(await list(db, { ...auth, admissionVersion: 2 })).toBeNull();
    await db.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").bind(alice.id).run();
    expect(await list(db, auth)).toBeNull();
  });
  it('fails discovery closed above 100 scoped roots instead of silently truncating', async () => {
    const auth = await authenticated(alice);
    for (let index = 0; index < 101; index++) {
      const id = uuid();
      await db.prepare("INSERT INTO ops_employee_read_roots(root_id,gateway_id,root_fingerprint,status) VALUES(?,?,?,'active')").bind(id, gatewayId, fingerprint).run();
      await grant(alice, { root: id });
    }
    expect(await list(db, auth)).toBeNull();
    expect(await list(db, await authenticated(bob))).toEqual([]);
  });
  it('rechecks discovered proofs after awaits and refuses revoked roots before list handoff', async () => {
    const grantId = await grant(alice), auth = await authenticated(alice);
    let revoked = false;
    const delayed = { withSession: (hint: D1SessionConstraint) => {
      const session = db.withSession(hint);
      return { prepare: (sql: string) => ({ bind: (...values: (string | number)[]) => {
        const statement = session.prepare(sql).bind(...values);
        return { all: () => statement.all(), first: async () => {
          const row = await statement.first();
          if (!revoked && sql.includes('ORDER BY allowed.grant_id LIMIT 1')) {
            revoked = true;
            await db.prepare('UPDATE ops_employee_read_grants SET active=0,grant_generation=grant_generation+1 WHERE grant_id=?').bind(grantId).run();
          }
          return row;
        } };
      } }) };
    } } as unknown as D1Database;
    expect(await list(delayed, auth)).toBeNull(); expect(revoked).toBe(true);
  });
  it('freshly rejects native identity changes during empty candidate reads', async () => {
    for (const mutation of [
      'UPDATE native_staff_admissions SET active=0,version=version+1 WHERE staff_id=?',
      "UPDATE native_staff_profiles SET display_name='changed',version=version+1 WHERE staff_id=?",
      "UPDATE native_staff_profiles SET login_email='changed-'||login_email,version=version+1 WHERE staff_id=?",
      "UPDATE staff_users SET status='inactive' WHERE id=?",
      "UPDATE staff_users SET access_subject='changed-'||access_subject WHERE id=?",
    ]) {
      const person = await staff(), auth = await authenticated(person);
      let changed = false;
      const delayed = { withSession: (hint: D1SessionConstraint) => {
        const session = db.withSession(hint);
        return { prepare: (sql: string) => ({ bind: (...values: (string | number)[]) => {
          const statement = session.prepare(sql).bind(...values);
          return { first: () => statement.first(), all: async () => {
            const rows = await statement.all();
            changed = true; await db.prepare(mutation).bind(person.id).run();
            return rows;
          } };
        } }) };
      } } as unknown as D1Database;
      expect(await list(delayed, auth)).toBeNull(); expect(changed).toBe(true);
    }
  });
});
