import { createWindowsPortalStagingRouter, type WindowsPortalStagingDeployment } from "./windows-files-staging";
import type standardWorker from "../index";
import type { Env } from "../types";
type StagingEnv = Env & Readonly<{ WINDOWS_PORTAL_QUEUE_KEY?: string }>;
type Fallback = Pick<typeof standardWorker, "fetch" | "scheduled">;
export type WindowsPortalWorkerProfile = Readonly<{ enabled: boolean; deployment: WindowsPortalStagingDeployment }>;
const ORIGIN = "https://portal-staging.ledgetopdroneservices.com";
const ISSUER = "https://ledgetoptechnologies.cloudflareaccess.com";
const AUDIENCE = "8eed2de9972afe7d653de2adb68c1b0ef7c6462a9a694203b31d9a32f4248bbc";
const BASE = "/api/client/operations/data/";
export const windowsPortalStagingPath = (path: string) => ["windows-catalog", "windows-successor", "queue"]
  .some(name => path === BASE + name || path.startsWith(BASE + name + "/"));
const unavailable = () => Response.json({ error: "windows_portal_staging_unavailable" }, { status: 503,
  headers: { "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
function key(text: string | undefined): Uint8Array {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(text)) throw Error();
  const decoded = atob(text.replace(/-/gu, "+").replace(/_/gu, "/") + "=");
  if (btoa(decoded).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "") !== text) throw Error();
  return Uint8Array.from(decoded, c => c.charCodeAt(0));
}
export function createWindowsPortalStagingWorker(profile: WindowsPortalWorkerProfile, fallback: Fallback) {
  const captured = Object.freeze({ enabled: profile?.enabled === true, deployment: Object.freeze({ ...profile?.deployment }) });
  return {
    async fetch(request: Request, env: StagingEnv, ctx: ExecutionContext): Promise<Response> {
      if (!windowsPortalStagingPath(new URL(request.url).pathname)) return fallback.fetch(request, env, ctx);
      if (!captured.enabled || env.ENVIRONMENT !== "staging" || env.CLIENT_PORTAL_ORIGIN !== ORIGIN
        || env.CLIENT_ACCESS_TEAM_DOMAIN !== ISSUER || env.CLIENT_ACCESS_AUD !== AUDIENCE
        || env.CLIENT_ACCESS_AUDS !== undefined && env.CLIENT_ACCESS_AUDS !== AUDIENCE) return unavailable();
      try {
        const router = createWindowsPortalStagingRouter({ enabled: true, portalOrigin: ORIGIN, issuer: ISSUER, audience: AUDIENCE,
          deployment: captured.deployment, queueKey: key(env.WINDOWS_PORTAL_QUEUE_KEY) }, { DELIVERY_DB: env.DELIVERY_DB, DATA_BUCKET: env.DATA_BUCKET });
        return await router.fetch(request, env, ctx);
      } catch { return unavailable(); }
    },
    scheduled: fallback.scheduled,
  };
}
