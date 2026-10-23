import { Hono } from "hono";
import { createEmployeeReadRouter } from "./employee-read-routes";
import { createEmployeeQueueRouter } from "./employee-queue-routes";
import { createEmployeeReadAdminRouter } from "./employee-read-admin-routes";
import type { NativeStaffAccessConfiguration } from "./native-staff-auth";
import type { EmployeeGatewayConfiguration } from "./employee-read-transport";

const OPS_ORIGIN = "https://ops-staging.ledgetopdroneservices.com";
const ACCESS_ISSUER = "https://ledgetoptechnologies.cloudflareaccess.com";
// Public application identifier from the production Wrangler configuration.
// A staging hostname must never admit the production staff application token.
const PRODUCTION_STAFF_AUDIENCE = "d09e298c864b9c8f4491b4b42a4dbe2ecbf558b5868d18258443740e56032407";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type WindowsEmployeeFilesStagingConfiguration = Readonly<{
  environment: "staging"; enabled: boolean; opsOrigin: string;
  access: NativeStaffAccessConfiguration; gateway: EmployeeGatewayConfiguration;
  handleKey: Uint8Array; queueKey: Uint8Array;
}>;
type Dependencies = Readonly<{ database: D1Database; fetch?: typeof fetch }>;
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function key(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length < 32 || value.length > 128) throw Error();
  return new Uint8Array(value);
}
function sameKey(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
function snapshot(input: WindowsEmployeeFilesStagingConfiguration, dependencies: Dependencies) {
  if (!exact(input, ["environment", "enabled", "opsOrigin", "access", "gateway", "handleKey", "queueKey"])
    || input.environment !== "staging" || input.enabled !== true || input.opsOrigin !== OPS_ORIGIN
    || !exact(input.access, ["enabled", "issuer", "staffAudience"])
    || input.access.enabled !== true || input.access.issuer !== ACCESS_ISSUER
    || typeof input.access.staffAudience !== "string" || !/^[A-Za-z0-9_-]{16,128}$/u.test(input.access.staffAudience)
    || input.access.staffAudience === PRODUCTION_STAFF_AUDIENCE
    || !exact(input.gateway, ["origin", "gatewayId", "keyId", "key"])
    || typeof input.gateway.origin !== "string" || typeof input.gateway.gatewayId !== "string" || !UUID.test(input.gateway.gatewayId)
    || typeof input.gateway.keyId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(input.gateway.keyId)
    || !dependencies?.database || typeof dependencies.database.withSession !== "function"
    || dependencies.fetch !== undefined && typeof dependencies.fetch !== "function") throw Error();
  const origin = new URL(input.gateway.origin);
  // Naming admission is not DNS/TLS/deployment evidence. The operator must review
  // the actual staging backend and its local synthetic mounts before activation.
  if (origin.protocol !== "https:" || origin.origin !== input.gateway.origin || origin.port || origin.username || origin.password
    || origin.pathname !== "/" || origin.search || origin.hash || origin.origin === OPS_ORIGIN
    || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-)?staging\.(?:ledgetopdroneservices|ledgetoptechnologies)\.com$/u.test(origin.hostname)) throw Error();
  const gatewayKey = key(input.gateway.key), handleKey = key(input.handleKey), queueKey = key(input.queueKey);
  if (sameKey(gatewayKey, handleKey) || sameKey(gatewayKey, queueKey) || sameKey(handleKey, queueKey)) throw Error();
  return Object.freeze({ enabled: true, opsOrigin: OPS_ORIGIN,
    access: Object.freeze({ enabled: true, issuer: ACCESS_ISSUER, staffAudience: input.access.staffAudience }),
    gateway: Object.freeze({ origin: origin.origin, gatewayId: input.gateway.gatewayId, keyId: input.gateway.keyId, key: gatewayKey }),
    handleKey, queueKey });
}

/** Source-only composition. Neither entrypoint imports or mounts it. A caller
 * must separately prove the supplied D1 binding is staging; a D1 object alone
 * cannot establish its remote account/database identity. No enrollment occurs. */
export function createWindowsEmployeeFilesStagingRouter(input: WindowsEmployeeFilesStagingConfiguration, dependencies: Dependencies) {
  const router = new Hono();
  const unavailable = () => Response.json({ error: "windows_files_unavailable" }, { status: 503,
    headers: { "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  let config: ReturnType<typeof snapshot>;
  try { config = snapshot(input, dependencies); }
  catch {
    router.all("/api/staff/files/*", unavailable);
    router.all("/api/admin/employee-files/*", unavailable);
    return router;
  }
  const captured = Object.freeze({ database: dependencies.database, fetch: dependencies.fetch });
  // Register the narrower queue middleware first; the broader read router must
  // not consume queue requests before their own exact query/identity checks.
  router.route("/", createEmployeeQueueRouter(config, captured));
  router.route("/", createEmployeeReadRouter(config, captured));
  router.route("/", createEmployeeReadAdminRouter({ enabled: true, opsOrigin: config.opsOrigin,
    access: config.access, gatewayIds: [config.gateway.gatewayId] }, captured));
  return router;
}
