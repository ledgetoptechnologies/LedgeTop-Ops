import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { reviewedClientMigrationNames, reviewedOperationsMigrationNames } from "./helpers/reviewed-operations-migration-chain";
import { registerOperationsAppReleaseRoutes } from "../src/worker/app-release-routes";
import type { Env, StaffPrincipal } from "../src/worker/types";

const ORIGIN = "https://ops-staging.ledgetopdroneservices.com";
const VERSION = "1.2.3.4";
const SHA = "ed48ea07035ed3e3c6ce7f6340319c8bf8d60d69809e8f0e903cab6e31ba18e0";
const COMMIT = "a".repeat(40);
const BYTES = new TextEncoder().encode("MZ synthetic pilot binary bytes");
const now = Math.floor(Date.now() / 1000);
let runtime: Miniflare, db: D1Database, bucket: R2Bucket, etag = "";

const owner: StaffPrincipal = { id: "staff-owner", email: "owner@example.test", displayName: "Owner",
  accessSubject: "access-subject-owner", projectAlphaUserId: null, accessExpiresAt: now + 3600 };
const contextEnv = () => ({
  OPS_DB: db, APP_RELEASE_BUCKET: bucket, ENVIRONMENT: "staging",
  PUBLIC_BASE_URL: ORIGIN, EXPECTED_HOST: "ops-staging.ledgetopdroneservices.com",
} as Env);
function app(principal: StaffPrincipal = owner, environment = "staging") {
  const router = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
  router.use("*", async (c, next) => { c.set("principal", principal); c.set("administrator", false); await next(); });
  registerOperationsAppReleaseRoutes(router);
  return { fetch: (path: string, init: RequestInit = {}) => router.request(`${ORIGIN}${path}`, init,
    { ...contextEnv(), ENVIRONMENT: environment } as Env) };
}

async function seedRelease(optional: { minSupported?: string | null; notes?: string | null } = {}) {
  const minSupported = optional.minSupported === undefined ? "Windows 10/11 x64" : optional.minSupported;
  const notes = optional.notes === undefined ? "Pilot candidate" : optional.notes;
  await db.prepare(`UPDATE app_release_control SET enabled=1,storage_accepted=1 WHERE singleton=1`).run();
  await bucket.put("windows/pilot/1.2.3.4/setup.exe", BYTES, {
    sha256: await crypto.subtle.digest("SHA-256", BYTES),
    customMetadata: { appReleaseVersion: VERSION, sourceCommit: COMMIT, installerType: "exe", sha256: SHA },
  });
  const object = await bucket.head("windows/pilot/1.2.3.4/setup.exe");
  if (!object) throw new Error("test artifact missing");
  etag = object.httpEtag;
  await db.prepare(`INSERT INTO app_release_catalog
    (release_id,platform,channel,version,version_major,version_minor,version_patch,version_revision,
     installer_type,artifact_key,size_bytes,sha256,strong_etag,source_commit,min_supported,notes,reviewed_by_staff_id,reviewed_at)
    VALUES('release-1','windows','pilot',?,1,2,3,4,'exe','windows/pilot/1.2.3.4/setup.exe',?,?,?,?,?,?,?,'2026-10-26T12:00:00Z')`)
    .bind(VERSION, BYTES.byteLength, SHA, etag, COMMIT, minSupported, notes, owner.id).run();
  await db.prepare(`INSERT INTO app_release_head VALUES('windows','pilot','release-1',1,'2026-10-26T12:00:00Z')`).run();
  await db.prepare(`INSERT INTO app_release_pilot_eligibilities
    (eligibility_id,principal_id,channel,cohort_id,cohort_revision,granted_at)
    VALUES('eligible-owner','staff-owner','pilot','synthetic-cohort',1,'2026-10-26T12:00:00Z')`).run();
}

async function initializeDatabase() {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('ok')}}",
    d1Databases: { OPS_DB: "app-release-test" }, r2Buckets: { APP_RELEASE_BUCKET: "app-release-test" } });
  db = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
  bucket = await runtime.getR2Bucket("APP_RELEASE_BUCKET") as unknown as R2Bucket;
  await db.exec(`CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT,status TEXT,access_subject TEXT);
    CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT);
    INSERT INTO staff_users VALUES('staff-owner','owner@example.test','active','access-subject-owner');
    INSERT INTO staff_role_assignments VALUES('staff-owner','role-owner','global');
    INSERT INTO staff_users VALUES('staff-admin','admin@example.test','active','access-subject-admin');
    INSERT INTO staff_role_assignments VALUES('staff-admin','role-admin','global');`);
  const migration = readFileSync(new URL("../migrations/0230_app_release_pilot.sql", import.meta.url), "utf8");
  for (const statement of splitD1MigrationStatements(migration)) await db.prepare(statement).run();
}
afterAll(async () => runtime?.dispose());
beforeEach(async () => {
  await runtime?.dispose();
  await initializeDatabase();
});

describe("staging Operations Windows app release feed", () => {
  it("keeps frozen migration prefixes and validates both new successor hashes", () => {
    expect(reviewedOperationsMigrationNames(new URL("../migrations/", import.meta.url))).toHaveLength(199);
    expect(reviewedClientMigrationNames(new URL("../../client/migrations/", import.meta.url))).toHaveLength(149);
  });

  it("returns exact flat native offer and preserves browser platform-only response", async () => {
    await seedRelease();
    const native = await app().fetch("/api/app/latest?platform=windows&channel=pilot&schemaVersion=1");
    expect(native.status).toBe(200);
    const offer = await native.json() as Record<string, unknown>;
    expect(Object.keys(offer).sort()).toEqual(["available","channel","downloadUrl","installerType","minSupported","notes","platform","schemaVersion","sha256","sizeBytes","sourceCommit","strongETag","version"].sort());
    expect(offer).toEqual({ schemaVersion: 1, available: true, platform: "windows", channel: "pilot", version: VERSION,
      sizeBytes: BYTES.byteLength, sha256: SHA, strongETag: etag, sourceCommit: COMMIT, installerType: "exe",
      downloadUrl: `/api/app/download/${VERSION}?platform=windows&channel=pilot`, minSupported: "Windows 10/11 x64", notes: "Pilot candidate" });
    expect(native.headers.get("cache-control")).toBe("private, no-store");
    const legacy = await app().fetch("/api/app/latest?platform=windows");
    const legacyOffer = await legacy.json() as { downloadUrl: string };
    expect(legacyOffer).toEqual({ available: true, platform: "windows", channel: "pilot", version: VERSION,
      size: BYTES.byteLength, sha256: SHA, downloadUrl: `/api/app/download/${VERSION}?platform=windows&channel=pilot`,
      minSupported: "Windows 10/11 x64", notes: "Pilot candidate" });
    for (const platform of ["macos", "linux"]) {
      const unsupported = await app().fetch(`/api/app/latest?platform=${platform}`);
      expect(unsupported.status).toBe(200);
      expect(await unsupported.json()).toEqual({ available: false });
    }
    const browserDownload = await app().fetch(legacyOffer.downloadUrl);
    expect(browserDownload.status).toBe(200);
    expect(Number(browserDownload.headers.get("content-length"))).toBe(BYTES.byteLength);
    expect(await browserDownload.bytes()).toEqual(BYTES);
  });

  it("omits genuinely absent optional native text fields", async () => {
    await seedRelease({ minSupported: null, notes: null });
    const response = await app().fetch("/api/app/latest?platform=windows&channel=pilot&schemaVersion=1");
    expect(response.status).toBe(200);
    const offer = await response.json() as Record<string, unknown>;
    expect(offer).not.toHaveProperty("minSupported");
    expect(offer).not.toHaveProperty("notes");
  });

  it("returns no-off only for eligible owners without a pilot cohort or approved head", async () => {
    await db.prepare("UPDATE app_release_control SET enabled=1,storage_accepted=1").run();
    const native = await app().fetch("/api/app/latest?platform=windows&channel=pilot&schemaVersion=1");
    expect(native.status).toBe(200); expect(await native.json()).toEqual({ schemaVersion: 1, available: false });
    await db.prepare(`INSERT INTO app_release_pilot_eligibilities VALUES('eligible-owner','staff-owner','pilot','synthetic-cohort',1,'2026-10-26T12:00:00Z')`).run();
    const noHead = await app().fetch("/api/app/latest?platform=windows&channel=pilot&schemaVersion=1");
    expect(noHead.status).toBe(200); expect(await noHead.json()).toEqual({ schemaVersion: 1, available: false });
    const legacyNoOffer = await app().fetch("/api/app/latest?platform=windows");
    expect(await legacyNoOffer.json()).toEqual({ available: false });
  });

  it("fails closed on optional text the native client rejects", async () => {
    const invalidOptionalValues: Array<{ minSupported?: string; notes?: string }> = [
      { notes: "" },
      { notes: "   " },
      { notes: "pilot\nnotes" },
      { minSupported: " Windows 11" },
      { minSupported: "\u0085Windows 11" },
    ];
    for (const optional of invalidOptionalValues) {
      await runtime.dispose();
      await initializeDatabase();
      await seedRelease(optional);
      const response = await app().fetch("/api/app/latest?platform=windows&channel=pilot&schemaVersion=1");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "app_release_catalog_invalid" });
    }
  });

  it("denies non-owner, revoked cohort, production, and malformed query without offering", async () => {
    await seedRelease();
    const path = "/api/app/latest?platform=windows&channel=pilot&schemaVersion=1";
    expect((await app({ ...owner, id: "staff-admin", accessSubject: "access-subject-admin" }).fetch(path)).status).toBe(403);
    await db.prepare(`INSERT INTO app_release_pilot_revocations VALUES('eligible-owner','test-revoke','2026-10-26T12:00:00Z','staff-owner')`).run();
    const revoked = await app().fetch(path); expect(revoked.status).toBe(200); expect(await revoked.json()).toEqual({ schemaVersion: 1, available: false });
    expect((await app(owner, "production").fetch(path)).status).toBe(404);
    expect((await app().fetch("/api/app/latest?platform=windows&platform=windows&channel=pilot&schemaVersion=1")).status).toBe(400);
    expect((await app().fetch("/api/app/latest?platform=windows&channel=stable&schemaVersion=1")).status).toBe(400);
  });

  it("serves exact bytes with strong validators and standard single-range responses", async () => {
    await seedRelease();
    const url = `/api/app/download/${VERSION}?platform=windows&channel=pilot`;
    const full = await app().fetch(url, { headers: { "If-Match": etag } });
    expect(full.status, await full.clone().text()).toBe(200); expect(full.headers.get("etag")).toBe(etag);
    expect(Number(full.headers.get("content-length"))).toBe(BYTES.byteLength);
    expect(full.headers.get("location")).toBeNull(); expect(await full.bytes()).toEqual(BYTES);
    const partial = await app().fetch(url, { headers: { "If-Match": etag, "If-Range": etag, Range: "bytes=3-8" } });
    expect(partial.status).toBe(206); expect(partial.headers.get("content-range")).toBe(`bytes 3-8/${BYTES.byteLength}`);
    expect(Number(partial.headers.get("content-length"))).toBe(6);
    expect(await partial.bytes()).toEqual(BYTES.slice(3, 9));
    const suffix = await app().fetch(url, { headers: { "If-Match": etag, "If-Range": etag, Range: "bytes=-4" } });
    expect(suffix.status).toBe(206); expect(suffix.headers.get("content-range")).toBe(`bytes ${BYTES.byteLength - 4}-${BYTES.byteLength - 1}/${BYTES.byteLength}`);
    expect(await suffix.bytes()).toEqual(BYTES.slice(-4));
    expect((await app().fetch(url, { method: "HEAD", headers: { "If-Match": etag } })).status).toBe(200);
  });

  it("serves browser full GETs while requiring native validators for ranges, and refuses R2 mismatches", async () => {
    await seedRelease();
    const url = `/api/app/download/${VERSION}?platform=windows&channel=pilot`;
    const browserFull = await app().fetch(url);
    expect(browserFull.status).toBe(200);
    expect(await browserFull.bytes()).toEqual(BYTES);
    expect((await app().fetch(url, { headers: { "If-Match": '"other"' } })).status).toBe(412);
    expect((await app().fetch(url, { headers: { Range: "bytes=0-1" } })).status).toBe(428);
    expect((await app().fetch(url, { headers: { "If-Match": etag, Range: "bytes=0-1" } })).status).toBe(428);
    expect((await app().fetch(url, { headers: { "If-Match": etag, "If-Range": '"other"', Range: "bytes=0-1" } })).status).toBe(412);
    expect((await app().fetch(url, { headers: { "If-Match": etag, "If-Range": etag, Range: "bytes=999-" } })).status).toBe(416);
    const full = await app().fetch(url, { headers: { "If-Match": etag }, redirect: "manual" });
    expect(full.status, await full.clone().text()).toBe(200);
    await bucket.put("windows/pilot/1.2.3.4/setup.exe", new TextEncoder().encode("corrupted"), {
      customMetadata: { appReleaseVersion: VERSION, sourceCommit: COMMIT, installerType: "exe", sha256: SHA },
    });
    const mismatch = await app().fetch("/api/app/latest?platform=windows&channel=pilot&schemaVersion=1");
    expect(mismatch.status).toBe(409); expect(await mismatch.json()).toEqual({ error: "app_release_artifact_mismatch" });
  });
});
