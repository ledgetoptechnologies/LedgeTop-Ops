import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fullImportDatabase, noRemoteCreateRows, uuid } from "./helpers/native-existing-import-fixture";

let fixture: Awaited<ReturnType<typeof fullImportDatabase>>;
beforeAll(async () => { fixture = await fullImportDatabase(); }, 240_000);
afterAll(async () => { await fixture.runtime.dispose(); });

describe("existing import admission guards on the complete D1 migration chain", () => {
  it("retains valid foreign keys and reserves no PA create or business work during migration", async () => {
    expect((await fixture.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(await noRemoteCreateRows(fixture.db)).toEqual({ project_alpha_directory_outbox: 0, operations_directory_intents: 0, operations_directory_materializations: 0 });
    expect(await fixture.db.prepare("SELECT count(*) n FROM native_directory_existing_import_reviews").first("n")).toBe(0);
    expect(await fixture.db.prepare("SELECT count(*) n FROM operations_directory_records").first("n")).toBe(0);
  });

  it("rejects a forged review row even when a caller bypasses the TypeScript validator", async () => {
    const at = new Date().toISOString(), expiry = new Date(Date.now() + 60_000).toISOString();
    await expect(fixture.db.prepare(`INSERT INTO native_directory_existing_import_reviews
      (import_id,idempotency_key,request_sha256,review_json,created_at,expires_at) VALUES(?,?,?,'{}',?,?)`)
      .bind(uuid(800_001), uuid(800_002), "a".repeat(64), at, expiry).run()).rejects.toThrow();
    expect(await fixture.db.prepare("SELECT count(*) n FROM native_directory_existing_import_reviews").first("n")).toBe(0);
  });

  it("rolls an unauthorized execution admission back without a local receipt or record", async () => {
    const at = new Date().toISOString(), expiry = new Date(Date.now() + 60_000).toISOString();
    await expect(fixture.db.batch([
      fixture.db.prepare(`INSERT INTO native_directory_existing_import_execution_admissions
        (execution_id,import_id,actor_json,created_at,verified_until) VALUES(?,?,'{}',?,?)`)
        .bind(uuid(800_003), uuid(800_004), at, expiry),
      fixture.db.prepare("INSERT INTO native_business_areas VALUES('should-roll-back','Never committed',1)"),
    ])).rejects.toThrow();
    expect(await fixture.db.prepare("SELECT id FROM native_business_areas WHERE id='should-roll-back'").first()).toBeNull();
    expect(await fixture.db.prepare("SELECT count(*) n FROM native_directory_existing_import_execution_admissions").first("n")).toBe(0);
    expect(await fixture.db.prepare("SELECT count(*) n FROM native_directory_existing_import_local_receipts").first("n")).toBe(0);
    expect(await fixture.db.prepare("SELECT count(*) n FROM operations_directory_records").first("n")).toBe(0);
  });
});
