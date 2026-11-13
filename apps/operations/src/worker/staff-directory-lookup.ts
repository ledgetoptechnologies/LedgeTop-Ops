// Pure lookups behind StaffDirectory (kept separate so they can be tested without the Workers runtime).
// They return ids only, and never derive a username from an email address. Usernames live in
// staff_usernames, so setting one never writes staff_users.
import { getPilotDeviceAuthority, resolveEligibleLogsUsername } from './logs-device-eligibility';
export { getPilotDeviceAuthority };
const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const STAFF_ID = /^[A-Za-z0-9-]{1,80}$/;

export async function resolvePilotUsername(db: D1Database, username: unknown): Promise<{ staffId: string; eligibilityRevision: number } | null> {
  const value = typeof username === "string" ? username.trim().toLowerCase() : "";
  if (!USERNAME.test(value)) return null;
  return resolveEligibleLogsUsername(db, value);
}

export async function isActiveStaff(db: D1Database, staffId: unknown): Promise<boolean> {
  if (typeof staffId !== "string" || !STAFF_ID.test(staffId)) return false;
  return (await getPilotDeviceAuthority(db, staffId)).eligible;
}

export async function usernameOf(db: D1Database, staffId: string): Promise<string | null> {
  const row = await db.prepare("SELECT username FROM staff_usernames WHERE staff_id = ?").bind(staffId).first<{ username: string }>();
  return row?.username ?? null;
}

/** Normalises an administrator-entered username; returns null for "clear", undefined when invalid. */
export function normalizeUsername(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const clean = value.trim().toLowerCase();
  if (clean === "") return null;
  return USERNAME.test(clean) ? clean : undefined;
}

export type SetUsernameResult = { ok: true; username: string | null; previous: string | null } | { ok: false; reason: "invalid" | "not_found" | "taken" };

/** Sets or clears one active staff member's controller username. Usernames are unique across all staff. */
export async function setStaffUsername(db: D1Database, staffId: unknown, value: unknown, setBy: string): Promise<SetUsernameResult> {
  const username = normalizeUsername(value);
  if (username === undefined || typeof staffId !== "string" || !STAFF_ID.test(staffId)) return { ok: false, reason: "invalid" };
  const staff = await db.prepare("SELECT id FROM staff_users WHERE id = ? AND status = 'active'").bind(staffId).first();
  if (!staff) return { ok: false, reason: "not_found" };
  const previous = await usernameOf(db, staffId);
  if (username === previous) return { ok: true, username, previous };
  if (username === null) {
    await db.prepare("DELETE FROM staff_usernames WHERE staff_id = ?").bind(staffId).run();
    return { ok: true, username, previous };
  }
  const other = await db.prepare("SELECT staff_id FROM staff_usernames WHERE username = ? AND staff_id <> ?").bind(username, staffId).first();
  if (other) return { ok: false, reason: "taken" };
  try {
    await db.prepare(`INSERT INTO staff_usernames (staff_id, username, set_by_staff_id) VALUES (?, ?, ?)
      ON CONFLICT(staff_id) DO UPDATE SET username = excluded.username, set_by_staff_id = excluded.set_by_staff_id,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).bind(staffId, username, setBy).run();
  } catch (error) { if (/UNIQUE/i.test(String(error))) return { ok: false, reason: "taken" }; throw error; }
  return { ok: true, username, previous };
}
