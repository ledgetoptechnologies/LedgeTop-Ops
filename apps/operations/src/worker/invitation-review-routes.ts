import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireMutationSecurity } from './request-security';
import {
  invitationReviewCapabilities, readStaffInvitationPolicy, changeStaffInvitationPolicy,
  listStaffInvitationRequests, readStaffInvitationRequest, decideStaffInvitationRequest,
} from './invitation-review';
import type { Env, StaffPrincipal } from './types';

type App = Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>;
function query(url: string, allowed: readonly string[], required: readonly string[] = []) {
  const parameters = new URL(url).searchParams, result: Record<string, string> = {};
  for (const [key, value] of parameters) {
    if (!allowed.includes(key) || parameters.getAll(key).length !== 1 || value.length > 4096)
      throw new HTTPException(400, { message: 'invitation_review_invalid_query' });
    result[key] = value;
  }
  for (const key of required) if (!result[key]) throw new HTTPException(400, { message: 'invitation_review_invalid_query' });
  return result;
}
async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
    throw new HTTPException(415, { message: 'invitation_review_json_required' });
  if (!request.body) throw new HTTPException(400, { message: 'invitation_review_invalid' });
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([(async () => {
      while (true) {
        const part = await reader.read(); if (part.done) return;
        size += part.value.byteLength;
        if (size > 8192) throw new HTTPException(413, { message: 'invitation_review_body_too_large' });
        if (part.value.byteLength) chunks.push(part.value);
      }
    })(), new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new HTTPException(408, { message: 'invitation_review_body_timeout' })), 5000);
    })]);
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
    catch { throw new HTTPException(400, { message: 'invitation_review_invalid' }); }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    let cancelTimeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([reader.cancel().catch(() => undefined), new Promise<void>(resolve => { cancelTimeout = setTimeout(resolve, 50); })]);
    if (cancelTimeout !== undefined) clearTimeout(cancelTimeout);
    reader.releaseLock();
  }
}

/** Mount after staff authentication. Every mutation also enforces origin/CSRF
 * here, and the domain coordinator rechecks current staff/source authority. */
export function registerInvitationReviewRoutes(app: App): void {
  const requests = '/api/client-portal/invitation-requests';
  const policy = '/api/client-portal/workspaces/:workspaceId/invitation-policy';
  app.get(`${requests}/capabilities`, async c => {
    query(c.req.url, []); c.header('Cache-Control', 'no-store');
    return c.json(await invitationReviewCapabilities(c.env, c.get('principal')));
  });
  app.get(requests, async c => {
    c.header('Cache-Control', 'no-store');
    return c.json(await listStaffInvitationRequests(c.env, c.get('principal'),
      query(c.req.url, ['sourceId', 'workspaceId', 'status', 'q', 'cursor', 'limit'])));
  });
  app.get(`${requests}/:requestId`, async c => {
    const values = query(c.req.url, ['sourceId', 'workspaceId'], ['sourceId', 'workspaceId']);
    c.header('Cache-Control', 'no-store');
    return c.json(await readStaffInvitationRequest(c.env, c.get('principal'), c.req.param('requestId'), values.sourceId!, values.workspaceId!));
  });
  app.post(`${requests}/:requestId/decision`, async c => {
    query(c.req.url, []); c.header('Cache-Control', 'no-store');
    await requireMutationSecurity(c.req.raw, c.env, c.get('principal'));
    return c.json(await decideStaffInvitationRequest(c.env, c.get('principal'), c.req.param('requestId'),
      await readBody(c.req.raw), c.req.header('Idempotency-Key') ?? ''));
  });
  app.get(policy, async c => {
    const values = query(c.req.url, ['sourceId'], ['sourceId']); c.header('Cache-Control', 'no-store');
    return c.json(await readStaffInvitationPolicy(c.env, c.get('principal'), c.req.param('workspaceId'), values.sourceId!));
  });
  app.patch(policy, async c => {
    query(c.req.url, []); c.header('Cache-Control', 'no-store');
    await requireMutationSecurity(c.req.raw, c.env, c.get('principal'));
    return c.json(await changeStaffInvitationPolicy(c.env, c.get('principal'), c.req.param('workspaceId'),
      await readBody(c.req.raw), c.req.header('Idempotency-Key') ?? ''));
  });
}
