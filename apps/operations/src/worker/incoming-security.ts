import { HTTPException } from "hono/http-exception";
import { hmac, timingSafeEqual } from "./crypto";

const encoder = new TextEncoder();

export function incomingConstantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(left, right);
}

export async function createIncomingSession(
  secret: string,
  requestId: string,
  contributorId: string,
  sessionVersion: number,
  expiresAt: number,
): Promise<string> {
  const signature = await hmac(secret, `${requestId}:${contributorId}:${sessionVersion}:${expiresAt}`);
  const value = `${requestId}.${contributorId}.${sessionVersion}.${expiresAt}.${signature}`;
  return `__Host-ltds_incoming=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}; HttpOnly; Secure; SameSite=Strict`;
}

export async function verifyIncomingSession(
  secret: string,
  cookie: string | undefined,
  expectedRequestId: string,
  expectedSessionVersion: number,
): Promise<{ contributorId: string; expiresAt: number }> {
  const raw = (cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("__Host-ltds_incoming="))
    ?.slice("__Host-ltds_incoming=".length);
  if (!raw) throw new HTTPException(401, { message: "Upload session required" });
  const [requestId, contributorId, versionRaw, expiresRaw, signature] = decodeURIComponent(raw).split(".");
  const sessionVersion = Number(versionRaw);
  const expiresAt = Number(expiresRaw);
  if (
    requestId !== expectedRequestId
    || !contributorId
    || !signature
    || sessionVersion !== expectedSessionVersion
    || !Number.isSafeInteger(expiresAt)
    || expiresAt <= Date.now()
  ) {
    throw new HTTPException(401, { message: "Upload session expired" });
  }
  const expected = await hmac(secret, `${requestId}:${contributorId}:${sessionVersion}:${expiresAt}`);
  if (!timingSafeEqual(expected, signature)) throw new HTTPException(401, { message: "Invalid upload session" });
  return { contributorId, expiresAt };
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function digest(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function hmacBytes(secret: string | Uint8Array, value: string): Promise<ArrayBuffer> {
  const source = typeof secret === "string" ? encoder.encode(secret) : secret;
  const raw = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, encoder.encode(value));
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function signingKey(secret: string, date: string): Promise<Uint8Array> {
  const dateKey = new Uint8Array(await hmacBytes(`AWS4${secret}`, date));
  const regionKey = new Uint8Array(await hmacBytes(dateKey, "auto"));
  const serviceKey = new Uint8Array(await hmacBytes(regionKey, "s3"));
  return new Uint8Array(await hmacBytes(serviceKey, "aws4_request"));
}

export async function presignIncomingPart(input: {
  accountId: string;
  bucket: string;
  key: string;
  uploadId: string;
  partNumber: number;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSeconds?: number;
  now?: Date;
}): Promise<string> {
  if (!/^[a-f0-9]{32}$/i.test(input.accountId) || !input.bucket || !input.accessKeyId || !input.secretAccessKey) {
    throw new Error("R2 incoming upload signing is not configured");
  }
  if (!Number.isInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > 10_000) {
    throw new HTTPException(400, { message: "Invalid multipart part number" });
  }
  const expires = Math.min(900, Math.max(30, input.expiresSeconds ?? 300));
  const now = input.now ?? new Date();
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = timestamp.slice(0, 8);
  const host = `${input.accountId}.r2.cloudflarestorage.com`;
  const path = `/${awsEncode(input.bucket)}/${input.key.split("/").map(awsEncode).join("/")}`;
  const scope = `${date}/auto/s3/aws4_request`;
  const parameters = new Map<string, string>([
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD"],
    ["X-Amz-Credential", `${input.accessKeyId}/${scope}`],
    ["X-Amz-Date", timestamp],
    ["X-Amz-Expires", String(expires)],
    ["X-Amz-SignedHeaders", "host"],
    ["partNumber", String(input.partNumber)],
    ["uploadId", input.uploadId],
  ]);
  const query = [...parameters]
    .map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const canonical = `PUT\n${path}\n${query}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${await digest(canonical)}`;
  const signature = hex(await hmacBytes(await signingKey(input.secretAccessKey, date), stringToSign));
  return `https://${host}${path}?${query}&X-Amz-Signature=${signature}`;
}

const blockedExtensions = new Set([
  "app", "bat", "cmd", "com", "cpl", "dll", "exe", "gadget", "hta", "htm", "html", "jar", "js", "jse", "lnk", "mjs",
  "msi", "msp", "pif", "ps1", "reg", "scr", "sct", "sh", "svg", "vbe", "vbs", "ws", "wsc", "wsf", "wsh", "xhtml", "xml",
]);

export function validateIncomingFile(name: string, contentType: string, size: number): string {
  const normalized = name.normalize("NFC").trim();
  if (!normalized || normalized.length > 255 || /[\\/\0-\x1f\x7f]/.test(normalized) || normalized === "." || normalized === "..") {
    throw new HTTPException(400, { message: "Invalid file name" });
  }
  const extension = normalized.includes(".") ? normalized.split(".").pop()!.toLowerCase() : "";
  if (blockedExtensions.has(extension)) throw new HTTPException(415, { message: "That file type is not accepted" });
  const mime = contentType.toLowerCase().split(";")[0]!.trim();
  if (/^(text\/html|image\/svg\+xml|application\/(javascript|x-javascript|xml|x-msdownload|x-sh|x-powershell))$/.test(mime)) {
    throw new HTTPException(415, { message: "That file type is not accepted" });
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > 2 * 1024 ** 4) {
    throw new HTTPException(413, { message: "File size is outside the allowed range" });
  }
  return normalized;
}

export function incomingMultipartPartSize(size: number): number {
  if (!Number.isSafeInteger(size) || size <= 0) throw new HTTPException(400, { message: "Invalid upload size" });
  const minimum = 32 * 1024 ** 2;
  const fiveMiB = 5 * 1024 ** 2;
  const required = Math.ceil(size / 10_000);
  return Math.max(minimum, Math.ceil(required / fiveMiB) * fiveMiB);
}

export function hasBlockedIncomingMagic(bytes: Uint8Array): boolean {
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) return true;
  const prefix = new TextDecoder().decode(bytes.slice(0, 256)).trimStart().toLowerCase();
  return prefix.startsWith("<!doctype html")
    || prefix.startsWith("<html")
    || prefix.startsWith("<svg")
    || prefix.startsWith("#!")
    || prefix.startsWith("<script")
    || prefix.startsWith("<?xml");
}
