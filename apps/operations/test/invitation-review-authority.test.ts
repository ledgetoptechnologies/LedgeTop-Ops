import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertInvitationReviewProof, assertInvitationReviewPublication, captureInvitationReviewProof,
  invitationReviewAuthorityReady, invitationReviewStaffCapabilities, readInvitationReviewAuthorization,
  reserveInvitationReviewAuthorization,
} from '../src/worker/invitation-review-authority';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { registerVisibleTestSource } from './helpers/project-alpha-connectors';
import type { Env, StaffPrincipal } from '../src/worker/types';

const PRIMARY = 'project-alpha:primary', SECONDARY = 'project-alpha:review-fixture';
const actor: StaffPrincipal = { id: 'invitation-review-admin', email: 'review-admin@example.test',
  displayName: 'Review administrator', accessSubject: 'verified-review-subject', projectAlphaUserId: 'review-alpha-user' };
const other: StaffPrincipal = { id: 'invitation-review-other', email: 'review-other@example.test',
  displayName: 'Other staff', accessSubject: 'verified-other-subject', projectAlphaUserId: null };
let runtime: Miniflare, db: D1Database, env: Env, sequence = 0;
const next = (prefix: string) => `${prefix}-${++sequence}`;

function operation() {
  return { action: 'approve' as const, workspaceId: 'same-external-workspace', subjectId: 'same-external-request',
    idempotencyKey: next('review-command'), deliveryContext: 'a'.repeat(64),
    operation: { requestVersion: 1, capabilities: ['delivery.view'], accessTerms: {
      kind: 'collaborator', mode: 'until_revoked', expiresAt: null,
    } } };
}
async function forbidden(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({ status: 403 });
}
async function changed(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({ status: 409, message: 'invitation_review_context_changed' });
}
async function receiptCount() {
  return db.prepare('SELECT count(*) n FROM invitation_review_authorizations').first<number>('n');
}
async function override(permission: 'team.view' | 'team.manage', effect: 'allow' | 'deny', scope: 'global' | 'division' = 'global') {
  await db.prepare(`INSERT INTO staff_permission_overrides
    (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by) VALUES(?,?,?,?,?,?,?,?)`)
    .bind(next('override'), actor.id, permission, effect, scope, scope === 'division' ? 'review-division' : null,
      scope === 'division' ? 'review-division' : 'global', actor.id).run();
}
async function removeAdmin() {
  await db.prepare('DELETE FROM staff_role_assignments WHERE staff_id=?').bind(actor.id).run();
}
async function sources() {
  await registerVisibleTestSource(db, PRIMARY, 'Primary source');
  await registerVisibleTestSource(db, SECONDARY, 'Secondary source');
  for (const sourceId of [PRIMARY, SECONDARY]) {
    await db.prepare("UPDATE pa_connectors SET state='active',version=version+1 WHERE source_id=?").bind(sourceId).run();
  }
}
async function reserve(sourceId = PRIMARY) {
  const proof = await captureInvitationReviewProof(env, actor, sourceId, true);
  const input = operation();
  const receipt = await reserveInvitationReviewAuthorization(env, actor, proof, input);
  return { proof, input, receipt };
}

/** Interleave a real committed policy change immediately before the real D1
 * receipt batch. No SQL result or authorization method is mocked. */
function beforeReceiptBatch(action: () => Promise<void>) {
  let injected = false;
  const wrap = <T extends D1Database | D1DatabaseSession>(database: T): T => new Proxy(database, {
    get(target, property) {
      if (property === 'withSession') return (...args: Parameters<D1Database['withSession']>) =>
        wrap((target as D1Database).withSession(...args));
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (!injected) { injected = true; await action(); }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { env: { ...env, OPS_DB: wrap(db) }, injected: () => injected };
}

// Serial real-D1 policy/receipt work must finish before the next fixture reset.
describe('Invitation review authority and immutable publication receipts', { timeout: 60_000, concurrent: false }, () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: '2026-07-22',
      script: "export default {fetch(){return new Response('fixture')}}", d1Databases: ['OPS_DB'] });
    db = await runtime.getD1Database('OPS_DB') as D1Database;
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) <= '0041').sort()) {
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), 'utf8')).map(sql => db.prepare(sql)));
    }
    await db.batch([
      ...[actor, other].map(person => db.prepare(`INSERT INTO staff_users
        (id,email,display_name,access_subject,project_alpha_user_id,status) VALUES(?,?,?,?,?,'active')`)
        .bind(person.id, person.email, person.displayName, person.accessSubject, person.projectAlphaUserId)),
      db.prepare("INSERT INTO divisions(id,name,code) VALUES('review-division','Review division','review-fixture')"),
    ]);
    // This module uses OPS only; no Delivery, mail or external provider binding exists.
    env = { OPS_DB: db, CLIENT_PORTAL_HIERARCHY_V2_ENABLED: 'true' } as Env;
  }, 120_000);
  beforeEach(async () => {
    await db.batch([
      db.prepare('DELETE FROM staff_permission_overrides WHERE staff_id=?').bind(actor.id),
      db.prepare('DELETE FROM local_staff_role_assignments WHERE staff_id=?').bind(actor.id),
      db.prepare('DELETE FROM staff_role_assignments WHERE staff_id=?').bind(actor.id),
      db.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key)
        VALUES('review-global-admin',?,'role-admin','global','global')`).bind(actor.id),
      ...['team.view', 'team.manage'].map(permission => db.prepare('INSERT OR IGNORE INTO role_permissions(role_id,permission_key) VALUES(\'role-admin\',?)').bind(permission)),
      db.prepare("UPDATE staff_users SET status='active',email=?,access_subject=?,project_alpha_user_id=? WHERE id=?")
        .bind(actor.email, actor.accessSubject, actor.projectAlphaUserId, actor.id),
      ...[PRIMARY, SECONDARY].map(sourceId => db.prepare("UPDATE pa_connectors SET state='active',read_visible=1,version=version+1 WHERE source_id=?").bind(sourceId)),
    ]);
  }, 60_000);
  afterAll(async () => { await runtime?.dispose(); }, 60_000);

  it('keeps the unenrolled primary adapter and reports the exact global staff capabilities', async () => {
    expect(await invitationReviewAuthorityReady(env)).toBe(true);
    expect(await invitationReviewStaffCapabilities(env, actor)).toEqual({ enabled: true, canReview: true, canManagePolicy: true });
    const proof = await captureInvitationReviewProof(env, actor, PRIMARY, true);
    expect(proof.sourceId).toBe(PRIMARY);
    expect(proof.canManage).toBe(true);
    await assertInvitationReviewProof(env, proof);
  });

  it('does not expose capabilities when the rollout flag is disabled', async () => {
    const disabled = { ...env, CLIENT_PORTAL_HIERARCHY_V2_ENABLED: 'false' };
    expect(await invitationReviewStaffCapabilities(disabled, actor)).toEqual({ enabled: false, canReview: false, canManagePolicy: false });
    await expect(captureInvitationReviewProof(disabled, actor, PRIMARY, true)).rejects.toMatchObject({ status: 503 });
  });

  it('allows global team.view reads without promoting a nonadministrator to reviewer', async () => {
    await removeAdmin();
    await override('team.view', 'allow');
    await override('team.manage', 'allow');
    expect(await invitationReviewStaffCapabilities(env, actor)).toEqual({ enabled: true, canReview: false, canManagePolicy: false });
    expect((await captureInvitationReviewProof(env, actor, PRIMARY, false)).canManage).toBe(false);
    await forbidden(captureInvitationReviewProof(env, actor, PRIMARY, true));
  });

  it.each(['team.view', 'team.manage'] as const)('does not promote a division-only %s grant', async permission => {
    await db.prepare('DELETE FROM role_permissions WHERE role_id=\'role-admin\' AND permission_key=?').bind(permission).run();
    await override(permission, 'allow', 'division');
    const capabilities = await invitationReviewStaffCapabilities(env, actor);
    expect(capabilities.canReview).toBe(false);
    expect(capabilities.enabled).toBe(permission !== 'team.view');
    await forbidden(captureInvitationReviewProof(env, actor, PRIMARY, true));
  });

  it.each(['team.view', 'team.manage'] as const)('honors a global %s deny even for a synced administrator', async permission => {
    await override(permission, 'deny');
    expect((await invitationReviewStaffCapabilities(env, actor)).canReview).toBe(false);
    await forbidden(captureInvitationReviewProof(env, actor, PRIMARY, true));
    if (permission === 'team.view') await forbidden(captureInvitationReviewProof(env, actor, PRIMARY, false));
  });

  it('does not treat a local administrator role as the synced administrator definition', async () => {
    await removeAdmin();
    await db.prepare(`INSERT INTO local_staff_role_assignments(id,staff_id,role_id,scope,created_by)
      VALUES('review-local-admin',?,'role-admin','global',?)`).bind(actor.id, actor.id).run();
    expect(await invitationReviewStaffCapabilities(env, actor)).toEqual({ enabled: true, canReview: false, canManagePolicy: false });
    await forbidden(captureInvitationReviewProof(env, actor, PRIMARY, true));
  });

  it('rejects an inactive staff actor before returning capabilities or a source proof', async () => {
    await db.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").bind(actor.id).run();
    expect(await invitationReviewStaffCapabilities(env, actor)).toEqual({ enabled: false, canReview: false, canManagePolicy: false });
    await forbidden(captureInvitationReviewProof(env, actor, PRIMARY, false));
  });

  it.each([
    { email: 'changed@example.test' }, { accessSubject: 'another-verified-subject' }, { projectAlphaUserId: 'another-alpha-user' },
  ])('pins the current staff identity tuple: %j', async changedActor => {
    await forbidden(captureInvitationReviewProof(env, { ...actor, ...changedActor }, PRIMARY, true));
  });

  it('rejects another actor using an administrator proof without inserting a receipt', async () => {
    const proof = await captureInvitationReviewProof(env, actor, PRIMARY, true), before = await receiptCount();
    await forbidden(reserveInvitationReviewAuthorization(env, other, proof, operation()));
    expect(await receiptCount()).toBe(before);
  });

  it('does not let a source label diverge from the captured source proof', async () => {
    const proof = await captureInvitationReviewProof(env, actor, PRIMARY, true), before = await receiptCount();
    await forbidden(reserveInvitationReviewAuthorization(env, actor, { ...proof, sourceId: SECONDARY }, operation()));
    expect(await receiptCount()).toBe(before);
  });

  it('rejects read-only proofs for reservation even when the actor can manage', async () => {
    const proof = await captureInvitationReviewProof(env, actor, PRIMARY, false), before = await receiptCount();
    await forbidden(reserveInvitationReviewAuthorization(env, actor, proof, operation()));
    expect(await receiptCount()).toBe(before);
  });

  it('requires an existing readable secondary source, not a caller-selected source name', async () => {
    await forbidden(captureInvitationReviewProof(env, actor, 'project-alpha:not-registered', true));
    await sources();
    const proof = await captureInvitationReviewProof(env, actor, SECONDARY, true);
    expect(proof.sourceName).toBe('Secondary source');
    await db.prepare('UPDATE pa_connectors SET read_visible=0,version=version+1 WHERE source_id=?').bind(SECONDARY).run();
    await forbidden(captureInvitationReviewProof(env, actor, SECONDARY, false));
    await changed(assertInvitationReviewProof(env, proof));
  });

  it.each([PRIMARY, SECONDARY])('requires active %s authority to mutate a secondary source', async sourceId => {
    await sources();
    const proof = await captureInvitationReviewProof(env, actor, SECONDARY, true);
    await db.prepare("UPDATE pa_connectors SET state='suspended',version=version+1 WHERE source_id=?").bind(sourceId).run();
    // Business history remains readable when read_visible is still true.
    expect(await captureInvitationReviewProof(env, actor, SECONDARY, false)).toMatchObject({ sourceId: SECONDARY, canManage: false });
    await forbidden(captureInvitationReviewProof(env, actor, SECONDARY, true));
    await changed(assertInvitationReviewProof(env, proof));
  });

  it('stores exact operation/context bytes and replays the same command without allocating another receipt', async () => {
    const before = await receiptCount(), { proof, input, receipt } = await reserve();
    expect(receipt.actor_id).toBe(actor.id);
    expect(receipt.operation_json).toBe(JSON.stringify(input.operation));
    expect(receipt.delivery_context).toBe(input.deliveryContext);
    expect(receipt.ops_proof_json).toBe(proof.json);
    const replay = await reserveInvitationReviewAuthorization(env, actor, proof, input);
    expect(replay).toEqual(receipt);
    expect(await readInvitationReviewAuthorization(env, actor.id, input.idempotencyKey)).toEqual(receipt);
    expect(await readInvitationReviewAuthorization(env, other.id, input.idempotencyKey)).toBeNull();
    expect(await receiptCount()).toBe(before! + 1);
    await assertInvitationReviewPublication(env, proof, receipt);
  });

  it.each(['operation', 'subject', 'source', 'action'] as const)('rejects same-key %s changes', async field => {
    await sources();
    const { proof, input, receipt } = await reserve();
    const selectedProof = field === 'source' ? await captureInvitationReviewProof(env, actor, SECONDARY, true) : proof;
    const changedInput = { ...input,
      ...(field === 'operation' ? { operation: { ...input.operation, requestVersion: 2 } } : {}),
      ...(field === 'subject' ? { subjectId: 'another-request' } : {}),
      ...(field === 'action' ? { action: 'reject' as const } : {}),
    };
    await expect(reserveInvitationReviewAuthorization(env, actor, selectedProof, changedInput)).rejects.toMatchObject({ status: 409, message: 'invitation_review_idempotency_conflict' });
    expect(await readInvitationReviewAuthorization(env, actor.id, input.idempotencyKey)).toEqual(receipt);
  });

  it('converges simultaneous identical reservations on the same immutable winner', async () => {
    const proof = await captureInvitationReviewProof(env, actor, PRIMARY, true), input = operation(), before = await receiptCount();
    const [first, second] = await Promise.all([
      reserveInvitationReviewAuthorization(env, actor, proof, input),
      reserveInvitationReviewAuthorization(env, actor, proof, input),
    ]);
    expect(first).toEqual(second);
    expect(await receiptCount()).toBe(before! + 1);
  });

  it('fences a deny committed immediately before receipt insertion in the real batch', async () => {
    const proof = await captureInvitationReviewProof(env, actor, PRIMARY, true), input = operation(), before = await receiptCount();
    const raced = beforeReceiptBatch(() => override('team.manage', 'deny'));
    await changed(reserveInvitationReviewAuthorization(raced.env, actor, proof, input));
    expect(raced.injected()).toBe(true);
    expect(await receiptCount()).toBe(before);
    expect(await readInvitationReviewAuthorization(env, actor.id, input.idempotencyKey)).toBeNull();
  });

  it('keeps receipt rows immutable under update, delete, ID replacement and command-key replacement', async () => {
    const { input, receipt } = await reserve();
    for (const sql of [
      'UPDATE invitation_review_authorizations SET subject_id=\'changed\' WHERE id=?',
      'DELETE FROM invitation_review_authorizations WHERE id=?',
      `INSERT OR REPLACE INTO invitation_review_authorizations SELECT * FROM invitation_review_authorizations WHERE id=?`,
      `INSERT OR REPLACE INTO invitation_review_authorizations
        (id,actor_id,idempotency_key,action,source_id,workspace_id,subject_id,fingerprint,operation_json,ops_proof_json,delivery_context,publication_deadline)
        SELECT 'replacement-id',actor_id,idempotency_key,action,source_id,workspace_id,subject_id,fingerprint,operation_json,ops_proof_json,delivery_context,publication_deadline
        FROM invitation_review_authorizations WHERE id=?`,
    ]) await expect(db.prepare(sql).bind(receipt.id).run()).rejects.toThrow('invitation-review-authorization-immutable');
    expect(await readInvitationReviewAuthorization(env, actor.id, input.idempotencyKey)).toEqual(receipt);
  });

  it('does not publish an expired receipt or a receipt with a different proof', async () => {
    const { proof, receipt } = await reserve();
    const expiredKey = next('expired-command');
    await db.prepare(`INSERT INTO invitation_review_authorizations
      (id,actor_id,idempotency_key,action,source_id,workspace_id,subject_id,fingerprint,operation_json,ops_proof_json,delivery_context,publication_deadline)
      SELECT ?,actor_id,?,action,source_id,workspace_id,subject_id,fingerprint,operation_json,ops_proof_json,delivery_context,'2000-01-01T00:00:00.000Z'
      FROM invitation_review_authorizations WHERE id=?`).bind(next('expired-receipt'), expiredKey, receipt.id).run();
    const expired = await readInvitationReviewAuthorization(env, actor.id, expiredKey);
    expect(expired).not.toBeNull();
    await changed(assertInvitationReviewPublication(env, proof, expired!));
    await changed(assertInvitationReviewPublication(env, proof, { ...receipt, ops_proof_json: '{}' }));
  });

  it('does not publish a receipt under another actor or source even with copied proof bytes', async () => {
    const { proof, receipt } = await reserve();
    await changed(assertInvitationReviewPublication(env, proof, { ...receipt, actor_id: other.id }));
    await changed(assertInvitationReviewPublication(env, proof, { ...receipt, source_id: SECONDARY }));
  });

  it('keeps exact replay history but refuses publication after current staff authority is revoked', async () => {
    const { proof, input, receipt } = await reserve();
    await override('team.manage', 'deny');
    expect(await readInvitationReviewAuthorization(env, actor.id, input.idempotencyKey)).toEqual(receipt);
    await changed(assertInvitationReviewPublication(env, proof, receipt));
  });

  it('refuses publication after source suspension without rewriting its immutable receipt', async () => {
    await sources();
    const { proof, input, receipt } = await reserve(SECONDARY);
    await db.prepare("UPDATE pa_connectors SET state='suspended',version=version+1 WHERE source_id=?").bind(SECONDARY).run();
    await changed(assertInvitationReviewPublication(env, proof, receipt));
    expect(await readInvitationReviewAuthorization(env, actor.id, input.idempotencyKey)).toEqual(receipt);
  });
});
