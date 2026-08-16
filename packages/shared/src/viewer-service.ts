const encoder = new TextEncoder();

export type ViewerAudience = "ops" | "client";

export interface ViewerModelSummary {
  id: string;
  title: string;
  provider: string;
  status: string;
  available: boolean;
  activeVersion: {
    id: string;
    providerVersionId: string;
    createdAt: string;
    updatedAt: string;
  } | null;
  updatedAt: string;
}

export interface ViewerSessionGrant {
  grant: string;
  grantExpiresAt: string;
  sessionTtlSeconds: number;
  redeemUrl: string;
  embedUrl: string;
}

export interface ViewerServiceConfiguration {
  baseUrl: string;
  keyId: string;
  secret: string;
}

export class ViewerServiceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_configured"
      | "invalid_configuration"
      | "unavailable"
      | "invalid_response"
      | "not_found",
    readonly status = 503,
  ) {
    super(message);
    this.name = "ViewerServiceError";
  }
}

function base64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const value of new Uint8Array(bytes)) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(value: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...hash].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function viewerServiceOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function viewerServiceConfigured(configuration: Partial<ViewerServiceConfiguration>): boolean {
  return Boolean(
    viewerServiceOrigin(configuration.baseUrl || "") &&
    /^[A-Za-z0-9._-]{1,64}$/.test(configuration.keyId || "") &&
    (configuration.secret?.length || 0) >= 32,
  );
}

export async function signViewerServiceRequest(input: {
  secret: string;
  keyId: string;
  method: string;
  pathWithQuery: string;
  body: string;
  timestamp?: number;
  nonce?: string;
}): Promise<Record<string, string>> {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = input.nonce ?? crypto.randomUUID();
  const bodyHash = await sha256Hex(input.body);
  const canonical = [
    "ltds-viewer-service-v1",
    input.method.toUpperCase(),
    input.pathWithQuery,
    String(timestamp),
    nonce,
    bodyHash,
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(canonical));
  return {
    "X-LTDS-Key-Id": input.keyId,
    "X-LTDS-Timestamp": String(timestamp),
    "X-LTDS-Nonce": nonce,
    "X-LTDS-Content-SHA256": bodyHash,
    "X-LTDS-Signature": base64Url(signature),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function model(value: unknown): ViewerModelSummary | null {
  const row = record(value), version = record(row?.activeVersion);
  if (!row || typeof row.id !== "string" || typeof row.title !== "string" ||
    typeof row.provider !== "string" || typeof row.status !== "string" ||
    typeof row.available !== "boolean" || typeof row.updatedAt !== "string") return null;
  let activeVersion: ViewerModelSummary["activeVersion"] = null;
  if (version) {
    if (typeof version.id !== "string" || typeof version.providerVersionId !== "string" ||
      typeof version.createdAt !== "string" || typeof version.updatedAt !== "string") return null;
    activeVersion = {
      id: version.id,
      providerVersionId: version.providerVersionId,
      createdAt: version.createdAt,
      updatedAt: version.updatedAt,
    };
  }
  return {
    id: row.id,
    title: row.title,
    provider: row.provider,
    status: row.status,
    available: row.available,
    activeVersion,
    updatedAt: row.updatedAt,
  };
}

function assertSameViewerOrigin(value: unknown, origin: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.origin === origin && url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export class ViewerServiceClient {
  private readonly origin: string;

  constructor(
    private readonly configuration: ViewerServiceConfiguration,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const origin = viewerServiceOrigin(configuration.baseUrl);
    if (!origin || !/^[A-Za-z0-9._-]{1,64}$/.test(configuration.keyId) || configuration.secret.length < 32)
      throw new ViewerServiceError("3D Viewer integration is not configured", "invalid_configuration");
    this.origin = origin;
  }

  private async request(pathWithQuery: string, init: { method?: string; body?: string; idempotencyKey?: string } = {}): Promise<unknown> {
    const method = (init.method || "GET").toUpperCase(), body = init.body || "";
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const signed = await signViewerServiceRequest({
        ...this.configuration,
        method,
        pathWithQuery,
        body,
      });
      const response = await this.fetcher(`${this.origin}${pathWithQuery}`, {
        method,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        headers: {
          ...signed,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
        },
        signal: controller.signal,
      });
      if (response.status === 404) throw new ViewerServiceError("3D model not found", "not_found", 404);
      if (!response.ok) throw new ViewerServiceError("3D Viewer is temporarily unavailable", "unavailable", 503);
      return await response.json();
    } catch (error) {
      if (error instanceof ViewerServiceError) throw error;
      throw new ViewerServiceError("3D Viewer is temporarily unavailable", "unavailable", 503);
    } finally {
      clearTimeout(timeout);
    }
  }

  async listModels(): Promise<ViewerModelSummary[]> {
    const payload = record(await this.request("/api/v1/models"));
    if (!payload || !Array.isArray(payload.models))
      throw new ViewerServiceError("3D Viewer returned an invalid model catalog", "invalid_response");
    const models = payload.models.map(model);
    if (models.some(item => item === null))
      throw new ViewerServiceError("3D Viewer returned an invalid model catalog", "invalid_response");
    return models as ViewerModelSummary[];
  }

  async createSession(input: {
    modelId: string;
    modelVersionId: string;
    subject: string;
    audience: ViewerAudience;
    idempotencyKey: string;
    authorizationExpiresAt: string;
    permissions?: { view: true; measure?: boolean; cameras?: boolean; download?: boolean };
  }): Promise<ViewerSessionGrant> {
    const path = `/api/v1/models/${encodeURIComponent(input.modelId)}/sessions`;
    const body = JSON.stringify({
      subject: input.subject,
      audience: input.audience,
      modelVersionId: input.modelVersionId,
      authorizationExpiresAt: input.authorizationExpiresAt,
      permissions: input.permissions || { view: true, measure: true, cameras: true, download: false },
    });
    const payload = record(await this.request(path, { method: "POST", body, idempotencyKey: input.idempotencyKey }));
    const redeemUrl = assertSameViewerOrigin(payload?.redeemUrl, this.origin);
    const embedUrl = assertSameViewerOrigin(payload?.embedUrl, this.origin);
    if (!payload || typeof payload.grant !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(payload.grant) ||
      typeof payload.grantExpiresAt !== "string" || !Number.isFinite(Date.parse(payload.grantExpiresAt)) ||
      typeof payload.sessionTtlSeconds !== "number" || !Number.isInteger(payload.sessionTtlSeconds) ||
      payload.sessionTtlSeconds < 60 || payload.sessionTtlSeconds > 3600 || !redeemUrl || !embedUrl)
      throw new ViewerServiceError("3D Viewer returned an invalid session grant", "invalid_response");
    return {
      grant: payload.grant,
      grantExpiresAt: payload.grantExpiresAt,
      sessionTtlSeconds: payload.sessionTtlSeconds,
      redeemUrl,
      embedUrl,
    };
  }
}
