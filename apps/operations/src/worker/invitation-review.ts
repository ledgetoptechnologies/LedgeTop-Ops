import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { decryptDeliveryToken, encryptDeliveryToken } from './crypto';
import {
  invitationRequestsReady, readWorkspaceInvitationPolicyContext, applyWorkspaceInvitationPolicy,
  listWorkspaceInvitationRequests, readWorkspaceInvitationReviewReplay, prepareWorkspaceInvitationDecision,
  stageApprovedWorkspaceInvitation, publishApprovedWorkspaceInvitation, abandonStagedWorkspaceInvitation,
  rejectWorkspaceInvitationRequest,
} from '../../../client/src/worker/client-portal/workspace-invitation-requests';
import {
  invitationReviewStaffCapabilities, captureInvitationReviewProof, assertInvitationReviewProof,
  invitationReviewChanged, invitationReviewIdempotency, invitationReviewDigest,
  readInvitationReviewAuthorization, reserveInvitationReviewAuthorization, assertInvitationReviewPublication,
  type InvitationReviewAuthorization, type InvitationReviewProof,
} from './invitation-review-authority';
import type { Env, StaffPrincipal } from './types';
import {requireProjectAccessAuthorityMutations} from './project-access-mutation-gate';

const opaque = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const source = z.string().regex(/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/);
const context = z.string().regex(/^[a-f0-9]{64}$/);
const policyInput = z.object({ sourceId: source, policy: z.enum(['allowed', 'disabled', 'require_approval']),
  expectedVersion: z.number().int().nonnegative(), contextVersion: context }).strict();
const decisionInput = z.object({ sourceId: source, workspaceId: opaque, decision: z.enum(['approve', 'reject']),
  expectedVersion: z.number().int().positive(), contextVersion: context,
  reason: z.string().trim().max(500).refine(value => !/[\u0000-\u001f\u007f]/.test(value)).default('') }).strict();
const listInput = z.object({ sourceId: source.optional(), workspaceId: opaque.optional(),
  status: z.enum(['open', 'pending', 'approving', 'approved', 'rejected', 'cancelled', 'stale', 'all']).default('open'),
  q: z.string().max(100).refine(value => !/[\u0000-\u001f\u007f]/.test(value)).default(''),
  cursor: z.string().max(4096).optional(), limit: z.coerce.number().int().min(1).max(50).default(25),
}).strict().refine(value => !value.workspaceId || value.sourceId);
const cursorSchema = z.object({ v: z.literal(1), selection: context,
  after: z.object({ createdAt: z.string().min(1).max(64), id: opaque }).strict(), expires: z.number().int().positive() }).strict();
type ReviewCursor = z.infer<typeof cursorSchema>;

function invalid(): never { throw new HTTPException(400, { message: 'invitation_review_invalid' }); }
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value); return parsed.success ? parsed.data : invalid();
}
const database = (env: Env) => env.DELIVERY_DB.withSession('first-primary');
const authorization = (receipt: InvitationReviewAuthorization) => ({ id: receipt.id, actorStaffId: receipt.actor_id,
  fingerprint: receipt.fingerprint, publicationDeadline: receipt.publication_deadline });
const reviewContext = (proof: InvitationReviewProof, deliveryContext: string) => invitationReviewDigest([proof.json, deliveryContext]);

export async function invitationReviewCapabilities(env: Env, actor: StaffPrincipal) {
  const capabilities = await invitationReviewStaffCapabilities(env, actor);
  if (!capabilities.enabled || !await invitationRequestsReady(database(env)))
    return { enabled: false, canReview: false, canManagePolicy: false };
  return capabilities;
}
async function readable(env: Env, actor: StaffPrincipal) {
  const capabilities = await invitationReviewCapabilities(env, actor);
  if (!capabilities.enabled) throw new HTTPException(403, { message: 'invitation_review_unavailable' });
  return capabilities;
}
async function currentPolicy(env: Env, actor: StaffPrincipal, workspaceId: string, sourceId: string, mutation = false) {
  parse(opaque, workspaceId); parse(source, sourceId);
  await readable(env, actor);
  const proof = await captureInvitationReviewProof(env, actor, sourceId, mutation);
  const policy = await readWorkspaceInvitationPolicyContext(database(env), { sourceId, workspaceId });
  await assertInvitationReviewProof(env, proof);
  return { proof, policy };
}
export async function readStaffInvitationPolicy(env: Env, actor: StaffPrincipal, workspaceId: string, sourceId: string) {
  const { proof, policy } = await currentPolicy(env, actor, workspaceId, sourceId);
  return { ...policy, contextVersion: await reviewContext(proof, policy.contextVersion),
    capabilities: { canManagePolicy: proof.canManage } };
}

/** Receipts bind the reviewed operation, not just a browser-generated key. On
 * an uncertain retry the Delivery handler resolves the same immutable command. */
async function savedReceipt(env: Env, actor: StaffPrincipal, proof: InvitationReviewProof, key: string,
  action: 'approve' | 'reject' | 'policy', workspaceId: string, subjectId: string, operation: unknown) {
  const receipt = await readInvitationReviewAuthorization(env, actor.id, key);
  if (!receipt) return null;
  const fingerprint = await invitationReviewDigest([action, proof.sourceId, workspaceId, subjectId, operation]);
  if (receipt.fingerprint !== fingerprint) throw new HTTPException(409, { message: 'invitation_review_idempotency_conflict' });
  if (receipt.ops_proof_json !== proof.json) invitationReviewChanged();
  return receipt;
}
export async function changeStaffInvitationPolicy(env: Env, actor: StaffPrincipal, workspaceId: string, value: unknown, keyValue: string) {
  parse(opaque, workspaceId);
  const input = parse(policyInput, value), key = invitationReviewIdempotency(keyValue);
  await readable(env, actor);
  const proof = await captureInvitationReviewProof(env, actor, input.sourceId, true);
  let receipt = await savedReceipt(env, actor, proof, key, 'policy', workspaceId, workspaceId, input);
  if (receipt) {
    const completed = await readWorkspaceInvitationReviewReplay(database(env), { sourceId: input.sourceId, workspaceId,
      action: 'policy', authorizationId: receipt.id, actorStaffId: actor.id, idempotencyKey: key });
    if (completed?.policy) {
      await assertInvitationReviewProof(env, proof);
      // A later administrator change is not the result of this command. Send
      // the caller back to a fresh review instead of an endless uncertain retry.
      if (completed.policy.policy !== input.policy || completed.policy.version !== input.expectedVersion + 1)
        invitationReviewChanged();
      return { policy: { ...completed.policy, contextVersion: await reviewContext(proof, completed.policy.contextVersion),
        capabilities: { canManagePolicy: proof.canManage } }, replayed: true };
    }
  }
  if (!receipt) {
    const policy = await readWorkspaceInvitationPolicyContext(database(env), { sourceId: input.sourceId, workspaceId });
    if (input.contextVersion !== await reviewContext(proof, policy.contextVersion) || input.expectedVersion !== policy.version)
      invitationReviewChanged();
    receipt = await reserveInvitationReviewAuthorization(env, actor, proof, { action: 'policy', workspaceId,
      subjectId: workspaceId, idempotencyKey: key, operation: input, deliveryContext: policy.contextVersion });
  }
  await assertInvitationReviewPublication(env, proof, receipt);
  const result = await applyWorkspaceInvitationPolicy(database(env), { sourceId: input.sourceId, workspaceId,
    policy: input.policy, expectedVersion: input.expectedVersion, expectedContextVersion: receipt.delivery_context,
    authorization: authorization(receipt), idempotencyKey: key });
  await assertInvitationReviewProof(env, proof);
  if (result.policy.policy !== input.policy || result.policy.version !== input.expectedVersion + 1)
    invitationReviewChanged();
  return { policy: { ...result.policy, contextVersion: await reviewContext(proof, result.policy.contextVersion),
    capabilities: { canManagePolicy: proof.canManage } }, replayed: result.replayed };
}

async function encodeCursor(env: Env, actor: StaffPrincipal, value: ReviewCursor): Promise<string> {
  const encrypted = await encryptDeliveryToken(JSON.stringify(value), env.OPERATIONS_SESSION_SECRET, 'invitation-review:' + actor.id);
  return encrypted.iv + '.' + encrypted.ciphertext;
}
async function decodeCursor(env: Env, actor: StaffPrincipal, value: string, selection: string): Promise<ReviewCursor> {
  let cursor: ReviewCursor;
  try {
    const [iv, ciphertext, extra] = value.split('.');
    if (!iv || !ciphertext || extra !== undefined) return invalid();
    cursor = cursorSchema.parse(JSON.parse(await decryptDeliveryToken(ciphertext, iv, env.OPERATIONS_SESSION_SECRET, 'invitation-review:' + actor.id)));
  } catch { return invalid(); }
  if (cursor.selection !== selection || cursor.expires <= Date.now()) invitationReviewChanged();
  return cursor;
}
export async function listStaffInvitationRequests(env: Env, actor: StaffPrincipal, value: unknown) {
  const input = parse(listInput, value);
  await readable(env, actor);
  const selection = await invitationReviewDigest([actor.id, input.sourceId ?? null, input.workspaceId ?? null,
    input.status, input.q.normalize('NFC').trim(), input.limit]);
  const cursor = input.cursor ? await decodeCursor(env, actor, input.cursor, selection) : null;
  if (input.sourceId) await captureInvitationReviewProof(env, actor, input.sourceId, false);
  const result = await listWorkspaceInvitationRequests(database(env), { sourceId: input.sourceId, workspaceId: input.workspaceId,
    status: input.status === 'all' ? undefined : input.status, q: input.q.normalize('NFC').trim(), after: cursor?.after, limit: input.limit });
  const proofs = new Map<string, InvitationReviewProof | null>();
  const items: typeof result.items = [];
  for (const item of result.items) {
    if (!proofs.has(item.sourceId)) {
      try { proofs.set(item.sourceId, await captureInvitationReviewProof(env, actor, item.sourceId, false)); }
      catch (cause) {
        if (cause instanceof HTTPException && cause.status === 403) proofs.set(item.sourceId, null);
        else throw cause;
      }
    }
    const proof = proofs.get(item.sourceId);
    if (proof) items.push({ ...item, sourceName: proof.sourceName });
  }
  for (const proof of proofs.values()) if (proof) await assertInvitationReviewProof(env, proof);
  const finalCapabilities = await readable(env, actor);
  // Hidden-source rows are not exposed, but still advance the opaque cursor.
  // This is a bounded live page, not a claim that an empty page is the end.
  const nextCursor = result.hasMore && result.nextAfter ? await encodeCursor(env, actor,
    { v: 1, selection, after: result.nextAfter, expires: Date.now() + 15 * 60_000 }) : null;
  return { items, page: { hasMore: result.hasMore, nextCursor, limit: input.limit }, capabilities: { canReview: finalCapabilities.canReview } };
}

export async function readStaffInvitationRequest(env: Env, actor: StaffPrincipal, requestId: string, sourceId: string, workspaceId: string) {
  parse(opaque, requestId); parse(opaque, workspaceId); parse(source, sourceId);
  await readable(env, actor);
  const proof = await captureInvitationReviewProof(env, actor, sourceId, false);
  const prepared = await prepareWorkspaceInvitationDecision(env, { sourceId, workspaceId, requestId, decision: 'approve' });
  await assertInvitationReviewProof(env, proof);
  return { request: { ...prepared.request, sourceName: proof.sourceName },
    contextVersion: await reviewContext(proof, prepared.contextVersion),
    capabilities: { canApprove: proof.canManage && prepared.canApprove,
      canReject: proof.canManage && ['pending', 'stale'].includes(prepared.request.status) },
    unavailableReason: prepared.unavailableReason };
}

export async function decideStaffInvitationRequest(env: Env, actor: StaffPrincipal, requestId: string, value: unknown, keyValue: string) {
  parse(opaque, requestId);
  const input = parse(decisionInput, value), key = invitationReviewIdempotency(keyValue);
  if (input.decision === 'approve' && input.reason) return invalid();
  await readable(env, actor);
  const proof = await captureInvitationReviewProof(env, actor, input.sourceId, true);
  let receipt = await savedReceipt(env, actor, proof, key, input.decision, input.workspaceId, requestId, input);
  if (receipt) {
    // A completed decision can be read after its publication window. This is
    // not permission to resume a staged invitation or renew the original terms.
    const completed = await readWorkspaceInvitationReviewReplay(database(env), { sourceId: input.sourceId,
      workspaceId: input.workspaceId, requestId, action: input.decision, authorizationId: receipt.id,
      actorStaffId: actor.id, idempotencyKey: key });
    if (completed?.request) {
      await assertInvitationReviewProof(env, proof);
      return { request: { ...completed.request, sourceName: proof.sourceName }, replayed: true };
    }
  }
  if(input.decision==='approve')requireProjectAccessAuthorityMutations(env);
  const prepared = await prepareWorkspaceInvitationDecision(env, { sourceId: input.sourceId, workspaceId: input.workspaceId,
    requestId, decision: input.decision });
  if (!receipt) {
    if (input.contextVersion !== await reviewContext(proof, prepared.contextVersion)
      || input.expectedVersion !== prepared.request.version) invitationReviewChanged();
    if (input.decision === 'approve' && !prepared.canApprove) invitationReviewChanged();
    receipt = await reserveInvitationReviewAuthorization(env, actor, proof, { action: input.decision, workspaceId: input.workspaceId,
      subjectId: requestId, idempotencyKey: key, operation: input, deliveryContext: prepared.contextVersion });
  }
  const shared = { sourceId: input.sourceId, workspaceId: input.workspaceId, requestId, expectedVersion: input.expectedVersion,
    expectedContextVersion: receipt.delivery_context, authorization: authorization(receipt), idempotencyKey: key };
  if (input.decision === 'reject') {
    await assertInvitationReviewPublication(env, proof, receipt);
    const result = await rejectWorkspaceInvitationRequest(database(env), { ...shared, reason: input.reason });
    await assertInvitationReviewProof(env, proof);
    return { ...result, request: { ...result.request, sourceName: proof.sourceName } };
  }
  try {
    await assertInvitationReviewPublication(env, proof, receipt);
    const staged = await stageApprovedWorkspaceInvitation(env, { ...shared, expectedPolicyVersion: prepared.request.policyVersion });
    await assertInvitationReviewPublication(env, proof, receipt);
    const request = await publishApprovedWorkspaceInvitation(env, { authorizationId: receipt.id });
    await assertInvitationReviewProof(env, proof);
    return { request: { ...request, sourceName: proof.sourceName }, replayed: staged.replayed };
  } catch (cause) {
    // Never treat an uncertain cross-database publication as successful. The
    // Delivery helper closes only this authorization's unpublished invitation;
    // another reviewer's operation is not affected.
    try {
      await abandonStagedWorkspaceInvitation(database(env), { authorizationId: receipt.id,actor:{type:'staff',id:receipt.actor_id} },
        env.PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED==='true');
    } catch {
      // Retain the original failure if cleanup is unavailable. An unpublished
      // stage remains unusable, including after the publication deadline.
      console.warn('invitation_review_cleanup_incomplete', { authorizationId: receipt.id });
    }
    throw cause;
  }
}
