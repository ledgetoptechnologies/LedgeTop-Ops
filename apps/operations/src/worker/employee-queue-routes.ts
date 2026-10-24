import { Hono } from "hono";
import { queueContext, queuePrincipal, encodeQueueReference, decodeQueueReference, queueQuery } from "@ltds/shared/windows-queue-reference";
import { authenticateNativeStaffWithAdmissionVersion, type AuthenticatedNativeStaffWithAdmissionVersion, type NativeStaffAccessConfiguration } from "./native-staff-auth";
import { resolveEmployeeReadAuthority, recheckEmployeeReadAuthority, type EmployeeReadAuthority } from "./employee-read-authority";
import { canonicalEmployeeReadPath, type EmployeeGatewayConfiguration } from "./employee-read-transport";
import { employeeReadManifest } from "./employee-read-routes";
import { resolveCanonicalNativeStaffIdentityWithAdmissionVersion, resolveNativeStaffIdentityWithAdmissionVersion } from "./native-staff-identity";

type Configuration = Readonly<{ enabled: boolean; opsOrigin: string; access: NativeStaffAccessConfiguration; gateway: EmployeeGatewayConfiguration; handleKey: Uint8Array; queueKey: Uint8Array }>;
const pins = ["gatewayId", "rootId", "rootGeneration", "rootFingerprint", "staffId", "accessSubject", "admissionVersion", "grantId", "grantGeneration"] as const;
const resource = (p: EmployeeReadAuthority, path: string) => Object.fromEntries([...pins.map(k => [k, p[k]]), ["path", path]]);
const error = (status: number) => Response.json({ error: "queue_unavailable" }, { status, headers: { "Cache-Control": "private, no-store" } });

/** Source-only: callers must explicitly mount and configure this factory. */
export function createEmployeeQueueRouter(input: Configuration, dependencies: Readonly<{ database: D1Database; fetch?: typeof fetch }>) {
  const config = { ...input, access: { ...input.access }, gateway: { ...input.gateway, key: new Uint8Array(input.gateway.key) }, handleKey: new Uint8Array(input.handleKey), queueKey: new Uint8Array(input.queueKey) };
  const db = dependencies.database, deps = { database: db, fetch: dependencies.fetch };
  const context = queueContext({ source: "employee", origin: config.opsOrigin, issuer: config.access.issuer, audience: config.access.staffAudience, key: config.queueKey });
  const router = new Hono<{ Variables: { auth: AuthenticatedNativeStaffWithAdmissionVersion } }>().basePath("/api/staff/files/queue");
  router.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store"); c.header("Cloudflare-CDN-Cache-Control", "no-store"); c.header("X-Content-Type-Options", "nosniff");
    if (!config.enabled || !config.access.enabled) return error(503);
    if (new URL(c.req.url).origin !== config.opsOrigin || c.req.header("Origin") !== undefined && c.req.header("Origin") !== config.opsOrigin || c.req.header("Sec-Fetch-Site")?.toLowerCase() === "cross-site") return error(403);
    if (c.req.method !== "GET") return error(405);
    try { c.set("auth", await authenticateNativeStaffWithAdmissionVersion(c.req.raw, db, config.access)); } catch { return error(401); }
    return next();
  });
  const principal = (a: AuthenticatedNativeStaffWithAdmissionVersion) => queuePrincipal(context, [a.identity.verifiedAccessSubject, a.identity.staffId, a.admissionVersion]);
  router.get("/session", async c => {
    queueQuery(c.req.url, []); const a = c.get("auth"), principalId = await principal(a);
    // Retain alternate-login evidence through this fresh native re-resolution.
    const fresh = a.verifiedLogin
      ? await resolveCanonicalNativeStaffIdentityWithAdmissionVersion(db, a.verifiedLogin)
      : await resolveNativeStaffIdentityWithAdmissionVersion(db, { verifiedEmail: a.identity.email, verifiedAccessSubject: a.identity.verifiedAccessSubject });
    if (!fresh || fresh.identity.staffId !== a.identity.staffId || fresh.admissionVersion !== a.admissionVersion
      || fresh.identity.profileVersion !== a.identity.profileVersion || Date.parse(a.verifiedUntil) <= Date.now()) return error(401);
    return c.json({ schemaVersion: 1, principalId, expiresAt: Math.floor(Date.parse(a.verifiedUntil) / 1000) });
  });
  for (const operation of ["reference", "resolve"] as const) router.get("/" + operation, async c => {
    const a = c.get("auth"), principalId = await principal(a);
    let path: string, rootId: string, previous: Record<string, unknown> | null = null;
    if (operation === "reference") {
      const q = queueQuery(c.req.url, ["rootId", "path"]); rootId = q.get("rootId")!; path = q.get("path")!;
    } else {
      const q = queueQuery(c.req.url, ["resourceRef"]), reference = await decodeQueueReference(context, q.get("resourceRef")!);
      if (!reference || reference.principalId !== principalId) return error(409);
      previous = reference.resource; rootId = String(previous.rootId ?? ""); path = String(previous.path ?? "");
    }
    if (!canonicalEmployeeReadPath(path, false)) return error(400);
    const proof = await resolveEmployeeReadAuthority(db, a, rootId, previous ? String(previous.grantId ?? "") : undefined);
    if (!proof || proof.gatewayId !== config.gateway.gatewayId) return error(403);
    const selected = resource(proof, path);
    if (previous && (Object.keys(previous).length !== Object.keys(selected).length || Object.entries(selected).some(([k, v]) => previous![k] !== v))) return error(409);
    if (operation === "reference") {
      const resourceRef = await encodeQueueReference(context, principalId, selected);
      if (!await recheckEmployeeReadAuthority(db, proof)) return error(403);
      return c.json({ schemaVersion: 1, principalId, resourceRef });
    }
    const response = await employeeReadManifest(config, deps, proof, path, c.req.raw.signal);
    if (response.status !== 200) return response;
    const manifest: unknown = await response.json();
    if (!await recheckEmployeeReadAuthority(db, proof)) return error(403);
    return c.json({ schemaVersion: 1, principalId, manifest });
  });
  router.onError(() => error(503)); return router;
}
