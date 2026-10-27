import { reconcileAccessGroupForEmails, type ReconciliationEnvironment } from "./access-group";
import { staffLoginLinksAvailable } from "../../operations/src/worker/staff-login-bindings";

type Database = D1Database;
type Control = { enabled: number; generation: number; applied_generation: number };
export type NativeStaffAccessOutcome = Readonly<{ status: "disabled" | "busy" | "applied" | "pending"; members: number }>;

function validAccessIssuer(value: unknown): value is string {
  try {
    if (typeof value !== "string") return false;
    const url = new URL(value);
    return url.origin === value && url.protocol === "https:" && url.hostname.endsWith(".cloudflareaccess.com")
      && url.hostname !== ".cloudflareaccess.com" && !url.port && !url.username && !url.password
      && url.pathname === "/" && !url.search && !url.hash;
  } catch { return false; }
}

function validMemberEmail(email: unknown): email is string {
  return typeof email === "string" && email.length >= 3 && email.length <= 254
    && email === email.trim().toLowerCase() && !/[\p{Cc}\p{Cf}]/u.test(email) && /^[^\s@]+@[^\s@]+$/u.test(email);
}

/** Only an exact, already-bound native/compatibility identity enters this set.
 * Historical PA users, roles and email-only matches confer no membership. */
export async function desiredNativeStaffAccessEmails(db: Database, configuredIssuer?: string): Promise<string[]> {
  const result = await db.prepare(`SELECT p.login_email AS email FROM native_staff_profiles p
    JOIN native_staff_admissions a ON a.staff_id=p.staff_id AND a.active=1
    JOIN staff_users s ON s.id=a.staff_id AND s.status='active'
      AND s.email=p.login_email COLLATE BINARY AND s.access_subject=a.bound_access_subject
    ORDER BY p.login_email LIMIT 10001`).all<{email:string}>();
  const emails = result.results.map(row => row.email);
  if (!result.success || emails.length > 10_000 || new Set(emails).size !== emails.length
    || emails.some(email => !validMemberEmail(email)))
    throw new Error("native-access-members-invalid");

  // Keep migrations rolling-deploy safe: no 0226 tables means the historical
  // primary-login cohort remains unchanged. A partial/broken migration throws
  // through Operations' canonical schema preflight instead of guessing.
  if (await staffLoginLinksAvailable(db)) {
    if (!validAccessIssuer(configuredIssuer)) throw new Error("native-access-issuer-invalid");
    const aliases = await db.prepare(`SELECT b.login_email AS email FROM staff_login_bindings b
      JOIN staff_login_binding_intents i ON i.id=b.intent_id AND i.status='claimed' AND i.binding_id=b.id
        AND i.issuer=b.issuer AND i.alternate_email=b.login_email COLLATE BINARY
      JOIN staff_login_generations g ON g.staff_id=b.staff_id AND g.generation>i.generation
      JOIN staff_users s ON s.id=b.staff_id AND s.status='active'
        AND s.email=i.canonical_email COLLATE BINARY AND s.access_subject=i.canonical_subject
      JOIN native_staff_admissions a ON a.staff_id=s.id AND a.active=1 AND a.bound_access_subject=s.access_subject
      JOIN native_staff_profiles p ON p.staff_id=s.id AND p.login_email=s.email COLLATE BINARY
      WHERE b.issuer=? AND b.status='active'
      ORDER BY b.login_email LIMIT 10001`).bind(configuredIssuer).all<{email:string}>();
    const aliasEmails = aliases.results.map(row => row.email);
    if (!aliases.success || aliasEmails.length > 10_000 || aliasEmails.some(email => !validMemberEmail(email))
      || new Set(aliasEmails).size !== aliasEmails.length
      || aliasEmails.some(email => emails.includes(email))) throw new Error("native-access-members-invalid");
    emails.push(...aliasEmails);
    emails.sort();
  }
  return emails;
}

/** Source only until 0225's default-off cohort control is explicitly enabled.
 * D1 leases fence local outcomes, not remote Cloudflare processing. A timed-out
 * PUT may apply later; every cron re-reads and converges even applied generations.
 * Immediate offboarding denial therefore relies on local native + legacy status. */
export async function reconcileNativeStaffAccess(env: ReconciliationEnvironment & { TEAM_DOMAIN?: string }): Promise<NativeStaffAccessOutcome> {
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
    const emails = await desiredNativeStaffAccessEmails(env.OPS_DB, env.TEAM_DOMAIN);
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
