import { configuredDeploymentOrigin } from "@ltds/shared/configured-deployment-origin";
import { fetchUiReleaseAsset, fetchUiReleaseShell } from "../../../../packages/shared/src/ui-release-assets";
import { findUiReleaseManifest, uiReleaseForRequest } from "../../../../packages/shared/src/ui-release-catalog";
import type { Env } from "./types";

type UiReleaseEnv = Pick<Env, "ENVIRONMENT" | "EXPECTED_HOST" | "PUBLIC_BASE_URL"
  | "ASSETS" | "UI_RELEASE_ASSETS" | "UI_ACTIVE_RELEASE">;

function failure(status: 404 | 503): Response {
  return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
}

function canonicalOperationsRequest(request: Request, env: UiReleaseEnv): boolean {
  const origin = configuredDeploymentOrigin({ environment: env.ENVIRONMENT ?? "",
    origin: env.PUBLIC_BASE_URL, expectedHost: env.EXPECTED_HOST });
  return origin !== null && new URL(request.url).origin === origin;
}

function htmlNavigation(request: Request): boolean {
  return (request.method === "GET" || request.method === "HEAD")
    && (request.headers.get("Accept") ?? "").split(",").some(entry => {
      const [mime, ...parameters] = entry.trim().toLowerCase().split(";");
      return mime?.trim() === "text/html" && !parameters.some(value => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(value));
    });
}

/** Finite SPA surfaces only. API, legacy assets, Incoming and staging-owner
 * namespaces are never inferred to be presentation routes from Accept alone. */
export function operationsUiPresentationPath(pathname: string): boolean {
  if (pathname === "/") return true;
  if (["/dashboard", "/notifications", "/airspace", "/team", "/administration", "/configurations",
    "/administration/client-onboarding", "/administration/client-portal/recipients"].includes(pathname)) return true;
  return ["/operations", "/clients", "/viewer", "/delivery", "/jobs", "/projects", "/tasks", "/sops"]
    .some(base => pathname === base || pathname.startsWith(`${base}/`));
}

/** Only called after presentation admission, including native-owner flags.
 * The empty selector keeps the existing asset binding and response unchanged. */
export async function serveOperationsUiShell(request: Request, env: UiReleaseEnv): Promise<Response> {
  const selected = env.UI_ACTIVE_RELEASE;
  if (selected === undefined || selected === "" || !htmlNavigation(request)) return env.ASSETS.fetch(request);
  // Already-admitted staff aliases retain their installed shell. Release HTML
  // references canonical-only immutable assets and cannot be selected there.
  if (!canonicalOperationsRequest(request, env)) return env.ASSETS.fetch(request);
  const manifest = findUiReleaseManifest("operations", selected);
  const binding = env.UI_RELEASE_ASSETS;
  if (!manifest || !binding) return failure(503);
  return fetchUiReleaseShell(request, binding, manifest);
}

/** Called by Hono only after ordinary host middleware and existing handlers.
 * Registered immutable assets remain readable when HTML selection rolls back. */
export async function dispatchOperationsUiReleaseRequest(request: Request, env: UiReleaseEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/_ui" || url.pathname.startsWith("/_ui/")) {
    if (!canonicalOperationsRequest(request, env)) return failure(404);
    const manifest = uiReleaseForRequest("operations", request.url);
    if (!manifest) return failure(404);
    const binding = env.UI_RELEASE_ASSETS;
    if (!binding) return failure(503);
    return fetchUiReleaseAsset(request, binding, manifest);
  }
  if (!operationsUiPresentationPath(url.pathname) || !htmlNavigation(request)) return null;
  return serveOperationsUiShell(request, env);
}
