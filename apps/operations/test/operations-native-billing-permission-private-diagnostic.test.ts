import { describe, expect, it, vi } from "vitest";
import { billingPermissionDiagnosticEnabled, classifyBillingPermissionBatchError,
  type BillingPermissionDiagnosticOptions } from "../src/worker/operations-portal-native-billing-permission-diagnostic";
import { manageOperationsPortalNativeBillingPermission as manage } from "../src/worker/operations-portal-native-billing-permission-issuer";

const secret = "SECRET-subject-email-token-SQL-bindings";
const actor = { identity: { kind: "native" as const, staffId: "owner", verifiedAccessSubject: secret,
  email: secret, displayName: secret, profileVersion: 1 }, admissionVersion: 19,
  verifiedUntil: "2099-01-01T00:00:00.000Z" };
const input = { action: "issue" as const, operationId: "00000000-0000-4000-8000-000000000001",
  grantId: "00000000-0000-4000-8000-000000000002", expectedGeneration: 2,
  staffId: "beneficiary", effect: "allow" as const, scope: { kind: "resource" as const, resourceId: "synthetic-root" } };
async function requestFingerprint() {
  const canonical = JSON.stringify({ protocol: "operations-portal-native-billing-permission-management", protocolVersion: 1,
    operationId: input.operationId, action: input.action, grantId: input.grantId,
    expectedGeneration: String(input.expectedGeneration), staffId: input.staffId, effect: input.effect,
    scope: input.scope, actorStaffId: actor.identity.staffId });
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function database(error: Error, observationFails = false,
  winner?: { request_fingerprint: string; grant_id: string; resulting_generation: number }) {
  let commandReads = 0;
  const prepare = vi.fn((sql: string): D1PreparedStatement => {
    const statement = { bind: (..._values: unknown[]) => statement, first: async () => {
      if (sql.includes("SELECT request_fingerprint")) return ++commandReads > 1 ? winner ?? null : null;
      if (sql.includes("SELECT staff_id,effect,scope_kind,resource_id"))
        return { staff_id: input.staffId, effect: input.effect, scope_kind: "resource", resource_id: input.scope.resourceId };
      if (sql.includes("SELECT 1 ok")) return { ok: 1 };
      if (sql.includes("generationMatches")) {
        if (observationFails) throw Error(secret);
        return { generationMatches: 1, grantIdExists: 0, operationIdExists: 0, verifiedUntilFuture: 1, observedAtFresh: 1 };
      }
      throw Error("unexpected test read");
    } };
    return statement as D1PreparedStatement;
  });
  const batch = vi.fn(async (_statements: D1PreparedStatement[]): Promise<never> => { throw error; });
  const db = { prepare, batch, withSession: vi.fn<D1Database["withSession"]>(),
    exec: vi.fn<D1Database["exec"]>(), dump: vi.fn<D1Database["dump"]>() } satisfies D1Database;
  return { db, batch, prepare };
}
describe("private staging billing permission failure diagnostics", () => {
  it.each([["staging", "true", true], ["staging", undefined, false], ["staging", "false", false],
    ["staging", "TRUE", false], ["production", "true", false], ["development", "true", false]] as const)(
    "gates %s/%s explicitly", (environment, flag, expected) => {
      expect(billingPermissionDiagnosticEnabled(environment, flag)).toBe(expected);
    });
  it.each([
    ["native billing permission command is not currently authorized and exact", "command-guard"],
    ["native billing permission issue is not exact", "issue-guard"],
    ["native billing permission revoke is not exact", "revoke-guard"],
    ["native billing permission generation transition is invalid", "generation-guard"],
    ["UNIQUE constraint failed", "unique-constraint"], ["FOREIGN KEY constraint failed", "foreign-key-constraint"],
    ["CHECK constraint failed", "check-constraint"],
  ])("classifies only fixed labels: %s", (literal, expected) => {
    expect(classifyBillingPermissionBatchError(new Error(`D1_ERROR: ${literal}: ${secret}`))).toBe(expected);
    expect(classifyBillingPermissionBatchError(new Error(secret, { cause: new Error(literal) }))).toBe(expected);
  });
  it("unknown errors stay fail-closed and logs contain no raw error, identity, time or SQL", async () => {
    const { db, batch } = database(new Error(secret)); const emit = vi.fn();
    expect(await manage(db, actor, input, { environment: "staging", enabled: "true", emit }))
      .toEqual({ status: "conflict", reason: "generation" });
    expect(batch).toHaveBeenCalledOnce(); expect(batch.mock.calls[0]![0]).toHaveLength(4);
    expect(emit).toHaveBeenCalledExactlyOnceWith({ event: "native-billing-permission-batch-failed", classification: "unknown",
      action: "issue", managerCurrent: true, generationMatches: true, grantIdExists: false, operationIdExists: false,
      verifiedUntilCanonical: true, verifiedUntilFuture: true, observedAtFresh: true });
    const logged = JSON.stringify(emit.mock.calls);
    for (const value of [secret, input.operationId, input.grantId, input.staffId, input.scope.resourceId, actor.verifiedUntil, "SELECT"])
      expect(logged).not.toContain(value);
  });
  it("failed observation and throwing callback cannot alter the conflict result or retry the batch", async () => {
    const { db, batch } = database(new Error(secret), true); const emit = vi.fn<BillingPermissionDiagnosticOptions["emit"]>(() => { throw Error(secret); });
    expect(await manage(db, actor, input, { environment: "staging", enabled: "true", emit }))
      .toEqual({ status: "conflict", reason: "generation" });
    expect(emit.mock.calls[0]![0]).toMatchObject({ managerCurrent: null, generationMatches: null, classification: "unknown" });
    expect(batch).toHaveBeenCalledOnce();
  });
  it.each([undefined, { environment: "production", enabled: "true" }, { environment: "staging", enabled: "false" }])(
    "disabled diagnostics add no reads and never emit", async configuration => {
      const { db, prepare } = database(new Error(secret)); const emit = vi.fn();
      const options: BillingPermissionDiagnosticOptions | undefined = configuration ? { ...configuration, emit } : undefined;
      expect(await manage(db, actor, input, options)).toEqual({ status: "conflict", reason: "generation" });
      expect(emit).not.toHaveBeenCalled();
      expect(prepare.mock.calls.some(([sql]) => sql.includes("generationMatches"))).toBe(false);
    });
  it("throwing diagnostics preserve an exact matching replay winner after batch failure", async () => {
    const fingerprint = await requestFingerprint();
    const { db, batch, prepare } = database(new Error(secret), true, {
      request_fingerprint: fingerprint, grant_id: input.grantId, resulting_generation: 3 });
    const emit = vi.fn<BillingPermissionDiagnosticOptions["emit"]>(() => { throw Error(secret); });
    expect(await manage(db, actor, input, { environment: "staging", enabled: "true", emit }))
      .toEqual({ status: "replayed", operationId: input.operationId, grantId: input.grantId, generation: 3 });
    expect(emit).toHaveBeenCalledOnce(); expect(batch).toHaveBeenCalledOnce();
    const queries = prepare.mock.calls.map(([sql]) => sql);
    const winnerRead = queries.map((sql, index) => sql.includes("SELECT request_fingerprint") ? index : -1)
      .reduce((latest, index) => Math.max(latest, index), -1);
    const observationRead = queries.findIndex(sql => sql.includes("generationMatches"));
    expect(winnerRead).toBeLessThan(observationRead);
    expect(queries.slice(winnerRead + 1, observationRead).filter(sql => sql.includes("SELECT 1 ok"))).toHaveLength(2);
  });
  it("classifies revoke failure without changing its fail-closed response", async () => {
    const { db, batch } = database(new Error(`native billing permission revoke is not exact ${secret}`));
    const emit = vi.fn();
    expect(await manage(db, actor, { action: "revoke", operationId: input.operationId,
      grantId: input.grantId, expectedGeneration: 2 }, { environment: "staging", enabled: "true", emit }))
      .toEqual({ status: "conflict", reason: "generation" });
    expect(emit.mock.calls[0]![0]).toMatchObject({ action: "revoke", classification: "revoke-guard" });
    expect(JSON.stringify(emit.mock.calls)).not.toContain(secret); expect(batch).toHaveBeenCalledOnce();
  });
  it("unusual or throwing Error.message stays unknown", () => {
    const error = new Error(); Object.defineProperty(error, "message", { value: { private: secret } });
    expect(classifyBillingPermissionBatchError(error)).toBe("unknown");
    const throwing = new Error(); Object.defineProperty(throwing, "message", { get() { throw Error(secret); } });
    expect(classifyBillingPermissionBatchError(throwing)).toBe("unknown");
  });
  it("success and pre-existing replay perform zero diagnostic reads or emissions", async () => {
    const emit = vi.fn(), options = { environment: "staging", enabled: "true", emit };
    const success = database(new Error(secret));
    expect(await manage({ ...success.db, batch: async () => [] }, actor, input, options))
      .toMatchObject({ status: "applied", generation: 3 });
    expect(success.prepare.mock.calls.some(([sql]) => sql.includes("generationMatches"))).toBe(false);
    const replay = database(new Error(secret));
    const winner = { request_fingerprint: await requestFingerprint(), grant_id: input.grantId, resulting_generation: 3 };
    replay.prepare.mockImplementationOnce(() => {
      const statement = { bind: (..._values: unknown[]) => statement, first: async () => winner };
      return statement as D1PreparedStatement;
    });
    expect(await manage(replay.db, actor, input, options)).toMatchObject({ status: "replayed", generation: 3 });
    expect(replay.batch).not.toHaveBeenCalled();
    expect(replay.prepare.mock.calls.some(([sql]) => sql.includes("generationMatches"))).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});
