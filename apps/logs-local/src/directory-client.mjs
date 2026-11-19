// Logs -> Ops directory over HTTPS: exactly four read-only lookups, and nothing else. Three are the pilot
// lookups the Logs code needs (env.OPS_DIRECTORY); the fourth, staff-authority, is the explicit, versioned
// scope extension (Merger decision) for fresh authority checks on sensitive staff writes.
// It authenticates with its own Access service token for the Ops staging Access app (a different issuer,
// audience and client id from the inbound Logs identities).
//
// No caching here: the Logs device code keeps the only positive cache (at most 60 s, revision-bound);
// denials and errors are never cached. Any transport error, timeout, redirect (e.g. to an Access login),
// non-200 status, oversize or malformed reply throws, and the Logs code fails closed on a throw.
import { readBounded } from './access-jwt.mjs';

export const DIRECTORY_PREFIX = '/api/internal/logs-directory/v1/';
const MAX_REPLY = 64 * 1024;
const STAFF_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const validRevision = value => Number.isSafeInteger(value) && value > 0;

export class DirectoryError extends Error {
  constructor(code) { super(code); this.name = 'DirectoryError'; this.code = code; }
}

/**
 * @param {{ baseUrl: string, clientId: string, clientSecret: string }} config
 * @param {{ fetch?: typeof fetch, timeoutMs?: number }} [deps]
 */
export function createOpsDirectory(config, { fetch = globalThis.fetch, timeoutMs = 5000 } = {}) {
  let base;
  try { base = new URL(config?.baseUrl ?? ''); } catch { throw new Error('directory_base_url_invalid'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/')
    throw new Error('directory_base_url_invalid');
  // A blank machine credential is a configuration error, never "no authentication".
  if (typeof config.clientId !== 'string' || !/^[A-Za-z0-9._-]{8,256}$/.test(config.clientId)) throw new Error('directory_client_id_missing');
  if (typeof config.clientSecret !== 'string' || config.clientSecret.length < 16 || /\s/.test(config.clientSecret)) throw new Error('directory_client_secret_missing');
  const headers = Object.freeze({ 'CF-Access-Client-Id': config.clientId, 'CF-Access-Client-Secret': config.clientSecret,
    'Content-Type': 'application/json', Accept: 'application/json' });

  async function call(method, body) {
    let response;
    try {
      response = await fetch(new URL(`${DIRECTORY_PREFIX}${method}`, base), { method: 'POST', headers, body: JSON.stringify(body),
        redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch { throw new DirectoryError('directory_unreachable'); }
    if (response.status !== 200) { await response.body?.cancel().catch(() => {}); throw new DirectoryError('directory_refused'); }
    let text;
    try { text = await readBounded(response, MAX_REPLY); } catch { throw new DirectoryError('directory_reply_invalid'); }
    try { return JSON.parse(text); } catch { throw new DirectoryError('directory_reply_invalid'); }
  }

  return Object.freeze({
    /** A typed username -> { staffId, eligibilityRevision } for an active, device-eligible pilot, else null. */
    async resolvePilotUsername(username) {
      const reply = await call('resolve-pilot', { username: String(username) });
      if (reply?.pilot === null) return null;
      const pilot = reply?.pilot;
      if (!STAFF_ID.test(pilot?.staffId ?? '') || !validRevision(pilot.eligibilityRevision)) throw new DirectoryError('directory_reply_invalid');
      return { staffId: pilot.staffId, eligibilityRevision: pilot.eligibilityRevision };
    },
    /** Current device authority: { eligible: true, revision } or { eligible: false, revision: null }. */
    async getPilotDeviceAuthority(staffId) {
      const reply = await call('pilot-authority', { staffId: String(staffId) });
      if (reply?.eligible === true && validRevision(reply.revision)) return { eligible: true, revision: reply.revision };
      if (reply?.eligible === false) return { eligible: false, revision: null };
      throw new DirectoryError('directory_reply_invalid');
    },
    /**
     * Current authority for a sensitive write, always fresh (never cached, here or by callers):
     * { active, canViewAll, canImport, administrator }, from Ops' canonical status and ACL. Nothing else is
     * returned or accepted. Assign/reassign/conflict resolution requires active && administrator.
     */
    async getStaffAuthority(staffId) {
      const reply = await call('staff-authority', { staffId: String(staffId) });
      const fields = ['active', 'administrator', 'canImport', 'canViewAll'];
      if (!reply || typeof reply !== 'object' || Object.keys(reply).sort().join() !== fields.join() || !fields.every(f => typeof reply[f] === 'boolean'))
        throw new DirectoryError('directory_reply_invalid');
      return Object.freeze({ active: reply.active, canViewAll: reply.canViewAll, canImport: reply.canImport, administrator: reply.administrator });
    },
    /**
     * Compatibility contract used by the Logs device code. In Ops this is the device-eligibility alias of the
     * legacy lookup, not general "active staff": never use it to authorise staff writes (use getStaffAuthority).
     */
    async isActiveStaff(staffId) {
      const reply = await call('staff-active', { staffId: String(staffId) });
      if (typeof reply?.active !== 'boolean') throw new DirectoryError('directory_reply_invalid');
      return reply.active;
    },
  });
}
