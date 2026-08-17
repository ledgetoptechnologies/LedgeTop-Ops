import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { sqlScope } from "./acl";
import { auditStatement } from "./request-security";
import { parseStoredWorkArea, type StaffRequestArea } from "./request-area-revision";
import type { Env, StaffPrincipal } from "./types";

type AppEnv = {
  Bindings: Env;
  Variables: { principal: StaffPrincipal; administrator: boolean };
};
type App = Hono<AppEnv>;

const COMMAND_SCOPE = "portal.quote-draft.create";
const COMMAND_TIMEOUT_MS = 8_000;
const MAX_COMMAND_BYTES = 96 * 1024;
const SQUARE_METERS_PER_ACRE = 4_046.8564224;
const EARTH_RADIUS_METERS = 6_371_008.8;
const SAFE_PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPAQUE_PUBLIC_ID = /^(?=.{1,128}$)(?=.*[A-Za-z])[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const commandPath = (applicationKey: string): string => `/api/v2/integrations/${encodeURIComponent(applicationKey)}/draft-quotes`;
const SHA256_HEX = /^[a-f0-9]{64}$/;

interface RequestRow {
  id: string;
  status: string;
  title: string;
  details: string;
  deliverables_text: string | null;
  project_alpha_client_id: string | null;
  project_alpha_organization_id: string | null;
  project_alpha_project_id: string | null;
  portal_project_id: string | null;
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
  source: "ltds-operations";
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
const projectAlphaDraftQuotePayloadSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("ltds-operations"),
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
    readonly code: "integration_disabled" | "integration_unavailable" | "idempotency_conflict" | "stale_catalog" | "scope_denied" | "invalid_response",
    message: string,
  ) {
    super(message);
    this.name = "ProjectAlphaDraftQuoteError";
  }
}

function database(env: Env): D1Database {
  const candidate = env.DELIVERY_DB as D1Database & {
    withSession?: (consistency: "first-primary") => D1Database;
  };
  return typeof candidate.withSession === "function"
    ? candidate.withSession("first-primary")
    : env.DELIVERY_DB;
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
  const local = ["localhost", "127.0.0.1", "::1"].includes(base.hostname);
  if ((base.protocol !== "https:" && !(local && base.protocol === "http:")) || base.username || base.password)
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

function editorUrl(env: Env, path: string): string | null {
  try {
    const base = new URL(env.PROJECT_ALPHA_BASE_URL);
    if (base.protocol !== "https:" || base.username || base.password) return null;
    const resolved = new URL(path, base);
    return resolved.origin === base.origin ? resolved.toString() : null;
  } catch {
    return null;
  }
}

function receiptResponse(env: Env, row: ReceiptRow) {
  return {
    requestRevision: row.request_revision,
    areaRevision: row.area_revision,
    createdAt: row.created_at,
    editorUrl: editorUrl(env, row.editor_path),
    ...resultFromReceipt(row),
  };
}

export async function sendProjectAlphaDraftQuoteCommand(
  env: Env,
  payload: ProjectAlphaDraftQuotePayload,
  idempotencyKey: string,
  options: { now?: Date; fetcher?: typeof fetch } = {},
): Promise<ProjectAlphaDraftQuoteResult> {
  const configuration = integrationConfiguration(env);
  if (!configuration)
    throw new ProjectAlphaDraftQuoteError(503, "integration_disabled", "Project Alpha draft creation is not available");
  const validatedPayload = parseProjectAlphaDraftQuotePayload(payload);
  if (!validatedPayload)
    throw new ProjectAlphaDraftQuoteError(409, "invalid_response", "The Project Alpha draft command is invalid");
  const rawBody = canonicalProjectAlphaJson(validatedPayload);
  if (new TextEncoder().encode(rawBody).byteLength > MAX_COMMAND_BYTES)
    throw new ProjectAlphaDraftQuoteError(409, "invalid_response", "The Project Alpha draft command is too large");
  const bodyHash = await sha256Hex(rawBody);
  const timestamp = (options.now ?? new Date()).toISOString();
  const signatureInput = `${timestamp}\nPOST\n${commandPath(configuration.applicationKey)}\n${idempotencyKey}\n${bodyHash}`;
  const signature = await hmacHex(configuration.signingSecret, signatureInput);
  let response: Response;
  try {
    response = await (options.fetcher ?? globalThis.fetch)(configuration.url.toString(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${configuration.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "X-Portal-Integration-Application-Key": configuration.applicationKey,
        "X-Portal-Integration-Body-SHA256": bodyHash,
        "X-Portal-Integration-Signature": `sha256=${signature}`,
        "X-Portal-Integration-Timestamp": timestamp,
      },
      body: rawBody,
      // Cloudflare Workers rejects redirect:"error"; manual prevents the
      // signed request from following a destination-controlled Location.
      redirect: "manual",
      signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
    });
  } catch {
    throw new ProjectAlphaDraftQuoteError(503, "integration_unavailable", "Project Alpha did not accept the draft command; retry is safe");
  }
  if (!response.ok) {
    const parsed = errorSchema.safeParse(await response.json().catch(() => null));
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
        ? "Project Alpha could not create the draft; retry is safe"
        : "Project Alpha rejected the draft command",
    );
  }
  const parsed = parseProjectAlphaDraftQuoteResult(await response.json().catch(() => null));
  if (!parsed)
    throw new ProjectAlphaDraftQuoteError(502, "invalid_response", "Project Alpha returned an invalid draft receipt");
  return parsed;
}

async function requestForDraft(env: Env, requestId: string): Promise<RequestRow | null> {
  return database(env).prepare(
    `SELECT r.id,r.status,r.title,r.details,r.deliverables_text,
      account.project_alpha_client_id,account.project_alpha_organization_id,
      project.project_alpha_project_id,r.project_id portal_project_id,
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
     JOIN client_accounts account ON account.id=r.account_id AND account.status='active'
     LEFT JOIN projects project ON project.id=r.project_id
     LEFT JOIN client_service_request_area_revisions effective ON effective.request_id=r.id
       AND effective.revision_number=(SELECT MAX(candidate.revision_number)
         FROM client_service_request_area_revisions candidate WHERE candidate.request_id=r.id)
     WHERE r.id=?`,
  ).bind(requestId).first<RequestRow>();
}

async function latestReceipt(env: Env, requestId: string): Promise<ReceiptRow | null> {
  return database(env).prepare(
    `SELECT request_revision,area_revision,idempotency_key,payload_hash,
      project_alpha_receipt_id,project_alpha_artifact_public_id,document_number,
      artifact_status,artifact_version,editor_path,scope_stale_at,created_at
     FROM request_pa_draft_quote_receipts WHERE request_id=? AND scope_stale_at IS NULL
     ORDER BY request_revision DESC,area_revision DESC,created_at DESC LIMIT 1`,
  ).bind(requestId).first<ReceiptRow>();
}

async function buildPayload(env: Env, row: RequestRow): Promise<ProjectAlphaDraftQuotePayload> {
  if (!OPAQUE_PUBLIC_ID.test(row.id))
    throw new HTTPException(409, { message: "This request has an invalid public identifier" });
  if (!row.project_alpha_client_id || !OPAQUE_PUBLIC_ID.test(row.project_alpha_client_id))
    throw new HTTPException(409, { message: "This client request is not linked to an authorized Project Alpha client" });
  if (
    row.portal_project_id !== null &&
    (row.project_authorized !== 1 || !row.project_alpha_project_id)
  ) throw new HTTPException(409, {
    message: "This request is no longer linked to an authorized Project Alpha project",
  });
  for (const optionalId of [row.project_alpha_organization_id, row.project_alpha_project_id]) {
    if (optionalId !== null && !OPAQUE_PUBLIC_ID.test(optionalId))
      throw new HTTPException(409, { message: "This request has an invalid Project Alpha authorization link" });
  }
  if (row.request_revision < 1)
    throw new HTTPException(409, { message: "This request has no immutable revision to send to Project Alpha" });

  const [serviceResult, attachmentResult] = await Promise.all([
    database(env).prepare(
      `SELECT service_public_id,service_source_version,answers_json
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
    source: "ltds-operations",
    request: {
      publicId: row.id,
      revision: row.request_revision,
      title: row.title.slice(0, 160),
      scopeSummary: (row.scope_text || row.details).slice(0, 5_000),
      deliverablesSummary: row.deliverables_text?.slice(0, 2_000) || null,
    },
    authorization: {
      organizationPublicId: row.project_alpha_organization_id,
      clientPublicId: row.project_alpha_client_id,
      projectPublicId: row.project_alpha_project_id,
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
    const receipt = await latestReceipt(c.env, requestId);
    return c.json({
      capability: projectAlphaDraftQuoteCapability(c.env),
      receipt: receipt ? receiptResponse(c.env, receipt) : null,
    });
  });

  app.post("/api/client-service-requests/:id/pa-draft", async c => {
    const principal = c.get("principal");
    await requireOperationsManage(c.env, principal);
    const capability = projectAlphaDraftQuoteCapability(c.env);
    if (!capability.enabled)
      return c.json({ error: capability.reason, code: "integration_disabled" }, 503);

    const requestId = c.req.param("id");
    const request = await requestForDraft(c.env, requestId);
    if (!request) throw new HTTPException(404, { message: "Client request not found" });
    if (!["under_review", "accepted_pending_pa_linkage"].includes(request.status))
      throw new HTTPException(409, { message: "Review or accept the request before creating a Project Alpha draft" });

    const payload = await buildPayload(c.env, request);
    const rawPayload = canonicalProjectAlphaJson(payload);
    const payloadHash = await sha256Hex(rawPayload);
    const areaRevision = request.area_revision || 0;
    const idempotencyKey = projectAlphaDraftIdempotencyKey(
      request.id,
      request.request_revision,
      areaRevision,
    );
    const existing = await database(c.env).prepare(
      `SELECT request_revision,area_revision,idempotency_key,payload_hash,
        project_alpha_receipt_id,project_alpha_artifact_public_id,document_number,
        artifact_status,artifact_version,editor_path,scope_stale_at,created_at
       FROM request_pa_draft_quote_receipts
       WHERE request_id=? AND request_revision=? AND area_revision=?`,
    ).bind(requestId, request.request_revision, areaRevision).first<ReceiptRow>();
    if (existing) {
      if (existing.payload_hash !== payloadHash || existing.idempotency_key !== idempotencyKey)
        return c.json({ error: "This Project Alpha draft revision has a conflicting recorded payload", code: "idempotency_conflict" }, 409);
      if (existing.scope_stale_at)
        return c.json({ error: "This Project Alpha draft was created for an obsolete request scope and must be reconciled in Project Alpha", code: "scope_changed" }, 409);
      return c.json({ ...receiptResponse(c.env, existing), idempotentReplay: true });
    }

    let result: ProjectAlphaDraftQuoteResult;
    try {
      result = await sendProjectAlphaDraftQuoteCommand(c.env, payload, idempotencyKey);
    } catch (error) {
      if (error instanceof ProjectAlphaDraftQuoteError)
        return c.json({ error: error.message, code: error.code }, error.status);
      throw error;
    }

    const receiptId = crypto.randomUUID();
    try {
      const receiptInsert = await database(c.env).prepare(
          `INSERT INTO request_pa_draft_quote_receipts
            (id,request_id,request_revision,area_revision,idempotency_key,payload_hash,
             project_alpha_receipt_id,project_alpha_artifact_public_id,document_number,
             artifact_status,artifact_version,editor_path,created_by)
           SELECT ?,?,?,?,?,?,?,?,?,'draft',?,?,? WHERE EXISTS (
             SELECT 1 FROM client_service_requests current_request
             WHERE current_request.id=? AND current_request.status IN ('under_review','accepted_pending_pa_linkage')
               AND COALESCE((SELECT MAX(revision_number) FROM request_revisions WHERE request_id=current_request.id),0)=?
               AND COALESCE((SELECT MAX(revision_number) FROM client_service_request_area_revisions WHERE request_id=current_request.id),0)=?
           )`,
        ).bind(
          receiptId, requestId, request.request_revision, areaRevision, idempotencyKey, payloadHash,
          result.receiptId, result.draftQuote.publicId, result.draftQuote.documentNumber,
          result.draftQuote.version, result.draftQuote.editorPath, principal.id,
          requestId,request.request_revision,areaRevision,
        ).run();
      if (receiptInsert.meta.changes !== 1) {
        await database(c.env).batch([
          database(c.env).prepare(`INSERT INTO request_pa_draft_quote_receipts
            (id,request_id,request_revision,area_revision,idempotency_key,payload_hash,
             project_alpha_receipt_id,project_alpha_artifact_public_id,document_number,
             artifact_status,artifact_version,editor_path,scope_stale_at,created_by)
            VALUES (?,?,?,?,?,?,?,?,?,'draft',?,?,datetime('now'),?)`)
            .bind(receiptId,requestId,request.request_revision,areaRevision,idempotencyKey,payloadHash,
              result.receiptId,result.draftQuote.publicId,result.draftQuote.documentNumber,
              result.draftQuote.version,result.draftQuote.editorPath,principal.id),
          database(c.env).prepare(`INSERT INTO request_admin_audit(request_id,actor_id,action,details_json)
            VALUES (?,?,'pa_draft_quote_scope_stale',?)`).bind(requestId,principal.id,JSON.stringify({
              requestRevision:request.request_revision,areaRevision,payloadHash,
              projectAlphaReceiptId:result.receiptId,projectAlphaDraftPublicId:result.draftQuote.publicId,
            })),
        ]);
        return c.json({
          error:"The request scope changed while Project Alpha created the draft. The remote draft was recorded as stale and must be reconciled before use.",
          code:"scope_changed",
        },409);
      }
      await database(c.env).batch([
        database(c.env).prepare(
          `INSERT INTO request_admin_audit(request_id,actor_id,action,details_json)
           VALUES (?,?,'pa_draft_quote_created',?)`,
        ).bind(requestId, principal.id, JSON.stringify({
          requestRevision: request.request_revision,
          areaRevision,
          payloadHash,
          projectAlphaReceiptId: result.receiptId,
          projectAlphaDraftPublicId: result.draftQuote.publicId,
        })),
        database(c.env).prepare(
          `INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json)
           VALUES ('staff',?,'client.service_request.pa_draft_quote_created','client_service_request',?,?)`,
        ).bind(principal.id, requestId, JSON.stringify({
          requestRevision: request.request_revision,
          areaRevision,
          payloadHash,
          projectAlphaReceiptId: result.receiptId,
          projectAlphaDraftPublicId: result.draftQuote.publicId,
        })),
      ]);
    } catch {
      const raced = await database(c.env).prepare(
        `SELECT request_revision,area_revision,idempotency_key,payload_hash,
          project_alpha_receipt_id,project_alpha_artifact_public_id,document_number,
          artifact_status,artifact_version,editor_path,scope_stale_at,created_at
         FROM request_pa_draft_quote_receipts
         WHERE request_id=? AND request_revision=? AND area_revision=?`,
      ).bind(requestId, request.request_revision, areaRevision).first<ReceiptRow>();
      if (!raced || raced.payload_hash !== payloadHash || raced.idempotency_key !== idempotencyKey)
        return c.json({ error: "The Project Alpha draft receipt could not be recorded safely", code: "receipt_conflict" }, 409);
      if (raced.scope_stale_at)
        return c.json({ error: "This Project Alpha draft was created for an obsolete request scope and must be reconciled in Project Alpha", code: "scope_changed" }, 409);
      return c.json({ ...receiptResponse(c.env, raced), idempotentReplay: true });
    }

    c.executionCtx.waitUntil(
      (async () => c.env.OPS_DB.batch([
        await auditStatement(
          c.env, c.req.raw, principal,
          "client.service_request.pa_draft_quote_created",
          "client_service_request", requestId, null,
          {
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
        error: error instanceof Error ? error.message : "unknown",
      }))),
    );
    return c.json({
      requestRevision: request.request_revision,
      areaRevision,
      createdAt: new Date().toISOString(),
      editorUrl: editorUrl(c.env, result.draftQuote.editorPath),
      ...result,
      idempotentReplay: false,
    }, 201);
  });
}
