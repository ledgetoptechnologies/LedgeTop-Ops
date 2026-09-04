import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
import {
  buildOnePassZipPrefixPart,
  buildOnePassZipTrailer,
  initialOnePassZipState,
  joinZipBytes,
  planOnePassZipMultipart,
  ZIP_MULTIPART_MAX_PART,
  ZIP_MULTIPART_MIN_PART,
  ZIP_SOURCE_READ_CHUNK,
  type OnePassZipEntry,
} from "../src/worker/one-pass-zip";
import { crc32 } from "../src/worker/zip";
import { bulkSelectionFingerprint } from "../src/worker/workflow";

const mib = 1024 * 1024;
const u16 = (bytes: Uint8Array, offset: number) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
const u32 = (bytes: Uint8Array, offset: number) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
const u64 = (bytes: Uint8Array, offset: number) => Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true));

function bytesFor(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + seed) & 0xff;
  return bytes;
}

describe("one-pass descriptor ZIP64", () => {
  it("fingerprints the exact share version, entry name, object identity, and size", async () => {
    const base = { root: "Jobs/", shareId: "share", shareVersion: 3, sources: [
      { key: "Jobs/file", physicalKey: "Jobs/file", name: "file.jpg", size: 100, etag: "etag" },
    ] };
    const stable = await bulkSelectionFingerprint(base);
    expect(await bulkSelectionFingerprint(structuredClone(base))).toBe(stable);
    for (const changed of [
      { ...base, shareVersion: 4 },
      { ...base, sources: [{ ...base.sources[0]!, name: "renamed.jpg" }] },
      { ...base, sources: [{ ...base.sources[0]!, etag: "new-etag" }] },
      { ...base, sources: [{ ...base.sources[0]!, size: 101 }] },
    ]) expect(await bulkSelectionFingerprint(changed)).not.toBe(stable);
  });

  it("uses uniform bounded multipart pieces and leaves the directory in the final part", () => {
    const plan = planOnePassZipMultipart([
      { name: "large-a.bin", size: 41 * mib },
      { name: "large-b.bin", size: 27 * mib },
      ...Array.from({ length: 1_000 }, (_, index) => ({ name: `small/${index}.txt`, size: 8 })),
    ]);
    expect(plan.partSize).toBeGreaterThanOrEqual(ZIP_MULTIPART_MIN_PART);
    expect(plan.partSize).toBeLessThanOrEqual(ZIP_MULTIPART_MAX_PART);
    expect(plan.finalPrefixBytes + plan.trailerSize).toBeLessThanOrEqual(plan.partSize);
    expect(plan.prefixPartCount * plan.partSize + plan.finalPrefixBytes).toBe(plan.prefixSize);
    expect(plan.partCount).toBe(plan.prefixPartCount + 1);
  });

  it("reads every conditional source range once while calculating only missing CRCs", async () => {
    const values = new Map([
      ["cached", bytesFor(9 * mib + 17, 3)],
      ["legacy", bytesFor(25 * mib + 29, 7)],
    ]);
    const cachedCrc = (crc32(values.get("cached")!) ^ 0xffffffff) >>> 0;
    const entries: OnePassZipEntry[] = [
      { key: "cached", physicalKey: "cached", name: "same.jpg", size: values.get("cached")!.length, etag: "etag-cached", crc32: cachedCrc },
      { key: "legacy", physicalKey: "legacy", name: "same.jpg", size: values.get("legacy")!.length, etag: "etag-legacy" },
    ];
    const ranges = new Map<string, Array<{ offset: number; length: number }>>();
    const bucket = {
      async get(key: string, options: { range: { offset: number; length: number }; onlyIf: { etagMatches: string } }) {
        expect(options.onlyIf.etagMatches).toBe(`etag-${key}`);
        expect(options.range.length).toBeLessThanOrEqual(ZIP_SOURCE_READ_CHUNK);
        const calls = ranges.get(key) || [];
        calls.push(options.range); ranges.set(key, calls);
        const source = values.get(key)!;
        const selected = source.slice(options.range.offset, options.range.offset + options.range.length);
        return { arrayBuffer: async () => selected.buffer };
      },
    };
    const plan = planOnePassZipMultipart(entries);
    let state = initialOnePassZipState();
    const prefixParts: Uint8Array[] = [];
    const calculated: Array<{ entryIndex: number; crc32: number; calculated: boolean }> = [];
    for (let index = 0; index < plan.prefixPartCount; index += 1) {
      const built = await buildOnePassZipPrefixPart(bucket, entries, state, plan.partSize);
      prefixParts.push(built.bytes); calculated.push(...built.completedChecksums); state = built.state;
    }
    const tail = await buildOnePassZipPrefixPart(bucket, entries, state, plan.finalPrefixBytes);
    prefixParts.push(tail.bytes); calculated.push(...tail.completedChecksums); state = tail.state;
    expect(state.stage).toBe("done");

    for (const [key, source] of values) {
      const calls = ranges.get(key)!;
      expect(calls.reduce((total, range) => total + range.length, 0)).toBe(source.length);
      expect(calls.map(range => range.offset)).toEqual(calls.map((_, index) => calls.slice(0, index).reduce((total, range) => total + range.length, 0)));
    }
    expect(calculated).toEqual([
      { entryIndex: 0, crc32: cachedCrc, calculated: false },
      { entryIndex: 1, crc32: (crc32(values.get("legacy")!) ^ 0xffffffff) >>> 0, calculated: true },
    ]);

    const complete = entries.map((entry, index) => ({ ...entry, crc32: calculated[index]!.crc32 }));
    let archive: Uint8Array<ArrayBufferLike> = new Uint8Array();
    for (const part of prefixParts) archive = joinZipBytes(archive, part);
    archive = joinZipBytes(archive, buildOnePassZipTrailer(complete));
    expect(archive.length).toBe(plan.archiveSize);
    const expectedNames = ["same.jpg", "same.jpg~2"];
    let localOffset = 0;
    complete.forEach((entry, index) => {
      expect(u32(archive, localOffset)).toBe(0x04034b50);
      expect(u16(archive, localOffset + 6)).toBe(0x0808);
      const nameLength = u16(archive, localOffset + 26);
      const extraLength = u16(archive, localOffset + 28);
      expect(new TextDecoder().decode(archive.slice(localOffset + 30, localOffset + 30 + nameLength))).toBe(expectedNames[index]);
      const dataOffset = localOffset + 30 + nameLength + extraLength;
      const archivedPayload = archive.subarray(dataOffset, dataOffset + entry.size);
      expect(archivedPayload.length).toBe(entry.size);
      expect((crc32(archivedPayload) ^ 0xffffffff) >>> 0).toBe(entry.crc32);
      const descriptorOffset = dataOffset + entry.size;
      expect(u32(archive, descriptorOffset)).toBe(0x08074b50);
      expect(u32(archive, descriptorOffset + 4)).toBe(entry.crc32);
      expect(u64(archive, descriptorOffset + 8)).toBe(entry.size);
      expect(u64(archive, descriptorOffset + 16)).toBe(entry.size);
      localOffset = descriptorOffset + 24;
    });
    expect(localOffset).toBe(plan.prefixSize);
    expect(u32(archive, archive.length - 22)).toBe(0x06054b50);
    expect(u32(archive, plan.prefixSize)).toBe(0x02014b50);
  });

  it("rejects a changed or short conditional source instead of producing a corrupt archive", async () => {
    const entry: OnePassZipEntry = { key: "file", physicalKey: "file", name: "file.bin", size: 10, etag: "old" };
    await expect(buildOnePassZipPrefixPart({ get: async () => null }, [entry], initialOnePassZipState(), 84)).rejects.toThrow("source-changed-or-disappeared");
    await expect(buildOnePassZipPrefixPart({ get: async () => ({ arrayBuffer: async () => new Uint8Array(2).buffer }) }, [entry], initialOnePassZipState(), 84)).rejects.toThrow("source-short-read");
  });
});
