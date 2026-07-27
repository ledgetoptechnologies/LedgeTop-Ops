import { HTTPException } from "hono/http-exception";
import { preparedKey } from "./artifacts";

export type PreparedImageVariant = "thumbnail" | "preview" | "poster";

interface PreparedObject {
  size: number;
  etag: string;
  httpEtag: string;
}

interface PreparedObjectBody extends PreparedObject {
  body: BodyInit;
}

export interface PreparedImageBucket {
  head(key: string): Promise<PreparedObject | null>;
  get(
    key: string,
    options: { onlyIf: { etagMatches: string } },
  ): Promise<PreparedObjectBody | PreparedObject | null>;
}

interface PreparedImageStatement {
  bind(...values: unknown[]): PreparedImageStatement;
  first<T>(): Promise<T | null>;
}

export interface PreparedImageDatabase {
  prepare(query: string): PreparedImageStatement;
}

export interface PreparedImageContext {
  bucket: PreparedImageBucket;
  database: PreparedImageDatabase;
  ifNoneMatch?: string;
}

interface PreviewRegistration {
  source_etag: string;
  manifest_etag: string;
  derivative_etags_json: string;
}

function registeredDerivativeEtags(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function cleanEtag(value: string): string {
  return value.replace(/^"|"$/g, "");
}

export function matchesEtag(value: string | undefined, current: string): boolean {
  if (!value) return false;
  const clean = (etag: string) => etag.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  const expected = clean(current);
  return value.split(",").some(candidate => candidate.trim() === "*" || clean(candidate) === expected);
}

export async function servePreparedImage(
  context: PreparedImageContext,
  key: string,
  variant: PreparedImageVariant,
): Promise<Response> {
  const preparedVariant = variant === "thumbnail" ? "thumb" : variant;
  const prefix = (await preparedKey(key, "thumb")).replace(/thumb\.webp$/, "");
  const source = await context.bucket.head(key);
  const manifest = await context.bucket.head(`${prefix}manifest.json`);
  const registered = await context.database
    .prepare("SELECT source_etag,manifest_etag,derivative_etags_json FROM preview_artifacts WHERE artifact_prefix=? AND source_key=? AND missing_since IS NULL")
    .bind(prefix, key)
    .first<PreviewRegistration>();
  const derivativeEtags = registered ? registeredDerivativeEtags(registered.derivative_etags_json) : {};
  const expectedEtag = derivativeEtags[preparedVariant];
  if (!source || !manifest || !registered || typeof expectedEtag !== "string" ||
    cleanEtag(registered.source_etag) !== cleanEtag(source.httpEtag) ||
    cleanEtag(registered.manifest_etag) !== cleanEtag(manifest.httpEtag)) {
    throw new HTTPException(404, { message: "Prepared preview unavailable" });
  }

  const derivativeKey = await preparedKey(key, preparedVariant);
  const derivative = await context.bucket.head(derivativeKey);
  const maxBytes = preparedVariant === "preview" ? 512_000 : 100 * 1024;
  if (!derivative || derivative.size <= 0 || derivative.size > maxBytes ||
    cleanEtag(derivative.httpEtag) !== cleanEtag(expectedEtag)) {
    throw new HTTPException(404, { message: "Prepared preview unavailable" });
  }

  const responseEtag = derivative.httpEtag.startsWith("\"")
    ? derivative.httpEtag
    : `"${cleanEtag(derivative.httpEtag)}"`;
  const headers = new Headers({
    "Content-Type": "image/webp",
    "Content-Disposition": "inline",
    "Cache-Control": "private, no-cache",
    "ETag": responseEtag,
    "X-Content-Type-Options": "nosniff",
  });
  if (matchesEtag(context.ifNoneMatch, responseEtag)) {
    return new Response(null, { status: 304, headers });
  }

  const object = await context.bucket.get(derivativeKey, {
    onlyIf: { etagMatches: derivative.etag },
  });
  if (!object || !("body" in object) || object.size > maxBytes) {
    throw new HTTPException(404, { message: "Prepared preview unavailable" });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}
