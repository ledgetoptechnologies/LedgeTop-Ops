import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ WorkerEntrypoint: class {}, WorkflowEntrypoint: class {}, DurableObject: class {} }));
const keys = vi.hoisted(() => ({ resolver: undefined as ReturnType<typeof createLocalJWKSet> | undefined }));
vi.mock('../src/worker/access-jwks', () => ({ accessJwksResolver: () => keys.resolver }));
import worker from '../src/worker/index';
import { authenticateNativeStaffWithAdmissionVersion } from '../src/worker/native-staff-auth';
import { getPilotDeviceAuthority, setLogsDeviceEligibility } from '../src/worker/logs-device-eligibility';
import { resolvePilotUsername, setStaffUsername } from '../src/worker/staff-directory-lookup';
import { logsDeviceRevisionCurrent } from '../src/worker/logs-device-authority';
import { auditStatement } from '../src/worker/request-security';
import { executeOperationsStaffLifecycleCommand } from '../src/worker/native-staff-management-command';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { reviewedOperationsMigrationNames } from './helpers/reviewed-operations-migration-chain';
import type { Env, StaffPrincipal } from '../src/worker/types';

// Requests go directly to Worker.fetch. No real-host HTTP/provider calls occur.
const origin = 'https://ops.ledgetop.app', issuer = 'https://device-fixture.cloudflareaccess.com', audience = 'device-fixture-human-audience';
let runtime: Miniflare, db: D1Database, privateKey: CryptoKey, serial = 0;
const context = { waitUntil() { throw Error('eligibility must not schedule work'); }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const environment = () => ({ OPS_DB: db, ENVIRONMENT: 'production', PUBLIC_BASE_URL: origin, EXPECTED_HOST: 'ops.ledgetop.app',
  OPERATIONS_ORIGINS: origin, TEAM_DOMAIN: issuer, OPERATIONS_AUD: audience, OPERATIONS_SESSION_SECRET: 'device-test-csrf-'.repeat(4),
  AUDIT_IP_SECRET: 'device-test-audit-'.repeat(4), INCOMING_BASE_URL: 'https://incoming.example.test',
  INCOMING_EXPECTED_HOST: 'incoming.example.test', THUMBNAIL_RENDERER_EXPECTED_HOST: 'ops.ledgetop.app' } as unknown as Env);
async function person(manage = false) {
  const id = `device-test-${++serial}`, email = `${id}@example.test`, subject = `access|${id}`;
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,provisioning_source,sync_protected) VALUES(?,?,?,?,'local',1)").bind(id, email, id, subject),
    db.prepare('INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)').bind(id, subject, id),
    db.prepare('INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)').bind(id, email, id),
    ...(manage ? [db.prepare("INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by) VALUES(?,?,'roles.manage','allow','global','global',?)").bind(crypto.randomUUID(), id, id)] : []),
  ]);
  return { id, email, subject };
}
type Person = Awaited<ReturnType<typeof person>>;
async function jwt(p: Person, options: { audience?: string; service?: boolean } = {}) {
  return new SignJWT({ email: p.email, type: 'app', ...(options.service ? { service_token_id: 'fixture-service' } : {}) })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuer(issuer).setAudience(options.audience ?? audience)
    .setSubject(p.subject).setIssuedAt().setExpirationTime('10m').sign(privateKey);
}
async function request(p: Person, target: string, init: RequestInit = {}, token?: string) {
  return worker.fetch(new Request(`${origin}/api/staff-device-eligibility/${target}`, {
    ...init, headers: { 'Cf-Access-Jwt-Assertion': token ?? await jwt(p), ...init.headers },
  }), environment(), context);
}
async function change(p: Person, target: string, expectedRevision: number, effect: 'allow' | 'deny' = 'allow', commandId = crypto.randomUUID()) {
  const state = await request(p, target); expect(state.status, await state.clone().text()).toBe(200);
  const { csrfToken } = await state.json() as { csrfToken: string };
  return request(p, target, { method: 'POST', headers: { Origin: origin, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ commandId, expectedRevision, effect, reason: 'Controlled synthetic eligibility test' }) });
}

describe('explicit controller eligibility against actual Worker and all current D1 migrations', () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: '2026-07-22', cf: false, script: 'export default {}', d1Databases: ['OPS_DB'] });
    db = await runtime.getD1Database('OPS_DB') as D1Database;
    const directory = new URL('../migrations/', import.meta.url);
    reviewedOperationsMigrationNames(directory);
    const names = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
    expect(names).toHaveLength(235); expect(names.at(-1)).toBe('0243_staff_logs_device_eligibility.sql');
    for (const name of names) await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), 'utf8')).map(sql => db.prepare(sql)));
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    const pair = await generateKeyPair('RS256'); privateKey = pair.privateKey;
    keys.resolver = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'fixture', alg: 'RS256' }] });
  }, 120_000);
  afterAll(async () => runtime?.dispose());

  it('never infers controller access from username, active status or own-flight access', async () => {
    const manager = await person(true), pilot = await person();
    await setStaffUsername(db, pilot.id, pilot.id, manager.id);
    expect(await resolvePilotUsername(db, pilot.id)).toBeNull();
    expect(await getPilotDeviceAuthority(db, pilot.id)).toEqual({ eligible: false, revision: null });
    const state = await request(manager, pilot.id);
    expect(state.status).toBe(200); expect(await state.json()).toMatchObject({ eligible: false, revision: 0, username: pilot.id, effect: null });
  });

  it('accepts an explicit global roles.manage delegate without an administrator role, including audited self-grant', async () => {
    const manager = await person(true);
    const response = await change(manager, manager.id, 0);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ receipt: { staffId: manager.id, revision: 1, effect: 'allow', replayed: false } });
    expect(await getPilotDeviceAuthority(db, manager.id)).toEqual({ eligible: true, revision: 1 });
    expect(await db.prepare("SELECT COUNT(*) count FROM audit_events WHERE actor_id=? AND action='staff.logs_device_eligibility.changed'").bind(manager.id).first('count')).toBe(1);
  });

  it('rejects wrong audience, service identity, missing permission and global deny', async () => {
    const manager = await person(true), pilot = await person();
    expect((await request(manager, pilot.id, {}, await jwt(manager, { audience: 'other-human-audience' }))).status).toBe(403);
    expect((await request(manager, pilot.id, {}, await jwt(manager, { service: true }))).status).toBe(403);
    expect((await request(pilot, pilot.id)).status).toBe(403);
    await db.prepare("INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by) VALUES(?,?,'roles.manage','deny','global','global',?)").bind(crypto.randomUUID(), manager.id, manager.id).run();
    expect((await request(manager, pilot.id)).status).toBe(403);
    expect(await getPilotDeviceAuthority(db, pilot.id)).toEqual({ eligible: false, revision: null });
  });

  it('requires same-origin CSRF and exact body/method shape before a write', async () => {
    const manager = await person(true), pilot = await person();
    const state = await (await request(manager, pilot.id)).json() as { csrfToken: string };
    const input = JSON.stringify({ commandId: crypto.randomUUID(), expectedRevision: 0, effect: 'allow', reason: 'Fixture' });
    expect((await request(manager, pilot.id, { method: 'HEAD' })).status).toBe(405);
    expect((await request(manager, pilot.id, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: input })).status).toBe(403);
    expect((await request(manager, pilot.id, { method: 'POST', headers: { Origin: 'https://attacker.example.test', 'X-CSRF-Token': state.csrfToken, 'Content-Type': 'application/json' }, body: input })).status).toBe(403);
    expect((await request(manager, pilot.id, { method: 'POST', headers: { Origin: origin, 'X-CSRF-Token': state.csrfToken, 'Content-Type': 'application/json' }, body: input.replace('"effect":"allow"', '"actor":"forged","effect":"allow"') })).status).toBe(400);
    expect(await getPilotDeviceAuthority(db, pilot.id)).toEqual({ eligible: false, revision: null });
  });

  it('replays one immutable receipt and fences competing revisions without duplicate audits', async () => {
    const manager = await person(true), pilot = await person(), commandId = crypto.randomUUID();
    const first = await change(manager, pilot.id, 0, 'allow', commandId); expect(first.status).toBe(200);
    const replay = await change(manager, pilot.id, 0, 'allow', commandId); expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ receipt: { revision: 1, replayed: true } });
    expect((await change(manager, pilot.id, 1, 'deny', commandId)).status).toBe(409);
    const results = await Promise.all([change(manager, pilot.id, 1, 'deny'), change(manager, pilot.id, 1, 'allow')]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(await db.prepare('SELECT COUNT(*) count FROM staff_logs_device_eligibility_commands WHERE target_staff_id=?').bind(pilot.id).first('count')).toBe(2);
    expect(await db.prepare("SELECT COUNT(*) count FROM audit_events WHERE entity_id=? AND action='staff.logs_device_eligibility.changed'").bind(pilot.id).first('count')).toBe(2);
  });

  it('denies a global override introduced after authority reads but before the write transaction', async () => {
    const manager = await person(true), pilot = await person();
    const token = await jwt(manager), actor = await authenticateNativeStaffWithAdmissionVersion(new Request(origin, { headers: { 'Cf-Access-Jwt-Assertion': token } }), db, { enabled: true, issuer, staffAudience: audience });
    let intercepted = false;
    const raced = new Proxy(db, { get(base, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (!intercepted) { intercepted = true; await db.prepare("INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by) VALUES(?,?,'roles.manage','deny','global','global',?)").bind(crypto.randomUUID(), manager.id, manager.id).run(); }
        return base.batch(statements);
      };
      const value = Reflect.get(base, key, base); return typeof value === 'function' ? value.bind(base) : value;
    } });
    const principal: StaffPrincipal = { id: manager.id, email: manager.email, displayName: manager.id, accessSubject: manager.subject, projectAlphaUserId: null };
    const audit = await auditStatement(environment(), new Request(origin), principal, 'staff.logs_device_eligibility.changed', 'staff', pilot.id, null);
    await expect(setLogsDeviceEligibility(raced, actor, pilot.id, { commandId: crypto.randomUUID(), expectedRevision: 0, effect: 'allow', reason: 'Late deny fixture' }, audit)).rejects.toMatchObject({ status: 403 });
    expect(intercepted).toBe(true);
    expect(await db.prepare('SELECT COUNT(*) count FROM staff_logs_device_eligibility_commands WHERE target_staff_id=?').bind(pilot.id).first('count')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) count FROM audit_events WHERE entity_id=?').bind(pilot.id).first('count')).toBe(0);
  });

  it('recovers a committed write after a lost acknowledgement without another grant or audit', async () => {
    const manager = await person(true), pilot = await person();
    const actor = await authenticateNativeStaffWithAdmissionVersion(new Request(origin, {
      headers: { 'Cf-Access-Jwt-Assertion': await jwt(manager) },
    }), db, { enabled: true, issuer, staffAudience: audience });
    const principal: StaffPrincipal = { id: manager.id, email: manager.email, displayName: manager.id, accessSubject: manager.subject, projectAlphaUserId: null };
    const audit = await auditStatement(environment(), new Request(origin), principal, 'staff.logs_device_eligibility.changed', 'staff', pilot.id, null);
    let committedBatches = 0;
    const lostAcknowledgement = new Proxy(db, { get(base, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        await base.batch(statements);
        committedBatches++;
        throw new Error('Synthetic transport loss after commit');
      };
      const value = Reflect.get(base, key, base); return typeof value === 'function' ? value.bind(base) : value;
    } });
    const command = { commandId: crypto.randomUUID(), expectedRevision: 0, effect: 'allow' as const, reason: 'Lost acknowledgement fixture' };
    expect(await setLogsDeviceEligibility(lostAcknowledgement, actor, pilot.id, command, audit))
      .toMatchObject({ commandId: command.commandId, revision: 1, replayed: true });
    expect(committedBatches).toBe(1);
    expect(await getPilotDeviceAuthority(db, pilot.id)).toEqual({ eligible: true, revision: 1 });
    expect(await db.prepare('SELECT COUNT(*) count FROM staff_logs_device_eligibility_commands WHERE target_staff_id=?').bind(pilot.id).first('count')).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) count FROM audit_events WHERE entity_id=? AND action='staff.logs_device_eligibility.changed'").bind(pilot.id).first('count')).toBe(1);
  });

  it('rolls back the command and grant when its audit statement fails', async () => {
    const manager = await person(true), pilot = await person();
    const actor = await authenticateNativeStaffWithAdmissionVersion(new Request(origin, {
      headers: { 'Cf-Access-Jwt-Assertion': await jwt(manager) },
    }), db, { enabled: true, issuer, staffAudience: audience });
    const command = { commandId: crypto.randomUUID(), expectedRevision: 0, effect: 'allow' as const, reason: 'Audit rollback fixture' };
    // Fails inside the same D1 transaction, after the command's grant trigger.
    const failedAudit = db.prepare('INSERT INTO audit_events (id) VALUES (NULL)');
    await expect(setLogsDeviceEligibility(db, actor, pilot.id, command, failedAudit)).rejects.toMatchObject({ status: 503 });
    expect(await getPilotDeviceAuthority(db, pilot.id)).toEqual({ eligible: false, revision: null });
    expect(await db.prepare('SELECT COUNT(*) count FROM staff_logs_device_eligibility_commands WHERE target_staff_id=?').bind(pilot.id).first('count')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) count FROM audit_events WHERE entity_id=?').bind(pilot.id).first('count')).toBe(0);
  });

  it('archive/restore requires explicit regrant and never revives a prior token revision', async () => {
    const manager = await person(true), pilot = await person();
    for (const capability of ['staff.admission.disable', 'staff.admission.enable']) await db.prepare("INSERT INTO native_staff_management_delegations(id,actor_staff_id,capability,effect,scope_kind,granted_by) VALUES(?,?,?,'allow','global',?)").bind(crypto.randomUUID(), manager.id, capability, manager.id).run();
    expect((await change(manager, pilot.id, 0)).status).toBe(200);
    expect(logsDeviceRevisionCurrent(await getPilotDeviceAuthority(db, pilot.id), 1)).toBe(true);
    const lifecycle = (capability: 'staff.admission.disable' | 'staff.admission.enable', version: number) => executeOperationsStaffLifecycleCommand(db, {
      commandId: crypto.randomUUID(), contractVersion: 1, capability, actor: { staffId: manager.id, verifiedAccessSubject: manager.subject },
      targetStaffId: pilot.id, expectedVersion: version, reason: 'Synthetic archive/restore' },
    { admissionVersion: 1, profileVersion: 1, verifiedUntil: new Date(Date.now() + 600_000).toISOString() });
    await lifecycle('staff.admission.disable', 1);
    expect((await getPilotDeviceAuthority(db, pilot.id)).eligible).toBe(false);
    await lifecycle('staff.admission.enable', 2);
    expect((await getPilotDeviceAuthority(db, pilot.id)).eligible).toBe(false);
    expect((await change(manager, pilot.id, 1)).status).toBe(200);
    const restored = await getPilotDeviceAuthority(db, pilot.id);
    expect(restored).toEqual({ eligible: true, revision: 2 });
    expect(logsDeviceRevisionCurrent(restored, 1)).toBe(false); expect(logsDeviceRevisionCurrent(restored, 2)).toBe(true);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
});
