import { reconcileAccessGroupForEmails, type ReconciliationEnvironment } from "./access-group";

type Database = Pick<D1DatabaseSession, "prepare">;
type Control = { enabled: number; generation: number; applied_generation: number };
export type NativeStaffAccessOutcome = Readonly<{ status: "disabled" | "busy" | "applied" | "pending"; members: number }>;

/** Only an exact, already-bound native/compatibility identity enters this set.
 * Historical PA users, roles and email-only matches confer no membership. */
export async function desiredNativeStaffAccessEmails(db: Database): Promise<string[]> {
  const result = await db.prepare(`SELECT p.login_email AS email FROM native_staff_profiles p
    JOIN native_staff_admissions a ON a.staff_id=p.staff_id AND a.active=1
    JOIN staff_users s ON s.id=a.staff_id AND s.status='active'
      AND s.email=p.login_email COLLATE BINARY AND s.access_subject=a.bound_access_subject
    ORDER BY p.login_email LIMIT 10001`).all<{email:string}>();
  const emails = result.results.map(row => row.email);
  if (!result.success || emails.length > 10_000 || new Set(emails).size !== emails.length
    || emails.some(email => typeof email !== "string" || email.length < 3 || email.length > 254
      || email !== email.trim().toLowerCase() || /[\p{Cc}\p{Cf}]/u.test(email) || !/^[^\s@]+@[^\s@]+$/u.test(email)))
    throw new Error("native-access-members-invalid");
  return emails;
}

/** Source only until 0225's default-off cohort control is explicitly enabled.
 * D1 leases fence local outcomes, not remote Cloudflare processing. A timed-out
 * PUT may apply later; every cron re-reads and converges even applied generations.
 * Immediate offboarding denial therefore relies on local native + legacy status. */
export async function reconcileNativeStaffAccess(env: ReconciliationEnvironment): Promise<NativeStaffAccessOutcome> {
  const db = env.OPS_DB.withSession("first-primary");
  let state: Control | null;
  try {
    state = await db.prepare(`SELECT enabled,generation,applied_generation
      FROM native_staff_access_reconciliation WHERE singleton=1`).first<Control>();
  } catch (error) {
    // Rolling deployment before the additive migration has no new authority.
    if (error instanceof Error && error.message.includes("no such table: native_staff_access_reconciliation"))
      return { status: "disabled", members: 0 };
    throw error;
  }
  if (!state || state.enabled === 0) return { status: "disabled", members: 0 };
  if (state.enabled !== 1 || !Number.isSafeInteger(state.generation) || state.generation < 0
    || !Number.isSafeInteger(state.applied_generation) || state.applied_generation < 0
    || state.applied_generation > state.generation) throw new Error("native-access-control-invalid");
  const generation = state.generation, lease = crypto.randomUUID();
  const claimed = await db.prepare(`UPDATE native_staff_access_reconciliation SET lease_id=?,
      lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+120 seconds'),attempt_generation=generation,
      attempts=MIN(attempts+1,1000000),last_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE singleton=1 AND enabled=1 AND generation=?
      AND (lease_id IS NULL OR julianday(lease_until)<=julianday('now'))`).bind(lease, generation).run();
  if (claimed.meta.changes !== 1) return { status: "busy", members: 0 };
  const current = async () => {
    const valid = await db.prepare(`SELECT 1 valid FROM native_staff_access_reconciliation
      WHERE singleton=1 AND enabled=1 AND generation=? AND attempt_generation=? AND lease_id=?
        AND julianday(lease_until)>julianday('now')`).bind(generation, generation, lease).first("valid");
    if (valid !== 1) throw new Error("native-access-generation-changed");
  };
  try {
    const emails = await desiredNativeStaffAccessEmails(db);
    // A ready cohort retains an admitted control-plane member. Do not assume
    // provider include:[] means deny-all, invent an address, or rewrite excludes.
    if (emails.length === 0) throw new Error("native-access-empty-cohort");
    await current();
    await reconcileAccessGroupForEmails(env, emails, current);
    await current();
    const completed = await db.prepare(`UPDATE native_staff_access_reconciliation
      SET applied_generation=?,last_success_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_error=NULL,
        lease_id=NULL,lease_until=NULL,attempt_generation=NULL
      WHERE singleton=1 AND enabled=1 AND generation=? AND attempt_generation=? AND lease_id=?
        AND julianday(lease_until)>julianday('now')`).bind(generation, generation, generation, lease).run();
    if (completed.meta.changes !== 1) throw new Error("native-access-generation-changed");
    return { status: "applied", members: emails.length };
  } catch (error) {
    // Includes unknown remote acknowledgement: never mark a newer generation
    // applied, never undo local offboarding, and never persist provider details.
    const code = error instanceof Error && error.message === "native-access-empty-cohort" ? "native-cohort-empty" : "reconciliation-pending";
    await db.prepare(`UPDATE native_staff_access_reconciliation SET last_error=?,
      lease_id=NULL,lease_until=NULL,attempt_generation=NULL WHERE singleton=1 AND lease_id=?`).bind(code, lease).run();
    return { status: "pending", members: 0 };
  }
}
