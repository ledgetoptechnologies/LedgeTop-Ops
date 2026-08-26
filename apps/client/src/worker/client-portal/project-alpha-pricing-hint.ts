import { z } from "zod";
import { createCatalogSourceContext, PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";
import { localOrPrimaryAlphaReference, primaryAlphaReference } from "./project-alpha-source";
import type { Env } from "../types";
import type { ClientPricingHint, ClientPricingHintInput, ClientPricingHintProvider } from "./types";
import type { EffectivePortalWorkspaceContext } from "./workspace-v2";

const PRICING_SCOPE = "portal.pricing.preview";
const PRICING_TIMEOUT_MS = 4_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const REQUIRED_DISCLAIMER = "Planning guidance only. Final quote after staff review.";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPAQUE_PA_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MONEY = /^(?:0|[1-9][0-9]{0,10})\.[0-9]{2}$/;
const pricingPath = (applicationKey: string): string => `/api/v2/integrations/${encodeURIComponent(applicationKey)}/pricing-hints`;

export const projectAlphaPricingRequestSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("ltds-client-portal"),
  scope: z.literal("portal.pricing.preview"),
  authorizationContext: z.object({
    workspaceRoot: z.object({
      type: z.enum(["organization", "standalone_client"]),
      publicId: z.string().min(1).max(128).regex(OPAQUE_PA_ID).refine(value => !/^\d+$/.test(value)),
    }).strict(),
    projectPublicId: z.string().min(1).max(128).regex(OPAQUE_PA_ID).refine(value => !/^\d+$/.test(value)),
  }).strict(),
  coverageSquareMetres: z.string().regex(/^(?:0|[1-9][0-9]{0,14})\.[0-9]{6}$/),
  services: z.array(z.object({
    publicId: z.string().min(1).max(128).regex(SAFE_ID),
    sourceVersion: z.string().min(1).max(128).regex(SAFE_ID),
  }).strict()).min(1).max(10),
}).strict();

const responseSchema = z.object({
  schemaVersion: z.literal(1),
  catalogVersion: z.string().min(1).max(128).regex(SAFE_ID),
  coverageSquareMetres: z.string().regex(/^(?:0|[1-9][0-9]{0,14})\.[0-9]{6}$/),
  displayMode: z.enum(["none", "starting_at", "typical_range"]),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  startingAt: z.string().regex(MONEY).nullable(),
  typicalMinimum: z.string().regex(MONEY).nullable(),
  typicalMaximum: z.string().regex(MONEY).nullable(),
  reasonUnavailable: z.string().trim().min(1).max(240).nullable(),
  disclaimer: z.literal(REQUIRED_DISCLAIMER),
  validUntil: z.iso.datetime({ offset: true }),
}).strict();

interface PricingConfiguration {
  url: URL;
  bearer: string;
  hmacSecret: string;
  applicationKey: string;
  allowedCurrencies: ReadonlySet<string>;
}

export interface ProjectAlphaPricingOptions {
  fetcher?: typeof fetch;
  now?: Date;
}

export type ProjectAlphaPricingAuthorizationContextResolver = (
  env: Env,
  workspace: EffectivePortalWorkspaceContext,
  localProjectId: string,
  draft: { id: string; version: number },
) => Promise<Pick<ClientPricingHintInput, "catalogSource" | "authorizationContext"> | null>;

function validOpaquePaId(value: string): boolean {
  return OPAQUE_PA_ID.test(value) && !/^\d+$/.test(value);
}

/**
 * Converts already-authorized LTDS scope into PA public identity. Neither the
 * browser-selected workspace ID nor the local/numeric project ID crosses the
 * integration boundary.
 */
export const resolveProjectAlphaPricingAuthorizationContext: ProjectAlphaPricingAuthorizationContextResolver = async (
  env,
  workspace,
  localProjectId,
  draft,
) => {
  if (!validOpaquePaId(workspace.rootPublicId) || !OPAQUE_PA_ID.test(localProjectId)
    || !draft || !OPAQUE_PA_ID.test(draft.id) || !Number.isSafeInteger(draft.version) || draft.version < 1) return null;
  const database = env.DELIVERY_DB.withSession?.("first-primary") ?? env.DELIVERY_DB;
  const project = await database.prepare(`SELECT project.project_alpha_project_id public_id,
      draft.catalog_source_id, native_workspace.project_alpha_source_id
    FROM projects project
    JOIN client_accounts account ON account.id=? AND account.status='active' AND ${localOrPrimaryAlphaReference("account")}
    JOIN portal_v2_workspaces native_workspace ON native_workspace.id=? AND native_workspace.status='active'
      AND ${primaryAlphaReference("native_workspace")}
      AND native_workspace.legacy_account_id=account.id AND native_workspace.root_type=?
      AND COALESCE(native_workspace.pa_organization_public_id,native_workspace.pa_client_public_id)=?
    JOIN client_project_grants grant_record
      ON grant_record.project_id=project.id AND grant_record.account_id=?
      AND grant_record.revoked_at IS NULL AND grant_record.can_request_service=1
    JOIN client_service_request_drafts draft ON draft.id=? AND draft.version=?
      AND draft.account_id=account.id AND draft.project_id=project.id
      AND draft.catalog_source_id=native_workspace.project_alpha_source_id
      AND draft.catalog_source_id=project.project_alpha_source_id
      AND NOT EXISTS (SELECT 1 FROM client_service_request_draft_services service
        WHERE service.draft_id=draft.id AND service.service_source_id<>draft.catalog_source_id)
    WHERE project.id=? AND project.active=1 AND ${primaryAlphaReference("project")} AND project.project_alpha_project_id IS NOT NULL`)
    .bind(workspace.legacyAccountId, workspace.workspaceId, workspace.rootType, workspace.rootPublicId, workspace.legacyAccountId, draft.id, draft.version, localProjectId)
    .first<{ public_id: string; catalog_source_id: string; project_alpha_source_id: string }>();
  if (!project || !validOpaquePaId(project.public_id)) return null;
  return {
    catalogSource: createCatalogSourceContext(project.catalog_source_id),
    authorizationContext: {
      sourceId: project.project_alpha_source_id,
      workspaceRoot: { type: workspace.rootType, publicId: workspace.rootPublicId },
      projectPublicId: project.public_id,
    },
  };
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function configuration(env: Env): PricingConfiguration | null {
  if (env.PROJECT_ALPHA_PRICING_HINTS_ENABLED !== "true") return null;
  if (
    !env.PROJECT_ALPHA_PRICING_HINT_URL ||
    !env.PROJECT_ALPHA_PRICING_HINT_ALLOWED_ORIGIN ||
    !env.PROJECT_ALPHA_PRICING_HINT_API_KEY || env.PROJECT_ALPHA_PRICING_HINT_API_KEY.length < 20 ||
    !env.PROJECT_ALPHA_PRICING_HINT_HMAC_SECRET || env.PROJECT_ALPHA_PRICING_HINT_HMAC_SECRET.length < 32 ||
    !env.PROJECT_ALPHA_PRICING_HINT_APPLICATION_KEY || !SAFE_ID.test(env.PROJECT_ALPHA_PRICING_HINT_APPLICATION_KEY) ||
    !env.PROJECT_ALPHA_PRICING_HINT_CURRENCIES
  ) return null;
  let url: URL;
  let allowedOrigin: URL;
  try {
    url = new URL(env.PROJECT_ALPHA_PRICING_HINT_URL);
    allowedOrigin = new URL(env.PROJECT_ALPHA_PRICING_HINT_ALLOWED_ORIGIN);
  } catch {
    return null;
  }
  const endpointHost = url.hostname.toLowerCase();
  const hostIsIpLiteral = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(endpointHost) || endpointHost.includes(":");
  if (
    url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    url.pathname !== pricingPath(env.PROJECT_ALPHA_PRICING_HINT_APPLICATION_KEY) ||
    allowedOrigin.protocol !== "https:" || allowedOrigin.username || allowedOrigin.password ||
    allowedOrigin.pathname !== "/" || allowedOrigin.search || allowedOrigin.hash ||
    url.origin !== allowedOrigin.origin || !endpointHost.includes(".") || hostIsIpLiteral ||
    endpointHost === "localhost" || endpointHost.endsWith(".localhost") ||
    endpointHost.endsWith(".local") || endpointHost.endsWith(".internal")
  ) return null;
  const currencies = env.PROJECT_ALPHA_PRICING_HINT_CURRENCIES.split(",").map(value => value.trim());
  if (!currencies.length || currencies.some(value => !/^[A-Z]{3}$/.test(value))) return null;
  return {
    url,
    bearer: env.PROJECT_ALPHA_PRICING_HINT_API_KEY,
    hmacSecret: env.PROJECT_ALPHA_PRICING_HINT_HMAC_SECRET,
    applicationKey: env.PROJECT_ALPHA_PRICING_HINT_APPLICATION_KEY,
    allowedCurrencies: new Set(currencies),
  };
}

export function projectAlphaPricingHintCapability(env: Env): { enabled: boolean } {
  return { enabled: configuration(env) !== null };
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/** Race the whole exchange, including a response stream that never completes. */
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

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get("Content-Length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    cancelBody(response);
    throw new Error("pricing-response-too-large");
  }
  if (!response.body) throw new Error("pricing-response-empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await untilAborted(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        cancel();
        throw new Error("pricing-response-too-large");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  signal.throwIfAborted();
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function moneyMinor(value: string): number | null {
  if (!MONEY.test(value)) return null;
  const [whole, fraction] = value.split(".") as [string, string];
  const minor = Number(whole) * 100 + Number(fraction);
  return Number.isSafeInteger(minor) ? minor : null;
}

function normalizeResponse(
  raw: unknown,
  squareMetres: string,
  allowedCurrencies: ReadonlySet<string>,
  now: Date,
): ClientPricingHint | null {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.coverageSquareMetres !== squareMetres) return null;
  const expiry = Date.parse(parsed.data.validUntil);
  if (!Number.isFinite(expiry) || expiry <= now.getTime() || expiry > now.getTime() + 24 * 60 * 60 * 1000) return null;
  const basis = parsed.data.catalogVersion;
  if (parsed.data.displayMode === "none") {
    if (parsed.data.currency !== null || parsed.data.startingAt !== null || parsed.data.typicalMinimum !== null || parsed.data.typicalMaximum !== null || !parsed.data.reasonUnavailable) return null;
    return null;
  }
  if (!parsed.data.currency || !allowedCurrencies.has(parsed.data.currency) || parsed.data.reasonUnavailable !== null) return null;
  if (parsed.data.displayMode === "starting_at") {
    if (parsed.data.startingAt === null || parsed.data.typicalMinimum !== null || parsed.data.typicalMaximum !== null) return null;
    const startingAtMinor = moneyMinor(parsed.data.startingAt);
    return startingAtMinor === null ? null : {
      kind: "starting_at", currency: parsed.data.currency, startingAtMinor,
      disclaimer: parsed.data.disclaimer, basisVersion: basis, validUntil: parsed.data.validUntil,
    };
  }
  if (parsed.data.startingAt !== null || parsed.data.typicalMinimum === null || parsed.data.typicalMaximum === null) return null;
  const minimumMinor = moneyMinor(parsed.data.typicalMinimum);
  const maximumMinor = moneyMinor(parsed.data.typicalMaximum);
  return minimumMinor === null || maximumMinor === null || maximumMinor < minimumMinor ? null : {
    kind: "typical_range", currency: parsed.data.currency, minimumMinor, maximumMinor,
    disclaimer: parsed.data.disclaimer, basisVersion: basis, validUntil: parsed.data.validUntil,
  };
}

export async function fetchProjectAlphaPricingHint(
  input: ClientPricingHintInput,
  env: Env,
  options: ProjectAlphaPricingOptions = {},
): Promise<ClientPricingHint | null> {
  // Scalar connector settings belong only to this explicitly proven primary
  // source. An unknown/missing source must never fall back to that connector.
  try {
    const catalog = createCatalogSourceContext(input.catalogSource?.sourceId);
    const owner = createCatalogSourceContext(input.authorizationContext?.sourceId);
    if (catalog.sourceId !== owner.sourceId || catalog.sourceId !== PRIMARY_ALPHA_SOURCE_ID) return null;
  } catch { return null; }
  const config = configuration(env);
  if (!config || input.areaSquareMeters === null || !Number.isFinite(input.areaSquareMeters) || input.areaSquareMeters <= 0) return null;
  if (input.services.length < 1 || input.services.length > 10) return null;
  const services = input.services
    .map(service => ({ publicId: service.publicId, sourceVersion: service.sourceVersion }))
    .sort((left, right) => left.publicId < right.publicId ? -1 : left.publicId > right.publicId ? 1 : 0);
  if (
    services.some(service => !SAFE_ID.test(service.publicId) || !SAFE_ID.test(service.sourceVersion)) ||
    new Set(services.map(service => service.publicId)).size !== services.length
  ) return null;
  const squareMetres = input.areaSquareMeters.toFixed(6);
  const requestPayload = projectAlphaPricingRequestSchema.safeParse({
    schemaVersion: 1,
    source: "ltds-client-portal",
    scope: PRICING_SCOPE,
    authorizationContext: {
      workspaceRoot: input.authorizationContext.workspaceRoot,
      projectPublicId: input.authorizationContext.projectPublicId,
    },
    coverageSquareMetres: squareMetres,
    services,
  });
  if (!requestPayload.success) return null;
  const body = canonicalJson(requestPayload.data);
  const bodyHash = await sha256Hex(body);
  const startedAt = Date.now();
  const now = options.now ?? new Date(startedAt);
  const timestamp = now.toISOString();
  const signatureInput = `${timestamp}\nPOST\n${pricingPath(config.applicationKey)}\n${PRICING_SCOPE}\n${bodyHash}`;
  const signature = await hmacHex(config.hmacSecret, signatureInput);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new DOMException("Pricing response timed out", "TimeoutError")), PRICING_TIMEOUT_MS);
  try {
    const response = await untilAborted((options.fetcher ?? globalThis.fetch)(config.url.toString(), {
      method: "POST",
      redirect: "manual",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.bearer}`,
        "Content-Type": "application/json",
        "X-Portal-Integration-Application-Key": config.applicationKey,
        "X-Portal-Integration-Body-SHA256": bodyHash,
        "X-Portal-Integration-Scope": PRICING_SCOPE,
        "X-Portal-Integration-Signature": `sha256=${signature}`,
        "X-Portal-Integration-Timestamp": timestamp,
      },
      body,
      signal: controller.signal,
    }).then(result => {
      if (controller.signal.aborted) cancelBody(result);
      return result;
    }), controller.signal);
    if (!response.ok || response.redirected || !/^application\/json(?:;|$)/i.test(response.headers.get("Content-Type") ?? "")) {
      cancelBody(response);
      return null;
    }
    const raw = await readBoundedJson(response, controller.signal);
    return normalizeResponse(raw, squareMetres, config.allowedCurrencies,
      new Date(now.getTime() + Math.max(0, Date.now() - startedAt)));
  } catch {
    return null;
  } finally {
    clearTimeout(deadline);
  }
}

export function createProjectAlphaPricingHintProvider(options: ProjectAlphaPricingOptions = {}): ClientPricingHintProvider {
  return (input, env) => fetchProjectAlphaPricingHint(input, env, options);
}

export const projectAlphaPricingHintProvider: ClientPricingHintProvider = createProjectAlphaPricingHintProvider();
