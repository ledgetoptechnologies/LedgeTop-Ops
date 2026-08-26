import { PRIMARY_PROJECT_ALPHA_SOURCE } from "../../operations/src/worker/project-alpha-source";

interface ReconciliationEnvironment {
  OPS_DB: D1Database;
  CF_ACCOUNT_ID: string;
  CF_ACCESS_GROUP_ID: string;
  CF_ACCESS_GROUP_NAME?: string;
  CF_ACCESS_GROUP_API_TOKEN: string;
}

interface CloudflareEnvelope<T> { success: boolean; result: T; errors?: Array<{ code?: number; message?: string }>; }
interface AccessGroup { id: string; name: string; include?: unknown[]; exclude?: unknown[]; require?: unknown[]; is_default?: boolean; }

const CONTROL_PLANE_TIMEOUT_MS = 8_000;
const CONTROL_PLANE_ATTEMPTS = 3;

function retryable(response: Response): boolean { return response.status === 429 || response.status >= 500; }
async function delay(milliseconds: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve,milliseconds)); }

async function boundedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let lastError: unknown;
  for(let attempt=1;attempt<=CONTROL_PLANE_ATTEMPTS;attempt+=1){
    try {
      const response=await fetch(input,{...init,signal:AbortSignal.timeout(CONTROL_PLANE_TIMEOUT_MS)});
      if(!retryable(response)||attempt===CONTROL_PLANE_ATTEMPTS)return response;
      lastError=new Error(`access-group-retryable-${response.status}`);
      await response.body?.cancel();
    } catch(error) {
      lastError=error;
      if(attempt===CONTROL_PLANE_ATTEMPTS)break;
    }
    await delay(50*2**(attempt-1));
  }
  throw new Error(`access-group-network:${lastError instanceof Error?lastError.message:"unknown"}`);
}

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
  const configuredResponse = await boundedFetch(configuredEndpoint, { headers });
  const configuredEnvelope = await responseEnvelope<AccessGroup>(configuredResponse);
  if (configuredResponse.ok && configuredEnvelope.success && configuredEnvelope.result) {
    return { endpoint: configuredEndpoint, group: configuredEnvelope.result };
  }

  // Cloudflare returns HTTP 400 when a stale or wrong resource identifier is
  // supplied. Resolve an exact deployment-configured name so an identifier
  // rotation does not permanently block Project Alpha provisioning.
  const groupName = String(env.CF_ACCESS_GROUP_NAME ?? "").trim();
  if (groupName !== "") {
    const listResponse = await boundedFetch(`${accountEndpoint}?per_page=50`, { headers });
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
    WHERE u.projection_source_id=? AND e.projection_source_id=?
      AND u.active=1 AND e.active=1 AND e.enabled=1 AND email IS NOT NULL
    UNION
    SELECT lower(s.email) AS email FROM staff_users s
    JOIN staff_role_assignments a ON a.staff_id=s.id
    WHERE s.status='active' AND s.sync_protected=1 AND a.role_id='role-owner' AND a.scope='global'
    ORDER BY email
  `).bind(PRIMARY_PROJECT_ALPHA_SOURCE.sourceId,PRIMARY_PROJECT_ALPHA_SOURCE.sourceId).all<{ email: string }>();
  return result.results.map((row) => row.email).filter(Boolean);
}

export async function reconcileAccessGroup(env: ReconciliationEnvironment): Promise<string[]> {
  if (![env.CF_ACCOUNT_ID, env.CF_ACCESS_GROUP_ID, env.CF_ACCESS_GROUP_API_TOKEN].every(configured)) throw new Error("access-group-configuration-invalid");
  const headers = { Authorization: `Bearer ${env.CF_ACCESS_GROUP_API_TOKEN}`, "Content-Type": "application/json", Accept: "application/json" };
  const { endpoint, group } = await loadAccessGroup(env, headers);
  const emails = await desiredAccessEmails(env.OPS_DB);
  const currentEmails=(group.include??[]).map((rule)=>{
    if(!rule||typeof rule!=="object"||!("email" in rule))throw new Error("access-group-unmanaged-include-rule");
    const email=(rule as {email?:{email?:unknown}}).email?.email;
    if(typeof email!=="string")throw new Error("access-group-unmanaged-include-rule");
    return email.trim().toLowerCase();
  }).sort();
  if(currentEmails.length===emails.length&&currentEmails.every((email,index)=>email===emails[index]))return emails;
  const updateResponse = await boundedFetch(endpoint, {
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
