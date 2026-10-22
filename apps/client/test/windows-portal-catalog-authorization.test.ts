import { describe, expect, it, vi } from "vitest";
import { authorizeWindowsPortalCatalog as catalogAuthorize } from "../src/worker/client-portal/windows-portal-catalog-authorization";
import { fixture, id, principal } from "./helpers/windows-portal-successor-fixture";

import { canonicalOperationsPortalNativeDeliveryAuthorityCommand, sha256OperationsPortalNativeDeliveryAuthorityCommand } from "@ltds/shared/operations-portal-native-delivery-authority";
const authorize = (env: Parameters<typeof catalogAuthorize>[0], person: typeof principal, authorityId: string) => catalogAuthorize(env, person, authorityId, "folder.list");
async function setup(feature: "folder.list" | "file.metadata" = "folder.list") {
  const f = await fixture() as Mutable<Awaited<ReturnType<typeof fixture>>>;
  f.command.features = [feature]; f.successor.authorization.features = [feature];
  f.candidate.canonical_command_json = canonicalOperationsPortalNativeDeliveryAuthorityCommand(f.command);
  f.candidate.request_fingerprint = await sha256OperationsPortalNativeDeliveryAuthorityCommand(f.command);
  f.successor.continuity.grantFingerprint = f.candidate.request_fingerprint;
  const reply = { ok:true, protocolVersion:1, feature, catalog:f.successor };
  const first = vi.fn(async () => f.candidate as typeof f.candidate | null);
  const prepare = vi.fn((_sql: string) => ({ bind: vi.fn((..._args: unknown[]) => ({ first })) }));
  const ordinary = vi.fn(async () => { throw new Error("no ordinary fallback"); });
  const rpc = vi.fn<(_: string, feature: "folder.list" | "file.metadata") => Promise<unknown>>(async () => JSON.stringify(reply));
  const env = { DELIVERY_DB: { withSession: () => ({ prepare }) } as unknown as D1Database,
    ENVIRONMENT: "staging", CLIENT_PORTAL_ORIGIN: "https://client-staging.ledgetopdroneservices.com",
    CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED: "true", OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER: {
      readNativeDeliveryAuthorization: ordinary, readWindowsCatalogSuccessorAuthorization: async (wire: string, _feature: "folder.list" | "file.metadata") => await rpc(wire, _feature) as string,
    } };
  return { ...f, reply, env, first, prepare, rpc, ordinary };
}
describe("Windows portal consumer catalog proof", () => {
  it("binds original command and current local publication into a distinct private context", async () => {
    const f = await setup(), result = await authorize(f.env, principal, id(2));
    expect(result).toEqual({ ok: true, catalogContext: { kind: "windows-portal-catalog-v1", feature: "folder.list", originalGrant: f.command,
      originalRequestFingerprint: f.candidate.request_fingerprint, selectedR2Prefix: "synthetic/photos/", continuity: f.successor.continuity } });
    expect(f.first).toHaveBeenCalledTimes(2);
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith(f.candidate.canonical_command_json, "folder.list");
    expect(f.ordinary).not.toHaveBeenCalled();
    expect(Object.isFrozen(result.ok && result.catalogContext)).toBe(true);
    if (result.ok) expect("command" in result.catalogContext).toBe(false);
  });
  it.each([
    ["rewritten original publication", v => { v.catalog.authorization.publicationRevision = 3; }],
    ["different original prefix", v => { v.catalog.authorization.selectedR2Prefix = "other/"; }],
    ["different grant fingerprint", v => { v.catalog.continuity.grantFingerprint = "e".repeat(64); }],
    ["different original snapshot", v => { v.catalog.continuity.first.snapshotSha256 = "e".repeat(64); }],
    ["different current publication", v => { v.catalog.continuity.current.publicationId = id(900); }],
    ["skipped revision", v => { v.catalog.continuity.current.sourceSequence = 4; }],
    ["negative count", v => { v.catalog.continuity.publicationCount = -1; }],
    ["overflow count", v => { v.catalog.continuity.publicationCount = 65; }],
    ["fractional count", v => { v.catalog.continuity.publicationCount = 3.5; }],
    ["wrong count", v => { v.catalog.continuity.publicationCount = 2; }],
    ["invalid history digest", v => { v.catalog.continuity.chainSha256 = "not-a-hash"; }],
    ["extra nested field", v => { Object.assign(v.catalog.continuity.current, { extra: true }); }],
    ["extra original proof field", v => { Object.assign(v.catalog.authorization, { extra: true }); }],
  ] as Array<[string, (value: { ok: boolean; protocolVersion: number; feature: string; catalog: MutableSuccessor }) => void]>)("rejects %s", async (_name, mutate) => {
    const f = await setup(), value = JSON.parse(JSON.stringify(f.reply)) as { ok: boolean; protocolVersion: number; feature: string; catalog: MutableSuccessor };
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

  it("authorizes metadata-only without download and passes only its explicit feature", async () => {
    const f = await setup("file.metadata");
    const result = await catalogAuthorize(f.env, principal, id(2), "file.metadata");
    expect(result.ok && result.catalogContext.feature).toBe("file.metadata");
    expect(result.ok && result.catalogContext.originalGrant.features).toEqual(["file.metadata"]);
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith(f.candidate.canonical_command_json, "file.metadata");
  });
  it("rejects missing granted feature, substituted echo and forbidden feature", async () => {
    const f = await setup();
    expect(await catalogAuthorize(f.env, principal, id(2), "file.metadata")).toEqual({ok:false,code:"denied"});
    expect(await catalogAuthorize(f.env, principal, id(2), "file.download" as "file.metadata")).toEqual({ok:false,code:"denied"});
    expect(await catalogAuthorize(f.env, principal, id(2), "file.preview" as "file.metadata")).toEqual({ok:false,code:"denied"});
    expect(f.rpc).not.toHaveBeenCalled();
    f.rpc.mockResolvedValue(JSON.stringify({...f.reply,feature:"file.metadata"}));
    expect(await authorize(f.env, principal, id(2))).toEqual({ok:false,code:"unavailable"});
    f.rpc.mockResolvedValue(JSON.stringify({ok:true,protocolVersion:1,successor:f.successor}));
    expect(await authorize(f.env, principal, id(2))).toEqual({ok:false,code:"unavailable"});
  });
});
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
type MutableSuccessor = Mutable<Awaited<ReturnType<typeof fixture>>["successor"]>;
