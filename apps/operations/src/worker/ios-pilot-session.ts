import { HTTPException } from 'hono/http-exception';
import { requireNativeAdmissionAfterCutover } from './auth';
import { assertCurrentStaffLogin, resolveVerifiedStaffLogin, snapshotStaffLoginProof, type StaffLoginProof, type VerifiedStaffLoginClaims } from './staff-login-bindings';
import type { Env, StaffPrincipal } from './types';

export const IOS_PILOT_BASE = '/mobile-pilot/v1';
const now = () => Math.floor(Date.now() / 1000);
export const denied = (): never => { throw new HTTPException(401, { message: 'Sign in again to the read-only pilot' }); };
export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
type Admission = { mode: 'legacy' } | { mode: 'native'; profile: number; admission: number };
type Stored = { proof_json: string; admission_json: string; expires_at: number };
export type PilotSession = { proof: StaffLoginProof; admission: Admission; principal: StaffPrincipal; expiresAt: number };

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
