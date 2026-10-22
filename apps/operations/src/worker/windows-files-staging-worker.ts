import { createWindowsEmployeeFilesStagingRouter } from "./windows-files-staging";
import type standardWorker from "./staging-native-authority-entrypoint";

export type WindowsEmployeeStagingProfile = Readonly<{ enabled: boolean; gateway: Readonly<{ origin: string; gatewayId: string; keyId: string }> }>;
type PrivateBindings = Readonly<{ WINDOWS_EMPLOYEE_GATEWAY_SIGNING_KEY?: string; WINDOWS_EMPLOYEE_HANDLE_KEY?: string; WINDOWS_EMPLOYEE_QUEUE_KEY?: string }>;
type StagingEnv = Parameters<typeof standardWorker.fetch>[1] & PrivateBindings;
type Fallback = Pick<typeof standardWorker, "fetch" | "queue" | "scheduled">;
const ORIGIN = "https://ops-staging.ledgetopdroneservices.com";
const ISSUER = "https://ledgetoptechnologies.cloudflareaccess.com";
const AUDIENCE = "559cd7c0d2cc47f271aac422412fce677a51443ec365d9f2c585d9c0e377cc0b";
const family = (path: string, base: string) => path === base || path.startsWith(base + "/");
export const windowsEmployeeStagingPath = (path: string) => family(path, "/api/staff/files") || family(path, "/api/admin/employee-files");
const unavailable = () => Response.json({ error: "windows_files_unavailable" }, { status: 503,
  headers: { "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
function key(text: string | undefined): Uint8Array {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(text)) throw Error();
  const decoded = atob(text.replace(/-/gu, "+").replace(/_/gu, "/") + "=");
  const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
  if (bytes.length !== 32 || btoa(decoded).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "") !== text) throw Error();
  return bytes;
}
/** The generated staging main supplies build-time public metadata. Only fixed
 * secret slots are read here; origins/IDs never come from env or a request. */
export function createWindowsEmployeeStagingWorker(profile: WindowsEmployeeStagingProfile, fallback: Fallback) {
  const captured = Object.freeze({ enabled: profile?.enabled === true, gateway: Object.freeze({ ...profile?.gateway }) });
  return {
    async fetch(request: Request, env: StagingEnv, ctx: ExecutionContext): Promise<Response> {
      if (!windowsEmployeeStagingPath(new URL(request.url).pathname)) return fallback.fetch(request, env, ctx);
      if (!captured.enabled || env.ENVIRONMENT !== "staging" || env.PUBLIC_BASE_URL !== ORIGIN
        || env.EXPECTED_HOST !== new URL(ORIGIN).host || env.TEAM_DOMAIN !== ISSUER || env.OPERATIONS_AUD !== AUDIENCE) return unavailable();
      try {
        const router = createWindowsEmployeeFilesStagingRouter({ environment: "staging", enabled: true,
          opsOrigin: ORIGIN, access: { enabled: true, issuer: ISSUER, staffAudience: AUDIENCE }, gateway: { ...captured.gateway,
            key: key(env.WINDOWS_EMPLOYEE_GATEWAY_SIGNING_KEY) }, handleKey: key(env.WINDOWS_EMPLOYEE_HANDLE_KEY), queueKey: key(env.WINDOWS_EMPLOYEE_QUEUE_KEY) }, { database: env.OPS_DB });
        return await router.fetch(request);
      } catch { return unavailable(); }
    },
    queue: fallback.queue,
    scheduled: fallback.scheduled,
  };
}
