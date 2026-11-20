// The renderer API's NAS link path: one Cloudflare Access service token, verified from its Access assertion, with
// the older shared bearer kept during the transition until THUMBNAIL_RENDERER_BEARER_RETIRED. Synthetic keys only.
import { beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { authorizeRenderer, dispatchThumbnailRendererApi } from "../src/worker/thumbnail-renderer-api";

const HOST = "incoming.example.test";
const SECRET = "thumbnail-renderer-secret-that-is-at-least-32-bytes";
const ISSUER = "https://ledgetoptechnologies.cloudflareaccess.com";
const AUD = "a".repeat(64);
const LINK = "nas-link.access";
let privateKey: CryptoKey, keyResolver: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256"); privateKey = pair.privateKey;
  keyResolver = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: "renderer-test", alg: "RS256" }] });
});

async function assertion(claims: Record<string, unknown> = {}, signer?: CryptoKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ type: "app", sub: "", common_name: LINK, iss: ISSUER, aud: [AUD], iat: now - 5, exp: now + 300, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "renderer-test" }).sign(signer ?? privateKey);
}
const env = (overrides: Record<string, string> = {}) => ({ THUMBNAIL_INGEST_EXPECTED_HOST: HOST, THUMBNAIL_INGEST_SECRET: SECRET,
  TEAM_DOMAIN: ISSUER, THUMBNAIL_RENDERER_ACCESS_AUD: AUD, THUMBNAIL_RENDERER_ACCESS_CLIENT_ID: LINK, ...overrides }) as never;
const request = (headers: Record<string, string>) =>
  new Request(`https://${HOST}/api/internal/thumbnail-renderer/v1/heartbeat`, { method: "POST", headers });

describe("thumbnail renderer API: NAS link Access identity", () => {
  it("accepts the NAS link token's Access assertion without the bearer", async () => {
    expect(await authorizeRenderer(request({ "Cf-Access-Jwt-Assertion": await assertion() }), env(), keyResolver)).toBe("access");
  });

  it("keeps the shared bearer working during the transition", async () => {
    expect(await authorizeRenderer(request({ Authorization: `Bearer ${SECRET}` }), env(), keyResolver)).toBe("bearer");
    expect(await authorizeRenderer(request({ Authorization: `Bearer ${SECRET}` }), env({ THUMBNAIL_RENDERER_ACCESS_AUD: "", THUMBNAIL_RENDERER_ACCESS_CLIENT_ID: "" }), keyResolver)).toBe("bearer");
  });

  it("refuses other tokens, other audiences, forged or expired assertions, and anything once the bearer is retired", async () => {
    const other = await generateKeyPair("RS256");
    const refused: Array<[string, Record<string, string>]> = [
      ["another service token", { "Cf-Access-Jwt-Assertion": await assertion({ common_name: "someone-else.access" }) }],
      ["another audience", { "Cf-Access-Jwt-Assertion": await assertion({ aud: ["b".repeat(64)] }) }],
      ["a forged signature", { "Cf-Access-Jwt-Assertion": await assertion({}, other.privateKey) }],
      ["an expired assertion", { "Cf-Access-Jwt-Assertion": await assertion({ iat: 1, exp: 2 }) }],
      ["a user (email) assertion", { "Cf-Access-Jwt-Assertion": await assertion({ email: "person@example.test" }) }],
      ["no credentials", {}],
      ["a wrong bearer", { Authorization: "Bearer wrong-secret-wrong-secret-wrong-secret" }],
    ];
    for (const [name, headers] of refused) expect(await authorizeRenderer(request(headers), env(), keyResolver), name).toBeNull();
    const retired = env({ THUMBNAIL_RENDERER_BEARER_RETIRED: "true" });
    expect(await authorizeRenderer(request({ Authorization: `Bearer ${SECRET}` }), retired, keyResolver)).toBeNull();
    expect(await authorizeRenderer(request({ "Cf-Access-Jwt-Assertion": await assertion() }), retired, keyResolver)).toBe("access");
    expect(await authorizeRenderer(request({ "Cf-Access-Jwt-Assertion": await assertion() }),
      env({ THUMBNAIL_RENDERER_ACCESS_CLIENT_ID: "", THUMBNAIL_RENDERER_BEARER_RETIRED: "true" }), keyResolver)).toBeNull();
  });

  it("returns 401 at the API for a refused request and keeps the host gate first", async () => {
    const refused = await dispatchThumbnailRendererApi(request({ "Cf-Access-Jwt-Assertion": await assertion({ common_name: "x.access" }) }), env(), { keyResolver });
    expect(refused?.status).toBe(401);
    const otherHost = await dispatchThumbnailRendererApi(new Request("https://elsewhere.example.test/api/internal/thumbnail-renderer/v1/heartbeat",
      { method: "POST", headers: { "Cf-Access-Jwt-Assertion": await assertion() } }), env(), { keyResolver });
    expect(otherHost).toBeNull();
  });
});
