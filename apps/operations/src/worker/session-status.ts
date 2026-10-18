import type { StaffPrincipal } from "./types";

/** Uses only the expiry supplied by verified Access authentication. */
export function staffSessionStatus(principal: Pick<StaffPrincipal, "id" | "accessExpiresAt">, now = Date.now()) {
  const expiry = principal.accessExpiresAt;
  const milliseconds = typeof expiry === "number" && Number.isSafeInteger(expiry) && expiry > 0
    ? expiry * 1000 : NaN;
  return {
    userId: principal.id,
    expiresAt: Number.isFinite(milliseconds) && milliseconds <= 8.64e15
      ? new Date(milliseconds).toISOString() : null,
    serverTime: new Date(now).toISOString(),
  };
}
