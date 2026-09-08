import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";
import { sqlScope } from "./acl";
import { auditStatement } from "./request-security";
import { parseStoredWorkArea, type StaffRequestArea } from "./request-area-revision";
import type { Env, StaffPrincipal } from "./types";
import { provePrimaryBusinessReferences } from "./project-alpha-primary-references";
import { assertProjectAlphaConnectorProof, LEGACY_PRIMARY_DRAFT_QUOTE_SOURCE, ProjectAlphaConnectorError, resolveProjectAlphaConnector,
  type ProjectAlphaConnectorProof } from "./project-alpha-connectors";
import { projectAlphaReadVisibleSql } from "./project-alpha-read-visibility";
import { validatedUniquePublicIdExpression } from "./client-hub-source";

type AppEnv = {
  Bindings: Env;
  Variables: { principal: StaffPrincipal; administrator: boolean };
};
type App = Hono<AppEnv>;

const COMMAND_SCOPE = "portal.quote-draft.create";
const COMMAND_TIMEOUT_MS = 8_000;
const MAX_COMMAND_BYTES = 96 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const SQUARE_METERS_PER_ACRE = 4_046.8564224;
const EARTH_RADIUS_METERS = 6_371_008.8;
const SAFE_PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPAQUE_PUBLIC_ID = /^(?=.{1,128}$)(?=.*[A-Za-z])[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const commandPath = (applicationKey: string): string => `/api/v2/integrations/${encodeURIComponent(applicationKey)}/draft-quotes`;
const SHA256_HEX = /^[a-f0-9]{64}$/;

interface RequestRow {
  id: string;
  account_id: string;
  catalog_source_id: string;
  status: string;
  title: string;
  details: string;
  deliverables_text: string | null;
  project_alpha_client_id: string | null;
  project_alpha_organization_id: string | null;
  project_alpha_project_id: string | null;
  account_source_id: string | null;
  project_source_id: string | null;
  portal_project_id: string | null;
  portal_workspace_id: string | null;
  portal_project_public_id: string | null;
  project_authorized: number;
  area_geojson: string | null;
  poi_points_json: string | null;
  effective_area_geojson: string | null;
  effective_poi_points_json: string | null;
  area_revision: number | null;
  request_revision: number;
  scope_text: string | null;
}

interface ServiceRow {
  service_source_id: string;
  service_public_id: string;
  service_source_version: string;
  answers_json: string;
}

interface AttachmentRow {
  original_name: string;
  content_type: string;
  actual_size: number;
  verified_sha256: string;
}

export interface ProjectAlphaDraftQuotePayload {
  schemaVersion: 1;
  /** Deployment-owned, exact Project Alpha integration profile identity. */
  source: string;
  request: {
    publicId: string;
    revision: number;
    title: string;
    scopeSummary: string;
    deliverablesSummary: string | null;
  };
  authorization: {
    organizationPublicId: string | null;
    clientPublicId: string;
    projectPublicId: string | null;
  };
  services: Array<{
    publicId: string;
    catalogVersion: string;
    answers: Record<string, unknown>;
  }>;
  workArea: {
    revision: number;
    hash: string;
    squareMeters: number | null;
    acres: number | null;
  };
  attachments: Array<{
    name: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
  }>;
}

export interface ProjectAlphaDraftQuoteResult {
  receiptId: string;
  draftQuote: {
    publicId: string;
    documentNumber: string | null;
    status: "draft";
    version: number;
    editorPath: string;
  };
}

const opaquePublicId = z.string().trim().min(1).max(128).regex(OPAQUE_PUBLIC_ID);
const draftQuoteSourceSchema = z.string().min(1).max(100).regex(/^[a-z][a-z0-9._:-]{0,99}$/);
const projectAlphaDraftQuotePayloadSchema = z.object({
  schemaVersion: z.literal(1),
  source: draftQuoteSourceSchema,
  request: z.object({
    publicId: opaquePublicId,
    revision: z.number().int().positive(),
    title: z.string().min(1).max(160),
    scopeSummary: z.string().min(1).max(5_000),
    deliverablesSummary: z.string().min(1).max(2_000).nullable(),
  }).strict(),
  authorization: z.object({
    organizationPublicId: opaquePublicId.nullable(),
    clientPublicId: opaquePublicId,
    projectPublicId: opaquePublicId.nullable(),
  }).strict(),
  services: z.array(z.object({
    publicId: opaquePublicId,
    catalogVersion: z.string().trim().min(1).max(128).regex(SAFE_PUBLIC_ID),
    answers: z.record(z.string(), z.unknown()),
  }).strict()).min(1).max(10),
  workArea: z.object({
    revision: z.number().int().nonnegative(),
    hash: z.string().regex(SHA256_HEX),
    squareMeters: z.number().nonnegative().nullable(),
    acres: z.number().nonnegative().nullable(),
  }).strict().refine(
    area => (area.squareMeters === null) === (area.acres === null),
    "squareMeters and acres must both be present or both be null",
  ),
  attachments: z.array(z.object({
    name: z.string().min(1).max(255),
    contentType: z.string().min(1).max(100),
    sizeBytes: z.number().int().positive().safe(),
    sha256: z.string().regex(SHA256_HEX),
  }).strict()).max(10),
}).strict();

interface ReceiptRow {
  source_id: string;
  command_id: string | null;
  editor_origin: string | null;
  request_revision: number;
  area_revision: number;
  idempotency_key: string;
  payload_hash: string;
  project_alpha_receipt_id: string;
  project_alpha_artifact_public_id: string;
  document_number: string | null;
  artifact_status: "draft";
  artifact_version: number;
  editor_path: string;
  scope_stale_at: string | null;
  created_at: string;
}

const responseSchema = z.object({
  receiptId: opaquePublicId,
  draftQuote: z.object({
    publicId: opaquePublicId,
    documentNumber: z.string().trim().min(1).max(120).nullable(),
    status: z.literal("draft"),
    version: z.number().int().positive(),
    editorPath: z.string().min(2).max(500).refine(
      value => value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && !/\s/.test(value),
      "editorPath must be a same-origin relative path",
    ),
  }).strict(),
}).strict().superRefine((result, context) => {
  const expectedPath = `/quotes/${encodeURIComponent(result.draftQuote.publicId)}/edit`;
  if (result.draftQuote.editorPath !== expectedPath) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["draftQuote", "editorPath"],
      message: "editorPath must identify the returned quote public ID",
    });
  }
});

export function parseProjectAlphaDraftQuotePayload(value: unknown): ProjectAlphaDraftQuotePayload | null {
  const parsed = projectAlphaDraftQuotePayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseProjectAlphaDraftQuoteResult(value: unknown): ProjectAlphaDraftQuoteResult | null {
  const parsed = responseSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const errorSchema = z.object({
  code: z.enum(["IDEMPOTENCY_CONFLICT", "STALE_CATALOG", "SCOPE_DENIED", "INVALID_REQUEST"]).optional(),
}).passthrough();

export class ProjectAlphaDraftQuoteError extends Error {
  constructor(
    readonly status: 409 | 502 | 503,
    readonly code: "integration_disabled" | "integration_unavailable" | "idempotency_conflict" | "stale_catalog" | "scope_denied" | "invalid_response" | "destination_changed" | "reconciliation_required",
    message: string,
  ) {
    super(message);
    this.name = "ProjectAlphaDraftQuoteError";
  }
}

function database(env: Env): Pick<D1Database, "prepare" | "batch"> {
  return env.DELIVERY_DB.withSession?.("first-primary") ?? env.DELIVERY_DB;
}

async function requireOperationsManage(env: Env, principal: StaffPrincipal): Promise<void> {
  const scope = await sqlScope(env, principal, "operations.manage");
  if (!scope.global || scope.deniedGlobal)
    throw new HTTPException(403, { message: "Global operations.manage permission required" });
}

function integrationConfiguration(env: Env): {
  url: URL;
  apiKey: string;
  signingSecret: string;
  applicationKey: string;
} | null {
  if (env.PROJECT_ALPHA_DRAFT_QUOTES_ENABLED !== "true") return null;
  if (
    !env.PROJECT_ALPHA_BASE_URL ||
    !env.PROJECT_ALPHA_DRAFT_QUOTE_API_KEY ||
    !env.PROJECT_ALPHA_DRAFT_QUOTE_HMAC_SECRET ||
    env.PROJECT_ALPHA_DRAFT_QUOTE_HMAC_SECRET.length < 32 ||
    !env.APPLICATION_KEY ||
    !SAFE_PUBLIC_ID.test(env.APPLICATION_KEY)
  ) return null;
  let base: URL;
  try {
    base = new URL(env.PROJECT_ALPHA_BASE_URL);
  } catch {
    return null;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if ((base.protocol !== "https:" && !(local && base.protocol === "http:")) || base.username || base.password || base.search || base.hash)
    return null;
  return {
    url: new URL(commandPath(env.APPLICATION_KEY), base),
    apiKey: env.PROJECT_ALPHA_DRAFT_QUOTE_API_KEY,
    signingSecret: env.PROJECT_ALPHA_DRAFT_QUOTE_HMAC_SECRET,
    applicationKey: env.APPLICATION_KEY,
  };
}

export function projectAlphaDraftQuoteCapability(env: Env): { enabled: boolean; reason: string | null } {
  if (env.PROJECT_ALPHA_DRAFT_QUOTES_ENABLED !== "true")
    return { enabled: false, reason: "Project Alpha draft creation is not enabled" };
  if (!integrationConfiguration(env))
    return { enabled: false, reason: "Project Alpha draft creation is not configured" };
  return { enabled: true, reason: null };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

export function canonicalProjectAlphaJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export async function sha256Hex(value: string): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function projectAlphaDraftIdempotencyKey(
  requestPublicId: string,
  requestRevision: number,
  areaRevision: number,
): string {
  if (
    !OPAQUE_PUBLIC_ID.test(requestPublicId) ||
    !Number.isSafeInteger(requestRevision) || requestRevision < 1 ||
    !Number.isSafeInteger(areaRevision) || areaRevision < 0
  ) throw new Error("Invalid Project Alpha draft revision identity");
  return `ltds-pa-draft:${requestPublicId}:r${requestRevision}:a${areaRevision}`;
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const result = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function polygonSquareMeters(area: StaffRequestArea | null): number | null {
  if (!area) return null;
  const ring = area.coordinates[0]!;
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [longitude1, latitude1] = ring[index]!;
    const [longitude2, latitude2] = ring[index + 1]!;
    sum += ((longitude2 - longitude1) * Math.PI / 180) *
      (2 + Math.sin(latitude1 * Math.PI / 180) + Math.sin(latitude2 * Math.PI / 180));
  }
  return Math.abs(sum * EARTH_RADIUS_METERS * EARTH_RADIUS_METERS / 2);
}

function finiteRounded(value: number | null, places: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(places));
}

function parseAnswers(raw: string): Record<string, unknown> {
  if (new TextEncoder().encode(raw).byteLength > 32 * 1024)
    throw new HTTPException(409, { message: "A selected service answer snapshot is too large for Project Alpha" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HTTPException(409, { message: "A selected service answer snapshot is invalid" });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new HTTPException(409, { message: "A selected service answer snapshot is invalid" });
  return parsed as Record<string, unknown>;
}

function resultFromReceipt(row: ReceiptRow): ProjectAlphaDraftQuoteResult {
  return {
    receiptId: row.project_alpha_receipt_id,
    draftQuote: {
      publicId: row.project_alpha_artifact_public_id,
      documentNumber: row.document_number,
      status: row.artifact_status,
      version: row.artifact_version,
      editorPath: row.editor_path,
    },
  };
}

function editorUrl(origin: string | null, path: string): string | null {
  if (!origin) return null;
  try {
    const base = new URL(origin);
    if (base.protocol !== "https:" || base.username || base.password || base.origin !== origin) return null;
    const resolved = new URL(path, base);
    return resolved.origin === base.origin ? resolved.toString() : null;
  } catch {
    return null;
  }
}

function receiptResponse(row: ReceiptRow) {
  return {
    requestRevision: row.request_revision,
    areaRevision: row.area_revision,
    createdAt: row.created_at,
    sourceId: row.source_id,
    editorUrl: editorUrl(row.editor_origin, row.editor_path),
    editorUnavailableReason: row.command_id === null ? "legacy_destination_unknown" : null,
    ...resultFromReceipt(row),
  };
}

interface QuoteDestination {
  sourceId: string;
  draftQuoteSource: string;
  commandEndpoint: string;
  applicationKey: string;
  editorOrigin: string;
  destinationFingerprint: string;
}

interface QuoteRuntime {
  destination: QuoteDestination;
  apiKey: string;
  signingSecret: string;
  draftQuoteSource: string;
  connectorProof: ProjectAlphaConnectorProof | null;
}

async function quoteRuntime(env: Env, sourceId: string): Promise<QuoteRuntime> {
  // The no-manifest primary adapter remains compatible while an installation
  // upgrades. Once a manifest is present, every PA—including primary—uses its
  // deployment-owned source identity rather than an Operations scalar.
  if (sourceId === PRIMARY_ALPHA_SOURCE_ID && !env.PROJECT_ALPHA_CONNECTOR_SOURCES?.trim()) {
    // Preserve the established primary scalar integration exactly. Registry
    // credentials are not allowed to silently take ownership of this route.
    const config = integrationConfiguration(env);
    if (!config) throw new ProjectAlphaDraftQuoteError(503, "integration_disabled", "Project Alpha draft creation is not available");
    const target = { sourceId, draftQuoteSource: LEGACY_PRIMARY_DRAFT_QUOTE_SOURCE, commandEndpoint: config.url.toString(), applicationKey: config.applicationKey, editorOrigin: config.url.origin };
    return { destination: { ...target, destinationFingerprint: await sha256Hex(canonicalProjectAlphaJson(target)) },
      apiKey: config.apiKey, signingSecret: config.signingSecret, draftQuoteSource: LEGACY_PRIMARY_DRAFT_QUOTE_SOURCE, connectorProof: null };
  }
  if (env.PROJECT_ALPHA_DRAFT_QUOTES_ENABLED !== "true")
    throw new ProjectAlphaDraftQuoteError(503, "integration_disabled", "Project Alpha draft creation is not enabled");
  if (!env.OPS_DB)
    throw new ProjectAlphaDraftQuoteError(409, "scope_denied", "This request's catalog source has no configured quote connection");
  try {
    const connector = await resolveProjectAlphaConnector(env, sourceId, "draft_quote");
    if (!connector.draftQuote)
      throw new ProjectAlphaDraftQuoteError(503, "integration_disabled", "This request's source has no dedicated draft quote connection");
    const base = new URL(connector.draftQuote.baseUrl);
    const endpoint = new URL(commandPath(connector.draftQuote.applicationKey), base);
    if (endpoint.origin !== base.origin)
      throw new ProjectAlphaDraftQuoteError(503, "integration_disabled", "The draft quote destination is invalid");
    const target = { sourceId, draftQuoteSource: connector.draftQuote.source, commandEndpoint: endpoint.toString(), applicationKey: connector.draftQuote.applicationKey, editorOrigin: endpoint.origin };
    return { destination: { ...target, destinationFingerprint: await sha256Hex(canonicalProjectAlphaJson(target)) },
      apiKey: connector.draftQuote.apiKey, signingSecret: connector.draftQuote.hmacSecret,
      draftQuoteSource: connector.draftQuote.source, connectorProof: connector.proof };
  } catch (error) {
    if (error instanceof ProjectAlphaDraftQuoteError) throw error;
    if (error instanceof ProjectAlphaConnectorError) {
      const denied = error.code === "invalid" || error.code === "unavailable";
      const changed = error.code === "changed" || error.code === "conflict";
      throw new ProjectAlphaDraftQuoteError(denied || changed ? 409 : 503,
        denied ? "scope_denied" : changed ? "destination_changed" : "integration_disabled", error.message);
    }
    throw error;
  }
}

async function boundedResponseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get("Content-Length");
  if ((declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) ||
    !/^application\/json(?:;|$)/i.test(response.headers.get("Content-Type") ?? "")) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("invalid-quote-response");
  }
  if (!response.body) throw new Error("empty-quote-response");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const next = await untilAborted(reader.read(), signal);
      signal.throwIfAborted();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new Error("quote-response-too-large");
      }
      chunks.push(next.value);
    }
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    throw signal.reason;
  }
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

export async function sendProjectAlphaDraftQuoteCommand(
  env: Env,
  payload: ProjectAlphaDraftQuotePayload,
  idempotencyKey: string,
  options: { now?: Date; fetcher?: typeof fetch; sourceId?: string; destination?: QuoteDestination } = {},
): Promise<ProjectAlphaDraftQuoteResult> {
  const runtime = await quoteRuntime(env, options.sourceId ?? PRIMARY_ALPHA_SOURCE_ID);
  const destination = runtime.destination;
  if (options.destination && canonicalProjectAlphaJson(options.destination) !== canonicalProjectAlphaJson(destination))
    throw new ProjectAlphaDraftQuoteError(409, "destination_changed", "The quote destination changed; reconcile the saved command before retrying");
  if (runtime.connectorProof) await assertProjectAlphaConnectorProof(env, runtime.connectorProof);
  const validatedPayload = parseProjectAlphaDraftQuotePayload(payload);
  if (!validatedPayload)
    throw new ProjectAlphaDraftQuoteError(409, "invalid_response", "The Project Alpha draft command is invalid");
  if (validatedPayload.source !== runtime.draftQuoteSource)
    throw new ProjectAlphaDraftQuoteError(409, "scope_denied", "The Project Alpha draft command does not match this source's configured identity");
  const rawBody = canonicalProjectAlphaJson(validatedPayload);
  if (new TextEncoder().encode(rawBody).byteLength > MAX_COMMAND_BYTES)
    throw new ProjectAlphaDraftQuoteError(409, "invalid_response", "The Project Alpha draft command is too large");
  const bodyHash = await sha256Hex(rawBody);
  const timestamp = (options.now ?? new Date()).toISOString();
  const endpoint = new URL(destination.commandEndpoint);
  const signatureInput = `${timestamp}\nPOST\n${endpoint.pathname}${endpoint.search}\n${idempotencyKey}\n${bodyHash}`;
  const signature = await hmacHex(runtime.signingSecret, signatureInput);
  let response: Response, rawResponse: unknown;
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS);
  try {
    if (runtime.connectorProof) await assertProjectAlphaConnectorProof(env, runtime.connectorProof);
    const pending = (options.fetcher ?? globalThis.fetch)(destination.commandEndpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${runtime.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "X-Portal-Integration-Application-Key": destination.applicationKey,
        "X-Portal-Integration-Body-SHA256": bodyHash,
        "X-Portal-Integration-Signature": `sha256=${signature}`,
        "X-Portal-Integration-Timestamp": timestamp,
      },
      body: rawBody,
      // Cloudflare Workers rejects redirect:"error"; manual prevents the
      // signed request from following a destination-controlled Location.
      redirect: "manual",
      signal: controller.signal,
    });
    // Even an injected transport that ignores abort must not prolong a request.
    // Dispose a late response rather than leaving its body unread.
    void pending.then(late => { if (controller.signal.aborted) void late.body?.cancel().catch(() => undefined); }, () => undefined);
    response = await untilAborted(pending, controller.signal);
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      void response.body?.cancel().catch(() => undefined);
      throw new ProjectAlphaDraftQuoteError(502, "invalid_response", "Project Alpha redirected the signed quote command");
    }
    try { rawResponse = await boundedResponseJson(response, controller.signal); }
    catch {
      if (controller.signal.aborted) throw new Error("quote-response-timeout");
      if (response.ok) throw new ProjectAlphaDraftQuoteError(502, "invalid_response", "Project Alpha returned an invalid draft receipt");
      rawResponse = null;
    }
  } catch (error) {
    if (error instanceof ProjectAlphaDraftQuoteError) throw error;
    throw new ProjectAlphaDraftQuoteError(503, "integration_unavailable", "Project Alpha did not return a confirmed receipt; retry the saved command to reconcile the outcome");
  } finally { clearTimeout(timeout); }
  if (!response.ok) {
    const parsed = errorSchema.safeParse(rawResponse);
    const code = parsed.success ? parsed.data.code : undefined;
    if (response.status === 409 && code === "STALE_CATALOG")
      throw new ProjectAlphaDraftQuoteError(409, "stale_catalog", "Project Alpha service catalog changed; refresh the request before retrying");
    if (response.status === 409 && code === "IDEMPOTENCY_CONFLICT")
      throw new ProjectAlphaDraftQuoteError(409, "idempotency_conflict", "Project Alpha rejected a conflicting idempotency replay");
    if (response.status === 403 || code === "SCOPE_DENIED")
      throw new ProjectAlphaDraftQuoteError(409, "scope_denied", "Project Alpha rejected the client or project scope");
    throw new ProjectAlphaDraftQuoteError(
      response.status >= 500 || response.status === 429 ? 503 : 502,
      "integration_unavailable",
      response.status >= 500 || response.status === 429
        ? "Project Alpha did not confirm the draft; retry the saved command to reconcile the outcome"
        : "Project Alpha rejected the draft command",
    );
  }
  const parsed = parseProjectAlphaDraftQuoteResult(rawResponse);
  if (!parsed)
    throw new ProjectAlphaDraftQuoteError(502, "invalid_response", "Project Alpha returned an invalid draft receipt");
  return parsed;
}

async function requestForDraft(env: Env, requestId: string): Promise<RequestRow | null> {
  return database(env).prepare(
    `SELECT r.id,r.account_id,r.catalog_source_id,r.status,r.title,r.details,r.deliverables_text,
      account.project_alpha_client_id,account.project_alpha_organization_id,
      account.project_alpha_source_id account_source_id,project.project_alpha_source_id project_source_id,
      project.project_alpha_project_id,r.project_id portal_project_id,
      r.portal_workspace_id,r.portal_project_public_id,
      CASE WHEN r.project_id IS NULL THEN 1 WHEN project.active=1 AND EXISTS (
        SELECT 1 FROM client_project_grants grant_row
        WHERE grant_row.account_id=r.account_id AND grant_row.project_id=r.project_id
          AND grant_row.revoked_at IS NULL
      ) THEN 1 ELSE 0 END project_authorized,
      r.area_geojson,r.poi_points_json,
      effective.area_geojson effective_area_geojson,effective.poi_points_json effective_poi_points_json,
      effective.revision_number area_revision,
      COALESCE((SELECT MAX(revision.revision_number) FROM request_revisions revision WHERE revision.request_id=r.id),0) request_revision,
      (SELECT estimate.scope_text FROM request_operational_estimates estimate
        WHERE estimate.request_id=r.id AND estimate.status IN ('draft','ready','accepted','change_requested')
        ORDER BY estimate.version DESC LIMIT 1) scope_text
     FROM client_service_requests r
     LEFT JOIN client_accounts account ON account.id=r.account_id
     LEFT JOIN projects project ON project.id=r.project_id
     LEFT JOIN client_service_request_area_revisions effective ON effective.request_id=r.id
       AND effective.revision_number=(SELECT MAX(candidate.revision_number)
         FROM client_service_request_area_revisions candidate WHERE candidate.request_id=r.id)
     WHERE r.id=?`,
  ).bind(requestId).first<RequestRow>();
}

async function latestReceipt(env: Env, requestId: string, sourceId: string): Promise<ReceiptRow | null> {
  return database(env).prepare(
    `${receiptSelect} WHERE receipt.request_id=? AND receipt.source_id=? AND receipt.scope_stale_at IS NULL
     ORDER BY receipt.request_revision DESC,receipt.area_revision DESC,receipt.created_at DESC LIMIT 1`,
  ).bind(requestId, sourceId).first<ReceiptRow>();
}

const receiptSelect = `SELECT receipt.*,command.editor_origin
  FROM request_pa_draft_quote_receipts receipt
  LEFT JOIN request_pa_draft_quote_commands command ON command.id=receipt.command_id
    AND command.source_id=receipt.source_id`;

async function exactReceipt(env: Env, requestId: string, sourceId: string,
  revision: number, areaRevision: number): Promise<ReceiptRow | null> {
  return database(env).prepare(`${receiptSelect} WHERE receipt.request_id=?
      AND receipt.request_revision=? AND receipt.area_revision=? AND receipt.source_id=?`)
    .bind(requestId, revision, areaRevision, sourceId).first<ReceiptRow>();
}

interface QuoteCommandRow {
  id: string;
  source_id: string;
  command_endpoint: string;
  application_key: string;
  editor_origin: string;
  destination_fingerprint: string;
  idempotency_key: string;
  payload_hash: string;
  payload_json: string;
}

const unresolvedOtherCommandSql = `SELECT 1 FROM request_pa_draft_quote_commands pending
  WHERE pending.request_id=? AND (pending.request_revision<>? OR pending.area_revision<>?)
    AND NOT EXISTS(SELECT 1 FROM request_pa_draft_quote_receipts receipt WHERE receipt.command_id=pending.id)`;
const reconcileMessage = "An earlier quote command has no confirmed receipt. Reconcile its outcome in the original Project Alpha instance before creating a new revision.";

async function hasUnresolvedOtherCommand(env: Env, row: RequestRow): Promise<boolean> {
  return !!await database(env).prepare(unresolvedOtherCommandSql)
    .bind(row.id, row.request_revision, row.area_revision || 0).first();
}

interface NativeDraftAuthority {
  sourceId: string;
  workspaceId: string;
  rootType: "organization" | "standalone_client";
  rootPublicId: string;
  projectPublicId: string;
  projectSourceVersion: string;
  generationId: string;
  sourceSequence: number;
  portalAuthorityVersion: number;
  connectorRevision: number;
  connectorVersion: number;
  clientPublicId: string;
  organizationPublicId: string | null;
  proof: string;
}

async function resolveNativeDraftAuthority(env: Env, row: RequestRow,
  connectorProof: ProjectAlphaConnectorProof): Promise<NativeDraftAuthority> {
  if (row.catalog_source_id === PRIMARY_ALPHA_SOURCE_ID || !row.portal_workspace_id || !row.portal_project_public_id)
    throw new HTTPException(409, { message: "This request is not linked to a source-owned Project Alpha project" });
  if (connectorProof.mode !== "registry" || connectorProof.sourceId !== row.catalog_source_id || connectorProof.profile !== "business_data")
    throw new HTTPException(409, { message: "This request's Project Alpha connection is not current" });
  const delivery = await database(env).prepare(`WITH RECURSIVE lineage(entity_type,public_id,parent_public_id,depth) AS (
      SELECT project.entity_type,project.public_id,project.parent_public_id,0
      FROM portal_v2_directory_entities project
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=project.workspace_id
        AND checkpoint.active_generation_id=project.generation_id
      WHERE project.workspace_id=? AND project.entity_type='project' AND project.public_id=? AND project.active=1
      UNION ALL
      SELECT parent.entity_type,parent.public_id,parent.parent_public_id,lineage.depth+1
      FROM lineage JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=?
      JOIN portal_v2_directory_entities parent ON parent.workspace_id=checkpoint.workspace_id
        AND parent.generation_id=checkpoint.active_generation_id AND parent.public_id=lineage.parent_public_id AND parent.active=1
      WHERE lineage.parent_public_id IS NOT NULL AND lineage.depth<16
        AND (SELECT count(*) FROM portal_v2_directory_entities unique_parent
          WHERE unique_parent.workspace_id=checkpoint.workspace_id AND unique_parent.generation_id=checkpoint.active_generation_id
            AND unique_parent.public_id=lineage.parent_public_id AND unique_parent.active=1)=1
    ) SELECT workspace.root_type,COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) root_public_id,
      (SELECT public_id FROM lineage WHERE entity_type='client' LIMIT 1) client_public_id,
      checkpoint.active_generation_id generation_id,checkpoint.source_sequence,
      authority.version portal_authority_version,authority.connector_revision,authority.connector_version,
      project.source_version project_source_version
    FROM portal_v2_workspaces workspace
    JOIN pa_portal_workspace_sources owner ON owner.workspace_id=workspace.id
      AND owner.projection_source_id=workspace.project_alpha_source_id
    JOIN pa_portal_source_authorities authority ON authority.source_id=workspace.project_alpha_source_id AND authority.state='active'
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
      AND generation.workspace_id=workspace.id AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities root ON root.workspace_id=workspace.id AND root.generation_id=checkpoint.active_generation_id
      AND root.entity_type=workspace.root_type AND root.public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) AND root.active=1
    JOIN portal_v2_directory_entities project ON project.workspace_id=workspace.id AND project.generation_id=checkpoint.active_generation_id
      AND project.entity_type='project' AND project.public_id=? AND project.active=1
    WHERE workspace.id=? AND workspace.project_alpha_source_id=? AND workspace.legacy_account_id IS NULL AND workspace.status='active'
      AND authority.connector_revision=? AND authority.connector_version=?
      AND (SELECT count(*) FROM lineage WHERE entity_type='client')=1
      AND EXISTS(SELECT 1 FROM lineage WHERE entity_type=workspace.root_type
        AND public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id))`)
    .bind(row.portal_workspace_id,row.portal_project_public_id,row.portal_workspace_id,row.portal_project_public_id,
      row.portal_workspace_id,row.catalog_source_id,connectorProof.revision,connectorProof.version)
    .first<{root_type: NativeDraftAuthority["rootType"];root_public_id:string;client_public_id:string;generation_id:string;source_sequence:number;
      portal_authority_version:number;connector_revision:number;connector_version:number;project_source_version:string}>();
  if (!delivery) throw new HTTPException(409, { message: "Refresh the Project Alpha portal directory before creating this quote" });
  const projectId = validatedUniquePublicIdExpression("pa_projects", "project");
  const clientId = validatedUniquePublicIdExpression("pa_clients", "client");
  const organizationId = validatedUniquePublicIdExpression("pa_organizations", "organization");
  const rows = await env.OPS_DB.withSession("first-primary").prepare(`SELECT ${projectId} project_public_id,
      ${clientId} client_public_id,${organizationId} organization_public_id
    FROM pa_projects project
    JOIN pa_clients client ON client.id=project.client_id AND client.projection_source_id=project.projection_source_id AND client.active=1
    LEFT JOIN pa_organizations organization ON organization.id=COALESCE(project.organization_id,client.organization_id)
      AND organization.projection_source_id=project.projection_source_id AND organization.active=1
    WHERE project.projection_source_id=? AND project.active=1 AND ${projectId}=?
      AND ${clientId}=? AND ${projectAlphaReadVisibleSql("project.projection_source_id")}
      AND ((?='standalone_client' AND client.organization_id IS NULL AND project.organization_id IS NULL AND ${clientId}=?)
        OR (?='organization' AND organization.id IS NOT NULL AND client.organization_id=organization.id
          AND (project.organization_id IS NULL OR project.organization_id=organization.id) AND ${organizationId}=?))
    LIMIT 2`).bind(row.catalog_source_id,row.portal_project_public_id,delivery.client_public_id,
      delivery.root_type,delivery.root_public_id,
      delivery.root_type,delivery.root_public_id).all<{project_public_id:string;client_public_id:string;organization_public_id:string|null}>();
  if (rows.results.length !== 1)
    throw new HTTPException(409, { message: "The Project Alpha project does not have one unambiguous active client relationship" });
  const business = rows.results[0]!;
  const authority = { sourceId: row.catalog_source_id, workspaceId: row.portal_workspace_id,
    rootType: delivery.root_type, rootPublicId: delivery.root_public_id, projectPublicId: business.project_public_id,
    projectSourceVersion: delivery.project_source_version, generationId: delivery.generation_id,
    sourceSequence: delivery.source_sequence, portalAuthorityVersion: delivery.portal_authority_version,
    connectorRevision: delivery.connector_revision, connectorVersion: delivery.connector_version,
    clientPublicId: business.client_public_id, organizationPublicId: business.organization_public_id };
  return { ...authority, proof: await sha256Hex(canonicalProjectAlphaJson(authority)) };
}

/** This proof belongs to DELIVERY_DB only, not a cross-database transaction. */
function currentRequestProof(row: RequestRow, native?: NativeDraftAuthority): { sql: string; bindings: (string | number | null)[] } {
  if (row.catalog_source_id !== PRIMARY_ALPHA_SOURCE_ID) {
    if (!native || native.sourceId !== row.catalog_source_id || native.workspaceId !== row.portal_workspace_id
      || native.projectPublicId !== row.portal_project_public_id) throw new Error("native-draft-proof-required");
    return { sql: `WITH RECURSIVE lineage(entity_type,public_id,parent_public_id,depth) AS (
        SELECT project.entity_type,project.public_id,project.parent_public_id,0
        FROM portal_v2_directory_entities project
        JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=project.workspace_id
          AND checkpoint.active_generation_id=project.generation_id
        WHERE project.workspace_id=? AND project.entity_type='project' AND project.public_id=? AND project.active=1
        UNION ALL
        SELECT parent.entity_type,parent.public_id,parent.parent_public_id,lineage.depth+1
        FROM lineage JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=?
        JOIN portal_v2_directory_entities parent ON parent.workspace_id=checkpoint.workspace_id
          AND parent.generation_id=checkpoint.active_generation_id AND parent.public_id=lineage.parent_public_id AND parent.active=1
        WHERE lineage.parent_public_id IS NOT NULL AND lineage.depth<16
          AND (SELECT count(*) FROM portal_v2_directory_entities unique_parent
            WHERE unique_parent.workspace_id=checkpoint.workspace_id AND unique_parent.generation_id=checkpoint.active_generation_id
              AND unique_parent.public_id=lineage.parent_public_id AND unique_parent.active=1)=1
      ) SELECT 1 FROM client_service_requests r
      JOIN portal_v2_workspaces workspace ON workspace.id=r.portal_workspace_id AND workspace.status='active'
        AND workspace.legacy_account_id IS NULL AND workspace.project_alpha_source_id=r.catalog_source_id
      JOIN pa_portal_workspace_sources owner ON owner.workspace_id=workspace.id AND owner.projection_source_id=r.catalog_source_id
      JOIN pa_portal_source_authorities authority ON authority.source_id=r.catalog_source_id AND authority.state='active'
        AND authority.version=? AND authority.connector_revision=? AND authority.connector_version=?
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
        AND checkpoint.active_generation_id=? AND checkpoint.source_sequence=?
      JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
        AND generation.workspace_id=workspace.id AND generation.status='active' AND generation.complete=1
      JOIN portal_v2_directory_entities project ON project.workspace_id=workspace.id AND project.generation_id=checkpoint.active_generation_id
        AND project.entity_type='project' AND project.public_id=r.portal_project_public_id AND project.source_version=? AND project.active=1
      JOIN portal_v2_directory_entities root ON root.workspace_id=workspace.id AND root.generation_id=checkpoint.active_generation_id
        AND root.entity_type=? AND root.public_id=? AND root.active=1
      WHERE r.id=? AND r.catalog_source_id=? AND r.portal_workspace_id=? AND r.portal_project_public_id=? AND r.project_id IS NULL
        AND (SELECT count(*) FROM lineage WHERE entity_type='client')=1
        AND EXISTS(SELECT 1 FROM lineage WHERE entity_type='client' AND public_id=?)
        AND EXISTS(SELECT 1 FROM lineage WHERE entity_type=? AND public_id=?)
        AND r.status IN ('under_review','accepted_pending_pa_linkage') AND r.title=? AND r.details=? AND r.deliverables_text IS ?
        AND COALESCE((SELECT MAX(revision_number) FROM request_revisions WHERE request_id=r.id),0)=?
        AND COALESCE((SELECT MAX(revision_number) FROM client_service_request_area_revisions WHERE request_id=r.id),0)=?
        AND (SELECT estimate.scope_text FROM request_operational_estimates estimate WHERE estimate.request_id=r.id
          AND estimate.status IN ('draft','ready','accepted','change_requested') ORDER BY estimate.version DESC LIMIT 1) IS ?`,
      bindings: [native.workspaceId,native.projectPublicId,native.workspaceId,
        native.portalAuthorityVersion,native.connectorRevision,native.connectorVersion,native.generationId,native.sourceSequence,
        native.projectSourceVersion,native.rootType,native.rootPublicId,
        row.id,row.catalog_source_id,row.portal_workspace_id,row.portal_project_public_id,
        native.clientPublicId,native.rootType,native.rootPublicId,
        row.title,row.details,row.deliverables_text,row.request_revision,row.area_revision || 0,row.scope_text] };
  }
  return {
    sql: `SELECT 1 FROM client_service_requests r
      JOIN client_accounts account ON account.id=r.account_id AND account.status='active'
      LEFT JOIN projects project ON project.id=r.project_id
      WHERE r.id=? AND r.account_id=? AND r.catalog_source_id=?
        AND r.status IN ('under_review','accepted_pending_pa_linkage')
        AND r.project_id IS ? AND account.project_alpha_source_id IS ?
        AND account.project_alpha_client_id IS ? AND account.project_alpha_organization_id IS ?
        AND project.project_alpha_source_id IS ? AND project.project_alpha_project_id IS ?
        AND (r.project_id IS NULL OR (project.active=1 AND EXISTS(SELECT 1 FROM client_project_grants grant_row
          WHERE grant_row.account_id=r.account_id AND grant_row.project_id=r.project_id AND grant_row.revoked_at IS NULL)))
        AND r.title=? AND r.details=? AND r.deliverables_text IS ?
        AND COALESCE((SELECT MAX(revision_number) FROM request_revisions WHERE request_id=r.id),0)=?
        AND COALESCE((SELECT MAX(revision_number) FROM client_service_request_area_revisions WHERE request_id=r.id),0)=?
        AND (SELECT estimate.scope_text FROM request_operational_estimates estimate WHERE estimate.request_id=r.id
          AND estimate.status IN ('draft','ready','accepted','change_requested') ORDER BY estimate.version DESC LIMIT 1) IS ?`,
    bindings: [row.id,row.account_id,row.catalog_source_id,row.portal_project_id,row.account_source_id,
      row.project_alpha_client_id,row.project_alpha_organization_id,row.project_source_id,row.project_alpha_project_id,
      row.title,row.details,row.deliverables_text,row.request_revision,row.area_revision || 0,row.scope_text],
  };
}

async function reserveQuoteCommand(env: Env, row: RequestRow, target: QuoteDestination,
  payload: string, payloadHash: string, idempotencyKey: string, actorId: string,
  native?: NativeDraftAuthority, connectorProof?: ProjectAlphaConnectorProof | null): Promise<QuoteCommandRow> {
  if (await hasUnresolvedOtherCommand(env, row))
    throw new ProjectAlphaDraftQuoteError(409, "reconciliation_required", reconcileMessage);
  const read = () => database(env).prepare(`SELECT * FROM request_pa_draft_quote_commands
    WHERE request_id=? AND request_revision=? AND area_revision=?`)
    .bind(row.id,row.request_revision,row.area_revision || 0).first<QuoteCommandRow>();
  const validate = (command: QuoteCommandRow): QuoteCommandRow => {
    if (command.source_id !== target.sourceId || command.command_endpoint !== target.commandEndpoint ||
      command.application_key !== target.applicationKey || command.editor_origin !== target.editorOrigin ||
      command.destination_fingerprint !== target.destinationFingerprint)
      throw new ProjectAlphaDraftQuoteError(409,"destination_changed","The quote destination changed; reconcile the saved command before retrying");
    if (command.idempotency_key !== idempotencyKey || command.payload_hash !== payloadHash || command.payload_json !== payload)
      throw new ProjectAlphaDraftQuoteError(409,"idempotency_conflict","This quote revision already has a different saved command");
    return command;
  };
  const existing = await read(); if (existing) return validate(existing);
  if (connectorProof) await assertProjectAlphaConnectorProof(env, connectorProof);
  const proof=currentRequestProof(row,native),id=crypto.randomUUID();
  try {
    const result=await database(env).prepare(`INSERT INTO request_pa_draft_quote_commands
      (id,request_id,request_revision,area_revision,source_id,command_endpoint,application_key,editor_origin,
       destination_fingerprint,idempotency_key,payload_hash,payload_json,created_by)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(${proof.sql}) AND NOT EXISTS(${unresolvedOtherCommandSql})`)
      .bind(id,row.id,row.request_revision,row.area_revision || 0,target.sourceId,target.commandEndpoint,target.applicationKey,
        target.editorOrigin,target.destinationFingerprint,idempotencyKey,payloadHash,payload,actorId,...proof.bindings,
        row.id,row.request_revision,row.area_revision || 0).run();
    if(result.meta.changes!==1) throw new ProjectAlphaDraftQuoteError(409,"scope_denied","The request changed before the quote command could be saved");
  } catch (error) {
    if (await hasUnresolvedOtherCommand(env, row))
      throw new ProjectAlphaDraftQuoteError(409, "reconciliation_required", reconcileMessage);
    const winner=await read(); if(winner)return validate(winner);
    if(error instanceof ProjectAlphaDraftQuoteError)throw error;
    throw new ProjectAlphaDraftQuoteError(503,"integration_unavailable","The quote command could not be saved; nothing was sent");
  }
  const saved=await read();
  if(!saved)throw new ProjectAlphaDraftQuoteError(503,"integration_unavailable","The saved quote command could not be verified; nothing was sent");
  if (connectorProof) await assertProjectAlphaConnectorProof(env, connectorProof);
  return validate(saved);
}

async function buildPayload(env: Env, row: RequestRow, draftQuoteSource: string, native?: NativeDraftAuthority): Promise<ProjectAlphaDraftQuotePayload> {
  if (!OPAQUE_PUBLIC_ID.test(row.id))
    throw new HTTPException(409, { message: "This request has an invalid public identifier" });
  const clientPublicId = native?.clientPublicId ?? row.project_alpha_client_id;
  const organizationPublicId = native?.organizationPublicId ?? row.project_alpha_organization_id;
  const projectPublicId = native?.projectPublicId ?? row.project_alpha_project_id;
  if (!clientPublicId || !OPAQUE_PUBLIC_ID.test(clientPublicId))
    throw new HTTPException(409, { message: "This client request is not linked to an authorized Project Alpha client" });
  if (!native &&
    row.portal_project_id !== null &&
    (row.project_authorized !== 1 || !row.project_alpha_project_id)
  ) throw new HTTPException(409, {
    message: "This request is no longer linked to an authorized Project Alpha project",
  });
  for (const optionalId of [organizationPublicId, projectPublicId]) {
    if (optionalId !== null && !OPAQUE_PUBLIC_ID.test(optionalId))
      throw new HTTPException(409, { message: "This request has an invalid Project Alpha authorization link" });
  }
  if (!native) {
    if (row.catalog_source_id !== PRIMARY_ALPHA_SOURCE_ID)
      throw new HTTPException(409, { message: "This request's catalog source has no configured quote connection" });
    const provenance = await provePrimaryBusinessReferences(env, { accountId: row.account_id,
      accountSourceId: row.account_source_id, projectSourceId: row.project_source_id,
      clientId: clientPublicId, organizationId: organizationPublicId, projectId: projectPublicId });
    if (!provenance.available) throw new HTTPException(409, { message: provenance.reason === "unsupported_source"
      ? "unsupported_source: This request's business source has no configured quote connection"
      : "mapping_unavailable: Refresh the primary Alpha business or portal projection before creating this quote" });
  }
  if (row.request_revision < 1)
    throw new HTTPException(409, { message: "This request has no immutable revision to send to Project Alpha" });

  const [serviceResult, attachmentResult] = await Promise.all([
    database(env).prepare(
      `SELECT service_source_id,service_public_id,service_source_version,answers_json
       FROM client_service_request_services WHERE request_id=? ORDER BY ordinal`,
    ).bind(row.id).all<ServiceRow>(),
    database(env).prepare(
      `SELECT original_name,content_type,actual_size,verified_sha256
       FROM client_service_request_attachments
       WHERE submitted_request_id=? AND status='accepted'
       ORDER BY created_at,id`,
    ).bind(row.id).all<AttachmentRow>(),
  ]);
  if (!serviceResult.results.length)
    throw new HTTPException(409, {
      message: "This request predates Project Alpha catalog selection; use the manual Project Alpha quote fallback",
    });
  if (serviceResult.results.length > 10 || attachmentResult.results.length > 10)
    throw new HTTPException(409, { message: "This request exceeds the Project Alpha draft command bounds" });
  if (serviceResult.results.some(service => service.service_source_id !== row.catalog_source_id))
    throw new HTTPException(409, { message: "This request contains services from an inconsistent catalog source" });

  let workArea;
  try {
    workArea = parseStoredWorkArea(
      row.area_revision === null ? row.area_geojson : row.effective_area_geojson,
      row.area_revision === null ? row.poi_points_json : row.effective_poi_points_json,
    );
  } catch {
    throw new HTTPException(409, { message: "The effective work area is invalid" });
  }
  const areaJson = canonicalProjectAlphaJson(workArea);
  const squareMeters = polygonSquareMeters(workArea.areaGeoJson);
  const payload: ProjectAlphaDraftQuotePayload = {
    schemaVersion: 1,
    source: draftQuoteSource,
    request: {
      publicId: row.id,
      revision: row.request_revision,
      title: row.title.slice(0, 160),
      scopeSummary: (row.scope_text || row.details).slice(0, 5_000),
      deliverablesSummary: row.deliverables_text?.slice(0, 2_000) || null,
    },
    authorization: {
      organizationPublicId,
      clientPublicId,
      projectPublicId,
    },
    services: serviceResult.results.map(service => {
      if (!OPAQUE_PUBLIC_ID.test(service.service_public_id) || !SAFE_PUBLIC_ID.test(service.service_source_version))
        throw new HTTPException(409, { message: "A selected Project Alpha service identifier is invalid" });
      return {
        publicId: service.service_public_id,
        catalogVersion: service.service_source_version,
        answers: parseAnswers(service.answers_json),
      };
    }),
    workArea: {
      revision: row.area_revision || 0,
      hash: await sha256Hex(areaJson),
      squareMeters: finiteRounded(squareMeters, 3),
      acres: finiteRounded(squareMeters === null ? null : squareMeters / SQUARE_METERS_PER_ACRE, 6),
    },
    attachments: attachmentResult.results.map(attachment => {
      if (
        !Number.isSafeInteger(attachment.actual_size) || attachment.actual_size < 1 ||
        !/^[a-f0-9]{64}$/.test(attachment.verified_sha256) ||
        attachment.original_name.length > 255 || attachment.content_type.length > 100
      ) throw new HTTPException(409, { message: "An accepted attachment has invalid verification metadata" });
      return {
        name: attachment.original_name,
        contentType: attachment.content_type,
        sizeBytes: attachment.actual_size,
        sha256: attachment.verified_sha256,
      };
    }),
  };
  if (new TextEncoder().encode(canonicalProjectAlphaJson(payload)).byteLength > MAX_COMMAND_BYTES)
    throw new HTTPException(409, { message: "This request is too large for the Project Alpha draft command" });
  return payload;
}

export function registerProjectAlphaDraftQuoteRoutes(app: App): void {
  app.get("/api/client-service-requests/:id/pa-draft", async c => {
    await requireOperationsManage(c.env, c.get("principal"));
    const requestId = c.req.param("id");
    const request = await requestForDraft(c.env, requestId);
    if (!request) throw new HTTPException(404, { message: "Client request not found" });
    c.header("Cache-Control", "no-store");
    const primarySource = request.catalog_source_id === PRIMARY_ALPHA_SOURCE_ID;
    let receipt: ReceiptRow | null = null;
    let receiptAuthorityProven = primarySource;
    let capability = primarySource
      ? projectAlphaDraftQuoteCapability(c.env) : { enabled: c.env.PROJECT_ALPHA_DRAFT_QUOTES_ENABLED === "true", reason: null as string | null };
    if (!primarySource && (!request.portal_workspace_id || !request.portal_project_public_id)) {
      capability = { enabled: false, reason: "This request's catalog source has no configured quote connection" };
    } else if (capability.enabled) {
      try {
        const runtime = await quoteRuntime(c.env, request.catalog_source_id);
        const native = runtime.connectorProof ? await resolveNativeDraftAuthority(c.env, request, runtime.connectorProof) : undefined;
        await buildPayload(c.env, request, runtime.draftQuoteSource, native);
        receiptAuthorityProven = true;
        if (!["under_review", "accepted_pending_pa_linkage"].includes(request.status))
          capability = { enabled: false, reason: "Review or accept the request before creating a Project Alpha draft" };
        else if (await hasUnresolvedOtherCommand(c.env, request))
          capability = { enabled: false, reason: reconcileMessage };
      } catch (error) {
        if (error instanceof HTTPException || error instanceof ProjectAlphaDraftQuoteError)
          capability = { enabled: false, reason: error.message };
        else throw error;
      }
    }
    if (receiptAuthorityProven)
      receipt = await latestReceipt(c.env, requestId, request.catalog_source_id);
    c.header("Cache-Control", "no-store");
    return c.json({
      capability,
      receipt: receipt ? receiptResponse(receipt) : null,
    });
  });

  app.post("/api/client-service-requests/:id/pa-draft", async c => {
    const principal = c.get("principal");
    await requireOperationsManage(c.env, principal);
    const requestId = c.req.param("id");
    const request = await requestForDraft(c.env, requestId);
    if (!request) throw new HTTPException(404, { message: "Client request not found" });
    if (c.env.PROJECT_ALPHA_DRAFT_QUOTES_ENABLED !== "true")
      return c.json({ error: "Project Alpha draft creation is not enabled", code: "integration_disabled" }, 503);
    if (request.catalog_source_id !== PRIMARY_ALPHA_SOURCE_ID &&
      (!request.portal_workspace_id || !request.portal_project_public_id))
      throw new HTTPException(409, { message: "This request's catalog source has no configured quote connection" });
    if (!["under_review", "accepted_pending_pa_linkage"].includes(request.status))
      throw new HTTPException(409, { message: "Review or accept the request before creating a Project Alpha draft" });

    let runtime: QuoteRuntime;
    let native: NativeDraftAuthority | undefined;
    try {
      runtime = await quoteRuntime(c.env, request.catalog_source_id);
      native = runtime.connectorProof ? await resolveNativeDraftAuthority(c.env, request, runtime.connectorProof) : undefined;
    } catch (error) {
      if (error instanceof ProjectAlphaDraftQuoteError)
        return c.json({ error: error.message, code: error.code }, error.status);
      throw error;
    }
    const payload = await buildPayload(c.env, request, runtime.draftQuoteSource, native);
    const rawPayload = canonicalProjectAlphaJson(payload);
    const payloadHash = await sha256Hex(rawPayload);
    const areaRevision = request.area_revision || 0;
    const idempotencyKey = projectAlphaDraftIdempotencyKey(
      request.id,
      request.request_revision,
      areaRevision,
    );
    c.header("Cache-Control", "no-store");
    const existing = await exactReceipt(c.env, requestId, request.catalog_source_id,
      request.request_revision, areaRevision);
    if (existing) {
      if (existing.source_id !== request.catalog_source_id || existing.payload_hash !== payloadHash || existing.idempotency_key !== idempotencyKey)
        return c.json({ error: "This Project Alpha draft revision has a conflicting recorded payload", code: "idempotency_conflict" }, 409);
      if (existing.scope_stale_at)
        return c.json({ error: "This Project Alpha draft was created for an obsolete request scope and must be reconciled in Project Alpha", code: "scope_changed" }, 409);
      // A historical receipt has no verified origin. Do not manufacture a
      // journal or resend it just because configuration has changed since then.
      return c.json({ ...receiptResponse(existing), idempotentReplay: true });
    }

    let result: ProjectAlphaDraftQuoteResult;
    let command: QuoteCommandRow;
    try {
      const destination = runtime.destination;
      command = await reserveQuoteCommand(c.env, request, destination, rawPayload, payloadHash, idempotencyKey, principal.id,
        native, runtime.connectorProof);
      await requireOperationsManage(c.env, principal);
      // Reservation is durable before the first network call. Check the current
      // authority and content again after that await; never dispatch stale data.
      const current = await requestForDraft(c.env, requestId);
      const currentRuntime = await quoteRuntime(c.env, request.catalog_source_id);
      if (canonicalProjectAlphaJson(currentRuntime.destination) !== canonicalProjectAlphaJson(destination)
        || canonicalProjectAlphaJson(currentRuntime.connectorProof) !== canonicalProjectAlphaJson(runtime.connectorProof))
        throw new ProjectAlphaDraftQuoteError(409, "destination_changed", "The quote destination changed before the saved command could be sent");
      const currentNative = current && currentRuntime.connectorProof
        ? await resolveNativeDraftAuthority(c.env, current, currentRuntime.connectorProof) : undefined;
      if (!current || !["under_review", "accepted_pending_pa_linkage"].includes(current.status) ||
        canonicalProjectAlphaJson(currentRequestProof(current,currentNative).bindings) !== canonicalProjectAlphaJson(currentRequestProof(request,native).bindings) ||
        canonicalProjectAlphaJson(await buildPayload(c.env, current,currentRuntime.draftQuoteSource,currentNative)) !== rawPayload)
        throw new ProjectAlphaDraftQuoteError(409, "scope_denied", "The request changed before the saved quote command could be sent");
      result = await sendProjectAlphaDraftQuoteCommand(c.env, payload, idempotencyKey, {
        sourceId: request.catalog_source_id, destination,
      });
    } catch (error) {
      if (error instanceof ProjectAlphaDraftQuoteError)
        return c.json({ error: error.message, code: error.code }, error.status);
      throw error;
    }

    // A remote side effect cannot be rolled back with D1. Record its receipt
    // even if local scope changed, but quarantine it from ordinary use.
    let scopeCurrent = false;
    try {
      await requireOperationsManage(c.env, principal);
      const current = await requestForDraft(c.env, requestId);
      const currentRuntime = await quoteRuntime(c.env, request.catalog_source_id);
      const currentNative = current && currentRuntime.connectorProof
        ? await resolveNativeDraftAuthority(c.env, current, currentRuntime.connectorProof) : undefined;
      scopeCurrent = !!current && ["under_review", "accepted_pending_pa_linkage"].includes(current.status) &&
        canonicalProjectAlphaJson(currentRuntime.destination) === canonicalProjectAlphaJson(runtime.destination) &&
        canonicalProjectAlphaJson(currentRuntime.connectorProof) === canonicalProjectAlphaJson(runtime.connectorProof) &&
        canonicalProjectAlphaJson(currentRequestProof(current,currentNative).bindings) === canonicalProjectAlphaJson(currentRequestProof(request,native).bindings) &&
        canonicalProjectAlphaJson(await buildPayload(c.env, current,currentRuntime.draftQuoteSource,currentNative)) === rawPayload;
    } catch { /* Unverifiable authority is stale, never permission to use a quote. */ }
    const receiptId = crypto.randomUUID(), proof = currentRequestProof(request,native);
    const details = JSON.stringify({ sourceId: command.source_id, commandId: command.id,
      requestRevision: request.request_revision, areaRevision, payloadHash,
      projectAlphaReceiptId: result.receiptId, projectAlphaDraftPublicId: result.draftQuote.publicId });
    let saved: ReceiptRow | null;
    try {
      const db = database(c.env);
      await db.batch([
        db.prepare(
          `INSERT INTO request_pa_draft_quote_receipts
            (id,request_id,request_revision,area_revision,idempotency_key,payload_hash,
             project_alpha_receipt_id,project_alpha_artifact_public_id,document_number,
             artifact_status,artifact_version,editor_path,created_by,source_id,command_id,scope_stale_at)
           VALUES (?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,
             CASE WHEN ?=1 AND EXISTS(${proof.sql}) THEN NULL ELSE datetime('now') END)`,
        ).bind(
          receiptId, requestId, request.request_revision, areaRevision, idempotencyKey, payloadHash,
          result.receiptId, result.draftQuote.publicId, result.draftQuote.documentNumber,
          result.draftQuote.version, result.draftQuote.editorPath, principal.id, command.source_id, command.id,
          scopeCurrent ? 1 : 0, ...proof.bindings,
        ),
        db.prepare(
          `INSERT INTO request_admin_audit(request_id,actor_id,action,details_json)
           SELECT request_id,?,CASE WHEN scope_stale_at IS NULL THEN 'pa_draft_quote_created'
             ELSE 'pa_draft_quote_scope_stale' END,? FROM request_pa_draft_quote_receipts WHERE id=?`,
        ).bind(principal.id, details, receiptId),
        db.prepare(
          `INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json)
           SELECT 'staff',?,CASE WHEN scope_stale_at IS NULL THEN 'client.service_request.pa_draft_quote_created'
             ELSE 'client.service_request.pa_draft_quote_scope_stale' END,'client_service_request',request_id,?
           FROM request_pa_draft_quote_receipts WHERE id=?`,
        ).bind(principal.id, details, receiptId),
        db.prepare(
          `INSERT INTO client_portal_notification_outbox
            (id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json)
           SELECT ?,request_id,'pa_draft_quote_created',NULL,?,?,?
             FROM request_pa_draft_quote_receipts WHERE id=? AND scope_stale_at IS NULL
               AND EXISTS(${proof.sql})
           ON CONFLICT(request_id,dedupe_key) DO NOTHING`,
        ).bind(crypto.randomUUID(),native?'native_request_owner':'client_requester',`pa_draft_quote_created:${receiptId}:${native?'native_request_owner':'client_requester'}`,JSON.stringify({ lifecycle:'accepted_linked',action:'open_client_portal',title:request.title,projectId:null,projectName:null,serviceCategory:null,locationLabel:null }),receiptId,...proof.bindings),
      ]);
      saved = await exactReceipt(c.env, requestId, request.catalog_source_id,
        request.request_revision, areaRevision);
    } catch {
      const raced = await exactReceipt(c.env, requestId, request.catalog_source_id,
        request.request_revision, areaRevision);
      if (!raced)
        return c.json({ error: "Project Alpha may have created the draft, but its receipt could not be saved. Retry the saved command to reconcile it.", code: "receipt_unconfirmed" }, 503);
      if (raced.command_id !== command.id || raced.source_id !== command.source_id ||
        raced.payload_hash !== payloadHash || raced.idempotency_key !== idempotencyKey ||
        canonicalProjectAlphaJson(resultFromReceipt(raced)) !== canonicalProjectAlphaJson(result))
        return c.json({ error: "The Project Alpha draft receipt conflicts with its saved command", code: "receipt_conflict" }, 409);
      let winnerAuthorized = scopeCurrent;
      try {
        await requireOperationsManage(c.env, principal);
        winnerAuthorized = winnerAuthorized && !!await database(c.env).prepare(proof.sql).bind(...proof.bindings).first();
      } catch { winnerAuthorized = false; }
      if (!winnerAuthorized || raced.scope_stale_at)
        return c.json({ error: "This Project Alpha draft was created for an obsolete request scope and must be reconciled in Project Alpha", code: "scope_changed" }, 409);
      return c.json({ ...receiptResponse(raced), idempotentReplay: true });
    }
    if (!saved)
      return c.json({ error: "The saved draft receipt could not be verified. Retry the saved command to reconcile it.", code: "receipt_unconfirmed" }, 503);
    if (saved.scope_stale_at)
      return c.json({ error: "The request scope changed while Project Alpha created the draft. Its receipt was saved as stale and must be reconciled before use.", code: "scope_changed" }, 409);

    c.executionCtx.waitUntil(
      (async () => c.env.OPS_DB.batch([
        await auditStatement(
          c.env, c.req.raw, principal,
          "client.service_request.pa_draft_quote_created",
          "client_service_request", requestId, null,
          {
            sourceId: command.source_id,
            commandId: command.id,
            requestRevision: request.request_revision,
            areaRevision,
            payloadHash,
            projectAlphaReceiptId: result.receiptId,
            projectAlphaDraftPublicId: result.draftQuote.publicId,
          },
        ),
      ]))().catch(error => console.error(JSON.stringify({
        event: "secondary_ops_audit_failed",
        requestId,
        action: "client.service_request.pa_draft_quote_created",
        error: "audit_write_failed",
      }))),
    );
    return c.json({ ...receiptResponse(saved), idempotentReplay: false }, 201);
  });
}
