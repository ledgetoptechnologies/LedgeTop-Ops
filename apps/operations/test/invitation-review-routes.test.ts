import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HTTPException } from 'hono/http-exception';

const mocks = vi.hoisted(() => ({
  authenticateStaff: vi.fn(), isAdministrator: vi.fn(), invitationReviewCapabilities: vi.fn(),
  readStaffInvitationPolicy: vi.fn(), changeStaffInvitationPolicy: vi.fn(), listStaffInvitationRequests: vi.fn(),
  readStaffInvitationRequest: vi.fn(), decideStaffInvitationRequest: vi.fn(),
}));
vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock('../src/worker/auth', () => ({ authenticateStaff: mocks.authenticateStaff }));
vi.mock('../src/worker/acl', async original => ({ ...await original<typeof import('../src/worker/acl')>(), isAdministrator: mocks.isAdministrator }));
vi.mock('../src/worker/invitation-review', () => ({
  invitationReviewCapabilities: mocks.invitationReviewCapabilities,
  readStaffInvitationPolicy: mocks.readStaffInvitationPolicy,
  changeStaffInvitationPolicy: mocks.changeStaffInvitationPolicy,
  listStaffInvitationRequests: mocks.listStaffInvitationRequests,
  readStaffInvitationRequest: mocks.readStaffInvitationRequest,
  decideStaffInvitationRequest: mocks.decideStaffInvitationRequest,
}));
import worker from '../src/worker/index';
import { csrfToken } from '../src/worker/request-security';
import type { Env, StaffPrincipal } from '../src/worker/types';

const ROOT = '/api/client-portal/invitation-requests';
const POLICY = '/api/client-portal/workspaces/workspace-fixture/invitation-policy';
const selected = '?sourceId=project-alpha%3Aprimary&workspaceId=workspace-fixture';
const actor: StaffPrincipal = { id: 'review-route-admin', email: 'review-route@example.test', displayName: 'Review route administrator',
  accessSubject: 'review-route-verified-subject', projectAlphaUserId: null };
const env = { ENVIRONMENT: 'development', EXPECTED_HOST: 'ops.example', INCOMING_EXPECTED_HOST: 'incoming.example',
  PUBLIC_BASE_URL: 'https://ops.example', OPERATIONS_SESSION_SECRET: 'review-route-session-secret-at-least-thirty-two-characters' } as Env;
const execution = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const capabilities = { enabled: true, canReview: true, canManagePolicy: true };
const decision = { sourceId: 'project-alpha:primary', workspaceId: 'workspace-fixture', decision: 'approve',
  expectedVersion: 1, contextVersion: 'a'.repeat(64), reason: '' };
const policy = { sourceId: 'project-alpha:primary', policy: 'require_approval', expectedVersion: 0, contextVersion: 'b'.repeat(64) };
const mutationCalls = () => mocks.decideStaffInvitationRequest.mock.calls.length + mocks.changeStaffInvitationPolicy.mock.calls.length;

async function request(path: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}, raw?: BodyInit) {
  const supplied = new Headers(headers);
  if (method !== 'GET') {
    if (!supplied.has('Origin')) supplied.set('Origin', 'https://ops.example');
    if (!supplied.has('X-CSRF-Token')) supplied.set('X-CSRF-Token', await csrfToken(env, actor));
    if (!supplied.has('Content-Type')) supplied.set('Content-Type', 'application/json');
    if (!supplied.has('Idempotency-Key')) supplied.set('Idempotency-Key', 'review-route-command');
  }
  return worker.fetch(new Request(`https://ops.example${path}`, { method, headers: supplied,
    ...(raw !== undefined ? { body: raw } : value === undefined ? {} : { body: JSON.stringify(value) }),
    ...(raw instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit), env, execution);
}

// These are the actual Worker/authentication/CSRF/route boundaries. Domain
// results are isolated here; the adjacent real-D1 suite verifies authority.
describe('Invitation review HTTP envelopes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateStaff.mockReset().mockResolvedValue(actor);
    mocks.isAdministrator.mockReset().mockResolvedValue(true);
    mocks.invitationReviewCapabilities.mockReset().mockResolvedValue(capabilities);
    mocks.listStaffInvitationRequests.mockReset().mockResolvedValue({ items: [], page: { hasMore: false, nextCursor: null, limit: 25 }, capabilities: { canReview: true } });
    mocks.readStaffInvitationRequest.mockReset().mockResolvedValue({ request: { id: 'request-fixture' }, capabilities: { canApprove: true, canReject: true } });
    mocks.readStaffInvitationPolicy.mockReset().mockResolvedValue({ policy: 'allowed', version: 0, capabilities: { canManagePolicy: true } });
    mocks.changeStaffInvitationPolicy.mockReset().mockResolvedValue({ policy: { policy: 'require_approval', version: 1 }, replayed: false });
    mocks.decideStaffInvitationRequest.mockReset().mockResolvedValue({ request: { id: 'request-fixture', status: 'approved' }, replayed: false });
  });
  afterEach(() => { vi.useRealTimers(); });

  it.each([
    `${ROOT}/capabilities`, ROOT, `${ROOT}/request-fixture${selected}`, `${POLICY}?sourceId=project-alpha%3Aprimary`,
  ])('requires authentication for GET %s before domain reads', async path => {
    mocks.authenticateStaff.mockRejectedValue(new HTTPException(401, { message: 'Authentication required' }));
    expect((await request(path)).status).toBe(401);
    expect(mocks.invitationReviewCapabilities).not.toHaveBeenCalled();
    expect(mocks.listStaffInvitationRequests).not.toHaveBeenCalled();
    expect(mocks.readStaffInvitationRequest).not.toHaveBeenCalled();
    expect(mocks.readStaffInvitationPolicy).not.toHaveBeenCalled();
  });

  it('mounts capabilities before the request-id route and keeps all reads nonmutating/no-store', async () => {
    const cap = await request(`${ROOT}/capabilities`);
    expect(await cap.json()).toEqual(capabilities);
    expect(cap.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.readStaffInvitationRequest).not.toHaveBeenCalled();
    for (const path of [ROOT, `${ROOT}/request-fixture${selected}`, `${POLICY}?sourceId=project-alpha%3Aprimary`]) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(mutationCalls()).toBe(0);
  });

  it.each([
    `${ROOT}/capabilities?sourceId=project-alpha%3Aprimary`, `${ROOT}?status=pending&status=all`,
    `${ROOT}?unknown=1`, `${ROOT}/request-fixture?sourceId=project-alpha%3Aprimary`,
    `${ROOT}/request-fixture${selected}&workspaceId=other`, `${POLICY}?sourceId=project-alpha%3Aprimary&sourceId=project-alpha%3Ab`,
    `${POLICY}`, `${ROOT}?cursor=${'x'.repeat(4097)}`,
  ])('rejects unsupported, duplicate, missing or oversized query fields: %s', async path => {
    expect((await request(path)).status).toBe(400);
    expect(mutationCalls()).toBe(0);
  });

  it('forwards exact selection, authenticated actor and command key to the coordinator', async () => {
    await request(`${ROOT}?sourceId=project-alpha%3Aprimary&workspaceId=workspace-fixture&status=pending&q=A%26B&limit=10`);
    expect(mocks.listStaffInvitationRequests).toHaveBeenCalledWith(env, actor, {
      sourceId: 'project-alpha:primary', workspaceId: 'workspace-fixture', status: 'pending', q: 'A&B', limit: '10',
    });
    expect((await request(`${ROOT}/request-fixture/decision`, 'POST', decision)).status).toBe(200);
    expect(mocks.decideStaffInvitationRequest).toHaveBeenCalledWith(env, actor, 'request-fixture', decision, 'review-route-command');
    expect((await request(POLICY, 'PATCH', policy)).status).toBe(200);
    expect(mocks.changeStaffInvitationPolicy).toHaveBeenCalledWith(env, actor, 'workspace-fixture', policy, 'review-route-command');
  });

  it.each([
    { path: `${ROOT}/request-fixture/decision`, method: 'POST', body: decision },
    { path: POLICY, method: 'PATCH', body: policy },
  ])('rejects wrong origin and missing/invalid CSRF before $method $path', async entry => {
    const invalidHeaders: Record<string, string>[] = [{ Origin: 'https://foreign.example' }, { 'X-CSRF-Token': '' }, { 'X-CSRF-Token': 'invalid' }];
    for (const headers of invalidHeaders) {
      expect((await request(entry.path, entry.method, entry.body, headers)).status).toBe(403);
    }
    expect(mutationCalls()).toBe(0);
  });

  it.each([
    { contentType: 'text/plain', body: '{}' , status: 415 },
    { contentType: 'application/json', body: '{broken', status: 400 },
    { contentType: 'application/json', body: 'x'.repeat(8193), status: 413 },
  ])('rejects malformed or unbounded bodies without reaching the coordinator: $status', async entry => {
    expect((await request(`${ROOT}/request-fixture/decision`, 'POST', undefined,
      { 'Content-Type': entry.contentType }, entry.body)).status).toBe(entry.status);
    expect(mutationCalls()).toBe(0);
  });

  it('bounds streamed bodies even when Content-Length is absent', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(4096).fill(32)); controller.enqueue(new Uint8Array(4097).fill(32)); controller.close();
    } });
    expect((await request(`${ROOT}/request-fixture/decision`, 'POST', undefined, {}, stream)).status).toBe(413);
    expect(mutationCalls()).toBe(0);
  });

  it('times out a stalled body and cancels the reader without invoking a mutation', async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    let reading!: () => void;
    const readStarted = new Promise<void>(resolve => { reading = resolve; });
    // Wait for the actual route reader, not for asynchronous CSRF crypto, before advancing its deadline.
    const stream = new ReadableStream<Uint8Array>({ pull: reading, cancel: cancelled }, { highWaterMark: 0 });
    const pending = request(`${ROOT}/request-fixture/decision`, 'POST', undefined, {}, stream);
    await readStarted;
    await vi.advanceTimersByTimeAsync(6000);
    expect((await pending).status).toBe(408);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(mutationCalls()).toBe(0);
  });

  it('does not execute a decision through GET or a policy mutation through POST', async () => {
    expect((await request(`${ROOT}/request-fixture/decision`)).status).toBe(404);
    expect((await request(POLICY, 'POST', policy)).status).toBe(404);
    expect(mutationCalls()).toBe(0);
  });

  it('preserves coordinator denials and conflicts instead of returning success', async () => {
    mocks.decideStaffInvitationRequest.mockRejectedValueOnce(new HTTPException(403, { message: 'invitation_review_forbidden' }));
    expect((await request(`${ROOT}/request-fixture/decision`, 'POST', decision)).status).toBe(403);
    mocks.decideStaffInvitationRequest.mockRejectedValueOnce(new HTTPException(409, { message: 'invitation_review_context_changed' }));
    expect((await request(`${ROOT}/request-fixture/decision`, 'POST', decision)).status).toBe(409);
  });
});
