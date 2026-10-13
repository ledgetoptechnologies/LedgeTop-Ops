import { z } from "zod";
import {
  probeProjectAlphaApiV2,
  type ProjectAlphaApiV2Connection,
  type ProjectAlphaApiV2Endpoint,
} from "./project-alpha-api-v2";
import { withEnabledConfiguredProjectAlphaFinancialApiV2Connection } from "./project-alpha-api-v2-connections";
import type { ProjectAlphaFinancialSummaryRequestV1, ProjectAlphaFinancialSummaryResultV1 } from "@ltds/shared";
import type { Env } from "./types";

const FINANCIAL_SUMMARY_ENDPOINT: ProjectAlphaApiV2Endpoint = {
  method: "GET",
  path: "/api/v2/financial/summary",
  requiredCapability: "financial.portal_summary.read",
};
const PROJECT_PUBLIC_ID = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RESPONSE_BYTES = 128 * 1024;

const money = z.string().regex(/^(?:0|[1-9][0-9]{0,11})\.[0-9]{2}$/);
const invoiceUrl = z.string().url().max(4096).nullable();
const paymentUrl = z.string().url().max(4096).nullable();
const responseSchema = z.object({
  apiVersion: z.literal("2"),
  sourceInstanceId: z.string().regex(UUID),
  applicationId: z.string().regex(UUID),
  historyEpoch: z.string().regex(UUID),
  requestId: z.string().regex(UUID),
  resource: z.object({
    type: z.literal("project"),
    externalId: z.string().min(1).max(128),
    publicId: z.string().regex(PROJECT_PUBLIC_ID),
  }).strict(),
  returnedPageTotals: z.object({ invoiceTotal: money, amountPaid: money, balanceDue: money }).strict(),
  invoices: z.array(z.object({
    documentNumber: z.number().int().positive().nullable(),
    status: z.string().min(1).max(40).regex(/^[a-z][a-z0-9_-]*$/),
    total: money,
    amountPaid: money,
    balanceDue: money,
    dueDate: z.string().max(40).nullable(),
    documentDate: z.string().max(40).nullable(),
    invoicePublicUrl: invoiceUrl,
    paymentPublicUrl: paymentUrl,
  }).strict()).max(100),
  nextCursor: z.string().regex(/^[1-9][0-9]{0,9}$/).refine(value => Number(value) <= 2_147_483_647).nullable(),
}).strict();

export type ProjectAlphaFinancialSummaryPayload = z.infer<typeof responseSchema>;
export type { ProjectAlphaFinancialSummaryRequestV1, ProjectAlphaFinancialSummaryResultV1 } from "@ltds/shared";

export function projectAlphaFinancialSummaryEnabled(env: Pick<Env, "PROJECT_ALPHA_FINANCIAL_SUMMARY_ENABLED">): boolean {
  return env.PROJECT_ALPHA_FINANCIAL_SUMMARY_ENABLED === "true";
}

function safeInvoiceUrl(raw: string, payment: boolean, allowedOrigins: ReadonlySet<string>): boolean {
  try {
    const url = new URL(raw);
    const page = payment ? "stripe-checkout" : "public-doc";
    const expected = payment ? ["page", "token"] : ["page", "type", "token"];
    return url.protocol === "https:" && allowedOrigins.has(url.origin) && !url.username && !url.password && !url.hash &&
      url.searchParams.getAll("page").length === 1 && url.searchParams.get("page") === page &&
      (!payment ? url.searchParams.get("type") === "invoice" && url.searchParams.getAll("type").length === 1 : !url.searchParams.has("type")) &&
      /^[A-Za-z0-9_-]{16,128}$/.test(url.searchParams.get("token") ?? "") && url.searchParams.getAll("token").length === 1 &&
      [...url.searchParams.keys()].length === expected.length;
  } catch { return false; }
}

function allowedPublicLinkOrigins(connection: ProjectAlphaApiV2Connection, configured: string | undefined): ReadonlySet<string> | null {
  const origins = new Set<string>([new URL(connection.baseUrl).origin]);
  if (configured === undefined || configured === "") return origins;
  if (configured.length > 4096) return null;
  for (const raw of configured.split(",")) {
    if (!raw || raw !== raw.trim() || origins.size >= 16) return null;
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.href !== `${url.origin}/`) return null;
      origins.add(url.origin);
    } catch { return null; }
  }
  return origins;
}

function queryUrl(connection: ProjectAlphaApiV2Connection, projectPublicId: string, cursor: string | null): URL {
  const url = new URL(FINANCIAL_SUMMARY_ENDPOINT.path, connection.baseUrl);
  url.searchParams.set("projectPublicId", projectPublicId);
  url.searchParams.set("limit", "100");
  if (cursor !== null) url.searchParams.set("cursor", cursor);
  return url;
}

function authHeaders(connection: ProjectAlphaApiV2Connection): Headers {
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${connection.apiKey}`,
    "Cache-Control": "no-store",
    "X-PA-Source-Instance-ID": connection.expectedSourceInstanceId,
    "X-PA-Application-ID": connection.expectedApplicationId,
  });
  if (connection.expectedHistoryEpoch) headers.set("X-PA-History-Epoch", connection.expectedHistoryEpoch);
  if (connection.accessClientId && connection.accessClientSecret) {
    headers.set("CF-Access-Client-Id", connection.accessClientId);
    headers.set("CF-Access-Client-Secret", connection.accessClientSecret);
  }
  return headers;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new Error("response_limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("invalid_response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("response_limit");
      }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function noStoreJson(response: Response): boolean {
  return /^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "") &&
    (response.headers.get("Cache-Control") ?? "").split(",").some(value => value.trim().toLowerCase() === "no-store") &&
    !response.headers.has("Set-Cookie") && !response.headers.has("Location");
}

async function readFromConnection(
  connection: ProjectAlphaApiV2Connection,
  request: ProjectAlphaFinancialSummaryRequestV1,
  send: typeof fetch,
  configuredPublicOrigins: string | undefined,
): Promise<ProjectAlphaFinancialSummaryResultV1> {
  const probe = await probeProjectAlphaApiV2(connection, ["financial.portal_summary.read"], send, [FINANCIAL_SUMMARY_ENDPOINT]);
  if (probe.status !== "verified") {
    return { ok: false, protocolVersion: 1, code: probe.status === "misconfigured" ? "misconfigured" : "unavailable" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await send(queryUrl(connection, request.projectPublicId, request.cursor ?? null), {
      method: "GET", headers: authHeaders(connection), redirect: "manual", credentials: "omit", cache: "no-store", signal: controller.signal,
    });
    const requestId = response.headers.get("X-Request-ID");
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      return { ok: false, protocolVersion: 1, code: "incompatible" };
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return { ok: false, protocolVersion: 1, code: "not_found" };
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return { ok: false, protocolVersion: 1, code: response.status === 400 ? "incompatible" : "unavailable" };
    }
    if (!requestId || !UUID.test(requestId) || !noStoreJson(response)) {
      await response.body?.cancel();
      return { ok: false, protocolVersion: 1, code: "incompatible" };
    }
    const parsed = responseSchema.safeParse(await boundedJson(response));
    if (!parsed.success || parsed.data.requestId !== requestId ||
      parsed.data.sourceInstanceId.toLowerCase() !== connection.expectedSourceInstanceId.toLowerCase() ||
      parsed.data.applicationId.toLowerCase() !== connection.expectedApplicationId.toLowerCase() ||
      (connection.expectedHistoryEpoch && parsed.data.historyEpoch.toLowerCase() !== connection.expectedHistoryEpoch.toLowerCase()) ||
      parsed.data.resource.publicId !== request.projectPublicId) {
      return { ok: false, protocolVersion: 1, code: "incompatible" };
    }
    const publicLinkOrigins = allowedPublicLinkOrigins(connection, configuredPublicOrigins);
    if (!publicLinkOrigins) return { ok: false, protocolVersion: 1, code: "misconfigured" };
    if (parsed.data.invoices.some(invoice =>
      (invoice.invoicePublicUrl !== null && !safeInvoiceUrl(invoice.invoicePublicUrl, false, publicLinkOrigins)) ||
      (invoice.paymentPublicUrl !== null && !safeInvoiceUrl(invoice.paymentPublicUrl, true, publicLinkOrigins)))) {
      return { ok: false, protocolVersion: 1, code: "incompatible" };
    }
    return { ok: true, protocolVersion: 1, summary: parsed.data };
  } catch {
    return { ok: false, protocolVersion: 1, code: "unavailable" };
  } finally { clearTimeout(timer); }
}

export async function readProjectAlphaFinancialSummary(
  env: Env,
  input: unknown,
  send: typeof fetch = fetch,
): Promise<ProjectAlphaFinancialSummaryResultV1> {
  if (!projectAlphaFinancialSummaryEnabled(env)) return { ok: false, protocolVersion: 1, code: "disabled" };
  const requestSchema = z.object({
    protocolVersion: z.literal(1),
    sourceId: z.string().regex(/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/),
    projectPublicId: z.string().regex(PROJECT_PUBLIC_ID),
    cursor: z.string().regex(/^[1-9][0-9]{0,9}$/).refine(value => Number(value) <= 2_147_483_647).nullable().optional(),
  }).strict();
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, protocolVersion: 1, code: "incompatible" };
  try {
    const selected = await withEnabledConfiguredProjectAlphaFinancialApiV2Connection(env, parsed.data.sourceId,
      connection => readFromConnection(connection, parsed.data, send, env.PROJECT_ALPHA_FINANCIAL_SUMMARY_PUBLIC_ORIGINS));
    if (selected.status === "disabled") return { ok: false, protocolVersion: 1, code: "disabled" };
    if (selected.status === "misconfigured") return { ok: false, protocolVersion: 1, code: "misconfigured" };
    return selected.value;
  } catch {
    return { ok: false, protocolVersion: 1, code: "misconfigured" };
  }
}
