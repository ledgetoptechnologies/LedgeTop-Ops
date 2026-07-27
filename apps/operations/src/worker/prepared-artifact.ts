import { HTTPException } from "hono/http-exception";
import { artifactKey } from "./artifacts";
import type { Env } from "./types";

export type PreparedArtifactVariant = "thumb" | "preview" | "poster";

type PreparedArtifactEnv = Pick<Env, "DATA_BUCKET" | "DELIVERY_DB">;

function registeredDerivativeEtags(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function cleanEtag(value: string): string {
  return value.replace(/^"|"$/g, "");
}

function matchesEtag(value: string | undefined, current: string): boolean {
  if (!value) return false;
  const clean = (etag: string) => etag.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  const expected = clean(current);
  return value.split(",").some((candidate) => candidate.trim() === "*" || clean(candidate) === expected);
}

export async function servePreparedArtifact(
  env: PreparedArtifactEnv,
  key: string,
  variant: PreparedArtifactVariant,
  ifNoneMatch?: string,
): Promise<Response> {
  const prefix = (await artifactKey(key, "thumb")).replace(/thumb\.webp$/, "");
  const source = await env.DATA_BUCKET.head(key);
  const manifest = await env.DATA_BUCKET.head(`${prefix}manifest.json`);
  const registered = await env.DELIVERY_DB.withSession("first-primary")
    .prepare("SELECT source_etag,manifest_etag,derivative_etags_json FROM preview_artifacts WHERE artifact_prefix=? AND source_key=? AND missing_since IS NULL")
    .bind(prefix, key)
    .first() as { source_etag: string; manifest_etag: string; derivative_etags_json: string } | null;
  const etags = registered ? registeredDerivativeEtags(registered.derivative_etags_json) : {};
  const expected = etags[variant];
  if (
    !source
    || !manifest
    || !registered
    || typeof expected !== "string"
    || cleanEtag(registered.source_etag) !== cleanEtag(source.httpEtag)
    || cleanEtag(registered.manifest_etag) !== cleanEtag(manifest.httpEtag)
  ) {
    throw new HTTPException(404, { message: "Prepared preview unavailable" });
  }

  const derivativeKey = await artifactKey(key, variant);
  const derivative = await env.DATA_BUCKET.head(derivativeKey);
  const maxBytes = variant === "preview" ? 512_000 : 100 * 1024;
  if (
    !derivative
    || derivative.size <= 0
    || derivative.size > maxBytes
    || cleanEtag(derivative.httpEtag) !== cleanEtag(expected)
  ) {
    throw new HTTPException(404, { message: "Prepared preview unavailable" });
  }

  const responseEtag = derivative.httpEtag.startsWith("\"")
    ? derivative.httpEtag
    : `"${derivative.httpEtag.replace(/^"|"$/g, "")}"`;
  const headers = new Headers({
    "Content-Type": "image/webp",
    "Content-Disposition": "inline",
    "Cache-Control": "private, no-cache",
    "ETag": responseEtag,
    "X-Content-Type-Options": "nosniff",
  });
  if (matchesEtag(ifNoneMatch, responseEtag)) return new Response(null, { status: 304, headers });

  const object = await env.DATA_BUCKET.get(derivativeKey, { onlyIf: { etagMatches: derivative.etag } });
  if (!object || !("body" in object) || object.size > maxBytes) {
    throw new HTTPException(404, { message: "Prepared preview unavailable" });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}
