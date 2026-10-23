import { describe, expect, it, vi } from "vitest";
import { authorizeWindowsPortalSuccessor as authorize } from "../src/worker/client-portal/windows-portal-successor-authorization";
import { fixture, id, principal } from "./helpers/windows-portal-successor-fixture";

async function setup() {
  const f = await fixture(), first = vi.fn(async () => f.candidate as typeof f.candidate | null);
  const prepare = vi.fn((_sql: string) => ({ bind: vi.fn((..._args: unknown[]) => ({ first })) }));
  const ordinary = vi.fn(async () => { throw new Error("no ordinary fallback"); });
  const rpc = vi.fn<(_: string) => Promise<unknown>>(async () => JSON.stringify(f.reply));
  const env = { DELIVERY_DB: { withSession: () => ({ prepare }) } as unknown as D1Database,
    ENVIRONMENT: "staging", CLIENT_PORTAL_ORIGIN: "https://client-staging.ledgetopdroneservices.com",
    CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED: "true", OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER: {
      readNativeDeliveryAuthorization: ordinary, readWindowsDeliverySuccessorAuthorization: async (wire: string) => await rpc(wire) as string,
    } };
  return { ...f, env, first, prepare, rpc, ordinary };
}
describe("Windows portal consumer successor proof", () => {
  it("binds original command and current local publication into a distinct private context", async () => {
    const f = await setup(), result = await authorize(f.env, principal, id(2));
    expect(result).toEqual({ ok: true, successorContext: { kind: "windows-portal-successor-v1", originalGrant: f.command,
      originalRequestFingerprint: f.candidate.request_fingerprint, selectedR2Prefix: "synthetic/photos/", continuity: f.successor.continuity } });
    expect(f.first).toHaveBeenCalledTimes(2);
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith(f.candidate.canonical_command_json);
    expect(f.ordinary).not.toHaveBeenCalled();
    expect(Object.isFrozen(result.ok && result.successorContext)).toBe(true);
    if (result.ok) expect("command" in result.successorContext).toBe(false);
  });
  it.each([
    ["rewritten original publication", v => { v.successor.authorization.publicationRevision = 3; }],
    ["different original prefix", v => { v.successor.authorization.selectedR2Prefix = "other/"; }],
    ["different grant fingerprint", v => { v.successor.continuity.grantFingerprint = "e".repeat(64); }],
    ["different original snapshot", v => { v.successor.continuity.first.snapshotSha256 = "e".repeat(64); }],
    ["different current publication", v => { v.successor.continuity.current.publicationId = id(900); }],
    ["skipped revision", v => { v.successor.continuity.current.sourceSequence = 4; }],
    ["negative count", v => { v.successor.continuity.publicationCount = -1; }],
    ["overflow count", v => { v.successor.continuity.publicationCount = 65; }],
    ["fractional count", v => { v.successor.continuity.publicationCount = 3.5; }],
    ["wrong count", v => { v.successor.continuity.publicationCount = 2; }],
    ["invalid history digest", v => { v.successor.continuity.chainSha256 = "not-a-hash"; }],
    ["extra nested field", v => { Object.assign(v.successor.continuity.current, { extra: true }); }],
    ["extra original proof field", v => { Object.assign(v.successor.authorization, { extra: true }); }],
  ] as Array<[string, (value: { ok: boolean; protocolVersion: number; successor: MutableSuccessor }) => void]>)("rejects %s", async (_name, mutate) => {
    const f = await setup(), value = JSON.parse(JSON.stringify(f.reply)) as { ok: boolean; protocolVersion: number; successor: MutableSuccessor };
    mutate(value); f.rpc.mockResolvedValue(JSON.stringify(value));
    await expect(authorize(f.env, principal, id(2))).resolves.toEqual({ ok: false, code: "unavailable" });
    expect(f.ordinary).not.toHaveBeenCalled();
  });
  it.each([null, {}, [], { ok: true, protocolVersion: 1, authorization: {} },
    "{\"ok\":true,\"ok\":true}", "{} ", "é".repeat(10_000)])("rejects wrong wire types, duplicate/noncanonical keys and oversized UTF-8", async wire => {
    const f = await setup(); f.rpc.mockResolvedValue(wire);
    await expect(authorize(f.env, principal, id(2))).resolves.toEqual({ ok: false, code: "unavailable" });
  });
  it.each(["denied", "disabled", "unavailable", "invalid"])("handles private failure %s without fallback", async code => {
    const f = await setup(); f.rpc.mockResolvedValue(JSON.stringify({ ok: false, protocolVersion: 1, code }));
    await expect(authorize(f.env, principal, id(2))).resolves.toEqual({ ok: false, code: code === "denied" || code === "disabled" ? "denied" : "unavailable" });
    expect(f.ordinary).not.toHaveBeenCalled();
  });
  it("fails closed on revoke, replacement or publication change during RPC", async () => {
    for (const after of [null, { changed: "publication" }, { changed: "grant" }]) {
      const f = await setup();
      f.first.mockResolvedValueOnce(f.candidate).mockResolvedValueOnce(after === null ? null : after.changed === "publication"
        ? { ...f.candidate, snapshot_sha256: "e".repeat(64) } : { ...f.candidate, request_fingerprint: "e".repeat(64) });
      await expect(authorize(f.env, principal, id(2))).resolves.toEqual({ ok: false, code: "denied" });
    }
  });
  it("rejects wrong person and bad local wire before private RPC", async () => {
    const wrong = await setup();
    await expect(authorize(wrong.env, { ...principal, subject: "other" }, id(2))).resolves.toEqual({ ok: false, code: "denied" });
    expect(wrong.rpc).not.toHaveBeenCalled();
    const bad = await setup(); bad.first.mockResolvedValue({ ...bad.candidate, request_fingerprint: "e".repeat(64) });
    await expect(authorize(bad.env, principal, id(2))).resolves.toEqual({ ok: false, code: "unavailable" });
    expect(bad.rpc).not.toHaveBeenCalled();
  });
  it("rejects disabled deployment and missing successor capability without a database read", async () => {
    const f = await setup();
    await expect(authorize({ ...f.env, CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED: "false" }, principal, id(2)))
      .resolves.toEqual({ ok: false, code: "disabled" });
    await expect(authorize({ ...f.env, OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER: undefined }, principal, id(2)))
      .resolves.toEqual({ ok: false, code: "unavailable" });
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("bounds an unanswered private call", async () => {
    const f = await setup(); f.rpc.mockImplementation(() => new Promise(() => {}));
    await expect(authorize(f.env, principal, id(2))).resolves.toEqual({ ok: false, code: "unavailable" });
  });
});
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
type MutableSuccessor = Mutable<Awaited<ReturnType<typeof fixture>>["successor"]>;
