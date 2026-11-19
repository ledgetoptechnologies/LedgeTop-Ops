// One Idempotency-Key per user action, so the Logs host can tell a retry from a new request and never applies an
// action twice. The key is kept, and reused by the next attempt of the SAME action, until the server gives a definite
// answer.
//
//   - success settles the action;
//   - a lost answer (network error), a 5xx or any 409 keeps the key AND marks the action uncertain: its effect may
//     already have happened;
//   - once uncertain, only a success settles it. Every later error, including a 401/403 from Ops itself (an expired
//     session, a removed permission) keeps the key, so after signing in again the retry still carries the SAME key
//     and can never repeat the effect;
//   - a refusal other than 409 on an action that was never uncertain settles it (nothing was applied).
//
// Unresolved keys are never dropped by age or evicted for space. If too many actions are unresolved, a NEW action is
// refused instead of forgetting an old one. Keys live in sessionStorage under a label of the signed-in staff member
// (stable across session renewals; never a token). Only action names (ids already on the page) and random keys are
// stored.
const STORE = "ltds.flight-logs.operation-keys.v3";
export const MAX_PENDING_ACTIONS = 50;

type Entry = { key: string; uncertain: boolean };
type Store = Record<string, Entry>;

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
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      store = {};
      for (const [action, entry] of Object.entries(parsed ?? {})) {
        const e = entry as Partial<Entry>;
        if (typeof e?.key === "string" && /^[0-9a-f]{32}$/.test(e.key)) store[action] = { key: e.key, uncertain: e.uncertain === true };
      }
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
  if (store[action]) return store[action].key;
  if (Object.keys(store).length >= MAX_PENDING_ACTIONS) throw new TooManyPendingActions();
  store[action] = { key: crypto.randomUUID().replace(/-/g, ""), uncertain: false };
  save(scope, store);
  return store[action].key;
}

/** Call once the action definitely succeeded. */
export function settleOperation(scope: string, action: string): void {
  const store = load(scope);
  if (store[action]) { delete store[action]; save(scope, store); }
}

/** Whether a failure leaves the outcome unknown (lost answer, 5xx, or any 409). */
export function keepKey(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  return typeof status !== "number" || status >= 500 || status === 409;
}

/** Records a failed attempt: an uncertain outcome marks the action; a plain refusal of a never-uncertain action settles it. */
export function recordFailure(scope: string, action: string, error: unknown): void {
  const store = load(scope);
  const entry = store[action];
  if (!entry) return;
  if (keepKey(error)) { if (!entry.uncertain) { entry.uncertain = true; save(scope, store); } return; }
  if (!entry.uncertain) settleOperation(scope, action);
}

/** Whether this action has an uncertain earlier attempt (its key must be reused until it succeeds). */
export function isUncertain(scope: string, action: string): boolean { return load(scope)[action]?.uncertain === true; }

/** Runs an action with its key: settles on success, keeps the key whenever the outcome is or was uncertain. */
export async function withOperationKey<T>(scope: string, action: string, run: (key: string) => Promise<T>): Promise<T> {
  const key = operationKey(scope, action);
  try {
    const result = await run(key);
    settleOperation(scope, action);
    return result;
  } catch (error) {
    recordFailure(scope, action, error);
    throw error;
  }
}
