/** Non-authorizing durable selectors. No assertion, URL or byte handle belongs here. */
export type QueueContext = Readonly<{ source: "employee" | "portal"; origin: string; issuer: string; audience: string; key: Uint8Array }>;
export type QueueReference = Readonly<{ v: 1; principalId: string; issuedAt: number; expiresAt: number; resource: Record<string, unknown> }>;
const encoder = new TextEncoder(), MAX = 16_384, TTL = 30 * 86400;
export function queueContext(input: QueueContext): QueueContext {
  const c = { ...input, key: new Uint8Array(input.key) };
  const origin = new URL(c.origin), issuer = new URL(c.issuer);
  if (!["employee", "portal"].includes(c.source) || origin.protocol !== "https:" || origin.origin !== c.origin
    || issuer.protocol !== "https:" || issuer.origin !== c.issuer || !issuer.hostname.endsWith(".cloudflareaccess.com")
    || issuer.hostname === ".cloudflareaccess.com" || issuer.port || !/^[A-Za-z0-9_-]{16,128}$/u.test(c.audience) || c.key.length < 32 || c.key.length > 128) throw Error("queue_configuration");
  return Object.freeze(c);
}
function aad(c: QueueContext) { return encoder.encode(JSON.stringify(["windows-read-queue-v1", c.source, c.origin, c.issuer, c.audience])); }
async function key(c: QueueContext, purpose: "reference" | "principal") {
  const base = await crypto.subtle.importKey("raw", new Uint8Array(c.key), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: await crypto.subtle.digest("SHA-256", aad(c)), info: encoder.encode("windows-read-queue-" + purpose + "-v1") }, base,
    purpose === "reference" ? { name: "AES-GCM", length: 256 } : { name: "HMAC", hash: "SHA-256", length: 256 }, false,
    purpose === "reference" ? ["encrypt", "decrypt"] : ["sign"]);
}
export async function queuePrincipal(input: QueueContext, identity: readonly (string | number)[]): Promise<string> {
  const c = queueContext(input), bytes = encoder.encode(JSON.stringify(identity));
  if (!identity.length || identity.some(v => typeof v === "string" ? !v || v.length > 1024 : !Number.isSafeInteger(v) || v < 1) || bytes.length > 4096) throw Error("queue_identity");
  const signed = new Uint8Array(await crypto.subtle.sign("HMAC", await key(c, "principal"), bytes));
  return "odqp1_" + Array.from(signed, v => v.toString(16).padStart(2, "0")).join("");
}
function base64(bytes: Uint8Array) { let s = ""; for (const v of bytes) s += String.fromCharCode(v); return btoa(s).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, ""); }
function valid(v: QueueReference): boolean {
  const now = Math.floor(Date.now() / 1000);
  return !!v && Object.keys(v).sort().join() === "expiresAt,issuedAt,principalId,resource,v" && v.v === 1
    && /^odqp1_[a-f0-9]{64}$/u.test(v.principalId) && Number.isSafeInteger(v.issuedAt) && v.issuedAt > 0 && v.issuedAt <= now
    && Number.isSafeInteger(v.expiresAt) && v.expiresAt > now && v.expiresAt <= v.issuedAt + TTL
    && !!v.resource && typeof v.resource === "object" && !Array.isArray(v.resource) && Object.getPrototypeOf(v.resource) === Object.prototype;
}
export async function encodeQueueReference(input: QueueContext, principalId: string, resource: Record<string, unknown>): Promise<string> {
  const c = queueContext(input), now = Math.floor(Date.now() / 1000);
  // Snapshot all caller-owned claims before cryptographic awaits.
  const value: QueueReference = JSON.parse(JSON.stringify({ v: 1, principalId, issuedAt: now, expiresAt: now + TTL, resource }));
  if (!valid(value)) throw Error("queue_reference");
  const bytes = encoder.encode(JSON.stringify(value)); if (bytes.length > 12_000) throw Error("queue_reference");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(c) }, await key(c, "reference"), bytes));
  const result = new Uint8Array(12 + encrypted.length); result.set(iv); result.set(encrypted, 12);
  const token = "odqr1_" + base64(result); if (token.length > MAX) throw Error("queue_reference"); return token;
}
export async function decodeQueueReference(input: QueueContext, token: string): Promise<QueueReference | null> {
  try {
    const c = queueContext(input);
    if (typeof token !== "string" || token.length > MAX || !/^odqr1_[A-Za-z0-9_-]+$/u.test(token)) return null;
    const raw = token.slice(6), bytes = Uint8Array.from(atob(raw.replace(/-/gu, "+").replace(/_/gu, "/")), c => c.charCodeAt(0));
    if (bytes.length < 29 || base64(bytes) !== raw) return null;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: aad(c) }, await key(c, "reference"), bytes.slice(12));
    if (plain.byteLength > 12_000) return null;
    // Only this module creates authenticated plaintext; require its exact canonical encoding.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(plain), value = JSON.parse(text) as QueueReference;
    return JSON.stringify(value) === text && valid(value) ? value : null;
  } catch { return null; }
}
/** Parse exactly once; aliases, duplicate/unknown fields and malformed escapes fail closed. */
export function queueQuery(url: string, allowed: readonly string[], required = allowed): Map<string, string> {
  const raw = new URL(url).search.slice(1), values = new Map<string, string>();
  if (raw.length > 25_000) throw Error("queue_query");
  if (raw) for (const part of raw.split("&")) {
    const i = part.indexOf("="); if (i < 0) throw Error("queue_query");
    const k = decodeURIComponent(part.slice(0, i).replace(/\+/gu, " ")), v = decodeURIComponent(part.slice(i + 1).replace(/\+/gu, " "));
    if (!allowed.includes(k) || values.has(k)) throw Error("queue_query"); values.set(k, v);
  }
  if (required.some(k => !values.has(k))) throw Error("queue_query"); return values;
}
