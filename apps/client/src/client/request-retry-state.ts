export type RequestAttemptKind = "service" | "inquiry";
export type RequestAttemptState = "first_send" | "uncertain";
export type RequestAttempt = Readonly<{
  kind: RequestAttemptKind;
  key: string;
  body: string;
  state: RequestAttemptState;
}>;

export function createRequestAttempt(kind: RequestAttemptKind, key: string, body: string): RequestAttempt {
  if ((kind !== "service" && kind !== "inquiry") || typeof key !== "string" || !key
    || typeof body !== "string" || !body) throw new TypeError("Invalid request attempt");
  return Object.freeze({ kind, key, body, state: "first_send" });
}

export function markRequestAttemptUncertain(attempt: RequestAttempt): RequestAttempt {
  return attempt.state === "uncertain" ? attempt : Object.freeze({ ...attempt, state: "uncertain" });
}

/** Only failures that prove the first attempt was rejected may release its key.
 * Once delivery is uncertain, every failure keeps the exact body and key. */
export function requestAttemptFailureIsDefinite(
  attempt: RequestAttempt,
  status: number,
  code?: string,
): boolean {
  if (attempt.state === "uncertain") return false;
  if ([400, 404, 405, 422].includes(status)) return true;
  return status === 409 && (code === "catalog_changed" || code === "idempotency_conflict");
}
