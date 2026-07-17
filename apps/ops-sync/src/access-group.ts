interface ReconciliationEnvironment {
  OPS_DB: D1Database;
  CF_ACCOUNT_ID: string;
  CF_ACCESS_GROUP_ID: string;
  CF_ACCESS_GROUP_API_TOKEN: string;
}

interface CloudflareEnvelope<T> { success: boolean; result: T; errors?: Array<{ code?: number; message?: string }>; }
interface AccessGroup { name: string; include?: unknown[]; exclude?: unknown[]; require?: unknown[]; is_default?: boolean; }

function configured(value: string): boolean { return Boolean(value) && !value.startsWith("REPLACE_"); }

export async function desiredAccessEmails(db: D1Database): Promise<string[]> {
  const result = await db.prepare(`
    SELECT lower(email) AS email FROM pa_users u
    JOIN pa_application_entitlements e ON e.user_id=u.id
    WHERE u.active=1 AND e.active=1 AND e.enabled=1 AND email IS NOT NULL
    UNION
    SELECT lower(s.email) AS email FROM staff_users s
    JOIN staff_role_assignments a ON a.staff_id=s.id
    WHERE s.status='active' AND s.sync_protected=1 AND a.role_id='role-owner' AND a.scope='global'
    ORDER BY email
  `).all<{ email: string }>();
  return result.results.map((row) => row.email).filter(Boolean);
}

export async function reconcileAccessGroup(env: ReconciliationEnvironment): Promise<string[]> {
  if (![env.CF_ACCOUNT_ID, env.CF_ACCESS_GROUP_ID, env.CF_ACCESS_GROUP_API_TOKEN].every(configured)) throw new Error("access-group-configuration-invalid");
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/access/groups/${encodeURIComponent(env.CF_ACCESS_GROUP_ID)}`;
  const headers = { Authorization: `Bearer ${env.CF_ACCESS_GROUP_API_TOKEN}`, "Content-Type": "application/json", Accept: "application/json" };
  const groupResponse = await fetch(endpoint, { headers });
  const groupEnvelope = await groupResponse.json<CloudflareEnvelope<AccessGroup>>();
  if (!groupResponse.ok || !groupEnvelope.success) throw new Error(`access-group-read-${groupResponse.status}`);
  const emails = await desiredAccessEmails(env.OPS_DB);
  const updateResponse = await fetch(endpoint, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      name: groupEnvelope.result.name,
      include: emails.map((email) => ({ email: { email } })),
      exclude: groupEnvelope.result.exclude ?? [],
      require: groupEnvelope.result.require ?? [],
      is_default: groupEnvelope.result.is_default ?? false,
    }),
  });
  const updateEnvelope = await updateResponse.json<CloudflareEnvelope<AccessGroup>>();
  if (!updateResponse.ok || !updateEnvelope.success) throw new Error(`access-group-update-${updateResponse.status}`);
  return emails;
}
