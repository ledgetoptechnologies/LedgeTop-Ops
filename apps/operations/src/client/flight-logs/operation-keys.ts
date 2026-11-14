// One Idempotency-Key per user action. The same action retried after a lost answer (network error or a 5xx)
// reuses its key, so the Logs host can tell a retry from a new request and never applies it twice. A definite
// answer (success, or a 4xx refusal) settles the action, and the next click is a new operation with a new key.
const pending = new Map<string, string>();

export function operationKey(action: string): string {
  let key = pending.get(action);
  if (!key) { key = crypto.randomUUID().replace(/-/g, ""); pending.set(action, key); }
  return key;
}

/** Call once the server gave a definite answer for this action. */
export function settleOperation(action: string): void { pending.delete(action); }

/** True when an error means the answer was lost (so the same key must be reused on retry). */
export function answerLost(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  return typeof status !== "number" || status >= 500;
}
