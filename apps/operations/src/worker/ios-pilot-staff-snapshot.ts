import { prepareStaffLoginSnapshot, snapshotStaffLoginProof } from './staff-login-bindings';
import type { PilotSession } from './ios-pilot-session';
import type { Env } from './types';

/** Build staff and admission reads for a caller-owned D1 batch. Discovery only
 * selects a compatible SQL shape: the evaluator checks that schema shape again
 * inside the final batch, and never grants authority from the discovery read. */
export async function preparePilotStaffSnapshot(env: Env, transaction: D1DatabaseSession, session: PilotSession): Promise<{
  statements: D1PreparedStatement[];
  verify: (results: D1Result[], nowSeconds: number) => boolean;
} | null> {
  const proof = snapshotStaffLoginProof(session.proof);
  if (!proof || !env.TEAM_DOMAIN || proof.issuer !== env.TEAM_DOMAIN.replace(/\/$/, '')
    || !Number.isSafeInteger(session.expiresAt) || session.expiresAt > proof.expiresAt
    || session.principal.id !== proof.staffId || session.principal.email !== proof.canonicalEmail
    || session.principal.accessSubject !== proof.canonicalSubject) return null;
  // Freeze the candidate values before asynchronous discovery; the evaluator
  // must compare against the same session that supplied the SQL bindings.
  const expiresAt = session.expiresAt;
  const projectAlphaUserId = session.principal.projectAlphaUserId;
  const admission = { ...session.admission };
  const tokenHash = session.tokenHash;

  const staff = await prepareStaffLoginSnapshot(env.OPS_DB, transaction, proof);
  if (!staff) return null;
  const found = await env.OPS_DB.withSession('first-primary').prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='native_staff_access_reconciliation'"
  ).all<{ name: string }>();
  if (!found.success || found.results.length > 1) return null;
  const hasControl = found.results.length === 1;
  if (!hasControl && admission.mode !== 'legacy') return null;

  const statements = [...staff.statements];
  const inventoryIndex = statements.push(transaction.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='native_staff_access_reconciliation'"
  )) - 1;
  let controlIndex = -1, admissionIndex = -1, sessionIndex = -1;
  if (hasControl) {
    controlIndex = statements.push(transaction.prepare(
      'SELECT enabled FROM native_staff_access_reconciliation WHERE singleton=1'
    )) - 1;
    if (admission.mode === 'native') admissionIndex = statements.push(transaction.prepare(`
      SELECT p.version profile,a.version admission FROM native_staff_admissions a
      JOIN native_staff_profiles p ON p.staff_id=a.staff_id JOIN staff_users s ON s.id=a.staff_id
      WHERE a.staff_id=? AND a.active=1 AND a.bound_access_subject=?
       AND p.login_email=? COLLATE BINARY AND s.email=p.login_email COLLATE BINARY
       AND s.access_subject=a.bound_access_subject AND s.status='active'`)
      .bind(proof.staffId, proof.canonicalSubject, proof.canonicalEmail)) - 1;
  }
  if (tokenHash) sessionIndex = statements.push(transaction.prepare(
    'SELECT expires_at FROM ios_pilot_sessions WHERE token_hash=?'
  ).bind(tokenHash)) - 1;

  return { statements, verify: (results, nowSeconds) => {
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0 || expiresAt <= nowSeconds
      || results.length !== statements.length || results.some(r => !r.success || !Array.isArray(r.results))
      || !staff.verify(results.slice(0, staff.statements.length), projectAlphaUserId, nowSeconds)) return false;
    const inventory = results[inventoryIndex]!.results;
    if (inventory.length !== (hasControl ? 1 : 0)) return false;
    if (!hasControl) {
      if (admission.mode !== 'legacy') return false;
    } else {
      const controls = results[controlIndex]!.results;
      if (controls.length !== 1) return false;
      const enabled = (controls[0] as { enabled?: unknown }).enabled;
      if (admission.mode === 'legacy') {
        if (enabled !== 0) return false;
      } else {
        if (enabled !== 1 || admissionIndex < 0) return false;
        const rows = results[admissionIndex]!.results;
        if (rows.length !== 1) return false;
        const row = rows[0] as { profile?: unknown; admission?: unknown };
        if (!Number.isSafeInteger(row.profile) || !Number.isSafeInteger(row.admission)
          || row.profile !== admission.profile || row.admission !== admission.admission
          || (row.profile as number) < 1 || (row.admission as number) < 1) return false;
      }
    }
    if (sessionIndex >= 0) {
      const rows = results[sessionIndex]!.results;
      if (rows.length !== 1 || typeof (rows[0] as { expires_at?: unknown }).expires_at !== 'number'
        || ((rows[0] as { expires_at: number }).expires_at <= nowSeconds)) return false;
    }
    return true;
  } };
}
