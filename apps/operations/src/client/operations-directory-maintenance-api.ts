const BASE = "/api/native-client-portal/directory-maintenance-authority";
const CSRF = /^\d{1,12}\.[0-9a-f]{64}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/|-]{0,190}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_RESPONSE_BYTES = 1_048_576;

export type DirectoryMaintenanceReview = Readonly<{
  /** Opaque private server artifact. Never display or interpret its staff rows. */
  plan: unknown;
  commandId: string;
  snapshotRows: number;
  planSha256: string;
  independentBindingVerificationSha256: string;
}>;
export type DirectoryMaintenanceAttempt = Readonly<{
  approvalId: string; commandId: string; planSha256: string;
}>;
export type DirectoryMaintenanceResult = Readonly<{
  status: "applied" | "replayed";
  commandId: string; approvalId: string; grantId: string; resultingGeneration: number;
}>;
export class DirectoryMaintenanceApiError extends Error {
  constructor(readonly status: number, readonly uncertain: boolean) {
    super(uncertain ? "uncertain" : "denied");
  }
}
function fail(status = 503, uncertain = true): never { throw new DirectoryMaintenanceApiError(status, uncertain); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
    ? value as Record<string, unknown> : null;
}
function inspectPlan(value: unknown): Readonly<{ commandId: string; snapshotRows: number }> {
  const row = record(value, ["protocol", "version", "target", "staffId", "grantId", "commandId", "operator", "approvalIssuer", "identityEvidence", "snapshot"]);
  const target = row && record(row.target, ["environment", "accountLabel", "workerLabel", "databaseLabel"]);
  const snapshot = row && record(row.snapshot, ["staff", "admission", "profile", "roles", "grants", "history", "generation"]);
  if (!row || row.protocol !== "native-directory-maintenance-authority" || row.version !== 1
    || row.staffId !== "staff-beau-koltz" || typeof row.grantId !== "string" || !ID.test(row.grantId)
    || typeof row.commandId !== "string" || !UUID.test(row.commandId)
    || !target || target.environment !== "staging" || target.workerLabel !== "ledgetop-ops-staging"
    || !snapshot) return fail();
  let snapshotRows = 0;
  for (const rows of Object.values(snapshot)) {
    if (!Array.isArray(rows)) return fail();
    snapshotRows += rows.length;
  }
  return { commandId: row.commandId, snapshotRows };
}
async function request(path: string, init: RequestInit = {}): Promise<{ response: Response; value: unknown }> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { ...init, credentials: "same-origin", mode: "same-origin",
      redirect: "error", cache: "no-store", headers: { "X-Native-Staff-Request": "1", ...init.headers } });
  } catch { return fail(); }
  if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get("Content-Type") ?? ""))
    return fail(response.status, response.ok || response.status >= 500);
  const reader = response.body?.getReader();
  if (!reader) return fail(response.status, response.ok || response.status >= 500);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); return fail(response.status); }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { response, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
  } catch { return fail(response.status); }
  finally { reader.releaseLock(); }
}
function postHeaders(csrfToken: string) {
  if (!CSRF.test(csrfToken)) return fail(400, false);
  return { "Content-Type": "application/json", "X-CSRF-Token": csrfToken };
}
export async function readDirectoryMaintenanceSession(): Promise<Readonly<{ csrfToken: string; staffId: string; verifiedUntil: string }>> {
  const { response, value } = await request("/session");
  if (!response.ok) return fail(response.status, response.status >= 500);
  const row = record(value, ["csrfToken", "staffId", "verifiedUntil"]);
  if (!row || typeof row.csrfToken !== "string" || !CSRF.test(row.csrfToken) || row.staffId !== "staff-beau-koltz"
    || typeof row.verifiedUntil !== "string" || !Number.isFinite(Date.parse(row.verifiedUntil))) return fail();
  return { csrfToken: row.csrfToken, staffId: row.staffId, verifiedUntil: row.verifiedUntil };
}
export async function reviewDirectoryMaintenance(csrfToken: string): Promise<DirectoryMaintenanceReview> {
  const { response, value } = await request("/review", { method: "POST", headers: postHeaders(csrfToken), body: "{}" });
  if (!response.ok) return fail(response.status, response.status >= 500);
  const row = record(value, ["plan", "planSha256", "independentBindingVerificationSha256"]);
  if (!row || typeof row.planSha256 !== "string" || !HASH.test(row.planSha256)
    || typeof row.independentBindingVerificationSha256 !== "string" || !HASH.test(row.independentBindingVerificationSha256)) return fail();
  const summary = inspectPlan(row.plan);
  return { plan: row.plan, ...summary, planSha256: row.planSha256,
    independentBindingVerificationSha256: row.independentBindingVerificationSha256 };
}
export async function executeDirectoryMaintenance(csrfToken: string, attempt: DirectoryMaintenanceAttempt): Promise<DirectoryMaintenanceResult> {
  if (!UUID.test(attempt.approvalId) || !UUID.test(attempt.commandId) || !HASH.test(attempt.planSha256)) return fail(400, false);
  const { response, value } = await request("/execute", { method: "POST", headers: postHeaders(csrfToken),
    body: JSON.stringify({ ...attempt, confirm: true }) });
  if (!response.ok) return fail(response.status, response.status >= 500);
  const row = record(value, ["status", "commandId", "approvalId", "grantId", "resultingGeneration"]);
  if (!row || row.status !== "applied" && row.status !== "replayed" || row.commandId !== attempt.commandId
    || row.approvalId !== attempt.approvalId || typeof row.grantId !== "string" || !ID.test(row.grantId)
    || typeof row.resultingGeneration !== "number" || !Number.isSafeInteger(row.resultingGeneration)
    || row.resultingGeneration < 1) return fail(response.status);
  return row as DirectoryMaintenanceResult;
}
