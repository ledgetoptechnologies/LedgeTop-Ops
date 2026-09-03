import { describe, expect, it } from "vitest";
import { buildZipLayout, crc32, estimateZipArchiveSize, readZipPart, streamZip, uniqueZipEntryNames } from "../src/worker/zip";
import { normalizedSourceFilename, preparedKey } from "../src/worker/artifacts";

async function bytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader(); const chunks: Uint8Array[] = [];
  while (true) { const next = await reader.read(); if (next.done) break; chunks.push(next.value); }
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0)); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

describe("streaming ZIP writer", () => {
  it("keeps standard CRC-32 values and incremental chunks identical", () => {
    const input = new TextEncoder().encode("123456789");
    expect((crc32(input) ^ 0xffffffff) >>> 0).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0xffffffff);
    for (let split = 0; split <= input.length; split += 1) {
      expect(crc32(input.subarray(split), crc32(input.subarray(0, split)))).toBe(crc32(input));
    }
  });
  it("writes a valid stored archive with nested names", async () => {
    const result = await bytes(streamZip([{ name: "edited/photo.txt", size: 5, open: async () => new Blob(["hello"]).stream() }]));
    const text = new TextDecoder().decode(result);
    expect(result[0]).toBe(0x50); expect(result[1]).toBe(0x4b); expect(text).toContain("edited/photo.txt"); expect(text).toContain("hello");
    expect(result[result.length - 22]).toBe(0x50); expect(result[result.length - 21]).toBe(0x4b);
  });

  it("emits ZIP64 central-directory records and rejects changed sources", async () => {
    const result = await bytes(streamZip([{ name: "unicode/фото.txt", size: 5, open: async () => new Blob(["hello"]).stream() }]));
    const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
    let signatures: number[] = [];
    for (let offset = 0; offset + 4 <= result.length; offset += 1) signatures.push(view.getUint32(offset, true));
    expect(signatures).toContain(0x06064b50);
    expect(signatures).toContain(0x07064b50);
    await expect(bytes(streamZip([{ name: "changed.bin", size: 4, open: async () => new Blob(["hello"]).stream() }]))).rejects.toThrow("ZIP source changed");
  });

  it("reconstructs a multipart ZIP64 archive from bounded source ranges", async () => {
    const source = new TextEncoder().encode("hello");
    const checksum = (crc32(source) ^ 0xffffffff) >>> 0;
    const reads: Array<{ range: { offset: number; length: number }; onlyIf?: { etagMatches: string } }> = [];
    const layout = buildZipLayout([{ key: "Jobs/client/hello.txt", name: "Client Name/hello.txt", size: source.length, crc32: checksum, etag: "source-etag" }]);
    const bucket = { async get(_key: string, options?: { range: { offset: number; length: number }; onlyIf?: { etagMatches: string } }) {
      const range = options!.range;
      reads.push(options!);
      if (options?.onlyIf?.etagMatches !== "source-etag") return null;
      return { async arrayBuffer() { return source.slice(range.offset, range.offset + range.length).buffer; } };
    } };
    const first = await readZipPart(bucket, layout, 0, 37);
    const rest = await readZipPart(bucket, layout, 37, layout.archiveSize - 37);
    const archive = new Uint8Array(first.length + rest.length); archive.set(first); archive.set(rest, first.length);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const entry = layout.entries[0]!;
    const localNameLength = view.getUint16(entry.localOffset + 26, true);
    const localExtraOffset = entry.localOffset + 30 + localNameLength;
    const dataOffset = entry.localOffset + entry.local.length;
    expect(view.getUint32(entry.localOffset, true)).toBe(0x04034b50);
    expect(view.getUint32(entry.localOffset + 14, true)).toBe(checksum);
    expect(new TextDecoder().decode(archive.subarray(entry.localOffset + 30, localExtraOffset))).toBe("Client Name/hello.txt");
    expect(view.getUint16(localExtraOffset, true)).toBe(0x0001);
    expect(view.getBigUint64(localExtraOffset + 4, true)).toBe(BigInt(source.length));
    expect(archive.subarray(dataOffset, dataOffset + source.length)).toEqual(source);
    expect(view.getUint32(layout.centralOffset, true)).toBe(0x02014b50);
    expect(view.getUint32(layout.centralOffset + 16, true)).toBe(checksum);
    expect(view.getUint32(archive.length - 98, true)).toBe(0x06064b50);
    expect(view.getUint32(archive.length - 42, true)).toBe(0x07064b50);
    expect(view.getUint32(archive.length - 22, true)).toBe(0x06054b50);
    expect(reads).toEqual([{ range: { offset: 0, length: source.length }, onlyIf: { etagMatches: "source-etag" } }]);
  });

  it("rejects short R2 range reads instead of zero-filling an archive", async () => {
    const source = new TextEncoder().encode("hello");
    const layout = buildZipLayout([{ key: "Jobs/client/hello.txt", name: "hello.txt", size: source.length, crc32: 0 }]);
    const bucket = { async get() { return { async arrayBuffer() { return source.slice(0, 1).buffer; } }; } };
    await expect(readZipPart(bucket, layout, layout.entries[0]!.local.length, source.length)).rejects.toThrow("short range");
  });

  it("fails safely when a conditionally read source changed or disappeared", async () => {
    const layout = buildZipLayout([{ key: "Jobs/client/hello.txt", name: "hello.txt", size: 5, crc32: 0, etag: "source-etag" }]);
    const reads: unknown[] = [];
    const bucket = { async get(_key: string, options?: unknown) { reads.push(options); return null; } };
    await expect(readZipPart(bucket, layout, layout.entries[0]!.local.length, 5)).rejects.toThrow("changed or disappeared");
    expect(reads).toEqual([{ range: { offset: 0, length: 5 }, onlyIf: { etagMatches: "source-etag" } }]);
  });

  it("seeks through empty files and reconstructs identical bytes across part boundaries", async () => {
    const entries = Array.from({ length: 75 }, (_, index) => ({
      key: `file-${index}`, name: `folder/file-${index}`, size: index % 4 === 0 ? 0 : 13 + index, crc32: index, etag: `etag-${index}`,
    }));
    const layout = buildZipLayout(entries);
    const bucket = { async get(key: string, options?: { range: { offset: number; length: number }; onlyIf?: { etagMatches: string } }) {
      const index = Number(key.slice(5));
      expect(options?.onlyIf?.etagMatches).toBe(`etag-${index}`);
      const range = options!.range;
      return { async arrayBuffer() { return new Uint8Array(range.length).fill(index).buffer; } };
    } };
    const entire = await readZipPart(bucket, layout, 0, layout.archiveSize);
    const reconstructed = new Uint8Array(layout.archiveSize);
    for (let start = 0; start < layout.archiveSize; start += 113) {
      reconstructed.set(await readZipPart(bucket, layout, start, 113), start);
    }
    expect(reconstructed).toEqual(entire);
    expect(await readZipPart(bucket, layout, layout.archiveSize, 113)).toHaveLength(0);
  });

  it("only inspects a logarithmic prefix when seeking a late archive part", async () => {
    const layout = buildZipLayout(Array.from({ length: 5_000 }, (_, index) => ({
      key: `file-${index}`, name: `file-${index}`, size: 1, crc32: 0,
    })));
    let segmentReads = 0;
    layout.segments = new Proxy(layout.segments, { get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) segmentReads += 1;
      return Reflect.get(target, property, receiver);
    } });
    const bucket = { async get() { throw new Error("Trailer must not read source files"); } };
    const trailer = await readZipPart(bucket, layout, layout.archiveSize - 22, 22);
    expect(new DataView(trailer.buffer).getUint32(0, true)).toBe(0x06054b50);
    expect(segmentReads).toBeLessThan(25);
  });

  it("assigns deterministic, case-insensitively unique names after sanitizing and truncating", () => {
    const veryLong = `${"😀".repeat(100)}.jpg`;
    const names = uniqueZipEntryNames([
      "folder/a:b.jpg",
      "folder/a?b.jpg",
      "Photo.JPG",
      "photo.jpg",
      veryLong,
      veryLong,
    ]);

    expect(names.slice(0, 4)).toEqual([
      "folder/a_b.jpg",
      "folder/a_b.jpg~2",
      "Photo.JPG",
      "photo.jpg~2",
    ]);
    expect(new Set(names.map(name => name.toLocaleLowerCase("en-US"))).size).toBe(names.length);
    expect(names.every(name => new TextEncoder().encode(name).length <= 240)).toBe(true);
    expect(names[5]).toMatch(/~2$/);
    expect(names.every(name => !name.includes("\uFFFD"))).toBe(true);
  });

  it("uses the same unique names and exact byte count in estimation and ZIP layout", () => {
    const entries = [
      { key: "one", name: "same:name.jpg", size: 5, crc32: 1 },
      { key: "two", name: "same?name.jpg", size: 7, crc32: 2 },
      { key: "three", name: "日本語/写真.jpg", size: 11, crc32: 3 },
    ];
    const layout = buildZipLayout(entries);
    expect(estimateZipArchiveSize(entries)).toBe(layout.archiveSize);

    const decoder = new TextDecoder();
    const names = layout.entries.map(entry => {
      const view = new DataView(entry.local.buffer, entry.local.byteOffset, entry.local.byteLength);
      const nameLength = view.getUint16(26, true);
      return decoder.decode(entry.local.subarray(30, 30 + nameLength));
    });
    expect(names).toEqual(uniqueZipEntryNames(entries.map(entry => entry.name)));
  });
});

describe("TrueNAS prepared artifacts", () => {
  it("uses the normalized full source filename and manifest-last variants", async () => {
    const source = "jobs\\2026//Client//photo.JPG";
    expect(normalizedSourceFilename(source)).toBe("photo.JPG");
    await expect(preparedKey(source, "thumb")).resolves.toMatch(/^jobs\/2026\/Client\/\.previews\/[a-f0-9]{64}\/thumb\.webp$/);
    await expect(preparedKey(source, "preview")).resolves.toMatch(/^jobs\/2026\/Client\/\.previews\/[a-f0-9]{64}\/preview\.webp$/);
    await expect(preparedKey(source, "poster")).resolves.toMatch(/^jobs\/2026\/Client\/\.previews\/[a-f0-9]{64}\/poster\.webp$/);
  });
});
