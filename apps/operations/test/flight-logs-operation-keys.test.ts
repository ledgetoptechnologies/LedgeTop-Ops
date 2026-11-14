// Browser per-action Idempotency-Key lifecycle: one key per action, kept across lost answers, 5xx and every 409,
// settled only by a definite answer, persisted per staff session in bounded sessionStorage.
import { beforeEach, describe, expect, it } from 'vitest';
import { isUncertain, keepKey, MAX_PENDING_ACTIONS, operationKey, settleOperation, TooManyPendingActions, withOperationKey } from '../src/client/flight-logs/operation-keys';

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
const error = (status?: number) => Object.assign(new Error('x'), status === undefined ? {} : { status });

beforeEach(() => { (globalThis as { sessionStorage?: unknown }).sessionStorage = new MemoryStorage(); });

describe('per-action operation keys', () => {
  it('one key per action, distinct across actions and staff sessions', () => {
    const a = operationKey('session-1', 'revoke:dev-1');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(operationKey('session-1', 'revoke:dev-1')).toBe(a);
    expect(operationKey('session-1', 'revoke:dev-2')).not.toBe(a);
    expect(operationKey('session-2', 'revoke:dev-1')).not.toBe(a);
  });

  it('keeps the key on a lost answer, a 5xx and every 409; settles on success or another refusal', async () => {
    for (const kept of [undefined, 500, 502, 503, 409]) expect(keepKey(error(kept))).toBe(true);
    for (const settled of [400, 401, 403, 404, 413]) expect(keepKey(error(settled))).toBe(false);
    const seen: string[] = [];
    const attempt = (outcome: () => unknown) => withOperationKey('s', 'import-start:p:3', async key => { seen.push(key); return outcome(); });
    await expect(attempt(() => { throw error(); })).rejects.toThrow();
    await expect(attempt(() => { throw error(409); })).rejects.toThrow();
    await expect(attempt(() => { throw error(503); })).rejects.toThrow();
    await attempt(() => 'ok');
    expect(new Set(seen).size).toBe(1);
    await attempt(() => 'next');
    expect(seen.at(-1)).not.toBe(seen[0]);
    await expect(attempt(() => { throw error(403); })).rejects.toThrow();
    const afterRefusal = operationKey('s', 'import-start:p:3');
    expect(afterRefusal).not.toBe(seen.at(-1));
  });

  it('survives a page reload (sessionStorage); never drops an unresolved key; refuses new actions at capacity', () => {
    const before = operationKey('cap', 'decide:x:approve');
    const stored = (globalThis as unknown as { sessionStorage: MemoryStorage }).sessionStorage.data;
    expect([...stored.keys()].some(k => k.endsWith(':cap'))).toBe(true);
    expect(operationKey('cap', 'decide:x:approve')).toBe(before);
    for (let i = 1; i < MAX_PENDING_ACTIONS; i++) operationKey('cap', `revoke:${i}`);
    expect(() => operationKey('cap', 'revoke:new')).toThrow(TooManyPendingActions);
    expect(operationKey('cap', 'decide:x:approve'), 'the oldest unresolved key is still there').toBe(before);
    settleOperation('cap', 'revoke:1');
    expect(operationKey('cap', 'revoke:new')).toMatch(/^[0-9a-f]{32}$/);
  });


  it('an action whose answer was lost keeps its key through a later 401/403 (expired session, removed permission) until it succeeds', async () => {
    const seen: string[] = [];
    const attempt = (outcome: () => unknown) => withOperationKey('life', 'revoke:dev-9', async key => { seen.push(key); return outcome(); });
    await expect(attempt(() => { throw error(); })).rejects.toThrow();
    expect(isUncertain('life', 'revoke:dev-9')).toBe(true);
    await expect(attempt(() => { throw error(401); })).rejects.toThrow();
    await expect(attempt(() => { throw error(403); })).rejects.toThrow();
    expect(isUncertain('life', 'revoke:dev-9'), 'not forgotten by the preflight refusals').toBe(true);
    await attempt(() => 'ok after signing in again');
    expect(new Set(seen).size).toBe(1);
    expect(isUncertain('life', 'revoke:dev-9')).toBe(false);
    // A plain refusal of an action that was never uncertain settles it (nothing was applied).
    await expect(withOperationKey('life', 'revoke:dev-10', async () => { throw error(403); })).rejects.toThrow();
    expect(isUncertain('life', 'revoke:dev-10')).toBe(false);
  });
});
