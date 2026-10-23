import { z } from "zod";
import { canonicalEmployeeReadPath, type EmployeeReadProof } from "./employee-read-transport";
import { isNativeAccessSubject } from "./native-access-subject";
import { parseDuplicateFreeJson } from "./bounded-json";

const encoder = new TextEncoder(), PREFIX = "eof1_", MAX = 16_384;
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
const positive = z.number().int().positive().refine(Number.isSafeInteger);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const proofSchema = z.object({ gatewayId: uuid, rootId: uuid, rootGeneration: positive, rootFingerprint: digest,
  staffId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/u), accessSubject: z.string().refine(isNativeAccessSubject),
  admissionVersion: positive, profileVersion: positive, grantId: uuid, grantGeneration: positive,
  verifiedUntil: z.string().datetime().refine(value => Date.parse(value) > Date.now()),
}).strict();
const schema = z.object({ v: z.literal(1), proof: proofSchema, path: z.string().refine(value => canonicalEmployeeReadPath(value, false)),
  snapshotId: uuid, sha256: digest, size: z.number().int().min(0).max(1_099_511_627_776), expiresAt: positive,
}).strict().refine(value => value.expiresAt > Math.floor(Date.now() / 1000)
  && value.expiresAt <= Math.floor(Date.now() / 1000) + 900 && value.expiresAt * 1000 <= Date.parse(value.proof.verifiedUntil));

export type EmployeeFileHandle = z.infer<typeof schema>;
export type EmployeeHandleContext = Readonly<{ opsOrigin: string; issuer: string; audience: string; key: Uint8Array }>;

/** Snapshot deployment context before any asynchronous cryptographic operation. */
export function employeeHandleContext(input: EmployeeHandleContext): EmployeeHandleContext {
  const value = { opsOrigin: input.opsOrigin, issuer: input.issuer, audience: input.audience, key: new Uint8Array(input.key) };
  const origin = new URL(value.opsOrigin), issuer = new URL(value.issuer);
  if (origin.protocol !== "https:" || origin.origin !== value.opsOrigin || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
    || issuer.protocol !== "https:" || issuer.origin !== value.issuer || !issuer.hostname.endsWith(".cloudflareaccess.com") || issuer.hostname === ".cloudflareaccess.com" || issuer.port
    || issuer.username || issuer.password || issuer.pathname !== "/" || issuer.search || issuer.hash
    || !/^[A-Za-z0-9_-]{16,128}$/u.test(value.audience) || value.key.length < 32 || value.key.length > 128) throw Error("employee_handle_configuration");
  return Object.freeze(value);
}
function aad(context: EmployeeHandleContext): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(["ops-employee-file-handle-v1", context.opsOrigin, context.issuer, context.audience]));
}
async function subkey(context: EmployeeHandleContext, purpose: "encryption" | "logical-id"): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new Uint8Array(context.key), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: await crypto.subtle.digest("SHA-256", aad(context)),
    info: encoder.encode(`ops-employee-file-${purpose}-v1`) }, base,
  purpose === "encryption" ? { name: "AES-GCM", length: 256 } : { name: "HMAC", hash: "SHA-256", length: 256 }, false,
  purpose === "encryption" ? ["encrypt", "decrypt"] : ["sign"]);
}
function base64(bytes: Uint8Array): string {
  let raw = ""; for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** Encrypted selector only: every read still requires fresh native authority. */
export async function encodeEmployeeFileHandle(inputContext: EmployeeHandleContext, input: EmployeeFileHandle): Promise<string> {
  const context = employeeHandleContext(inputContext), value = schema.parse(input), bytes = encoder.encode(JSON.stringify(value));
  if (bytes.length > 12_000) throw Error("employee_handle_invalid");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(context) }, await subkey(context, "encryption"), bytes));
  const output = new Uint8Array(iv.length + encrypted.length); output.set(iv); output.set(encrypted, iv.length);
  const token = PREFIX + base64(output); if (token.length > MAX) throw Error("employee_handle_invalid");
  return token;
}
export async function decodeEmployeeFileHandle(inputContext: EmployeeHandleContext, token: string): Promise<EmployeeFileHandle | null> {
  try {
    const context = employeeHandleContext(inputContext);
    if (typeof token !== "string" || token.length > MAX || !/^eof1_[A-Za-z0-9_-]+$/u.test(token)) return null;
    const raw = token.slice(PREFIX.length), bytes = Uint8Array.from(atob(raw.replace(/-/gu, "+").replace(/_/gu, "/")), c => c.charCodeAt(0));
    if (bytes.length < 29 || base64(bytes) !== raw) return null;
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: aad(context) },
      await subkey(context, "encryption"), bytes.slice(12));
    if (plaintext.byteLength > 12_000) return null;
    const parsed = schema.safeParse(parseDuplicateFreeJson(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export function employeeFileProofMatches(handle: EmployeeFileHandle, current: EmployeeReadProof): boolean {
  const pins = ["gatewayId", "rootId", "rootGeneration", "rootFingerprint", "staffId", "accessSubject", "admissionVersion", "profileVersion", "grantId", "grantGeneration"] as const;
  return pins.every(pin => handle.proof[pin] === current[pin]) && Date.parse(current.verifiedUntil) >= handle.expiresAt * 1000;
}
/** Stable across prepared-copy renewal and profile edits; never a storage key or grant. */
export async function employeeLogicalFileId(inputContext: EmployeeHandleContext, proof: EmployeeReadProof, path: string): Promise<string> {
  const context = employeeHandleContext(inputContext), p = proofSchema.parse(proof);
  if (!canonicalEmployeeReadPath(path, false)) throw Error("employee_handle_invalid");
  const material = encoder.encode(JSON.stringify(["ops-employee-logical-file-v1", p.gatewayId, p.rootId, p.rootGeneration,
    p.rootFingerprint, p.staffId, p.accessSubject, p.admissionVersion, p.grantId, p.grantGeneration, path]));
  const signed = new Uint8Array(await crypto.subtle.sign("HMAC", await subkey(context, "logical-id"), material));
  return "oef1_" + Array.from(signed, value => value.toString(16).padStart(2, "0")).join("");
}
