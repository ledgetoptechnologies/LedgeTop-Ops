import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { generateKeyPair, SignJWT } from 'jose';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { staffLoginClaims, STAFF_LOGIN_TEST_ISSUER } from './helpers/staff-login-fixture';
import { authenticateNativeStaffWithAdmissionVersion } from '../src/worker/native-staff-auth';
import { createStaffLoginBindingIntent, claimStaffLoginBindingIntent, resolveVerifiedStaffLogin, revokeStaffLoginBinding } from '../src/worker/staff-login-bindings';
import { resolveEmployeeReadAuthority, recheckEmployeeReadAuthority, listEmployeeReadRoots } from '../src/worker/employee-read-authority';
import { encodeEmployeeFileHandle, decodeEmployeeFileHandle, employeeFileProofMatches, employeeLogicalFileId } from '../src/worker/employee-read-handles';

// Replace only remote key discovery. RSA verification, native authentication,
// binding resolution, real D1 migrations, grant readers and handle crypto run.
const verification = vi.hoisted(() => ({ key: null as unknown }));
vi.mock('jose', async original => ({ ...await original<typeof import('jose')>(), createRemoteJWKSet: vi.fn(() => verification.key) }));
const owner = { id: 'staff:joined-owner', email: 'owner@example.test', subject: 'access|joined-owner' };
const alternate = { email: 'other-owner@example.test', subject: 'access|joined-alternate' };
const rootId = '10000000-0000-4000-8000-000000000001', gatewayId = '10000000-0000-4000-8000-000000000002';
const grantId = '10000000-0000-4000-8000-000000000003', audience = 'synthetic-employee-joined-audience';
const origin = 'https://ops.example.test';

describe('alternate login with actual persisted employee grants and encrypted handles', () => {
  let runtime: Miniflare, db: D1Database, privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  beforeAll(async () => {
    const keys = await generateKeyPair('RS256'); privateKey = keys.privateKey; verification.key = keys.publicKey;
    runtime = new Miniflare({ modules: true, compatibilityDate: '2026-08-06', script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['OPS_DB'] });
    db = await runtime.getD1Database('OPS_DB') as D1Database;
    const directory = new URL('../migrations/', import.meta.url);
    // Use the same full source223 baseline as employee-read-authority.test,
    // followed by the actual alternate-login successor. No substitute grants.
    for (const name of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/u.test(name)
      && (name.slice(0, 4) <= '0223' || name === '0226_staff_login_bindings.sql')).sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), 'utf8')).map(sql => db.prepare(sql)));
    await db.batch([
      db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,'active')").bind(owner.id, owner.email, 'Synthetic Owner', owner.subject),
      db.prepare('INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)').bind(owner.id, owner.subject, owner.id),
      db.prepare('INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)').bind(owner.id, owner.email, 'Synthetic Owner'),
      db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key,created_by) VALUES(?,?,'role-owner','global','global',?)").bind(crypto.randomUUID(), owner.id, owner.id),
      db.prepare("INSERT INTO ops_employee_read_roots(root_id,gateway_id,root_fingerprint,status,display_name) VALUES(?,?,?,'active','Synthetic employee files')").bind(rootId, gatewayId, 'a'.repeat(64)),
      db.prepare(`INSERT INTO ops_employee_read_grants(grant_id,root_id,root_generation,root_fingerprint,staff_id,access_subject,admission_version,effect,expires_at)
        VALUES(?,?,1,?,?,?,1,'allow',?)`).bind(grantId, rootId, 'a'.repeat(64), owner.id, owner.subject, Math.floor(Date.now() / 1000) + 3600),
    ]);
  }, 180_000);
  afterAll(async () => runtime?.dispose());
  async function authenticate(email: string, subject: string) {
    const claims = staffLoginClaims(email, subject);
    const jwt = await new SignJWT({ type: 'app', email }).setProtectedHeader({ alg: 'RS256', kid: 'synthetic' })
      .setIssuer(claims.issuer).setAudience(audience).setSubject(subject).setIssuedAt(claims.issuedAt).setExpirationTime(claims.expiresAt).sign(privateKey);
    return authenticateNativeStaffWithAdmissionVersion(new Request(origin, { headers: { 'Cf-Access-Jwt-Assertion': jwt } }), db,
      { enabled: true, issuer: STAFF_LOGIN_TEST_ISSUER, staffAudience: audience });
  }
  const context = () => ({ opsOrigin: origin, issuer: STAFF_LOGIN_TEST_ISSUER, audience, key: new Uint8Array(32).fill(0x31) });
  const grant = () => db.prepare('SELECT * FROM ops_employee_read_grants WHERE grant_id=?').bind(grantId).first();

  it('retains the exact grant and fresh primary access while invalidating old contexts and revoked alternate access', async () => {
    const persisted = await grant(); expect(persisted).not.toBeNull();
    const before = await authenticate(owner.email, owner.subject);
    const oldProof = await resolveEmployeeReadAuthority(db, before, rootId); expect(oldProof).not.toBeNull();
    const file = { v: 1 as const, proof: oldProof!, path: 'synthetic/map.raw', snapshotId: '10000000-0000-4000-8000-000000000004',
      sha256: 'b'.repeat(64), size: 2048, expiresAt: Math.floor(Date.now() / 1000) + 300 };
    const oldHandle = (await decodeEmployeeFileHandle(context(), await encodeEmployeeFileHandle(context(), file)))!;
    const logicalId = await employeeLogicalFileId(context(), oldProof!, file.path);
    const primary = await resolveVerifiedStaffLogin(db, staffLoginClaims(owner.email, owner.subject)); expect(primary).not.toBeNull();
    const intent = await createStaffLoginBindingIntent(db, primary!.proof, alternate.email);
    // Pending approval alone does not admit an alternate or mint root authority.
    await expect(authenticate(alternate.email, alternate.subject)).rejects.toThrow('native_staff_access_denied');
    expect(await grant()).toEqual(persisted);
    const binding = await claimStaffLoginBindingIntent(db, staffLoginClaims(alternate.email, alternate.subject), intent);
    expect(await resolveEmployeeReadAuthority(db, before, rootId)).toBeNull();
    expect(await recheckEmployeeReadAuthority(db, oldProof!)).toBe(false);
    const freshPrimary = await authenticate(owner.email, owner.subject), freshAlias = await authenticate(alternate.email, alternate.subject);
    expect(freshPrimary.admissionVersion).toBe(1); expect(freshAlias.admissionVersion).toBe(1);
    expect(freshPrimary.identity.profileVersion).toBe(before.identity.profileVersion + 1);
    expect(freshAlias.identity).toEqual(freshPrimary.identity);
    expect(freshAlias.verifiedLogin).toMatchObject({ kind: 'alternate', email: alternate.email, subject: alternate.subject });
    const primaryProof = await resolveEmployeeReadAuthority(db, freshPrimary, rootId), aliasProof = await resolveEmployeeReadAuthority(db, freshAlias, rootId);
    expect(primaryProof).not.toBeNull(); expect(aliasProof).not.toBeNull();
    expect(aliasProof).toMatchObject({ staffId: owner.id, accessSubject: owner.subject, grantId, admissionVersion: 1 });
    expect(await recheckEmployeeReadAuthority(db, aliasProof!)).toBe(true);
    const expectedRoots = [{ rootId, gatewayId, displayName: 'Synthetic employee files' }];
    expect(await listEmployeeReadRoots(db, freshAlias)).toEqual(expectedRoots);
    expect(await listEmployeeReadRoots(db, freshPrimary)).toEqual(expectedRoots);
    expect(employeeFileProofMatches(oldHandle, primaryProof!)).toBe(false);
    expect(await employeeLogicalFileId(context(), aliasProof!, file.path)).toBe(logicalId);
    const aliasHandle = (await decodeEmployeeFileHandle(context(), await encodeEmployeeFileHandle(context(), { ...file, proof: aliasProof! })))!;
    expect(aliasHandle.proof).not.toHaveProperty('verifiedLogin');
    expect(employeeFileProofMatches(aliasHandle, primaryProof!)).toBe(true);
    expect(await grant()).toEqual(persisted);
    const revoker = await resolveVerifiedStaffLogin(db, staffLoginClaims(owner.email, owner.subject));
    await revokeStaffLoginBinding(db, revoker!.proof, { bindingId: binding.bindingId, expectedVersion: binding.version });
    await expect(authenticate(alternate.email, alternate.subject)).rejects.toThrow('native_staff_access_denied');
    expect(await resolveEmployeeReadAuthority(db, freshAlias, rootId)).toBeNull();
    expect(await recheckEmployeeReadAuthority(db, aliasProof!)).toBe(false);
    expect(await recheckEmployeeReadAuthority(db, primaryProof!)).toBe(false);
    const retained = await authenticate(owner.email, owner.subject), retainedProof = await resolveEmployeeReadAuthority(db, retained, rootId);
    expect(retainedProof).not.toBeNull(); expect(await recheckEmployeeReadAuthority(db, retainedProof!)).toBe(true);
    expect(retained.admissionVersion).toBe(1); expect(retained.identity.profileVersion).toBe(before.identity.profileVersion + 2);
    expect(await listEmployeeReadRoots(db, retained)).toEqual(expectedRoots);
    expect(employeeFileProofMatches(aliasHandle, retainedProof!)).toBe(false);
    expect(await employeeLogicalFileId(context(), retainedProof!, file.path)).toBe(logicalId);
    expect(await grant()).toEqual(persisted);
    expect(await db.prepare('SELECT version FROM native_staff_admissions WHERE staff_id=?').bind(owner.id).first('version')).toBe(1);
  }, 120_000);
});
