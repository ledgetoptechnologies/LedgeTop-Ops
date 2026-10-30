import { afterAll, beforeAll, expect, it } from 'vitest';
import { createStaffLoginFixture, staffLoginClaims } from './helpers/staff-login-fixture';
import { pilotSessionFromAccessClaims, recheckPilotSession } from '../src/worker/ios-pilot-session';
import { preparePilotStaffSnapshot } from '../src/worker/ios-pilot-staff-snapshot';
import { claimStaffLoginBindingIntent, createStaffLoginBindingIntent, resolveVerifiedStaffLogin, revokeStaffLoginBinding } from '../src/worker/staff-login-bindings';
import type { Env } from '../src/worker/types';

let fixture: Awaited<ReturnType<typeof createStaffLoginFixture>>;
let env: Env;
beforeAll(async () => {
  fixture = await createStaffLoginFixture();
  env = { OPS_DB: fixture.db, TEAM_DOMAIN: fixture.issuer } as Env;
});
afterAll(async () => fixture?.runtime.dispose());

it('matches current staff rechecks and denies changes before the batch', async () => {
  const db = fixture.db;
  const candidate = await pilotSessionFromAccessClaims(env, staffLoginClaims(fixture.owner.email, fixture.owner.subject));
  const transaction = db.withSession('first-primary');
  const plan = await preparePilotStaffSnapshot(env, transaction, candidate);
  expect(plan).not.toBeNull();
  const verify = async () => plan!.verify(await transaction.batch(plan!.statements), Math.floor(Date.now() / 1000));
  await expect(recheckPilotSession(env, candidate)).resolves.toBeUndefined();
  expect(await verify()).toBe(true);
  await db.prepare("UPDATE staff_users SET project_alpha_user_id='changed' WHERE id=?").bind(fixture.owner.id).run();
  expect(await verify()).toBe(false);
  await expect(recheckPilotSession(env, candidate)).rejects.toThrow();
});

it('rechecks native admission and its version in the same batch', async () => {
  const db = fixture.db;
  await db.batch([
    db.prepare('CREATE TABLE native_staff_access_reconciliation(singleton INTEGER PRIMARY KEY,enabled INTEGER)'),
    db.prepare('INSERT INTO native_staff_access_reconciliation VALUES(1,1)'),
  ]);
  const candidate = await pilotSessionFromAccessClaims(env, staffLoginClaims(fixture.owner.email, fixture.owner.subject));
  const transaction = db.withSession('first-primary');
  const plan = await preparePilotStaffSnapshot(env, transaction, candidate);
  const verify = async () => plan!.verify(await transaction.batch(plan!.statements), Math.floor(Date.now() / 1000));
  expect(await verify()).toBe(true);
  await db.prepare('UPDATE native_staff_admissions SET active=0 WHERE staff_id=?').bind(fixture.owner.id).run();
  expect(await verify()).toBe(false);
  await expect(recheckPilotSession(env, candidate)).rejects.toThrow();
});

it('rejects an alternate identity after its binding is revoked', async () => {
  const db = fixture.db;
  await db.prepare('UPDATE native_staff_admissions SET active=1 WHERE staff_id=?').bind(fixture.owner.id).run();
  const primary = await resolveVerifiedStaffLogin(db, staffLoginClaims(fixture.owner.email, fixture.owner.subject));
  const intent = await createStaffLoginBindingIntent(db, primary!.proof, fixture.owner.alternate);
  const linked = await claimStaffLoginBindingIntent(db, staffLoginClaims(fixture.owner.alternate, fixture.owner.alternateSubject), intent);
  const candidate = await pilotSessionFromAccessClaims(env, staffLoginClaims(fixture.owner.alternate, fixture.owner.alternateSubject));
  const transaction = db.withSession('first-primary');
  const plan = await preparePilotStaffSnapshot(env, transaction, candidate);
  const verify = async () => plan!.verify(await transaction.batch(plan!.statements), Math.floor(Date.now() / 1000));
  expect(await verify()).toBe(true);
  const currentOwner = await resolveVerifiedStaffLogin(db, staffLoginClaims(fixture.owner.email, fixture.owner.subject));
  await revokeStaffLoginBinding(db, currentOwner!.proof, { bindingId: linked.bindingId, expectedVersion: 1 });
  expect(await verify()).toBe(false);
  await expect(recheckPilotSession(env, candidate)).rejects.toThrow();
});
