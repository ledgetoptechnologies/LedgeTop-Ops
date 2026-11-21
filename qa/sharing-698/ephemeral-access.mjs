// QA fixture for #698 (not for merge). Test-only, ephemeral Cloudflare Access
// style assertions for the fixture principals. In-process API only: there is no
// command line and nothing is written to disk. Each signer makes a fresh RS256
// key pair in memory; the private key is non-extractable and never exported.
// The products verify these with their existing verifiers (jose jwtVerify,
// RS256, issuer + audience + exp); serving the JWKS is the QA launcher's job.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const encoder = new TextEncoder();
const base64url = bytes => Buffer.from(bytes).toString("base64url");

export function fixtureAccess() {
  return JSON.parse(readFileSync(path.join(fixtureDir, "contract.json"), "utf8")).access;
}

/** One in-memory signer. Returns the public JWKS and a mint function. */
export async function createEphemeralAccessSigner() {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    false, ["sign", "verify"]);
  const kid = `qa698-${crypto.randomUUID()}`;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid, alg: "RS256", use: "sig" };
  delete jwk.key_ops; delete jwk.ext;
  async function mint(claims, { ttlSeconds = 900 } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(encoder.encode(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })));
    const payload = base64url(encoder.encode(JSON.stringify({ iat: now - 5, nbf: now - 5, exp: now + ttlSeconds, type: "app", ...claims })));
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, encoder.encode(`${header}.${payload}`));
    return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
  }
  return { jwks: { keys: [jwk] }, mint };
}

/** Assertions for every fixture principal, keyed by the contract's principal names. */
export async function mintFixtureAssertions(signer = undefined) {
  const access = fixtureAccess(), active = signer ?? await createEphemeralAccessSigner();
  const assertions = {};
  for (const [name, principal] of Object.entries(access.clients))
    assertions[name] = await active.mint({ iss: access.clientIssuer, aud: [access.clientAudience], sub: principal.subject, email: principal.email });
  for (const [name, principal] of Object.entries(access.staff))
    assertions[name] = await active.mint({ iss: access.staffIssuer, aud: [access.staffAudience], sub: principal.subject, email: principal.email });
  return { jwks: active.jwks, assertions };
}

