import { HTTPException } from 'hono/http-exception';
import { requireNativeAdmissionAfterCutover, verifyStaffLoginClaims } from './auth';
import { assertCurrentStaffLogin, resolveVerifiedStaffLogin, snapshotStaffLoginProof, type StaffLoginProof, type VerifiedStaffLoginClaims } from './staff-login-bindings';
import type { Env, StaffPrincipal } from './types';

export const IOS_PILOT_CALLBACK = 'com.ledgetoptechnologies.ops.pilot://auth/callback';
export const IOS_PILOT_AUTHORIZE = '/api/mobile-pilot/authorize';
export const IOS_PILOT_BASE = '/mobile-pilot/v1';
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
export const statePattern = /^[A-Za-z0-9_-]{32,128}$/;
export const verifierPattern = /^[A-Za-z0-9._~-]{43,128}$/;
const now = () => Math.floor(Date.now() / 1000);
export const denied = (): never => { throw new HTTPException(401, { message: 'Sign in again to the read-only pilot' }); };
export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(v => v.toString(16).padStart(2, '0')).join('');
}
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}
const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
type Admission = { mode: 'legacy' } | { mode: 'native'; profile: number; admission: number };
type Stored = { proof_json: string; admission_json: string; expires_at: number };
export type PilotSession = { proof: StaffLoginProof; admission: Admission; principal: StaffPrincipal; expiresAt: number; tokenHash?: string };

/** The existing web cutover policy remains authoritative. Pin native versions
 * once enabled so disabling/re-enabling admission cannot revive an old session. */
async function admissionSnapshot(env: Env, proof: StaffLoginProof): Promise<Admission> {
  const db = env.OPS_DB.withSession('first-primary');
  await requireNativeAdmissionAfterCutover(db, proof.staffId, proof.canonicalEmail, proof.canonicalSubject);
  let control: { enabled: number } | null;
  try { control = await db.prepare('SELECT enabled FROM native_staff_access_reconciliation WHERE singleton=1').first<{ enabled: number }>(); }
  catch (error) {
    if (error instanceof Error && error.message.includes('no such table: native_staff_access_reconciliation')) return { mode: 'legacy' };
    throw error;
  }
  if (control?.enabled === 0) return { mode: 'legacy' };
  if (control?.enabled !== 1) return denied();
  const row = await db.prepare(`SELECT p.version profile,a.version admission FROM native_staff_profiles p
    JOIN native_staff_admissions a ON a.staff_id=p.staff_id WHERE p.staff_id=? AND a.active=1
    AND p.login_email=? COLLATE BINARY AND a.bound_access_subject=?`)
    .bind(proof.staffId, proof.canonicalEmail, proof.canonicalSubject).first<{ profile: number; admission: number }>();
  if (!row || !Number.isSafeInteger(row.profile) || row.profile < 1 || !Number.isSafeInteger(row.admission) || row.admission < 1) return denied();
  return { mode: 'native', profile: row.profile, admission: row.admission };
}
async function currentPrincipal(env: Env, proof: StaffLoginProof): Promise<StaffPrincipal> {
  if (!await assertCurrentStaffLogin(env.OPS_DB, proof)) return denied();
  const row = await env.OPS_DB.withSession('first-primary').prepare(`SELECT display_name,project_alpha_user_id FROM staff_users
    WHERE id=? AND email=? COLLATE BINARY AND access_subject=? AND status='active'`)
    .bind(proof.staffId, proof.canonicalEmail, proof.canonicalSubject)
    .first<{ display_name: string; project_alpha_user_id: string | null }>();
  if (!row) return denied();
  return { id: proof.staffId, email: proof.canonicalEmail, displayName: row.display_name, accessSubject: proof.canonicalSubject,
    projectAlphaUserId: row.project_alpha_user_id, accessExpiresAt: proof.expiresAt, verifiedLogin: proof };
}
async function restore(env: Env, row: Stored): Promise<PilotSession> {
  if (!Number.isSafeInteger(row.expires_at) || row.expires_at <= now()) return denied();
  const proof = snapshotStaffLoginProof(JSON.parse(row.proof_json));
  if (!proof || proof.issuer !== env.TEAM_DOMAIN.replace(/\/$/, '') || row.expires_at > proof.expiresAt) return denied();
  const principal = await currentPrincipal(env, proof);
  const admission = await admissionSnapshot(env, proof);
  if (JSON.stringify(admission) !== row.admission_json || row.expires_at <= now()) return denied();
  return { proof, admission, principal, expiresAt: row.expires_at };
}
export async function recheckPilotSession(env: Env, session: PilotSession): Promise<void> {
  const current = await restore(env, { proof_json: JSON.stringify(session.proof), admission_json: JSON.stringify(session.admission), expires_at: session.expiresAt });
  if (current.principal.projectAlphaUserId !== session.principal.projectAlphaUserId) return denied();
  if (session.tokenHash && !await env.OPS_DB.withSession('first-primary').prepare('SELECT 1 ok FROM ios_pilot_sessions WHERE token_hash=? AND expires_at>?')
    .bind(session.tokenHash, now()).first('ok')) return denied();
}

/** Resolve a freshly verified Access identity without issuing a local token or
 * modifying staff records. Rechecks use the same proof and admission snapshot
 * as the existing pilot; the originating Access assertion bounds its lifetime. */
export async function pilotSessionFromAccessClaims(env: Env, claims: VerifiedStaffLoginClaims): Promise<PilotSession> {
  const resolved = await resolveVerifiedStaffLogin(env.OPS_DB, claims);
  if (!resolved) return denied();
  const principal = await currentPrincipal(env, resolved.proof);
  const admission = await admissionSnapshot(env, resolved.proof);
  const session = { proof: resolved.proof, admission, principal, expiresAt: claims.expiresAt };
  await recheckPilotSession(env, session);
  return session;
}
export async function issuePilotCode(request: Request, env: Env, origin: string): Promise<string> {
  const query = new URL(request.url).searchParams;
  const allowed = ['redirect_uri', 'state', 'code_challenge', 'code_challenge_method'];
  if ([...query.keys()].length !== allowed.length || allowed.some(key => query.getAll(key).length !== 1)
    || [...query.keys()].some(key => !allowed.includes(key)) || query.get('redirect_uri') !== IOS_PILOT_CALLBACK
    || query.get('code_challenge_method') !== 'S256' || !tokenPattern.test(query.get('code_challenge') ?? '')
    || !statePattern.test(query.get('state') ?? '')) throw new HTTPException(400, { message: 'Invalid sign-in request' });
  const claims = await verifyStaffLoginClaims(request, env);
  const resolved = await resolveVerifiedStaffLogin(env.OPS_DB, claims);
  if (!resolved) return denied();
  const principal = await currentPrincipal(env, resolved.proof);
  const admission = await admissionSnapshot(env, resolved.proof);
  const timestamp = now(), expiresAt = Math.min(timestamp + 900, claims.expiresAt);
  if (expiresAt <= timestamp) return denied();
  const code = randomToken(), db = env.OPS_DB.withSession('first-primary');
  await db.batch([
    db.prepare('DELETE FROM ios_pilot_codes WHERE expires_at<?').bind(timestamp - 3600),
    db.prepare('DELETE FROM ios_pilot_sessions WHERE expires_at<?').bind(timestamp - 3600),
  ]);
  // Bound issuance by identity without logging or retaining the Access JWT.
  const inserted = await db.prepare(`INSERT INTO ios_pilot_codes(code_hash,challenge,state_hash,origin,access_audience,staff_id,proof_json,admission_json,created_at,expires_at,session_expires_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM ios_pilot_codes WHERE staff_id=? AND created_at>?)<10`)
    .bind(await sha256(code), query.get('code_challenge'), await sha256(query.get('state')!), origin, env.OPERATIONS_AUD, principal.id,
      JSON.stringify(resolved.proof), JSON.stringify(admission), timestamp, Math.min(timestamp + 120, expiresAt), expiresAt, principal.id, timestamp - 60).run();
  if (inserted.meta.changes !== 1) throw new HTTPException(429, { message: 'Too many sign-in attempts' });
  await recheckPilotSession(env, { proof: resolved.proof, admission, principal, expiresAt });
  const callback = new URL(IOS_PILOT_CALLBACK);
  callback.searchParams.set('code', code); callback.searchParams.set('state', query.get('state')!);
  return callback.href;
}
export async function redeemPilotCode(env: Env, origin: string, value: { code: string; codeVerifier: string; state: string; redirectUri: string }) {
  if (!tokenPattern.test(value.code) || !verifierPattern.test(value.codeVerifier) || !statePattern.test(value.state)
    || value.redirectUri !== IOS_PILOT_CALLBACK) throw new HTTPException(400, { message: 'Invalid sign-in exchange' });
  const timestamp = now(), db = env.OPS_DB.withSession('first-primary');
  // UPDATE ... RETURNING is one atomic consume. A failed/replayed proof never
  // mints a session; a transient failure may require a new explicit sign-in.
  const row = await db.prepare(`UPDATE ios_pilot_codes SET consumed_at=? WHERE code_hash=? AND challenge=?
    AND state_hash=? AND origin=? AND access_audience=? AND consumed_at IS NULL AND expires_at>?
    RETURNING proof_json,admission_json,session_expires_at AS expires_at`)
    .bind(timestamp, await sha256(value.code), await pkceChallenge(value.codeVerifier), await sha256(value.state), origin, env.OPERATIONS_AUD, timestamp).first<Stored>();
  if (!row) return denied();
  const session = await restore(env, row), accessToken = randomToken();
  await db.prepare('INSERT INTO ios_pilot_sessions(token_hash,origin,access_audience,proof_json,admission_json,expires_at) VALUES(?,?,?,?,?,?)')
    .bind(await sha256(accessToken), origin, env.OPERATIONS_AUD, row.proof_json, row.admission_json, row.expires_at).run();
  await recheckPilotSession(env, session);
  return { accessToken, tokenType: 'Bearer' as const, expiresAt: session.expiresAt };
}
export async function authenticatePilotSession(request: Request, env: Env, origin: string): Promise<PilotSession> {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') ?? '');
  if (!match) return denied();
  const row = await env.OPS_DB.withSession('first-primary').prepare(`SELECT proof_json,admission_json,expires_at FROM ios_pilot_sessions
    WHERE token_hash=? AND origin=? AND access_audience=? AND expires_at>?`).bind(await sha256(match[1]!), origin, env.OPERATIONS_AUD, now()).first<Stored>();
  if (!row) return denied();
  return { ...await restore(env, row), tokenHash: await sha256(match[1]!) };
}
