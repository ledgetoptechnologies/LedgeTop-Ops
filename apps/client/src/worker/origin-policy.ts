import { HTTPException } from "hono/http-exception";
import type { Env } from "./types";

type OriginEnv = Pick<Env,
  "ENVIRONMENT" | "EXPECTED_HOST" | "PUBLIC_BASE_URL" | "PUBLIC_SHARE_ORIGIN" | "CLIENT_PORTAL_ORIGIN" | "CLIENT_PORTAL_ORIGINS"
>;

type RequestNamespace = "public" | "portal" | "internal" | "shared" | "assets" | "unknown";

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
  if (path === "/assets" || path.startsWith("/assets/")) return "assets";
  if (path === "/s" || path.startsWith("/s/")
    || path === "/client-share" || path.startsWith("/client-share/")
    || path === "/api/public" || path.startsWith("/api/public/")) return "public";
  if (path === "/api/internal" || path.startsWith("/api/internal/")) return "internal";
  if (path === "/portal" || path.startsWith("/portal/")
    || path === "/api/client" || path.startsWith("/api/client/")) return "portal";
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

export function configuredClientPortalOrigins(env: OriginEnv): string[] | null {
  const primary = configuredClientPortalOrigin(env);
  if (!primary) return null;
  if (!env.CLIENT_PORTAL_ORIGINS) return [primary];
  const values = env.CLIENT_PORTAL_ORIGINS.split(",").map(value => value.trim());
  if (!values.length || values.length > 4 || values.some(value => !value)) return null;
  const origins = values.map(value => exactOrigin(value, deployed(env))?.origin ?? null);
  if (origins.some(value => value === null)) return null;
  const exact = origins as string[];
  if (new Set(exact).size !== exact.length || !exact.includes(primary)) return null;
  return exact;
}

export function clientPortalRequestOriginAllowed(request: Request, env: OriginEnv): boolean {
  const origins = configuredClientPortalOrigins(env);
  if (!origins) return false;
  let requestOrigin: string;
  try { requestOrigin = new URL(request.url).origin; } catch { return false; }
  return request.headers.get("Origin") === requestOrigin && origins.includes(requestOrigin);
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

export function clientPortalEntryOrigin(requestUrl: string, env: OriginEnv): string {
  const primary = requireClientPortalOrigin(env);
  const origins = configuredClientPortalOrigins(env);
  if (!origins) throw new HTTPException(503, { message: "Client portal is not configured" });
  try {
    const requestOrigin = new URL(requestUrl).origin;
    return origins.includes(requestOrigin) ? requestOrigin : primary;
  } catch {
    return primary;
  }
}

export function requestHostAllowed(requestUrl: string, env: OriginEnv): boolean {
  if (!deployed(env)) return true;
  let request: URL;
  try { request = new URL(requestUrl); } catch { return false; }
  const namespace = requestNamespace(request.pathname);
  const publicOrigin = configuredPublicShareOrigin(env);
  if (namespace === "public") return publicOrigin !== null && request.origin === publicOrigin;
  const primaryPortalOrigin = configuredClientPortalOrigin(env);
  if (namespace === "internal") return primaryPortalOrigin !== null && request.origin === primaryPortalOrigin;
  const portalOrigins = configuredClientPortalOrigins(env);
  if (!portalOrigins) return false;
  if (namespace === "portal") return portalOrigins.includes(request.origin);
  if (namespace === "shared" || namespace === "assets")
    return (publicOrigin !== null && request.origin === publicOrigin) || portalOrigins.includes(request.origin);
  return false;
}
