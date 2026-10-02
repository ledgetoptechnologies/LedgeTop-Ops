import { z } from "zod";

/** Encrypted continuation state for the bounded Project Alpha inventory route.
 * The upstream cursor can contain external record identifiers, so it must not
 * be returned to browser code or included in audit metadata. */
export type ProjectAlphaApiV2SyncSurface = "directory" | "projects";
export type ProjectAlphaApiV2SyncCursorPayload = Readonly<{
  v: 1;
  sourceId: string;
  surface: ProjectAlphaApiV2SyncSurface;
  limit: number;
  sourceInstanceId: string;
  applicationId: string;
  historyEpoch: string;
  authorizationGeneration: string;
  cursor: string;
  expires: number;
}>;

export interface ProjectAlphaApiV2SyncCursorEnvironment {
  OPERATIONS_SESSION_SECRET?: string;
}

const schema = z.object({
  v: z.literal(1),
  sourceId: z.string().regex(/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/),
  surface: z.enum(["directory", "projects"]),
  limit: z.number().int().min(1).max(200),
  sourceInstanceId: z.string().uuid(),
  applicationId: z.string().uuid(),
  historyEpoch: z.string().uuid(),
  authorizationGeneration: z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/),
  cursor: z.string().min(1).max(764).refine(value => !/\p{C}/u.test(value)),
  expires: z.number().int().positive(),
}).strict();

function b64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function unb64(value: string): ArrayBuffer {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0)).buffer as ArrayBuffer;
}
async function key(env: ProjectAlphaApiV2SyncCursorEnvironment): Promise<CryptoKey> {
  if (!env.OPERATIONS_SESSION_SECRET || env.OPERATIONS_SESSION_SECRET.length < 32)
    throw new Error("Project Alpha API-v2 continuation configuration unavailable");
  const material = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(`project-alpha-api-v2-sync-cursor:v1:${env.OPERATIONS_SESSION_SECRET}`));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encodeProjectAlphaApiV2SyncCursor(
  env: ProjectAlphaApiV2SyncCursorEnvironment,
  actorId: string,
  input: ProjectAlphaApiV2SyncCursorPayload,
): Promise<string> {
  const payload = schema.parse(input);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv,
    additionalData: new TextEncoder().encode(`project-alpha-api-v2-sync:${actorId}`) }, await key(env),
  new TextEncoder().encode(JSON.stringify(payload)));
  return `${b64(iv)}.${b64(new Uint8Array(encrypted))}`;
}

export async function decodeProjectAlphaApiV2SyncCursor(
  env: ProjectAlphaApiV2SyncCursorEnvironment,
  actorId: string,
  token: string,
  expected: Readonly<{ sourceId: string; surface: ProjectAlphaApiV2SyncSurface; limit: number }>,
  now = Date.now(),
): Promise<ProjectAlphaApiV2SyncCursorPayload> {
  let payload: ProjectAlphaApiV2SyncCursorPayload;
  try {
    if (token.length > 2048) throw new Error();
    const parts = token.split(".");
    if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]+$/u.test(part))) throw new Error();
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(parts[0]!),
      additionalData: new TextEncoder().encode(`project-alpha-api-v2-sync:${actorId}`) }, await key(env), unb64(parts[1]!));
    payload = schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)));
  } catch { throw new Error("Project Alpha API-v2 continuation is invalid"); }
  if (payload.sourceId !== expected.sourceId || payload.surface !== expected.surface || payload.limit !== expected.limit
    || payload.expires <= now) throw new Error("Project Alpha API-v2 continuation is stale");
  return payload;
}
