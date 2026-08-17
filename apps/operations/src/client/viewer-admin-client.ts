import type {
  ViewerAdminSession,
  ViewerAdminSessionGrant,
  ViewerDisplayUnits,
} from "@ltds/shared";
import { api } from "./api";

type AdminGrant = ViewerAdminSessionGrant & {
  units: { default: "imperial"; resolved: ViewerDisplayUnits };
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseSession(value: unknown): ViewerAdminSession {
  const payload = record(value), session = record(payload?.session), units = record(payload?.units);
  if (!payload || !session || !units || typeof payload.accessToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(payload.accessToken) || typeof session.id !== "string" ||
    typeof session.subject !== "string" || !Array.isArray(session.permissions) ||
    !session.permissions.every(permission => typeof permission === "string") ||
    typeof session.expiresAt !== "string" || !Number.isFinite(Date.parse(session.expiresAt)) ||
    units.default !== "imperial" || !["imperial", "metric"].includes(String(units.resolved)))
    throw new Error("3D Viewer returned an invalid administrative session");
  return value as ViewerAdminSession;
}

async function boundedJson<T>(response: Response, maximum = 2 * 1024 * 1024): Promise<T> {
  const contentType = response.headers.get("Content-Type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType))
    throw new Error("3D Viewer returned a non-JSON response");
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maximum)
    throw new Error("3D Viewer returned an oversized response");
  if (!response.body) throw new Error("3D Viewer returned an empty response");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maximum) { await reader.cancel(); throw new Error("3D Viewer returned an oversized response"); }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as T; }
  catch { throw new Error("3D Viewer returned invalid JSON"); }
}

export class ViewerAdminClient {
  private accessToken: string | null = null;
  private expiresAt = 0;
  private renewal: Promise<void> | null = null;
  private renewalError: string | null = null;
  private readonly fetcher: typeof fetch;

  constructor(
    readonly origin: string,
    fetcher?: typeof fetch,
  ) {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.pathname !== "/")
      throw new Error("3D Viewer origin is invalid");
    this.fetcher = fetcher || globalThis.fetch.bind(globalThis);
  }

  private async renew(): Promise<void> {
    const grant = await api<AdminGrant>("/api/viewer/admin-grant", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    const redeemUrl = new URL(grant.redeemUrl);
    if (redeemUrl.origin !== this.origin || redeemUrl.pathname !== "/api/v1/admin-sessions/redeem" ||
      redeemUrl.search || redeemUrl.hash)
      throw new Error("3D Viewer returned an invalid redemption URL");
    const response = await this.fetcher(redeemUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
      },
      body: JSON.stringify({ grant: grant.grant }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok) throw new Error("3D Viewer administrative authorization is temporarily unavailable");
    const session = parseSession(await boundedJson(response));
    this.accessToken = session.accessToken;
    this.expiresAt = Date.parse(session.session.expiresAt);
    this.renewalError = null;
  }

  async ensureSession(force = false): Promise<void> {
    const now = Date.now();
    if (!force && this.accessToken && this.expiresAt - now > 5 * 60 * 1000) return;
    if (!this.renewal) this.renewal = this.renew().finally(() => { this.renewal = null; });
    try { await this.renewal; }
    catch (error) {
      this.renewalError = error instanceof Error ? error.message : "Viewer authorization renewal failed";
      // A retryable proactive renewal must not destroy a still-valid Viewer
      // session or the UI state it protects. Requests continue until expiry.
      if (!force && this.accessToken && this.expiresAt > Date.now()) return;
      throw error;
    }
  }

  async requestWithMetadata<T>(path: string, init: RequestInit = {}): Promise<{
    payload: T;
    status: number;
    location: string | null;
    retryAfterSeconds: number | null;
  }> {
    if (!path.startsWith("/api/v1/") || path.includes("..")) throw new Error("Viewer API path is invalid");
    await this.ensureSession();
    const send = () => {
      const headers = new Headers(init.headers);
      headers.set("Accept", "application/json");
      headers.set("Authorization", `Bearer ${this.accessToken}`);
      if (init.body && !(init.body instanceof Blob) && !headers.has("Content-Type"))
        headers.set("Content-Type", "application/json");
      return this.fetcher(new URL(path, this.origin), {
        ...init, headers, cache: "no-store", credentials: "omit", redirect: "error",
      });
    };
    let response = await send();
    if (response.status === 401 && this.expiresAt > Date.now()) {
      await this.ensureSession(true);
      response = await send();
    }
    if (response.status === 204) return {
      payload: undefined as T,
      status: response.status,
      location: response.headers.get("Location"),
      retryAfterSeconds: null,
    };
    let payload: T & { error?: string };
    try { payload = await boundedJson<T & { error?: string }>(response); }
    catch (error) {
      if (response.ok) throw error;
      payload = {} as T & { error?: string };
    }
    if (!response.ok) throw new Error(payload.error || `3D Viewer request failed (${response.status})`);
    const retryAfter = Number(response.headers.get("Retry-After"));
    return {
      payload,
      status: response.status,
      location: response.headers.get("Location"),
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter >= 1 ? retryAfter : null,
    };
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return (await this.requestWithMetadata<T>(path, init)).payload;
  }

  async requestBlob(path: string, init: RequestInit = {}): Promise<Blob> {
    if (!path.startsWith("/api/v1/") || path.includes("..")) throw new Error("Viewer API path is invalid");
    await this.ensureSession();
    const send = () => {
      const headers = new Headers(init.headers);
      headers.set("Accept", "image/*");
      headers.set("Authorization", `Bearer ${this.accessToken}`);
      return this.fetcher(new URL(path, this.origin), {
        ...init, headers, cache: "no-store", credentials: "omit", redirect: "error",
      });
    };
    let response = await send();
    if (response.status === 401 && this.expiresAt > Date.now()) {
      await this.ensureSession(true);
      response = await send();
    }
    if (!response.ok) {
      let message = `3D Viewer request failed (${response.status})`;
      try {
        const payload = await boundedJson<{ error?: string }>(response, 64 * 1024);
        if (payload.error) message = payload.error;
      } catch { /* preserve the bounded generic error */ }
      throw new Error(message);
    }
    const declared = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(declared) && declared > 128 * 1024 * 1024)
      throw new Error("3D Viewer returned an oversized image response");
    const contentType = response.headers.get("Content-Type") || "";
    if (!/^image\/(?:jpeg|png|webp|gif|avif|tiff)(?:\s*;|$)/i.test(contentType))
      throw new Error("3D Viewer returned an unsupported image response");
    if (!response.body) throw new Error("3D Viewer returned an empty image response");
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > 128 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("3D Viewer returned an oversized image response");
      }
      chunks.push(result.value);
    }
    const parts: BlobPart[] = chunks.map((chunk) => {
      const copy = new Uint8Array(chunk.byteLength);
      copy.set(chunk);
      return copy.buffer;
    });
    return new Blob(parts, { type: contentType.split(";", 1)[0] });
  }

  async uploadChunk(input: {
    uploadId: string;
    fileId: string;
    index: number;
    uploadToken: string;
    sha256: string;
    body: Blob;
    signal?: AbortSignal;
  }): Promise<void> {
    await this.request(
      `/api/v1/admin/uploads/${encodeURIComponent(input.uploadId)}/files/${encodeURIComponent(input.fileId)}/chunks/${input.index}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Idempotency-Key": `${input.uploadId}:${input.fileId}:${input.index}`.slice(0, 128),
          "X-Upload-Token": input.uploadToken,
          "X-Chunk-SHA256": input.sha256,
        },
        body: input.body,
        signal: input.signal,
      },
    );
  }

  clear(): void {
    this.accessToken = null;
    this.expiresAt = 0;
  }

  status(): { expiresAt: number; renewalError: string | null } {
    return { expiresAt: this.expiresAt, renewalError: this.renewalError };
  }
}
