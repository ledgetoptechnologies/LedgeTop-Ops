// One Idempotency-Key per user action, so the Logs host can tell a retry from a new request and never applies an
// action twice. The key is kept, and reused by the next attempt of the SAME action, until the server gives a definite
// answer: success, or a refusal other than 409. A lost answer (network error), a 5xx and every 409 (still in progress,
// already completed, expired, conflicting) keep the key, so a later click can never become a new write.
//
// Unresolved keys are never dropped by age or evicted for space. If too many actions are unresolved, a NEW action is
// refused (the person is asked to wait or reload) instead of forgetting an old one. Keys live in sessionStorage under
// a label of the signed-in staff member (stable across session renewals; never a token), so a reload keeps them and
// another person never reuses them. Only action names (ids already on the page) and random keys are stored.
const STORE = "ltds.flight-logs.operation-keys.v2";
export const MAX_PENDING_ACTIONS = 50;

type Store = Record<string, string>;

export class TooManyPendingActions extends Error {
  readonly status = 429;
  constructor() { super("Several earlier actions are still being confirmed. Wait a moment, then try again."); this.name = "TooManyPendingActions"; }
}

function storage(): Storage | null {
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}
const memory = new Map<string, Store>();

function load(scope: string): Store {
  let store: Store = memory.get(scope) ?? {};
  try {
    const raw = storage()?.getItem(`${STORE}:${scope}`);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") store = Object.fromEntries(Object.entries(parsed).filter(([, key]) => typeof key === "string" && /^[0-9a-f]{32}$/.test(key))) as Store;
    }
  } catch { /* unreadable: keep the in-memory copy */ }
  memory.set(scope, store);
  return store;
}
function save(scope: string, store: Store): void {
  memory.set(scope, store);
  try { storage()?.setItem(`${STORE}:${scope}`, JSON.stringify(store)); } catch { /* storage full or blocked: memory only */ }
}

export function operationKey(scope: string, action: string): string {
  const store = load(scope);
  if (store[action]) return store[action];
  if (Object.keys(store).length >= MAX_PENDING_ACTIONS) throw new TooManyPendingActions();
  store[action] = crypto.randomUUID().replace(/-/g, "");
  save(scope, store);
  return store[action];
}

/** Call once the server gave a definite answer for this action. */
export function settleOperation(scope: string, action: string): void {
  const store = load(scope);
  if (store[action]) { delete store[action]; save(scope, store); }
}

/** Whether this failure must keep the action's key for the next attempt (lost answer, 5xx, or any 409). */
export function keepKey(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  return typeof status !== "number" || status >= 500 || status === 409;
}

/** Runs an action with its key: settles on a definite answer, keeps the key otherwise. */
export async function withOperationKey<T>(scope: string, action: string, run: (key: string) => Promise<T>): Promise<T> {
  const key = operationKey(scope, action);
  try {
    const result = await run(key);
    settleOperation(scope, action);
    return result;
  } catch (error) {
    if (!keepKey(error)) settleOperation(scope, action);
    throw error;
  }
}
