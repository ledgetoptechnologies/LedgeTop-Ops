import { afterEach, expect, it, vi } from "vitest";
import { clockedNativeImportSqlite } from "./helpers/clocked-native-import-sqlite";
import { importCase, noRemoteCreateRows, paImportTransport } from "./helpers/native-existing-import-fixture";
import { executeNativeExistingDirectoryImport, prepareNativeExistingDirectoryImport, readNativeExistingDirectoryImportStatus,
  renewNativeExistingDirectoryImport } from "../src/worker/native-directory-existing-import";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("renews an expired lost-ACK import and reconciles the original immutable binding command after five hours", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const database = clockedNativeImportSqlite();
  try {
    const f = await importCase(database.database), transport = paImportTransport([f]); vi.stubGlobal("fetch", transport.fetcher);
    const prepared = await prepareNativeExistingDirectoryImport(f.env, f.selection, f.actor);
    expect(prepared.status, JSON.stringify(prepared)).toBe("reviewed");
    if (prepared.status !== "reviewed") throw new Error("review failed");
    const review = prepared.review;
    transport.states.get(f.origin)!.loseNextAck = true;
    expect(await executeNativeExistingDirectoryImport(f.env, { importId: review.importId }, f.actor)).toMatchObject({ status: "pending" });
    const originalCommand = await database.database.prepare("SELECT * FROM native_directory_existing_import_binding_intents WHERE import_id=?").bind(review.importId).first();
    const originalBody = transport.posts()[0]![1]!.body;
    const outbox = await noRemoteCreateRows(database.database);

    vi.setSystemTime(Date.now() + 5 * 60 * 60 * 1000);
    const actor = { ...f.actor, verifiedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
    expect(await readNativeExistingDirectoryImportStatus(f.env, review.importId, actor)).toMatchObject({ status: "pending", renewable: true, expiryReason: "review_expired" });
    expect((await executeNativeExistingDirectoryImport(f.env, { importId: review.importId }, actor)).status).not.toBe("activated");
    expect(transport.posts()).toHaveLength(1);

    expect(await renewNativeExistingDirectoryImport(f.env, review.importId, actor)).toMatchObject({ status: "reviewed", review: { importId: review.importId, nativeRecordId: review.nativeRecordId } });
    expect(await executeNativeExistingDirectoryImport(f.env, { importId: review.importId }, actor)).toMatchObject({ status: "activated", recordId: review.nativeRecordId });
    expect(await database.database.prepare("SELECT * FROM native_directory_existing_import_binding_intents WHERE import_id=?").bind(review.importId).first()).toEqual(originalCommand);
    expect(transport.posts()).toHaveLength(2);
    expect(transport.posts()[1]![1]!.body).toBe(originalBody);
    expect(await noRemoteCreateRows(database.database)).toEqual(outbox);
    expect(await database.database.prepare("SELECT generation FROM native_directory_existing_import_source_cursors WHERE batch_id=? AND source_id=?")
      .bind(review.batchId, review.sourceId).first("generation")).toBe("6");
  } finally { database.dispose(); }
}, 60_000);
