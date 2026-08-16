import { HTTPException } from "hono/http-exception";
import type { ShareRow } from "./types";

export const PUBLIC_SHARE_SESSION_MS = 12 * 60 * 60 * 1000;
export const PUBLIC_SHARE_RENEWAL_WINDOW_MS = 2 * 60 * 60 * 1000;

export type PublicShareLifecycleRow = ShareRow & {
  project_active: number;
  project_exists: number;
};

export type PublicShareLifecycleOutcome =
  | "active"
  | "expired"
  | "revoked"
  | "project_inactive"
  | "resource_removed";

const outcomes: Record<Exclude<PublicShareLifecycleOutcome, "active">, {
  status: 410;
  code: string;
  message: string;
}> = {
  expired: { status: 410, code: "SHARE_EXPIRED", message: "This delivery link has expired." },
  revoked: { status: 410, code: "SHARE_REVOKED", message: "This delivery link has been revoked." },
  project_inactive: { status: 410, code: "SHARE_PROJECT_INACTIVE", message: "This delivery project is no longer active." },
  resource_removed: { status: 410, code: "SHARE_RESOURCE_REMOVED", message: "The shared folder was moved or removed." },
};

export function classifyPublicShareLifecycle(row: Pick<PublicShareLifecycleRow,
  "revoked_at" | "revoked_reason" | "expires_at" | "project_active" | "project_exists"
>, now = Date.now()): PublicShareLifecycleOutcome {
  if (row.project_exists === 0 || row.revoked_reason === "folder_unavailable") return "resource_removed";
  if (row.revoked_reason === "project_inactive" || row.project_active === 0) return "project_inactive";
  if (row.revoked_reason === "expired") return "expired";
  if (row.revoked_at) return "revoked";
  if (row.expires_at) {
    const expiresAt = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return "expired";
  }
  return "active";
}

export function publicShareLifecycleException(outcome: Exclude<PublicShareLifecycleOutcome, "active">): HTTPException {
  const value = outcomes[outcome];
  return new HTTPException(value.status, { message: value.message, cause: { code: value.code } });
}

export function temporaryPublicShareException(layer: "database" | "storage"): HTTPException {
  return new HTTPException(503, {
    message: "This delivery is temporarily unavailable. Please try again.",
    cause: { code: "SHARE_TEMPORARILY_UNAVAILABLE", layer },
  });
}

export function publicShareSessionExpiresAt(shareExpiresAt: string | null, now = Date.now()): number {
  const shareExpiry = shareExpiresAt ? Date.parse(shareExpiresAt) : Number.POSITIVE_INFINITY;
  return Math.min(now + PUBLIC_SHARE_SESSION_MS, Number.isFinite(shareExpiry) ? shareExpiry : Number.POSITIVE_INFINITY);
}

export function shouldRenewPublicShareSession(input: {
  sessionExpiresAt: number;
  cookieKeyId: string | null;
  currentKeyId: string;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  return input.cookieKeyId !== input.currentKeyId || input.sessionExpiresAt - now <= PUBLIC_SHARE_RENEWAL_WINDOW_MS;
}

export function logPublicShareOutcome(request: Request, input: {
  outcome: string;
  status: number;
  shareId?: string | null;
  layer?: "database" | "storage";
}): void {
  const record = {
    event: "public_share.lifecycle",
    outcome: input.outcome,
    status: input.status,
    shareId: input.shareId || undefined,
    layer: input.layer,
    method: request.method,
    pathKind: new URL(request.url).pathname.includes("/session") ? "session" : "protected",
    rayId: request.headers.get("CF-Ray") || undefined,
  };
  if (input.status >= 500) console.error(record);
  else if (input.status >= 400) console.warn(record);
  else console.log(record);
}
