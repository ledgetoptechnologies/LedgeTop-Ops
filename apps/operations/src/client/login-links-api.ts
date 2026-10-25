import { ApiError, api } from "./api";

/** Other emails that open the same Operations staff profile. The main email is never listed or removed here. */
export type LoginLinkBinding = { id: string; email: string; version: number; status: "active" | "revoked"; createdAt: string; revokedAt: string | null };
export type LoginLinks = { canonicalEmail: string; currentEmail: string; canManage: boolean; bindings: LoginLinkBinding[] };
export type LoginLinkIntent = { intentId: string; targetEmail: string; verificationUrl: string; expiresAt: string };
/** A verification link waiting to be confirmed while signed in with the email being added. Kept only in this tab. */
export type PendingLoginLink = { intentId: string; token: string };

export const LOGIN_LINKS_PATH = "/api/account/login-links";
export const LINK_LOGIN_PATH = "/auth/link-login";
const PENDING_KEY = "ops.login-link.pending";
const INTENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const BINDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isVersion = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const validPending = (intentId: unknown, token: unknown): intentId is string =>
  typeof intentId === "string" && typeof token === "string" && INTENT_ID.test(intentId) && TOKEN.test(token);

export const loadLoginLinks = (signal?: AbortSignal) => api<LoginLinks>(LOGIN_LINKS_PATH, { signal });

/** Creates a fresh single-use link. A lost response can't be recovered, so callers offer a new link instead of retrying. */
export const createLoginLinkIntent = (email: string) =>
  api<LoginLinkIntent>(`${LOGIN_LINKS_PATH}/intents`, { method: "POST", body: JSON.stringify({ email }) });

/** Removes a linked email at the version shown. Retrying with the same version is safe; an unclear answer throws. */
export async function removeLoginLink(binding: LoginLinkBinding) {
  const result = await api<{ bindingId?: unknown; version?: unknown; status?: unknown }>(`${LOGIN_LINKS_PATH}/${encodeURIComponent(binding.id)}`,
    { method: "DELETE", body: JSON.stringify({ expectedVersion: binding.version }) });
  if (result.bindingId !== binding.id || result.status !== "revoked" || !isVersion(result.version)) throw new Error("unconfirmed removal");
}

/** Whose profile a pending link joins, shown before anything is linked. */
export type LoginLinkPreview = { canonicalEmail: string; ownerDisplayName: string; targetEmail: string; expiresAt: string; state: "pending" | "linked" };
type Refusal = { kind: "invalid" | "sign-in" | "conflict"; message?: string };
/** "unknown" means the link may or may not have been made; retrying the same link is safe and tells which. */
export type ClaimResult = { kind: "linked" } | Refusal | { kind: "unknown" };
export type PreviewResult = { kind: "preview"; preview: LoginLinkPreview } | { kind: "linked" } | Refusal | { kind: "unknown" };

/**
 * Both link-page requests run before any Operations session exists, so they send no staff CSRF token: the server
 * checks the origin, the single-use token and a fresh Access sign-in instead. Null means no clear answer arrived.
 */
async function postPending(path: string, pending: PendingLoginLink): Promise<{ status: number; payload: Record<string, unknown> } | null> {
  try {
    const response = await fetch(`${LOGIN_LINKS_PATH}/${path}`, {
      method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intentId: pending.intentId, verificationToken: pending.token }), signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json().catch(() => ({})) as unknown;
    return { status: response.status, payload: payload && typeof payload === "object" ? payload as Record<string, unknown> : {} };
  } catch { return null; }
}
function refusal(status: number, payload: Record<string, unknown>): Refusal | null {
  const message = typeof payload.error === "string" ? payload.error : undefined;
  return status === 400 ? { kind: "invalid", message } : status === 401 || status === 403 ? { kind: "sign-in", message }
    : status === 409 ? { kind: "conflict", message } : null;
}
const text = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.length <= 320;

/** Reads whose profile the link joins without changing anything. */
export async function previewLoginLink(pending: PendingLoginLink): Promise<PreviewResult> {
  const answer = await postPending("preview-claim", pending);
  if (!answer) return { kind: "unknown" };
  const { status, payload } = answer;
  if (status >= 200 && status < 300) {
    const valid = text(payload.canonicalEmail) && text(payload.ownerDisplayName) && text(payload.targetEmail) && text(payload.expiresAt)
      && (payload.state === "pending" || payload.state === "linked");
    if (!valid) return { kind: "unknown" };
    return payload.state === "linked" ? { kind: "linked" } : { kind: "preview", preview: payload as unknown as LoginLinkPreview };
  }
  return refusal(status, payload) ?? { kind: "unknown" };
}

/** Links the current Access email to the previewed profile. Only a well-formed answer counts as linked. */
export async function claimLoginLink(pending: PendingLoginLink): Promise<ClaimResult> {
  const answer = await postPending("claim", pending);
  if (!answer) return { kind: "unknown" };
  const { status, payload } = answer;
  if (status >= 200 && status < 300)
    return typeof payload.bindingId === "string" && BINDING_ID.test(payload.bindingId) && isVersion(payload.version) ? { kind: "linked" } : { kind: "unknown" };
  return refusal(status, payload) ?? { kind: "unknown" };
}

/** Reads `#intent=…&token=…` from a verification link; null for anything else. */
export function pendingFromHash(hash: string): PendingLoginLink | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const intentId = params.get("intent") ?? "", token = params.get("token") ?? "";
  return validPending(intentId, token) ? { intentId, token } : null;
}

/** The pending link inside a verification URL, only when it points at this host's link page. */
export function pendingFromVerificationUrl(value: string, origin = location.origin): PendingLoginLink | null {
  try {
    const url = new URL(value, origin);
    return url.origin === origin && url.pathname === LINK_LOGIN_PATH ? pendingFromHash(url.hash) : null;
  } catch { return null; }
}

/** False when this browser won't keep the link (for example, storage is blocked), so a sign-out would lose it. */
export function savePendingLoginLink(pending: PendingLoginLink): boolean {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    return readPendingLoginLink()?.token === pending.token;
  } catch { return false; }
}

export function readPendingLoginLink(): PendingLoginLink | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null") as Partial<PendingLoginLink> | null;
    return validPending(value?.intentId, value?.token) ? { intentId: value.intentId, token: value.token as string } : null;
  } catch { return null; }
}

export function clearPendingLoginLink() {
  try { sessionStorage.removeItem(PENDING_KEY); } catch { /* nothing stored */ }
}

export const loginLinksUnavailable = (caught: unknown) => caught instanceof ApiError && caught.status === 404;
