interface ReconciliationEnvironment {
  OPS_DB: D1Database;
  CF_ACCOUNT_ID: string;
  CF_ACCESS_GROUP_ID: string;
  CF_ACCESS_GROUP_NAME?: string;
  CF_ACCESS_GROUP_API_TOKEN: string;
}

interface CloudflareEnvelope<T> { success: boolean; result: T; errors?: Array<{ code?: number; message?: string }>; }
interface AccessGroup { id: string; name: string; include?: unknown[]; exclude?: unknown[]; require?: unknown[]; is_default?: boolean; }

function configured(value: string): boolean { return Boolean(value) && !value.startsWith("REPLACE_"); }

function cloudflareError(prefix: string, response: Response, envelope: CloudflareEnvelope<unknown>): Error {
  const detail = envelope.errors?.[0];
  const code = detail?.code ? `-${detail.code}` : "";
  const message = String(detail?.message ?? "")
    .replace(/[^a-zA-Z0-9 .:_-]+/g, " ")
    .trim()
    .slice(0, 160);
  return new Error(`${prefix}-${response.status}${code}${message ? `:${message}` : ""}`);
}

async function responseEnvelope<T>(response: Response): Promise<CloudflareEnvelope<T>> {
  try {
    return await response.json<CloudflareEnvelope<T>>();
  } catch {
    return { success: false, result: null as T, errors: [{ message: "invalid-json-response" }] };
  }
}

async function loadAccessGroup(
  env: ReconciliationEnvironment,
  headers: Record<string, string>,
): Promise<{ endpoint: string; group: AccessGroup }> {
  const accountEndpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/access/groups`;
  const configuredEndpoint = `${accountEndpoint}/${encodeURIComponent(env.CF_ACCESS_GROUP_ID)}`;
  const configuredResponse = await fetch(configuredEndpoint, { headers });
  const configuredEnvelope = await responseEnvelope<AccessGroup>(configuredResponse);
  if (configuredResponse.ok && configuredEnvelope.success && configuredEnvelope.result) {
    return { endpoint: configuredEndpoint, group: configuredEnvelope.result };
  }

  // Cloudflare returns HTTP 400 when a stale or wrong resource identifier is
  // supplied. Resolve an exact deployment-configured name so an identifier
  // rotation does not permanently block Project Alpha provisioning.
  const groupName = String(env.CF_ACCESS_GROUP_NAME ?? "").trim();
  if (groupName !== "") {
    const listResponse = await fetch(`${accountEndpoint}?per_page=50`, { headers });
    const listEnvelope = await responseEnvelope<AccessGroup[]>(listResponse);
    if (!listResponse.ok || !listEnvelope.success || !Array.isArray(listEnvelope.result)) {
      throw cloudflareError("access-group-list", listResponse, listEnvelope);
    }
    const group = listEnvelope.result.find((candidate) => candidate.name === groupName);
    if (group?.id) {
      return { endpoint: `${accountEndpoint}/${encodeURIComponent(group.id)}`, group };
    }
  }

  throw cloudflareError("access-group-read", configuredResponse, configuredEnvelope);
}

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
  const headers = { Authorization: `Bearer ${env.CF_ACCESS_GROUP_API_TOKEN}`, "Content-Type": "application/json", Accept: "application/json" };
  const { endpoint, group } = await loadAccessGroup(env, headers);
  const emails = await desiredAccessEmails(env.OPS_DB);
  const updateResponse = await fetch(endpoint, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      name: group.name,
      include: emails.map((email) => ({ email: { email } })),
      exclude: group.exclude ?? [],
      require: group.require ?? [],
      is_default: group.is_default ?? false,
    }),
  });
  const updateEnvelope = await responseEnvelope<AccessGroup>(updateResponse);
  if (!updateResponse.ok || !updateEnvelope.success) throw cloudflareError("access-group-update", updateResponse, updateEnvelope);
  return emails;
}
