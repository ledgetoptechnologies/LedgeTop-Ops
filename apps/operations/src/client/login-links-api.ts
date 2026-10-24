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
const TOKEN_PART = /^[A-Za-z0-9._~-]{1,512}$/;

export const loadLoginLinks = (signal?: AbortSignal) => api<LoginLinks>(LOGIN_LINKS_PATH, { signal });

/** Creates a fresh single-use link. A lost response can't be recovered, so callers offer a new link instead of retrying. */
export const createLoginLinkIntent = (email: string) =>
  api<LoginLinkIntent>(`${LOGIN_LINKS_PATH}/intents`, { method: "POST", body: JSON.stringify({ email }) });

export const removeLoginLink = (binding: LoginLinkBinding) =>
  api<{ bindingId: string; version: number; status: "revoked" }>(`${LOGIN_LINKS_PATH}/${encodeURIComponent(binding.id)}`,
    { method: "DELETE", body: JSON.stringify({ expectedVersion: binding.version }) });

export type ClaimResult = { kind: "linked" } | { kind: "invalid" | "sign-in" | "conflict" | "unavailable"; message?: string };

/**
 * Confirms the pending link with the current Access sign-in. It runs before any Operations session exists, so it sends
 * no staff CSRF token: the server checks the origin, the single-use token and a fresh Access sign-in instead.
 */
export async function claimLoginLink(pending: PendingLoginLink): Promise<ClaimResult> {
  let response: Response;
  try {
    response = await fetch(`${LOGIN_LINKS_PATH}/claim`, {
      method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intentId: pending.intentId, verificationToken: pending.token }), signal: AbortSignal.timeout(15000),
    });
  } catch { return { kind: "unavailable" }; }
  if (response.ok) return { kind: "linked" };
  const payload = await response.json().catch(() => ({})) as { error?: unknown };
  const message = typeof payload.error === "string" ? payload.error : undefined;
  if (response.status === 400) return { kind: "invalid", message };
  if (response.status === 401 || response.status === 403) return { kind: "sign-in", message };
  if (response.status === 409) return { kind: "conflict", message };
  return { kind: "unavailable", message };
}

/** Reads `#intent=…&token=…` from a verification link; null for anything else. */
export function pendingFromHash(hash: string): PendingLoginLink | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const intentId = params.get("intent") ?? "", token = params.get("token") ?? "";
  return TOKEN_PART.test(intentId) && TOKEN_PART.test(token) ? { intentId, token } : null;
}

/** The pending link inside a verification URL, only when it points at this host's link page. */
export function pendingFromVerificationUrl(value: string, origin = location.origin): PendingLoginLink | null {
  try {
    const url = new URL(value, origin);
    return url.origin === origin && url.pathname === LINK_LOGIN_PATH ? pendingFromHash(url.hash) : null;
  } catch { return null; }
}

export function savePendingLoginLink(pending: PendingLoginLink) {
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending)); } catch { /* the page keeps it in memory */ }
}

export function readPendingLoginLink(): PendingLoginLink | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null") as Partial<PendingLoginLink> | null;
    return typeof value?.intentId === "string" && typeof value.token === "string" && TOKEN_PART.test(value.intentId) && TOKEN_PART.test(value.token)
      ? { intentId: value.intentId, token: value.token } : null;
  } catch { return null; }
}

export function clearPendingLoginLink() {
  try { sessionStorage.removeItem(PENDING_KEY); } catch { /* nothing stored */ }
}

export const loginLinksUnavailable = (caught: unknown) => caught instanceof ApiError && caught.status === 404;
