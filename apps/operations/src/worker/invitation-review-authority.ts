import { HTTPException } from 'hono/http-exception';
import { projectAlphaReadVisibleSql } from './project-alpha-read-visibility';
import type { Env, StaffPrincipal } from './types';

export type InvitationReviewAction = 'approve' | 'reject' | 'policy';
export interface InvitationReviewProof {
  input: string;
  json: string;
  sourceId: string;
  sourceName: string;
  canManage: boolean;
}
export interface InvitationReviewAuthorization {
  id: string;
  actor_id: string;
  idempotency_key: string;
  action: InvitationReviewAction;
  source_id: string;
  workspace_id: string;
  subject_id: string;
  fingerprint: string;
  operation_json: string;
  ops_proof_json: string;
  delivery_context: string;
  publication_deadline: string;
}

export async function invitationReviewDigest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const globalPermission = (key: 'team.view' | 'team.manage') => `EXISTS(
  SELECT 1 FROM permissions_now WHERE permission_key='${key}' AND effect='allow' AND scope='global')
  AND NOT EXISTS(SELECT 1 FROM permissions_now WHERE permission_key='${key}' AND effect='deny' AND scope='global')`;
const administrator = `EXISTS(SELECT 1 FROM staff_role_assignments a,input
  WHERE a.staff_id=json_extract(v,'$.actor.id') AND a.role_id IN ('role-owner','role-admin') AND a.scope='global')`;
// Keep the administrator definition identical to acl.isAdministrator. Local
// grants can supply permissions, but cannot manufacture administrator status.
const staffCte = `WITH input AS(SELECT json(?) v), permissions_now AS(
  SELECT rp.permission_key,'allow' effect,a.scope,a.division_id FROM staff_role_assignments a
  JOIN role_permissions rp ON rp.role_id=a.role_id,input WHERE a.staff_id=json_extract(v,'$.actor.id')
    AND rp.permission_key IN ('team.view','team.manage')
  UNION ALL SELECT rp.permission_key,'allow',a.scope,a.division_id FROM local_staff_role_assignments a
  JOIN role_permissions rp ON rp.role_id=a.role_id,input WHERE a.staff_id=json_extract(v,'$.actor.id')
    AND rp.permission_key IN ('team.view','team.manage')
  UNION ALL SELECT permission_key,effect,scope,division_id FROM staff_permission_overrides,input
  WHERE staff_id=json_extract(v,'$.actor.id') AND permission_key IN ('team.view','team.manage')
), active_actor AS(SELECT actor.* FROM staff_users actor,input WHERE actor.id=json_extract(v,'$.actor.id')
  AND actor.email=json_extract(v,'$.actor.email') AND actor.access_subject IS json_extract(v,'$.actor.accessSubject')
  AND actor.project_alpha_user_id IS json_extract(v,'$.actor.projectAlphaUserId') AND actor.status='active')`;
const capabilitySql = `${staffCte} SELECT json_object('canRead',CASE WHEN ${globalPermission('team.view')} THEN 1 ELSE 0 END,
  'canManage',CASE WHEN (${globalPermission('team.view')}) AND (${globalPermission('team.manage')}) AND ${administrator}
    THEN 1 ELSE 0 END) proof FROM active_actor
  WHERE (SELECT count(*) FROM permissions_now)<=200`;
const proofSql = `${staffCte} SELECT json_object(
  'actorId',actor.id,'email',actor.email,'subject',actor.access_subject,'alphaUser',actor.project_alpha_user_id,
  'sourceId',json_extract(v,'$.sourceId'),'sourceName',COALESCE(connector.display_name,'Project Alpha'),
  'connectorState',connector.state,'connectorRevision',connector.active_revision,'connectorVersion',connector.version,
  'producerBindingId',connector.producer_binding_id,'readVisible',connector.read_visible,
  'primaryState',primary_connector.state,'primaryRevision',primary_connector.active_revision,'primaryVersion',primary_connector.version,
  'readRevision',directory.read_revision,
  'canManage',CASE WHEN (${globalPermission('team.manage')}) AND ${administrator}
    AND (connector.source_id IS NULL OR connector.state='active')
    AND (json_extract(v,'$.sourceId')='project-alpha:primary' OR primary_connector.state='active')
    THEN 1 ELSE 0 END,
  'permissions',(SELECT json_group_array(json_array(permission_key,effect,scope,division_id)) FROM (
    SELECT * FROM permissions_now ORDER BY permission_key,effect,scope,division_id LIMIT 201))) proof
FROM input JOIN active_actor actor JOIN pa_connector_directory_state directory ON directory.id='directory'
LEFT JOIN pa_connectors connector ON connector.source_id=json_extract(v,'$.sourceId')
LEFT JOIN pa_connectors primary_connector ON primary_connector.source_id='project-alpha:primary'
WHERE (${globalPermission('team.view')}) AND (SELECT count(*) FROM permissions_now)<=200
  AND ((json_extract(v,'$.sourceId')='project-alpha:primary' AND connector.source_id IS NULL)
    OR (connector.source_id IS NOT NULL AND ${projectAlphaReadVisibleSql('connector.source_id')}))
  AND (json_extract(v,'$.mutation')=0 OR (
    (${globalPermission('team.manage')}) AND ${administrator}
    AND (connector.source_id IS NULL OR connector.state='active')
    AND (json_extract(v,'$.sourceId')='project-alpha:primary' OR primary_connector.state='active')))`;

export async function invitationReviewAuthorityReady(env: Env): Promise<boolean> {
  if (env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED !== 'true') return false;
  return await env.OPS_DB.withSession('first-primary').prepare(`SELECT count(*) n FROM sqlite_master
    WHERE type='table' AND name IN ('invitation_review_authorizations','pa_connectors','pa_connector_directory_state')`)
    .first<number>('n') === 3;
}

export async function invitationReviewStaffCapabilities(env: Env, actor: StaffPrincipal) {
  if (!await invitationReviewAuthorityReady(env)) return { enabled: false, canReview: false, canManagePolicy: false };
  const raw = await env.OPS_DB.withSession('first-primary').prepare(capabilitySql)
    .bind(JSON.stringify({ actor })).first<string>('proof');
  const value = raw ? JSON.parse(raw) as { canRead: number; canManage: number } : null;
  return { enabled: value?.canRead === 1, canReview: value?.canManage === 1, canManagePolicy: value?.canManage === 1 };
}

export function invitationReviewChanged(): never {
  throw new HTTPException(409, { message: 'invitation_review_context_changed' });
}
export async function captureInvitationReviewProof(env: Env, actor: StaffPrincipal, sourceId: string, mutation: boolean): Promise<InvitationReviewProof> {
  if (!/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(sourceId))
    throw new HTTPException(400, { message: 'invitation_review_invalid_source' });
  if (!await invitationReviewAuthorityReady(env)) throw new HTTPException(503, { message: 'invitation_review_unavailable' });
  const input = JSON.stringify({ actor, sourceId, mutation: mutation ? 1 : 0 });
  const json = await env.OPS_DB.withSession('first-primary').prepare(proofSql).bind(input).first<string>('proof');
  if (!json || new TextEncoder().encode(json).byteLength > 32768)
    throw new HTTPException(403, { message: 'invitation_review_forbidden' });
  const value = JSON.parse(json) as { sourceName: string; canManage: number };
  return { input, json, sourceId, sourceName: value.sourceName, canManage: value.canManage === 1 };
}

export async function assertInvitationReviewProof(env: Env, proof: InvitationReviewProof): Promise<void> {
  const json = await env.OPS_DB.withSession('first-primary').prepare(proofSql).bind(proof.input).first<string>('proof');
  if (json !== proof.json) invitationReviewChanged();
}
export function invitationReviewIdempotency(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(value))
    throw new HTTPException(400, { message: 'invitation_review_invalid_idempotency' });
  return value;
}
export async function readInvitationReviewAuthorization(env: Env, actorId: string, key: string) {
  return env.OPS_DB.withSession('first-primary').prepare(`SELECT * FROM invitation_review_authorizations
    WHERE actor_id=? AND idempotency_key=?`).bind(actorId, key).first<InvitationReviewAuthorization>();
}
function proofInput(proof: InvitationReviewProof): { actor: StaffPrincipal; sourceId: string; mutation: number } {
  try {
    const value = JSON.parse(proof.input) as { actor?: StaffPrincipal; sourceId?: string; mutation?: number };
    if (value.actor && typeof value.actor.id === 'string' && value.sourceId === proof.sourceId
      && (value.mutation === 0 || value.mutation === 1))
      return { actor: value.actor, sourceId: value.sourceId, mutation: value.mutation };
  } catch { /* Invalid internal proof is never authority. */ }
  throw new HTTPException(403, { message: 'invitation_review_forbidden' });
}
export async function reserveInvitationReviewAuthorization(env: Env, actor: StaffPrincipal, proof: InvitationReviewProof,
  input: { action: InvitationReviewAction; workspaceId: string; subjectId: string; idempotencyKey: string;
    operation: unknown; deliveryContext: string }): Promise<InvitationReviewAuthorization> {
  const key = invitationReviewIdempotency(input.idempotencyKey);
  const captured = proofInput(proof);
  if (captured.actor.id !== actor.id || captured.actor.email !== actor.email
    || captured.actor.accessSubject !== actor.accessSubject || captured.actor.projectAlphaUserId !== actor.projectAlphaUserId
    || captured.mutation !== 1 || !proof.canManage)
    throw new HTTPException(403, { message: 'invitation_review_forbidden' });
  const operation = JSON.stringify(input.operation);
  const fingerprint = await invitationReviewDigest([input.action, proof.sourceId, input.workspaceId, input.subjectId, input.operation]);
  const existing = await readInvitationReviewAuthorization(env, actor.id, key);
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new HTTPException(409, { message: 'invitation_review_idempotency_conflict' });
    return existing;
  }
  const id = crypto.randomUUID(), deadline = new Date(Date.now() + 5 * 60_000).toISOString();
  const db = env.OPS_DB.withSession('first-primary');
  // The proof is checked again in the receipt INSERT itself. A role removal or
  // new deny after the review cannot pass merely because an earlier read did.
  try {
    await db.batch([db.prepare(`INSERT INTO invitation_review_authorizations
      (id,actor_id,idempotency_key,action,source_id,workspace_id,subject_id,fingerprint,operation_json,
        ops_proof_json,delivery_context,publication_deadline,write_guard)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN (${proofSql})=? THEN 1 ELSE 0 END)`)
      .bind(id, actor.id, key, input.action, proof.sourceId, input.workspaceId, input.subjectId, fingerprint, operation,
        proof.json, input.deliveryContext, deadline, proof.input, proof.json)]);
  } catch (cause) {
    const winner = await readInvitationReviewAuthorization(env, actor.id, key);
    if (winner?.fingerprint === fingerprint) return winner;
    if (cause instanceof Error && /invitation_review_authorization_guard|invitation-review-authorization-immutable/.test(cause.message))
      invitationReviewChanged();
    throw cause;
  }
  return (await readInvitationReviewAuthorization(env, actor.id, key))!;
}

export async function assertInvitationReviewPublication(env: Env, proof: InvitationReviewProof, receipt: InvitationReviewAuthorization) {
  const captured = proofInput(proof);
  if (captured.actor.id !== receipt.actor_id || captured.sourceId !== receipt.source_id || captured.mutation !== 1
    || receipt.ops_proof_json !== proof.json || !(Date.parse(receipt.publication_deadline) > Date.now())) invitationReviewChanged();
  await assertInvitationReviewProof(env, proof);
}
