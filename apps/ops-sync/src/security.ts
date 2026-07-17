import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
interface AccessEnvironment { TEAM_DOMAIN: string; CF_ACCESS_AUD: string; }

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export async function verifyAccessAssertion(request: Request, env: AccessEnvironment): Promise<JWTPayload> {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) throw new Error("access-assertion-required");
  const issuer = env.TEAM_DOMAIN.replace(/\/$/, "");
  if (!issuer.startsWith("https://") || !env.CF_ACCESS_AUD) throw new Error("access-configuration-invalid");
  try {
    const verified = await jwtVerify(assertion, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)), {
      issuer,
      audience: env.CF_ACCESS_AUD,
      algorithms: ["RS256"],
    });
    return verified.payload;
  } catch {
    throw new Error("access-assertion-invalid");
  }
}

export function validateRequestTimestamp(value: string | null, now = Date.now()): string {
  if (!value) throw new Error("timestamp-required");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || Math.abs(now - parsed) > MAX_CLOCK_SKEW_MS) throw new Error("timestamp-invalid");
  return value;
}

export async function verifyWebhookHmac(rawBody: Uint8Array, timestamp: string, signatureHeader: string | null, secret: string): Promise<void> {
  if (!signatureHeader?.startsWith("sha256=") || !secret) throw new Error("signature-required");
  const suppliedHex = signatureHeader.slice(7);
  if (!/^[a-f0-9]{64}$/i.test(suppliedHex)) throw new Error("signature-invalid");
  const supplied = Uint8Array.from(suppliedHex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
  const encoder = new TextEncoder();
  const prefix = encoder.encode(`${timestamp}.`);
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const message = new Uint8Array(prefix.length + rawBody.length);
  message.set(prefix);
  message.set(rawBody, prefix.length);
  if (!(await crypto.subtle.verify("HMAC", key, supplied, message))) throw new Error("signature-invalid");
}

export async function sha256Hex(value: Uint8Array): Promise<string> {
  const copy = new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
