import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
export interface AccessEnvironment { TEAM_DOMAIN: string; CF_ACCESS_AUD: string; }

// Portal snapshot pages share this authenticated ingress. Allow bounded room
// for the signed outer envelope; the private Client receiver independently
// preserves its 256 KiB limit on the embedded projection.
export const MAX_BODY_BYTES = 320 * 1024;
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** The declared length is only an early rejection, never the memory bound. */
export async function readWebhookBody(request: Request, timeoutMs = 10_000): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new Error("payload-too-large");
  if (!request.body) throw new Error("payload-size-invalid");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const expiresAt = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("payload-read-timeout")), timeoutMs);
  });
  let complete = false;
  try {
    while (true) {
      const result = await Promise.race([reader.read(), deadline]);
      if (Date.now() > expiresAt) throw new Error("payload-read-timeout");
      if (result.done) break;
      if (!result.value.byteLength) continue;
      bytes += result.value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new Error("payload-too-large");
      chunks.push(result.value);
    }
    if (bytes === 0) throw new Error("payload-size-invalid");
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    complete = true;
    return body;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function requireAccessSubject(claims: unknown, expected: string): void {
  if (!expected || !claims || typeof claims !== "object" || !("sub" in claims) || claims.sub !== expected) {
    throw new Error("access-subject-invalid");
  }
}

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

function base64UrlBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("signature-invalid");
  try {
    const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
    return Uint8Array.from(raw, (character) => character.charCodeAt(0));
  } catch { throw new Error("signature-invalid"); }
}

async function verifyEd25519(rawBody: Uint8Array, timestamp: string, signature: Uint8Array, publicKey: string): Promise<boolean> {
  const keyBytes = base64UrlBytes(publicKey);
  if (keyBytes.byteLength !== 32 || signature.byteLength !== 64) return false;
  const encoder = new TextEncoder();
  const prefix = encoder.encode(`${timestamp}.`);
  const message = new Uint8Array(prefix.length + rawBody.length);
  message.set(prefix);
  message.set(rawBody, prefix.length);
  const key = await crypto.subtle.importKey("raw", keyBytes.buffer as ArrayBuffer, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, signature.buffer as ArrayBuffer, message.buffer as ArrayBuffer);
}

export async function verifyWebhookSignature(
  rawBody: Uint8Array,
  timestamp: string,
  ed25519Header: string | null,
  currentPublicKey: string | undefined,
  previousPublicKey: string | undefined,
  legacyHmacHeader: string | null,
  legacyHmacSecret: string,
  allowLegacyHmac: boolean,
  previousLegacyHmacSecret?: string,
): Promise<"ed25519-current" | "ed25519-previous" | "hmac-legacy"> {
  if (ed25519Header) {
    if (!ed25519Header.startsWith("ed25519=")) throw new Error("signature-invalid");
    const signature = base64UrlBytes(ed25519Header.slice("ed25519=".length));
    if (currentPublicKey && await verifyEd25519(rawBody, timestamp, signature, currentPublicKey)) return "ed25519-current";
    if (previousPublicKey && await verifyEd25519(rawBody, timestamp, signature, previousPublicKey)) return "ed25519-previous";
    throw new Error("signature-invalid");
  }
  if (!allowLegacyHmac) throw new Error("signature-required");
  try { await verifyWebhookHmac(rawBody, timestamp, legacyHmacHeader, legacyHmacSecret); }
  catch (error) {
    if (!previousLegacyHmacSecret || !(error instanceof Error) || error.message !== "signature-invalid") throw error;
    await verifyWebhookHmac(rawBody,timestamp,legacyHmacHeader,previousLegacyHmacSecret);
  }
  return "hmac-legacy";
}

export async function sha256Hex(value: Uint8Array): Promise<string> {
  const copy = new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
