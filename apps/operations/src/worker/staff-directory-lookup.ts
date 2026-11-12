// Pure lookups behind StaffDirectory (kept separate so they can be tested without the Workers runtime).
// They return ids only, and never derive a username from an email address.
const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const STAFF_ID = /^[A-Za-z0-9-]{1,80}$/;

export async function resolvePilotUsername(db: D1Database, username: unknown): Promise<{ staffId: string } | null> {
  const value = typeof username === "string" ? username.trim().toLowerCase() : "";
  if (!USERNAME.test(value)) return null;
  // The unique index allows at most one row; LIMIT 2 still refuses anything ambiguous.
  const rows = await db.prepare("SELECT id FROM staff_users WHERE username = ? AND status = 'active' LIMIT 2").bind(value).all<{ id: string }>();
  return rows.results.length === 1 ? { staffId: rows.results[0]!.id } : null;
}

export async function isActiveStaff(db: D1Database, staffId: unknown): Promise<boolean> {
  if (typeof staffId !== "string" || !STAFF_ID.test(staffId)) return false;
  const row = await db.prepare("SELECT status FROM staff_users WHERE id = ?").bind(staffId).first<{ status: string }>();
  return row?.status === "active";
}
