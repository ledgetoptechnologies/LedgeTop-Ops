// Who may call the private Logs backend, and for what. Every request must carry a verified Access service
// assertion (access-jwt.mjs) from one of the configured client ids, and each client id has exactly one role:
//
//   staff-proxy   Ops server acting for a signed-in staff member: /internal/v1/logs/* only, and it MUST send the
//                 staff actor (X-Ledge-Top-Actor) that Ops authorised in the staff session.
//   device-proxy  the edge Worker forwarding controller traffic: /api/v1/device/* only, and it MUST NOT send a
//                 staff actor; controllers authenticate themselves with their own device tokens.
//
// Anything else gets the same 404 as an unknown route: no detail about which check failed. A blank or missing
// machine configuration refuses to start; it never turns authentication off.
import { verifyAccessService, accessKeyResolver, canonicalIssuer } from './access-jwt.mjs';

export const ROLES = Object.freeze({
  'staff-proxy': Object.freeze({ prefix: '/internal/v1/logs/', actor: 'required' }),
  'device-proxy': Object.freeze({ prefix: '/api/v1/device/', actor: 'forbidden' }),
});
export const ACTOR_HEADER = 'X-Ledge-Top-Actor';
const STAFF_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PERMISSION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const CLIENT_ID = /^[A-Za-z0-9._-]{1,256}$/;

const denied = Object.freeze({ ok: false, status: 404 });

/** Parses the Ops-asserted staff actor: base64url JSON { staffId, permissions[] }. */
export function parseActor(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let actor;
  try { actor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { return null; }
  if (!actor || typeof actor !== 'object' || Array.isArray(actor) || Object.keys(actor).sort().join() !== 'permissions,staffId') return null;
  const { staffId, permissions } = actor;
  if (!STAFF_ID.test(staffId ?? '') || !Array.isArray(permissions) || permissions.length > 64) return null;
  if (!permissions.every(p => typeof p === 'string' && PERMISSION.test(p)) || new Set(permissions).size !== permissions.length) return null;
  return Object.freeze({ staffId, permissions: Object.freeze([...permissions]) });
}

export function encodeActor(actor) {
  return Buffer.from(JSON.stringify({ staffId: actor.staffId, permissions: actor.permissions })).toString('base64url');
}

/**
 * @param {{ issuer: string, audience: string, identities: Record<string, keyof ROLES> }} config
 * @param {{ getKey?: Function, now?: () => number, fetch?: typeof fetch }} [deps]
 */
export function createMachineAuth(config, deps = {}) {
  const issuer = canonicalIssuer(config?.issuer);
  const audience = config?.audience;
  const identities = new Map(Object.entries(config?.identities ?? {}));
  if (!identities.size) throw new Error('machine_identities_missing');
  for (const [clientId, role] of identities) {
    if (!CLIENT_ID.test(clientId)) throw new Error('machine_client_id_invalid');
    if (!Object.hasOwn(ROLES, role)) throw new Error('machine_role_invalid');
  }
  const getKey = deps.getKey ?? accessKeyResolver(issuer, { fetch: deps.fetch, now: deps.now });
  return async function authorize(request) {
    let verified;
    try { verified = await verifyAccessService(request, { issuer, audience }, getKey, { now: deps.now }); }
    catch { return denied; }
    const role = identities.get(verified.clientId);
    if (!role) return denied;
    const rule = ROLES[role];
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith(rule.prefix) || pathname.includes('/../') || pathname.includes('//')) return denied;
    const header = request.headers.get(ACTOR_HEADER);
    if (rule.actor === 'forbidden') {
      if (header !== null) return denied;
      return Object.freeze({ ok: true, role, clientId: verified.clientId, actor: null });
    }
    const actor = parseActor(header);
    if (!actor) return denied;
    return Object.freeze({ ok: true, role, clientId: verified.clientId, actor });
  };
}

/** Whether an Ops-asserted actor holds `permission`. Callers still recheck live authority for sensitive writes. */
export function actorHas(actor, permission) { return Boolean(actor?.permissions.includes(permission)); }
