// One Idempotency-Key per user action, so the Logs host can tell a retry from a new request and never applies an
// action twice. The key is kept, and reused by the next attempt of the SAME action, until the server gives a definite
// answer: success, or a refusal other than 409. A lost answer (network error), a 5xx and every 409 (still in progress,
// already completed, expired, conflicting) keep the key, so a click after one of those never becomes a new write.
//
// Keys are kept in sessionStorage (this tab only, bounded, at most a day old) under a scope derived from the staff
// session, so a page reload keeps them and another staff session never reuses them. Only action names (ids already
// shown on the page) and random keys are stored; no tokens or personal data.
const STORE = "ltds.flight-logs.operation-keys.v1";
const MAX_ENTRIES = 50;
const MAX_AGE_MS = 24 * 60 * 60_000;

type Entry = { key: string; at: number };
type Store = Record<string, Entry>;

function storage(): Storage | null {
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}
const memory = new Map<string, Store>();

function load(scope: string): Store {
  const now = Date.now();
  let store: Store = memory.get(scope) ?? {};
  try {
    const raw = storage()?.getItem(`${STORE}:${scope}`);
    if (raw) store = JSON.parse(raw) as Store;
  } catch { /* unreadable: start empty */ }
  for (const [action, entry] of Object.entries(store))
    if (!entry || typeof entry.key !== "string" || !Number.isFinite(entry.at) || now - entry.at > MAX_AGE_MS) delete store[action];
  return store;
}
function save(scope: string, store: Store): void {
  const entries = Object.entries(store).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES);
  const bounded = Object.fromEntries(entries);
  memory.set(scope, bounded);
  try { storage()?.setItem(`${STORE}:${scope}`, JSON.stringify(bounded)); } catch { /* storage full or blocked: memory only */ }
}

export function operationKey(scope: string, action: string): string {
  const store = load(scope);
  let entry = store[action];
  if (!entry) { entry = { key: crypto.randomUUID().replace(/-/g, ""), at: Date.now() }; store[action] = entry; save(scope, store); }
  return entry.key;
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
