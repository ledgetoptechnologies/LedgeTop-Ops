export interface ReconciliationEnvironment {
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

async function boundedFetch(input: string, init: RequestInit = {}, authorize?: () => Promise<void>): Promise<Response> {
  let lastError: unknown;
  for(let attempt=1;attempt<=CONTROL_PLANE_ATTEMPTS;attempt+=1){
    await authorize?.();
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
  authorize?: () => Promise<void>,
): Promise<{ endpoint: string; group: AccessGroup }> {
  const accountEndpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/access/groups`;
  const configuredEndpoint = `${accountEndpoint}/${encodeURIComponent(env.CF_ACCESS_GROUP_ID)}`;
  const configuredResponse = await boundedFetch(configuredEndpoint, { headers }, authorize);
  const configuredEnvelope = await responseEnvelope<AccessGroup>(configuredResponse);
  if (configuredResponse.ok && configuredEnvelope.success && configuredEnvelope.result) {
    const group = configuredEnvelope.result;
    // The configured identifier is an authority pin, not a lookup hint. Never
    // replace another group's full membership after a stale/misdirected read.
    if (group.id !== env.CF_ACCESS_GROUP_ID || typeof group.name !== "string" || !group.name
      || env.CF_ACCESS_GROUP_NAME !== undefined && (!env.CF_ACCESS_GROUP_NAME.trim()
        || group.name !== env.CF_ACCESS_GROUP_NAME)) throw new Error("access-group-identity-mismatch");
    return { endpoint: configuredEndpoint, group: configuredEnvelope.result };
  }

  throw cloudflareError("access-group-read", configuredResponse, configuredEnvelope);
}

export async function desiredAccessEmails(db: D1Database): Promise<string[]> {
  // Operations owns employee admission. PA users/entitlements are business
  // references and must never add or remove members of the Operations group.
  // Preserve the current local accounts during the independent-staff cutover;
  // activating native admissions is a separate reviewed migration.
  const result = await db.prepare(`
    SELECT lower(s.email) AS email FROM staff_users s
    WHERE s.status='active'
    ORDER BY email
  `).bind().all<{ email: string }>();
  if (result.success !== true || !Array.isArray(result.results)) throw new Error("access-group-members-read-failed");
  return result.results.map((row) => row.email).filter(Boolean);
}

export async function reconcileAccessGroup(env: ReconciliationEnvironment, authorize?: () => Promise<void>): Promise<string[]> {
  return applyManagedEmails(env, () => desiredAccessEmails(env.OPS_DB), authorize, false);
}

/** Native reconciliation supplies its own exact joined membership, independently
 * of PA projections and the historical compatibility helper above. */
export async function reconcileAccessGroupForEmails(env: ReconciliationEnvironment, desired: readonly string[],
  authorize: () => Promise<void>): Promise<string[]> {
  const emails = [...desired];
  if (emails.length === 0 || emails.length > 10_000 || emails.some(email => typeof email !== "string" || email.length > 254
    || email !== email.trim().toLowerCase() || /[\p{Cc}\p{Cf}]/u.test(email) || !/^[^\s@]+@[^\s@]+$/u.test(email))
    || new Set(emails).size !== emails.length) throw new Error("access-group-members-invalid");
  emails.sort();
  return applyManagedEmails(env, async () => emails, authorize, true);
}

function managedEmails(group: AccessGroup): string[] {
  if (!group || typeof group.name !== "string" || !group.name || typeof group.id !== "string"
    || group.exclude !== undefined && !Array.isArray(group.exclude)
    || group.require !== undefined && !Array.isArray(group.require)
    || group.include !== undefined && !Array.isArray(group.include)) throw new Error("access-group-shape-invalid");
  return (group.include ?? []).map(rule => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule) || Object.keys(rule).join() !== "email")
      throw new Error("access-group-unmanaged-include-rule");
    const value = (rule as {email?: unknown}).email;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join() !== "email"
      || typeof (value as {email?:unknown}).email !== "string") throw new Error("access-group-unmanaged-include-rule");
    return (value as {email:string}).email.trim().toLowerCase();
  }).sort();
}

async function applyManagedEmails(env: ReconciliationEnvironment, desired: () => Promise<string[]>,
  authorize: (() => Promise<void>) | undefined, verifyWrite: boolean): Promise<string[]> {
  if (![env.CF_ACCOUNT_ID, env.CF_ACCESS_GROUP_ID, env.CF_ACCESS_GROUP_API_TOKEN].every(configured)) throw new Error("access-group-configuration-invalid");
  const headers = { Authorization: `Bearer ${env.CF_ACCESS_GROUP_API_TOKEN}`, "Content-Type": "application/json", Accept: "application/json" };
  const { endpoint, group } = await loadAccessGroup(env, headers, authorize);
  const emails = await desired();
  const currentEmails = managedEmails(group);
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
  }, authorize);
  const updateEnvelope = await responseEnvelope<AccessGroup>(updateResponse);
  if (!updateResponse.ok || !updateEnvelope.success) throw cloudflareError("access-group-update", updateResponse, updateEnvelope);
  if (verifyWrite) {
    // Acknowledged writes still need a readback. No remote CAS or atomicity with
    // D1 is implied; a later cron also checks already-applied generations.
    const response = await boundedFetch(endpoint, { headers }, authorize);
    const envelope = await responseEnvelope<AccessGroup>(response);
    if (!response.ok || !envelope.success || !envelope.result) throw new Error("access-group-readback-failed");
    const observed = envelope.result;
    if (JSON.stringify(managedEmails(observed)) !== JSON.stringify(emails)
      || JSON.stringify(observed.exclude ?? []) !== JSON.stringify(group.exclude ?? [])
      || JSON.stringify(observed.require ?? []) !== JSON.stringify(group.require ?? [])
      || observed.id !== group.id || observed.name !== group.name
      || (observed.is_default ?? false) !== (group.is_default ?? false)) throw new Error("access-group-readback-mismatch");
  }
  return emails;
}
