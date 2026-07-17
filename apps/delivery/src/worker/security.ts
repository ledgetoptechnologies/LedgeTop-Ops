import { HTTPException } from "hono/http-exception";

const encoder = new TextEncoder();

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomSecret(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64Url(value);
}

export async function sha256(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

export async function hmac(secret: string, value: string): Promise<string> {
  if (secret.length < 32) throw new Error("A cryptographic Worker secret is missing or too short");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left); const b = encoder.encode(right);
  const length = Math.max(a.byteLength, b.byteLength); let difference = a.byteLength ^ b.byteLength;
  for (let index = 0; index < length; index += 1) difference |= (a[index] || 0) ^ (b[index] || 0);
  return difference === 0;
}

export async function verifyAccessCode(code: string, expected: string, salt: string, iterations: number): Promise<boolean> {
  if (code.length < 8 || iterations < 50_000 || iterations > 1_000_000) return false;
  const material = await crypto.subtle.importKey("raw", encoder.encode(code), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations }, material, 256);
  return constantTimeEqual(base64Url(new Uint8Array(bits)), expected);
}

export function parseCookie(header: string | undefined, name: string): string | null {
  for (const entry of (header || "").split(";")) {
    const [key, ...parts] = entry.trim().split("=");
    if (key === name) return decodeURIComponent(parts.join("="));
  }
  return null;
}

export async function createSessionCookie(secret: string, keyId: string, shareId: string, expiresAt: number): Promise<string> {
  const signature = await hmac(secret, `${keyId}:${shareId}:${expiresAt}`);
  const value = `${keyId}.${shareId}.${expiresAt}.${signature}`;
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return `__Host-ltds_delivery=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export async function verifySessionCookie(secret: string, expectedKeyId: string, value: string | null): Promise<{ shareId: string; expiresAt: number }> {
  if (!value) throw new HTTPException(401, { message: "Delivery session required" });
  const [keyId, shareId, expiresRaw, signature] = value.split(".");
  const expiresAt = Number(expiresRaw);
  if (!keyId || keyId !== expectedKeyId || !shareId || !signature || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
    throw new HTTPException(401, { message: "Delivery session expired" });
  }
  const expected = await hmac(secret, `${keyId}:${shareId}:${expiresAt}`);
  if (!constantTimeEqual(expected, signature)) throw new HTTPException(401, { message: "Invalid delivery session" });
  return { shareId, expiresAt };
}
