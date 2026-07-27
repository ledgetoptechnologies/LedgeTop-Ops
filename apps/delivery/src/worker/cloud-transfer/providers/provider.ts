export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function byteBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export interface ProviderRequestOptions {
  accepted?: readonly number[];
  operation: string;
}

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly providerCode?: string;

  constructor(input: {
    operation: string;
    status: number;
    retryAfterMs?: number;
    retryable: boolean;
    providerCode?: string;
  }) {
    super(`${input.operation} failed (${input.status})`);
    this.name = "ProviderHttpError";
    this.status = input.status;
    this.retryAfterMs = input.retryAfterMs;
    this.retryable = input.retryable;
    this.providerCode = input.providerCode;
  }
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

function providerCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  const value = record.error_summary ?? record.error ?? record.reason;
  if (typeof value === "string") return value.slice(0, 120);
  if (value && typeof value === "object") {
    const tag = (value as Record<string, unknown>)[".tag"];
    if (typeof tag === "string") return tag.slice(0, 120);
  }
  return undefined;
}

export async function providerFetch(
  fetcher: Fetcher,
  input: RequestInfo | URL,
  init: RequestInit,
  options: ProviderRequestOptions,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(input, init);
  } catch {
    throw new ProviderHttpError({
      operation: options.operation,
      status: 0,
      retryable: true,
    });
  }
  const accepted = options.accepted ?? [200];
  if (accepted.includes(response.status)) return response;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    body = undefined;
  }
  throw new ProviderHttpError({
    operation: options.operation,
    status: response.status,
    retryAfterMs: parseRetryAfter(response.headers.get("Retry-After")),
    retryable: response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
    providerCode: providerCode(body),
  });
}

export async function responseJson<T>(response: Response, operation: string): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    throw new ProviderHttpError({ operation, status: response.status, retryable: false, providerCode: "invalid-response" });
  }
}
