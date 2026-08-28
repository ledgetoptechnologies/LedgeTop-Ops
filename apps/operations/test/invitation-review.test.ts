import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRIMARY_ALPHA_SOURCE_ID } from '@ltds/shared';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { submitWorkspaceInvitationRequest, invitationApprovalDigest, readWorkspaceInvitationRequest,
  readWorkspaceInvitationPolicyContext, prepareWorkspaceInvitationDecision,
  type WorkspaceInvitationRequestView } from '../../client/src/worker/client-portal/workspace-invitation-requests';
import { recordInvitationAccessEnrollmentReceipt } from '../../client/src/worker/client-portal/access-enrollment-receipts';
import { processInvitationEmailBatch } from '../../client/src/worker/client-portal/invitation-email';
import { acceptPortalWorkspaceInvitation } from '../../client/src/worker/client-portal/workspace-v2';
import { invitationReviewCapabilities, readStaffInvitationPolicy, changeStaffInvitationPolicy,
  listStaffInvitationRequests, readStaffInvitationRequest, decideStaffInvitationRequest } from '../src/worker/invitation-review';
import type { Env, StaffPrincipal } from '../src/worker/types';
import type { Env as ClientEnv } from '../../client/src/worker/types';
import type { ProjectAccessTermsInput } from '../../client/src/worker/client-portal/project-access-terms';

const SOURCE = PRIMARY_ALPHA_SOURCE_ID, issuer = 'https://clients.example.test';
const actor: StaffPrincipal = { id: 'joined-review-admin', email: 'joined-review@example.test', displayName: 'Invitation reviewer',
  accessSubject: 'joined-review-verified-subject', projectAlphaUserId: null };
let runtime: Miniflare, ops: D1Database, delivery: D1Database, env: Env, client: ClientEnv, sequence = 0;
const next = (prefix: string) => `${prefix}-${++sequence}`;
const permanent: ProjectAccessTermsInput = { kind: 'collaborator', mode: 'until_revoked', expiresAt: null };
const send = vi.fn().mockResolvedValue(undefined);

async function fixture(initialPolicy: 'require_approval' | null = 'require_approval') {
  const id = next('joined-workspace'), project = next('joined-project'), generation = next('joined-generation'),
    identity = next('joined-manager'), root = next('joined-root'), account = next('joined-account');
  const principal = { issuer, subject: identity, email: `${identity}@example.test` };
  await delivery.batch([
    delivery.prepare("INSERT INTO client_accounts(id,display_name,status) VALUES(?,?,'active')").bind(account, account),
    delivery.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status,legacy_account_id,project_alpha_source_id)
      VALUES(?,'organization',?,?,'active',?,?)`).bind(id, root, id, account, SOURCE),
    delivery.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete)
      VALUES(?,?,?,1,'active',1)`).bind(generation, id, generation),
    delivery.prepare('INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version) VALUES(?,?,3)').bind(generation, id),
    delivery.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,display_name,source_version)
      VALUES(?,?,'organization',?,?,'root-v1')`).bind(id, generation, root, root),
    delivery.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version)
      VALUES(?,?,'project',?,?,?,'project-v1')`).bind(id, generation, project, root, project),
    delivery.prepare(`INSERT INTO portal_v2_directory_relations(workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version)
      VALUES(?,?,'root-project','contains','organization',?,'project',?,'relation-v1')`).bind(id, generation, root, project),
    delivery.prepare(`INSERT INTO portal_v2_project_lifecycle(workspace_id,generation_id,project_public_id,lifecycle_status,source_version)
      VALUES(?,?,?,'active','lifecycle-v1')`).bind(id, generation, project),
    delivery.prepare(`INSERT INTO pa_portal_projection_receipts(projection_source_id,delivery_id,workspace_id,delivery_kind,payload_hash,source_sequence,status)
      VALUES(?,?,?,'snapshot_activate',?,1,'completed')`).bind(SOURCE, next('joined-receipt'), id, 'a'.repeat(64)),
    delivery.prepare('INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)').bind(id, generation),
    delivery.prepare('INSERT INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES(?,?,?,?)').bind(identity, issuer, identity, principal.email),
    delivery.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type)
      VALUES(?,?,?,'operations')`).bind(next('joined-membership'), id, identity),
    ...['workspace.view', 'member.manage', 'delivery.view', 'request.create'].map(capability => delivery.prepare(`INSERT INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,scope_type,scope_public_id,source_type)
      VALUES(?,?,?,?,'workspace',?,'operations')`).bind(next('joined-entitlement'), id, identity, capability, id)),
    ...(initialPolicy ? [delivery.prepare(`INSERT INTO portal_workspace_invitation_policies(workspace_id,policy,version,updated_by_staff_id)
      VALUES(?,?,1,?)`).bind(id, initialPolicy, actor.id)] : []),
  ]);
  return { id, project, generation, root, identity, account, principal };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function submit(f: Fixture, accessTerms: ProjectAccessTermsInput = permanent, targetProject = f.project) {
  const email = `${next('named-invitee')}@example.test`, capabilities = ['delivery.view'] as const;
  const target = { scopeType: 'project' as const, publicId: targetProject };
  const requestHash = await invitationApprovalDigest(JSON.stringify({ email, capabilities, target, accessTerms }));
  const result = await submitWorkspaceInvitationRequest(client, f.principal, { workspaceId: f.id,
    requesterIdentityId: f.identity, email, target, capabilities: [...capabilities], accessTerms,
    requestHash, idempotencyKey: next('joined-submit-command') });
  return result.request;
}
async function prepared(f: Fixture, request: WorkspaceInvitationRequestView, decision: 'approve' | 'reject' = 'approve', target = env) {
  const detail = await readStaffInvitationRequest(target, actor, request.id, SOURCE, f.id);
  return { sourceId: SOURCE, workspaceId: f.id, decision, expectedVersion: detail.request.version,
    contextVersion: detail.contextVersion, reason: decision === 'reject' ? 'not approved' : '' };
}
async function decide(f: Fixture, request: WorkspaceInvitationRequestView, decision: 'approve' | 'reject' = 'approve', target = env) {
  const input = await prepared(f, request, decision, target), key = next('joined-decision-command');
  return { input, key, result: await decideStaffInvitationRequest(target, actor, request.id, input, key) };
}
async function policy(f: Fixture, value: 'allowed' | 'disabled' | 'require_approval') {
  const current = await readStaffInvitationPolicy(env, actor, f.id, SOURCE);
  const input = { sourceId: SOURCE, policy: value, expectedVersion: current.version, contextVersion: current.contextVersion };
  const key = next('joined-policy-command');
  return { input, key, result: await changeStaffInvitationPolicy(env, actor, f.id, input, key) };
}
async function records(workspaceId: string) {
  return delivery.prepare(`SELECT
    (SELECT count(*) FROM portal_v2_invitations WHERE workspace_id=?) invitations,
    (SELECT count(*) FROM portal_v2_invitation_email_outbox o JOIN portal_v2_invitations i ON i.id=o.invitation_id WHERE i.workspace_id=?) outbox,
    (SELECT count(*) FROM portal_workspace_invitation_approvals a JOIN portal_workspace_invitation_requests r ON r.id=a.request_id WHERE r.workspace_id=?) approvals`)
    .bind(workspaceId, workspaceId, workspaceId).first<{ invitations: number; outbox: number; approvals: number }>();
}
async function denyManage() {
  await ops.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by)
    VALUES(?,?,'team.manage','deny','global','global',?)`).bind(next('joined-deny'), actor.id, actor.id).run();
}

/** Real query interleaving only: execute the underlying D1 operation and inject
 * a competing committed state change at the selected boundary. */
function intercept(database: D1Database, phase: 'beforeBatch' | 'afterBatch' | 'afterAll' | 'beforeFirst', match: (sql: string[]) => boolean,
  action: () => Promise<void>) {
  let injected = false;
  const sql = new WeakMap<object, string>(), originals = new WeakMap<object, D1PreparedStatement>();
  const inject = async (texts: string[]) => { if (!injected && match(texts)) { injected = true; await action(); } };
  const statement = (raw: D1PreparedStatement, text: string): D1PreparedStatement => {
    const wrapped = new Proxy(raw, { get(target, name) {
      if (name === 'bind') return (...values: unknown[]) => statement(target.bind(...values), text);
      if (name === 'first' && phase === 'beforeFirst') return async (column?: string) => {
        await inject([text]); return column === undefined ? target.first() : target.first(column);
      };
      if (name === 'all' && phase === 'afterAll') return async (...args: []) => {
        const result = await target.all(...args); await inject([text]); return result;
      };
      const value = Reflect.get(target, name, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    sql.set(wrapped, text); originals.set(wrapped, raw); return wrapped;
  };
  const wrap = <T extends D1Database | D1DatabaseSession>(raw: T): T => new Proxy(raw, { get(target, name) {
    if (name === 'withSession') return (...args: Parameters<D1Database['withSession']>) => wrap((target as D1Database).withSession(...args));
    if (name === 'prepare') return (text: string) => statement(target.prepare(text), text);
    if (name === 'batch') return async (statements: D1PreparedStatement[]) => {
      const texts = statements.map(item => sql.get(item) ?? '');
      if (phase === 'beforeBatch') await inject(texts);
      const result = await target.batch(statements.map(item => originals.get(item) ?? item));
      if (phase === 'afterBatch') await inject(texts);
      return result;
    };
    const value = Reflect.get(target, name, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { db: wrap(database), injected: () => injected };
}

describe('Joined Client invitation request and Operations review', { timeout: 120_000, concurrent: false }, () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: '2026-07-22',
      script: "export default {fetch(){return new Response('joined invitation fixture')}}", d1Databases: ['OPS_DB', 'DELIVERY_DB'] });
    ops = await runtime.getD1Database('OPS_DB') as D1Database;
    delivery = await runtime.getD1Database('DELIVERY_DB') as D1Database;
    for (const [database, path, cap] of [[ops, new URL('../migrations/', import.meta.url), '0041'],
      [delivery, new URL('../../client/migrations/', import.meta.url), '0165']] as const) {
      for (const name of readdirSync(path).filter(name => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) <= cap).sort()) {
        await database.batch(splitD1MigrationStatements(readFileSync(new URL(name, path), 'utf8')).map(sql => database.prepare(sql)));
      }
    }
    await delivery.batch(splitD1MigrationStatements(readFileSync(
      new URL('../../client/migrations/0172_project_access_authority_history.sql',import.meta.url),'utf8')).map(sql=>delivery.prepare(sql)));
    await ops.batch([
      ops.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,'active')")
        .bind(actor.id, actor.email, actor.displayName, actor.accessSubject),
      ops.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key)
        VALUES('joined-review-admin-role',?,'role-admin','global','global')`).bind(actor.id),
    ]);
    env = { OPS_DB: ops, DELIVERY_DB: delivery, CLIENT_PORTAL_HIERARCHY_V2_ENABLED: 'true',
      CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: 'true', CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED: 'true',
      PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED: 'true',
      OPERATIONS_SESSION_SECRET: 'joined-review-session-secret-at-least-thirty-two-characters' } as Env;
    client = { ...env, CLIENT_PORTAL_ACCESS_ENROLLMENT_READY: 'true', CLIENT_PORTAL_INVITATION_EMAIL_ENABLED: 'true',
      CLIENT_PORTAL_INVITATION_EMAIL: { send }, CLIENT_PORTAL_INVITATION_FROM: 'invitations@example.test',
      CLIENT_PORTAL_ORIGIN: 'https://client.example.test' } as unknown as ClientEnv;
  }, 240_000);
  beforeEach(async () => {
    send.mockClear();
    await ops.batch([
      ops.prepare('DELETE FROM staff_permission_overrides WHERE staff_id=?').bind(actor.id),
      ops.prepare(`INSERT OR IGNORE INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key)
        VALUES('joined-review-admin-role',?,'role-admin','global','global')`).bind(actor.id),
      ...['team.view', 'team.manage'].map(key => ops.prepare("INSERT OR IGNORE INTO role_permissions(role_id,permission_key) VALUES('role-admin',?)").bind(key)),
    ]);
  }, 60_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await runtime?.dispose(); }, 60_000);

  it('keeps requests non-authorizing, then reviews, publishes, mails and accepts the exact named invitation', async () => {
    const f = await fixture(), request = await submit(f);
    expect(request.status).toBe('pending');
    expect(await records(f.id)).toEqual({ invitations: 0, outbox: 0, approvals: 0 });
    expect(send).not.toHaveBeenCalled();
    const detail = await readStaffInvitationRequest(env, actor, request.id, SOURCE, f.id);
    expect(detail.capabilities).toEqual({ canApprove: true, canReject: true });
    const { result } = await decide(f, request);
    expect(result.request.status).toBe('approved');
    expect(result.request.scope).toEqual({ type: 'project', publicId: f.project });
    expect(result.request.accessTerms?.id).toBe(request.accessTerms?.id);
    expect(await records(f.id)).toEqual({ invitations: 1, outbox: 1, approvals: 1 });
    const invitationId = result.request.invitationId!;
    const raw = await delivery.prepare('SELECT payload_json FROM portal_v2_invitation_email_outbox WHERE invitation_id=?')
      .bind(invitationId).first<string>('payload_json');
    const payload = JSON.parse(raw!) as { token: string };
    expect(await recordInvitationAccessEnrollmentReceipt(client, { invitationId, workspaceId: f.id,
      email: request.email, enrollmentVersion: 1, providerReceiptHash: 'e'.repeat(43), enrolledAt: new Date().toISOString() })).toBe(true);
    expect((await processInvitationEmailBatch(client)).sent).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({ to: request.email });
    const guest = { issuer, subject: next('accepted-invitee'), email: request.email };
    expect(await acceptPortalWorkspaceInvitation(client, guest, payload.token)).toBe('accepted');
    const grants = await delivery.prepare(`SELECT e.access_terms_id,e.scope_type,e.scope_public_id FROM portal_v2_entitlements e
      JOIN portal_v2_identities i ON i.id=e.identity_id WHERE i.issuer=? AND i.subject=? AND e.workspace_id=? AND e.capability='delivery.view'`)
      .bind(guest.issuer, guest.subject, f.id).all();
    expect(grants.results).toEqual([{ access_terms_id: request.accessTerms!.id, scope_type: 'project', scope_public_id: f.project }]);
  });

  it.each([undefined,'false'] as const)('blocks approval without writes but keeps rejection live when the authority mutation flag is %s',async flag=>{
    const f=await fixture(),request=await submit(f),approve=await prepared(f,request,'approve');
    const target={...env,PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED:flag} as Env;
    if(flag===undefined)delete (target as Partial<Env>).PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED;
    const approveKey=next('joined-gated-approve');
    await expect(decideStaffInvitationRequest(target,actor,request.id,approve,approveKey)).rejects.toMatchObject({status:503});
    expect(await records(f.id)).toEqual({invitations:0,outbox:0,approvals:0});
    expect(await delivery.prepare('SELECT status FROM portal_workspace_invitation_requests WHERE id=?').bind(request.id).first<string>('status')).toBe('pending');
    expect(await ops.prepare('SELECT count(*) n FROM invitation_review_authorizations WHERE idempotency_key=?').bind(approveKey).first<number>('n')).toBe(0);

    const reject=await prepared(f,request,'reject',target),rejectKey=next('joined-live-reject');
    const result=await decideStaffInvitationRequest(target,actor,request.id,reject,rejectKey);
    expect(result.request.status).toBe('rejected');
    expect(await records(f.id)).toEqual({invitations:0,outbox:0,approvals:0});
    expect(await ops.prepare('SELECT count(*) n FROM invitation_review_authorizations WHERE idempotency_key=?').bind(rejectKey).first<number>('n')).toBe(1);
  });

  it('keeps read/capability calls free of authorization receipts and invitation side effects', async () => {
    const f = await fixture(), request = await submit(f);
    const before = await ops.prepare('SELECT count(*) n FROM invitation_review_authorizations').first<number>('n');
    expect(await invitationReviewCapabilities(env, actor)).toEqual({ enabled: true, canReview: true, canManagePolicy: true });
    expect((await listStaffInvitationRequests(env, actor, { sourceId: SOURCE, workspaceId: f.id })).items.map(item => item.id)).toEqual([request.id]);
    await readStaffInvitationRequest(env, actor, request.id, SOURCE, f.id);
    await readStaffInvitationPolicy(env, actor, f.id, SOURCE);
    expect(await ops.prepare('SELECT count(*) n FROM invitation_review_authorizations').first<number>('n')).toBe(before);
    expect(await records(f.id)).toEqual({ invitations: 0, outbox: 0, approvals: 0 });
  });

  it('keeps policy DTOs allowlisted and review hashes stable when internal callers carry extra command fields', async () => {
    const f = await fixture(), request = await submit(f);
    const coordinates = { sourceId: SOURCE, workspaceId: f.id };
    const extended = { ...coordinates, requestId: request.id, decision: 'approve' as const,
      authorization: { id: 'private-authorization', fingerprint: 'a'.repeat(64), actorStaffId: actor.id,
        publicationDeadline: new Date(Date.now() + 300_000).toISOString() },
      idempotencyKey: 'private-command-key', expectedContextVersion: 'b'.repeat(64), expectedVersion: 1 };
    const clean = await readWorkspaceInvitationPolicyContext(delivery, coordinates);
    const carried = await readWorkspaceInvitationPolicyContext(delivery, extended);
    expect(carried).toEqual(clean);
    expect(Object.keys(carried).sort()).toEqual(['sourceId', 'workspaceId', 'workspaceName', 'policy', 'version', 'contextVersion'].sort());
    const plainReview = await prepareWorkspaceInvitationDecision(env, { ...coordinates, requestId: request.id, decision: 'approve' });
    const carriedReview = await prepareWorkspaceInvitationDecision(env, extended);
    expect(carriedReview.contextVersion).toBe(plainReview.contextVersion);
    const staffPolicy = await readStaffInvitationPolicy(env, actor, f.id, SOURCE);
    expect(Object.keys(staffPolicy).sort()).toEqual([...Object.keys(clean), 'capabilities'].sort());
    expect(JSON.stringify(staffPolicy)).not.toContain('private-command-key');
    expect(await records(f.id)).toEqual({ invitations: 0, outbox: 0, approvals: 0 });
  });

  it('rejects cross-workspace/source coordinates instead of resolving a request by raw ID', async () => {
    const f = await fixture(), another = await fixture(), request = await submit(f);
    await expect(readStaffInvitationRequest(env, actor, request.id, SOURCE, another.id)).rejects.toMatchObject({ status: 404 });
    await expect(readStaffInvitationRequest(env, actor, request.id, 'project-alpha:foreign', f.id)).rejects.toMatchObject({ status: 403 });
    const input = await prepared(f, request);
    await expect(decideStaffInvitationRequest(env, actor, request.id, { ...input, workspaceId: another.id }, next('joined-wrong-scope'))).rejects.toMatchObject({ status: 404 });
    expect(await records(f.id)).toEqual({ invitations: 0, outbox: 0, approvals: 0 });
  });

  it('does not let approval broaden a requested project or the requester lifetime ceiling', async () => {
    const f = await fixture();
    await delivery.prepare("UPDATE portal_v2_entitlements SET expires_at=datetime('now','+1 day') WHERE workspace_id=? AND capability='member.manage'")
      .bind(f.id).run();
    await expect(submit(f, permanent)).rejects.toMatchObject({ status: 403 });
    const request = await submit(f, { kind: 'collaborator', mode: 'specific_date', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const input = await prepared(f, request);
    await expect(decideStaffInvitationRequest(env, actor, request.id, { ...input, projectId: 'different-project' }, next('joined-broadening')))
      .rejects.toMatchObject({ status: 400 });
    expect((await decide(f, request)).result.request.scope.publicId).toBe(f.project);
  });

  it('invalidates pending review on an exact workspace policy version change', async () => {
    const f = await fixture(), request = await submit(f), input = await prepared(f, request);
    await policy(f, 'disabled');
    const detail = await readStaffInvitationRequest(env, actor, request.id, SOURCE, f.id);
    expect(detail.request.status).toBe('stale');
    expect(detail.capabilities.canApprove).toBe(false);
    await expect(decideStaffInvitationRequest(env, actor, request.id, input, next('joined-stale-policy'))).rejects.toMatchObject({ status: 409 });
    expect(await records(f.id)).toEqual({ invitations: 0, outbox: 0, approvals: 0 });
  });

  it('does not borrow staff power after the requester membership or requested capability is revoked', async () => {
    const f = await fixture(), request = await submit(f), input = await prepared(f, request);
    await delivery.prepare("UPDATE portal_v2_workspace_memberships SET status='revoked',revoked_at=datetime('now') WHERE workspace_id=? AND identity_id=?")
      .bind(f.id, f.identity).run();
    expect((await readStaffInvitationRequest(env, actor, request.id, SOURCE, f.id)).capabilities.canApprove).toBe(false);
    await expect(decideStaffInvitationRequest(env, actor, request.id, input, next('joined-revoked-inviter'))).rejects.toMatchObject({ status: 409 });
    expect(await records(f.id)).toEqual({ invitations: 0, outbox: 0, approvals: 0 });
  });

  it('returns current readonly capabilities after manage permission disappears during list hydration', async () => {
    const f = await fixture(), request = await submit(f);
    const race = intercept(delivery, 'afterAll', sql => sql.some(value => value.includes('FROM portal_workspace_invitation_requests r') && value.includes('ORDER BY r.created_at')), denyManage);
    const result = await listStaffInvitationRequests({ ...env, DELIVERY_DB: race.db }, actor, { sourceId: SOURCE, workspaceId: f.id });
    expect(race.injected()).toBe(true);
    expect(result.items.map(item => item.id)).toEqual([request.id]);
    expect(result.capabilities.canReview).toBe(false);
  });

  it.each(['approve', 'reject'] as const)('replays a committed %s after the publication window without new invitation or audit rows', async decision => {
    const f = await fixture(), request = await submit(f), { result, input, key } = await decide(f, request, decision);
    const before = await records(f.id), audit = await delivery.prepare('SELECT count(*) n FROM portal_workspace_invitation_request_audit WHERE request_id=?').bind(request.id).first<number>('n');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
    const retry = await decideStaffInvitationRequest(env, actor, request.id, input, key);
    expect(retry.replayed).toBe(true);
    expect(retry.request.id).toBe(result.request.id);
    expect(retry.request.status).toBe(result.request.status);
    expect(await records(f.id)).toEqual(before);
    expect(await delivery.prepare('SELECT count(*) n FROM portal_workspace_invitation_request_audit WHERE request_id=?').bind(request.id).first<number>('n')).toBe(audit);
  });

  it('replays a committed policy command after five minutes without changing the policy version', async () => {
    const f = await fixture(null), { input, key, result } = await policy(f, 'require_approval');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
    const retry = await changeStaffInvitationPolicy(env, actor, f.id, input, key);
    expect(retry.replayed).toBe(true);
    expect(retry.policy.version).toBe(result.policy.version);
    expect(retry.policy.contextVersion).toBe(result.policy.contextVersion);
  });

  it('does not replay an obsolete policy result after another administrator command supersedes it', async () => {
    const f = await fixture(null), original = await policy(f, 'require_approval');
    const latest = await policy(f, 'disabled');
    const before = await ops.prepare('SELECT count(*) n FROM invitation_review_authorizations').first<number>('n');
    const audit = await delivery.prepare('SELECT count(*) n FROM portal_workspace_invitation_request_audit WHERE workspace_id=?').bind(f.id).first<number>('n');
    await expect(changeStaffInvitationPolicy(env, actor, f.id, original.input, original.key)).rejects.toMatchObject({ status: 409 });
    expect((await readStaffInvitationPolicy(env, actor, f.id, SOURCE)).version).toBe(latest.result.policy.version);
    expect(await ops.prepare('SELECT count(*) n FROM invitation_review_authorizations').first<number>('n')).toBe(before);
    expect(await delivery.prepare('SELECT count(*) n FROM portal_workspace_invitation_request_audit WHERE workspace_id=?').bind(f.id).first<number>('n')).toBe(audit);
  });

  it.each(['', 'Révision requise — 请重新提交'])('accepts the pinned optional Unicode rejection reason: %s', async reason => {
    const f = await fixture(), request = await submit(f), input = await prepared(f, request, 'reject');
    const result = await decideStaffInvitationRequest(env, actor, request.id, { ...input, reason }, next('joined-unicode-reason'));
    expect(result.request.status).toBe('rejected');
    expect(result.request.reasonCode).toBe(reason);
    expect(await records(f.id)).toEqual({ invitations: 0, outbox: 0, approvals: 0 });
  });

  it('rejects changed command bodies and actor spoofing on an existing key', async () => {
    const f = await fixture(), request = await submit(f), { input, key } = await decide(f, request, 'reject');
    await expect(decideStaffInvitationRequest(env, actor, request.id, { ...input, reason: 'different decision reason' }, key)).rejects.toMatchObject({ status: 409 });
    await expect(decideStaffInvitationRequest(env, actor, request.id, { ...input, actorId: 'forged-admin' }, next('joined-actor-spoof'))).rejects.toMatchObject({ status: 400 });
  });

  it('does not publish a staged invitation when the workspace policy changes between databases', async () => {
    const f = await fixture(), request = await submit(f), input = await prepared(f, request);
    const race = intercept(delivery, 'afterBatch', sql => sql.some(value => value.includes('INSERT INTO portal_workspace_invitation_approvals')),
      async () => { await delivery.prepare("UPDATE portal_workspace_invitation_policies SET policy='disabled',version=version+1 WHERE workspace_id=?").bind(f.id).run(); });
    await expect(decideStaffInvitationRequest({ ...env, DELIVERY_DB: race.db }, actor, request.id, input, next('joined-policy-race'))).rejects.toBeDefined();
    expect(race.injected()).toBe(true);
    expect(await delivery.prepare(`SELECT count(*) n FROM portal_workspace_invitation_publications WHERE request_id=? AND published=1`).bind(request.id).first<number>('n')).toBe(0);
    const outbox = await delivery.prepare(`SELECT o.status,o.payload_json FROM portal_v2_invitation_email_outbox o JOIN portal_v2_invitations i ON i.id=o.invitation_id WHERE i.workspace_id=?`).bind(f.id).all();
    expect(outbox.results).toEqual([{ status: 'cancelled', payload_json: '{"redacted":true}' }]);
    expect(send).not.toHaveBeenCalled();
  });

  it('closes only its staged invitation when staff authority is revoked before publication', async () => {
    const f = await fixture(), request = await submit(f), input = await prepared(f, request);
    const race = intercept(delivery, 'afterBatch', sql => sql.some(value => value.includes('INSERT INTO portal_workspace_invitation_approvals')), denyManage);
    await expect(decideStaffInvitationRequest({ ...env, DELIVERY_DB: race.db }, actor, request.id, input, next('joined-staff-race'))).rejects.toMatchObject({ status: 409 });
    expect(race.injected()).toBe(true);
    expect(await delivery.prepare('SELECT status FROM portal_v2_invitations WHERE workspace_id=?').bind(f.id).first<string>('status')).toBe('revoked');
    expect(await delivery.prepare('SELECT status FROM portal_workspace_invitation_approvals WHERE request_id=?').bind(request.id).first<string>('status')).toBe('closed');
  });

  it('closes an unpublished stage when its original publication deadline passes, without treating it as a completed retry', async () => {
    const f = await fixture(), request = await submit(f), input = await prepared(f, request), key = next('joined-expired-stage');
    const race = intercept(delivery, 'afterBatch', sql => sql.some(value => value.includes('INSERT INTO portal_workspace_invitation_approvals')),
      async () => { vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000); });
    await expect(decideStaffInvitationRequest({ ...env, DELIVERY_DB: race.db }, actor, request.id, input, key)).rejects.toMatchObject({ status: 409 });
    expect(race.injected()).toBe(true);
    expect(await delivery.prepare('SELECT status FROM portal_workspace_invitation_approvals WHERE request_id=?').bind(request.id).first<string>('status')).toBe('closed');
    expect(await delivery.prepare('SELECT status FROM portal_v2_invitations WHERE workspace_id=?').bind(f.id).first<string>('status')).toBe('revoked');
    await expect(decideStaffInvitationRequest(env, actor, request.id, input, key)).rejects.toMatchObject({ status: 409 });
    expect(await records(f.id)).toEqual({ invitations: 1, outbox: 1, approvals: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it('preserves the original failure if cleanup also fails, and never publishes that expired stage on retry', async () => {
    const f = await fixture(), request = await submit(f), input = await prepared(f, request), key = next('joined-cleanup-failure');
    const original = new Error('synthetic-post-stage-ops-proof-unavailable'), cleanup = new Error('synthetic-cleanup-unavailable');
    let staged = false;
    const cleanupRace = intercept(delivery, 'beforeBatch', sql => sql.some(value => value.includes("SET status='closed'")), async () => { throw cleanup; });
    const stageRace = intercept(cleanupRace.db, 'afterBatch', sql => sql.some(value => value.includes('INSERT INTO portal_workspace_invitation_approvals')), async () => { staged = true; });
    const proofRace = intercept(ops, 'beforeFirst', sql => staged && sql.some(value => value.includes("'connectorState'")), async () => { throw original; });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(decideStaffInvitationRequest({ ...env, DELIVERY_DB: stageRace.db, OPS_DB: proofRace.db }, actor, request.id, input, key)).rejects.toBe(original);
    expect(stageRace.injected()).toBe(true);
    expect(proofRace.injected()).toBe(true);
    expect(cleanupRace.injected()).toBe(true);
    expect(warning).toHaveBeenCalledWith('invitation_review_cleanup_incomplete', { authorizationId: expect.any(String) });
    expect(await delivery.prepare('SELECT status FROM portal_workspace_invitation_approvals WHERE request_id=?').bind(request.id).first<string>('status')).toBe('staged');
    expect(await delivery.prepare('SELECT published FROM portal_workspace_invitation_publications WHERE request_id=?').bind(request.id).first<number>('published')).toBe(0);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
    await expect(decideStaffInvitationRequest(env, actor, request.id, input, key)).rejects.toMatchObject({ status: 409 });
    expect(await delivery.prepare('SELECT status FROM portal_workspace_invitation_approvals WHERE request_id=?').bind(request.id).first<string>('status')).toBe('closed');
    expect(await records(f.id)).toEqual({ invitations: 1, outbox: 1, approvals: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it('preserves already-published state after a lost publication response and recovers through exact retry', async () => {
    const f = await fixture(), request = await submit(f), input = await prepared(f, request), key = next('joined-lost-response');
    const race = intercept(delivery, 'afterBatch', sql => sql.some(value => value.includes("SET status='published'")),
      async () => { throw new Error('synthetic-lost-publication-response'); });
    const recovered = await decideStaffInvitationRequest({ ...env, DELIVERY_DB: race.db }, actor, request.id, input, key);
    expect(recovered.request.status).toBe('approved');
    expect(race.injected()).toBe(true);
    const committed = await readWorkspaceInvitationRequest(delivery, { sourceId: SOURCE, workspaceId: f.id, requestId: request.id });
    expect(committed?.status).toBe('approved');
    expect(await delivery.prepare('SELECT status FROM portal_v2_invitations WHERE workspace_id=?').bind(f.id).first<string>('status')).toBe('pending');
    const retry = await decideStaffInvitationRequest(env, actor, request.id, input, key);
    expect(retry.replayed).toBe(true);
    expect(retry.request.invitationId).toBe(committed?.invitationId);
    expect(await records(f.id)).toEqual({ invitations: 1, outbox: 1, approvals: 1 });
  });

  it('cannot replay a committed decision after the reviewing staff loses current permission', async () => {
    const f = await fixture(), request = await submit(f), { input, key } = await decide(f, request, 'reject');
    await denyManage();
    await expect(decideStaffInvitationRequest(env, actor, request.id, input, key)).rejects.toMatchObject({ status: 403 });
  });
});
