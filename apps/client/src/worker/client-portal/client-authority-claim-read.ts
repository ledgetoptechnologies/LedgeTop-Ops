/**
 * A claimed workspace must not fall back to its historical PA-derived access.
 * This is a deny-only compatibility fence until Operations grants are installed
 * and checked by a separate, versioned reader. No claim is inferred from PA
 * identity, email, or an absent pre-0216 table.
 */
export async function activeClientAuthorityWorkspaceClaim(
  database: D1Database,
  workspaceId: string,
): Promise<boolean> {
  // The live D1 binding uses a primary session. A few legacy test doubles
  // implement only prepare(); keep their pre-0216 behavior testable.
  const current = typeof database.withSession === "function" ? database.withSession("first-primary") : database;
  const present = await current.prepare(`SELECT 1 present FROM sqlite_master
    WHERE type='table' AND name='portal_client_authority_workspace_claims'`).first<number>("present");
  if (present !== 1) return false;
  return (await current.prepare(`
    SELECT 1 active FROM portal_client_authority_workspace_claims
    WHERE workspace_id=? AND state='active' LIMIT 1
  `).bind(workspaceId).first<number>("active")) === 1;
}
