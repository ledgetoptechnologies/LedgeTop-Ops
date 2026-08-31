import { HTTPException } from "hono/http-exception";
import type { Env } from "./types";

type OriginEnv = Pick<Env,
  "ENVIRONMENT" | "EXPECTED_HOST" | "PUBLIC_BASE_URL" | "PUBLIC_SHARE_ORIGIN" | "CLIENT_PORTAL_ORIGIN"
>;

type RequestNamespace = "public" | "portal" | "shared" | "unknown";

function deployed(env: Pick<Env, "ENVIRONMENT">): boolean {
  return env.ENVIRONMENT === "production" || env.ENVIRONMENT === "staging";
}

function exactOrigin(value: string | undefined, requireHttps: boolean): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.origin !== value || url.pathname !== "/" || url.search || url.hash || url.username || url.password)
      return null;
    if (requireHttps && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

export function requestNamespace(path: string): RequestNamespace {
  if (path === "/" || path === "/health") return "shared";
  if (path === "/s" || path.startsWith("/s/")
    || path === "/client-share" || path.startsWith("/client-share/")
    || path === "/api/public" || path.startsWith("/api/public/")) return "public";
  if (path === "/portal" || path.startsWith("/portal/")
    || path === "/api/client" || path.startsWith("/api/client/")
    || path === "/api/internal" || path.startsWith("/api/internal/")) return "portal";
  return "unknown";
}

export function configuredPublicShareOrigin(env: OriginEnv): string | null {
  const requiredHttps = deployed(env);
  const configured = exactOrigin(env.PUBLIC_SHARE_ORIGIN || env.PUBLIC_BASE_URL, requiredHttps);
  if (!configured) return null;
  const legacy = env.PUBLIC_BASE_URL ? exactOrigin(env.PUBLIC_BASE_URL, requiredHttps) : configured;
  if (!legacy || legacy.origin !== configured.origin) return null;
  if (requiredHttps && configured.host !== env.EXPECTED_HOST) return null;
  return configured.origin;
}

export function configuredClientPortalOrigin(env: OriginEnv): string | null {
  return exactOrigin(env.CLIENT_PORTAL_ORIGIN, deployed(env))?.origin ?? null;
}

export function requirePublicShareOrigin(env: OriginEnv): string {
  const origin = configuredPublicShareOrigin(env);
  if (!origin) throw new HTTPException(503, { message: "Public delivery is not configured" });
  return origin;
}

export function requireClientPortalOrigin(env: OriginEnv): string {
  const origin = configuredClientPortalOrigin(env);
  if (!origin) throw new HTTPException(503, { message: "Client portal is not configured" });
  return origin;
}

export function requestHostAllowed(requestUrl: string, env: OriginEnv): boolean {
  if (!deployed(env)) return true;
  let request: URL;
  try { request = new URL(requestUrl); } catch { return false; }
  const publicOrigin = configuredPublicShareOrigin(env);
  const portalOrigin = configuredClientPortalOrigin(env);
  if (!publicOrigin || !portalOrigin) return false;
  const namespace = requestNamespace(request.pathname);
  if (namespace === "public") return request.origin === publicOrigin;
  if (namespace === "portal") return request.origin === portalOrigin;
  if (namespace === "shared") return request.origin === publicOrigin || request.origin === portalOrigin;
  return false;
}
