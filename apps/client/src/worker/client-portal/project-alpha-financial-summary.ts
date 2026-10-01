import { z } from "zod";
import type { Env } from "../types";
import type { EffectivePortalWorkspaceContext } from "./workspace-v2";

const ENDPOINT = "/api/v2/financial/summary";
const TIMEOUT_MS = 4_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PA_PUBLIC_ID = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONEY = /^(?:0|[1-9][0-9]{0,12})\.[0-9]{2}$/;
const CURSOR = /^(?:[1-9][0-9]{0,8}|1[0-9]{9}|20[0-9]{8}|21[0-3][0-9]{7}|214[0-6][0-9]{6}|2147[0-3][0-9]{5}|21474[0-7][0-9]{4}|214748[0-2][0-9]{3}|2147483[0-5][0-9]{2}|21474836[0-3][0-9]|214748364[0-7])$/;

export function validFinancialSummaryCursor(value: string): boolean { return CURSOR.test(value); }

const optionalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
const publicUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
}).nullable();

const responseSchema = z.object({
  apiVersion: z.literal("2"),
  sourceInstanceId: z.string().regex(UUID),
  applicationId: z.string().regex(UUID),
  historyEpoch: z.string().regex(UUID),
  requestId: z.string().regex(UUID),
  resource: z.object({
    type: z.literal("project"),
    externalId: z.string().min(1).max(256).regex(SAFE_ID),
    publicId: z.string().regex(PA_PUBLIC_ID),
  }).strict(),
  returnedPageTotals: z.object({
    invoiceTotal: z.string().regex(MONEY),
    amountPaid: z.string().regex(MONEY),
    balanceDue: z.string().regex(MONEY),
  }).strict(),
  invoices: z.array(z.object({
    documentNumber: z.number().int().safe().positive().nullable(),
    status: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/),
    total: z.string().regex(MONEY),
    amountPaid: z.string().regex(MONEY),
    balanceDue: z.string().regex(MONEY),
    dueDate: optionalDate,
    documentDate: optionalDate,
    // Only PA-issued, currently active public links belong here. Authenticated
    // staff action URLs are deliberately not part of the accepted contract.
    invoicePublicUrl: publicUrl,
    paymentPublicUrl: publicUrl,
  }).strict()).max(50),
  nextCursor: z.string().regex(CURSOR).nullable(),
}).strict();

export type ClientFinancialSummary = z.infer<typeof responseSchema>;

type Connection = Readonly<{
  baseUrl: string;
  apiKey: string;
  sourceInstanceId: string;
  applicationId: string;
  historyEpoch: string;
  accessClientId?: string;
  accessClientSecret?: string;
}>;

export type FinancialProjectAuthority = Readonly<{
  sourceId: string;
  projectPublicId: string;
}>;

export interface FinancialSummaryOptions { fetcher?: typeof fetch }

function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

function configuredConnection(env: Env, sourceId: string): Connection | null {
  if (env.CLIENT_PORTAL_FINANCIAL_SUMMARY_ENABLED !== "true" || !SOURCE_ID.test(sourceId)
    || typeof env.CLIENT_PORTAL_FINANCIAL_API_V2_CONNECTIONS !== "string"
    || new TextEncoder().encode(env.CLIENT_PORTAL_FINANCIAL_API_V2_CONNECTIONS).byteLength > 256 * 1024) return null;
  try {
    const envelope: unknown = JSON.parse(env.CLIENT_PORTAL_FINANCIAL_API_V2_CONNECTIONS);
    if (!plain(envelope) || !exact(envelope, ["version", "instances"]) || envelope.version !== 1 || !plain(envelope.instances)) return null;
    const entries = Object.entries(envelope.instances);
    if (entries.length < 1 || entries.length > 64) return null;
    let selected: Connection | null = null;
    const seenOrigins = new Set<string>();
    for (const [key, raw] of entries) {
      if (!SOURCE_ID.test(key) || !plain(raw)) return null;
      const access = raw.accessClientId !== undefined || raw.accessClientSecret !== undefined;
      const fields = ["sourceId", "enabled", "baseUrl", "apiKey", "sourceInstanceId", "applicationId", "historyEpoch",
        ...(access ? ["accessClientId", "accessClientSecret"] : [])];
      if (!exact(raw, fields) || raw.sourceId !== key || typeof raw.enabled !== "boolean"
        || typeof raw.baseUrl !== "string" || typeof raw.apiKey !== "string" || !/^[\x21-\x7e]{20,8192}$/.test(raw.apiKey)
        || typeof raw.sourceInstanceId !== "string" || !UUID.test(raw.sourceInstanceId)
        || typeof raw.applicationId !== "string" || !UUID.test(raw.applicationId)
        || typeof raw.historyEpoch !== "string" || !UUID.test(raw.historyEpoch)
        || (access && (typeof raw.accessClientId !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(raw.accessClientId)
          || typeof raw.accessClientSecret !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(raw.accessClientSecret)))) return null;
      const url = new URL(raw.baseUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
        || url.href !== `${url.origin}/` || seenOrigins.has(url.origin)) return null;
      seenOrigins.add(url.origin);
      if (key === sourceId && raw.enabled) selected = Object.freeze({ baseUrl: url.origin, apiKey: raw.apiKey,
        sourceInstanceId: raw.sourceInstanceId.toLowerCase(), applicationId: raw.applicationId.toLowerCase(),
        historyEpoch: raw.historyEpoch.toLowerCase(), ...(access ? { accessClientId: raw.accessClientId as string,
          accessClientSecret: raw.accessClientSecret as string } : {}) });
    }
    return selected;
  } catch { return null; }
}

/** Resolve authorization and the PA selector from current source-qualified DB rows only. */
export async function resolveFinancialProjectAuthority(
  env: Env,
  workspace: EffectivePortalWorkspaceContext,
  localProjectId: string,
): Promise<FinancialProjectAuthority | null> {
  if (!workspace.canViewBilling || !SAFE_ID.test(localProjectId)) return null;
  const database = env.DELIVERY_DB.withSession?.("first-primary") ?? env.DELIVERY_DB;
  const row = await database.prepare(`SELECT project.project_alpha_source_id source_id,
      project.project_alpha_project_id project_public_id
    FROM portal_v2_workspaces workspace
    JOIN client_accounts account ON account.id=workspace.legacy_account_id AND account.id=?
      AND account.status='active' AND account.project_alpha_source_id=workspace.project_alpha_source_id
    JOIN client_identity_links identity ON identity.id=? AND identity.account_id=account.id AND identity.revoked_at IS NULL
    JOIN client_account_members member ON member.account_id=account.id AND member.identity_id=identity.id
      AND member.revoked_at IS NULL AND member.can_view_billing=1
    JOIN client_project_grants account_grant ON account_grant.account_id=account.id
      AND account_grant.project_id=? AND account_grant.revoked_at IS NULL
    JOIN projects project ON project.id=account_grant.project_id AND project.active=1
      AND project.project_alpha_source_id=workspace.project_alpha_source_id
      AND project.project_alpha_source_id=account.project_alpha_source_id
      AND project.project_alpha_project_id IS NOT NULL
    WHERE workspace.id=? AND workspace.status='active' AND workspace.legacy_account_id=account.id
      AND workspace.project_alpha_source_id IS NOT NULL
      AND (member.role='manager' OR EXISTS (SELECT 1 FROM client_member_project_grants member_grant
        WHERE member_grant.account_id=account.id AND member_grant.identity_id=identity.id
          AND member_grant.project_id=project.id AND member_grant.revoked_at IS NULL))`)
    .bind(workspace.legacyAccountId, workspace.legacyIdentityId, localProjectId, workspace.workspaceId)
    .first<{ source_id: string; project_public_id: string }>();
  if (!row || !SOURCE_ID.test(row.source_id) || !PA_PUBLIC_ID.test(row.project_public_id)) return null;
  return { sourceId: row.source_id, projectPublicId: row.project_public_id };
}

function cancel(response: Response): void { void response.body?.cancel().catch(() => undefined); }

async function readBounded(response: Response): Promise<unknown> {
  const declared = response.headers.get("Content-Length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) throw new Error("response_limit");
  if (!response.body) throw new Error("empty_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("response_limit"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export async function fetchProjectAlphaFinancialSummary(
  env: Env,
  authority: FinancialProjectAuthority,
  cursor: string | null = null,
  options: FinancialSummaryOptions = {},
): Promise<ClientFinancialSummary | null> {
  if (!SOURCE_ID.test(authority.sourceId) || !PA_PUBLIC_ID.test(authority.projectPublicId)
    || (cursor !== null && !validFinancialSummaryCursor(cursor))) return null;
  const connection = configuredConnection(env, authority.sourceId);
  if (!connection) return null;
  const url = new URL(ENDPOINT, `${connection.baseUrl}/`);
  // Deliberately exactly one, server-derived, most-constrained selector. The
  // canonical PA public ID is not interchangeable with an application's
  // external project binding ID; PA resolves this public ID through the
  // authenticated application's own active Project-v2 binding.
  url.searchParams.set("projectPublicId", authority.projectPublicId);
  url.searchParams.set("limit", "50");
  if (cursor !== null) url.searchParams.set("cursor", cursor);
  const headers = new Headers({ Accept: "application/json", Authorization: `Bearer ${connection.apiKey}`,
    "X-PA-Source-Instance-ID": connection.sourceInstanceId, "X-PA-Application-ID": connection.applicationId,
    "X-PA-History-Epoch": connection.historyEpoch });
  if (connection.accessClientId && connection.accessClientSecret) {
    headers.set("CF-Access-Client-Id", connection.accessClientId);
    headers.set("CF-Access-Client-Secret", connection.accessClientSecret);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await (options.fetcher ?? fetch)(url, { method: "GET", headers, redirect: "manual", credentials: "omit",
      cache: "no-store", signal: controller.signal });
    if (response.status !== 200 || response.redirected || response.headers.has("Location") || response.headers.has("Set-Cookie")
      || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")
      || !(response.headers.get("Cache-Control") ?? "").split(",").some(value => value.trim().toLowerCase() === "no-store")) {
      cancel(response); return null;
    }
    const requestId = response.headers.get("X-Request-ID");
    const parsed = responseSchema.safeParse(await readBounded(response));
    if (!parsed.success || requestId !== parsed.data.requestId
      || parsed.data.sourceInstanceId.toLowerCase() !== connection.sourceInstanceId
      || parsed.data.applicationId.toLowerCase() !== connection.applicationId
      || parsed.data.historyEpoch.toLowerCase() !== connection.historyEpoch
      || parsed.data.resource.publicId !== authority.projectPublicId
      || parsed.data.invoices.some(invoice => [invoice.invoicePublicUrl, invoice.paymentPublicUrl]
        .some(value => value !== null && new URL(value).origin !== connection.baseUrl))) return null;
    return parsed.data;
  } catch { return null; }
  finally { clearTimeout(timer); }
}
