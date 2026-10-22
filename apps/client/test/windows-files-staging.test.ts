import { beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createWindowsPortalStagingRouter, type WindowsPortalStagingConfiguration } from "../src/worker/client-portal/windows-files-staging";
import type { WindowsPortalCatalogRouteEnv } from "../src/worker/client-portal/windows-portal-catalog-routes";

const keys = vi.hoisted(() => vi.fn());
vi.mock("jose", async () => ({ ...await vi.importActual<typeof import("jose")>("jose"), createRemoteJWKSet: keys }));
const origin = "https://portal-staging.ledgetopdroneservices.com", issuer = "https://ledgetoptechnologies.cloudflareaccess.com", audience = "staging-human-app";
const base = "/api/client/operations/data/";
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => {
  pair = await generateKeyPair("RS256", { extractable: true });
  const publicKey = await exportJWK(pair.publicKey); publicKey.kid = "staging";
  keys.mockReturnValue(createLocalJWKSet({ keys: [publicKey] }));
});
function setup() {
  const query = vi.fn(async () => ({ success: true, results: [] })), storage = vi.fn();
  const env = { ENVIRONMENT: "staging", CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_ORIGIN: origin,
    CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED: "true", CLIENT_ACCESS_TEAM_DOMAIN: issuer, CLIENT_ACCESS_AUD: audience,
    DELIVERY_DB: { withSession: () => ({ prepare: () => ({ bind: () => ({ all: query }) }) }) },
    DATA_BUCKET: { head: storage, get: storage } } as unknown as WindowsPortalCatalogRouteEnv;
  const config: WindowsPortalStagingConfiguration = { enabled: true, portalOrigin: origin, issuer, audience, queueKey: new Uint8Array(32).fill(7),
    deployment: { accountId: "a".repeat(32), workerName: "synthetic-client-staging", databaseId: "00000000-0000-4000-8000-000000000001",
      bucketName: "synthetic-data-staging", opsReaderWorkerName: "synthetic-ops-staging" } };
  const resources = { DELIVERY_DB: env.DELIVERY_DB, DATA_BUCKET: env.DATA_BUCKET };
  return { env, config, resources, query, storage };
}
async function token(claims: Record<string, unknown> = {}, aud: string | string[] = audience) {
  return new SignJWT({ type: "app", email: "synthetic@example.invalid", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "staging" }).setIssuer(issuer).setSubject("synthetic-person")
    .setAudience(aud).setExpirationTime("1h").sign(pair.privateKey);
}
const request = (path: string, jwt?: string, headers: HeadersInit = {}) => new Request(origin + base + path,
  { headers: { ...(jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {}), ...headers } });

describe("source-only staging Windows portal composition", () => {
  it("mounts all three route families while retaining mandatory human authentication", async () => {
    const f = setup(), router = createWindowsPortalStagingRouter(f.config, f.resources);
    for (const path of ["windows-catalog/deliveries", "windows-successor/files/wsp1_invalid/download", "queue/session"])
      expect((await router.fetch(request(path), f.env)).status).toBe(401);
    expect(f.query).not.toHaveBeenCalled(); expect(f.storage).not.toHaveBeenCalled();
    expect((await router.fetch(new Request(origin + "/api/client/operations/data/deliveries"), f.env)).status).toBe(404);
  });
  it("admits an exact signed human to the queue and empty catalog, without byte access", async () => {
    const f = setup(), router = createWindowsPortalStagingRouter(f.config, f.resources), jwt = await token();
    const queue = await router.fetch(request("queue/session", jwt), f.env);
    expect(queue.status).toBe(200); expect(await queue.json()).toMatchObject({ schemaVersion: 1, principalId: expect.stringMatching(/^odqp1_[a-f0-9]{64}$/u) });
    const catalog = await router.fetch(request("windows-catalog/deliveries", jwt), f.env);
    expect(catalog.status).toBe(200); expect(await catalog.json()).toMatchObject({ items: [], page: { nextCursor: null } });
    expect((await router.fetch(request("windows-successor/files/wsp1_invalid/download", jwt), f.env)).status).toBe(404);
    expect(f.query).toHaveBeenCalledTimes(1); expect(f.storage).not.toHaveBeenCalled();
  });
  it("rejects production, resource swaps and existing native deployment denial before authentication or data reads", async () => {
    const f = setup(), router = createWindowsPortalStagingRouter(f.config, f.resources);
    for (const changed of [{ ENVIRONMENT: "production" }, { CLIENT_PORTAL_ORIGIN: "https://portal.ledgetopdroneservices.com" },
      { CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE: "invented-profile" }, { DELIVERY_DB: {} }, { DATA_BUCKET: {} }])
      for (const path of ["windows-catalog/deliveries", "windows-successor/files/wsp1_invalid/download", "queue/session"]) {
        const response = await router.fetch(request(path), { ...f.env, ...changed } as WindowsPortalCatalogRouteEnv);
        expect(response.status).toBe(503); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      }
    expect(f.query).not.toHaveBeenCalled(); expect(f.storage).not.toHaveBeenCalled();
  });
  it("keeps disabled configuration restrictive even if caller mutates the original config", async () => {
    const f = setup(), config = { ...f.config, enabled: false }, router = createWindowsPortalStagingRouter(config, f.resources);
    config.enabled = true;
    for (const path of ["windows-catalog/deliveries", "windows-successor/files/wsp1_invalid/download", "queue/session"])
      expect((await router.fetch(request(path), f.env)).status).toBe(503);
    expect(f.query).not.toHaveBeenCalled(); expect(f.storage).not.toHaveBeenCalled();
  });
  it("snapshots enabled constructor fields, key bytes and resource references against later caller mutation", async () => {
    const f = setup(), config = { ...f.config, deployment: { ...f.config.deployment } };
    const router = createWindowsPortalStagingRouter(config, f.resources), jwt = await token();
    const before = await (await router.fetch(request("queue/session", jwt), f.env)).json() as { principalId: string };
    config.enabled = false; config.portalOrigin = "https://portal.ledgetopdroneservices.com";
    config.issuer = "https://example.invalid"; config.audience = "another-human-app";
    config.queueKey.fill(99); config.deployment.databaseId = "7f40a7b7-c3ec-470e-a626-e798867f71f8";
    f.resources.DELIVERY_DB = {} as D1Database; f.resources.DATA_BUCKET = {} as R2Bucket;
    const after = await router.fetch(request("queue/session", jwt), f.env);
    expect(after.status).toBe(200); expect(await after.json()).toMatchObject({ principalId: before.principalId });
    expect((await router.fetch(request("windows-catalog/deliveries", jwt), f.env)).status).toBe(200);
    expect((await router.fetch(request("queue/session", jwt), { ...f.env, ...f.resources })).status).toBe(503);
    expect(f.query).toHaveBeenCalledTimes(1); expect(f.storage).not.toHaveBeenCalled();
  });
  it("rejects malformed or production constructor declarations without touching resources", () => {
    const f = setup();
    const invalid = [{ enabled: "true" }, { portalOrigin: "https://portal.ledgetopdroneservices.com" }, { portalOrigin: origin + "/" },
      { issuer: issuer + "/" }, { issuer: "https://example.invalid" }, { audience: "one,two" }, { audience: "short" },
      { audience: "0fa9c4453634e4c74d4522e2d44407a49701320b06d8f21d8a58efa21e5f947f" },
      { audience: { toString: () => audience } }, { queueKey: new Uint8Array(31) }, { unexpected: true }, { deployment: null },
      ...[{ workerName: "ledgetop-clients" }, { opsReaderWorkerName: "ledgetop-ops" }, { bucketName: "client-data" },
        { accountId: "invalid" }, { databaseId: "7f40a7b7-c3ec-470e-a626-e798867f71f8" }].map(d => ({ deployment: { ...f.config.deployment, ...d } }))];
    for (const patch of invalid) expect(() => createWindowsPortalStagingRouter({ ...f.config, ...patch } as WindowsPortalStagingConfiguration, f.resources))
      .toThrow("windows_portal_staging_configuration");
    for (const value of [null, undefined, [], true])
      expect(() => createWindowsPortalStagingRouter(value as unknown as WindowsPortalStagingConfiguration, f.resources)).toThrow("windows_portal_staging_configuration");
    expect(() => createWindowsPortalStagingRouter(f.config, null as never)).toThrow("windows_portal_staging_configuration");
    expect(f.query).not.toHaveBeenCalled(); expect(f.storage).not.toHaveBeenCalled();
  });
  it("rejects reusing the handle secret as the queue key before authentication", async () => {
    const f = setup(), router = createWindowsPortalStagingRouter({ ...f.config, queueKey: new TextEncoder().encode("x".repeat(32)) }, f.resources);
    for (const path of ["windows-catalog/deliveries", "windows-successor/files/wsp1_invalid/download", "queue/session"])
      expect((await router.fetch(request(path), { ...f.env, DELIVERY_SESSION_SECRET: "x".repeat(32) })).status).toBe(503);
    expect(f.query).not.toHaveBeenCalled(); expect(f.storage).not.toHaveBeenCalled();
  });
  it("also rejects reusing a previous handle secret during key rotation", async () => {
    const f = setup(), router = createWindowsPortalStagingRouter({ ...f.config, queueKey: new TextEncoder().encode("x".repeat(32)) }, f.resources);
    for (const path of ["windows-catalog/deliveries", "windows-successor/files/wsp1_invalid/download", "queue/session"])
      expect((await router.fetch(request(path), { ...f.env, DELIVERY_SESSION_SECRET: "y".repeat(32), DELIVERY_PREVIOUS_SESSION_SECRET: "x".repeat(32) })).status).toBe(503);
    expect(f.query).not.toHaveBeenCalled(); expect(f.storage).not.toHaveBeenCalled();
  });
  it("preserves exact audience, human type, origin and method restrictions of composed factories", async () => {
    const f = setup(), router = createWindowsPortalStagingRouter(f.config, f.resources);
    for (const jwt of [await token({}, "another-app"), await token({}, [audience, "another-app"]), await token({ type: "service" })])
      for (const path of ["windows-catalog/deliveries", "windows-successor/files/wsp1_invalid/download", "queue/session"])
        expect((await router.fetch(request(path, jwt), f.env)).status).toBe(401);
    const jwt = await token();
    for (const path of ["windows-catalog/deliveries", "windows-successor/files/wsp1_invalid/download", "queue/session"]) {
      expect((await router.fetch(request(path, jwt, { Origin: "https://example.invalid" }), f.env)).status).toBe(403);
      expect((await router.fetch(new Request(request(path, jwt), { method: "POST" }), f.env)).status).toBe(405);
    }
    expect(f.query).not.toHaveBeenCalled(); expect(f.storage).not.toHaveBeenCalled();
  });
});
