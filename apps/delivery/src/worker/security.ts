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

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
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

export async function verifyAccessCode(code: string, expected: string, salt: string, iterations: number, algorithm: string | null, pepper?: string): Promise<boolean> {
  if (code.length < 8) return false;
  if (algorithm === "hmac-sha256-v1") {
    if (!pepper) throw new Error("DELIVERY_ACCESS_CODE_PEPPER is required");
    return constantTimeEqual(await hmac(pepper, `access-code:v1:${salt}:${code}`), expected);
  }
  if (algorithm !== "pbkdf2-sha256-v1" || iterations < 50_000 || iterations > 1_000_000) return false;
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

export async function createSessionCookie(secret: string, keyId: string, shareId: string, shareVersion: number, expiresAt: number): Promise<string> {
  const signature = await hmac(secret, `${keyId}:${shareId}:${shareVersion}:${expiresAt}`);
  const value = `${keyId}.${shareId}.${shareVersion}.${expiresAt}.${signature}`;
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return `__Host-ltds_delivery=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export async function verifySessionCookie(secret: string, expectedKeyId: string, value: string | null): Promise<{ shareId: string; shareVersion: number; expiresAt: number }> {
  if (!value) throw new HTTPException(401, { message: "Delivery session required" });
  const [keyId, shareId, versionRaw, expiresRaw, signature] = value.split(".");
  const shareVersion = Number(versionRaw);
  const expiresAt = Number(expiresRaw);
  if (!keyId || keyId !== expectedKeyId || !shareId || !signature || !Number.isSafeInteger(shareVersion) || shareVersion < 1 || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
    throw new HTTPException(401, { message: "Delivery session expired" });
  }
  const expected = await hmac(secret, `${keyId}:${shareId}:${shareVersion}:${expiresAt}`);
  if (!constantTimeEqual(expected, signature)) throw new HTTPException(401, { message: "Invalid delivery session" });
  return { shareId, shareVersion, expiresAt };
}

export async function verifyRotatingSessionCookie(
  value: string | null,
  current: { keyId: string; secret: string },
  previous?: { keyId: string; secret: string } | null,
): Promise<{ shareId: string; shareVersion: number; expiresAt: number }> {
  const keyId = value?.split(".", 1)[0];
  if (keyId === current.keyId) return verifySessionCookie(current.secret, current.keyId, value);
  if (previous?.keyId && previous.secret && keyId === previous.keyId) return verifySessionCookie(previous.secret, previous.keyId, value);
  throw new HTTPException(401, { message: "Delivery session expired" });
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

async function hmacBytes(key: BufferSource, value: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value));
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalPath(value: string): string {
  return value.split("/").map(segment => awsEncode(segment)).join("/") || "/";
}

export interface R2PresignConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresInSeconds?: number;
  downloadName?: string;
}

export async function presignR2Get(config: R2PresignConfig, key: string, now = new Date()): Promise<{ url: string; expiresAt: string }> {
  const expiresIn = Math.min(120, Math.max(1, config.expiresInSeconds ?? 120));
  const endpoint = new URL(config.endpoint);
  const host = endpoint.host;
  const date = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const shortDate = date.slice(0, 8);
  const credentialScope = `${shortDate}/auto/s3/aws4_request`;
  const path = `${endpoint.pathname.replace(/\/$/, "")}/${config.bucket}/${key}`;
  const expiresAt = new Date(now.getTime() + expiresIn * 1000).toISOString();
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.accessKeyId}/${credentialScope}`,
    "X-Amz-Date": date,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": "host",
    "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
  };
  if (config.downloadName) {
    const normalized = config.downloadName.normalize("NFC");
    const ascii = normalized.replace(/[^\x20-\x7e]/g, "_").replace(/[\0-\x1f\x7f"\\]/g, "_").slice(0, 180) || "download";
    query["response-content-disposition"] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(normalized)}`;
  }
  const canonicalQuery = Object.keys(query).sort().map(name => `${awsEncode(name)}=${awsEncode(query[name]!)}`).join("&");
  const canonicalRequest = `GET\n${canonicalPath(path)}\n${canonicalQuery}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
  const requestHash = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(canonicalRequest))));
  const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${credentialScope}\n${requestHash}`;
  const dateKey = await hmacBytes(encoder.encode(`AWS4${config.secretAccessKey}`), shortDate);
  const regionKey = await hmacBytes(dateKey, "auto");
  const serviceKey = await hmacBytes(regionKey, "s3");
  const signingKey = await hmacBytes(serviceKey, "aws4_request");
  const signature = hex(new Uint8Array(await hmacBytes(signingKey, stringToSign)));
  const url = new URL(endpoint.toString()); url.pathname = path;
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  url.searchParams.set("X-Amz-Signature", signature);
  return { url: url.toString(), expiresAt };
}
