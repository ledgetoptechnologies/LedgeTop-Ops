import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { clientAccessConfiguration, resolveCloudflareClientPrincipal, verifiedClientPrincipalFromAccessPayload } from "../src/worker/client-portal/access-identity";
import { clientAccessSyncSecretManifest, processClientAccessSyncBatch, type ClientAccessSyncCommand, type ClientAccessSyncOutbox } from "../src/worker/client-portal/access-sync";
import type { Env } from "../src/worker/types";

const configuration = { issuer: "https://team.cloudflareaccess.com", audience: "client-portal-aud" };
const accessEnv = {
  CLIENT_ACCESS_TEAM_DOMAIN: configuration.issuer,
  CLIENT_ACCESS_AUD: configuration.audience,
} as Env;

let accessPrivateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let localJwks: JWTVerifyGetKey;

beforeAll(async () => {
  const accessKeys = await generateKeyPair("RS256", { extractable: true });
  const otherKeys = await generateKeyPair("RS256", { extractable: true });
  const accessPublicJwk = await exportJWK(accessKeys.publicKey);
  accessPublicJwk.alg = "RS256";
  accessPublicJwk.kid = "client-access-key";
  accessPublicJwk.use = "sig";
  accessPrivateKey = accessKeys.privateKey;
  otherPrivateKey = otherKeys.privateKey;
  localJwks = createLocalJWKSet({ keys: [accessPublicJwk] });
});

function accessPayload(overrides: Partial<JWTPayload> = {}): JWTPayload {
  return {
    iss: configuration.issuer,
    aud: configuration.audience,
    type: "app",
    sub: "access-subject",
    email: "Client@Example.com",
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  };
}

async function signAccessToken(payload: JWTPayload = accessPayload(), key: CryptoKey = accessPrivateKey): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "client-access-key", typ: "JWT" })
    .sign(key);
}

function accessRequest(assertion: string): Request {
  return new Request("https://client.example/api/client/session", {
    headers: { "Cf-Access-Jwt-Assertion": assertion },
  });
}

describe("Client Portal Cloudflare Access identity boundary", () => {
  it("requires a dedicated HTTPS issuer and audience", () => {
    expect(clientAccessConfiguration({ CLIENT_ACCESS_TEAM_DOMAIN: configuration.issuer, CLIENT_ACCESS_AUD: configuration.audience } as Env)).toEqual(configuration);
    expect(() => clientAccessConfiguration({ CLIENT_ACCESS_TEAM_DOMAIN: "http://team.example", CLIENT_ACCESS_AUD: configuration.audience } as Env)).toThrow("client-access-configuration-invalid");
    expect(() => clientAccessConfiguration({ CLIENT_ACCESS_TEAM_DOMAIN: configuration.issuer, CLIENT_ACCESS_AUD: "" } as Env)).toThrow("client-access-configuration-invalid");
  });

  it("maps only a verified human Access application assertion", () => {
    expect(verifiedClientPrincipalFromAccessPayload({
      iss: configuration.issuer, aud: configuration.audience, type: "app", sub: "access-subject", email: "Client@Example.com", exp: 2_000_000_000,
    }, configuration)).toEqual({ issuer: configuration.issuer, subject: "access-subject", email: "client@example.com" });

    for (const payload of [
      { iss: configuration.issuer, aud: configuration.audience, type: "org", sub: "access-subject", email: "client@example.com", exp: 2_000_000_000 },
      { iss: configuration.issuer, aud: "staff-aud", type: "app", sub: "access-subject", email: "client@example.com", exp: 2_000_000_000 },
      { iss: configuration.issuer, aud: configuration.audience, type: "app", sub: "", email: "client@example.com", exp: 2_000_000_000 },
      { iss: configuration.issuer, aud: configuration.audience, type: "app", sub: "access-subject", email: "not-an-email", exp: 2_000_000_000 },
    ]) expect(verifiedClientPrincipalFromAccessPayload(payload, configuration)).toBeNull();
  });

  it("accepts a real RS256 Access application token without an email_verified claim", async () => {
    const principal = await resolveCloudflareClientPrincipal(accessRequest(await signAccessToken()), accessEnv, localJwks);
    expect(principal).toEqual({ issuer: configuration.issuer, subject: "access-subject", email: "client@example.com" });
  });

  it.each([
    ["issuer", { iss: "https://other-team.cloudflareaccess.com" }],
    ["audience", { aud: "staff-audience" }],
    ["token type", { type: "org" }],
    ["expiry", { exp: Math.floor(Date.now() / 1000) - 60 }],
    ["service-token subject", { sub: "" }],
  ] as const)("rejects a signed token with the wrong %s", async (_label, overrides) => {
    const token = await signAccessToken(accessPayload(overrides));
    expect(await resolveCloudflareClientPrincipal(accessRequest(token), accessEnv, localJwks)).toBeNull();
  });

  it("rejects a token signed by an untrusted RS256 key", async () => {
    const token = await signAccessToken(accessPayload(), otherPrivateKey);
    expect(await resolveCloudflareClientPrincipal(accessRequest(token), accessEnv, localJwks)).toBeNull();
  });

  it("rejects a token using an algorithm outside the RS256 allowlist", async () => {
    const token = await new SignJWT(accessPayload())
      .setProtectedHeader({ alg: "HS256", kid: "client-access-key", typ: "JWT" })
      .sign(new TextEncoder().encode("not-a-trusted-rsa-key"));
    expect(await resolveCloudflareClientPrincipal(accessRequest(token), accessEnv, localJwks)).toBeNull();
  });

  it("fails closed when JWKS resolution is unavailable", async () => {
    const unavailableJwks: JWTVerifyGetKey = async () => { throw new Error("jwks-unavailable"); };
    expect(await resolveCloudflareClientPrincipal(accessRequest(await signAccessToken()), accessEnv, unavailableJwks)).toBeNull();
  });

  it("declares the group-management token as an internal-only secret", () => {
    expect(clientAccessSyncSecretManifest).toEqual(["CLIENT_ACCESS_GROUP_API_TOKEN"]);
  });
});

describe("Client Portal Access sync seam", () => {
  const command: ClientAccessSyncCommand = {
    id: "outbox-1", accountId: "account-1", email: "client@example.com", action: "provision", attempt: 1, idempotencyKey: "client-access-v1:outbox-1",
  };

  it("batches durable commands with an idempotency key and retries a transport outage", async () => {
    let completed: unknown;
    const outbox: ClientAccessSyncOutbox = {
      claim: async () => [command],
      complete: async (_env, commands, results) => { completed = { commands, results }; },
    };
    const processed = await processClientAccessSyncBatch({} as Env, { dispatch: async () => { throw new Error("network"); } }, outbox);
    expect(processed).toBe(1);
    expect(completed).toEqual({ commands: [command], results: [{ id: "outbox-1", outcome: "retry", errorCode: "temporary" }] });
  });

  it("does not dispatch when no client membership work is pending", async () => {
    let dispatched = false;
    const outbox: ClientAccessSyncOutbox = { claim: async () => [], complete: async () => undefined };
    expect(await processClientAccessSyncBatch({} as Env, { dispatch: async () => { dispatched = true; return []; } }, outbox)).toBe(0);
    expect(dispatched).toBe(false);
  });
});
