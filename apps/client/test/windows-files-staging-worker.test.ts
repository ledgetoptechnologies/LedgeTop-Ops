import { beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createWindowsPortalStagingWorker, windowsPortalStagingPath } from "../src/worker/client-portal/windows-files-staging-worker";
const keys = vi.hoisted(() => vi.fn());
vi.mock("jose", async () => ({ ...await vi.importActual<typeof import("jose")>("jose"), createRemoteJWKSet: keys }));
const origin = "https://portal-staging.ledgetopdroneservices.com", issuer = "https://ledgetoptechnologies.cloudflareaccess.com";
const audience = "8eed2de9972afe7d653de2adb68c1b0ef7c6462a9a694203b31d9a32f4248bbc";
let jwt: string;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true }), publicKey = await exportJWK(pair.publicKey); publicKey.kid = "local-staging-wrapper";
  keys.mockReturnValue(createLocalJWKSet({ keys: [publicKey] }));
  jwt = await new SignJWT({ type: "app", email: "synthetic@example.invalid" }).setProtectedHeader({ alg: "RS256", kid: publicKey.kid })
    .setIssuer(issuer).setSubject("synthetic-wrapper-person").setAudience(audience).setExpirationTime("1h").sign(pair.privateKey);
});
function setup() {
  const query = vi.fn(async () => ({ success: true, results: [] }));
  const fetch = vi.fn(async () => new Response("legacy", { status: 418 })), scheduled = vi.fn();
  const env = { ENVIRONMENT: "staging", CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_ORIGIN: origin, CLIENT_ACCESS_TEAM_DOMAIN: issuer, CLIENT_ACCESS_AUD: audience,
    CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED: "true", DELIVERY_SESSION_SECRET: "x".repeat(40), WINDOWS_PORTAL_QUEUE_KEY: Buffer.alloc(32, 9).toString("base64url"),
    DELIVERY_DB: { withSession: () => ({ prepare: () => ({ bind: () => ({ all: query }) }) }) }, DATA_BUCKET: { head: vi.fn(), get: vi.fn() } };
  const profile = { enabled: true, deployment: { accountId: "846c924bf17bf4f3dd15c97a4c5d1d51", workerName: "ledgetop-clients-staging", databaseId: "b6f653ab-9acd-4421-9ad0-207754b59aeb", bucketName: "client-data-staging", opsReaderWorkerName: "ledgetop-ops-staging" } };
  const worker = createWindowsPortalStagingWorker(profile, { fetch, scheduled });
  const call = (path: string, method = "GET", assertion?: string) => worker.fetch(new Request(origin + path, { method, headers: assertion ? { "Cf-Access-Jwt-Assertion": assertion } : {} }), env as never, {} as ExecutionContext);
  return { worker, profile, env, fetch, scheduled, query, call };
}
describe("generated staging Client main composition", () => {
  it("routes actual signed human queue/catalog HTTP and preserves scheduled/fallback", async () => {
    const h = setup();
    expect((await h.call("/api/client/operations/data/queue/session", "GET", jwt)).status).toBe(200);
    expect((await h.call("/api/client/operations/data/windows-catalog/deliveries", "GET", jwt)).status).toBe(200);
    expect(h.query).toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
    expect((await h.call("/s/old-public-link")).status).toBe(418);
    expect(h.worker.scheduled).toBe(h.scheduled);
  });
  it.each(["windows-catalog", "windows-successor", "queue"])("owns every verb/root/subtree of %s, never rescuing auth or route denial", async family => {
    const h = setup(), base = "/api/client/operations/data/" + family;
    for (const path of [base, base + "/", base + "/unknown"]) for (const method of ["GET", "POST", "HEAD", "OPTIONS"])
      expect((await h.call(path, method)).status).not.toBe(418);
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.query).not.toHaveBeenCalled();
    for (const path of [base + "-other", base + "%2funknown", base + "%252funknown"]) expect(windowsPortalStagingPath(path)).toBe(false);
  });
  it.each(["", "x", "a".repeat(43), Buffer.alloc(31).toString("base64url"), Buffer.alloc(33).toString("base64url")])("fails closed for missing/noncanonical private key %s", async value => {
    const h = setup(); h.env.WINDOWS_PORTAL_QUEUE_KEY = value;
    expect((await h.call("/api/client/operations/data/queue/session", "GET", jwt)).status).toBe(503);
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.query).not.toHaveBeenCalled();
  });
  it("freezes disabled profile and refuses production/foreign audience without storage", async () => {
    const h = setup(); h.env.ENVIRONMENT = "production";
    expect((await h.call("/api/client/operations/data/queue/session", "GET", jwt)).status).toBe(503);
    h.env.ENVIRONMENT = "staging"; h.env.CLIENT_ACCESS_AUD = "wrong-app";
    expect((await h.call("/api/client/operations/data/queue/session", "GET", jwt)).status).toBe(503);
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.query).not.toHaveBeenCalled();
  });
  it("refuses ordinary secret reuse and preserves unrelated fallback rejection", async () => {
    const h = setup(); h.env.DELIVERY_SESSION_SECRET = "x".repeat(32);
    h.env.WINDOWS_PORTAL_QUEUE_KEY = Buffer.from(h.env.DELIVERY_SESSION_SECRET).toString("base64url");
    expect((await h.call("/api/client/operations/data/queue/session", "GET", jwt)).status).toBe(503);
    const failure = new Error("ordinary fallback error"); h.fetch.mockRejectedValue(failure);
    await expect(h.call("/s/old-link")).rejects.toBe(failure);
    expect(h.query).not.toHaveBeenCalled();
  });
});
