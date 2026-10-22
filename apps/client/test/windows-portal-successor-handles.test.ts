import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256OperationsPortalNativeDeliveryAuthorityCommand } from "@ltds/shared/operations-portal-native-delivery-authority";
import { fixture, id, principal } from "./helpers/windows-portal-successor-fixture";
import { encodeWindowsPortalSuccessorHandle as encode, decodeWindowsPortalSuccessorHandle as decode,
  windowsPortalSuccessorHandleMatchesContext as matches, type WindowsPortalSuccessorFilePins } from "../src/worker/client-portal/windows-portal-successor-handles";
import { encodeOperationsNativeDeliveryHandle, decodeOperationsNativeDeliveryHandle } from "../src/worker/client-portal/operations-native-delivery-handles";
import type { WindowsPortalSuccessorContext } from "../src/worker/client-portal/windows-portal-successor-authorization";

const env = { DELIVERY_SESSION_SECRET: "current-synthetic-secret-".repeat(3), DELIVERY_PREVIOUS_SESSION_SECRET: undefined };
const file: WindowsPortalSuccessorFilePins = { path: "photos/map.tif", etag: '"trusted-etag"', providerVersion: "r2-version-one", sha256: "a".repeat(64), size: 52750 };
async function setup() {
  const f = await fixture();
  const context: WindowsPortalSuccessorContext = { kind: "windows-portal-successor-v1", originalGrant: f.command,
    originalRequestFingerprint: f.candidate.request_fingerprint, selectedR2Prefix: f.command.resource.selectedR2Prefix,
    continuity: f.successor.continuity };
  const until = Date.now() + 600_000;
  const token = await encode(env, context, principal, until, file), handle = (await decode(env, token))!;
  expect(handle).not.toBeNull();
  return { context, until, token, handle };
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
async function seal(text: string | Uint8Array, purpose = "windows-portal-publication-successor-file-v1", prefix = "wsp1_") {
  const e = new TextEncoder(), secret = env.DELIVERY_SESSION_SECRET;
  const key = await crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", e.encode(`${purpose}\0${secret}`)), { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: e.encode(prefix) }, key, typeof text === "string" ? e.encode(text) : new Uint8Array(text)));
  const bytes = new Uint8Array(iv.length + encrypted.length); bytes.set(iv); bytes.set(encrypted, iv.length);
  let raw = ""; for (const byte of bytes) raw += String.fromCharCode(byte);
  return prefix + btoa(raw).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}
afterEach(() => vi.useRealTimers());

describe("private Windows portal successor selectors", () => {
  it("round trips real AES-GCM and exact private claims without storage prefix or original grant plaintext", async () => {
    const f = await setup();
    expect(f.token).toMatch(/^wsp1_[A-Za-z0-9_-]+$/u);
    expect(f.token).not.toContain(file.path);
    expect(f.handle).toMatchObject({ ...file, v: 1, authorityId: f.context.originalGrant.authority.authorityId,
      originalGrantFingerprint: f.context.originalRequestFingerprint, ...principal, current: f.context.continuity.current,
      chainSha256: f.context.continuity.chainSha256, publicationCount: f.context.continuity.publicationCount, expires: f.until });
    expect(f.handle).not.toHaveProperty("selectedR2Prefix"); expect(f.handle).not.toHaveProperty("originalGrant");
    expect(Object.isFrozen(f.handle)).toBe(true); expect(Object.isFrozen(f.handle.current)).toBe(true);
    expect(await matches(f.handle, f.context, principal, f.until)).toBe(true);
    expect(await matches(f.handle, f.context, principal, f.until + 300_000)).toBe(true); // explicit human renewal does not widen selector expiry
  });
  it("caps expiry by each human grant and fifteen-minute limit; rejects expired or shortened sessions", async () => {
    const f = await setup();
    expect(await matches(f.handle, f.context, principal, f.until - 1)).toBe(false);
    const longHuman = Date.now() + 3_600_000;
    const token = await encode(env, f.context, principal, longHuman, file), handle = (await decode(env, token))!;
    expect(handle.expires).toBeLessThanOrEqual(Date.now() + 900_000);
    const c = clone(f.context) as MutableContext; c.originalGrant.expiresAt = new Date(Date.now() + 120_000).toISOString();
    c.originalRequestFingerprint = await sha256OperationsPortalNativeDeliveryAuthorityCommand(c.originalGrant);
    c.continuity.grantFingerprint = c.originalRequestFingerprint;
    const short = (await decode(env, await encode(env, c, principal, longHuman, file)))!;
    expect(short.expires).toBe(Date.parse(c.originalGrant.expiresAt!));
    vi.useFakeTimers(); vi.setSystemTime(f.until + 1);
    expect(await decode(env, f.token)).toBeNull();
    expect(await matches(f.handle, f.context, principal, f.until)).toBe(false);
    await expect(encode(env, f.context, principal, f.until, file)).rejects.toThrow();
  });
  it("rejects ciphertext and prefix tampering and rotates only within its own encryption purpose", async () => {
    const f = await setup(), rotated = { DELIVERY_SESSION_SECRET: "new-synthetic-key-".repeat(3), DELIVERY_PREVIOUS_SESSION_SECRET: env.DELIVERY_SESSION_SECRET };
    expect(await decode(rotated, f.token)).toEqual(f.handle);
    expect(await decode({ DELIVERY_SESSION_SECRET: rotated.DELIVERY_SESSION_SECRET }, f.token)).toBeNull();
    expect(await decode(env, f.token.slice(0, 20) + (f.token[20] === "a" ? "b" : "a") + f.token.slice(21))).toBeNull();
    expect(await decode(env, f.token + "=")).toBeNull();
    expect(await decode(env, "wsp1_" + "a".repeat(8192))).toBeNull();
    expect(await decodeOperationsNativeDeliveryHandle(env, f.token)).toBeNull();
    const ordinary = await encodeOperationsNativeDeliveryHandle(env, { v: 1, kind: "file", ...ordinaryClaims(f.context),
      path: file.path, etag: file.etag, expires: f.until });
    expect(await decode(env, ordinary)).toBeNull();
    expect(await decode(env, "wsp1_" + ordinary.slice(5))).toBeNull();
    expect(await decode(env, await seal(JSON.stringify(f.handle), "operations-native-delivery-resource-v1"))).toBeNull();
  });
  it.each(["authorityId", "originalGrantFingerprint", "issuer", "subject", "chainSha256", "publicationCount"] as const)("exact matcher rejects changed %s", async field => {
    const f = await setup(), changed = clone(f.handle);
    if (field === "authorityId") changed[field] = id(999);
    else if (field === "publicationCount") changed[field]++;
    else if (field.endsWith("Fingerprint") || field === "chainSha256") changed[field as "chainSha256"] = "e".repeat(64);
    else changed[field as "issuer"] = "different";
    expect(await matches(changed, f.context, principal, f.until)).toBe(false);
  });
  it.each(["operationId", "publicationId", "revision", "sourceSequence", "snapshotId", "snapshotSha256"] as const)("pins current publication %s", async field => {
    const f = await setup(), changed = clone(f.handle);
    if (field === "revision" || field === "sourceSequence") changed.current[field]++;
    else changed.current[field] = field === "snapshotSha256" ? "e".repeat(64) : id(999);
    expect(await matches(changed, f.context, principal, f.until)).toBe(false);
  });
  it("requires original download grant and exact first publication/count; fingerprint binds every original lifecycle change", async () => {
    const f = await setup();
    for (const edit of [
      (c: MutableContext) => { c.originalGrant.features = ["file.metadata"]; },
      (c: MutableContext) => { c.originalGrant.recipient.homeOwnershipEpoch = "2"; },
      (c: MutableContext) => { c.originalGrant.resource.folderReservationRevision = "2"; },
      (c: MutableContext) => { c.originalGrant.target.workspaceId = "different-workspace"; },
    ]) {
      const c = clone(f.context) as MutableContext; edit(c);
      c.originalRequestFingerprint = await sha256OperationsPortalNativeDeliveryAuthorityCommand(c.originalGrant);
      c.continuity.grantFingerprint = c.originalRequestFingerprint;
      expect(await matches(f.handle, c, principal, f.until)).toBe(false);
    }
    for (const edit of [(c: MutableContext) => { c.continuity.first.snapshotId = id(999); },
      (c: MutableContext) => { c.continuity.publicationCount = 1; },
      (c: MutableContext) => { c.continuity.grantOperationId = id(999); },
      (c: MutableContext) => { c.originalRequestFingerprint = "e".repeat(64); }]) {
      const c = clone(f.context) as MutableContext; edit(c);
      await expect(encode(env, c, principal, f.until, file)).rejects.toThrow();
      expect(await matches(f.handle, c, principal, f.until)).toBe(false);
    }
    const noDownload = clone(f.context) as MutableContext; noDownload.originalGrant.features = ["file.metadata"];
    noDownload.originalRequestFingerprint = await sha256OperationsPortalNativeDeliveryAuthorityCommand(noDownload.originalGrant);
    noDownload.continuity.grantFingerprint = noDownload.originalRequestFingerprint;
    await expect(encode(env, noDownload, principal, f.until, file)).rejects.toThrow();
    expect(await matches(f.handle, f.context, { ...principal, subject: "other-human" }, f.until)).toBe(false);
  });
  it.each([
    { path: "../map.tif" }, { path: "photos//map.tif" }, { path: "/map.tif" }, { path: "photos\\map.tif" },
    { path: "photos/_ltds/file" }, { path: "photos/.previews/file" }, { path: "dump/file" }, { path: "a".repeat(1025) },
    { path: "a\0b" }, { etag: 'W/"weak"' }, { etag: "unquoted" }, { etag: '"bad\n"' },
    { providerVersion: " padded " }, { providerVersion: "v\0" }, { sha256: "A".repeat(64) },
    { size: -1 }, { size: 1.5 }, { size: 2 ** 40 + 1 }, { size: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects malformed file pins %j", async bad => {
    const f = await setup(); await expect(encode(env, f.context, principal, f.until, { ...file, ...bad })).rejects.toThrow();
  });
  it("rejects authenticated unknown/duplicate claims, invalid UTF8, noncanonical JSON and expiry/bounds violations", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-22T12:00:00.000Z"));
    const f = await setup(), raw = JSON.stringify(f.handle);
    for (const value of [raw.replace('"v":1', '"v":1,"v":1'), raw.slice(0, -1) + ',"extra":true}', raw + " ", "[]",
      JSON.stringify({ ...f.handle, expires: Date.now() + 900_001 }), JSON.stringify({ ...f.handle, size: -1 }),
      JSON.stringify({ ...f.handle, current: { ...f.handle.current, extra: true } }), JSON.stringify({ ...f.handle, publicationCount: 65 })])
      expect(await decode(env, await seal(value))).toBeNull();
    expect(await decode(env, await seal(new Uint8Array([255, 254])))).toBeNull();
    expect(await decode(env, await seal("a".repeat(6001)))).toBeNull();
    await expect(encode({ DELIVERY_SESSION_SECRET: "short" }, f.context, principal, f.until, file)).rejects.toThrow();
  });
  it("snapshots caller metadata/context before cryptographic awaits", async () => {
    const f = await setup(), c = clone(f.context) as MutableContext, pins = { ...file };
    const promise = encode(env, c, principal, f.until, pins);
    c.continuity.current.snapshotId = id(999); c.originalGrant.recipient.homeOwnershipEpoch = "9"; pins.path = "other.tif";
    const selected = (await decode(env, await promise))!;
    expect(selected.path).toBe(file.path); expect(selected.current.snapshotId).toBe(f.context.continuity.current.snapshotId);
    expect(await matches(selected, f.context, principal, f.until)).toBe(true);
  });
});
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly unknown[] ? T[K][number][] : T[K] extends object ? Mutable<T[K]> : T[K] };
type MutableContext = Mutable<WindowsPortalSuccessorContext>;
function ordinaryClaims(c: WindowsPortalSuccessorContext) {
  const g = c.originalGrant;
  return { authorityId: g.authority.authorityId, authorityRevision: g.authority.resultingRevision,
    ...g.recipient, targetId: g.target.targetId, targetRevision: g.target.targetRevision, clientAuthorityId: g.target.clientAuthorityId,
    workspaceId: g.target.workspaceId, publicationId: g.publication.publicationId, publicationOperationId: g.publication.operationId,
    publicationRevision: g.publication.revision, publicationSourceSequence: g.publication.sourceSequence,
    snapshotId: g.publication.snapshotId, snapshotSha256: g.publication.snapshotSha256,
    folderReservationId: g.resource.folderReservationId, folderReservationRevision: g.resource.folderReservationRevision,
    clientFolderBindingId: g.resource.clientFolderBindingId, externalProjectId: g.resource.externalProjectId, projectVersion: g.resource.projectVersion };
}
