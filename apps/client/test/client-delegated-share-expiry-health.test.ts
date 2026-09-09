import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import healthMigration from "../migrations/0210_client_delegated_share_expiry_health.sql?raw";
import { runClientDelegatedShareExpiryReconciliation } from "../src/worker/client-portal/delegated-share-expiry-health";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const FIRST = Date.UTC(2026, 8, 8, 1, 0, 0);
const SECOND = FIRST + 60_000;
const result = (sharesExpired: number, delegationsExpired: number, sharesAtLimit = false, delegationsAtLimit = false) =>
  ({ sharesExpired, delegationsExpired, sharesAtLimit, delegationsAtLimit });

describe("delegated-share expiry scheduler health", () => {
  let runtime: Miniflare;

  beforeAll(() => {
    runtime = new Miniflare({ compatibilityDate: "2026-07-16", modules: true,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: { HEALTH_DB: "delegated-expiry-health" } });
  });
  afterAll(async () => runtime.dispose());

  async function database(): Promise<D1Database> {
    const db = await runtime.getD1Database("HEALTH_DB") as unknown as D1Database;
    await db.exec("DROP TABLE IF EXISTS client_delegated_share_expiry_health");
    await db.batch(splitD1MigrationStatements(healthMigration).map(sql => db.prepare(sql)));
    return db;
  }

  it("retains the last success and records only a safe failure category", async () => {
    const db = await database();
    let clock = FIRST;
    await runClientDelegatedShareExpiryReconciliation({ DELIVERY_DB: db }, {
      now: () => clock, reconcile: async () => { clock = SECOND; return result(2, 1, true); },
    });
    clock = SECOND + 60_000;
    await expect(runClientDelegatedShareExpiryReconciliation({ DELIVERY_DB: db }, {
      now: () => clock, reconcile: async () => { throw new Error("provider text must not persist"); },
    })).rejects.toThrow("provider text must not persist");
    expect(await db.prepare(`SELECT last_run_at,last_success_at,last_error_code,last_shares_expired,
      last_delegations_expired,shares_at_limit,delegations_at_limit,active_run_id
      FROM client_delegated_share_expiry_health`).first()).toEqual({
      last_run_at: new Date(SECOND + 60_000).toISOString(), last_success_at: new Date(SECOND).toISOString(),
      last_error_code: "reconcile-failed", last_shares_expired: 2, last_delegations_expired: 1,
      shares_at_limit: 1, delegations_at_limit: 0, active_run_id: null,
    });
  });

  it("fences an older overlapping completion from replacing newer health", async () => {
    const db = await database();
    let releaseOlder: (() => void) | undefined;
    let olderStarted: (() => void) | undefined;
    const older = runClientDelegatedShareExpiryReconciliation({ DELIVERY_DB: db }, {
      now: () => FIRST,
      reconcile: async () => {
        olderStarted?.();
        await new Promise<void>(resolve => { releaseOlder = resolve; });
        return result(9, 9, true, true);
      },
    });
    await new Promise<void>(resolve => { olderStarted = resolve; });
    await runClientDelegatedShareExpiryReconciliation({ DELIVERY_DB: db }, {
      now: () => SECOND, reconcile: async () => result(1, 0, false, true),
    });
    releaseOlder?.();
    await older;
    expect(await db.prepare(`SELECT last_run_at,last_success_at,last_error_code,last_shares_expired,
      last_delegations_expired,shares_at_limit,delegations_at_limit,active_run_id
      FROM client_delegated_share_expiry_health`).first()).toEqual({
      last_run_at: new Date(SECOND).toISOString(), last_success_at: new Date(SECOND).toISOString(),
      last_error_code: null, last_shares_expired: 1, last_delegations_expired: 0,
      shares_at_limit: 0, delegations_at_limit: 1, active_run_id: null,
    });
  });

  it("continues reconciliation when the health migration has not arrived", async () => {
    const db = await runtime.getD1Database("HEALTH_DB") as unknown as D1Database;
    await db.exec("DROP TABLE IF EXISTS client_delegated_share_expiry_health");
    await expect(runClientDelegatedShareExpiryReconciliation({ DELIVERY_DB: db }, {
      now: () => FIRST, reconcile: async () => result(1, 0),
    })).resolves.toEqual(result(1, 0));
  });

  it("does not let a delayed older registration replace a newer start token", async () => {
    const db = await database();
    await db.prepare(`INSERT INTO client_delegated_share_expiry_health
      (id,last_run_at,last_success_at,active_run_id,updated_at) VALUES(?,?,?,?,?)`)
      .bind("client-delegated-share-expiry", new Date(SECOND).toISOString(), new Date(SECOND).toISOString(), null, new Date(SECOND).toISOString()).run();
    await runClientDelegatedShareExpiryReconciliation({ DELIVERY_DB: db }, {
      now: () => FIRST, reconcile: async () => result(9, 9, true, true),
    });
    expect(await db.prepare(`SELECT last_run_at,last_success_at,last_shares_expired,
      last_delegations_expired,shares_at_limit,delegations_at_limit,active_run_id
      FROM client_delegated_share_expiry_health`).first()).toEqual({
      last_run_at: new Date(SECOND).toISOString(), last_success_at: new Date(SECOND).toISOString(),
      last_shares_expired: 0, last_delegations_expired: 0, shares_at_limit: 0,
      delegations_at_limit: 0, active_run_id: null,
    });
  });
});
