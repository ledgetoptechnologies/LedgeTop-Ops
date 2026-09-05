import { describe, expect, it, vi } from "vitest";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {} }));

import { BulkDownloadWorkflow, CACHE_REUSE_CLAIM_QUERIES, CHECKSUM_SQL_CHUNK, CRC_CONCURRENCY, UPLOAD_CONCURRENCY, assertBulkPreparationCapacity, drainParallel, estimateBulkPreparation, estimateOnePassBulkPreparation, finalBulkManifestKey, planCrcWindows, planCrcWorkUnits } from "../src/worker/workflow";
import { crc32 } from "../src/worker/zip";

const mib = 1024 * 1024;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1));

function harness(failUpload = false, sizes = Array<number>(7).fill(6 * mib), prepared = true, reuseArchive = false, failReady = false, reuseArchiveKey = "cache/reused.zip", cleanupOverlap = false) {
  const sources = sizes.map((size, index) => ({ physicalKey: `source-${index}`, key: `source-${index}`, name: `photo-${index}.jpg`, size, etag: `etag-${index}` }));
  const snapshot = { root: "", shareId: "share", shareVersion: 1, sources };
  const objects = new Map<string, string>([["snapshot.json", JSON.stringify(snapshot)]]);
  const cached = new Map<string, unknown>();
  const calls: string[] = [];
  const progress: number[] = [];
  const completedParts: number[] = [];
  const spawned: string[] = [];
  const checksums = new Map<string, { r2_key: string; etag: string; size: number; crc32: number }>();
  const uploadedSizes = new Map<number, number>();
  const deletedKeys: string[] = [];
  let completedArchive: { size: number; etag: string } | null = reuseArchive
    ? { size: 1234, etag: "cached-etag" }
    : null;
  let status = "running";
  let activeReads = 0; let maximumReads = 0;
  let activeUploads = 0; let maximumUploads = 0;
  let abortedWithActive = -1;
  let failOnce = failUpload;
  let scheduledCleanupDeleted = false;
  let activeStep = "outside";
  const d1Queries = new Map<string, number>();
  const countD1Query = () => d1Queries.set(activeStep, (d1Queries.get(activeStep) || 0) + 1);
  const job = { id: "job", share_id: "share", share_version: 1, request_json: "{}", manifest_key: "snapshot.json", archive_key: "archive.zip" };
  const database = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => {
    const statement = {
      first: async () => { countD1Query(); return sql.includes("SELECT id,") ? job
        : sql.includes("FROM bulk_download_archive_cache") ? (reuseArchive ? {
          archive_key: reuseArchiveKey, archive_etag: "cached-etag", archive_size: 1234,
          file_count: sources.length, total_bytes: sources.reduce((total, source) => total + source.size, 0),
        } : null)
        : sql.includes("SELECT status") ? { status }
        : sql.includes("SELECT archive_key,archive_fingerprint") ? { archive_key: job.archive_key, archive_fingerprint: "f".repeat(64), multipart_upload_id: "upload" }
        : null; },
      all: async () => { countD1Query(); return sql.includes("bulk_download_object_checksums")
        ? { results: values.flatMap(value => checksums.has(String(value)) ? [checksums.get(String(value))!] : []) }
        : { results: [] }; },
      run: async () => {
        countD1Query();
        if (sql.includes("INSERT INTO bulk_download_object_checksums")) {
          for (const row of JSON.parse(String(values[0])) as Array<{ key: string; etag: string; size: number; crc32: number }>)
            checksums.set(row.key, { r2_key: row.key, etag: row.etag, size: row.size, crc32: row.crc32 });
        }
        if (sql.includes("SET archive_key=")) job.archive_key = String(values[0]);
        if (sql.includes("status='ready'") && !failReady && !scheduledCleanupDeleted) status = "ready";
        if (sql.includes("SET status='failed'")) status = "failed";
        if (sql.includes("processed_files=MAX")) progress.push(Number(values[1]));
        else if (sql.includes("processed_bytes=MAX(0,total_bytes-1)")) progress.push(Math.max(0, sources.reduce((total, source) => total + source.size, 0) - 1));
        return { meta: { changes: sql.includes("status='ready'") && (failReady || scheduledCleanupDeleted) ? 0 : 1 } };
      },
    };
    return statement;
  } }), withSession() { return database; }, async batch(statements: Array<{ run(): Promise<unknown> }>) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    if (cleanupOverlap && statements.length === CACHE_REUSE_CLAIM_QUERIES) {
      // C has replaced the cache row. The scheduled orphan sweep can now
      // protect old A only through B's atomically persisted running-job key.
      scheduledCleanupDeleted = job.archive_key !== reuseArchiveKey;
    }
    return results;
  } };
  const env = {
    BULK_DOWNLOAD_WORKFLOW: { create: async ({ id }: { id: string }) => { spawned.push(id); return { id }; } },
    DELIVERY_DB: database,
    DATA_BUCKET: {
      get: async (key: string, options?: { range: { offset: number; length: number }; onlyIf?: { etagMatches: string } }) => {
        if (objects.has(key)) return { text: async () => objects.get(key)! };
        const index = Number(key.split("-")[1]);
        expect(options?.onlyIf?.etagMatches).toBe(`etag-${index}`);
        activeReads += 1; maximumReads = Math.max(maximumReads, activeReads);
        await tick();
        return { arrayBuffer: async () => { activeReads -= 1; return new Uint8Array(options!.range.length).fill(index).buffer; } };
      },
      put: async (key: string, value: string) => { objects.set(key, value); },
      delete: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) { objects.delete(key); deletedKeys.push(key); } },
      head: async () => completedArchive,
      createMultipartUpload: async () => ({ uploadId: "upload" }),
      resumeMultipartUpload: () => ({
        uploadPart: async (partNumber: number, bytes: Uint8Array) => {
          activeUploads += 1; maximumUploads = Math.max(maximumUploads, activeUploads);
          try {
            if (failOnce && partNumber === 1) { failOnce = false; throw new Error("injected-upload-failure"); }
            await new Promise<void>(resolve => setTimeout(resolve, 2)); completedParts.push(partNumber); uploadedSizes.set(partNumber, bytes.length);
            return { partNumber, etag: `part-${partNumber}` };
          } finally { activeUploads -= 1; }
        },
        complete: async (parts: Array<{ partNumber: number }>) => {
          expect(parts.map(part => part.partNumber)).toEqual(Array.from({ length: estimateOnePassBulkPreparation(sources).uploadParts }, (_, index) => index + 1));
          completedArchive = { size: [...uploadedSizes.values()].reduce((total, size) => total + size, 0), etag: "archive-etag" };
          return completedArchive;
        },
        abort: async () => { abortedWithActive = activeUploads + activeReads; },
      }),
    },
  };
  const step = {
    do: async (name: string, configOrCallback: unknown, callback?: () => Promise<unknown>) => {
      if (cached.has(name)) return cached.get(name);
      calls.push(name);
      const run = callback || configOrCallback as () => Promise<unknown>;
      const previousStep = activeStep; activeStep = name;
      try { const value = await run(); cached.set(name, value); return value; }
      finally { activeStep = previousStep; }
    },
    // Simulate hibernation after ready without expiring the seven-day artifact.
    sleep: async () => { throw new Error("test-retention-hibernation"); },
    sleepUntil: async () => {},
    waitForEvent: async () => { throw new Error("unused"); },
  } as WorkflowStep;
  const workflow = Object.assign(Object.create(BulkDownloadWorkflow.prototype) as BulkDownloadWorkflow, { env });
  const event = { payload: { jobId: "job", prepared } } as WorkflowEvent<{ jobId: string; prepared?: boolean }>;
  return { run: () => workflow.run(event, step), sources, objects, calls, progress, completedParts, spawned, cached, deletedKeys,
    archiveKey: () => job.archive_key,
    state: () => ({ status, maximumReads, maximumUploads, abortedWithActive, activeReads, activeUploads,
      maximumD1QueriesInStep: Math.max(0, ...d1Queries.values()), d1Queries, scheduledCleanupDeleted }) };
}

describe("bounded bulk ZIP concurrency", () => {
  it("retains the parent snapshot and does not respawn split children on replay", async () => {
    const test = harness(false, [60 * 1024 ** 3, 50 * 1024 ** 3], false);
    test.cached.set("snapshot-selection", { count: 2, totalBytes: 110 * 1024 ** 3, root: "" });
    const immutable = test.objects.get("snapshot.json");
    await test.run();
    expect(test.spawned).toEqual(["job-p01", "job-p02"]);
    expect(test.objects.get("snapshot.json")).toBe(immutable);
    const calls = test.calls.length;
    await test.run();
    expect(test.spawned).toEqual(["job-p01", "job-p02"]);
    expect(test.calls.length).toBe(calls);
    expect(test.objects.get("snapshot.json")).toBe(immutable);
  });

  it("keeps a 100 GiB single source within the supported single-archive capacity", () => {
    const source = { physicalKey: "large.bin", key: "large.bin", name: "large.bin", etag: "etag", size: 100 * 1024 ** 3 };
    const estimate = assertBulkPreparationCapacity({ root: "", shareId: "share", shareVersion: 1, sources: [source] });
    expect(estimate.crcSteps).toBe(0);
    expect(estimate.uploadParts).toBe(3_202);
    expect(estimate.workflowSteps).toBe(estimate.uploadParts + 8);
    expect(estimate.workflowSteps).toBe(3_210);
    expect(estimate.workflowSteps).toBeLessThanOrEqual(24_900);
  });

  it("reuses an exact completed archive without reading sources or creating another multipart upload", async () => {
    const test = harness(false, [100, 200], true, true);
    await test.run();
    expect(test.state().status).toBe("ready");
    expect(test.state().maximumReads).toBe(0);
    expect(test.completedParts).toEqual([]);
    expect(test.calls).toContain("mark-cached-archive-ready");
    expect(test.calls).not.toContain("create-one-pass-multipart-upload");
    expect(CACHE_REUSE_CLAIM_QUERIES).toBe(2);
  });

  it("atomically protects old archive A from scheduled cleanup before reuse job B marks ready", async () => {
    const archiveA = "_ltds/bulk-download-cache/v1/share/fingerprint/builder-a.zip";
    const reuseB = harness(false, [100, 200], true, true, false, archiveA, true);
    await reuseB.run();
    expect(reuseB.state().scheduledCleanupDeleted).toBe(false);
    expect(reuseB.archiveKey()).toBe(archiveA);
    expect(reuseB.state().status).toBe("ready");
    expect(reuseB.completedParts).toEqual([]);
  });

  it("keeps 10,626 tiny files in one archive with bulk checksum SQL safely below D1's paid query limit", async () => {
    const fileCount = 10_626;
    const sizes = Array<number>(fileCount).fill(0);
    const estimate = estimateOnePassBulkPreparation(sizes.map((size, index) => ({ name: `tiny-${index}`, size })));
    expect(estimate.uploadParts).toBe(1);
    expect(estimate.maximumD1QueriesPerStep).toBe(Math.ceil(fileCount / CHECKSUM_SQL_CHUNK) * 2 + 1);
    expect(estimate.maximumD1QueriesPerStep).toBeLessThanOrEqual(975);
    const test = harness(false, sizes);
    await test.run();
    expect(test.state().status).toBe("ready");
    expect(test.state().maximumD1QueriesInStep).toBe(estimate.maximumD1QueriesPerStep);
    expect(test.completedParts).toEqual([1]);
  });

  it.each([
    { name: "zero-byte file-count boundary", sizes: Array<number>(25).fill(0) },
    { name: "64 MiB byte boundary plus final chunk", sizes: [64 * mib + 1] },
    { name: "mixed chunk and batch boundary", sizes: [8 * mib + 1, 8 * mib - 1, 0] },
  ])("accounts for every actual success step at $name", async ({ sizes }) => {
    const test = harness(false, sizes);
    await test.run();
    // The harness interrupts retention: omit its artificial failure-state read,
    // then include the successful retention sleep and expiry it did not execute.
    const actualSuccessSteps = test.cached.size - 1 + 2;
    expect(estimateOnePassBulkPreparation(test.sources).workflowSteps).toBe(actualSuccessSteps);
  });

  it("bounds CRC windows to 32 MiB and preserves same-file chunk dependencies", () => {
    const units = planCrcWorkUnits([{ size: 6 * mib }, { size: 6 * mib }, { size: 20 * mib }, { size: 6 * mib }, { size: 6 * mib }]);
    const windows = planCrcWindows(units);
    expect(windows.flat()).toEqual(units.map((_, index) => index));
    for (const window of windows) {
      expect(window.length).toBeLessThanOrEqual(CRC_CONCURRENCY);
      expect(window.reduce((bytes, index) => { const unit = units[index]!; return bytes + (unit.kind === "batch" ? unit.totalBytes : unit.length); }, 0)).toBeLessThanOrEqual(32 * mib);
      const chunks = window.flatMap(index => { const unit = units[index]!; return unit.kind === "chunk" ? [unit.sourceIndex] : []; });
      expect(new Set(chunks).size).toBe(chunks.length);
    }
  });

  it("drains delayed siblings even after synchronous or asynchronous failure", async () => {
    const events: string[] = [];
    await expect(drainParallel([
      () => { throw new Error("failure"); },
      async () => { await tick(); events.push("drained"); return 2; },
    ])).rejects.toThrow("failure");
    expect(events).toEqual(["drained"]);
  });

  it("runs bounded steps, writes truthful ordered progress, and replays after final-manifest persistence", async () => {
    const test = harness();
    await test.run();
    expect(test.state().status).toBe("ready");
    expect(test.state().maximumReads).toBe(1);
    expect(test.state().maximumUploads).toBe(1);
    expect(test.progress).toEqual([...test.progress].sort((a, b) => a - b));
    expect(test.progress.at(-1)).toBe(42 * mib - 1);
    const immutable = JSON.parse(test.objects.get("snapshot.json")!);
    expect(immutable.sources).toHaveLength(7);
    expect(immutable.entries).toBeUndefined();
    const final = JSON.parse(test.objects.get(finalBulkManifestKey("snapshot.json"))!);
    expect(final.entries.map((entry: { crc32: number }) => entry.crc32)).toEqual(test.sources.map((source, index) => (crc32(new Uint8Array(source.size).fill(index)) ^ 0xffffffff) >>> 0));
    const counts = { calls: test.calls.length, uploads: test.completedParts.length };
    await test.run();
    expect(test.calls.length).toBe(counts.calls);
    expect(test.completedParts.length).toBe(counts.uploads);
    expect(estimateOnePassBulkPreparation(test.sources).workflowSteps).toBeGreaterThanOrEqual(test.cached.size);
  });

  it("does not abort or delete artifacts until sibling uploads drain on terminal failure", async () => {
    const test = harness(true);
    await expect(test.run()).rejects.toThrow("injected-upload-failure");
    expect(test.state().abortedWithActive).toBe(0);
    expect(test.state().activeReads + test.state().activeUploads).toBe(0);
    expect(test.state().status).toBe("failed");
    expect(test.objects.has("snapshot.json")).toBe(false);
    expect(test.objects.has(finalBulkManifestKey("snapshot.json"))).toBe(false);
    expect(test.calls).not.toContain("complete-multipart-upload");
    expect(test.calls).not.toContain("upload-progress-2");
  });

  it("preserves a completed generation while an in-flight cache reuse has not persisted its job reference", async () => {
    // B has selected A's completed generation in memory. C replaces the cache
    // row, then A fails before B persists archive_key on its own job.
    const builderA = harness(false, [6 * mib], true, false, true);
    await expect(builderA.run()).rejects.toThrow("job-no-longer-active");
    expect(builderA.completedParts).toEqual([1]);
    expect(builderA.deletedKeys.some(key => key.endsWith(".zip"))).toBe(false);
    expect(builderA.state().status).toBe("failed");

    // The selected immutable object remains available for B's ready transition.
    const reuseB = harness(false, [6 * mib], true, true, false, builderA.archiveKey());
    await reuseB.run();
    expect(reuseB.state().status).toBe("ready");
    expect(reuseB.completedParts).toEqual([]);
    expect(reuseB.calls).toContain("mark-cached-archive-ready");
  });

  it("chains large-file CRC chunks correctly alongside independent small files", async () => {
    const test = harness(false, [9 * mib, 6 * mib, 17 * mib, 0]);
    await test.run();
    const final = JSON.parse(test.objects.get(finalBulkManifestKey("snapshot.json"))!);
    expect(final.entries.map((entry: { crc32: number }) => entry.crc32)).toEqual(test.sources.map((source, index) => (crc32(new Uint8Array(source.size).fill(index)) ^ 0xffffffff) >>> 0));
    expect(test.progress).toEqual([...test.progress].sort((a, b) => a - b));
    expect(test.progress.at(-1)).toBe(32 * mib - 1);
  });
});
